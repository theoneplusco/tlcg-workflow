// tests/server/my-tasks.test.js — getMyTaskCounts (sidebar badges): documents waiting for the signed-in person,
// counted only for workflows on Postgres. Needs TEST_DATABASE_URL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const ME = 'tasks-me@x.vn';
const OTHER = 'tasks-other@x.vn';
let h, pool, redis;

const callAs = (fn, auth) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body: {}, query: {}, headers: auth ? { authorization: auth } : {} }, res)).catch(reject);
});
const jwtFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
const clean = () => pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'TASKS-%'; DELETE FROM purchase_requests WHERE pr_no LIKE 'TASKS-%'`);

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  h = await import('../../api/handlers/my-tasks.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default; // auth.js opens it; closed in after()
  for (const e of [ME, OTHER]) {
    await pool.query(`INSERT INTO employees (full_name, email, status) SELECT $1, $1, 'active' WHERE NOT EXISTS (SELECT 1 FROM employees WHERE LOWER(email) = $1)`, [e]);
  }
  await clean();
  const v = (no, status, pending) => pool.query(
    `INSERT INTO vouchers (voucher_number, voucher_type, status, pending_emails) VALUES ($1, 'Chi', $2, $3)`, [no, status, pending]);
  await v('TASKS-V1', 'Đang treo', [ME]);
  await v('TASKS-V2', 'Đang treo', ['Tasks-Me@X.vn', OTHER]); // emails compared without case
  await v('TASKS-V3', 'Đang treo', [OTHER]);
  await v('TASKS-V4', 'Đã từ chối', [ME]); // closed: never counted, even with a stale pending list
  await v('TASKS-V5', 'Đã xóa', [ME]);
  const pr = (no, status, pending) => pool.query(
    `INSERT INTO purchase_requests (pr_no, status, pending_emails) VALUES ($1, $2, $3)`, [no, status, pending]);
  await pr('TASKS-PR1', 'Đang duyệt ngân sách & NCC (2/5)', [ME]);
  await pr('TASKS-PR2', 'Trả lại bổ sung', [ME]); // sent back to me, the requester
  await pr('TASKS-PR3', 'Hoàn thành', [ME]);
  await pr('TASKS-PR4', 'Mua hàng (5/5)', [OTHER]);
});
after(async () => {
  if (!pool) return;
  await clean();
  await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [[ME, OTHER]]);
  await pool.end();
  redis.quit?.();
});

test('signed out: refused', { skip }, async () => {
  assert.equal((await callAs(h.handleMyTaskCounts, null)).code, 401);
});

test('counts open documents waiting for me, only for workflows on Postgres', { skip }, async () => {
  const before = process.env.PG_WORKFLOWS;
  try {
    process.env.PG_WORKFLOWS = 'cash,vouchers,p2p';
    const r = await callAs(h.handleMyTaskCounts, await jwtFor(ME));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.counts, { 'cash-voucher': 2, 'p2p-pr': 2 });
    assert.deepEqual((await callAs(h.handleMyTaskCounts, await jwtFor(OTHER))).data.counts, { 'cash-voucher': 2, 'p2p-pr': 1 });

    process.env.PG_WORKFLOWS = 'vouchers'; // p2p still on GAS: no key, so no badge rather than a wrong one
    assert.deepEqual((await callAs(h.handleMyTaskCounts, await jwtFor(ME))).data.counts, { 'cash-voucher': 2 });
    process.env.PG_WORKFLOWS = '';
    assert.deepEqual((await callAs(h.handleMyTaskCounts, await jwtFor(ME))).data.counts, {});
  } finally {
    process.env.PG_WORKFLOWS = before;
    if (before === undefined) delete process.env.PG_WORKFLOWS;
  }
});
