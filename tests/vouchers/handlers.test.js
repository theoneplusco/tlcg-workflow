// Integration tests for the voucher write actions. Need TEST_DATABASE_URL (a
// throwaway DB with schema + migrations 001-005 + master data imported) and a
// local Redis (REDIS_URL, db 15 recommended).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
let h, pool, saveVersion, company, people;

const call = (fn, body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: {} }, res)).catch(reject);
});
const ok = { verified: true, similarity: 92, reason: 'ok' };
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
const approve = (no, email, extra = {}) => call(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverEmail: email, approverSignature: 'data:sig', signatureVerification: ok, ...extra } });

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  h = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  ({ saveVersion } = await import('../../api/lib/approval/flows-repo.js'));
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC20261007%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC20261007%';
                    TRUNCATE email_queue; TRUNCATE approval_flows`);
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  people = { accountant: company.accountant_email.toLowerCase(), legal: company.legal_rep_email.toLowerCase(), treasurer: company.treasurer_email.toLowerCase() };
});
after(async () => {
  if (!pool) return;
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

test('approve: signature rules, order, already-approved, then progress + next-step email', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  assert.match((await approve(no, people.accountant, { signatureVerification: undefined })).message, /Thiếu dữ liệu xác thực chữ ký/);
  assert.match((await approve(no, people.accountant, { signatureVerification: { verified: false, reason: 'mismatch', similarity: 40 } })).message, /Chữ ký không hợp lệ/);
  assert.match((await approve(no, 'stranger@x.vn')).message, /Không tìm thấy thông tin người phê duyệt/);
  if (people.legal !== people.accountant) assert.match((await approve(no, people.legal)).message, /Vui lòng đợi/);
  const r = await approve(no, people.accountant);
  assert.equal(r.success, true, r.message);
  assert.match(r.message, /Đã gửi email đến/);
  assert.match((await approve(no, people.accountant)).message, /đã phê duyệt phiếu này rồi/);
  const v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.equal(v.metadata.accountantSignature, 'data:sig');
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
  assert.equal(v.metadata.treasurerSignature, 'data:sig');
  assert.equal(v.metadata.approverSignature, 'data:sig', 'print-template alias');
  const ack = await call(h.handleVoucherAcknowledge, { voucherNumber: no, requesterEmail: 'sub@x.vn', requesterName: 'Người Lập', requesterSignature: 'data:ack' });
  assert.equal(ack.success, true, ack.message);
  assert.match((await call(h.handleVoucherAcknowledge, { voucherNumber: no, requesterSignature: 'x' })).message, /đã được xác nhận nhận tiền rồi/);
  assert.equal((await voucher(no)).status, 'Received');
  const hist = await history(no);
  assert.deepEqual(hist.map((x) => x.status), ['Đang treo', 'Đang duyệt (1/3)', 'Đang duyệt (2/3)', 'Đã duyệt', 'Received']);
  assert.equal(hist[3].note, 'Tất cả 3 bước phê duyệt đã duyệt');
  const subjects = (await emails(no)).map((x) => x.subject);
  assert.ok(subjects.includes(`[ĐÃ DUYỆT HOÀN TOÀN] Phiếu ${no}`));
  assert.ok(subjects.includes(`[XÁC NHẬN NHẬN TIỀN] Phiếu ${no}`));
  assert.ok(subjects.includes(`[ĐÃ NHẬN TIỀN] Phiếu ${no}`));
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
  const r = await call(h.handleVoucherBulkApprove, { voucherNumbers: [...nos, 'MI-PC20261007999999'], approverEmail: people.accountant,
    approverSignature: 'data:sig', signatureVerification: ok });
  assert.equal(r.success, true);
  assert.deepEqual(r.data.approved, nos);
  assert.equal(r.data.failed.length, 1);
  const batch = (await pool.query(`SELECT to_email, subject, body_html FROM email_queue WHERE subject LIKE '[PHÊ DUYỆT HÀNG LOẠT]%' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(batch.to_email, people.legal);
  assert.match(batch.subject, /^\[PHÊ DUYỆT HÀNG LOẠT\] 2 phiếu/);
  assert.ok(nos.every((no) => batch.body_html.includes(no)));
});
