// tests/server/auth-throttle.test.js — login / change-password failure throttling and the change-password token
// (needs TEST_DATABASE_URL + Redis db 15). Counters: per client IP + email (10 / 15 min) and per email (50 / hour).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { PW } from '../approval/step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const ME = 'throttle@test.vn';
const OTHER = 'throttle-other@test.vn';
const IP1 = '203.0.113.7';
const IP2 = '198.51.100.9';
const LOCKED = 'Bạn đã nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.';
let auth, throttle, pool, redis, passwords;

const call = (fn, body, { ip = IP1, token } = {}) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  const headers = { 'cf-connecting-ip': ip };
  if (token) headers.authorization = token;
  Promise.resolve(fn({ body, query: {}, headers, ip: '127.0.0.1', socket: {} }, res)).catch(reject);
});
const login = (password, opts) => call(auth.handleLogin, { email: ME, password }, opts);
const tokenFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
const clearKeys = async () => {
  const keys = await redis.keys('loginfail:*');
  if (keys.length) await redis.del(...keys);
};
const resetPw = async () => {
  const hash = await bcrypt.hash(PW, 4);
  for (const e of [ME, OTHER]) await pool.query(`UPDATE employees SET password_hash = $2, legacy_password_sha256 = '', must_change_password = FALSE WHERE email = $1`, [e, hash]);
};

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  auth = await import('../../api/handlers/auth.js');
  throttle = await import('../../api/lib/auth/login-throttle.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default;
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [[ME, OTHER]]);
  for (const e of [ME, OTHER]) await pool.query(`INSERT INTO employees (full_name, email, status, password_hash) VALUES ($1, $1, 'active', '')`, [e]);
  await resetPw();
  await clearKeys();
  passwords = 0;
});
after(async () => {
  if (!url) return;
  pool = pool || (await import('../../db/pool.js')).default;
  redis = redis || (await import('../../db/redis.js')).default;
  await clearKeys();
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [[ME, OTHER]]);
  await pool.end();
  await redis.quit();
});

test('login: right password ok; wrong password 401; the IP+email counter is cleared by a success', { skip }, async () => {
  await clearKeys();
  assert.equal((await login('nope')).code, 401);
  assert.equal((await login('nope')).code, 401);
  assert.equal(await redis.get(throttle.ipEmailKey(IP1, ME)), '2');
  const ok = await login(PW);
  assert.equal(ok.success, true);
  assert.ok(ok.data.token);
  assert.equal(await redis.exists(throttle.ipEmailKey(IP1, ME)), 0, 'a success clears this IP for this account');
  assert.equal(await redis.get(throttle.emailKey(ME)), '2', 'a success is not counted as a failure on the email counter');
  await clearKeys();
});

test('login: 10 failures from one IP refuse that IP for that account (even the right password), not other IPs or accounts', { skip }, async () => {
  await clearKeys();
  for (let i = 1; i <= 10; i += 1) assert.equal((await login('nope')).code, 401, `attempt ${i}`);
  const r = await login(PW);
  assert.equal(r.code, 429);
  assert.equal(r.success, false);
  assert.equal(r.message, LOCKED);
  const ttl = await redis.ttl(throttle.ipEmailKey(IP1, ME));
  assert.ok(ttl > 0 && ttl <= 900, `ip+email ttl ${ttl}`);
  assert.equal((await login(PW, { ip: IP2 })).success, true, 'the owner on another IP still signs in');
  assert.equal((await call(auth.handleLogin, { email: OTHER, password: PW })).success, true, 'other accounts from the same IP are not refused');
  await clearKeys();
});

test('login: 50 failures across IPs refuse the account everywhere for the hour', { skip }, async () => {
  await clearKeys();
  for (let i = 0; i < 50; i += 1) {
    const r = await login('nope', { ip: `10.0.${Math.floor(i / 9)}.${i % 9}` }); // ≤ 9 per IP: the IP counter never trips
    assert.equal(r.code, 401, `attempt ${i + 1}`);
  }
  const r = await login(PW, { ip: IP2 });
  assert.equal(r.code, 429);
  assert.equal(r.message, LOCKED);
  const ttl = await redis.ttl(throttle.emailKey(ME));
  assert.ok(ttl > 900 && ttl <= 3600, `email ttl ${ttl}`);
  await clearKeys();
});

