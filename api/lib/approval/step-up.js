// api/lib/approval/step-up.js — who approves on Postgres (decision 2026-10-07, option D).
// The approver re-enters their login password (checked like login, failures counted in Redis), and the
// server stamps their registered sample signature on the approval. No upload, no image comparison.
// Shared by vouchers and purchase requests; acceptance minutes adopt it in Plan 7. Takes db/redis as arguments.
// The lockout counter (stepup:fail:<email>) is separate from login: it locks approvals only, never login.
// Callers must pass the signed-in caller's email from the token (no token → 401 'Vui lòng đăng nhập').
import { verifyPassword } from '../auth/password.js';
import { fetchImageDataUrl } from '../files/fetch-image.js';
import { sampleSignatureFor, NO_SAMPLE } from './signature-check.js';

export const MAX_PASSWORD_FAILS = 5;
export const LOCK_SECONDS = 900;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_STAMP_BYTES = 768000; // 750 KB decoded
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

export const STEP_UP_MSG = {
  vi: {
    needPassword: 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.',
    wrongPassword: 'Mật khẩu không đúng.',
    locked: 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.',
    unavailable: 'Không kiểm tra được mật khẩu lúc này. Vui lòng thử lại sau.',
    sampleFetch: 'Không tải được chữ ký mẫu của bạn. Vui lòng thử lại hoặc liên hệ quản trị viên.',
    sampleTooBig: 'Chữ ký mẫu của bạn quá lớn (tối đa 750 KB). Vui lòng nhờ quản trị viên thay ảnh nhỏ hơn.',
  },
  en: {
    needPassword: 'Please enter your login password to confirm the approval.',
    wrongPassword: 'Incorrect password.',
    locked: 'Too many wrong passwords. Please try again in 15 minutes.',
    unavailable: 'The password cannot be checked right now. Please try again later.',
    sampleFetch: 'Your sample signature could not be loaded. Please try again or contact an administrator.',
    sampleTooBig: 'Your sample signature is too large (max 750 KB). Ask an administrator to replace it with a smaller image.',
  },
};
const msgs = (lang) => STEP_UP_MSG[lang === 'en' ? 'en' : 'vi'];
const lower = (s) => String(s || '').trim().toLowerCase();
export const failKey = (email) => `stepup:fail:${lower(email)}`;

/** The login password of `email`, re-entered at approval time. Never logs the password. */
export async function confirmPassword({ db, redis, email, password, lang }) {
  const m = msgs(lang);
  const me = lower(email);
  const pw = typeof password === 'string' ? password : '';
  if (!me || !pw) return { ok: false, message: m.needPassword };
  let fails;
  try { fails = Number(await redis.get(failKey(me))) || 0; } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
  if (fails >= MAX_PASSWORD_FAILS) return { ok: false, locked: true, message: m.locked };
  const user = pw.length > MAX_PASSWORD_LENGTH ? null : (await db.query(
    `SELECT id, password_hash, legacy_password_sha256 FROM employees WHERE LOWER(email) = $1 AND status = 'active'`, [me])).rows[0];
  const valid = user ? await verifyPassword(db, user, pw) : false;
  try {
    if (valid) { await redis.del(failKey(me)); return { ok: true }; }
    const n = await redis.incr(failKey(me));
    if (n === 1) await redis.expire(failKey(me), LOCK_SECONDS);
    return n >= MAX_PASSWORD_FAILS ? { ok: false, locked: true, message: m.locked } : { ok: false, message: m.wrongPassword };
  } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
}

/** Test seam: how a non-data sample URL becomes a data URL. */
export const stampDeps = { fetchImage: (url) => fetchImageDataUrl(url) };
const cache = new Map(); // url → { dataUrl, at }
export function clearStampCache() { cache.clear(); }

async function sampleImage(url) {
  if (/^data:image\//.test(url)) return url;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.dataUrl;
  const dataUrl = await stampDeps.fetchImage(url);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, { dataUrl, at: Date.now() });
  return dataUrl;
}

const decodedBytes = (dataUrl) => {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Buffer.byteLength(dataUrl.slice(i + 1), 'base64');
};

/**
 * The approver's registered sample (company role sample, else the employee's Signature column) as the
 * image data URL stamped on the approval. `entries` as sampleSignatureFor (null = from the company emails).
 * Controller decision 3 (2026-10-07): a sample that cannot be loaded, is not an image or is over
 * MAX_STAMP_BYTES refuses its owner with NO_SAMPLE (logged for admins; Plan 5b Task 7 lists them).
 * STEP_UP_MSG.sampleFetch / sampleTooBig are kept for that admin listing, not answered here.
 */
export async function stampSignature(db, companyId, entries, email, lang) {
  const none = { ok: false, message: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
  const { url, from } = await sampleSignatureFor(db, companyId, entries, email);
  if (!url) return none;
  let signature;
  try { signature = await sampleImage(url); } catch (e) {
    console.error('[StepUp] sample fetch failed:', e.message);
    return none;
  }
  if (typeof signature !== 'string' || !/^data:image\//.test(signature)) {
    console.error('[StepUp] sample is not an image:', from);
    return none;
  }
  if (decodedBytes(signature) > MAX_STAMP_BYTES) {
    console.error('[StepUp] sample larger than', MAX_STAMP_BYTES, 'bytes:', from);
    return none;
  }
  return { ok: true, signature, from, url };
}

/** What the metadata keeps for an approval confirmed by password (old browser-check records stay as they are). */
export const verificationRecord = (from, at) => ({ verified: true, method: 'password', sampleFrom: from || '', verifiedAt: at });
