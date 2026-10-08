// tests/files/fetch-image.test.js — the allow-listed image fetcher shared by fetchSignatureImage and the approval stamp
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchImageDataUrl, ImageFetchError } from '../../api/lib/files/fetch-image.js';

const resp = (status, headers = {}, body = Buffer.from([0x89, 0x50, 0x4e, 0x47])) => ({
  status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), arrayBuffer: async () => body,
});

test('fetchImageDataUrl: Drive link → direct download → data URL with the served type', async () => {
  const seen = [];
  const out = await fetchImageDataUrl('https://drive.google.com/file/d/abc/view', {
    fetchImpl: async (u) => { seen.push(u); return resp(200, { 'content-type': 'image/png' }); } });
  assert.equal(seen[0], 'https://drive.google.com/uc?export=download&id=abc');
  assert.equal(out, 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
});

test('fetchImageDataUrl: refusals keep the fetchSignatureImage wording', async () => {
  const run = (url, fetchImpl, opts = {}) => fetchImageDataUrl(url, { fetchImpl, ...opts }).then(() => 'resolved', (e) => (e instanceof ImageFetchError ? e.message : 'other: ' + e.message));
  assert.equal(await run('https://127.0.0.1/x', async () => resp(200)), 'URL hình ảnh không được phép');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(302, { location: 'https://127.0.0.1/x' })), 'URL hình ảnh không được phép');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(302, { location: 'https://drive.google.com/again' })), 'Không tải được hình ảnh (chuyển hướng quá nhiều)');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(404)), 'Không tải được hình ảnh (HTTP 404)');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'text/html' })), 'Tệp không phải hình ảnh');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png', 'content-length': '10' }), { maxBytes: 4 }), 'Hình ảnh quá lớn');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png' }, Buffer.alloc(5))), 'resolved');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png' }, Buffer.alloc(5)), { maxBytes: 4 }), 'Hình ảnh quá lớn');
});

test('fetchImageDataUrl: at most MAX_REDIRECTS (4) redirects followed, 5 fetches in all', async () => {
  const { MAX_REDIRECTS } = await import('../../api/lib/files/fetch-image.js');
  assert.equal(MAX_REDIRECTS, 4);
  const chain = (redirects) => {
    let n = 0;
    const fetchImpl = async () => { n += 1; return n <= redirects ? resp(302, { location: `https://drive.google.com/r${n}` }) : resp(200, { 'content-type': 'image/png' }); };
    return { fetchImpl, count: () => n };
  };
  const ok = chain(4);
  assert.match(await fetchImageDataUrl('https://drive.google.com/file/d/a/view', { fetchImpl: ok.fetchImpl }), /^data:image\/png;base64,/);
  assert.equal(ok.count(), 5, '4 redirects + the image = 5 fetches');
  const tooMany = chain(5);
  await assert.rejects(fetchImageDataUrl('https://drive.google.com/file/d/a/view', { fetchImpl: tooMany.fetchImpl }), /chuyển hướng quá nhiều/);
  assert.equal(tooMany.count(), 5, 'the 5th response is a redirect: refused without a 6th fetch');
});
