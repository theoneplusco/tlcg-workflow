// tests/purchase-requests/self-approval.test.js — Plan 5c on PRs: self-picks allowed; the requester's own slots are
// auto-approved after one password at submit / resubmit (TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { sampleSignatureFor } from '../../api/lib/approval/signature-check.js';
import { failKey, lockKey } from '../../api/lib/approval/step-up.js';
import { fullFromRow } from '../../api/lib/purchase-requests/views.js';

let s, d, pool, company, people, redis, cleanupStepUp;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.treasurer, people.accountant, people.ap]);
});
after(async () => { if (cleanupStepUp) await cleanupStepUp(); await teardown(pool); });

const NOTE = (labels) => `Tự động duyệt khi gửi phiếu (người đề nghị là ${labels})`;
const BS = 'Người duyệt Ngân sách, Người duyệt NCC';
const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mailsTo = async (no, part) => (await pool.query(`SELECT to_email FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${part}%${no}`])).rows.map((r) => r.to_email);
const mailBody = async (no, part) => (await pool.query(`SELECT body_html FROM email_queue WHERE subject LIKE $1 ORDER BY id DESC LIMIT 1`, [`%${part}%${no}`])).rows[0].body_html;
const audit = async (no) => (await pool.query(`SELECT action, role, actor_email, actor_name, note, extra FROM pr_audit_log WHERE doc_no = $1 ORDER BY id`, [no])).rows;
const approve = (no, who, role, password = PW) => call(d.handlePRApprove, { prNo: no, approverRole: role, note: '', approverPassword: password }, as(who));
const stampOf = async (email) => FAKE_STAMP((await sampleSignatureFor(pool, company.id, null, email)).url);
const sheetRows = async (no) => (await pool.query(`SELECT tab, record FROM sheet_outbox WHERE record->>'pr_no' = $1 OR record->>'document_no' = $1 ORDER BY id`, [no])).rows;
/** Every stored copy outside purchase_requests.metadata (Sheet PR rows, API view) carries no stamp image. */
const noStampCopies = async (no) => {
  for (const o of (await sheetRows(no)).filter((x) => x.tab === 'Purchase_Request_History')) {
    const c = JSON.parse(o.record.metadata_json).selfApproval;
    if (c) assert.ok(c.stamps.every((st) => st.signature === undefined), 'Sheet PR row without the stamp copy');
  }
  const c = JSON.parse(fullFromRow(await pr(no)).metadata).selfApproval;
  if (c) assert.ok(c.stamps.every((st) => st.signature === undefined), 'API view without the stamp copy');
};
async function withSheet(fn) {
  const saved = process.env.P2P_SPREADSHEET_ID;
  process.env.P2P_SPREADSHEET_ID = 'p2p-test';
  try { return await fn(); } finally { if (saved === undefined) delete process.env.P2P_SPREADSHEET_ID; else process.env.P2P_SPREADSHEET_ID = saved; }
}

