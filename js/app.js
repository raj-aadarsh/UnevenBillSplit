import { computeSplit, round2 } from './split.js';
import { readWithSharedReader, readOnDevice, readFromText } from './ocr.js';
import { SHARED_READER_URL } from './config.js';

// ---------- tiny helpers ----------

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const parseAmt = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage full / private mode */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const K = { settings: 'ubs.settings', draft: 'ubs.draft' };
// No split history is kept. Remove any left by earlier versions.
store.del('ubs.history');
const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#9333ea'];

const CUR = '₹';
let settings = { mode: 'auto', ...store.get(K.settings, {}) };
delete settings.currency; // always rupees
// Older versions let people save their own Gemini key on the phone. The key now
// lives only on the server, so wipe any copy left in this browser.
if ('apiKey' in settings || 'model' in settings) {
  delete settings.apiKey;
  delete settings.model;
  store.set(K.settings, settings);
}
let draft = store.get(K.draft, null);
let view = 'home';
let reading = null; // { url, status, progress, token, error }
let installPrompt = null;
let reloadWhenHome = false; // a new version is ready; reload when back on home

const saveSettings = () => store.set(K.settings, settings);
let draftTimer;
const saveDraft = () => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => (draft ? store.set(K.draft, draft) : store.del(K.draft)), 250);
};

const money = (n) => {
  const v = round2(Number(n) || 0);
  const abs = Math.abs(v);
  const whole = Number.isInteger(abs);
  const s = abs.toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  return `${v < 0 ? '−' : ''}${CUR}${s}`;
};
const amtInputValue = (n) => (n === '' || n === null || n === undefined ? '' : String(round2(Number(n))));
const colorOf = (i) => COLORS[i % COLORS.length];
const initial = (name) => (String(name).trim()[0] || '?').toUpperCase();
const fraction = (n) => ({ 2: '½', 3: '⅓', 4: '¼', 5: '⅕', 6: '⅙', 8: '⅛' })[n] || `1/${n}`;
const fmtDate = (ts) =>
  new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- icons ----------

const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
  paste: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

// ---------- draft model ----------

function newDraft(src = {}) {
  draft = {
    id: uid(),
    createdAt: Date.now(),
    step: 'review',
    bill: {
      merchant: src.merchant || '',
      source: src.source || 'manual',
      note: src.note || '',
      rawText: src.source === 'ocr' ? String(src.rawText || '').slice(0, 6000) : '',
      items: (src.items || []).map((it) => ({ id: uid(), name: it.name, amount: it.amount, people: [] })),
      charges: (src.charges || []).map((c) => ({ id: uid(), name: c.name, amount: c.amount })),
      discount: src.discount || 0,
      total: src.total || 0,
    },
    people: draft?.people?.length ? draft.people.map((p) => ({ id: uid(), name: p.name })) : [],
    discountPct: 0,
    paid: '',
    assignMode: 'item',
    activePerson: null,
  };
  saveDraft();
}

const FLOW = ['review', 'people', 'assign', 'discount', 'result'];
const PREV = { settings: 'home', paste: 'home', reading: 'home', review: 'home', people: 'review', assign: 'people', discount: 'assign', result: 'discount' };
const TITLES = {
  home: 'Uneven Bill Split',
  settings: 'Settings',
  paste: 'Paste bill text',
  reading: 'Reading bill',
  review: 'Check items',
  people: 'Who’s splitting?',
  assign: 'Who had what?',
  discount: 'Amount paid',
  result: 'The split',
};

function go(v, { replace = false } = {}) {
  if (v === 'home' && reloadWhenHome) {
    location.replace(location.pathname);
    return;
  }
  view = v;
  if (draft && FLOW.includes(v)) {
    draft.step = v;
    saveDraft();
  }
  $('#toast')?.classList.remove('show');
  const state = { v };
  if (replace) history.replaceState(state, '');
  else history.pushState(state, '');
  render();
  window.scrollTo(0, 0);
}

window.addEventListener('popstate', (e) => {
  let v = e.state?.v || 'home';
  if (FLOW.includes(v) && !draft) v = 'home';
  if (v === 'reading' && !reading) v = 'home';
  view = v;
  render();
});

// ---------- rendering ----------

function render() {
  const app = $('#app');
  const body = (VIEWS[view] || VIEWS.home)();
  app.innerHTML = header() + `<main class="screen screen-${view}">${body}</main>` + (FOOTERS[view]?.() || '');
  AFTER[view]?.();
}

