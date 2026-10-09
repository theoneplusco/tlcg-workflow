// Integration tests for the voucher write actions. Need TEST_DATABASE_URL (a
// throwaway DB with schema + migrations 001-005 + master data imported) and a
// local Redis (REDIS_URL, db 15 recommended).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { stampDeps, clearStampCache } from '../../api/lib/approval/step-up.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
let h, pool, saveVersion, company, people;
let redis, cleanupStepUp;

const call = (fn, body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: {} }, res)).catch(reject);
});
let seq = 0;
const newNo = () => `MI-PC20261007${String(900000 + ++seq).padStart(6, '0')}`;
const submitBody = (no, extra = {}) => ({
  email: { to: people.accountant, subject: `[PHÊ DUYỆT] Phiếu ${no}`, body: '<p>page body</p>', replyTo: 'sub@x.vn' },
  requesterEmail: { to: 'sub@x.vn', subject: `[THÔNG BÁO] Phiếu ${no}`, body: '<p>Phiếu đã được gửi phê duyệt</p>' },
  voucher: { voucherNumber: no, voucherType: 'Phiếu Chi', company: company.company_name, companyKey: company.company_key,
    employee: 'Người Lập', requestorEmail: 'Sub@x.vn', amount: '1.500.000', reason: 'Mua VPP',
    files: [{ fileName: 'hd.pdf', fileUrl: 'https://drive/x', fileSize: 1048576 }], ...extra },
});
const emails = async (no) => (await pool.query(`SELECT to_email, cc, subject FROM email_queue WHERE subject LIKE $1 OR body_html LIKE $1 ORDER BY id`, [`%${no}%`])).rows;
const voucher = async (no) => (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
const history = async (no) => (await pool.query(`SELECT status, action, note, approver_email, rejection_reason FROM voucher_history WHERE voucher_number = $1 ORDER BY id`, [no])).rows;
// Sheet copy queued for one voucher: History rows key voucher_number, Current rows voucherNumber
const outbox = async (no) => (await pool.query(
  `SELECT tab, mode, key_column, record FROM sheet_outbox WHERE record->>'voucher_number' = $1 OR record->>'voucherNumber' = $1 ORDER BY id`, [no])).rows;
// Approvals need the approver's login token (decision 2: the password step-up is keyed on the token's email)
const approve = async (no, email, extra = {}) => callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverEmail: email, approverPassword: PW, ...extra } }, await jwtFor(email));

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet';
  h = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  ({ saveVersion } = await import('../../api/lib/approval/flows-repo.js'));
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC20261007%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC20261007%';
                    TRUNCATE email_queue; TRUNCATE approval_flows; TRUNCATE sheet_outbox`);
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  people = { accountant: company.accountant_email.toLowerCase(), legal: company.legal_rep_email.toLowerCase(), treasurer: company.treasurer_email.toLowerCase() };
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.accountant, people.legal, people.treasurer, 'stranger@x.vn']);
});
after(async () => {
  if (!pool) return;
  if (cleanupStepUp) await cleanupStepUp();
  await pool.end();
  (await import('../../db/redis.js')).default.quit?.();
});

test('submit: stored with the default 3-step plan, page email kept, requester notified', { skip }, async () => {
  const no = newNo();
  const r = await call(h.handleVoucherSubmit, submitBody(no));
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công');
  const v = await voucher(no);
  assert.equal(v.status, 'Đang treo');
  assert.equal(Number(v.amount), 1500000);
  assert.equal(v.requestor_email, 'sub@x.vn');
  assert.deepEqual(v.pending_emails, [people.accountant]);
  assert.equal(v.metadata.companyApprovers.approvalProgress, '0/3');
  assert.equal(v.attachments, 'hd.pdf (1.00 MB)\nhttps://drive/x');
  assert.deepEqual((await history(no)).map((x) => x.action), ['Đã nộp phiếu']);
  const m = await emails(no);
  assert.deepEqual(m.map((x) => x.to_email), [people.accountant, 'sub@x.vn']);
  assert.equal(m[0].subject, `[PHÊ DUYỆT] Phiếu ${no}`, 'page subject kept');
});

test('submit twice → GAS duplicate message', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const r = await call(h.handleVoucherSubmit, submitBody(no));
  assert.equal(r.success, false);
  assert.match(r.message, /đã được gửi trước đó/);
});

test('approve: password, order, already-approved, then progress + next-step email', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  assert.equal((await approve(no, people.accountant, { approverPassword: '' })).message, 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.');
  assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Mật khẩu không đúng.');
  await redis.del(`stepup:fail:${people.accountant}`);
  assert.match((await approve(no, 'stranger@x.vn')).message, /Không tìm thấy thông tin người phê duyệt/);
  if (people.legal !== people.accountant) assert.match((await approve(no, people.legal)).message, /Vui lòng đợi/);
  const r = await approve(no, people.accountant);
  assert.equal(r.success, true, r.message);
  assert.match(r.message, /Đã gửi email đến/);
  assert.match((await approve(no, people.accountant)).message, /đã phê duyệt phiếu này rồi/);
  const v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.equal(v.metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url), 'the registered sample is stamped');
  assert.deepEqual(Object.values(v.metadata.signatureVerification).map((x) => [x.verified, x.method]), [[true, 'password']]);
  assert.deepEqual(v.pending_emails, [people.legal]);
  const m = await emails(no);
  assert.ok(m.some((x) => x.to_email === people.legal && x.subject.startsWith('[PHÊ DUYỆT]')), 'next approver asked');
  assert.ok(m.some((x) => x.to_email === 'sub@x.vn' && x.subject.startsWith('[ĐANG DUYỆT (1/3)]')), 'progress to requester');
});

test('full approval → final emails; acknowledge once; history like the sheet', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  assert.match((await call(h.handleVoucherAcknowledge, { voucherNumber: no, requesterSignature: 's' })).message, /chưa được duyệt hoàn toàn/);
  for (const e of [people.accountant, people.legal, people.treasurer]) assert.equal((await approve(no, e)).success, true);
  const v = await voucher(no);
  assert.equal(v.status, 'Đã duyệt');
  assert.equal(v.metadata.treasurerSignature, FAKE_STAMP(company.treasurer_sig_url));
  assert.equal(v.metadata.approverSignature, FAKE_STAMP(company.treasurer_sig_url), 'print-template alias');
  let ob = await outbox(no);
  assert.deepEqual(ob.map((r) => r.tab), Array(4).fill(['Voucher_History', 'Voucher_Current']).flat(), 'History then Current, per change');
  const cur = ob.filter((r) => r.tab === 'Voucher_Current');
  assert.ok(cur.every((r) => r.mode === 'upsert' && r.key_column === 'voucherNumber'));
  assert.ok(ob.filter((r) => r.tab === 'Voucher_History').every((r) => r.mode === 'append' && r.key_column === null));
  assert.deepEqual(cur.map((r) => r.record.approvalProgress), [0, 1, 2, 3]);
  assert.equal(cur.at(-1).record.status, 'Đã duyệt');
  assert.equal(cur.at(-1).record.submittedAt, cur[0].record.submittedAt, 'original submission time kept');
  assert.equal(cur[0].record.lastUpdated, cur[0].record.submittedAt);
  assert.equal(ob[0].record.amount, 1500000);
  const ack = await call(h.handleVoucherAcknowledge, { voucherNumber: no, requesterEmail: 'sub@x.vn', requesterName: 'Người Lập', requesterSignature: 'data:ack' });
  assert.equal(ack.success, true, ack.message);
  assert.match((await call(h.handleVoucherAcknowledge, { voucherNumber: no, requesterSignature: 'x' })).message, /đã được xác nhận nhận tiền rồi/);
  assert.equal((await voucher(no)).status, 'Received');
  const hist = await history(no);
  assert.deepEqual(hist.map((x) => x.status), ['Đang treo', 'Đang duyệt (1/3)', 'Đang duyệt (2/3)', 'Đã duyệt', 'Received']);
  ob = await outbox(no);
  assert.deepEqual(ob.filter((r) => r.tab === 'Voucher_History').map((r) => r.record.status), hist.map((x) => x.status), 'one History append per history row');
  const ackRow = ob.filter((r) => r.tab === 'Voucher_History').at(-1).record;
  assert.equal(ackRow.acknowledged_by, 'sub@x.vn');
  assert.equal(ackRow.signature_url, 'data:ack');
  assert.equal(ackRow.acknowledged_at, ackRow.submitted_at, 'event time');
  const lastCur = ob.filter((r) => r.tab === 'Voucher_Current').at(-1).record;
  assert.equal(lastCur.status, 'Received');
  assert.equal(lastCur.approvalProgress, 3);
  assert.equal(hist[3].note, 'Tất cả 3 bước phê duyệt đã duyệt');
  const subjects = (await emails(no)).map((x) => x.subject);
  assert.ok(subjects.includes(`[ĐÃ DUYỆT HOÀN TOÀN] Phiếu ${no}`));
  assert.ok(subjects.includes(`[XÁC NHẬN NHẬN TIỀN] Phiếu ${no}`));
  assert.ok(subjects.includes(`[ĐÃ NHẬN TIỀN] Phiếu ${no}`));
});

test('no VOUCHER_SPREADSHEET_ID: the voucher is saved, no Sheet copy is queued', { skip }, async () => {
  const no = newNo();
  delete process.env.VOUCHER_SPREADSHEET_ID;
  try {
    const r = await call(h.handleVoucherSubmit, submitBody(no));
    assert.equal(r.success, true, r.message);
    assert.ok(await voucher(no));
    assert.deepEqual(await outbox(no), []);
  } finally { process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet'; }
  await call(h.handleVoucherReject, { voucher: { voucherNumber: no, approverEmail: people.treasurer, rejectReason: 'r' } });
  const ids = (await pool.query(`SELECT DISTINCT spreadsheet_id FROM sheet_outbox WHERE record->>'voucherNumber' = $1 OR record->>'voucher_number' = $1`, [no])).rows;
  assert.deepEqual(ids, [{ spreadsheet_id: 'test-voucher-sheet' }], 'explicit target, never the production default');
});

test('reject: reason required; any approver in the flow may reject; everyone notified', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  assert.match((await call(h.handleVoucherReject, { voucher: { voucherNumber: no, approverEmail: people.treasurer } })).message, /lý do từ chối/);
  assert.match((await call(h.handleVoucherReject, { voucher: { voucherNumber: no, approverEmail: 'x@x.vn', rejectReason: 'r' } })).message, /người từ chối/);
  const r = await call(h.handleVoucherReject, { voucher: { voucherNumber: no, approverEmail: people.treasurer, rejectReason: 'Sai số tiền' } });
  assert.equal(r.success, true, r.message);
  assert.match((await approve(no, people.accountant)).message, /đã bị từ chối/);
  assert.match((await call(h.handleVoucherReject, { voucher: { voucherNumber: no, approverEmail: people.accountant, rejectReason: 'r' } })).message, /đã được từ chối trước đó/);
  const last = (await history(no)).pop();
  assert.equal(last.status, 'Đã từ chối');
  assert.equal(last.rejection_reason, 'Sai số tiền');
  const ob = await outbox(no);
  assert.equal(ob.length, 4, 'submit + one reject; refused attempts queue nothing');
  assert.equal(ob[2].record.rejection_reason, 'Sai số tiền');
  assert.equal(ob[3].record.status, 'Đã từ chối');
  assert.equal(ob[3].record.approvalProgress, 0);
  const rej = (await emails(no)).find((x) => x.subject === `[TỪ CHỐI] Phiếu ${no}`);
  assert.ok(rej.to_email.includes('sub@x.vn') && rej.to_email.includes(people.accountant));
});

test('custom company flow with a group step: all must approve before the next step', { skip }, async () => {
  await saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps: [
    { name: 'KTT + GĐ', approvers: [{ type: 'role', role: 'chief_accountant' }, { type: 'role', role: 'treasurer' }] },
    { name: 'ĐDPL', approvers: [{ type: 'role', role: 'legal_rep' }] },
  ] });
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  let v = await voucher(no);
  assert.equal(v.progress_total, 2);
  assert.deepEqual([...v.pending_emails].sort(), [people.accountant, people.treasurer].sort());
  const a = await approve(no, people.treasurer);
  assert.match(a.message, /cùng duyệt bước này/);
  assert.equal((await voucher(no)).status, 'Đang treo', 'step not done yet');
  await approve(no, people.accountant);
  v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/2)');
  assert.deepEqual(v.pending_emails, [people.legal]);
  assert.equal((await approve(no, people.legal)).message, 'Đã phê duyệt thành công. Phiếu đã được duyệt hoàn toàn.');
  await pool.query(`TRUNCATE approval_flows`);
});

test('bulk approve: per-voucher results and one batch email per next approver', { skip }, async () => {
  const nos = [newNo(), newNo()];
  for (const no of nos) await call(h.handleVoucherSubmit, submitBody(no));
  const r = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: [...nos, 'MI-PC20261007999999'], approverEmail: people.accountant,
    approverPassword: PW }, await jwtFor(people.accountant));
  assert.equal(r.success, true);
  assert.deepEqual(r.data.approved, nos);
  assert.equal(r.data.failed.length, 1);
  for (const no of nos) {
    const cur = (await outbox(no)).filter((x) => x.tab === 'Voucher_Current').map((x) => x.record);
    assert.deepEqual(cur.map((x) => [x.status, x.approvalProgress]), [['Đang treo', 0], ['Đang duyệt (1/3)', 1]]);
  }
  const batch = (await pool.query(`SELECT to_email, subject, body_html FROM email_queue WHERE subject LIKE '[PHÊ DUYỆT HÀNG LOẠT]%' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(batch.to_email, people.legal);
  assert.match(batch.subject, /^\[PHÊ DUYỆT HÀNG LOẠT\] 2 phiếu/);
  assert.ok(nos.every((no) => batch.body_html.includes(no)));
});

