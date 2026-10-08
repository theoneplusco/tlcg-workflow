// tests/purchase-requests/decide.test.js — approve / reject / send back / resubmit on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { sampleSignatureFor } from '../../api/lib/approval/signature-check.js';
import { stampDeps, clearStampCache } from '../../api/lib/approval/step-up.js';

let s, d, pool, company, people, redis, cleanupStepUp;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.treasurer, people.accountant, people.legal, people.ap, 'req@pr-test.vn', 'stranger@x.vn']);
});
after(async () => { if (cleanupStepUp) await cleanupStepUp(); await teardown(pool); });

const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mailsTo = async (no, subjectPart) => (await pool.query(
  `SELECT to_email FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${subjectPart}%${no}`])).rows.map((r) => r.to_email);
const submit = async (over = {}) => (await call(s.handlePRSubmit, submitBody(company, people, over), REQ)).prNo;
const approve = (no, who, role, extra = {}) => call(d.handlePRApprove, { prNo: no, approverRole: role, note: '', approverPassword: PW, ...extra }, as(who));

test('approve: the shared budget/supplier approver approves once; purchasing emailed on a simplified PR (B2)', { skip }, async () => {
  const no = await submit();
  const r = await approve(no, people.treasurer, 'budget');
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã duyệt thành công.');
  assert.equal(r.status, 'Mua hàng (5/5)');
  assert.equal(r.data.status, 'Mua hàng (5/5)', 'page reads result.data.status (B8)');
  const row = await pr(no);
  assert.equal(row.metadata.supplierStatus, 'Approved');
  const sample = (await sampleSignatureFor(pool, company.id, null, people.treasurer)).url;
  assert.equal(row.metadata.budgetSignature, FAKE_STAMP(sample), 'the registered sample is stamped on both slots');
  assert.equal(row.metadata.supplierSignature, FAKE_STAMP(sample));
  assert.deepEqual([row.metadata.budgetSignatureVerification.verified, row.metadata.budgetSignatureVerification.method], [true, 'password']);
  assert.deepEqual(row.metadata.supplierSignatureVerification, row.metadata.budgetSignatureVerification);
  assert.deepEqual(row.pending_emails, [people.ap]);
  const audit = (await pool.query(`SELECT role, extra FROM pr_audit_log WHERE doc_no = $1 AND action = 'Approve' ORDER BY id`, [no])).rows;
  assert.deepEqual(audit.map((a) => a.role), ['budget', 'supplier']);
  assert.deepEqual([audit[0].extra.auth, audit[0].extra.signatureStamped], ['password', true]);
  assert.deepEqual(audit[1].extra, audit[0].extra, 'both slots audited the same way');
  assert.equal(JSON.stringify(audit[0].extra).includes(PW), false, 'the password is never stored');
  assert.deepEqual(await mailsTo(no, 'Yêu cầu Mua hàng'), [people.ap]);
});

test('approve: purchasing completes; requester told; nobody pending', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'supplier');
  const r = await approve(no, people.ap, 'purchasing');
  assert.equal(r.status, 'Hoàn thành');
  assert.deepEqual((await pr(no)).pending_emails, []);
  assert.deepEqual(await mailsTo(no, 'Phiếu đã hoàn thành'), ['req@pr-test.vn']);
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Đề nghị này đã được duyệt rồi.');
});

test('approve: turn, assignment, role and identity checks', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
  assert.equal((await approve(no, 'stranger@x.vn', 'budget')).message, 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
  assert.equal((await approve(no, people.treasurer, 'boss')).message, 'Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".');
  assert.equal((await approve(no, people.treasurer, 'budget', { approverEmail: people.ap })).message,
    `Bạn đang đăng nhập bằng ${people.treasurer}, không thể thao tác thay ${people.ap}.`);
  assert.equal((await approve('EV-PR19990101000001', people.treasurer, 'budget')).message, 'Không tìm thấy đề nghị: EV-PR19990101000001');
  assert.equal((await call(d.handlePRApprove, { prNo: no, approverRole: 'budget' }, null)).code, 401);
});

