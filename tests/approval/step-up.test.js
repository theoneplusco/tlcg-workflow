// tests/approval/step-up.test.js — password step-up and the stamped sample (needs TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Redis from 'ioredis';
import {
  confirmPassword, stampSignature, stampDeps, clearStampCache, warmSample, failKey, lockKey, verificationRecord, STEP_UP_MSG, MAX_STAMP_BYTES, LOCK_SECONDS,
  stepUpDeps, MAX_PASSWORD_FAILS,
} from '../../api/lib/approval/step-up.js';
import { sha256Hex } from '../../api/lib/auth/password.js';
import { NO_SAMPLE } from '../../api/lib/approval/signature-check.js';
import { PW, FAKE_STAMP, useStepUp } from './step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
const redis = url ? new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15') : null;
const ME = 'stepup@test.vn';
const LEGACY = 'stepup-legacy@test.vn';
const M = STEP_UP_MSG.vi;
let company, savedSig, savedExtra, cleanup;
const realFetchImage = stampDeps.fetchImage; // captured before useStepUp swaps in FAKE_STAMP

before(async () => {
  if (!db) return;
  cleanup = await useStepUp(db, redis, [ME]);
  savedExtra = (await db.query(`SELECT extra FROM employees WHERE email = $1`, [ME])).rows[0].extra;
  await db.query(`DELETE FROM employees WHERE email = $1`, [LEGACY]);
  await db.query(`INSERT INTO employees (full_name, email, status, password_hash, legacy_password_sha256) VALUES ('Legacy', $1, 'active', '', $2)`, [LEGACY, sha256Hex(PW)]);
  company = (await db.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  savedSig = company.treasurer_sig_url;
  await db.query(`UPDATE companies SET treasurer_sig_url = 'https://drive.google.com/file/d/stamp-test/view' WHERE id = $1`, [company.id]);
});
after(async () => {
  if (!db) return;
  await db.query(`UPDATE companies SET treasurer_sig_url = $2 WHERE id = $1`, [company.id, savedSig]);
  await db.query(`DELETE FROM employees WHERE email = $1`, [LEGACY]);
  await db.query(`UPDATE employees SET extra = $2 WHERE email = $1`, [ME, savedExtra]);
  await cleanup();
  await redis.del(failKey(ME), failKey(LEGACY), lockKey(ME), lockKey(LEGACY), failKey('nobody@test.vn'), lockKey('nobody@test.vn'));
  await db.end();
  await redis.quit();
});

const check = (password, email = ME, lang = 'vi', r = redis) => confirmPassword({ db, redis: r, email, password, lang });

test('confirmPassword: right password ok; wrong, empty and over-long refused', { skip }, async () => {
  assert.deepEqual(await check(PW), { ok: true });
  assert.deepEqual(await check('nope'), { ok: false, message: M.wrongPassword });
  assert.deepEqual(await check(''), { ok: false, message: M.needPassword });
  assert.deepEqual(await check(undefined), { ok: false, message: M.needPassword });
  assert.deepEqual(await check('x'.repeat(201)), { ok: false, message: M.wrongPassword });
  assert.equal((await check('nope', ME, 'en')).message, 'Incorrect password.');
  assert.deepEqual(await check(PW, 'nobody@test.vn'), { ok: false, message: M.wrongPassword });
  await redis.del(failKey(ME), failKey('nobody@test.vn'));
});

test('confirmPassword: the 5th wrong password locks for 15 minutes from that failure, even the right one', { skip }, async () => {
  for (let i = 1; i <= 4; i += 1) assert.equal((await check('nope')).message, M.wrongPassword, `attempt ${i}`);
  const failTtl = await redis.ttl(failKey(ME));
  assert.ok(failTtl > 0 && failTtl <= LOCK_SECONDS, `fail ttl ${failTtl}`);
  assert.deepEqual(await check('nope'), { ok: false, locked: true, message: M.locked });
  assert.equal(await redis.get(failKey(ME)), '5', 'the count is kept (an attempt already past the lock check still sees it)');
  const ttl = await redis.ttl(lockKey(ME));
  assert.ok(ttl > 0 && ttl <= LOCK_SECONDS, `lock ttl ${ttl}`);
  assert.deepEqual(await check(PW), { ok: false, locked: true, message: M.locked });
  await redis.del(lockKey(ME), failKey(ME)); // the lock and the counter expired
  assert.deepEqual(await check(PW), { ok: true });
  assert.equal(await redis.exists(failKey(ME)) + await redis.exists(lockKey(ME)), 0, 'a correct password clears both keys');
});

test('confirmPassword: a counter left without TTL cannot lock forever (the next failure sets both TTLs)', { skip }, async () => {
  await redis.set(failKey(ME), '4'); // e.g. left by a crash between calls, no TTL
  assert.equal(await redis.ttl(failKey(ME)), -1);
  assert.deepEqual(await check('nope'), { ok: false, locked: true, message: M.locked });
  const kept = await redis.ttl(failKey(ME));
  assert.ok(kept > 0 && kept <= LOCK_SECONDS, `the counter got a TTL (${kept})`);
  const ttl = await redis.ttl(lockKey(ME));
  assert.ok(ttl > 0 && ttl <= LOCK_SECONDS, `lock ttl ${ttl}`);
  await redis.set(failKey(ME), '2');
  assert.deepEqual(await check('nope'), { ok: false, locked: true, message: M.locked }, 'still locked while the lock key lives');
  assert.equal(await redis.get(failKey(ME)), '2', 'attempts while locked are not counted');
  await redis.del(lockKey(ME));
  assert.deepEqual(await check('nope'), { ok: false, message: M.wrongPassword });
  const failTtl = await redis.ttl(failKey(ME));
  assert.ok(failTtl > 0 && failTtl <= LOCK_SECONDS, `a wrong password refreshes the counter TTL (${failTtl})`);
  await redis.del(failKey(ME));
});

test('confirmPassword: a parallel burst of 20 wrong passwords verifies at most 5 (counted before verifying)', { skip }, async () => {
  await redis.del(failKey(ME), lockKey(ME));
  const real = stepUpDeps.verifyPassword;
  let verified = 0;
  stepUpDeps.verifyPassword = async (...args) => { verified += 1; await new Promise((r) => setTimeout(r, 20)); return real(...args); };
  try {
    const results = await Promise.all(Array.from({ length: 20 }, () => check('nope')));
    assert.ok(verified <= MAX_PASSWORD_FAILS, `verified ${verified} passwords`);
    assert.ok(results.every((r) => !r.ok));
    assert.ok(results.filter((r) => r.locked).length >= 15, 'the rest are refused as locked');
    assert.equal(await redis.exists(lockKey(ME)), 1);
    assert.deepEqual(await check(PW), { ok: false, locked: true, message: M.locked }, 'even the right password while locked');
  } finally {
    stepUpDeps.verifyPassword = real;
    await redis.del(failKey(ME), lockKey(ME));
  }
});

test('confirmPassword: GAS SHA-256 password accepted and upgraded to bcrypt (the login path)', { skip }, async () => {
  assert.deepEqual(await check(PW, LEGACY), { ok: true });
  const row = (await db.query(`SELECT password_hash, legacy_password_sha256 FROM employees WHERE email = $1`, [LEGACY])).rows[0];
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.equal(row.legacy_password_sha256, '');
});

test('confirmPassword: Redis down → refused (fail closed)', { skip }, async () => {
  const down = { get: async () => { throw new Error('down'); } };
  assert.deepEqual(await check(PW, ME, 'vi', down), { ok: false, message: M.unavailable });
  const incrFails = {
    get: async () => null,
    del: async () => 1,
    multi: () => { const t = { incr: () => t, expire: () => t, set: () => t, del: () => t, exec: async () => [[new Error('OOM'), null], [null, 1]] }; return t; },
  };
  assert.deepEqual(await check('nope', ME, 'vi', incrFails), { ok: false, message: M.unavailable });
  const execNull = { get: async () => null, multi: () => { const t = { incr: () => t, expire: () => t, exec: async () => null }; return t; } };
  assert.deepEqual(await check('nope', ME, 'vi', execNull), { ok: false, message: M.unavailable });
});

test('stampSignature: the role sample as an image data URL, fetched once per URL (cache)', { skip }, async () => {
  let calls = 0;
  stampDeps.fetchImage = async (u) => { calls += 1; return FAKE_STAMP(u); };
  clearStampCache();
  const entries = [{ role: 'treasurer', label: 'Thủ quỹ' }];
  const a = await stampSignature(db, company.id, entries, company.treasurer_email, 'vi');
  const b = await stampSignature(db, company.id, entries, company.treasurer_email, 'vi');
  assert.deepEqual(a, { ok: true, signature: FAKE_STAMP('https://drive.google.com/file/d/stamp-test/view'), from: 'Thủ quỹ', url: 'https://drive.google.com/file/d/stamp-test/view' });
  assert.deepEqual(b, a);
  assert.equal(calls, 1);
});

// Controller decision 3 (2026-10-07): unreachable or oversized samples refuse their owner with NO_SAMPLE.
test('stampSignature: no sample, fetch failure, non-image and oversize refused with NO_SAMPLE; data URL samples used as is', { skip }, async () => {
  clearStampCache();
  assert.deepEqual(await stampSignature(db, null, null, ME, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  stampDeps.fetchImage = async () => { throw new Error('HTTP 500'); };
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  stampDeps.fetchImage = async () => 'data:text/html;base64,AAAA';
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  stampDeps.fetchImage = async () => 'data:image/png;base64,' + Buffer.alloc(MAX_STAMP_BYTES + 1).toString('base64');
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  const inline = 'data:image/png;base64,' + Buffer.from('sig').toString('base64');
  await db.query(`UPDATE employees SET extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('Signature', $2::text) WHERE email = $1`, [ME, inline]);
  stampDeps.fetchImage = async () => { throw new Error('must not fetch a data URL'); };
  assert.deepEqual(await stampSignature(db, null, null, ME, 'vi'), { ok: true, signature: inline, from: 'Master Employee', url: inline });
  stampDeps.fetchImage = async () => { throw new Error('HTTP 500'); };
  clearStampCache();
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'en'), { ok: false, message: NO_SAMPLE.en });
});

test('stampSignature: a failed fetch is not cached (the next approval tries again)', { skip }, async () => {
  clearStampCache();
  let calls = 0;
  stampDeps.fetchImage = async (u) => { calls += 1; if (calls === 1) throw new Error('HTTP 500'); return FAKE_STAMP(u); };
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  assert.equal((await stampSignature(db, company.id, null, company.treasurer_email, 'vi')).ok, true);
  assert.equal(calls, 2);
});

test('warmSample: an approval page starts the download; the approval in flight shares it, then stamps from memory', { skip }, async () => {
  clearStampCache();
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  stampDeps.fetchImage = async (u) => { calls += 1; await gate; return FAKE_STAMP(u); };
  const url = 'https://drive.google.com/file/d/stamp-test/view';
  warmSample(url); // page opened
  const approving = stampSignature(db, company.id, null, company.treasurer_email, 'vi'); // clicked before it finished
  release();
  assert.equal((await approving).ok, true);
  assert.equal((await stampSignature(db, company.id, null, company.treasurer_email, 'vi')).signature, FAKE_STAMP(url));
  assert.equal(calls, 1);
  warmSample(''); warmSample('data:image/png;base64,AAAA'); // nothing to load: no fetch, no throw
  stampDeps.fetchImage = async () => { throw new Error('HTTP 500'); };
  warmSample('https://drive.google.com/file/d/broken/view'); // a failure stays quiet (the approval reports it)
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
});

test('verificationRecord: what the metadata keeps for a password approval', () => {
  assert.deepEqual(verificationRecord('Thủ quỹ', '2026-10-07T01:00:00.000Z'),
    { verified: true, method: 'password', sampleFrom: 'Thủ quỹ', verifiedAt: '2026-10-07T01:00:00.000Z' });
});

test('stampSignature: an oversized fetched sample is not cached (the next approval fetches again)', { skip }, async () => {
  clearStampCache();
  let calls = 0;
  stampDeps.fetchImage = async () => { calls += 1; return 'data:image/png;base64,' + Buffer.alloc(MAX_STAMP_BYTES + 1).toString('base64'); };
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  assert.equal(calls, 2);
});

test('stampSignature: only raster images (png, jpeg, gif, webp) are stamped', { skip }, async () => {
  for (const [mime, okay] of [['image/png', true], ['image/jpeg', true], ['image/jpg', true], ['image/gif', true], ['image/webp', true],
    ['image/svg+xml', false], ['image/bmp', false], ['image/tiff', false]]) {
    clearStampCache();
    stampDeps.fetchImage = async () => `data:${mime};base64,` + Buffer.from('sig').toString('base64');
    assert.equal((await stampSignature(db, company.id, null, company.treasurer_email, 'vi')).ok, okay, mime);
  }
  const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64');
  await db.query(`UPDATE employees SET extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('Signature', $2::text) WHERE email = $1`, [ME, svg]);
  assert.deepEqual(await stampSignature(db, null, null, ME, 'vi'), { ok: false, message: NO_SAMPLE.vi }, 'inline svg sample refused');
});

test('stampDeps.fetchImage (real): refuses a sample larger than MAX_STAMP_BYTES before reading it', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, ok: true, headers: new Map([['content-type', 'image/png'], ['content-length', String(MAX_STAMP_BYTES + 1)]]), arrayBuffer: async () => new ArrayBuffer(0) });
  try {
    await assert.rejects(realFetchImage('https://drive.google.com/file/d/big/view'), /Hình ảnh quá lớn/);
  } finally { globalThis.fetch = saved; }
});
