// Boot checks (migration 006 present) and the JWT secret rule.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { missingVoucherSchema, missingP2PSchema } from '../../api/lib/startup-checks.js';
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

const fakeDb2 = (t, o) => ({ query: async () => ({ rows: [{ t, o }] }) });
test('missingP2PSchema: p2p off → not checked', async () => {
  assert.equal(await missingP2PSchema(['vouchers'], fakeDb2(null, null)), null);
});
test('missingP2PSchema: p2p on without migration 007 → names the file', async () => {
  assert.match(await missingP2PSchema(['p2p'], fakeDb2(null, 'sheet_outbox')), /007_purchase_requests\.sql/);
  assert.match(await missingP2PSchema(['p2p'], fakeDb2('purchase_order_types', null)), /006_sheet_outbox\.sql/);
});
test('missingP2PSchema: database unreachable → not fatal (null), the error is logged', async () => {
  const { error } = console;
  console.error = () => {};
  try {
    assert.equal(await missingP2PSchema(['p2p'], { query: async () => { throw new Error('ECONNREFUSED'); } }), null);
  } finally { console.error = error; }
});
test('missingP2PSchema: real test database has migrations 006 and 007', { skip: !process.env.TEST_DATABASE_URL && 'needs TEST_DATABASE_URL' }, async () => {
  const pg = (await import('pg')).default;
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try { assert.equal(await missingP2PSchema(['p2p'], db), null); } finally { await db.end(); }
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

test('configProblems: payments on → refuse to boot until Plan 6', async () => {
  const { configProblems } = await import('../../api/lib/startup-checks.js');
  assert.deepEqual(configProblems(['payments', 'files'], {}),
    ['[server] FATAL: payments workflow is not available yet (Plan 6); remove "payments" from PG_WORKFLOWS']);
});
test('configProblems: p2p without P2P_SPREADSHEET_ID → fatal; with it, or p2p off → none', async () => {
  const { configProblems } = await import('../../api/lib/startup-checks.js');
  assert.deepEqual(configProblems(['p2p', 'files'], {}),
    ['[server] FATAL: P2P_SPREADSHEET_ID must be set when p2p is on (GAS contracts/acceptance/payments read PRs from the Sheet)']);
  assert.deepEqual(configProblems(['p2p', 'files'], { P2P_SPREADSHEET_ID: 'abc' }), []);
  assert.deepEqual(configProblems(['vouchers', 'files'], {}), []);
  assert.deepEqual(configProblems([], {}), []);
  assert.equal(configProblems(['p2p', 'payments'], {}).length, 2);
});
test('configWarnings: sheet copy worker off with p2p or vouchers', async () => {
  const { configWarnings } = await import('../../api/lib/startup-checks.js');
  const off = '[server] Sheet copy worker is off (SHEETS_MIRROR != on); sheet_outbox will grow';
  assert.deepEqual(configWarnings(['vouchers', 'files'], {}), [off]);
  assert.deepEqual(configWarnings(['p2p', 'files'], { SHEETS_MIRROR: 'off' }), [off]);
  assert.deepEqual(configWarnings(['p2p', 'files'], { SHEETS_MIRROR: 'on' }), []);
  assert.deepEqual(configWarnings(['files'], {}), [], 'neither workflow on → no warning');
});
test('configWarnings: p2p without files → signatures and attachments still go through GAS', async () => {
  const { configWarnings } = await import('../../api/lib/startup-checks.js');
  assert.deepEqual(configWarnings(['p2p'], { SHEETS_MIRROR: 'on' }),
    ['[server] p2p without files: signature images and attachments still go through GAS']);
  assert.deepEqual(configWarnings(['vouchers'], { SHEETS_MIRROR: 'on' }), [], 'only p2p needs this warning');
});