function header() {
  const flowIdx = FLOW.indexOf(view);
  const left =
    view === 'home'
      ? '<span></span>'
      : `<button class="icon-btn" data-action="back" aria-label="Back">${I.back}</button>`;
  const right =
    view === 'home'
      ? `<button class="icon-btn" data-action="settings" aria-label="Settings">${I.gear}</button>`
      : '<span></span>';
  const progress =
    flowIdx >= 0
      ? `<div class="progress" aria-label="Step ${flowIdx + 1} of ${FLOW.length}">${FLOW.map(
          (_, i) => `<span class="${i <= flowIdx ? 'done' : ''}"></span>`,
        ).join('')}</div>`
      : '';
  return `<header class="topbar">${left}<div class="title">${esc(TITLES[view])}</div>${right}${progress}</header>`;
}

const actionbar = (inner) => `<div class="actionbar"><div class="actionbar-inner">${inner}</div></div>`;

const VIEWS = {};
const FOOTERS = {};
const AFTER = {};

// ----- home -----

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

VIEWS.home = () => {
  const aiOn = !!SHARED_READER_URL && settings.mode !== 'device';
  const cont =
    draft && draft.bill.items.length && draft.step !== 'result'
      ? `<div class="section-title">In progress</div>
         <div class="list"><button class="list-row" data-action="continue">
           <div class="grow"><div class="t1">${esc(draft.bill.merchant || 'Unfinished bill')}</div>
           <div class="t2">${draft.bill.items.length} items · ${esc(TITLES[draft.step] || '')}</div></div>
           <span class="amt" style="color:var(--accent)">Continue</span></button></div>`
      : '';
  let install = '';
  if (!isStandalone()) {
    if (installPrompt) {
      install = `<div class="banner"><span class="b-icon">📲</span><div style="flex:1">Install Uneven Bill Split as an app on this phone.</div><button class="btn btn-primary" style="min-height:36px;padding:0 14px;font-size:15px" data-action="install">Install</button></div>`;
    } else if (isIOS()) {
      install = `<div class="banner"><span class="b-icon">📲</span><div>Use it like an app: tap <b>Share</b> <span aria-hidden="true">⎋</span> then <b>Add to Home Screen</b>.</div></div>`;
    }
  }
  return `
    <section class="hero">
      <img class="hero-logo" src="icons/icon.svg" alt="" width="76" height="76" />
      <h1>Snap the bill.<br/>Tap who had what.</h1>
      <p>Taxes &amp; service charge are shared equally.</p>
    </section>
    <label class="btn btn-primary btn-xl btn-block">
      <input class="vh" type="file" accept="image/*" capture="environment" data-change="photo" />
      ${I.camera} Scan bill
    </label>
    <div class="tiles">
      <label class="tile"><input class="vh" type="file" accept="image/*" data-change="photo" />${I.image}From photos</label>
      <button class="tile" data-action="paste">${I.paste}Paste text</button>
      <button class="tile" data-action="manual">${I.pen}Type items</button>
    </div>
    <button class="mode-pill ${aiOn ? 'on' : ''}" data-action="settings">
      <span class="dot"></span>
      <span>${aiOn ? 'AI bill reading is on' : 'Reading bills on this phone'}</span>
      <span class="go">Settings</span>
    </button>
    ${install ? `<div style="margin-top:12px">${install}</div>` : ''}
    ${cont}
    <p class="hint center" style="margin-top:28px">No history is kept. Nothing is saved online.</p>`;
};

// ----- settings -----

VIEWS.settings = () => `
    <div class="section-title">Bill reading</div>
    <div class="card" style="padding:4px 16px">
      <label class="radio-row"><input type="radio" name="mode" value="auto" data-change="mode" ${settings.mode !== 'device' ? 'checked' : ''}/>
        <div><div>AI <small class="tag">Recommended</small></div><div class="t2">Google’s AI reads the bill like a person would, even crumpled, faded or tilted ones. Needs internet and takes a few seconds. If it can’t respond, On-device OCR is used automatically.</div></div></label>
      <label class="radio-row"><input type="radio" name="mode" value="device" data-change="mode" ${settings.mode === 'device' ? 'checked' : ''}/>
        <div><div>On-device OCR</div><div class="t2">Reads the text right on your phone. Works without internet and the photo never leaves your phone. Best with a clear, flat, well-lit photo. Check the items afterwards.</div></div></label>
    </div>`;

// ----- paste -----

VIEWS.paste = () => `
  <div class="banner"><span class="b-icon">💡</span><div><b>iPhone tip:</b> open the bill photo in Photos, press and hold on the text, tap <b>Select All</b>, then <b>Copy</b>. Paste it here. Android: use Google Lens → <b>Copy text</b>.</div></div>
  <div class="form-row">
    <textarea id="paste-in" class="text-in" placeholder="Paneer Tikka 2 360.00&#10;Butter Naan 4 180.00&#10;CGST 2.5% 13.50&#10;…"></textarea>
  </div>`;
FOOTERS.paste = () =>
  actionbar(`<button class="btn btn-primary btn-block" data-action="read-text">Find items</button>`);

// ----- reading -----

