// api/lib/approval/signature-store.js — each employee's sample signature stored in Postgres (migration 009).
// The first source of the stamped approval signature (signature-check.js); Drive links stay as a fallback.
// Takes `db` as an argument (no pool import).
import { MAX_STAMP_BYTES } from './stamp-limits.js';

const lower = (s) => String(s || '').trim().toLowerCase();
export const STORED_FROM = 'Chữ ký đã tải lên';

export const SIGNATURE_MSG = {
  vi: {
    missing: 'Vui lòng chọn ảnh chữ ký.',
    notImage: 'Chữ ký phải là ảnh PNG hoặc JPG.',
    tooBig: 'Ảnh chữ ký quá lớn (tối đa 750 KB). Vui lòng chọn ảnh nhỏ hơn.',
    saved: 'Đã lưu chữ ký mẫu.',
  },
  en: {
    missing: 'Please choose a signature image.',
    notImage: 'The signature must be a PNG or JPG image.',
    tooBig: 'The signature image is too large (max 750 KB). Please choose a smaller one.',
    saved: 'Sample signature saved.',
  },
};
const m = (lang) => SIGNATURE_MSG[lang === 'en' ? 'en' : 'vi'];

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (buf, sig) => sig.every((b, i) => buf[i] === b);

/** A PNG/JPEG data URL of at most MAX_STAMP_BYTES, checked by its bytes, not only its label. { ok, bytes } or { ok:false, message }. */
export function checkSignatureImage(dataUrl, lang) {
  if (typeof dataUrl !== 'string' || !dataUrl) return { ok: false, message: m(lang).missing };
  const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl);
  if (!match) return { ok: false, message: m(lang).notImage };
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_STAMP_BYTES) return { ok: false, message: m(lang).tooBig };
  const isPng = match[1].toLowerCase() === 'png';
  if (!startsWith(buf, isPng ? PNG : JPEG)) return { ok: false, message: m(lang).notImage };
  return { ok: true, bytes: buf.length };
}

/** The stored signature of an active employee by email: { dataUrl, updatedAt, updatedBy } or null. */
export async function storedSignatureFor(db, email) {
  const { rows } = await db.query(
    `SELECT s.data_url, s.updated_at, s.updated_by FROM employee_signatures s JOIN employees e ON e.id = s.employee_id
      WHERE LOWER(e.email) = $1 AND e.status = 'active'`, [lower(email)]);
  return rows[0] ? { dataUrl: rows[0].data_url, updatedAt: rows[0].updated_at, updatedBy: rows[0].updated_by } : null;
}

/** The stored signature of an employee by id (admin view): { dataUrl, updatedAt, updatedBy } or null. */
export async function storedSignatureById(db, employeeId) {
  const { rows } = await db.query(`SELECT data_url, updated_at, updated_by FROM employee_signatures WHERE employee_id = $1`, [employeeId]);
  return rows[0] ? { dataUrl: rows[0].data_url, updatedAt: rows[0].updated_at, updatedBy: rows[0].updated_by } : null;
}

/**
 * Save (insert or replace) an employee's signature and audit it in master_audit (table_key 'signatures';
 * the image itself is never written to the audit, only its size). The caller has already checked the image.
 */
export async function saveSignature(db, { employeeId, dataUrl, bytes, by }) {
  const prev = await storedSignatureById(db, employeeId);
  const { rows } = await db.query(
    `INSERT INTO employee_signatures (employee_id, data_url, bytes, updated_at, updated_by) VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (employee_id) DO UPDATE SET data_url = EXCLUDED.data_url, bytes = EXCLUDED.bytes, updated_at = NOW(), updated_by = EXCLUDED.updated_by
     RETURNING updated_at`, [employeeId, dataUrl, bytes, lower(by)]);
  await db.query(
    `INSERT INTO master_audit (table_key, row_id, column_name, old_value, new_value, actor_email) VALUES ('signatures', $1, 'signature', $2, $3, $4)`,
    [employeeId, prev ? 'uploaded' : '', `uploaded (${Math.round(bytes / 1024)} KB)`, lower(by)]);
  return { updatedAt: rows[0].updated_at };
}
