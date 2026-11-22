// Turns raw bill text (from on-device OCR or pasted Live Text) into
// { items, charges, discount, total, merchant }. Heuristic — the Review screen
// lets the user fix anything it gets wrong.

const NUM_RE = /-?\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?/g;

const SKIP_RE =
  /\b(sub\s*-?\s*total|s\s*\/\s*total|qty|quantity|invoice|inv\s*no|bill\s*(no|#|number)|receipt\s*no|date|time|table|tbl|gstin|gst\s*no|gst\s*in|fssai|cin|pan|hsn|sac|ph(one)?|mob(ile)?|tel|cover|covers|pax|kot|token|order\s*(no|#|id)|thank|visit|again|steward|waiter|cashier|server|captain|guest|no\.?\s*of\s*items|total\s*items|total\s*qty|items?\s*:|cash|card|upi|paytm|gpay|phonepe|paid|tender(ed)?|change|balance|due\s*date|www|http|email|e-?mail|address|road|street|nagar|marg)\b/i;
const CHARGE_RE =
  /\b(c\s*\.?\s*gst|s\s*\.?\s*gst|i\s*\.?\s*gst|u\s*\.?\s*t\s*\.?\s*gst|gst|vat|tax(es)?|cess|service|serv\.?\s*ch(g|arge)?|s\s*\.?\s*c(hg|harge)?|svc|round\s*-?\s*(off|ing)|r\s*\.?\s*off|packing|packaging|delivery|container|surcharge)\b/i;
const DISC_RE = /\b(disc(ount)?|less|offer|promo|coupon|saving|savings)\b/i;
const TOTAL_RE =
  /\b(grand\s*total|net\s*(amt|amount|payable|total)|total\s*(amount|amt|payable|due|bill)?|amount\s*(payable|due)|bill\s*(amount|amt|total)|to\s*pay|payable)\b/i;

function cleanLine(raw) {
  return raw
    .replace(/[|¦]/g, ' ')
    .replace(/(₹|rs\.?|inr)\s*/gi, ' ')
    .replace(/(\d)\s*[,](\d{2})(?!\d)/g, '$1.$2') // 120,00 → 120.00
    .replace(/(\d)\s+\.\s*(\d{2})(?!\d)/g, '$1.$2') // 120 .00 → 120.00
    .replace(/\/-\s*$/, '')
    .replace(/[*#=~_]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(tok) {
  return parseFloat(tok.replace(/,/g, ''));
}

function trailingAmount(line) {
  // The amount must be the last token on the line (allowing a trailing CR/DR).
  const m = line.match(/(-?\(?\d[\d,]*(?:\.\d{1,2})?\)?)\s*(cr|dr)?\s*$/i);
  if (!m) return null;
  let tok = m[1];
  const neg = tok.startsWith('(') && tok.endsWith(')');
  tok = tok.replace(/[()]/g, '');
  if (!/^-?(\d{1,3}(,\d{2,3})+|\d+)(\.\d{1,2})?$/.test(tok)) return null;
  const value = toNumber(tok) * (neg ? -1 : 1);
  const hasDecimals = tok.includes('.');
  const intDigits = tok.replace(/[-,]/g, '').split('.')[0].length;
  if (!hasDecimals && intDigits >= 6) return null; // pincodes, phone numbers, ids
  if (intDigits > 7) return null;
  return { value, hasDecimals, index: m.index };
}

function itemName(line, amountIndex) {
  let name = line.slice(0, amountIndex);
  // Drop trailing qty / rate columns like " 2 180.00", " 2 x 180", " @ 90", "2x60 ="
  const tokens = name.trim().split(/\s+/);
  const junk = /^([\d.,]+|[x×@*=:\-]+|\d+[x×]|[x×@]\d[\d.,]*|\d+[x×]\d[\d.,]*|nos?\.?|pcs?\.?)$/i;
  while (tokens.length > 1 && junk.test(tokens[tokens.length - 1])) tokens.pop();
  name = tokens.join(' ');
  // Drop a leading serial number "1." / "01)" / "1 -"
  name = name.replace(/^\s*\d{1,3}\s*[.)\]:-]\s*/, '');
  name = name.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return name;
}

function titleCase(s) {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase())
    .replace(/\b(cgst|sgst|igst|utgst|gst|vat|sc|kot|bbq|ac)\b/gi, (w) => w.toUpperCase());
}

const letters = (s) => (s.match(/\p{L}/gu) || []).length;

export function parseBillText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(cleanLine)
    .filter(Boolean);

  const items = [];
  const charges = [];
  let discount = 0;
  const totals = [];
  let merchant = '';
  let itemsClosed = false; // after a (sub)total line, stop collecting items

  for (const line of lines) {
    const lower = line.toLowerCase();
    const amt = trailingAmount(line);

    if (!merchant && !amt && letters(line) >= 3 && !SKIP_RE.test(line) && items.length === 0) {
      merchant = titleCase(line.replace(/[^\p{L}\p{N}&'.\s-]/gu, '').trim()).slice(0, 40);
    }
    if (!amt || amt.value === 0) continue;

    const isSubtotal = /\b(sub\s*-?\s*total|s\s*\/\s*total)\b/i.test(lower);
    const isCharge = CHARGE_RE.test(lower);
    const isDiscount = DISC_RE.test(lower);
    const isTotal = !isSubtotal && TOTAL_RE.test(lower);

    if (isSubtotal) {
      itemsClosed = true;
      continue;
    }
    if (isDiscount && !isTotal) {
      discount += Math.abs(amt.value);
      itemsClosed = true;
      continue;
    }
    const isTaxSummary = /^\s*total\s*(gst|tax(es)?|vat|cess)\b/i.test(lower);
    if (isTaxSummary || (isCharge && !isTotal)) {
      // "Total GST" duplicates the CGST+SGST lines — only keep it if there are none.
      if (isTaxSummary && charges.length) continue;
      const name = itemName(line, amt.index) || 'Tax';
      charges.push({ name: titleCase(name.replace(/@\s*$/, '').trim()), amount: amt.value });
      itemsClosed = true;
      continue;
    }
    if (isTotal) {
      totals.push(amt.value);
      itemsClosed = true;
      continue;
    }
    if (itemsClosed || SKIP_RE.test(lower)) continue;
    if (line.includes(':') && !amt.hasDecimals) continue; // "Table: 5", "Bill No: 123"
    if (/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(line)) continue; // dates
    if (/\d{1,2}:\d{2}/.test(line)) continue; // times

    const name = itemName(line, amt.index);
    if (letters(name) < 2 || amt.value < 0) continue;
    items.push({ name: titleCase(name), amount: amt.value });
  }

  return {
    merchant,
    items,
    charges,
    discount: Math.round(discount * 100) / 100,
    total: totals.length ? Math.max(...totals) : 0,
  };
}

export const _internals = { trailingAmount, itemName, cleanLine, NUM_RE };
