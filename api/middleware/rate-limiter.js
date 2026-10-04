// api/middleware/rate-limiter.js — Redis sliding window rate limiter
import redis from '../../db/redis.js';

const RATE_LIMIT = Number(process.env.API_RATE_LIMIT) || 300;  // per minute
const RATE_WINDOW = 60; // seconds

/**
 * Sliding window rate limiter using Redis sorted sets.
 * Key: rate:{userId|ip}:{window}
 * Score: timestamp
 */
export async function rateLimit(req, res, next) {
  // Identify the caller — prefer email from body, fall back to IP
  let key;
  const body = req.body;
  if (body && typeof body === 'object') {
    const email = (body.requesterEmail || body.approverEmail || body.email || '').toString().trim();
    if (email) key = 'rate:user:' + email.toLowerCase();
  }
  if (!key) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    key = 'rate:ip:' + ip;
  }

  const now = Date.now();
  const windowStart = now - RATE_WINDOW * 1000;

  try {
    const pipe = redis.pipeline();
    const member = `${now}-${Math.random().toString(36).slice(2, 8)}`;

    pipe.zremrangebyscore(key, 0, windowStart);   // remove expired
    pipe.zadd(key, now, member);                   // add current request
    pipe.zcard(key);                               // count in window
    pipe.pexpire(key, RATE_WINDOW * 1000 + 1000); // set TTL

    const results = await pipe.exec();
    const count = results[2][1];

    if (count > RATE_LIMIT) {
      return res.status(429).json({
        success: false,
        message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.',
      });
    }

    next();
  } catch (err) {
    // Redis down — fail open (don't block on infra error)
    console.error('[RateLimit] Redis error, failing open:', err.message);
    next();
  }
}
