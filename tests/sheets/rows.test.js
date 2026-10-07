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