test('requester = budget + supplier: asked once (nothing stored), then both slots approved with one stamp; purchasing asked', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  const ask = await call(s.handlePRSubmit, body, T);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true]);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 2, key: '*', labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.equal(ask.message, `Bạn cũng là người duyệt bước 2 (${BS}) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.`);
  assert.equal(await pr(body.prNo), undefined);
  const r = await withSheet(() => call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T));
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, `Đề nghị mua hàng đã được gửi thành công. Đã tự động duyệt bước 2 (${BS}) của bạn.`);
  assert.deepEqual(r.autoApproved, [{ step: 2, labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Mua hàng (5/5)');
  const stamp = await stampOf(people.treasurer);
  assert.equal(row.metadata.budgetSignature, stamp);
  assert.equal(row.metadata.supplierSignature, stamp);
  assert.equal(row.metadata.budgetNote, NOTE(BS));
  assert.deepEqual([row.metadata.budgetSignatureVerification.verified, row.metadata.budgetSignatureVerification.method], [true, 'password']);
  assert.deepEqual(row.pending_emails, [people.ap]);
  assert.equal(row.metadata.selfApproval.ref, body.prNo, 'consent bound to the PR number');
  assert.equal(row.metadata.selfApproval.by, people.treasurer);
  assert.deepEqual(row.metadata.selfApproval.stamps, [], 'no own slot left: stamp copy dropped');
  assert.equal(row.metadata.selfApproval.byName, T.name, 'the token name, for the audit actor');
  const log = await audit(body.prNo);
  assert.equal(log[1].actor_name, T.name, 'audit actor name from the token, not the body requesterName');
  assert.deepEqual(log.map((a) => [a.action, a.role, a.actor_email, a.extra.auto === true]), [
    ['Submit', 'requester', people.treasurer, false], ['Approve', 'budget', people.treasurer, true], ['Approve', 'supplier', people.treasurer, true]]);
  assert.equal(log[1].note, NOTE(BS));
  assert.deepEqual([log[1].extra.auth, log[1].extra.signatureStamped, log[1].extra.consentedAt], ['password', true, row.metadata.selfApproval.consentedAt]);
  const ob = await sheetRows(body.prNo);
  assert.deepEqual(ob.filter((o) => o.tab === 'PR_Audit_Log').map((o) => o.record.action), ['Submit', 'Approve', 'Approve'], 'auto-approval mirrored');
  assert.equal(ob.filter((o) => o.tab === 'Purchase_Request_History').at(-1).record.status, 'Mua hàng (5/5)');
  await noStampCopies(body.prNo);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [], 'no "please approve" email to the requester');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap]);
  assert.match(await mailBody(body.prNo, 'Xác nhận gửi phiếu'), /đã được tự động duyệt khi gửi phiếu/);
});

test('requester = budget only: budget approved at submit; the supplier approver alone is asked', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people, { supplierApprover: people.accountant });
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công. Đã tự động duyệt bước 2 (Người duyệt Ngân sách) của bạn.');
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.deepEqual([row.metadata.budgetStatus, row.metadata.supplierStatus], ['Approved', 'Pending']);
  assert.deepEqual(row.pending_emails, [people.accountant]);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [people.accountant]);
  const a = await approve(body.prNo, people.accountant, 'supplier');
  assert.equal(a.status, 'Mua hàng (5/5)');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap]);
});

test('requester = purchasing: nothing at submit; the budget approval auto-approves purchasing and completes the PR', { skip }, async () => {
  const P = as(people.ap);
  const body = submitBody(company, people);
  const ask = await call(s.handlePRSubmit, body, P);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 5, key: '*', labels: ['Người mua hàng'] }]);
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, P);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  assert.equal(r.autoApproved, undefined);
  assert.equal((await pr(body.prNo)).metadata.selfApproval.stamps.length, 1);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [people.treasurer]);
  const a = await withSheet(() => approve(body.prNo, people.treasurer, 'budget'));
  assert.equal(a.success, true, a.message);
  assert.equal(a.status, 'Hoàn thành');
  const row = await pr(body.prNo);
  assert.equal(row.metadata.purchasingSignature, await stampOf(people.ap));
  assert.equal(row.metadata.purchasingNote, NOTE('Người mua hàng'));
  assert.deepEqual(row.pending_emails, []);
  assert.deepEqual(row.metadata.selfApproval.stamps, [], 'final: stamp copy dropped');
  assert.deepEqual(row.metadata.selfApproval.auto.map((x) => x.step), [5]);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [], 'never asked for their own step');
  assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã hoàn thành'), [people.ap]);
  const log = await audit(body.prNo);
  assert.deepEqual(log.slice(-3).map((x) => [x.role, x.actor_email, x.extra.auto === true]),
    [['budget', people.treasurer, false], ['supplier', people.treasurer, false], ['purchasing', people.ap, true]]);
  await noStampCopies(body.prNo);
});