test('reads: summary visibility + admin flag check, history newest first, approval status', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  await approve(no, people.accountant);
  const admin = (await pool.query(`SELECT LOWER(email) AS e FROM employees WHERE is_admin AND status='active' LIMIT 1`)).rows[0].e;
  const nonAdmin = 'sub@x.vn';

  const asAdmin = await call(h.handleVoucherSummary, { callerEmail: admin, isAdmin: 'true' });
  assert.ok(asAdmin.data.globalStats, 'real admin gets global stats');
  assert.ok(asAdmin.data.recent.some((r) => r.voucherNumber === no));

  const spoof = await call(h.handleVoucherSummary, { callerEmail: 'nobody@x.vn', isAdmin: 'true' });
  assert.equal(spoof.data.globalStats, null, 'isAdmin from the page is not trusted');
  assert.equal(spoof.data.total, 0);

  const own = await call(h.handleVoucherSummary, { callerEmail: nonAdmin });
  const mine = own.data.recent.find((r) => r.voucherNumber === no);
  assert.equal(mine.meta.companyApprovers.approvalProgress, '1/3');
  assert.equal(mine.meta.companyApprovers.currentApprover, 'legalRep');

  const asLegal = await call(h.handleVoucherSummary, { callerEmail: people.legal });
  assert.ok(asLegal.data.recent.some((r) => r.voucherNumber === no), 'approver in the flow sees it');

  const hist = await call(h.handleVoucherHistory, { voucherNumber: no });
  assert.equal(hist.data.length, 2);
  assert.match(hist.data[0].action, /^Duyệt bởi /, 'newest first');
  assert.equal(hist.data[hist.data.length - 1].action, 'Đã nộp phiếu', 'oldest last');
  assert.equal(hist.data[0].meta.companyApprovers.approvalProgress, '1/3');

  const st = await call(h.handleVoucherApprovalStatus, { voucherNumber: no });
  assert.equal(st.data.approvalProgress, '1/3');
  assert.equal(st.data.currentApprover, 'legalRep');
  assert.equal(st.data.approvers.accountant.status, 'approved');
  assert.equal(st.data.approvalPlan.steps.length, 3);
  assert.match((await call(h.handleVoucherApprovalStatus, { voucherNumber: 'NOPE' })).message, /Không tìm thấy phiếu/);
});

