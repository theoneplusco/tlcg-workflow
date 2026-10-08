// tests/vouchers/self-approval.test.js — Plan 5c on vouchers: the requester's own steps are auto-approved after one
// password at submit. Needs TEST_DATABASE_URL (master data imported) + Redis db 15, like handlers.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { failKey, lockKey } from '../../api/lib/approval/step-up.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
let h, pool, redis, saveVersion, company, people, cleanup;
const A = 'sa-a@x.vn';
const B = 'sa-b@x.vn';
const C = 'sa-c@x.vn';
const SIG = (e) => `https://drive/sample-${e}`;
const NOTE = (label) => `Tự động duyệt khi gửi phiếu (người đề nghị là ${label})`;

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
const newNo = () => `MI-PC20261008${String(800000 + ++seq).padStart(6, '0')}`;
const submitBody = (no, requestor, extra = {}) => ({
  email: { to: people.accountant, subject: `[PHÊ DUYỆT] Phiếu ${no}`, body: '<p>page body</p>', replyTo: 'sub@x.vn' },
  requesterEmail: { to: requestor, subject: `[THÔNG BÁO] Phiếu ${no}`, body: '<p>Phiếu đã được gửi phê duyệt</p>' },
  voucher: { voucherNumber: no, voucherType: 'Phiếu Chi', company: company.company_name, companyKey: company.company_key,
    employee: 'Người Lập', requestorEmail: requestor, amount: '1.000.000', reason: 'Tự duyệt', files: [] },
  ...extra,
});
const submitAs = async (no, who, extra = {}) => callAs(h.handleVoucherSubmit, submitBody(no, who, extra), await jwtFor(who));
const approve = async (no, who, password = PW) => callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverPassword: password } }, await jwtFor(who));
const voucher = async (no) => (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
const history = async (no) => (await pool.query(`SELECT status, action, note, approver_email, metadata FROM voucher_history WHERE voucher_number = $1 ORDER BY id`, [no])).rows;
const mails = async (no) => (await pool.query(`SELECT to_email, subject, body_html FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${no}%`])).rows;
const asked = async (no) => (await mails(no)).filter((m) => m.subject.startsWith('[PHÊ DUYỆT]')).map((m) => m.to_email);
const auditRows = async (no) => (await pool.query(`SELECT action, actor_email, note, extra FROM voucher_audit_log WHERE doc_no = $1 ORDER BY id`, [no])).rows;
const outbox = async (no) => (await pool.query(
  `SELECT tab, record FROM sheet_outbox WHERE record->>'voucher_number' = $1 OR record->>'voucherNumber' = $1 ORDER BY id`, [no])).rows;