test('declined: submitted as today; the requester is emailed and approves by hand', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalDeclined: true }, T);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  assert.equal(r.autoApproved, undefined);
  const row = await pr(body.prNo);
  assert.equal(row.metadata.selfApproval, undefined);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [people.treasurer]);
  assert.doesNotMatch(await mailBody(body.prNo, 'Xác nhận gửi phiếu'), /tự động duyệt/);
  const a = await approve(body.prNo, people.treasurer, 'budget');
  assert.equal(a.success, true, a.message);
  assert.equal(a.status, 'Mua hàng (5/5)');
  assert.equal((await audit(body.prNo)).at(-1).extra.auto, undefined);
});

test('wrong password: asked again, nothing stored; same lockout counter as approvals', { skip }, async () => {
  await redis.del(failKey(people.treasurer), lockKey(people.treasurer));
  const T = as(people.treasurer);
  try {
    const body = submitBody(company, people);
    for (let i = 0; i < 4; i += 1) {
      const w = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: 'wrong' }, T);
      assert.deepEqual([w.needSelfApproval, w.message], [true, 'Mật khẩu không đúng.']);
    }
    assert.equal(await pr(body.prNo), undefined);
    const other = (await call(s.handlePRSubmit, submitBody(company, people), REQ)).prNo;
    assert.equal((await approve(other, people.treasurer, 'budget', 'wrong')).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
    const locked = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T);
    assert.deepEqual([locked.needSelfApproval, locked.message], [true, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.']);
    assert.equal(await pr(body.prNo), undefined);
  } finally { await redis.del(failKey(people.treasurer), lockKey(people.treasurer)); }
});

test('send-back to step 2 voids the consent: the requester re-approves by hand; a step-1 send-back + resubmit asks again', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T)).success, true);
  const back2 = await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'purchasing', targetStep: 2, sentBackNote: 'Xem lại' }, as(people.ap));
  assert.equal(back2.success, true, back2.message);
  let row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.deepEqual([row.metadata.budgetStatus, row.metadata.supplierStatus], ['Pending', 'Pending'], 'not auto-approved again');
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  assert.deepEqual(row.metadata.selfApproval.stamps, []);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu xem lại'), [people.treasurer], 'the requester is asked to re-review by hand');
  const back1 = await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'budget', targetStep: 1, sentBackNote: 'Bổ sung' }, T);
  assert.equal(back1.success, true, back1.message);
  const re = submitBody(company, people, { prNo: body.prNo });
  const ask = await call(s.handlePRResubmit, re, T);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true], 'the old consent is not reused');
  assert.equal((await pr(body.prNo)).status, 'Trả lại bổ sung');
  const r = await call(s.handlePRResubmit, { ...re, selfApprovalPassword: PW }, T);
  assert.equal(r.message, `Đã gửi lại đề nghị thành công. Đã tự động duyệt bước 2 (${BS}) của bạn.`);
  assert.deepEqual(r.autoApproved, [{ step: 2, labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  row = await pr(body.prNo);
  assert.equal(row.status, 'Mua hàng (5/5)');
  assert.equal(row.metadata.selfApproval.round, 2);
  assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã được cập nhật và gửi lại'), [], 'nobody left to ask at step 2');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap, people.ap], 'submit, then resubmit');
  assert.deepEqual((await audit(body.prNo)).slice(-3).map((a) => a.action), ['Resubmit', 'Approve', 'Approve']);
});

test('step-2 send-back with another supplier approver: both slots reset, the requester and the supplier approver are asked', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people, { supplierApprover: people.accountant });
  assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T)).success, true);
  assert.equal((await approve(body.prNo, people.accountant, 'supplier')).status, 'Mua hàng (5/5)');
  const back2 = await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'purchasing', targetStep: 2, sentBackNote: 'Xem lại' }, as(people.ap));
  assert.equal(back2.status, 'Đang duyệt ngân sách & NCC (2/5)');
  const row = await pr(body.prNo);
  assert.deepEqual([row.metadata.budgetStatus, row.metadata.supplierStatus], ['Pending', 'Pending']);
  assert.deepEqual(row.pending_emails, [people.treasurer, people.accountant]);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu xem lại'), [people.treasurer, people.accountant]);
});