VIEWS.reading = () => {
  if (reading?.error) {
    return `<div class="reading">
      ${reading.url ? `<div class="preview"><img src="${reading.url}" alt="Bill photo"/></div>` : ''}
      <div class="status">Couldn’t read this bill</div>
      <p class="hint">${esc(reading.error)}</p>
      <div style="display:flex;flex-direction:column;gap:10px;width:100%;max-width:340px;margin-top:8px">
        <button class="btn btn-primary" data-action="retry">Try again</button>
        <button class="btn btn-secondary" data-action="paste">Paste text instead</button>
        <button class="btn btn-secondary" data-action="manual">Type items</button>
      </div></div>`;
  }
  return `<div class="reading">
    <div class="preview">${reading?.url ? `<img src="${reading.url}" alt="Bill photo"/>` : ''}<div class="scanline"></div></div>
    <div class="status" id="read-status">${esc(reading?.status || 'Starting…')}</div>
    <div class="bar" id="read-bar" style="${reading?.progress == null ? 'visibility:hidden' : ''}"><i style="width:${Math.round((reading?.progress || 0) * 100)}%"></i></div>
    <p class="hint" id="read-note">${esc(reading?.note || '')}</p>
  </div>`;
};
FOOTERS.reading = () => (reading?.error ? '' : actionbar(`<button class="btn btn-secondary btn-block" data-action="cancel-read">Cancel</button>`));

// ----- review -----

function rowHtml(list, r) {
  return `<div class="edit-row" data-id="${r.id}">
    <input class="in name" data-list="${list}" data-field="name" value="${esc(r.name)}" placeholder="${list === 'items' ? 'Item name' : 'e.g. CGST'}" enterkeyhint="next" autocapitalize="words" />
    ${list === 'charges' ? `<button class="mini-btn" data-action="neg" data-list="${list}" aria-label="Make negative">±</button>` : ''}
    <div class="money"><span class="cur">${CUR}</span><input class="in" data-list="${list}" data-field="amount" inputmode="decimal" value="${amtInputValue(r.amount)}" placeholder="0" enterkeyhint="next" /></div>
    <button class="mini-btn" data-action="del-row" data-list="${list}" aria-label="Remove">${I.x}</button>
  </div>`;
}

VIEWS.review = () => {
  const b = draft.bill;
  const notes = [];
  if (b.note) notes.push(`<div class="banner warn"><span class="b-icon">⚠️</span><div>${esc(b.note)}</div></div>`);
  if (b.source === 'ocr' || b.source === 'text')
    notes.push(`<div class="banner"><span class="b-icon">👀</span><div>Read on this phone. Quickly check names and amounts below. Fix anything wrong.</div></div>`);
  if (b.source === 'ai')
    notes.push(`<div class="banner"><span class="b-icon">✨</span><div>Read by AI. Give it a quick check against the bill.</div></div>`);
  if (!b.items.length && b.source !== 'manual')
    notes.push(`<div class="banner warn"><span class="b-icon">🔍</span><div>No items found. Add them below, or go back and try a clearer photo.</div></div>`);
  return `
    ${notes.join('')}
    <div class="section-title" style="margin-top:14px">Bill name</div>
    <div class="field"><input class="in" style="flex:1" data-field="merchant" value="${esc(b.merchant)}" placeholder="Restaurant name (optional)" autocapitalize="words" /></div>
    <div class="section-title">Items <small>${b.items.length}</small></div>
    <div class="edit-list" id="items-list">${b.items.map((r) => rowHtml('items', r)).join('') || '<div class="empty">No items yet</div>'}</div>
    <button class="add-btn" data-action="add-row" data-list="items">+ Add item</button>
    <div class="section-title">Taxes &amp; charges <small>split equally</small></div>
    <div class="edit-list" id="charges-list">${b.charges.map((r) => rowHtml('charges', r)).join('') || '<div class="empty">No taxes or service charge</div>'}</div>
    <button class="add-btn" data-action="add-row" data-list="charges">+ Add tax / service charge</button>
    <div class="section-title">Discount printed on bill <small>optional</small></div>
    <div class="field"><label>Shared by what each person ordered</label>
      <div class="money"><span class="cur">${CUR}</span><input class="in" data-field="discount" inputmode="decimal" value="${b.discount ? amtInputValue(b.discount) : ''}" placeholder="0" /></div></div>
    <div class="card summary" id="review-summary">${reviewSummary()}</div>
    <div class="section-title">Total printed on bill <small>updates when you remove a charge</small></div>
    <div class="field"><label>Grand total</label>
      <div class="money"><span class="cur">${CUR}</span><input class="in" data-field="total" inputmode="decimal" value="${b.total ? amtInputValue(b.total) : ''}" placeholder="0" /></div></div>
    ${b.rawText ? `<details class="card" style="margin-top:16px"><summary style="font-weight:600">Text read from the photo</summary>
      <pre style="white-space:pre-wrap;font-size:12px;color:var(--muted);margin:10px 0 0">${esc(b.rawText)}</pre></details>` : ''}`;
};