test('reject: requester emailed (B13); a second reject and an approve are refused', { skip }, async () => {
  const no = await submit();
  const r = await call(d.handlePRReject, { prNo: no, note: 'Giá cao' }, as(people.treasurer));
  assert.deepEqual([r.success, r.message, r.status], [true, 'Đã từ chối thành công.', 'Đã từ chối']);
  const row = await pr(no);
  assert.equal(row.metadata.rejectionNote, 'Giá cao');
  assert.deepEqual(row.pending_emails, []);
  assert.deepEqual(await mailsTo(no, 'Phiếu bị từ chối'), ['req@pr-test.vn']);
  assert.equal((await call(d.handlePRReject, { prNo: no }, as(people.treasurer))).message, 'Đề nghị này đã bị từ chối rồi.');
  assert.equal((await approve(no, people.treasurer, 'budget')).message, 'Đề nghị này đã bị từ chối, không thể duyệt.');
});

test('reject: someone not on the PR has no right', { skip }, async () => {
  const no = await submit();
  assert.equal((await call(d.handlePRReject, { prNo: no }, as('stranger@x.vn'))).message, 'Bạn không có quyền từ chối đề nghị này.');
});

test('send back step 1 → returned to the requester, who is emailed; approvals blocked', { skip }, async () => {
  const no = await submit();
  const r = await call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Thiếu báo giá' }, as(people.treasurer));
  assert.deepEqual([r.success, r.status], [true, 'Trả lại bổ sung']);
  assert.deepEqual((await pr(no)).pending_emails, ['req@pr-test.vn']);
  assert.deepEqual(await mailsTo(no, 'Phiếu được trả lại để bổ sung'), ['req@pr-test.vn']);
  assert.equal((await approve(no, people.treasurer, 'budget')).message, 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.');
});

test('send back step 2 by purchasing resets the chain; step 3 refused (B3); note required', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const bad = await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 3, sentBackNote: 'x' }, as(people.ap));
  assert.equal(bad.message, 'Bước trả lại không hợp lệ với vai trò của bạn.');
  assert.equal((await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 2, sentBackNote: '' }, as(people.ap))).message, 'Vui lòng nhập lý do trả lại.');
  const r = await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 2, sentBackNote: 'Sai NCC' }, as(people.ap));
  assert.equal(r.status, 'Đang duyệt ngân sách & NCC (2/5)');
  const row = await pr(no);
  assert.equal(row.metadata.budgetStatus, 'Pending');
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  assert.deepEqual(await mailsTo(no, 'Bước Ngân sách & NCC'), [people.treasurer]);
  const ret = (await pool.query(`SELECT role, extra FROM pr_audit_log WHERE doc_no = $1 AND action = 'Return'`, [no])).rows;
  assert.deepEqual(ret.map((x) => [x.role, x.extra.targetStep]), [['purchasing', 2]]);
});