test('daily reminder: one email per pending approver for vouchers due tomorrow', { skip }, async () => {
  const { runVoucherReminders } = await import('../../api/jobs/voucher-reminders.js');
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no, { dueDate: '2026-10-08' }));
  const before = (await emails(no)).length;
  assert.ok((await runVoucherReminders(pool, '2026-10-07')) >= 1);
  const rem = (await emails(no)).slice(before).find((x) => x.subject === `[NHẮC NHỞ] Phiếu ${no} sắp đến hạn`);
  assert.equal(rem.to_email, people.accountant);
  const later = (await emails(no)).length;
  await runVoucherReminders(pool, '2026-10-05');
  assert.equal((await emails(no)).length, later, 'not due tomorrow → nothing');
});

// ── Signed-in identity (Plan 3, Task 1–2) ─────────────────────
const jwtFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
const callAs = (fn, body, auth) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: auth ? { authorization: auth } : {} }, res)).catch(reject);
});

test('token identity: cannot act for someone else; body email optional; page admin flag ignored', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const acc = await jwtFor(people.accountant);
  const other = await callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverEmail: people.legal, approverPassword: PW } }, acc);
  assert.match(other.message, /không thể thao tác thay/);
  const mine = await callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverPassword: PW } }, acc);
  assert.equal(mine.success, true, mine.message);
  const nonAdmin = (await pool.query(`SELECT LOWER(email) e FROM employees WHERE NOT is_admin AND status='active' LIMIT 1`)).rows[0].e;
  const admin = (await pool.query(`SELECT LOWER(email) e FROM employees WHERE is_admin AND status='active' LIMIT 1`)).rows[0].e;
  const s = await callAs(h.handleVoucherSummary, { callerEmail: admin, isAdmin: 'true' }, await jwtFor(nonAdmin));
  assert.equal(s.data.globalStats, null, 'token user, not the page claims');
});

