// api/handlers/files.js — voucher attachments on R2 + signature images (replaces GAS/Drive).
import { PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import busboy from 'busboy';
import { getS3, R2_BUCKET, R2_PUBLIC_URL, attachmentKey, validateUpload, contentDisposition, baseType, ALLOWED_TYPES, MAX_ATTACHMENT_BYTES } from '../lib/files/r2.js';
import { isAllowedImageUrl } from '../lib/files/signature-fetch.js';
import { fetchImageDataUrl, ImageFetchError } from '../lib/files/fetch-image.js';
import { callerFromRequest, requireLogin } from '../lib/auth-caller.js';

const ok = (res, message, data) => res.json({ success: true, message, data });
const fail = (res, message, status = 200) => res.status(status).json({ success: false, message });

/**
 * VOUCHER_REQUIRE_LOGIN=true: file actions need a valid login token (as resolveActor does for
 * voucher actions). Answers 401 and returns false otherwise. The R2 PUT itself carries no token.
 */
async function signedIn(req, res, who) {
  if (!requireLogin()) return true;
  let caller = null;
  try { caller = await who(req); } catch (e) { console.error('[files] caller check:', e.message); }
  if (caller) return true;
  res.status(401).json({ success: false, message: 'Vui lòng đăng nhập' });
  return false;
}

export async function handleCreateVoucherUploadSession(req, res, s3 = getS3(), who = callerFromRequest) {
  if (!(await signedIn(req, res, who))) return;
  const b = req.body || {};
  const bad = validateUpload(b);
  if (bad) return fail(res, bad);
  if (!s3) return fail(res, 'Không tạo được phiên tải lên (R2 chưa cấu hình)');
  const key = attachmentKey(b.voucherNumber, b.fileName);
  const contentType = baseType(b.mimeType); // normalised once: signed and sent exactly as returned
  const disposition = contentDisposition(contentType);
  try {
    // Content-Disposition is a signed header: the browser must PUT with exactly `headers`.
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, ContentType: contentType, ContentDisposition: disposition,
    }), { expiresIn: 3600, signableHeaders: new Set(['content-type']) }); // type is signed too: no swapping in text/html
    const headers = { 'Content-Type': contentType, ...(disposition ? { 'Content-Disposition': disposition } : {}) };
    return ok(res, 'ok', { uploadUrl, headers, key, fileUrl: `${R2_PUBLIC_URL}/${key}` });
  } catch (e) {
    return fail(res, 'Không tạo được phiên tải lên: ' + e.message);
  }
}

export async function handleFinalizeVoucherUpload(req, res, s3 = getS3(), who = callerFromRequest) {
  if (!(await signedIn(req, res, who))) return;
  const b = req.body || {};
  const key = String(b.key || '');
  if (!/^vouchers\/[A-Za-z0-9._-]+\/[0-9a-f]{32}-[A-Za-z0-9._-]+$/.test(key)) return fail(res, 'fileId không hợp lệ');
  if (!s3) return fail(res, 'Không lưu được file: R2 chưa cấu hình');
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    // presigned PUT cannot cap size, and the type is checked again: drop the object if either is wrong
    const problem = head.ContentLength > MAX_ATTACHMENT_BYTES ? 'File vượt quá 10 MB'
      : !ALLOWED_TYPES.has(baseType(head.ContentType)) ? 'Loại file không được hỗ trợ' : '';
    if (problem) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); } catch (e) { console.warn('[files] could not delete refused upload', key, e.message); }
      return fail(res, problem);
    }
    return ok(res, 'Đã tải file', { fileName: b.fileName || key.split('/').pop().slice(33), fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: head.ContentLength });
  } catch (e) {
    return fail(res, 'Không lưu được file: ' + (e.name === 'NotFound' ? 'file chưa được tải lên' : e.message));
  }
}

/**
 * /api/voucher-file (multipart: voucherNumber, file) — fallback when the browser cannot PUT to R2.
 * Mounted directly as Express middleware, so the third argument is `next`; tests pass deps fourth.
 */
export async function handleVoucherFileUpload(req, res, _next, { s3 = getS3(), who = callerFromRequest } = {}) {
  if (!(await signedIn(req, res, who))) { req.resume?.(); return; }
  if (!s3) { req.resume?.(); return fail(res, 'R2 chưa cấu hình', 503); }
  const fields = {};
  let upload = null;
  const abort = () => { if (!res.headersSent) fail(res, 'Không tải được file', 400); };
  const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES + 1 } });
  bb.on('error', abort);
  req.on('aborted', abort);
  req.on('error', abort);
  bb.on('field', (n, v) => { fields[n] = v; });
  bb.on('file', (_n, stream, info) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => { size += c.length; chunks.push(c); });
    stream.on('end', () => { upload = { name: info.filename, mime: info.mimeType, size, body: Buffer.concat(chunks), truncated: stream.truncated }; });
  });
  bb.on('close', async () => {
    if (res.headersSent) return;
    if (!upload || upload.truncated) return fail(res, upload ? 'File vượt quá 10 MB' : 'Thiếu dữ liệu file');
    const bad = validateUpload({ fileSize: upload.size, fileName: upload.name, mimeType: upload.mime });
    if (bad) return fail(res, bad);
    const key = attachmentKey(fields.voucherNumber, upload.name);
    try {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: upload.body, ContentType: upload.mime,
        ContentDisposition: contentDisposition(upload.mime) }));
      if (res.headersSent) return; // the request was aborted/answered while we were writing
      return ok(res, 'Đã tải file', { fileName: upload.name, fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: upload.size });
    } catch (e) { if (!res.headersSent) fail(res, 'Không lưu được file: ' + e.message, 502); }
  });
  req.pipe(bb);
}

export async function handleFetchSignatureImage(req, res, who = callerFromRequest) {
  if (!(await signedIn(req, res, who))) return;
  const url = String((req.body || {}).imageUrl || '');
  if (!url) return fail(res, 'Thiếu URL hình ảnh');
  if (!isAllowedImageUrl(url)) return fail(res, 'URL hình ảnh không được phép');
  try {
    return ok(res, 'Success', { imageBase64: await fetchImageDataUrl(url) });
  } catch (e) { return fail(res, e instanceof ImageFetchError ? e.message : 'Lỗi: ' + e.message); }
}
