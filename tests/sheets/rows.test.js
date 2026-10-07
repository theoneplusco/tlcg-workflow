import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowForHeader, backoffSeconds } from '../../api/lib/sheets/rows.js';

test('rowForHeader: fills by header name, any column order, unknown → empty', () => {
  const header = ['voucher_number', ' Status ', 'MetaJSON', 'Extra column'];
  assert.deepEqual(rowForHeader(header, { status: 'Đã duyệt', voucher_number: 'A1', metajson: '{"a":1}' }),
    ['A1', 'Đã duyệt', '{"a":1}', '']);
});
test('rowForHeader: numbers stay numbers, null → empty', () => {
  assert.deepEqual(rowForHeader(['amount', 'note'], { amount: 2500000, note: null }), [2500000, '']);
});
test('backoffSeconds: 30s doubling, capped at 1h', () => {
  assert.deepEqual([1, 2, 3, 10].map(backoffSeconds), [30, 60, 120, 3600]);
});
test('rowForHeader: escapes formula-looking strings, stringifies objects', () => {
  assert.deepEqual(rowForHeader(['a', 'b', 'c', 'd'], { a: '=SUM(1)', b: { a: 1 }, c: '-x', d: 'ok' }),
    ["'=SUM(1)", '{"a":1}', "'-x", 'ok']);
});
test('rowForHeader: protects leading zeros and long digit strings, leaves dates', () => {
  assert.deepEqual(rowForHeader(['a', 'b', 'c', 'd', 'e', 'f'], { a: '00123', b: '1234567890123456', c: '2026-10-07 03:21:09', d: '0', e: '07/10/2026', f: '08:30' }),
    ["'00123", "'1234567890123456", '2026-10-07 03:21:09', '0', '07/10/2026', '08:30']);
});
test('rowForHeader: cuts strings over the 50,000-char cell limit', () => {
  const [a, b] = rowForHeader(['a', 'b'], { a: 'x'.repeat(60000), b: 'y'.repeat(49000) });
  assert.ok(a === 'x'.repeat(49000) + '…[cắt bớt]', `cut to 49,000 + marker (got ${a.length} chars)`);
  assert.ok(b === 'y'.repeat(49000), 'exactly 49,000 kept');
});
test('rowForHeader: a repeated header (any case) gets the value in its first column only', () => {
  assert.deepEqual(rowForHeader(['a', 'row_type', 'b', 'Row_Type', 'ROW_TYPE '], { a: 1, row_type: 'submit', b: 2 }), [1, 'submit', 2, '', '']);
});
test('rowForHeader: headers without repeats are filled exactly as before (voucher tabs)', () => {
  assert.deepEqual(rowForHeader(['voucherNumber', 'status', 'amount'], { voucherNumber: 'V1', status: 'x', amount: 5 }), ['V1', 'x', 5]);
});
