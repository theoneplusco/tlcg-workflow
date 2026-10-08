// api/lib/approval/step-up.js — who approves on Postgres (decision 2026-10-07, option D).
// The approver re-enters their login password (checked like login, failures counted in Redis), and the
// server stamps their registered sample signature on the approval. No upload, no image comparison.
// Shared by vouchers and purchase requests; acceptance minutes adopt it in Plan 7. Takes db/redis as arguments.
// The lockout (stepup:fail:<email> counter, counted before the check; stepup:lock:<email> lock) is separate from login: it locks approvals only.
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
/** Test seam: the password check (a test counts how many passwords a burst gets verified). */
export const stepUpDeps = { verifyPassword };
const msgs = (lang) => STEP_UP_MSG[lang === 'en' ? 'en' : 'vi'];
const lower = (s) => String(s || '').trim().toLowerCase();
export const failKey = (email) => `stepup:fail:${lower(email)}`;
export const lockKey = (email) => `stepup:lock:${lower(email)}`;

/** ioredis MULTI results → values; an aborted transaction or any command error throws (refused by the caller). */
function execResults(res) {
  if (!Array.isArray(res)) throw new Error('transaction aborted');
  return res.map(([err, val]) => { if (err) throw err; return val; });
}

/** The login password of `email`, re-entered at approval time. Never logs the password. */
export async function confirmPassword({ db, redis, email, password, lang }) {
  const m = msgs(lang);
  const me = lower(email);
  const pw = typeof password === 'string' ? password : '';
  if (!me || !pw) return { ok: false, message: m.needPassword };
  // Count the attempt BEFORE checking the password (INCR + EXPIRE in one transaction, so the counter always has
  // a TTL): a parallel burst gets at most MAX_PASSWORD_FAILS passwords checked per window, never one per request.
  let n;
  try {
    if (await redis.get(lockKey(me))) return { ok: false, locked: true, message: m.locked };
    [n] = execResults(await redis.multi().incr(failKey(me)).expire(failKey(me), LOCK_SECONDS).exec());
    n = Number(n);
    if (n > MAX_PASSWORD_FAILS) {
      await redis.set(lockKey(me), '1', 'EX', LOCK_SECONDS);
      return { ok: false, locked: true, message: m.locked };
    }
  } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
  const user = pw.length > MAX_PASSWORD_LENGTH ? null : (await db.query(
    `SELECT id, password_hash, legacy_password_sha256 FROM employees WHERE LOWER(email) = $1 AND status = 'active'`, [me])).rows[0];
  const valid = user ? await stepUpDeps.verifyPassword(db, user, pw) : false;
  try {
    if (valid) { await redis.del(failKey(me), lockKey(me)); return { ok: true }; }
    if (n < MAX_PASSWORD_FAILS) return { ok: false, message: m.wrongPassword };
    // The 5th failure: a lock of LOCK_SECONDS from now (what the message says). The count is kept, so an
    // attempt that passed the lock check before this line still finds the counter over the limit.
    await redis.set(lockKey(me), '1', 'EX', LOCK_SECONDS);
    return { ok: false, locked: true, message: m.locked };
  } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
}

/** Test seam: how a non-data sample URL becomes a data URL (an oversized one throws before it is read). */
export const stampDeps = { fetchImage: (url) => fetchImageDataUrl(url, { maxBytes: MAX_STAMP_BYTES }) };
const cache = new Map(); // url → { dataUrl, at }
export function clearStampCache() { cache.clear(); }

const STAMPABLE = /^data:image\/(png|jpe?g|gif|webp)(;[^,]*)?,/i;
const decodedBytes = (dataUrl) => {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Buffer.byteLength(dataUrl.slice(i + 1), 'base64');
};
/** Why a data URL cannot be stamped ('' = it can): raster image types only, at most MAX_STAMP_BYTES decoded. */
function unstampable(dataUrl) {
  if (typeof dataUrl !== 'string' || !STAMPABLE.test(dataUrl)) return 'not a png/jpeg/gif/webp image';
  if (decodedBytes(dataUrl) > MAX_STAMP_BYTES) return `larger than ${MAX_STAMP_BYTES} bytes`;
  return '';
}

/** The sample as a stampable data URL; throws otherwise. Only stampable results are cached. */
async function sampleImage(url) {
  if (/^data:/i.test(url)) {
    const why = unstampable(url);
    if (why) throw new Error(why);
    return url;
  }
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.dataUrl;
  const dataUrl = await stampDeps.fetchImage(url);
  const why = unstampable(dataUrl);
  if (why) throw new Error(why);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, { dataUrl, at: Date.now() });
  return dataUrl;
}

/**
 * The approver's registered sample (company role sample, else the employee's Signature column) as the
 * image data URL stamped on the approval. `entries` as sampleSignatureFor (null = from the company emails).
 * Controller decision 3 (2026-10-07): a sample that cannot be loaded, is not an image or is over
 * MAX_STAMP_BYTES or is not png/jpeg/gif/webp refuses its owner with NO_SAMPLE (logged for admins; Plan 5b Task 7 lists them).
 * STEP_UP_MSG.sampleFetch / sampleTooBig are kept for that admin listing, not answered here.
 */
export async function stampSignature(db, companyId, entries, email, lang) {
  const none = { ok: false, message: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
  const { url, from } = await sampleSignatureFor(db, companyId, entries, email);
  if (!url) return none;
  let signature;
  try { signature = await sampleImage(url); } catch (e) {
    console.error(`[StepUp] sample unusable (company ${companyId || '-'}, approver ${lower(email)}, from ${from}):`, e.message);
    return none;
  }
  return { ok: true, signature, from, url };
}

/** What the metadata keeps for an approval confirmed by password (old browser-check records stay as they are). */
export const verificationRecord = (from, at) => ({ verified: true, method: 'password', sampleFrom: from || '', verifiedAt: at });

/**
 * stampSignature memoised for one request by (company, sample URL), failures included: a bulk approve
 * with a slow or broken sample loads it once, not once per document. Always reports the sample's
 * companyId/url/from so the caller can check, under its row lock, that the sample is still the same.
 * Call it BEFORE taking a row lock: a slow or unreachable sample must never hold the lock.
 */
export function makeStamper(lang) {
  const memo = new Map();
  return async (db, companyId, entries, email) => {
    const s = await sampleSignatureFor(db, companyId, entries, email);
    const base = { companyId: companyId || null, url: s.url, from: s.from };
    if (!s.url) return { ...base, ok: false, message: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
    const k = `${companyId || ''}|${s.url}`;
    if (!memo.has(k)) memo.set(k, stampSignature(db, companyId, entries, email, lang));
    return { ...(await memo.get(k)), ...base };
  };
}

/**
 * Under the row lock: is `pre` (a makeStamper result, or null) still the approver's current sample
 * (same company, URL and source)? A DB lookup only, never a fetch. false → redo the attempt outside the lock.
 */
export async function stampStillCurrent(client, pre, companyId, entries, email) {
  if (!pre) return false;
  const cur = await sampleSignatureFor(client, companyId, entries, email);
  return pre.companyId === (companyId || null) && pre.url === cur.url && pre.from === cur.from;
}
