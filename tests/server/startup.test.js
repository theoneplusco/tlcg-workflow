// Boot checks (migration 006 present) and the JWT secret rule.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { missingVoucherSchema } from '../../api/lib/startup-checks.js';
import { jwtSecret, decodeToken } from '../../api/handlers/auth.js';
import redis from '../../db/redis.js';

after(() => redis.quit());

const fakeDb = (value) => ({ query: async () => ({ rows: [{ t: value }] }) });

test('missingVoucherSchema: vouchers off → not checked', async () => {
  assert.equal(await missingVoucherSchema(['files'], fakeDb(null)), null);
});
test('missingVoucherSchema: vouchers on and sheet_outbox missing → explains migration 006', async () => {
  assert.match(await missingVoucherSchema(['vouchers'], fakeDb(null)), /sheet_outbox.*006_sheet_outbox\.sql/);
});
test('missingVoucherSchema: table present → ok', async () => {
  assert.equal(await missingVoucherSchema(['vouchers', 'files'], fakeDb('sheet_outbox')), null);
});
test('missingVoucherSchema: database unreachable → not fatal (null), the error is logged', async () => {
  const { error } = console;
  console.error = () => {};
  try {
    assert.equal(await missingVoucherSchema(['vouchers'], { query: async () => { throw new Error('ECONNREFUSED'); } }), null);
  } finally { console.error = error; }
});
test('missingVoucherSchema: real test database has migration 006', { skip: !process.env.TEST_DATABASE_URL && 'needs TEST_DATABASE_URL' }, async () => {
  const pg = (await import('pg')).default;
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try { assert.equal(await missingVoucherSchema(['vouchers'], db), null); } finally { await db.end(); }
});

test('jwtSecret: env wins; dev default outside production; none in production', () => {
  assert.equal(jwtSecret({ JWT_SECRET: 's', NODE_ENV: 'production' }), 's');
  assert.equal(jwtSecret({}), 'dev-secret-change-in-production');
  assert.equal(jwtSecret({ NODE_ENV: 'development' }), 'dev-secret-change-in-production');
  assert.equal(jwtSecret({ NODE_ENV: 'production' }), null);
  assert.equal(jwtSecret({ NODE_ENV: 'production', JWT_SECRET: '' }), null);
});
test('decodeToken refuses every token in production without JWT_SECRET', () => {
  const saved = { s: process.env.JWT_SECRET, n: process.env.NODE_ENV };
  try {
    delete process.env.JWT_SECRET;
    process.env.NODE_ENV = 'production';
    const forged = jwt.sign({ id: 1 }, 'dev-secret-change-in-production');
    assert.equal(decodeToken(forged), null, 'the public dev default is not accepted');
    process.env.NODE_ENV = 'test';
    assert.equal(decodeToken(forged).id, 1);
  } finally {
    if (saved.s === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = saved.s;
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
  }
});