function reviewSummary() {
  const b = draft.bill;
  const items = b.items.reduce((a, x) => a + parseAmt(x.amount), 0);
  const charges = b.charges.reduce((a, x) => a + parseAmt(x.amount), 0);
  const disc = parseAmt(b.discount);
  const total = round2(items + charges - disc);
  let match = '';
  if (parseAmt(b.total) > 0) {
    const diff = round2(total - parseAmt(b.total));
    match =
      Math.abs(diff) < 1
        ? `<div class="match ok">✓ Matches the bill total of ${money(b.total)}</div>`
        : `<div class="match bad">⚠ Bill says ${money(b.total)}, this adds up to ${money(total)} (${diff > 0 ? '+' : ''}${money(diff)}). Check for a missing or misread line.</div>`;
  }
  return `
    <div class="sum-row"><span class="muted">Items</span><span>${money(items)}</span></div>
    <div class="sum-row"><span class="muted">Taxes &amp; charges</span><span>${money(charges)}</span></div>
    ${disc ? `<div class="sum-row"><span class="muted">Discount on bill</span><span>−${money(disc)}</span></div>` : ''}
    <div class="sum-row total"><span>Bill total</span><span>${money(total)}</span></div>
    ${match}`;
}

FOOTERS.review = () =>
  actionbar(
    `<button class="btn btn-primary btn-block ${draft.bill.items.length ? '' : 'disabled'}" data-action="to-people">Next · Add people</button>`,
  );

// ----- people -----

VIEWS.people = () => {
  const n = draft.people.length;
  return `
    <div class="card count-card">
      <span class="lbl">How many people?</span>
      <div class="stepper">
        <button data-action="dec-people" aria-label="Fewer" ${n <= 1 ? 'disabled' : ''}>−</button>
        <output>${n}</output>
        <button data-action="inc-people" aria-label="More" ${n >= 30 ? 'disabled' : ''}>+</button>
      </div>
    </div>
    <div class="section-title">Names</div>
    <div class="card" style="padding:4px 16px">
      ${draft.people
        .map(
          (p, i) => `<div class="name-row"><span class="avatar" style="--c:${colorOf(i)}">${esc(initial(p.name || String(i + 1)))}</span>
          <input class="in" data-person="${p.id}" value="${esc(p.name)}" placeholder="Person ${i + 1}" autocapitalize="words" autocomplete="off" enterkeyhint="${i === n - 1 ? 'done' : 'next'}" /></div>`,
        )
        .join('')}
    </div>
`;
};
FOOTERS.people = () => actionbar(`<button class="btn btn-primary btn-block" data-action="to-assign">Next · Who had what</button>`);
AFTER.people = () => {
  const firstEmpty = $$('[data-person]').find((i) => !i.value);
  if (firstEmpty && !matchMedia('(hover: none)').matches) firstEmpty.focus();
};

function setPeopleCount(n) {
  n = Math.max(1, Math.min(30, n));
  while (draft.people.length < n) draft.people.push({ id: uid(), name: '' });
  while (draft.people.length > n) {
    const p = draft.people.pop();
    for (const it of draft.bill.items) it.people = it.people.filter((id) => id !== p.id);
  }
  saveDraft();
}

function finalisePeople() {
  const seen = new Map();
  draft.people.forEach((p, i) => {
    let name = p.name.trim() || `Person ${i + 1}`;
    const key = name.toLowerCase();
    if (seen.has(key)) {
      seen.set(key, seen.get(key) + 1);
      name = `${name} ${seen.get(key)}`;
    } else seen.set(key, 1);
    p.name = name;
  });
  saveDraft();
}

// ----- assign -----

const personIndex = (id) => draft.people.findIndex((p) => p.id === id);