test('VOUCHER_REQUIRE_LOGIN: no token → 401 for writes and lists', { skip }, async () => {
  process.env.VOUCHER_REQUIRE_LOGIN = 'true';
  try {
    const r = await call(h.handleVoucherApprove, { voucher: { voucherNumber: 'X', approverEmail: people.accountant, approverPassword: PW } });
    assert.equal(r.code, 401);
    assert.equal((await call(h.handleVoucherSummary, { callerEmail: people.accountant })).code, 401);
  } finally {
    delete process.env.VOUCHER_REQUIRE_LOGIN;
  }
});

test('single voucher reads: strangers refused; acknowledge only by the requester', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const stranger = (await pool.query(`SELECT LOWER(email) e FROM employees WHERE NOT is_admin AND status='active' AND LOWER(email) NOT IN ($1,$2,$3) LIMIT 1`,
    [people.accountant, people.legal, people.treasurer])).rows[0];
  if (stranger) {
    const r = await callAs(h.handleVoucherHistory, { voucherNumber: no }, await jwtFor(stranger.e));
    assert.equal(r.code, 403);
  }
  for (const e of [people.accountant, people.legal, people.treasurer]) await approve(no, e);
  const ack = await callAs(h.handleVoucherAcknowledge, { voucherNumber: no, requesterSignature: 'x' }, await jwtFor(people.accountant));
  const accIsAdmin = (await pool.query(`SELECT is_admin FROM employees WHERE LOWER(email) = $1`, [people.accountant])).rows[0].is_admin;
  if (!accIsAdmin) assert.match(ack.message, /Chỉ người đề nghị/);
});

