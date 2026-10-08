// api/handlers/signatures.js — sample signatures stored in Postgres (migration 009, decision 2026-10-08).
// The employee uploads their own in My Profile, confirmed with their login password (same lockout as approvals);
// an admin can view or replace anyone's in admin.html › Account. Always on Postgres (not a PG_WORKFLOWS workflow).
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { callerFromRequest } from '../lib/auth-caller.js';
import { confirmPassword, clearStampCache } from '../lib/approval/step-up.js';
import { checkSignatureImage, storedSignatureFor, storedSignatureById, saveSignature, SIGNATURE_MSG } from '../lib/approval/signature-store.js';
import { requireAdmin } from './admin-employees.js';

const fail = (res, message) => res.json({ success: false, message });
const signIn = (res, lang) => res.status(401).json({ success: false, message: lang === 'en' ? 'Please sign in.' : 'Vui lòng đăng nhập' });
const view = (s) => (s ? { hasSignature: true, signature: s.dataUrl, updatedAt: s.updatedAt, updatedBy: s.updatedBy } : { hasSignature: false });

/** getMySignature — the signed-in user's stored signature (or hasSignature: false). */
export async function handleGetMySignature(req, res) {
  const lang = req.body?.lang;
  const caller = await callerFromRequest(req);
  if (!caller) return signIn(res, lang);
  try {
    return res.json({ success: true, data: view(await storedSignatureFor(pool, caller.email)) });
  } catch (err) {
    console.error('[Signatures] get mine:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
}

/** saveMySignature { signature, password } — the signed-in user replaces their own signature after their password. */
export async function handleSaveMySignature(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const caller = await callerFromRequest(req);
  if (!caller) return signIn(res, lang);
  const img = checkSignatureImage(b.signature, lang);
  if (!img.ok) return fail(res, img.message);
  const pw = await confirmPassword({ db: pool, redis, email: caller.email, password: b.password, lang });
  if (!pw.ok) return fail(res, pw.message);
  try {
    const saved = await saveSignature(pool, { employeeId: caller.id, dataUrl: b.signature, bytes: img.bytes, by: caller.email });
    clearStampCache();
    console.log(`[Signatures] ${caller.email} uploaded their signature (${img.bytes} bytes)`);
    return res.json({ success: true, message: SIGNATURE_MSG[lang === 'en' ? 'en' : 'vi'].saved, data: { updatedAt: saved.updatedAt } });
  } catch (err) {
    console.error('[Signatures] save mine:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
}

/** adminGetSignature { id } — an employee's stored signature (admins only). */
export async function handleAdminGetSignature(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const id = parseInt(req.body?.id, 10);
  if (!id) return fail(res, 'Thiếu mã nhân viên.');
  try {
    return res.json({ success: true, data: view(await storedSignatureById(pool, id)) });
  } catch (err) {
    console.error('[Signatures] admin get:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
}

/** adminSaveSignature { id, signature } — an admin uploads or replaces an employee's signature (audited). */
export async function handleAdminSaveSignature(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const b = req.body || {};
  const id = parseInt(b.id, 10);
  if (!id) return fail(res, 'Thiếu mã nhân viên.');
  const img = checkSignatureImage(b.signature, b.lang);
  if (!img.ok) return fail(res, img.message);
  try {
    const emp = (await pool.query(`SELECT id, email FROM employees WHERE id = $1`, [id])).rows[0];
    if (!emp) return fail(res, 'Không tìm thấy nhân viên.');
    const saved = await saveSignature(pool, { employeeId: id, dataUrl: b.signature, bytes: img.bytes, by: admin.email });
    clearStampCache();
    console.log(`[Signatures] ${admin.email} uploaded the signature of employee #${id} (${img.bytes} bytes)`);
    return res.json({ success: true, message: SIGNATURE_MSG.vi.saved, data: { updatedAt: saved.updatedAt } });
  } catch (err) {
    console.error('[Signatures] admin save:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
}
