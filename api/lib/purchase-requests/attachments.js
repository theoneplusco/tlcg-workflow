// api/lib/purchase-requests/attachments.js — the page's base64 attachments → R2 (GAS: Drive, shared publicly).
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { R2_BUCKET, R2_PUBLIC_URL, prAttachmentKey, validateUpload, baseType, contentDisposition } from '../files/r2.js';

export const MAX_FILES = 5; // purchase_request.html MAX_ATTACH_FILES

export function parseAttachmentList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
}

export function decodeFile(a) {
  const raw = String(a.fileData || '');
  const m = raw.match(/^data:([^;,]*)(?:;[^,]*)?,(.*)$/s);
  return { fileName: String(a.fileName || 'attachment'), mimeType: baseType(a.mimeType || (m && m[1])), body: Buffer.from(m ? m[2] : raw, 'base64') };
}

/**
 * Like GAS, a file that cannot be stored never fails the request: it is recorded with fileUrl ''
 * and the reason. Entries without fileData are ignored (links are never taken from the client).
 * Keys carry no PR number, so a renumbered PR cannot point at another folder (B10).
 */
export async function storeAttachments(s3, list) {
  const out = [];
  let count = 0;
  for (const a of list) {
    if (!a || typeof a !== 'object' || !a.fileData) continue;
    count += 1;
    const f = decodeFile(a);
    const bad = count > MAX_FILES ? `Tối đa ${MAX_FILES} tệp`
      : validateUpload({ fileSize: f.body.length, fileName: f.fileName, mimeType: f.mimeType });
    if (bad) { out.push({ fileName: f.fileName, fileUrl: '', error: bad }); continue; }
    if (!s3) { out.push({ fileName: f.fileName, fileUrl: '', error: 'R2 chưa cấu hình' }); continue; }
    const key = prAttachmentKey(f.fileName);
    try {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: f.body, ContentType: f.mimeType,
        ContentDisposition: contentDisposition(f.mimeType) }));
      out.push({ fileName: f.fileName, fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: f.body.length });
    } catch (e) {
      out.push({ fileName: f.fileName, fileUrl: '', error: e.message });
    }
  }
  return out;
}