test('resubmit works from the page even with a new client submittedAt (B1); history kept; approvals cleared', { skip }, async () => {
  const no = await submit();
  await call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Thêm báo giá' }, as(people.treasurer));
  const body = submitBody(company, people, { prNo: no, purpose: 'Mua khăn giấy (đã bổ sung)', submittedAt: new Date().toISOString(),
    attachments: [{ fileName: 'bao-gia.pdf', fileData: Buffer.from('%PDF').toString('base64'), mimeType: 'application/pdf' }] });
  const other = await call(s.handlePRResubmit, body, as('other@pr-test.vn'));
  assert.equal(other.message, 'Bạn không phải người đề nghị ban đầu của phiếu này.');
  const sent = [];
  const r = await call(s.handlePRResubmit, body, REQ, { s3: { send: async (c) => { sent.push(c.input.Key); } } });
  assert.deepEqual([r.success, r.message, r.prNo], [true, 'Đã gửi lại đề nghị thành công.', no]);
  const row = await pr(no);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.equal(row.purpose, 'Mua khăn giấy (đã bổ sung)');
  assert.equal(row.metadata.resubmitCount, 1);
  assert.equal(row.metadata.sentBackHistory.length, 1);
  assert.equal(row.metadata.budgetStatus, 'Pending');
  assert.equal(row.attachments.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(await mailsTo(no, 'Phiếu đã được cập nhật và gửi lại'), [people.treasurer]);
  const audit = (await pool.query(`SELECT note FROM pr_audit_log WHERE doc_no = $1 AND action = 'Resubmit'`, [no])).rows;
  assert.deepEqual(audit.map((a) => a.note), ['Gửi lại lần 1']);
  assert.equal((await call(s.handlePRResubmit, body, REQ)).message, 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".');
});

const PDF = (name) => ({ fileName: name, fileData: Buffer.from('%PDF').toString('base64'), mimeType: 'application/pdf' });
const NO_SAMPLE = 'Chưa có chữ ký mẫu của bạn (hoặc không tải được). Vui lòng tải chữ ký trong Hồ sơ của tôi (My Profile) hoặc nhờ quản trị viên.';
const LOCKED = 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.';
const auditCount = async (no) => (await pool.query(`SELECT COUNT(*)::int AS n FROM pr_audit_log WHERE doc_no = $1 AND action = 'Approve'`, [no])).rows[0].n;

test('approve: password required, wrong one refused, 5th wrong locks; nothing approved meanwhile', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: '' })).message, 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.');
  for (let i = 0; i < 4; i += 1) assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: 'x' })).message, 'Mật khẩu không đúng.');
  assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: 'x' })).message, LOCKED);
  assert.equal((await approve(no, people.treasurer, 'budget')).message, LOCKED, 'the right password is refused while locked');
  assert.equal((await pr(no)).metadata.budgetStatus, 'Pending');
  await redis.del(`stepup:fail:${people.treasurer}`, `stepup:lock:${people.treasurer}`);
  assert.equal((await approve(no, people.treasurer, 'budget')).success, true);
});

test('approve: a wrong password writes nothing and never loads the sample', { skip }, async () => {
  const no = await submit();
  const before = await pr(no);
  let fetches = 0;
  const saved = stampDeps.fetchImage;
  try {
    stampDeps.fetchImage = async (u) => { fetches += 1; return FAKE_STAMP(u); };
    clearStampCache();
    const r = await approve(no, people.treasurer, 'budget', { approverPassword: 'wrong' });
    assert.deepEqual([r.success, r.message], [false, 'Mật khẩu không đúng.']);
  } finally { stampDeps.fetchImage = saved; clearStampCache(); await redis.del(`stepup:fail:${people.treasurer}`); }
  const after = await pr(no);
  assert.deepEqual([after.status, after.metadata, after.updated_at], [before.status, before.metadata, before.updated_at]);
  assert.equal(await auditCount(no), 0);
  assert.equal(fetches, 0);
});

test('approve: the password belongs to the token caller; a body approverEmail cannot borrow someone else\'s', { skip }, async () => {
  const no = await submit();
  // The treasurer's token with the AP's email in the body: refused before any password check (no counter touched)
  const r = await approve(no, people.treasurer, 'budget', { approverEmail: people.ap, approverPassword: 'x' });
  assert.equal(r.message, `Bạn đang đăng nhập bằng ${people.treasurer}, không thể thao tác thay ${people.ap}.`);
  assert.equal(await redis.get(`stepup:fail:${people.ap}`), null);
  assert.equal(await redis.get(`stepup:fail:${people.treasurer}`), null);
  assert.equal((await call(d.handlePRApprove, { prNo: no, approverRole: 'budget', approverPassword: PW }, null)).code, 401);
});

