// Bill reading: Gemini (free tier, best accuracy) with an on-device
// Tesseract.js fallback that needs no key and no account.

import { parseBillText } from './parser.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
// Tesseract.js 7.0.0 + English data are bundled in /vendor so they load fast
// from GitHub Pages and work offline after first use.
const VENDOR = new URL('../vendor/', import.meta.url).href;
const TESSERACT_URL = `${VENDOR}tesseract/tesseract.min.js`;

export class ReadError extends Error {
  constructor(message, { kind = 'error', cause } = {}) {
    super(message);
    this.kind = kind; // 'key' | 'quota' | 'network' | 'error'
    this.cause = cause;
  }
}

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

// ---------- Gemini ----------

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', description: 'Restaurant or shop name, empty if not visible' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          amount: { type: 'NUMBER', description: 'Final line amount (quantity x rate)' },
        },
        required: ['name', 'amount'],
      },
    },
    charges: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          amount: { type: 'NUMBER' },
        },
        required: ['name', 'amount'],
      },
    },
    discount: { type: 'NUMBER', description: 'Total discount printed on the bill, 0 if none' },
    total: { type: 'NUMBER', description: 'Final amount payable printed on the bill, 0 if not visible' },
  },
  required: ['merchant', 'items', 'charges', 'discount', 'total'],
};

const PROMPT = `This is a photo of a restaurant / cafe / shop bill (often Indian). Read it carefully and return JSON.

items: every ordered line item, top to bottom.
  - name: the item name as printed, with obvious OCR typos fixed and in Title Case. Do not include quantity or rate in the name.
  - amount: the line's FINAL amount, i.e. the rightmost amount column (quantity x rate), never the unit rate.
  - If the same dish appears on two lines, return two entries.
  - Never include sub-total, total, tax, service charge, discount, round-off, tip or payment lines as items.
charges: every tax or extra charge that is added on top of the items: CGST, SGST, IGST, UTGST, VAT, cess, service charge, service tax, packing / delivery / container charge, and round-off (round-off can be negative). Use the rupee amount, not the percentage. If both individual taxes and a "Total GST" line are printed, return only the individual ones.
discount: total of any discount lines printed on the bill, as a positive number. 0 if none.
total: the final payable amount printed on the bill (Grand Total / Net Amount / Amount Payable). 0 if not visible.
merchant: the restaurant / shop name, or "" if not visible.

Use plain numbers without currency symbols or commas. If the image is not a bill, return empty arrays and zeros.`;

async function geminiFetch(path, key, init = {}) {
  let res;
  try {
    res = await fetch(`${GEMINI_BASE}/${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key, ...(init.headers || {}) },
    });
  } catch (e) {
    throw new ReadError('No internet connection to reach Gemini.', { kind: 'network', cause: e });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const status = body?.error?.status || '';
    if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') {
      throw new ReadError('Free Gemini limit reached for now.', { kind: 'quota' });
    }
    if (/api key|API_KEY|permission|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg + status) && res.status !== 404) {
      throw new ReadError('Gemini API key is not valid. Check it in Settings.', { kind: 'key' });
    }
    const err = new ReadError(msg, { kind: res.status === 404 ? 'model' : 'error' });
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Returns the generateContent-capable Flash models available to this key, best first. */
export async function listFlashModels(key) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 5; i++) {
    const body = await geminiFetch(`models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`, key);
    out.push(...(body.models || []));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  const usable = out
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /flash/i.test(n) && !/(image|tts|audio|live|embed|thinking-exp|native)/i.test(n));
  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  const score = (n) =>
    version(n) * 100 - (/lite/i.test(n) ? 50 : 0) - (/preview|exp/i.test(n) ? 5 : 0) + (/latest/.test(n) ? 1 : 0);
  return usable.sort((a, b) => score(b) - score(a));
}

/** Quick check used by Settings → "Test key". */
export async function testGeminiKey(key) {
  const models = await listFlashModels(key);
  if (!models.length) throw new ReadError('Key works, but no Gemini Flash model is available to it.');
  return models;
}

function extractJson(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
  if (!text) {
    const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason || 'empty reply';
    throw new ReadError(`Gemini could not read this bill (${reason}).`);
  }
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ReadError('Gemini returned something unexpected. Try again.');
  }
}

export async function readWithGemini(blob, { key, model, onModel, onStatus = () => {} }) {
  onStatus('Preparing photo…');
  const data = await toJpegBase64(blob);
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  });

  const candidates = [...new Set([model, ...DEFAULT_MODELS].filter(Boolean))];
  let discovered = false;
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    onStatus(`Reading bill with AI…`);
    try {
      const body = await geminiFetch(`models/${encodeURIComponent(m)}:generateContent`, key, {
        method: 'POST',
        body: payload,
      });
      onModel?.(m);
      return normalise(extractJson(body), 'ai');
    } catch (e) {
      lastErr = e;
      if (e.kind === 'key' || e.kind === 'network') throw e;
      // Model missing / renamed / over quota → try the next one, discovering live models once.
      if (!discovered && i === candidates.length - 1) {
        discovered = true;
        try {
          const live = await listFlashModels(key);
          for (const lm of live) if (!candidates.includes(lm)) candidates.push(lm);
        } catch (le) {
          if (le.kind === 'key' || le.kind === 'network') throw le;
        }
      }
    }
  }
  throw lastErr || new ReadError('Gemini could not read this bill.');
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