VIEWS.assign = () => {
  const mode = draft.assignMode || 'item';
  const seg = `<div class="segmented" role="tablist">
    <button class="${mode === 'item' ? 'on' : ''}" data-action="assign-mode" data-mode="item">By item</button>
    <button class="${mode === 'person' ? 'on' : ''}" data-action="assign-mode" data-mode="person">By person</button></div>`;

  if (mode === 'person') {
    if (!draft.people.find((p) => p.id === draft.activePerson)) draft.activePerson = draft.people[0]?.id;
    const ap = draft.activePerson;
    const apIdx = personIndex(ap);
    return `${seg}
      <div class="chips scroll">${draft.people
        .map((p, i) => `<button class="chip ${p.id === ap ? 'on' : ''}" data-action="active-person" data-person="${p.id}">${esc(p.name)}</button>`)
        .join('')}</div>
      <p class="hint">Tap everything <b>${esc(draft.people[apIdx]?.name || '')}</b> had. Shared items are split equally.</p>
      <div class="list">${draft.bill.items
        .map((it) => {
          const on = it.people.includes(ap);
          const names = it.people.map((id) => esc(draft.people[personIndex(id)]?.name || '')).join(', ');
          return `<button class="pick-row ${on ? 'on' : ''}" data-action="pick" data-id="${it.id}">
            <div class="grow"><div class="t1">${esc(it.name)}</div>
              <div class="t2">${it.people.length ? names : '<span style="color:var(--warn)">Nobody yet</span>'}</div></div>
            <span class="amt">${money(it.amount)}</span></button>`;
        })
        .join('')}</div>`;
  }

  return `${seg}${draft.bill.items
    .map((it) => {
      const all = draft.people.length > 1 && it.people.length === draft.people.length;
      const n = it.people.length;
      return `<div class="item-card ${n ? '' : 'pending'}" data-id="${it.id}">
        <div class="item-top"><span class="item-name">${esc(it.name)}</span><span class="item-amt">${money(it.amount)}</span></div>
        <div class="chips">
          ${draft.people.length > 1 ? `<button class="chip all ${all ? 'on' : ''}" data-action="toggle-all" data-id="${it.id}">Everyone</button>` : ''}
          ${draft.people
            .map((p, i) => `<button class="chip ${it.people.includes(p.id) ? 'on' : ''}" data-action="toggle" data-id="${it.id}" data-person="${p.id}">${esc(p.name)}</button>`)
            .join('')}
        </div>
        ${n > 1 ? `<div class="item-split">${money(parseAmt(it.amount) / n)} each · ${fraction(n)} share</div>` : ''}
      </div>`;
    })
    .join('')}`;
};

FOOTERS.assign = () => {
  const s = computeSplit(draft.bill, draft.people, 0);
  const left = s.unassigned.length;
  return actionbar(`
    <div class="tally">${s.people
      .map((p) => `<span class="t">${esc(p.name)} ${money(p.final)}</span>`)
      .join('')}</div>
    <div class="meta"><span>${left ? `<span class="warn">${left} item${left > 1 ? 's' : ''} not assigned</span>` : '<strong>All items assigned ✓</strong>'}</span><span>incl. tax share</span></div>
    <button class="btn btn-primary btn-block ${left ? 'disabled' : ''}" data-action="to-discount">Next · Amount paid</button>`);
};

// ----- discount -----

const finalSplit = () => computeSplit(draft.bill, draft.people, draft.discountPct, draft.paid);
const pctText = (p) => `${Math.abs(Math.round(p * 100) / 100)}%`;
function discountLine(s) {
  if (s.extraDiscountTotal > 0.004) return `Discount ${money(s.extraDiscountTotal)} (${pctText(s.discountPct)})`;
  if (s.extraDiscountTotal < -0.004) return `Extra paid ${money(-s.extraDiscountTotal)} (${pctText(s.discountPct)})`;
  return '';
}

VIEWS.discount = () => {
  const s = computeSplit(draft.bill, draft.people, 0);
  return `
  <div class="card center" style="padding:24px 16px">
    <div style="font-weight:650;font-size:18px">How much did you actually pay?</div>
    <div class="hint" style="margin:6px 0 0">Enter the final amount after any card, app or coupon discount. The difference is shared in proportion to what each person owes.</div>
    <div class="pct-input"><span>${CUR}</span><input id="paid-in" inputmode="decimal" data-field="paid" value="${draft.paid ? esc(draft.paid) : ''}" placeholder="${amtInputValue(s.billTotal)}" aria-label="Amount paid" style="width:210px" /></div>
    <div class="chips center"><button class="chip ${draft.paid ? '' : 'on'}" data-action="paid-full">Paid the full bill · ${money(s.billTotal)}</button></div>
  </div>
  <div class="card summary" id="disc-preview">${discountPreview()}</div>`;
};

function discountPreview() {
  const s = finalSplit();
  const diff = s.extraDiscountTotal;
  const row =
    Math.abs(diff) > 0.004
      ? `<div class="sum-row"><span class="muted">${diff > 0 ? 'Discount received' : 'Extra paid'} <small>(${pctText(s.discountPct)})</small></span><span>${diff > 0 ? '−' : '+'}${money(Math.abs(diff))}</span></div>`
      : '';
  const warn =
    s.paid && s.paid < s.billTotal * 0.5
      ? `<div class="match bad">That is less than half the bill. Check the amount.</div>`
      : '';
  return `
    <div class="sum-row"><span class="muted">Bill total</span><span>${money(s.billTotal)}</span></div>
    ${row}
    <div class="sum-row total"><span>${s.paid ? 'You paid' : 'To pay'}</span><span>${money(s.grandTotal)}</span></div>
    ${warn}`;
}
FOOTERS.discount = () => actionbar(`<button class="btn btn-primary btn-block" data-action="to-result">See the split</button>`);