test('login: a parallel burst of 30 wrong passwords from one IP checks at most 10 (counted before checking)', { skip }, async () => {
  await clearKeys();
  const real = throttle.throttleDeps.verifyPassword;
  let checked = 0;
  throttle.throttleDeps.verifyPassword = async (...a) => { checked += 1; await new Promise((r) => setTimeout(r, 10)); return real(...a); };
  try {
    const rs = await Promise.all(Array.from({ length: 30 }, () => login('nope')));
    assert.ok(checked <= 10, `checked ${checked}`);
    assert.equal(rs.filter((x) => x.code === 429).length, 20);
  } finally {
    throttle.throttleDeps.verifyPassword = real;
    await clearKeys();
  }
});

test('login: Redis down → login still works (fails open, logged)', { skip }, async () => {
  const down = { multi: () => { const t = { incr: () => t, expire: () => t, exec: async () => { throw new Error('down'); } }; return t; }, del: async () => { throw new Error('down'); }, decr: async () => { throw new Error('down'); } };
  const r = await throttle.countAttempt(down, { ip: IP1, email: ME });
  assert.equal(r.ok, true);
});

test('changePassword: no token → 401 Vui lòng đăng nhập; the email comes from the token, never the body', { skip }, async () => {
  await clearKeys();
  const none = await call(auth.handleChangePassword, { email: ME, currentPassword: PW, newPassword: 'NewPass#2026' });
  assert.equal(none.code, 401);
  assert.equal(none.message, 'Vui lòng đăng nhập');
  // OTHER's token with ME in the body changes OTHER's password, not ME's
  const r = await call(auth.handleChangePassword, { email: ME, currentPassword: PW, newPassword: 'NewPass#2026' }, { token: await tokenFor(OTHER) });
  assert.equal(r.success, true, r.message);
  assert.equal((await call(auth.handleLogin, { email: OTHER, password: 'NewPass#2026' })).success, true);
  assert.equal((await login(PW)).success, true, "ME's password is unchanged");
  await resetPw();
  await clearKeys();
});

test('changePassword: wrong current passwords are throttled like login (10 per IP+email) and a success clears the IP counter', { skip }, async () => {
  await clearKeys();
  const token = await tokenFor(ME);
  const change = (cur, opts = {}) => call(auth.handleChangePassword, { currentPassword: cur, newPassword: 'NewPass#2026' }, { token, ...opts });
  assert.equal((await change('nope')).code, 401);
  assert.equal(await redis.get(throttle.ipEmailKey(IP1, ME)), '1');
  assert.equal((await change(PW)).success, true);
  assert.equal(await redis.exists(throttle.ipEmailKey(IP1, ME)), 0);
  await resetPw();
  for (let i = 1; i <= 10; i += 1) assert.equal((await change('nope')).code, 401, `attempt ${i}`);
  const r = await change(PW);
  assert.equal(r.code, 429);
  assert.equal(r.message, LOCKED);
  await clearKeys();
});

test('first-login forced change: the token returned by login is enough to change the password', { skip }, async () => {
  await clearKeys();
  await pool.query(`UPDATE employees SET must_change_password = TRUE WHERE email = $1`, [ME]);
  const l = await login(PW);
  assert.equal(l.data.mustChangePassword, true);
  const r = await call(auth.handleChangePassword, { email: ME, currentPassword: PW, newPassword: 'NewPass#2026' }, { token: 'Bearer ' + l.data.token });
  assert.equal(r.success, true, r.message);
  const row = (await pool.query(`SELECT must_change_password FROM employees WHERE email = $1`, [ME])).rows[0];
  assert.equal(row.must_change_password, false);
  await resetPw();
  await clearKeys();
});

test('clientIp: Cloudflare CF-Connecting-IP first, then the Express req.ip', () => {
  return import('../../api/lib/auth/login-throttle.js').then(({ clientIp }) => {
    assert.equal(clientIp({ headers: { 'cf-connecting-ip': '1.2.3.4' }, ip: '127.0.0.1' }), '1.2.3.4');
    assert.equal(clientIp({ headers: {}, ip: '5.6.7.8' }), '5.6.7.8');
    assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '9.9.9.9' } }), '9.9.9.9');
  });
});
