// Bill Split — shared AI reader (Cloudflare Worker, free plan).
//
// Holds the Gemini API key as an encrypted Worker secret
// (GEMINI_API_KEY, or Gemini_Api_Key as it was first saved).
// The key never leaves Cloudflare: the website sends a bill photo, this
// Worker asks Gemini to read it, and only the item list is sent back.
//
// Abuse limits: only the website's origin may call it, it only reads bills
// (fixed prompt, image-only input), photo size is capped, and each visitor is
// rate-limited. As long as billing is never enabled on the Google project,
// the key can only ever use the free tier — it cannot cost money.

import { geminiReadBill, ReadError } from '../js/gemini.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // base64 characters
const PER_IP_PER_MINUTE = 12;
const hits = new Map(); // per-isolate, best-effort

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > PER_IP_PER_MINUTE;
}

function corsHeaders(origin, allowed) {
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const allowed = allowedOrigins.includes(origin);
    const cors = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (request.method === 'GET' && url.pathname === '/') return json({ ok: true }, 200, cors);
    if (request.method !== 'POST' || url.pathname !== '/read') return json({ error: 'Not found' }, 404, cors);
    if (!allowed) return json({ error: 'This reader only works from the Bill Split website.' }, 403, cors);
    const apiKey = env.GEMINI_API_KEY || env.Gemini_Api_Key;
    if (!apiKey) return json({ error: 'AI reader is not set up yet.' }, 503, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) return json({ error: 'Too many scans. Wait a minute.' }, 429, cors);

    let image;
    try {
      ({ image } = await request.json());
    } catch {
      return json({ error: 'Bad request' }, 400, cors);
    }
    if (typeof image !== 'string' || !image.length || image.length > MAX_IMAGE_BYTES || !/^[A-Za-z0-9+/=]+$/.test(image)) {
      return json({ error: 'Photo is missing or too large.' }, 400, cors);
    }

    try {
      const t0 = Date.now();
      let used = '';
      const bill = await geminiReadBill({ key: apiKey, base64: image, model: env.GEMINI_MODEL, onModel: (m) => (used = m), onAttempt: (m, ms, e) => console.log('attempt failed', m, `${ms}ms`, e.kind, e.status, String(e.message).slice(0, 160)) });
      console.log('read ok', used, `${Date.now() - t0}ms`);
      return json(bill, 200, cors);
    } catch (e) {
      const status = e instanceof ReadError && e.kind === 'quota' ? 429 : 502;
      // Never echo upstream error text: it could mention key or project details.
      const message = status === 429 ? 'Free AI limit reached for now.' : 'The AI could not read this bill.';
      console.log('gemini error', e?.kind, e?.status);
      return json({ error: message }, status, cors);
    }
  },
};