// ----- result -----

VIEWS.result = () => {
  const s = finalSplit();
  const b = draft.bill;
  const subBits = [`Items ${money(s.itemsTotal)}`];
  if (s.chargesTotal) subBits.push(`Taxes &amp; charges ${money(s.chargesTotal)}`);
  if (s.billDiscount) subBits.push(`Bill discount −${money(s.billDiscount)}`);
  if (discountLine(s)) subBits.push(discountLine(s));
  const ok = Math.abs(s.sharesTotal - s.grandTotal) < 0.005;
  return `
    <div class="total-card">
      <div class="m">${esc(b.merchant || 'Bill')} · ${fmtDate(draft.createdAt)}</div>
      <div class="g">${money(s.grandTotal)}</div>
      <div class="s">${subBits.join(' · ')}</div>
    </div>
    ${s.people
      .map(
        (p, i) => `<details class="person-card">
        <summary><span class="avatar" style="--c:${colorOf(i)}">${esc(initial(p.name))}</span><span class="pname">${esc(p.name)}</span><span class="pamt">${money(p.final)}</span>${I.chev}</summary>
        <div class="breakdown">
          ${p.items.map((it) => `<div class="sum-row"><span>${esc(it.name)}${it.splitBy > 1 ? ` <small>(${fraction(it.splitBy)} of ${money(it.amount)})</small>` : ''}</span><span>${money(it.share)}</span></div>`).join('') || '<div class="sum-row"><span>No items</span><span></span></div>'}
          <div class="sep"></div>
          <div class="sum-row"><span>Items</span><span>${money(p.itemTotal)}</span></div>
          ${p.billDiscShare ? `<div class="sum-row"><span>Bill discount share</span><span>−${money(p.billDiscShare)}</span></div>` : ''}
          ${s.chargesTotal ? `<div class="sum-row"><span>Taxes &amp; charges (1/${s.people.length})</span><span>${money(p.chargeShare)}</span></div>` : ''}
          ${Math.abs(p.extraDiscount) > 0.004 ? `<div class="sum-row"><span>Before discount</span><span>${money(p.beforeDiscount)}</span></div>
          <div class="sum-row"><span>${p.extraDiscount > 0 ? 'Discount' : 'Extra paid'} (${pctText(s.discountPct)})</span><span>${p.extraDiscount > 0 ? '−' : '+'}${money(Math.abs(p.extraDiscount))}</span></div>` : ''}
          <div class="sum-row strong"><span>Pays</span><span>${money(p.final)}</span></div>
        </div></details>`,
      )
      .join('')}
    <div class="match ${ok ? 'ok' : 'bad'}" style="margin-top:14px;text-align:center">${ok ? `✓ Everyone’s shares add up to ${money(s.grandTotal)}` : `Shares add up to ${money(s.sharesTotal)}`}</div>`;
};
FOOTERS.result = () =>
  actionbar(`<div class="row-btns">
    <button class="btn btn-secondary" data-action="new-split">New split</button>
    <button class="btn btn-primary" data-action="share">${I.share} Share</button></div>`);
function shareText() {
  const s = finalSplit();
  const lines = [`🧾 ${draft.bill.merchant || 'Bill'} · ${fmtDate(draft.createdAt)}`, `Total: ${money(s.grandTotal)}`];
  const extra = [];
  if (s.chargesTotal) extra.push(`taxes & charges ${money(s.chargesTotal)} split equally`);
  if (discountLine(s)) extra.push(discountLine(s).toLowerCase());
  if (extra.length) lines.push(`(${extra.join(', ')})`);
  lines.push('');
  for (const p of s.people) {
    lines.push(`${p.name}: ${money(p.final)}`);
    for (const it of p.items) lines.push(`   • ${it.name}${it.splitBy > 1 ? ` (${fraction(it.splitBy)})` : ''} ${money(it.share)}`);
  }
  return lines.join('\n');
}

// ---------- reading flow ----------

let lastFile = null;

function setReadStatus(status, progress) {
  if (!reading) return;
  if (status != null) reading.status = status;
  if (progress !== undefined) reading.progress = progress;
  const st = $('#read-status');
  if (st && status != null) st.textContent = status;
  const bar = $('#read-bar');
  if (bar && progress !== undefined) {
    bar.style.visibility = progress == null ? 'hidden' : '';
    bar.firstElementChild.style.width = `${Math.round((progress || 0) * 100)}%`;
  }
}

