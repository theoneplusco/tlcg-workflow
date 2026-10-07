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
