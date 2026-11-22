// Bill reading, best first:
//   1. Shared AI reader (Cloudflare Worker holding the Gemini key — nobody sees it)
//   2. Gemini with a key saved on this phone (optional, Settings)
//   3. On-device Tesseract.js — no network, no account

import { parseBillText } from './parser.js';
import { ReadError, geminiReadBill, listFlashModels } from './gemini.js';

export { ReadError };

// Tesseract.js 7.0.0 + English data are bundled in /vendor so they load fast
// from GitHub Pages and work offline after first use.
const VENDOR = new URL('../vendor/', import.meta.url).href;
const TESSERACT_URL = `${VENDOR}tesseract/tesseract.min.js`;

// ---------- image helpers ----------

async function loadBitmap(blob) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawScaled(bitmap, maxSide) {
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function toJpegBase64(blob, maxSide = 1800) {
  const canvas = drawScaled(await loadBitmap(blob), maxSide);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

// Grayscale + contrast stretch helps Tesseract a lot on thermal-paper bills.
async function preprocessForOcr(blob) {
  const bitmap = await loadBitmap(blob);
  const w = bitmap.width || bitmap.naturalWidth;
  // Upscale small images, downscale huge ones.
  const target = Math.max(w, bitmap.height || bitmap.naturalHeight) < 1400 ? 2000 : 2400;
  const canvas = drawScaled(bitmap, target);
  if (Math.max(canvas.width, canvas.height) < 1400) {
    const up = document.createElement('canvas');
    const k = 2000 / Math.max(canvas.width, canvas.height);
    up.width = Math.round(canvas.width * k);
    up.height = Math.round(canvas.height * k);
    up.getContext('2d').drawImage(canvas, 0, 0, up.width, up.height);
    return preprocessCanvas(up);
  }
  return preprocessCanvas(canvas);
}

function preprocessCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = g;
    hist[g | 0]++;
  }
  // Stretch between the 2nd and 98th percentiles.
  const total = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / range));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ---------- AI (Gemini) ----------

/** Shared reader: the website's own Cloudflare Worker holds the key. */
export async function readWithSharedReader(blob, { url, onStatus = () => {} }) {
  onStatus('Preparing photo…');
  const image = await toJpegBase64(blob);
  onStatus('Reading bill with AI…');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image }),
    });
  } catch {
    throw new ReadError('No internet connection to reach the AI reader.', { kind: 'network' });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const kind = res.status === 429 ? 'quota' : 'error';
    throw new ReadError(body?.error || `AI reader error (${res.status}).`, { kind, status: res.status });
  }
  return normalise(body, 'ai');
}

/** Own-key mode: the browser calls Gemini directly with a key saved on this phone. */
export async function readWithGemini(blob, { key, model, onModel, onStatus = () => {} }) {
  onStatus('Preparing photo…');
  const base64 = await toJpegBase64(blob);
  onStatus('Reading bill with AI…');
  return normalise(await geminiReadBill({ key, base64, model, onModel }), 'ai');
}

/** Quick check used by Settings → "Test key". */
export async function testGeminiKey(key) {
  const models = await listFlashModels(key);
  if (!models.length) throw new ReadError('Key works, but no Gemini Flash model is available to it.');
  return models;
}

// ---------- On-device (Tesseract.js) ----------

let tesseractLoading;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tesseractLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => {
      tesseractLoading = null;
      reject(new ReadError('Could not download the on-device reader. Check your internet once.', { kind: 'network' }));
    };
    document.head.appendChild(s);
  });
  return tesseractLoading;
}

export async function readOnDevice(blob, { onStatus = () => {}, onProgress = () => {} } = {}) {
  onStatus('Loading on-device reader…');
  const Tesseract = await loadTesseract();
  onStatus('Enhancing photo…');
  const canvas = await preprocessForOcr(blob);
  const worker = await Tesseract.createWorker('eng', 1, {
    workerPath: `${VENDOR}tesseract/worker.min.js`,
    corePath: `${VENDOR}tesseract-core`,
    langPath: `${VENDOR}lang`,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'recognizing text') {
        onStatus('Reading text on your phone…');
        onProgress(m.progress);
      } else if (/loading|initializ/i.test(m.status)) {
        onStatus('Loading on-device reader…');
      }
    },
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas);
    return normalise(parseBillText(data.text), 'ocr', data.text);
  } finally {
    worker.terminate();
  }
}

export function readFromText(text) {
  return normalise(parseBillText(text), 'text', text);
}

// ---------- shared ----------

const toNum = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function normalise(r, source, rawText = '') {
  return {
    source,
    rawText,
    merchant: String(r.merchant || '').trim().slice(0, 60),
    items: (r.items || [])
      .map((it) => ({ name: String(it.name || '').trim() || 'Item', amount: toNum(it.amount) }))
      .filter((it) => it.amount !== 0),
    charges: (r.charges || [])
      .map((c) => ({ name: String(c.name || '').trim() || 'Tax', amount: toNum(c.amount) }))
      .filter((c) => c.amount !== 0),
    discount: Math.abs(toNum(r.discount)),
    total: toNum(r.total),
  };
}