test('approve: an approver with no registered sample is refused (ask an admin)', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  try {
    await pool.query(`UPDATE employees SET extra = extra - 'Signature' - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' WHERE LOWER(email) = $1`, [people.ap]);
    const r = await approve(no, people.ap, 'purchasing');
    assert.deepEqual([r.success, r.message], [false, NO_SAMPLE]);
    assert.equal((await pr(no)).status, 'Mua hàng (5/5)', 'unchanged');
  } finally {
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
  const ok = await approve(no, people.ap, 'purchasing');
  assert.deepEqual([ok.success, ok.status], [true, 'Hoàn thành'], ok.message);
});

test('approve: the business rules answer before the stamp (not your turn is not a sample problem)', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
});

test('approve: the sample loads before the PR row lock, once; an unreachable or oversized one refuses with NO_SAMPLE', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  const saved = stampDeps.fetchImage;
  let fetches = 0;
  const lockedDuringFetch = [];
  const lockFree = async () => {
    try { await pool.query(`SELECT 1 FROM purchase_requests WHERE pr_no = $1 FOR UPDATE NOWAIT`, [no]); } catch (e) { lockedDuringFetch.push(e.code); }
  };
  try {
    await pool.query(`UPDATE employees SET extra = extra - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' || '{"Signature":"https://sig.test/ap-broken.png"}'::jsonb WHERE LOWER(email) = $1`, [people.ap]);
    stampDeps.fetchImage = async () => { fetches += 1; await lockFree(); throw new Error('unreachable'); };
    clearStampCache();
    const err = console.error; console.error = () => {};
    let r;
    try { r = await approve(no, people.ap, 'purchasing'); } finally { console.error = err; }
    assert.deepEqual([r.success, r.message], [false, NO_SAMPLE]);
    assert.equal(fetches, 1);
    assert.equal((await pr(no)).status, 'Mua hàng (5/5)', 'unchanged');
    // Oversized (> 750 KB decoded) → NO_SAMPLE too; the 500 KB client-signature limit does not apply to the stamp
    const big = 'data:image/png;base64,' + Buffer.alloc(768001).toString('base64');
    stampDeps.fetchImage = async () => { fetches += 1; await lockFree(); return big; };
    clearStampCache();
    console.error = () => {};
    try { r = await approve(no, people.ap, 'purchasing'); } finally { console.error = err; }
    assert.deepEqual([r.success, r.message], [false, NO_SAMPLE]);
    // A 700 KB sample (over the 500 KB client limit, within the 750 KB stamp limit) is stamped
    const large = 'data:image/png;base64,' + Buffer.alloc(700 * 1024).toString('base64');
    stampDeps.fetchImage = async () => { fetches += 1; await lockFree(); return large; };
    clearStampCache();
    const ok = await approve(no, people.ap, 'purchasing');
    assert.deepEqual([ok.success, ok.status], [true, 'Hoàn thành'], ok.message);
    assert.equal((await pr(no)).metadata.purchasingSignature, large);
    assert.equal(fetches, 3);
    assert.deepEqual(lockedDuringFetch, [], 'no PR row lock held while the sample loads');
    const audit = (await pool.query(`SELECT extra FROM pr_audit_log WHERE doc_no = $1 AND action = 'Approve' AND role = 'purchasing'`, [no])).rows;
    assert.deepEqual(audit.map((a) => [a.extra.auth, a.extra.signatureStamped, a.extra.sampleFrom]), [['password', true, 'Master Employee']]);
  } finally {
    stampDeps.fetchImage = saved;
    clearStampCache();
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
});

