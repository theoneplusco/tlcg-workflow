// tests/vouchers/delete.test.js — the requester deletes a voucher nobody else has approved yet (decision 2026-10-08).
// Needs TEST_DATABASE_URL (master data imported) + Redis db 15, like handlers.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PW, useStepUp } from '../approval/step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const REQ = 'del-req@x.vn';
const OTHER = 'del-other@x.vn';
let h, pool, redis, company, people, cleanup;

const callAs = (fn, body, auth) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: auth ? { authorization: auth } : {} }, res)).catch(reject);
});
const jwtFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
let seq = 0;
const newNo = () => `MI-PC20261008${String(700000 + ++seq).padStart(6, '0')}`;
const submit = async (no, requestor, auth = null, extra = {}) => callAs(h.handleVoucherSubmit, {
  email: { to: people.accountant, subject: `[PHÊ DUYỆT] Phiếu ${no}`, body: '<p>page body</p>' },
  voucher: { voucherNumber: no, voucherType: 'Phiếu Chi', company: company.company_name, companyKey: company.company_key,
    employee: 'Người Lập', requestorEmail: requestor, amount: '250.000', reason: 'Nhập nhầm', files: [] },
  ...extra,
}, auth);
const del = async (no, who) => callAs(h.handleVoucherDelete, { voucherNumber: no }, who ? await jwtFor(who) : null);
const approve = async (no, who) => callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverPassword: PW } }, await jwtFor(who));
const voucher = async (no) => (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet';
  h = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default;
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC202610087%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC202610087%';
                    DELETE FROM email_queue WHERE subject LIKE '%MI-PC202610087%'; TRUNCATE approval_flows`);
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  people = { accountant: company.accountant_email.toLowerCase(), legal: company.legal_rep_email.toLowerCase() };
  cleanup = await useStepUp(pool, redis, [people.accountant, people.legal, REQ, OTHER]);
});
after(async () => {
  if (!pool) return;
  if (cleanup) await cleanup();
  await pool.end();
  redis.quit?.();
});

test('the requester deletes a voucher nobody approved: hidden from lists, history and audit kept, approvers told', { skip }, async () => {
  const no = newNo();
  assert.equal((await submit(no, REQ)).success, true);
  const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(REQ));
  assert.equal(ctx.data.canDelete, true);
  const r = await del(no, REQ);
  assert.deepEqual([r.success, r.message], [true, `Đã xóa phiếu ${no}.`]);

  const v = await voucher(no);
  assert.equal(v.status, 'Đã xóa');
  assert.deepEqual([v.pending_emails, v.current_approver, v.metadata.deletedBy], [[], '', REQ]);
  const hist = (await pool.query(`SELECT status, action FROM voucher_history WHERE voucher_number = $1 ORDER BY id`, [no])).rows;
  assert.deepEqual(hist.map((x) => x.status), ['Đang treo', 'Đã xóa']);
  assert.match(hist[1].action, /^Đã xóa bởi /);
  const a = (await pool.query(`SELECT action, prev_status, new_status, actor_email FROM voucher_audit_log WHERE doc_no = $1 ORDER BY id DESC LIMIT 1`, [no])).rows[0];
  assert.deepEqual(a, { action: 'Delete', prev_status: 'Đang treo', new_status: 'Đã xóa', actor_email: REQ });
  const current = (await pool.query(`SELECT record FROM sheet_outbox WHERE tab = 'Voucher_Current' AND record->>'voucherNumber' = $1 ORDER BY id DESC LIMIT 1`, [no])).rows[0];
  assert.equal(current.record.status, 'Đã xóa', 'the Sheet copy says deleted');
  const told = (await pool.query(`SELECT to_email FROM email_queue WHERE subject = $1`, [`[ĐÃ XÓA] Phiếu ${no}`])).rows;
  assert.deepEqual(told.map((x) => x.to_email), [people.accountant]);

  const mine = await callAs(h.handleVoucherSummary, {}, await jwtFor(REQ));
  assert.ok(!mine.data.recent.some((x) => x.voucherNumber === no), 'gone from the requester\'s list');
  const theirs = await callAs(h.handleVoucherSummary, {}, await jwtFor(people.accountant));
  assert.ok(!theirs.data.recent.some((x) => x.voucherNumber === no), 'gone from the approver\'s list');

  assert.equal((await approve(no, people.accountant)).message, 'Phiếu này đã bị người đề nghị xóa.');
  const rej = await callAs(h.handleVoucherReject, { voucher: { voucherNumber: no, rejectReason: 'x' } }, await jwtFor(people.accountant));
  assert.equal(rej.message, 'Phiếu này đã bị người đề nghị xóa.');
  assert.equal((await del(no, REQ)).message, 'Phiếu này đã bị người đề nghị xóa.');
  assert.equal((await voucher(no)).status, 'Đã xóa');
  assert.equal((await submit(no, REQ)).success, false, 'the number is never reused');
});

test('only the requester or the signed-in submitter may delete; a token is required', { skip }, async () => {
  const no = newNo();
  await submit(no, REQ);
  assert.equal((await del(no, OTHER)).message, 'Chỉ người đề nghị hoặc người đã gửi phiếu mới xóa được phiếu này.');
  assert.equal((await del(no, people.accountant)).message, 'Chỉ người đề nghị hoặc người đã gửi phiếu mới xóa được phiếu này.');
  const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(people.accountant));
  assert.equal(ctx.data.canDelete, false);
  assert.equal((await del(no, null)).code, 401);

  const filed = newNo();
  await submit(filed, REQ, await jwtFor(OTHER)); // OTHER files it for REQ
  assert.equal((await del(filed, OTHER)).success, true, 'the submitter may delete what they filed');
  assert.equal((await voucher(no)).status, 'Đang treo');
});

test('once someone else has approved, the requester can no longer delete', { skip }, async () => {
  const no = newNo();
  await submit(no, REQ);
  assert.equal((await approve(no, people.accountant)).success, true);
  const r = await del(no, REQ);
  assert.equal(r.success, false);
  assert.match(r.message, /^Không thể xóa: phiếu đã được .+ phê duyệt\.$/);
  assert.equal((await voucher(no)).status, 'Đang duyệt (1/3)');
});

test('the requester\'s own auto-approval (Plan 5c) does not block the delete', { skip }, async () => {
  const no = newNo();
  const r = await submit(no, people.accountant, await jwtFor(people.accountant), { selfApprovalPassword: PW });
  assert.equal(r.success, true, r.message);
  assert.equal((await voucher(no)).status, 'Đang duyệt (1/3)');
  assert.equal((await del(no, people.accountant)).success, true);
  assert.equal((await voucher(no)).status, 'Đã xóa');
});
