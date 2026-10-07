import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { handleCreateVoucherUploadSession, handleFinalizeVoucherUpload, handleFetchSignatureImage, handleVoucherFileUpload } from '../../api/handlers/files.js';
import redis from '../../db/redis.js';

after(() => redis.quit());

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

// ── A1: login required (VOUCHER_REQUIRE_LOGIN=true) ──
const nobody = async () => null;
const someone = async () => ({ id: 1, email: 'a@x.vn' });
const withLogin = async (fn) => {
  const saved = process.env.VOUCHER_REQUIRE_LOGIN;
  process.env.VOUCHER_REQUIRE_LOGIN = 'true';
  try { await fn(); } finally { if (saved === undefined) delete process.env.VOUCHER_REQUIRE_LOGIN; else process.env.VOUCHER_REQUIRE_LOGIN = saved; }
};
const s3ok = { send: async () => ({ ContentLength: 5 }) };
const fakeSigner = { config: { credentials: async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), region: async () => 'auto' } };
// the app's own client config with dummy credentials: presigning works offline
const presignS3 = async () => (await import('../../api/lib/files/r2.js')).createS3Client({ accountId: 'acct', accessKeyId: 'a', secretAccessKey: 'b' });

test('auth: no token → 401 on create/finalize/signature when login is required', async () => {
  await withLogin(async () => {
    for (const run of [
      (res) => handleCreateVoucherUploadSession({ body: { fileName: 'a.pdf', fileSize: 10 }, headers: {} }, res, fakeSigner),
      (res) => handleFinalizeVoucherUpload({ body: { key: KEY }, headers: {} }, res, s3ok),
      (res) => handleFetchSignatureImage({ body: { imageUrl: 'https://drive.google.com/file/d/abc/view' }, headers: {} }, res),
    ]) {
      const res = mkRes();
      await run(res);
      assert.equal(res.code, 401);
      assert.deepEqual(res.body, { success: false, message: 'Vui lòng đăng nhập' });
    }
  });
});
test('auth: a signed-in caller is let through when login is required', async () => {
  await withLogin(async () => {
    const res = mkRes();
    await handleFinalizeVoucherUpload({ body: { key: KEY, fileName: 'x.pdf' }, headers: {} }, res, s3ok, someone);
    assert.equal(res.body.success, true);
    const res2 = mkRes();
    await handleCreateVoucherUploadSession({ body: { fileName: 'a.pdf', fileSize: 10, mimeType: 'application/pdf' }, headers: {} }, res2, await presignS3(), someone);
    assert.equal(res2.body.success, true, res2.body.message);
    const res3 = mkRes();
    await handleFetchSignatureImage({ body: {}, headers: {} }, res3, someone);
    assert.equal(res3.body.message, 'Thiếu URL hình ảnh');
  });
});
test('auth: stub caller is consulted only when login is required', async () => {
  const res = mkRes();
  await handleFinalizeVoucherUpload({ body: { key: KEY, fileName: 'x.pdf' }, headers: {} }, res, s3ok, nobody);
  assert.equal(res.body.success, true);
});

