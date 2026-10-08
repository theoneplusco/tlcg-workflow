// api/lib/auth/login-throttle.js — failure throttling for login and change-password (takes redis as an argument).
// Product decision (2026-10-07): no hard per-account lockout that strangers could trigger. Two counters instead:
//   - per client IP + email: 10 failures / 15 min → that IP is refused for that account (the owner elsewhere is not);
//   - per email across all IPs: 50 failures / hour → the account is refused everywhere until the window ends
//     (a distributed attacker can lock an account only by sustained guessing, which this caps at 50/hour).
// Each attempt is counted BEFORE the password is checked (INCR + EXPIRE NX in one transaction: a fixed window
// that always has a TTL), so a parallel burst cannot get more checks than the limit. A success clears the
// IP + email counter and takes its own count back off the email counter. Redis down → fail open (logged),
// like the API rate limiter: login must not depend on the counters. Separate from the approval step-up lock.
import { verifyPassword } from './password.js';

export const IP_EMAIL_LIMIT = { max: 10, seconds: 900 };
export const EMAIL_LIMIT = { max: 50, seconds: 3600 };
export const THROTTLE_MSG = {
  vi: 'Bạn đã nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.',
  en: 'Too many wrong passwords. Please try again in 15 minutes.',
};
/** Test seam: the password check (a test counts how many passwords a burst gets checked). */
export const throttleDeps = { verifyPassword };

const norm = (s) => String(s || '').trim().toLowerCase().slice(0, 320);
export const ipEmailKey = (ip, email) => `loginfail:ip:${String(ip || 'unknown').slice(0, 64)}|${norm(email)}`;
export const emailKey = (email) => `loginfail:email:${norm(email)}`;

/**
 * The visitor's IP. Cloudflare (the tunnel in front of the server) sets CF-Connecting-IP to the real client and
 * overwrites any value the client sent; api/voucher.js reads it first for the same reason. Without it, the Express
 * req.ip (trust proxy is on in server.js), then the socket address.
 */
export function clientIp(req) {
  const cf = String(req?.headers?.['cf-connecting-ip'] || '').trim();
  return cf || req?.ip || req?.socket?.remoteAddress || 'unknown';
}

/**
 * Count one password attempt before checking it. { ok: false, message } = refuse without checking the password.
 * Returns { ok: true, counted } otherwise (counted false when Redis is unavailable).
 */
export async function countAttempt(redis, { ip, email, lang }) {
  const k1 = ipEmailKey(ip, email);
  const k2 = emailKey(email);
  try {
    const res = await redis.multi()
      .incr(k1).expire(k1, IP_EMAIL_LIMIT.seconds, 'NX')
      .incr(k2).expire(k2, EMAIL_LIMIT.seconds, 'NX')
      .exec();
    if (!Array.isArray(res)) throw new Error('transaction aborted');
    const [n1, , n2] = res.map(([err, val]) => { if (err) throw err; return Number(val); });
    if (n1 > IP_EMAIL_LIMIT.max || n2 > EMAIL_LIMIT.max) {
      return { ok: false, message: THROTTLE_MSG[lang === 'en' ? 'en' : 'vi'] };
    }
    return { ok: true, counted: true };
  } catch (e) {
    console.error('[LoginThrottle] counters unavailable, not throttling:', e.message);
    return { ok: true, counted: false };
  }
}

const UNDO_SCRIPT = `redis.call('DEL', KEYS[1])
if redis.call('EXISTS', KEYS[2]) == 1 and tonumber(redis.call('GET', KEYS[2])) > 0 then redis.call('DECR', KEYS[2]) end
return 1`;

/** After a correct password: clear this IP's counter for the account; the success is not a failure on the email counter. */
export async function attemptSucceeded(redis, { ip, email }, counted = true) {
  if (!counted) return;
  try {
    // One script: DEL the IP counter; DECR the email counter only while it exists (a DECR on an expired key would
    // create a counter without a TTL).
    await redis.eval(UNDO_SCRIPT, 2, ipEmailKey(ip, email), emailKey(email));
  } catch (e) {
    console.error('[LoginThrottle] could not clear counters:', e.message);
  }
}