async function handlePhoto(file) {
  if (!file) return;
  lastFile = file;
  if (reading?.url) URL.revokeObjectURL(reading.url);
  const token = uid();
  reading = { url: URL.createObjectURL(file), status: 'Starting…', progress: null, token, note: '' };
  go('reading');
  const alive = () => reading && reading.token === token;

  let result;
  let note = '';
  const onStatus = (s) => alive() && setReadStatus(s);
  // AI reader on the server first, then on-device.
  const aiReaders = [];
  if (settings.mode !== 'device' && SHARED_READER_URL)
    aiReaders.push(() => readWithSharedReader(file, { url: SHARED_READER_URL, onStatus }));
  try {
    for (const read of aiReaders) {
      try {
        result = await read();
        note = '';
        break;
      } catch (e) {
        if (!alive()) return;
        note = `${e.message} Used on-device reading instead.`;
      }
    }
    if (!result && note) {
      const n = $('#read-note');
      if (n) n.textContent = note;
      reading.note = note;
    }
    if (!result) {
      result = await readOnDevice(file, {
        onStatus: (s) => alive() && setReadStatus(s),
        onProgress: (p) => alive() && setReadStatus(undefined, p),
      });
    }
  } catch (e) {
    if (!alive()) return;
    reading.error = e.message || 'Something went wrong.';
    render();
    return;
  }
  if (!alive()) return;
  newDraft({ ...result, note });
  reading = null;
  go('review', { replace: true });
}

// ---------- events ----------

