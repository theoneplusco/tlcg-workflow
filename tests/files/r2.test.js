import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentKey, validateUpload, contentDisposition } from '../../api/lib/files/r2.js';

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

test('validateUpload: content-type allow-list', () => {
  const ok = (mimeType) => validateUpload({ fileSize: 1000, fileName: 'a', mimeType });
  for (const t of ['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/csv', 'text/plain', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream',
    'IMAGE/PNG', 'text/plain; charset=utf-8', undefined, '']) {
    assert.equal(ok(t), null, String(t));
  }
  for (const t of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/javascript', 'text/xml']) {
    assert.equal(ok(t), 'Loại file không được hỗ trợ', t);
  }
});
test('contentDisposition: pdf and images inline, everything else a download', () => {
  assert.equal(contentDisposition('application/pdf'), undefined);
  assert.equal(contentDisposition('image/jpeg'), undefined);
  assert.equal(contentDisposition('application/octet-stream'), 'attachment');
  assert.equal(contentDisposition('text/plain'), 'attachment');
  assert.equal(contentDisposition('application/vnd.ms-excel'), 'attachment');
  assert.equal(contentDisposition(''), 'attachment');
});
