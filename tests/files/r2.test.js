import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentKey, validateUpload } from '../../api/lib/files/r2.js';

test('attachmentKey: per-voucher folder, unguessable prefix, safe name', () => {
  const k = attachmentKey('MI-PC20261007000001', 'Hoá đơn tháng 9.pdf', 'abc123');
  assert.equal(k, 'vouchers/MI-PC20261007000001/abc123-Hoa_on_thang_9.pdf');
});
test('attachmentKey: missing voucher number goes to draft', () => {
  assert.match(attachmentKey('', 'a.png'), /^vouchers\/draft\/[0-9a-f]{32}-a\.png$/);
});
test('validateUpload: GAS limits and messages', () => {
  assert.equal(validateUpload({ fileSize: 0, fileName: 'a' }), 'File không hợp lệ');
  assert.equal(validateUpload({ fileSize: 10 * 1024 * 1024 + 1, fileName: 'a' }), 'File không hợp lệ');
  assert.equal(validateUpload({ fileSize: 1000, fileName: 'a.pdf' }), null);
});