test('declined resubmit: the resubmit emails are exactly today\'s (budget + supplier, requester included)', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people, { supplierApprover: people.accountant });
  assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalDeclined: true }, T)).success, true);
  assert.equal((await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'budget', targetStep: 1, sentBackNote: 'Sửa' }, T)).success, true);
  const r = await call(s.handlePRResubmit, { ...submitBody(company, people, { prNo: body.prNo, supplierApprover: people.accountant }), selfApprovalDeclined: true }, T);
  assert.equal(r.message, 'Đã gửi lại đề nghị thành công.');
  assert.equal(r.autoApproved, undefined);
  assert.equal((await pr(body.prNo)).metadata.selfApproval, undefined);
  assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã được cập nhật và gửi lại'), [people.treasurer, people.accountant]);
});

test('requester = purchasing whose sample changed after consenting: auto-approval stops; they are asked to buy by hand', { skip }, async () => {
  const P = as(people.ap);
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  const setSample = (u) => pool.query(`UPDATE employees SET extra = extra - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [people.ap, u]);
  try {
    await setSample('https://sig.test/self-v0.png');
    const body = submitBody(company, people);
    assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, P)).success, true);
    await setSample('https://sig.test/self-v1.png');
    const a = await approve(body.prNo, people.treasurer, 'budget');
    assert.equal(a.success, true, a.message);
    assert.equal(a.status, 'Mua hàng (5/5)', 'not auto-approved with a stale sample');
    const row = await pr(body.prNo);
    assert.equal(row.metadata.purchasingStatus, 'Pending');
    assert.deepEqual(row.pending_emails, [people.ap]);
    assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap], 'the normal email to the requester');
  } finally {
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
});

test('requester = budget + supplier + purchasing: completed at submit (completed + confirmation emails, no purchasing email)', { skip }, async () => {
  const { department } = (await pool.query(`SELECT department FROM employees WHERE LOWER(email) = $1`, [people.treasurer])).rows[0];
  await pool.query(`UPDATE employees SET department = 'Kế Toán Chi' WHERE LOWER(email) = $1`, [people.treasurer]);
  try {
    const T = as(people.treasurer);
    const body = submitBody(company, people, { purchasingApprover: people.treasurer });
    const ask = await call(s.handlePRSubmit, body, T);
    assert.deepEqual(ask.selfApproval.steps.map((x) => x.step), [2, 5]);
    const r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T);
    assert.equal(r.message, `Đề nghị mua hàng đã được gửi thành công. Đã tự động duyệt bước 2 (${BS}) và 5 (Người mua hàng) của bạn.`);
    const row = await pr(body.prNo);
    assert.equal(row.status, 'Hoàn thành');
    assert.deepEqual(row.pending_emails, []);
    assert.deepEqual(row.metadata.selfApproval.stamps, []);
    assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã hoàn thành'), [people.treasurer]);
    assert.deepEqual(await mailsTo(body.prNo, 'Xác nhận gửi phiếu'), [people.treasurer]);
    assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), []);
    assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), []);
  } finally {
    await pool.query(`UPDATE employees SET department = $2 WHERE LOWER(email) = $1`, [people.treasurer, department]);
  }
});

test('reject: final, the stored stamp copy is dropped and never reaches the Sheet copy', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T)).success, true);
  const rj = await withSheet(() => call(d.handlePRReject, { prNo: body.prNo, note: 'Không cần' }, as(people.ap)));
  assert.equal(rj.success, true, rj.message);
  assert.deepEqual((await pr(body.prNo)).metadata.selfApproval.stamps, []);
  await noStampCopies(body.prNo);
});