// Someone outside the company's role slots with no sample signature at all (no Signature column, none uploaded).
// Ordered, so the pick never depends on the table's physical row order (seed rows such as TLC AP have a sample).
const personWithoutSample = async () => (await pool.query(`SELECT LOWER(email) e FROM employees
  WHERE status='active' AND LOWER(email) NOT IN ($1,$2,$3) AND NOT (COALESCE(extra, '{}'::jsonb) ? 'Signature')
    AND id NOT IN (SELECT employee_id FROM employee_signatures) ORDER BY id LIMIT 1`,
  [people.accountant, people.legal, people.treasurer])).rows[0];

test('summary myTurn + approval context: whose turn, sample signature, missing sample', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const acc = await jwtFor(people.accountant);
  const sum = await callAs(h.handleVoucherSummary, {}, acc);
  assert.equal(sum.data.recent.find((r) => r.voucherNumber === no).myTurn, true);
  if (people.legal !== people.accountant) {
    const legalSum = await callAs(h.handleVoucherSummary, {}, await jwtFor(people.legal));
    assert.equal(legalSum.data.recent.find((r) => r.voucherNumber === no).myTurn, false);
    const notYet = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(people.legal));
    assert.equal(notYet.data.canApprove, false);
    assert.match(notYet.data.reason, /Chưa đến lượt/);
  }
  const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, acc);
  assert.equal(ctx.data.canApprove, true, ctx.data.reason);
  assert.equal(ctx.data.sampleSignatureUrl, company.accountant_sig_url);
  assert.equal(ctx.data.approvalPlan.steps.length, 3);
  assert.equal((await call(h.handleVoucherApprovalContext, { voucherNumber: no })).code, 401);

  // A named person in the flow needs a "Signature" on their Master Employee row
  const person = await personWithoutSample();
  if (person) {
    await saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps: [{ name: 'P', approvers: [{ type: 'person', email: person.e }] }] });
    const no2 = newNo();
    await call(h.handleVoucherSubmit, submitBody(no2));
    const pAuth = await jwtFor(person.e);
    const noSample = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no2 }, pAuth);
    assert.equal(noSample.data.canApprove, false);
    assert.match(noSample.data.reason, /Chưa có chữ ký mẫu/);
    await pool.query(`UPDATE employees SET extra = extra || '{"Signature":"https://drive/sample"}' WHERE LOWER(email) = $1`, [person.e]);
    const withSample = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no2 }, pAuth);
    assert.equal(withSample.data.canApprove, true);
    assert.equal(withSample.data.sampleSignatureUrl, 'https://drive/sample');
    await pool.query(`UPDATE employees SET extra = extra - 'Signature' WHERE LOWER(email) = $1`, [person.e]);
    await pool.query(`TRUNCATE approval_flows`);
  }
});