// ── A3: content-type policy ──
test('createSession: html/svg refused; non-pdf types are signed as downloads', async () => {
  const s3 = await presignS3();
  for (const mimeType of ['text/html', 'image/svg+xml', 'application/xhtml+xml']) {
    const res = mkRes();
    await handleCreateVoucherUploadSession({ body: { fileName: 'a', fileSize: 10, mimeType }, headers: {} }, res, s3);
    assert.equal(res.body.message, 'Loại file không được hỗ trợ', mimeType);
  }
  const xls = mkRes();
  await handleCreateVoucherUploadSession({ body: { fileName: 'a.xlsx', fileSize: 10, mimeType: 'application/vnd.ms-excel' }, headers: {} }, xls, s3);
  assert.match(new URL(xls.body.data.uploadUrl).searchParams.get('X-Amz-SignedHeaders'), /content-disposition/);
  assert.deepEqual(xls.body.data.headers, { 'Content-Type': 'application/vnd.ms-excel', 'Content-Disposition': 'attachment' });
  const pdf = mkRes();
  await handleCreateVoucherUploadSession({ body: { fileName: 'a.pdf', fileSize: 10, mimeType: 'application/pdf' }, headers: {} }, pdf, s3);
  assert.doesNotMatch(new URL(pdf.body.data.uploadUrl).searchParams.get('X-Amz-SignedHeaders'), /content-disposition/);
  assert.deepEqual(pdf.body.data.headers, { 'Content-Type': 'application/pdf' });
});
test('createSession: headers are the normalised signed values (type with params, empty type)', async () => {
  const s3 = await presignS3();
  const res = mkRes();
  await handleCreateVoucherUploadSession({ body: { fileName: 'a.txt', fileSize: 10, mimeType: 'Text/Plain; charset=UTF-8' }, headers: {} }, res, s3);
  assert.deepEqual(res.body.data.headers, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment' });
  const none = mkRes();
  await handleCreateVoucherUploadSession({ body: { fileName: 'a.bin', fileSize: 10 }, headers: {} }, none, s3);
  assert.deepEqual(none.body.data.headers, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' });
});
test('presigned PUT URL carries no checksum parameters (R2 would check them against the real body)', async () => {
  const s3 = await presignS3();
  for (const mimeType of ['application/pdf', 'text/csv']) {
    const res = mkRes();
    await handleCreateVoucherUploadSession({ body: { fileName: 'a', fileSize: 10, mimeType }, headers: {} }, res, s3);
    const q = new URL(res.body.data.uploadUrl).searchParams;
    assert.deepEqual([...q.keys()].filter((k) => /^x-amz-(checksum|sdk-checksum-algorithm)/i.test(k)), [], res.body.data.uploadUrl);
  }
});

// multipart helper: a fake request stream carrying one file
const multipart = (fileName, mime, body, fields = { voucherNumber: 'MI-PC1' }) => {
  const B = 'XBOUNDARY';
  const parts = Object.entries(fields).map(([k, v]) => `--${B}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('');
  const buf = Buffer.concat([Buffer.from(parts + `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.from(body), Buffer.from(`\r\n--${B}--\r\n`)]);
  const req = Readable.from([buf]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${B}` };
  return req;
};
const finished = (res) => new Promise((resolve) => { const j = res.json; res.json = (b) => { j.call(res, b); res.headersSent = true; resolve(res); return res; }; });

test('voucher-file: no token → 401 when login is required, nothing stored', async () => {
  await withLogin(async () => {
    const sent = [];
    const res = mkRes();
    const done = finished(res);
    handleVoucherFileUpload(multipart('a.pdf', 'application/pdf', 'x'), res, () => {}, { s3: { send: async (c) => { sent.push(c); } } });
    await done;
    assert.equal(res.code, 401);
    assert.deepEqual(res.body, { success: false, message: 'Vui lòng đăng nhập' });
    assert.equal(sent.length, 0);
  });
});
test('voucher-file: svg refused; csv stored as a download; pdf inline', async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.input); return {}; } };
  const svg = mkRes(); let done = finished(svg);
  handleVoucherFileUpload(multipart('a.svg', 'image/svg+xml', '<svg/>'), svg, () => {}, { s3 });
  await done;
  assert.equal(svg.body.message, 'Loại file không được hỗ trợ');
  const csv = mkRes(); done = finished(csv);
  handleVoucherFileUpload(multipart('a.csv', 'text/csv', 'a,b'), csv, () => {}, { s3 });
  await done;
  assert.equal(csv.body.success, true, csv.body.message);
  const pdf = mkRes(); done = finished(pdf);
  handleVoucherFileUpload(multipart('a.pdf', 'application/pdf', '%PDF'), pdf, () => {}, { s3 });
  await done;
  assert.equal(sent.length, 2);
  assert.equal(sent[0].ContentDisposition, 'attachment');
  assert.equal(sent[1].ContentDisposition, undefined);
});
test('voucher-file: no response twice when the request already answered during the S3 write', async () => {
  const res = mkRes();
  let calls = 0;
  const j = res.json; res.json = (b) => { calls += 1; return j.call(res, b); };
  let release;
  const gate = new Promise((r) => { release = r; });
  const s3 = { send: async () => { res.headersSent = true; await gate; return {}; } };
  handleVoucherFileUpload(multipart('a.pdf', 'application/pdf', '%PDF'), res, () => {}, { s3 });
  await new Promise((r) => setTimeout(r, 50));
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
});

// ── Round 3 ──
test('presigned PUT signs Content-Type too (pdf and xlsx), so the browser cannot swap in text/html', async () => {
  const s3 = await presignS3();
  for (const [mimeType, want] of [['application/pdf', 'content-type;host'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition;content-type;host']]) {
    const res = mkRes();
    await handleCreateVoucherUploadSession({ body: { fileName: 'a', fileSize: 10, mimeType }, headers: {} }, res, s3);
    const q = new URL(res.body.data.uploadUrl).searchParams;
    assert.equal(q.get('X-Amz-SignedHeaders'), want, mimeType);
    assert.ok(![...q.keys()].some((k) => /^x-amz-(checksum|sdk-checksum-algorithm)/i.test(k)));
  }
});
test('finalize: an object stored with a refused type is deleted and rejected', async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.constructor.name); return { ContentLength: 5, ContentType: 'text/html; charset=utf-8' }; } };
  const res = mkRes();
  await handleFinalizeVoucherUpload({ body: { key: KEY }, headers: {} }, res, s3);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Loại file không được hỗ trợ');
  assert.deepEqual(sent, ['HeadObjectCommand', 'DeleteObjectCommand']);
  const okRes = mkRes();
  await handleFinalizeVoucherUpload({ body: { key: KEY }, headers: {} }, okRes, { send: async () => ({ ContentLength: 5, ContentType: 'application/pdf' }) });
  assert.equal(okRes.body.success, true);
});
test('voucher-file: login is checked before the R2 configuration', async () => {
  await withLogin(async () => {
    const res = mkRes();
    const done = finished(res);
    handleVoucherFileUpload(multipart('a.pdf', 'application/pdf', 'x'), res, () => {}, { s3: null });
    await done;
    assert.equal(res.code, 401);
  });
});