const app = document.getElementById('app');

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const id = el.dataset.id;

  switch (a) {
    case 'back':
      if (view === 'reading') reading = null;
      go(PREV[view] || 'home');
      break;
    case 'settings':
      go('settings');
      break;
    case 'paste':
      reading = null;
      go('paste');
      break;
    case 'manual':
      reading = null;
      newDraft({ items: [{ name: '', amount: '' }] });
      go('review');
      setTimeout(() => $('#items-list .in.name')?.focus(), 50);
      break;
    case 'continue':
      go(draft.step || 'review');
      break;
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt = null;
        render();
      }
      break;
    // paste
    case 'read-text': {
      const text = $('#paste-in').value;
      if (!text.trim()) {
        toast('Paste the bill text first');
        return;
      }
      const r = readFromText(text);
      newDraft(r);
      go('review', { replace: true });
      break;
    }

    // reading
    case 'cancel-read':
      reading = null;
      go('home', { replace: true });
      break;
    case 'retry':
      handlePhoto(lastFile);
      break;

    // review
    case 'add-row': {
      const list = el.dataset.list;
      const row = list === 'items' ? { id: uid(), name: '', amount: '', people: [] } : { id: uid(), name: '', amount: '' };
      draft.bill[list].push(row);
      saveDraft();
      render();
      setTimeout(() => $(`[data-id="${row.id}"] .in.name`)?.focus(), 30);
      break;
    }
    case 'del-row': {
      const list = el.dataset.list;
      const rid = el.closest('[data-id]').dataset.id;
      const removed = draft.bill[list].find((r) => r.id === rid);
      draft.bill[list] = draft.bill[list].filter((r) => r.id !== rid);
      // Removing a tax / service charge you didn't pay lowers the grand total too.
      const removedAmt = parseAmt(removed?.amount);
      if (list === 'charges' && removedAmt && parseAmt(draft.bill.total) > 0) {
        draft.bill.total = round2(parseAmt(draft.bill.total) - removedAmt);
        toast(`Grand total updated to ${money(draft.bill.total)}`);
      }
      saveDraft();
      render();
      break;
    }
    case 'neg': {
      const rid = el.closest('[data-id]').dataset.id;
      const r = draft.bill.charges.find((x) => x.id === rid);
      r.amount = -parseAmt(r.amount);
      saveDraft();
      el.closest('.edit-row').querySelector('[data-field="amount"]').value = amtInputValue(r.amount);
      $('#review-summary').innerHTML = reviewSummary();
      break;
    }
    case 'to-people':
      draft.bill.items = draft.bill.items.filter((it) => it.name.trim() || parseAmt(it.amount));
      draft.bill.charges = draft.bill.charges.filter((c) => c.name.trim() || parseAmt(c.amount));
      draft.bill.items.forEach((it) => {
        it.amount = parseAmt(it.amount);
        if (!it.name.trim()) it.name = 'Item';
      });
      draft.bill.charges.forEach((c) => {
        c.amount = parseAmt(c.amount);
        if (!c.name.trim()) c.name = 'Charge';
      });
      if (!draft.bill.items.length) {
        toast('Add at least one item');
        render();
        return;
      }
      if (draft.people.length < 2) setPeopleCount(Math.max(2, draft.people.length));
      go('people');
      break;

    // people
    case 'inc-people':
      setPeopleCount(draft.people.length + 1);
      render();
      setTimeout(() => $$('[data-person]').at(-1)?.focus(), 30);
      break;
    case 'dec-people':
      setPeopleCount(draft.people.length - 1);
      render();
      break;
    case 'to-assign':
      finalisePeople();
      go('assign');
      break;

    // assign
    case 'assign-mode':
      draft.assignMode = el.dataset.mode;
      saveDraft();
      render();
      break;
    case 'active-person':
      draft.activePerson = el.dataset.person;
      saveDraft();
      render();
      break;
    case 'toggle': {
      const it = draft.bill.items.find((x) => x.id === id);
      const pid = el.dataset.person;
      it.people = it.people.includes(pid) ? it.people.filter((x) => x !== pid) : [...it.people, pid];
      saveDraft();
      render();
      break;
    }
    case 'toggle-all': {
      const it = draft.bill.items.find((x) => x.id === id);
      it.people = it.people.length === draft.people.length ? [] : draft.people.map((p) => p.id);
      saveDraft();
      render();
      break;
    }
    case 'pick': {
      const it = draft.bill.items.find((x) => x.id === id);
      const pid = draft.activePerson;
      it.people = it.people.includes(pid) ? it.people.filter((x) => x !== pid) : [...it.people, pid];
      saveDraft();
      render();
      break;
    }
    case 'to-discount': {
      const s = computeSplit(draft.bill, draft.people, 0);
      if (s.unassigned.length) {
        toast(`Pick who had ${s.unassigned.length === 1 ? `“${s.unassigned[0].name}”` : `${s.unassigned.length} items`}`);
        if (draft.assignMode === 'person') {
          draft.assignMode = 'item';
          render();
        }
        const card = $(`.item-card[data-id="${s.unassigned[0].id}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.remove('flash');
          void card.offsetWidth;
          card.classList.add('flash');
        }
        return;
      }
      go('discount');
      break;
    }

    // discount
    case 'paid-full':
      draft.paid = '';
      draft.discountPct = 0;
      saveDraft();
      render();
      break;
    case 'to-result':
      go('result');
      break;

    // result
    case 'share': {
      const text = shareText();
      try {
        if (navigator.share) {
          await navigator.share({ text });
          return;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied. Paste it in WhatsApp.');
      } catch {
        toast('Could not share on this device');
      }
      break;
    }
    case 'new-split':
      draft = null;
      store.del(K.draft);
      go('home', { replace: true });
      break;
  }
});

app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest('.list-row[role="button"]')) e.target.click();
  // Enter on a name/amount field jumps to the next field.
  if (e.key === 'Enter' && e.target.matches('input.in')) {
    const inputs = $$('main input.in:not([type=radio])');
    const i = inputs.indexOf(e.target);
    e.preventDefault();
    if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus();
    else e.target.blur();
  }
});

app.addEventListener('input', (e) => {
  const t = e.target;
  if (!draft && FLOW.includes(view)) return;

  if (t.dataset.list) {
    const rid = t.closest('[data-id]').dataset.id;
    const row = draft.bill[t.dataset.list].find((r) => r.id === rid);
    if (!row) return;
    row[t.dataset.field] = t.dataset.field === 'amount' ? t.value : t.value;
    saveDraft();
    if (t.dataset.field === 'amount') $('#review-summary').innerHTML = reviewSummary();
    return;
  }
  if (t.dataset.person) {
    const p = draft.people.find((x) => x.id === t.dataset.person);
    p.name = t.value;
    const av = t.parentElement.querySelector('.avatar');
    if (av) av.textContent = initial(t.value || String(draft.people.indexOf(p) + 1));
    saveDraft();
    return;
  }
  switch (t.dataset.field) {
    case 'merchant':
      draft.bill.merchant = t.value;
      saveDraft();
      break;
    case 'discount':
      draft.bill.discount = parseAmt(t.value);
      saveDraft();
      $('#review-summary').innerHTML = reviewSummary();
      break;
    case 'total':
      draft.bill.total = parseAmt(t.value);
      saveDraft();
      $('#review-summary').innerHTML = reviewSummary();
      break;
    case 'paid':
      draft.paid = t.value.replace(/[^\d.]/g, '');
      draft.discountPct = 0;
      saveDraft();
      $('#disc-preview').innerHTML = discountPreview();
      $$('[data-action="paid-full"]').forEach((c) => c.classList.toggle('on', !draft.paid));
      break;
  }
});

app.addEventListener('change', (e) => {
  const t = e.target;
  switch (t.dataset.change) {
    case 'photo':
      handlePhoto(t.files?.[0]);
      t.value = '';
      break;
    case 'mode':
      settings.mode = t.value;
      saveSettings();
      break;
  }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (view === 'home') render();
});

// ---------- boot ----------

history.replaceState({ v: 'home' }, '');
render();

// Updates: check for a new version on every launch and whenever the app comes
// back to the foreground; when one is installed, reload into it (right away on
// the home screen, otherwise as soon as the user is back on home).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker
    .register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (view === 'home') {
      reloading = true;
      location.reload();
    } else reloadWhenHome = true;
  });
}