test('server refuses an approval when the approver has no sample signature (no "no_sample" bypass)', { skip }, async () => {
  const person = await personWithoutSample();
  if (!person) return;
  await saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps: [{ name: 'P', approvers: [{ type: 'person', email: person.e }] }] });
  await useStepUp(pool, redis, [person.e]); // cleanup not needed: person is an existing employee, so nothing is created
  try {
    const no = newNo();
    await call(h.handleVoucherSubmit, submitBody(no));
    const r = await approve(no, person.e);
    assert.equal(r.success, false);
    assert.match(r.message, /Chưa có chữ ký mẫu/);
  } finally {
    await pool.query(`TRUNCATE approval_flows`); // a failure here must not leave this flow to the next tests
  }
});

test('approve: a wrong password approves nothing; the 5th locks the approver for 15 minutes', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  for (let i = 0; i < 4; i += 1) assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Mật khẩu không đúng.');
  assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await approve(no, people.accountant)).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await voucher(no)).status, 'Đang treo', 'nothing approved');
  await redis.del(`stepup:fail:${people.accountant}`, `stepup:lock:${people.accountant}`);
  assert.equal((await approve(no, people.accountant)).success, true);
  const a = (await pool.query(`SELECT extra FROM voucher_audit_log WHERE doc_no = $1 AND action = 'Approve' ORDER BY id DESC LIMIT 1`, [no])).rows[0];
  assert.deepEqual([a.extra.auth, a.extra.signatureStamped], ['password', true]);
});

test('bulk approve: one password for the batch; a wrong one refuses every voucher', { skip }, async () => {
  const nos = [newNo(), newNo()];
  for (const no of nos) await call(h.handleVoucherSubmit, submitBody(no));
  const acc = await jwtFor(people.accountant);
  const bad = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverEmail: people.accountant, approverPassword: 'wrong' }, acc);
  assert.deepEqual([bad.success, bad.message], [false, 'Mật khẩu không đúng.']);
  for (const no of nos) assert.equal((await voucher(no)).status, 'Đang treo');
  assert.equal(await redis.get(`stepup:fail:${people.accountant}`), '1', 'one failure for the whole batch');
  await redis.del(`stepup:fail:${people.accountant}`);
  const good = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverEmail: people.accountant, approverPassword: PW }, acc);
  assert.deepEqual(good.data.approved, nos);
  for (const no of nos) assert.equal((await voucher(no)).metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url));
});

test('approve without a login token → 401 even when VOUCHER_REQUIRE_LOGIN is off; no password is checked', { skip }, async () => {
  delete process.env.VOUCHER_REQUIRE_LOGIN;
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const one = await call(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverEmail: people.accountant, approverPassword: 'wrong' } });
  assert.deepEqual([one.code, one.success, one.message], [401, false, 'Vui lòng đăng nhập']);
  const bulk = await call(h.handleVoucherBulkApprove, { voucherNumbers: [no], approverEmail: people.accountant, approverPassword: PW });
  assert.deepEqual([bulk.code, bulk.success, bulk.message], [401, false, 'Vui lòng đăng nhập']);
  assert.equal(await redis.get(`stepup:fail:${people.accountant}`), null, 'a body email never feeds the lockout counter');
  assert.equal((await voucher(no)).status, 'Đang treo');
});

