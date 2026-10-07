import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleCreateVoucherUploadSession, handleFinalizeVoucherUpload, handleFetchSignatureImage } from '../../api/handlers/files.js';

const mkRes = () => {
  const r = { status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  return r;
};
const KEY = 'vouchers/MI-PC1/' + 'a'.repeat(32) + '-x.pdf';

test('finalize: oversized object is deleted and rejected', async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.constructor.name); return { ContentLength: 10 * 1024 * 1024 + 1 }; } };
  const res = mkRes();
  await handleFinalizeVoucherUpload({ body: { key: KEY } }, res, s3);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'File vượt quá 10 MB');
  assert.deepEqual(sent, ['HeadObjectCommand', 'DeleteObjectCommand']);
});
test('finalize: valid object returns size', async () => {
  const res = mkRes();
  await handleFinalizeVoucherUpload({ body: { key: KEY, fileName: 'x.pdf' } }, res, { send: async () => ({ ContentLength: 5 }) });
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.fileSize, 5);
});
test('createSession: signing error answers instead of throwing', async () => {
  const res = mkRes();
  // a client with no credentials/region config makes presigning reject
  const s3 = { config: { credentials: async () => { throw new Error('no creds'); }, region: async () => 'auto' } };
  await handleCreateVoucherUploadSession({ body: { fileName: 'a.pdf', fileSize: 10 } }, res, s3);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /^Không tạo được phiên tải lên: /);
});
test('fetchSignatureImage: missing imageUrl is rejected', async () => {
  const res = mkRes();
  await handleFetchSignatureImage({ body: {} }, res);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Thiếu URL hình ảnh');
});
test('fetchSignatureImage: disallowed URL (127.0.0.1) is rejected', async () => {
  const res = mkRes();
  await handleFetchSignatureImage({ body: { imageUrl: 'https://127.0.0.1/x' } }, res);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'URL hình ảnh không được phép');
});