test('approve: a sample changed while it loaded is never stamped stale (retried once, then NO_SAMPLE)', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  const saved = stampDeps.fetchImage;
  const setSample = (u) => pool.query(`UPDATE employees SET extra = extra - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [people.ap, u]);
  try {
    // Changes once while loading: the second attempt stamps the new sample
    let n = 0;
    await setSample('https://sig.test/v0.png');
    stampDeps.fetchImage = async (u) => { n += 1; if (n === 1) await setSample('https://sig.test/v1.png'); return FAKE_STAMP(u); };
    clearStampCache();
    const ok = await approve(no, people.ap, 'purchasing');
    assert.equal(ok.success, true, ok.message);
    assert.equal((await pr(no)).metadata.purchasingSignature, FAKE_STAMP('https://sig.test/v1.png'), 'the current sample, not the stale one');
    assert.equal(n, 2);
    // Changes on every load: refused, nothing written
    const no2 = await submit();
    await approve(no2, people.treasurer, 'budget');
    let m = 0;
    stampDeps.fetchImage = async (u) => { m += 1; await setSample(`https://sig.test/w${m}.png`); return FAKE_STAMP(u); };
    clearStampCache();
    const r = await approve(no2, people.ap, 'purchasing');
    assert.deepEqual([r.success, r.message], [false, NO_SAMPLE]);
    assert.equal(m, 2, 'one retry');
    assert.equal((await pr(no2)).metadata.purchasingStatus, 'Pending');
  } finally {
    stampDeps.fetchImage = saved;
    clearStampCache();
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
});

test('approve: a requester with no slot on the PR cannot approve it', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, 'req@pr-test.vn', 'budget')).message, 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
});

test('resubmit: picks off the company list are refused; the token decides who the requester is', { skip }, async () => {
  const no = await submit();
  await call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Sửa' }, as(people.treasurer));
  const self = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, budgetApprover: 'req@pr-test.vn' }), REQ);
  assert.match(self.message, /^Người phê duyệt ngân sách \(req@pr-test\.vn\) không thuộc danh sách/);
  const claim = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, requesterEmail: 'boss@pr-test.vn' }), REQ);
  assert.equal(claim.message, 'Bạn đang đăng nhập bằng req@pr-test.vn, không thể thao tác thay boss@pr-test.vn.');
  assert.equal((await call(s.handlePRResubmit, submitBody(company, people, { prNo: '' }), REQ)).message, 'Thiếu số phiếu mua hàng.');
  assert.equal((await call(s.handlePRResubmit, submitBody(company, people, { prNo: 'EV-PR19990101000009' }), REQ)).message,
    'Không tìm thấy đề nghị: EV-PR19990101000009');
  assert.equal((await call(s.handlePRResubmit, submitBody(company, people, { prNo: no }), null)).code, 401);
  assert.equal((await pr(no)).status, 'Trả lại bổ sung');
});

test('resubmit keeps the files already on the PR and adds the new ones (decision #7); server totals; approvals and signatures cleared', { skip }, async () => {
  const s3 = { send: async () => {} };
  const body0 = submitBody(company, people, { attachments: [PDF('cu.pdf')] });
  const no = (await call(s.handlePRSubmit, body0, REQ, { s3 })).prNo;
  await approve(no, people.treasurer, 'budget');
  await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 1, sentBackNote: 'Thêm' }, as(people.ap));
  const firstSubmittedAt = (await pr(no)).metadata.submittedAt;
  const items = JSON.stringify([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Khăn giấy', qty: '10', unit: 'Cái', price: '29900', total: '1', note: '' }]);
  const r = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, items, grandTotal: 1, attachments: [PDF('moi.pdf')] }), REQ, { s3 });
  assert.equal(r.success, true, r.message);
  const row = await pr(no);
  assert.deepEqual(row.attachments.map((a) => a.fileName), ['cu.pdf', 'moi.pdf']);
  assert.deepEqual(row.metadata.attachments.map((a) => a.fileName), ['cu.pdf', 'moi.pdf']);
  assert.equal(Number(row.grand_total), 299000, 'qty × price on the server, not the client total');
  assert.equal(row.items[0].total, 299000);
  assert.equal(row.metadata.supplierStatus, 'Pending');
  assert.equal(row.metadata.budgetSignature, undefined, 'old approver signatures dropped');
  assert.equal(row.metadata.submittedAt, firstSubmittedAt, 'original submittedAt kept');
  assert.ok(row.metadata.resubmittedAt);
  assert.deepEqual(row.pending_emails, [people.treasurer]);
});

