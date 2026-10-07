// api/lib/files/r2.js — R2 (S3 API) client and key rules shared by presign + voucher files.
import crypto from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';

export const R2_BUCKET = process.env.R2_BUCKET_NAME || 'tlcg-attachments';
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://attachments.tl-c.us';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // same limit as GAS

/**
 * S3 client for R2. Checksums only WHEN_REQUIRED: otherwise presigned PUT URLs carry
 * x-amz-checksum-crc32 of an empty body (+ x-amz-sdk-checksum-algorithm), which R2 checks
 * against the real upload.
 */
export function createS3Client({ accountId, accessKeyId, secretAccessKey }) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

let client = null;
export function getS3() {
  if (client) return client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  client = createS3Client({ accountId: R2_ACCOUNT_ID, accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY });
  return client;
}

const safe = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

/** Links are public like Drive "anyone with the link"; the random part keeps them unguessable. */
export function attachmentKey(voucherNumber, fileName, rand = crypto.randomBytes(16).toString('hex')) {
  return `vouchers/${safe(voucherNumber) || 'draft'}/${rand}-${safe(fileName) || 'attachment'}`;
}

/** Purchase request attachments: no PR number in the key, so the number may still change (GAS B10). */
export function prAttachmentKey(fileName, rand = crypto.randomBytes(16).toString('hex')) {
  return `purchase-requests/${rand}-${safe(fileName) || 'attachment'}`;
}

// Attachment types we accept. Anything that a browser would run (html, svg, xhtml) is refused.
export const ALLOWED_TYPES = new Set([
  'application/pdf',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'text/plain', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream',
]);

/** "Text/Plain; charset=utf-8" → "text/plain"; empty → application/octet-stream (what the page sends then). */
export const baseType = (mimeType) => String(mimeType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';

/** PDFs and images open in the browser; every other type is served as a download. */
export function contentDisposition(mimeType) {
  const t = baseType(mimeType);
  return t === 'application/pdf' || t.startsWith('image/') ? undefined : 'attachment';
}

export function validateUpload({ fileSize, fileName, mimeType }) {
  const size = Number(fileSize);
  if (!(size > 0 && size <= MAX_ATTACHMENT_BYTES) || !fileName) return 'File không hợp lệ';
  if (!ALLOWED_TYPES.has(baseType(mimeType))) return 'Loại file không được hỗ trợ';
  return null;
}
