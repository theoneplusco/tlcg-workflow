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
test('fetchSignatureImage: redirect to disallowed host is rejected', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes('drive.google.com')) {
        return {
          status: 302,
          ok: false,
          headers: new Map([['location', 'https://127.0.0.1/x']]),
        };
      }
      throw new Error('unexpected fetch: ' + url);
    };
    const res = mkRes();
    await handleFetchSignatureImage({ body: { imageUrl: 'https://drive.google.com/file/d/abc/view' } }, res);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'URL hình ảnh không được phép');
  } finally {
    globalThis.fetch = saved;
  }
});
test('fetchSignatureImage: successful fetch with stub returns imageBase64', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
      return {
        status: 200,
        ok: true,
        headers: new Map([
          ['content-type', 'image/png'],
          ['content-length', String(body.length)],
        ]),
        arrayBuffer: async () => body.buffer,
      };
    };
    const res = mkRes();
    await handleFetchSignatureImage({ body: { imageUrl: 'https://drive.google.com/file/d/abc/view' } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.message, 'Success');
    assert.ok(res.body.data.imageBase64.startsWith('data:image/png;base64,'));
  } finally {
    globalThis.fetch = saved;
  }
});
