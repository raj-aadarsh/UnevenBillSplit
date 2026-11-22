// Pure split calculation — no DOM. Shared by the app and the tests.
//
// Rules:
//   • An item's amount is divided equally among the people ticked on it.
//   • Taxes & charges (GST, service charge, round-off…) are summed and divided
//     equally among everyone.
//   • A discount printed on the bill (₹) is shared in proportion to what each
//     person ordered.
//   • The extra discount % is taken off each person's (items + taxes) amount.
//   • Final amounts are rounded to paise so they add up exactly to the total.

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + f(x), 0);

/**
 * @param {object} bill
 * @param {{id:string,name:string,amount:number|string,people:string[]}[]} bill.items
 * @param {{id:string,name:string,amount:number|string}[]} bill.charges
 * @param {number|string} [bill.discount]     discount printed on the bill, in ₹
 * @param {{id:string,name:string}[]} people
 * @param {number|string} [discountPct]       extra discount %, applied at the end
 */
export function computeSplit(bill, people, discountPct = 0, paid = null) {
  const billDiscount = Math.max(0, num(bill.discount));
  const preBillTotal = sum(bill.items, (it) => num(it.amount)) - billDiscount + sum(bill.charges, (c) => num(c.amount));
  // "Amount actually paid" wins over a discount %: the gap between the bill
  // and what was paid (card / app offer) is shared in proportion to each
  // person's share. Paying more than the bill (e.g. a tip) works the same way.
  const paidNum = num(paid);
  const usePaid = paid !== null && paid !== '' && paidNum > 0 && preBillTotal > 0;
  const pct = usePaid ? (1 - paidNum / preBillTotal) * 100 : Math.min(100, Math.max(0, num(discountPct)));
  const n = people.length;

  const rows = people.map((p) => ({
    id: p.id,
    name: p.name,
    items: [],
    itemTotal: 0,
    billDiscShare: 0,
    chargeShare: 0,
    beforeDiscount: 0,
    extraDiscount: 0,
    exact: 0,
    final: 0,
  }));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const itemsTotal = sum(bill.items, (it) => num(it.amount));
  const unassigned = [];
  for (const it of bill.items) {
    const amount = num(it.amount);
    const who = (it.people || []).filter((id) => byId.has(id));
    if (!who.length) {
      if (amount !== 0) unassigned.push(it);
      continue;
    }
    const share = amount / who.length;
    for (const id of who) {
      const r = byId.get(id);
      r.itemTotal += share;
      r.items.push({ name: it.name, amount, share, splitBy: who.length });
    }
  }

  const chargesTotal = sum(bill.charges, (c) => num(c.amount));
  const chargeEach = n ? chargesTotal / n : 0;
  const assignedTotal = sum(rows, (r) => r.itemTotal);

  for (const r of rows) {
    r.billDiscShare = assignedTotal > 0 ? (billDiscount * r.itemTotal) / assignedTotal : n ? billDiscount / n : 0;
    r.chargeShare = chargeEach;
    r.beforeDiscount = r.itemTotal - r.billDiscShare + r.chargeShare;
    r.extraDiscount = (r.beforeDiscount * pct) / 100;
    r.exact = r.beforeDiscount - r.extraDiscount;
  }

  // Largest-remainder rounding in paise so shares add up exactly.
  const exactPaise = rows.map((r) => r.exact * 100);
  const floors = exactPaise.map((p) => Math.floor(p + 1e-6));
  let leftover = Math.round(sum(exactPaise)) - sum(floors);
  const order = exactPaise
    .map((p, i) => ({ i, frac: p - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && leftover > 0; k++, leftover--) floors[order[k].i] += 1;
  rows.forEach((r, i) => (r.final = floors[i] / 100));

  const billTotal = itemsTotal - billDiscount + chargesTotal;
  const extraDiscountTotal = usePaid ? billTotal - paidNum : (billTotal * pct) / 100;
  return {
    people: rows,
    itemsTotal: round2(itemsTotal),
    chargesTotal: round2(chargesTotal),
    billDiscount: round2(billDiscount),
    billTotal: round2(billTotal),
    discountPct: Math.round(pct * 100) / 100,
    paid: usePaid ? round2(paidNum) : null,
    extraDiscountTotal: round2(extraDiscountTotal),
    grandTotal: round2(billTotal - extraDiscountTotal),
    sharesTotal: round2(sum(rows, (r) => r.final)),
    unassigned,
  };
}