const flow = (steps) => saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps });
const person = (email) => ({ type: 'person', email });

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet';
  h = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default;
  ({ saveVersion } = await import('../../api/lib/approval/flows-repo.js'));
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC20261008%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC20261008%';
                    DELETE FROM voucher_audit_log WHERE doc_no LIKE 'MI-PC20261008%';
                    TRUNCATE email_queue; TRUNCATE approval_flows; TRUNCATE sheet_outbox`);
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  people = { accountant: company.accountant_email.toLowerCase(), legal: company.legal_rep_email.toLowerCase(), treasurer: company.treasurer_email.toLowerCase() };
  cleanup = await useStepUp(pool, redis, [people.accountant, people.legal, people.treasurer, A, B, C]);
  for (const e of [A, B, C]) await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [e, SIG(e)]);
});
after(async () => {
  if (!pool) return;
  await pool.query(`TRUNCATE approval_flows`);
  if (cleanup) await cleanup();
  await pool.end();
  redis.quit?.();
});

test('requester = step 1 (default flow): asked once, nothing stored; with the password step 1 is auto-approved and stamped', { skip }, async () => {
  const no = newNo();
  const ask = await submitAs(no, people.accountant);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true]);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 1, key: 'chief_accountant', labels: ['Kế toán trưởng'] }]);
  assert.equal(ask.selfApproval.prompt, 'Bạn cũng là người duyệt bước 1 (Kế toán trưởng) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(ask.message, ask.selfApproval.prompt);
  assert.equal(await voucher(no), undefined, 'nothing stored before consent');
  const r = await submitAs(no, people.accountant, { selfApprovalPassword: PW });
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Kế toán trưởng) của bạn.');
  assert.deepEqual(r.autoApproved, [{ step: 1, labels: ['Kế toán trưởng'] }]);
  const v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.deepEqual(v.pending_emails, [people.legal]);
  assert.equal(v.metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url), 'registered sample stamped');
  assert.deepEqual(Object.values(v.metadata.signatureVerification).map((x) => [x.verified, x.method]), [[true, 'password']]);
  assert.equal(v.metadata.selfApproval.by, people.accountant);
  assert.deepEqual(v.metadata.selfApproval.auto.map((x) => x.step), [1]);
  assert.deepEqual(v.metadata.selfApproval.stamps, [], 'no own step left: the stamp copy is dropped');
  const hist = await history(no);
  assert.deepEqual(hist.map((x) => [x.status, x.note]), [['Đang treo', 'Gửi phê duyệt'], ['Đang duyệt (1/3)', NOTE('Kế toán trưởng')]]);
  assert.match(hist[1].action, /^Duyệt bởi /);
  assert.ok(hist.every((x) => !JSON.stringify(x.metadata.selfApproval || {}).includes('data:')), 'history rows never carry the stamp copy');
  const log = await auditRows(no);
  assert.deepEqual(log.map((a) => [a.action, a.actor_email, a.note]), [['Submit', people.accountant, 'Tự duyệt'], ['Approve', people.accountant, NOTE('Kế toán trưởng')]]);
  assert.deepEqual([log[1].extra.auth, log[1].extra.auto, log[1].extra.signatureStamped], ['password', true, true]);
  const ob = await outbox(no);
  assert.deepEqual(ob.filter((o) => o.tab === 'Voucher_Current').map((o) => o.record.approvalProgress), [0, 1], 'auto-approval mirrored like any approval');
  assert.deepEqual(ob.filter((o) => o.tab === 'Voucher_History').map((o) => o.record.note), ['Gửi phê duyệt', NOTE('Kế toán trưởng')]);
  assert.deepEqual(await asked(no), [people.legal], 'no "please approve" email to the requester');
  const conf = (await mails(no)).find((m) => m.subject.startsWith('[THÔNG BÁO]'));
  assert.equal(conf.to_email, people.accountant);
  assert.match(conf.body_html, /Đã gửi email đến .+ để tiếp tục phê duyệt\./);
  assert.match(conf.body_html, /Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu \(đã xác nhận bằng mật khẩu\): bước 1 \(Kế toán trưởng\)\./);
  // A second submit of the same number is refused before any password is checked
  const dup = await submitAs(no, people.accountant, { selfApprovalPassword: 'wrong' });
  assert.match(dup.message, /đã được gửi trước đó/);
  assert.equal(await redis.get(failKey(people.accountant)), null, 'no password checked for a duplicate');
});

test('requester = step 2: nothing at submit; the step-1 approval auto-approves step 2 in the same commit; step 3 is asked', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    assert.equal((await submitAs(no, B)).selfApproval.prompt,
      'Bạn cũng là người duyệt bước 2 (Phê duyệt) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công', 'nothing auto-approved yet: step 1 is another approver');
    assert.equal(r.autoApproved, undefined);
    let v = await voucher(no);
    assert.equal(v.status, 'Đang treo');
    assert.deepEqual(v.metadata.selfApproval.steps, [{ step: 2, key: 'person', labels: ['Phê duyệt'] }]);
    const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(A));
    assert.equal(JSON.stringify(ctx.data.voucher.meta).includes('data:image'), false, 'the stamp copy is not sent to pages');
    const a = await approve(no, A);
    assert.equal(a.success, true, a.message);
    assert.equal(a.message, `Đã phê duyệt thành công. Đã gửi email đến ${C} để tiếp tục phê duyệt.`);
    v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (2/3)');
    assert.deepEqual(v.pending_emails, [C]);
    assert.equal(v.metadata.approvalPlan.steps[1].approvers[0].signature, FAKE_STAMP(SIG(B)));
    assert.deepEqual((await history(no)).slice(1).map((x) => [x.approver_email, x.note]),
      [[A, 'Đã duyệt bởi Người duyệt (1/3)'], [B, NOTE('Phê duyệt')]]);
    assert.deepEqual(await asked(no), [A, C], 'never the requester');
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('requester = steps 1 and 3: step 1 at submit, step 3 right after step 2; the plan finishes', { skip }, async () => {
  await flow([{ name: 'Lập', approvers: [person(B)] }, { name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Chi tiền', approvers: [person(B)] }]);
  try {
    const no = newNo();
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Lập) của bạn.');
    let v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/3)');
    assert.equal(v.metadata.selfApproval.stamps.length, 1, 'step 3 still to come: stamp kept');
    const a = await approve(no, A);
    assert.equal(a.message, 'Đã phê duyệt thành công. Phiếu đã được duyệt hoàn toàn.');
    v = await voucher(no);
    assert.equal(v.status, 'Đã duyệt');
    assert.deepEqual(v.metadata.selfApproval.auto.map((x) => x.step), [1, 3]);
    assert.deepEqual(v.metadata.selfApproval.stamps, []);
    const subjects = (await mails(no)).map((m) => m.subject);
    assert.ok(subjects.includes(`[ĐÃ DUYỆT HOÀN TOÀN] Phiếu ${no}`));
    assert.deepEqual(await asked(no), [A]);
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('group step: only the requester entry is auto-approved; the step waits for the other member', { skip }, async () => {
  await flow([{ name: 'Nhóm', approvers: [person(B), person(A)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Nhóm) của bạn.');
    let v = await voucher(no);
    assert.equal(v.status, 'Đang treo', 'step 1 not done yet');
    assert.deepEqual(v.metadata.approvalPlan.steps[0].approvers.map((x) => [x.email, x.status]), [[B, 'approved'], [A, 'pending']]);
    assert.deepEqual(v.pending_emails, [A]);
    assert.deepEqual(await asked(no), [A]);
    assert.equal((await approve(no, A)).message, `Đã phê duyệt thành công. Đã gửi email đến ${C} để tiếp tục phê duyệt.`);
    v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/2)');
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('cancel path: declined → submitted as today; the requester is asked by email and approves by hand', { skip }, async () => {
  const no = newNo();
  const r = await submitAs(no, people.accountant, { selfApprovalDeclined: true });
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công');
  let v = await voucher(no);
  assert.equal(v.status, 'Đang treo');
  assert.equal(v.metadata.selfApproval, undefined);
  assert.deepEqual(await asked(no), [people.accountant], 'today: the page email to step 1');
  const a = await approve(no, people.accountant);
  assert.equal(a.success, true, a.message);
  v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.equal((await history(no)).pop().note, 'Đã duyệt bởi Kế toán trưởng (1/3)');
});

test('wrong password: asked again, nothing stored; the counter is the approval lockout (5th wrong anywhere locks)', { skip }, async () => {
  await redis.del(failKey(people.accountant), lockKey(people.accountant));
  try {
    const no = newNo();
    for (let i = 0; i < 4; i += 1) {
      const w = await submitAs(no, people.accountant, { selfApprovalPassword: 'wrong' });
      assert.deepEqual([w.success, w.needSelfApproval, w.message], [false, true, 'Mật khẩu không đúng.']);
    }
    assert.equal(await voucher(no), undefined);
    const other = newNo();
    assert.equal((await callAs(h.handleVoucherSubmit, submitBody(other, 'sub@x.vn'))).success, true, 'no token: submitted as today');
    assert.equal((await approve(other, people.accountant, 'wrong')).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
    const locked = await submitAs(no, people.accountant, { selfApprovalPassword: PW });
    assert.deepEqual([locked.needSelfApproval, locked.message], [true, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.']);
    assert.equal(await voucher(no), undefined);
  } finally { await redis.del(failKey(people.accountant), lockKey(people.accountant)); }
});

test('no prompt without a token: consent needs a signed-in submitter (never a body email)', { skip }, async () => {
  const noToken = newNo();
  const r1 = await callAs(h.handleVoucherSubmit, submitBody(noToken, people.accountant, { selfApprovalPassword: PW }));
  assert.equal(r1.message, 'Đã gửi yêu cầu phê duyệt thành công');
  const v = await voucher(noToken);
  assert.equal(v.status, 'Đang treo');
  assert.equal(v.metadata.selfApproval, undefined);
  assert.deepEqual(await asked(noToken), [people.accountant], 'the approver named on the form is emailed as today');
});

test('filing for someone else (decision 1): the signed-in submitter\'s own steps are prompted; consent is theirs', { skip }, async () => {
  const onBehalf = newNo();
  const ask = await callAs(h.handleVoucherSubmit, submitBody(onBehalf, 'sub@x.vn'), await jwtFor(people.accountant));
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true]);
  assert.deepEqual(ask.selfApproval.steps.map((s) => s.step), [1]);
  assert.equal(await voucher(onBehalf), undefined);
  const r = await callAs(h.handleVoucherSubmit, submitBody(onBehalf, 'sub@x.vn', { selfApprovalPassword: PW }), await jwtFor(people.accountant));
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Kế toán trưởng) của bạn.');
  const v = await voucher(onBehalf);
  assert.equal(v.requestor_email, 'sub@x.vn');
  assert.equal(v.metadata.submittedByEmail, people.accountant, 'the token email, not the form requestor');
  assert.deepEqual([v.metadata.selfApproval.by, v.metadata.selfApproval.ref], [people.accountant, onBehalf]);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.equal((await history(onBehalf)).pop().note, NOTE('Kế toán trưởng'));
  assert.deepEqual(await asked(onBehalf), [people.legal]);

  // A signed-in submitter who holds no step: no prompt, submitted as today (the requester on the form is not asked)
  const plain = newNo();
  const r2 = await callAs(h.handleVoucherSubmit, submitBody(plain, people.accountant), await jwtFor(C));
  assert.equal(r2.success, true, r2.message);
  assert.equal(r2.needSelfApproval, undefined);
  assert.equal((await voucher(plain)).metadata.selfApproval, undefined);
  assert.deepEqual(await asked(plain), [people.accountant]);
});

test('a stored consent is ignored when it does not match the recorded submitter or the voucher number', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    assert.equal((await submitAs(no, B, { selfApprovalPassword: PW })).success, true);
    await pool.query(`UPDATE vouchers SET metadata = jsonb_set(metadata, '{selfApproval,ref}', '"MI-OTHER"') WHERE voucher_number = $1`, [no]);
    assert.equal((await approve(no, A)).success, true);
    const v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/3)', 'step 2 waits for B by hand');
    assert.deepEqual(v.pending_emails, [B]);
    assert.deepEqual(await asked(no), [A, B]);
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('the sample changed after consent: the step waits for the requester by hand (and they are emailed)', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    await submitAs(no, B, { selfApprovalPassword: PW });
    await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sample-new') WHERE LOWER(email) = $1`, [B]);
    assert.equal((await approve(no, A)).success, true);
    let v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/3)');
    assert.deepEqual(v.pending_emails, [B]);
    assert.deepEqual(await asked(no), [A, B]);
    assert.equal((await approve(no, B)).success, true);
    v = await voucher(no);
    assert.equal(v.metadata.approvalPlan.steps[1].approvers[0].signature, FAKE_STAMP('https://drive/sample-new'));
  } finally {
    await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [B, SIG(B)]);
    await pool.query(`TRUNCATE approval_flows`);
  }
});

test('bulk approve: each voucher auto-advances the requester step; one batch email to the approver after it', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const nos = [newNo(), newNo()];
    for (const no of nos) assert.equal((await submitAs(no, B, { selfApprovalPassword: PW })).success, true);
    const r = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverPassword: PW }, await jwtFor(A));
    assert.deepEqual(r.data.approved, nos);
    for (const no of nos) assert.equal((await voucher(no)).status, 'Đang duyệt (2/3)');
    const batch = (await pool.query(`SELECT to_email, body_html FROM email_queue WHERE subject LIKE '[PHÊ DUYỆT HÀNG LOẠT]%' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(batch.to_email, C);
    assert.ok(nos.every((no) => batch.body_html.includes(no)));
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});
