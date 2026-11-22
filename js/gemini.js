// Gemini bill reader. Shared by the website (own-key mode) and the
// Cloudflare Worker in /worker (shared-key mode). Uses only `fetch`, so it
// runs in browsers and in Workers.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];

export class ReadError extends Error {
  constructor(message, { kind = 'error', status } = {}) {
    super(message);
    this.kind = kind; // 'key' | 'quota' | 'network' | 'model' | 'error'
    this.status = status;
  }
}

export const SCHEMA = {
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

export const PROMPT = `This is a photo of a restaurant / cafe / shop bill (often Indian). Read it carefully and return JSON.

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
    const msg = body?.error?.message || `HTTP ${res.status}`;
    const status = body?.error?.status || '';
    if (res.status === 429 || status === 'RESOURCE_EXHAUSTED') {
      throw new ReadError('Free AI limit reached for now.', { kind: 'quota', status: 429 });
    }
    if (res.status !== 404 && /api key|API_KEY|PERMISSION_DENIED|UNAUTHENTICATED/i.test(msg + status)) {
      throw new ReadError('Gemini API key is not valid.', { kind: 'key', status: res.status });
    }
    throw new ReadError(msg, { kind: res.status === 404 ? 'model' : 'error', status: res.status });
  }
  return body;
}

/** generateContent-capable Flash models available to this key, best first. */
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

function extractJson(body) {
  const parts = body?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
  if (!text) {
    const reason = body?.candidates?.[0]?.finishReason || body?.promptFeedback?.blockReason || 'empty reply';
    throw new ReadError(`The AI could not read this bill (${reason}).`);
  }
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new ReadError('The AI returned something unexpected. Try again.');
  }
}

/**
 * Reads a JPEG (base64, no data: prefix) and returns the raw bill JSON.
 * Tries the preferred model, then the default aliases, then any live Flash model.
 */
export async function geminiReadBill({ key, base64, mimeType = 'image/jpeg', model, onModel }) {
  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA },
  });
  const candidates = [...new Set([model, ...DEFAULT_MODELS].filter(Boolean))];
  let discovered = false;
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    try {
      const body = await geminiFetch(`models/${encodeURIComponent(m)}:generateContent`, key, {
        method: 'POST',
        body: payload,
      });
      onModel?.(m);
      return extractJson(body);
    } catch (e) {
      lastErr = e;
      if (e.kind === 'key' || e.kind === 'network') throw e;
      if (!discovered && i === candidates.length - 1) {
        discovered = true;
        try {
          for (const lm of await listFlashModels(key)) if (!candidates.includes(lm)) candidates.push(lm);
        } catch (le) {
          if (le.kind === 'key' || le.kind === 'network') throw le;
        }
      }
    }
  }
  throw lastErr || new ReadError('The AI could not read this bill.');
}
