// tests/purchase-requests/numbering.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { vnDate, cleanPrefix, choosePRNo, prefixFor, allocatePRNo } from '../../api/lib/purchase-requests/numbering.js';

test('vnDate: Vietnam calendar day (UTC+7)', () => {
  assert.equal(vnDate(new Date('2026-10-06T16:59:59Z')), '20261006');
  assert.equal(vnDate(new Date('2026-10-06T17:00:00Z')), '20261007');
});
test('cleanPrefix / prefixFor: company code, not the company name', () => {
  assert.equal(cleanPrefix('E.V'), 'EV');
  assert.equal(cleanPrefix(' w.s '), 'WS');
  assert.equal(prefixFor({ company_code: 'E.V' }, 'XX-PR20261007000001'), 'EV');
  assert.equal(prefixFor({ company_code: '' }, 'MI-PR20261007000004'), 'MI');
  assert.equal(prefixFor(null, 'CÔNG TY TNHH EGG VENTURES (E.V)'), 'PR');
});
test('choosePRNo: requested number kept when free', () => {
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261007000003', taken: new Set() }), 'EV-PR20261007000003');
});
test('choosePRNo: taken → next free tail (GAS allocateUniquePRNoOnServer_)', () => {
  const taken = new Set(['EV-PR20261007000003', 'EV-PR20261007000004']);
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261007000003', taken }), 'EV-PR20261007000005');
});
test('choosePRNo: other date / other prefix / garbage → today, first free from 1', () => {
  const taken = new Set(['EV-PR20261007000001']);
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261006000009', taken }), 'EV-PR20261007000002');
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'TL-PR20261007000009', taken }), 'EV-PR20261007000002');
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: '', taken: new Set() }), 'EV-PR20261007000001');
});

test('choosePRNo: over-long tail is garbage, returns promptly from 1', () => {
  const long = 'EV-PR202610079007199254740992';
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: long, taken: new Set([long]) }), 'EV-PR20261007000001');
});
test('choosePRNo: 9-digit tail still works', () => {
  const r = 'EV-PR20261007123456789';
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: r, taken: new Set([r]) }), 'EV-PR20261007123456790');
});
test('choosePRNo: lowercase requested number is accepted', () => {
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'ev-pr20261007000003', taken: new Set() }), 'EV-PR20261007000003');
  assert.equal(prefixFor({ company_code: '' }, 'mi-pr20261007000004'), 'MI');
});

const url = process.env.TEST_DATABASE_URL;
const db = url ? new pg.Pool({ connectionString: url }) : null;
after(async () => { if (db) await db.end(); });
const clean = () => db.query(`DELETE FROM purchase_requests WHERE pr_no LIKE 'QQ-%'; DELETE FROM pr_audit_log WHERE doc_no LIKE 'QQ-%'`);

test('allocatePRNo: two concurrent submits of the same number get different numbers', { skip: !url && 'needs TEST_DATABASE_URL' }, async () => {
  await clean();
  const now = new Date();
  const want = `QQ-PR${vnDate(now)}000001`;
  const a = await db.connect();
  const b = await db.connect();
  try {
    await db.query(`INSERT INTO pr_audit_log (doc_no, action) VALUES ($1, 'Submit')`, [`QQ-PR${vnDate(now)}000002`]); // audit-only number
    await a.query('BEGIN');
    await b.query('BEGIN');
    const first = await allocatePRNo(a, { prefix: 'QQ', requested: want, now });
    await a.query(`INSERT INTO purchase_requests (pr_no) VALUES ($1)`, [first]);
    const second = allocatePRNo(b, { prefix: 'QQ', requested: want, now }); // waits for a's lock
    await a.query('COMMIT');
    assert.equal(first, want);
    assert.equal(await second, `QQ-PR${vnDate(now)}000003`);
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    await b.query('ROLLBACK').catch(() => {});
    a.release(); b.release();
    await clean();
  }
});

test('allocatePRNo: a rolled-back allocation frees the number for reuse', { skip: !url && 'needs TEST_DATABASE_URL' }, async () => {
  await clean();
  const now = new Date();
  const want = `QQ-PR${vnDate(now)}000001`;
  const a = await db.connect();
  try {
    await a.query('BEGIN');
    const first = await allocatePRNo(a, { prefix: 'QQ', requested: want, now });
    await a.query(`INSERT INTO purchase_requests (pr_no) VALUES ($1)`, [first]);
    await a.query('ROLLBACK');
    await a.query('BEGIN');
    assert.equal(await allocatePRNo(a, { prefix: 'QQ', requested: want, now }), want);
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    a.release();
    await clean();
  }
});
