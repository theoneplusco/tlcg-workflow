// api/lib/files/r2.js — R2 (S3 API) client and key rules shared by presign + voucher files.
import crypto from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';

export const R2_BUCKET = process.env.R2_BUCKET_NAME || 'tlcg-attachments';
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://attachments.tl-c.us';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // same limit as GAS

let client = null;
export function getS3() {
  if (client) return client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

const safe = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

/** Links are public like Drive "anyone with the link"; the random part keeps them unguessable. */
export function attachmentKey(voucherNumber, fileName, rand = crypto.randomBytes(16).toString('hex')) {
  return `vouchers/${safe(voucherNumber) || 'draft'}/${rand}-${safe(fileName) || 'attachment'}`;
}

export function validateUpload({ fileSize, fileName }) {
  const size = Number(fileSize);
  if (!(size > 0 && size <= MAX_ATTACHMENT_BYTES) || !fileName) return 'File không hợp lệ';
  return null;
}