const sendBack1 = (no) => call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Sửa' }, as(people.treasurer));
const counting = () => { const sent = []; return { sent, s3: { send: async (c) => { sent.push(c.input.Key); } } }; };

test('resubmit: nothing is uploaded to R2 for a non-owner or a PR that is not returned', { skip }, async () => {
  const no = await submit();
  const files = { attachments: [PDF('x.pdf')] };
  const a = counting();
  const notReturned = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, ...files }), REQ, { s3: a.s3 });
  assert.equal(notReturned.message, 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".');
  assert.equal(a.sent.length, 0, 'no upload for a PR that is not returned');
  await sendBack1(no);
  const b = counting();
  const other = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, ...files }), as('other@pr-test.vn'), { s3: b.s3 });
  assert.equal(other.message, 'Bạn không phải người đề nghị ban đầu của phiếu này.');
  assert.equal(b.sent.length, 0, 'no upload for someone who is not the requester');
});

test('resubmit fails closed when the PR has no requester email', { skip }, async () => {
  const no = await submit();
  await sendBack1(no);
  await pool.query(`UPDATE purchase_requests SET requester_email = '', metadata = metadata - 'requesterEmail' WHERE pr_no = $1`, [no]);
  const c = counting();
  const r = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no, attachments: [PDF('x.pdf')] }), REQ, { s3: c.s3 });
  assert.deepEqual([r.success, r.message], [false, 'Bạn không phải người đề nghị ban đầu của phiếu này.']);
  assert.equal(c.sent.length, 0);
  assert.equal((await pr(no)).status, 'Trả lại bổ sung');
});

test('resubmit: no submittedAt anywhere on the row → the current time, not 1970 or a crash', { skip }, async () => {
  const no = await submit();
  await sendBack1(no);
  await pool.query(`UPDATE purchase_requests SET submitted_at = NULL, metadata = metadata - 'submittedAt' WHERE pr_no = $1`, [no]);
  const at = new Date('2026-10-07T03:04:05.000Z');
  const r = await call(s.handlePRResubmit, submitBody(company, people, { prNo: no }), REQ, { now: () => at });
  assert.equal(r.success, true, r.message);
  assert.equal((await pr(no)).metadata.submittedAt, at.toISOString());
});
test('Sheet copy: one approval covering budget + supplier queues one PR upsert and two audit appends', { skip }, async () => {
  const no = await submit();
  const saved = process.env.P2P_SPREADSHEET_ID;
  process.env.P2P_SPREADSHEET_ID = 'p2p-test';
  try {
    assert.equal((await approve(no, people.treasurer, 'budget')).success, true);
  } finally { if (saved === undefined) delete process.env.P2P_SPREADSHEET_ID; else process.env.P2P_SPREADSHEET_ID = saved; }
  const ob = (await pool.query(
    `SELECT spreadsheet_id, tab, mode, key_column, record FROM sheet_outbox
     WHERE record->>'pr_no' = $1 OR record->>'document_no' = $1 ORDER BY id`, [no])).rows;
  assert.deepEqual(ob.map((o) => [o.spreadsheet_id, o.tab, o.mode, o.key_column]), [
    ['p2p-test', 'Purchase_Request_History', 'upsert', 'pr_no,row_type'],
    ['p2p-test', 'PR_Audit_Log', 'append', null], ['p2p-test', 'PR_Audit_Log', 'append', null]]);
  assert.equal(ob[0].record.status, 'Mua hàng (5/5)');
  assert.deepEqual(ob.slice(1).map((o) => [o.record.action, o.record.role]), [['Approve', 'budget'], ['Approve', 'supplier']]);
});
