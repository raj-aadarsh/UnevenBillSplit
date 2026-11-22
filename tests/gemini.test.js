import test from 'node:test';
import assert from 'node:assert/strict';
import { geminiReadBill } from '../js/gemini.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (merchant) =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ merchant, items: [], charges: [] }) }] } }] }),
    { status: 200 },
  );
const err = (status, message, s = '') => new Response(JSON.stringify({ error: { message, status: s } }), { status });

function mockFetch(behaviour) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const model = decodeURIComponent(String(url).match(/models\/([^:?]+)/)?.[1] || 'list');
    calls.push(model);
    return behaviour(model);
  };
  return calls;
}

test('uses Flash-Lite first', async () => {
  const calls = mockFetch((m) => ok(m));
  const r = await geminiReadBill({ key: 'k', base64: 'AAAA', hedgeMs: 50 });
  assert.equal(r.merchant, 'gemini-flash-lite-latest');
  assert.deepEqual(calls, ['gemini-flash-lite-latest']);
});

test('busy model fails over immediately', async () => {
  const calls = mockFetch((m) => (m === 'gemini-flash-lite-latest' ? err(503, 'high demand', 'UNAVAILABLE') : ok(m)));
  const r = await geminiReadBill({ key: 'k', base64: 'AAAA', hedgeMs: 5000 });
  assert.equal(r.merchant, 'gemini-flash-latest');
  assert.deepEqual(calls, ['gemini-flash-lite-latest', 'gemini-flash-latest']);
});

test('slow model is hedged: first answer wins', async () => {
  mockFetch(async (m) => {
    if (m === 'gemini-flash-lite-latest') await wait(300);
    return ok(m);
  });
  const t0 = Date.now();
  const r = await geminiReadBill({ key: 'k', base64: 'AAAA', hedgeMs: 50 });
  assert.equal(r.merchant, 'gemini-flash-latest');
  assert.ok(Date.now() - t0 < 250);
});

test('bad key stops at once', async () => {
  const calls = mockFetch(() => err(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'));
  await assert.rejects(geminiReadBill({ key: 'k', base64: 'AAAA', hedgeMs: 50 }), (e) => e.kind === 'key');
  assert.equal(calls.length, 1);
});

test('quota on every model reports quota', async () => {
  mockFetch(() => err(429, 'quota', 'RESOURCE_EXHAUSTED'));
  await assert.rejects(geminiReadBill({ key: 'k', base64: 'AAAA', hedgeMs: 50 }), (e) => e.kind === 'quota');
});
