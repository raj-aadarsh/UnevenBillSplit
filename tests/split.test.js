import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSplit } from '../js/split.js';

const people = [
  { id: 'a', name: 'Asha' },
  { id: 'b', name: 'Bala' },
  { id: 'c', name: 'Chetan' },
];

test('items split among selected people, charges split equally', () => {
  const bill = {
    items: [
      { id: '1', name: 'Paneer Tikka', amount: 300, people: ['a', 'b'] },
      { id: '2', name: 'Biryani', amount: 450, people: ['c'] },
      { id: '3', name: 'Naan', amount: 90, people: ['a', 'b', 'c'] },
    ],
    charges: [
      { id: 'x', name: 'CGST', amount: 21 },
      { id: 'y', name: 'SGST', amount: 21 },
      { id: 'z', name: 'Service charge', amount: 42 },
    ],
  };
  const r = computeSplit(bill, people, 0);
  assert.equal(r.billTotal, 924);
  assert.deepEqual(r.people.map((p) => p.final), [208, 208, 508]); // 150+30+28, 150+30+28, 450+30+28
  assert.equal(r.sharesTotal, r.grandTotal);
});

test('extra discount % comes off each person after taxes', () => {
  const bill = {
    items: [
      { id: '1', name: 'A', amount: 100, people: ['a'] },
      { id: '2', name: 'B', amount: 200, people: ['b'] },
    ],
    charges: [{ id: 'x', name: 'GST', amount: 30 }],
  };
  const r = computeSplit(bill, people.slice(0, 2), 10);
  // a: (100+15)*0.9 = 103.5 ; b: (200+15)*0.9 = 193.5
  assert.deepEqual(r.people.map((p) => p.final), [103.5, 193.5]);
  assert.equal(r.grandTotal, 297);
});

test('paise rounding always adds up to the grand total', () => {
  const bill = {
    items: [{ id: '1', name: 'Pizza', amount: 100, people: ['a', 'b', 'c'] }],
    charges: [{ id: 'x', name: 'GST', amount: 5 }],
  };
  const r = computeSplit(bill, people, 7);
  assert.equal(r.grandTotal, 97.65);
  assert.equal(r.sharesTotal, 97.65);
  const finals = r.people.map((p) => p.final).sort();
  assert.deepEqual(finals, [32.55, 32.55, 32.55]);
});

test('printed bill discount is shared in proportion to items', () => {
  const bill = {
    items: [
      { id: '1', name: 'A', amount: 300, people: ['a'] },
      { id: '2', name: 'B', amount: 100, people: ['b'] },
    ],
    charges: [],
    discount: 40,
  };
  const r = computeSplit(bill, people.slice(0, 2), 0);
  assert.deepEqual(r.people.map((p) => p.final), [270, 90]);
});

test('reports unassigned items', () => {
  const bill = { items: [{ id: '1', name: 'Tea', amount: 20, people: [] }], charges: [] };
  const r = computeSplit(bill, people, 0);
  assert.equal(r.unassigned.length, 1);
});

test('amount actually paid: discount shared in proportion, adds up exactly', () => {
  const bill = {
    items: [
      { id: '1', name: 'Paneer', amount: 360, people: ['a', 'b'] },
      { id: '2', name: 'Biryani', amount: 260, people: ['c'] },
      { id: '3', name: 'Naan', amount: 180, people: ['a', 'b', 'c'] },
      { id: '4', name: 'Soda', amount: 270, people: ['a'] },
    ],
    charges: [{ id: 'x', name: 'Taxes', amount: 110 }],
  };
  const r = computeSplit(bill, people, 0, 1062); // bill 1180, paid 1062 → 118 off (10%)
  assert.equal(r.billTotal, 1180);
  assert.equal(r.extraDiscountTotal, 118);
  assert.equal(r.discountPct, 10);
  assert.deepEqual(r.people.map((p) => p.final), [492, 249, 321]);
  assert.equal(r.sharesTotal, 1062);
});

test('odd paid amount still adds up to the paise', () => {
  const bill = {
    items: [
      { id: '1', name: 'A', amount: 333, people: ['a'] },
      { id: '2', name: 'B', amount: 333, people: ['b'] },
      { id: '3', name: 'C', amount: 334, people: ['c'] },
    ],
    charges: [{ id: 'x', name: 'GST', amount: 50 }],
  };
  const r = computeSplit(bill, people, 0, 977.77);
  assert.equal(r.sharesTotal, 977.77);
  assert.equal(r.grandTotal, 977.77);
});

test('paying more than the bill (tip) is shared in proportion', () => {
  const bill = { items: [{ id: '1', name: 'A', amount: 100, people: ['a'] }, { id: '2', name: 'B', amount: 300, people: ['b'] }], charges: [] };
  const r = computeSplit(bill, people.slice(0, 2), 0, 440);
  assert.deepEqual(r.people.map((p) => p.final), [110, 330]);
});

test('empty paid amount means no discount', () => {
  const bill = { items: [{ id: '1', name: 'A', amount: 100, people: ['a'] }], charges: [] };
  assert.equal(computeSplit(bill, people.slice(0, 1), 0, '').grandTotal, 100);
});
