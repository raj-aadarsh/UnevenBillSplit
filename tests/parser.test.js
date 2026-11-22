import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBillText } from '../js/parser.js';

test('parses a typical Indian restaurant bill', () => {
  const text = `
    THE SPICE ROUTE
    12, MG Road, Bengaluru 560001
    GSTIN: 29ABCDE1234F1Z5
    Bill No: 1042   Table: 7
    Date: 21/11/2026 20:41
    Item            Qty   Rate    Amount
    1. Paneer Tikka   2   180.00   360.00
    2. Veg Biryani    1   260.00   260.00
    Butter Naan       4    45.00   180.00
    Fresh Lime Soda   3    90.00   270.00
    7 Up              2    40       80
    Sub Total                     1150.00
    Discount 10%                   115.00
    Service Charge 5%               51.75
    CGST @ 2.5%                     27.17
    SGST @ 2.5%                     27.17
    Round Off                       -0.09
    Grand Total                   1141.00
    Paid by UPI                   1141.00
    Thank you! Visit again
  `;
  const r = parseBillText(text);
  assert.equal(r.merchant, 'The Spice Route');
  assert.deepEqual(r.items, [
    { name: 'Paneer Tikka', amount: 360 },
    { name: 'Veg Biryani', amount: 260 },
    { name: 'Butter Naan', amount: 180 },
    { name: 'Fresh Lime Soda', amount: 270 },
    { name: '7 Up', amount: 80 },
  ]);
  assert.deepEqual(
    r.charges.map((c) => c.amount),
    [51.75, 27.17, 27.17, -0.09],
  );
  assert.equal(r.discount, 115);
  assert.equal(r.total, 1141);
});

test('handles rupee symbols, commas and Total GST summary lines', () => {
  const text = `
    CHICKEN BUCKET ₹1,299.00
    Pepsi 2 x 60 = ₹120.00
    Total GST ₹70.95
    TOTAL ₹1,489.95
  `;
  const r = parseBillText(text);
  assert.deepEqual(r.items, [
    { name: 'Chicken Bucket', amount: 1299 },
    { name: 'Pepsi', amount: 120 },
  ]);
  assert.deepEqual(r.charges.map((c) => c.amount), [70.95]);
  assert.equal(r.total, 1489.95);
});

test('keeps names ending in x and strips qty columns', () => {
  const r = parseBillText('Veg Box 2x120 240.00\nMasala Chai 3 nos 60\nTotal 300.00');
  assert.deepEqual(r.items, [
    { name: 'Veg Box', amount: 240 },
    { name: 'Masala Chai', amount: 60 },
  ]);
});