test('approval context tells the page to ask for the password', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(people.accountant));
  assert.equal(ctx.data.approvalAuth, 'password');
});

// A named person in the flow whose sample is a URL (not a role sample of the company)
const otherPerson = async () => (await pool.query(`SELECT LOWER(email) e FROM employees WHERE status='active' AND LOWER(email) NOT IN ($1,$2,$3) ORDER BY id LIMIT 1`,
  [people.accountant, people.legal, people.treasurer])).rows[0];

test('bulk approve: a broken sample is fetched once for the batch, never under the row lock; every voucher refused', { skip }, async () => {
  const person = await otherPerson();
  if (!person) return;
  await useStepUp(pool, redis, [person.e]); // cleanup not needed: existing employee
  await pool.query(`UPDATE employees SET extra = extra || '{"Signature":"https://drive/broken-sample"}' WHERE LOWER(email) = $1`, [person.e]);
  await saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps: [{ name: 'P', approvers: [{ type: 'person', email: person.e }] }] });
  const nos = [newNo(), newNo(), newNo()];
  for (const no of nos) await call(h.handleVoucherSubmit, submitBody(no));
  let fetches = 0;
  const lockedDuringFetch = [];
  const lockFree = async () => {
    try { await pool.query(`SELECT 1 FROM vouchers WHERE voucher_number = ANY($1) FOR UPDATE NOWAIT`, [nos]); } catch (e) { lockedDuringFetch.push(e.code); }
  };
  try {
    stampDeps.fetchImage = async () => { fetches += 1; await lockFree(); throw new Error('unreachable'); };
    clearStampCache();
    const r = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverPassword: PW }, await jwtFor(person.e));
    assert.equal(r.success, true, r.message);
    assert.deepEqual(r.data.approved, []);
    assert.deepEqual(r.data.failed.map((f) => [f.voucherNumber, /Chưa có chữ ký mẫu/.test(f.error)]), nos.map((no) => [no, true]));
    assert.equal(fetches, 1, 'one load of the broken sample for the whole batch');
    for (const no of nos) assert.equal((await voucher(no)).status, 'Đang treo');
    // A working sample: loaded before the lock too, then stamped
    stampDeps.fetchImage = async (u) => { fetches += 1; await lockFree(); return FAKE_STAMP(u); };
    const ok1 = await callAs(h.handleVoucherApprove, { voucher: { voucherNumber: nos[0], approverPassword: PW } }, await jwtFor(person.e));
    assert.equal(ok1.success, true, ok1.message);
    assert.equal(fetches, 2);
    assert.deepEqual(lockedDuringFetch, [], 'no voucher row lock held while the sample loads');
  } finally {
    stampDeps.fetchImage = async (u) => FAKE_STAMP(u);
    clearStampCache();
    await pool.query(`UPDATE employees SET extra = extra - 'Signature' WHERE LOWER(email) = $1`, [person.e]);
    await pool.query(`TRUNCATE approval_flows`);
  }
});

test('bulk approve: a voucher whose sample is missing fails alone; identity from the token', { skip }, async () => {
  const withSample = newNo();
  await call(h.handleVoucherSubmit, submitBody(withSample)); // default flow: the company's accountant role sample
  const savedExtra = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.accountant])).rows[0].extra;
  await pool.query(`UPDATE employees SET extra = extra - 'Signature' - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' WHERE LOWER(email) = $1`, [people.accountant]);
  await saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps: [{ name: 'P', approvers: [{ type: 'person', email: people.accountant }] }] });
  try {
    const noSample = newNo();
    await call(h.handleVoucherSubmit, submitBody(noSample)); // named person: needs their own Signature, which they lack
    const acc = await jwtFor(people.accountant);
    const spoof = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: [withSample], approverEmail: people.legal, approverPassword: PW }, acc);
    assert.match(spoof.message, /không thể thao tác thay/);
    const r = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: [withSample, noSample], approverPassword: PW }, acc);
    assert.deepEqual(r.data.approved, [withSample]);
    assert.deepEqual(r.data.failed.map((f) => [f.voucherNumber, /Chưa có chữ ký mẫu/.test(f.error)]), [[noSample, true]]);
    assert.equal((await voucher(noSample)).status, 'Đang treo');
  } finally {
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.accountant, savedExtra]);
    await pool.query(`TRUNCATE approval_flows`);
  }
});
