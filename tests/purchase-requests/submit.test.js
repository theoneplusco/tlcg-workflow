// tests/purchase-requests/submit.test.js — purchaseRequest on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';

let h, pool, company, people;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  h = await import('../../api/handlers/pr/submit.js');
});
after(() => teardown(pool));
const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mails = async (no) => (await pool.query(`SELECT to_email, subject FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${no}`])).rows;

test('no login token → 401', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people), null);
  assert.equal(r.code, 401);
  assert.equal(r.message, 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
});

test('submit: stored with the GAS shape, caller as requester, one email to the shared approver', { skip }, async () => {
  const body = submitBody(company, people, { grandTotal: 999999999 });
  const r = await call(h.handlePRSubmit, body, REQ);
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  assert.equal(r.prNo, body.prNo, 'page number kept');
  assert.equal(r.data.prNo, body.prNo);
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.equal(row.requester_email, 'req@pr-test.vn');
  assert.equal(Number(row.grand_total), 149500, 'server total, not the client figure (S4)');
  assert.equal(row.p2p_branch, 'simplified');
  assert.equal(row.company_id, company.id);
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  assert.deepEqual(row.approver_emails, [people.treasurer, people.ap]);
  assert.notEqual(row.metadata.submittedAt, '2020-01-01T00:00:00.000Z', 'server clock (S9)');
  assert.equal(row.metadata.requesterEmail, 'req@pr-test.vn');
  assert.equal(row.priority, 'Bình Thường');
  const m = await mails(body.prNo);
  assert.deepEqual(m.map((x) => x.to_email), [people.treasurer, 'req@pr-test.vn']);
  const audit = (await pool.query('SELECT action, role, new_status, extra FROM pr_audit_log WHERE doc_no = $1', [body.prNo])).rows;
  assert.deepEqual(audit.map((a) => [a.action, a.role]), [['Submit', 'requester']]);
  assert.deepEqual(audit[0].extra, { purchaseType: 'goods', p2pBranch: 'simplified' });
});

test('same number twice → next free tail, response carries the issued number', { skip }, async () => {
  const body = submitBody(company, people);
  await call(h.handlePRSubmit, body, REQ);
  const r = await call(h.handlePRSubmit, body, REQ);
  assert.equal(r.success, true);
  assert.notEqual(r.prNo, body.prNo);
  assert.equal(r.prNo.slice(0, -6), body.prNo.slice(0, -6));
});

test('GAS validation wording comes first', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { requiredDate: '' }), REQ);
  assert.deepEqual([r.success, r.message], [false, 'Thiếu ngày cần hàng.']);
});

test('approver outside the company list is refused (S3)', { skip }, async () => {
  // Not the caller's own email: self-picks are refused first, with their own message (next test).
  const r = await call(h.handlePRSubmit, submitBody(company, people, { budgetApprover: 'Outsider@pr-test.vn' }), REQ);
  assert.equal(r.success, false);
  assert.match(r.message, /^Người phê duyệt ngân sách \(outsider@pr-test\.vn\) không thuộc danh sách người duyệt của công ty này/);
});

test('the requester may not pick themselves (decision #3), even when on the company list', { skip }, async () => {
  const r1 = await call(h.handlePRSubmit, submitBody(company, people, { budgetApprover: 'REQ@pr-test.vn' }), REQ);
  assert.deepEqual([r1.success, r1.message], [false, 'Bạn không thể tự phê duyệt đề nghị của chính mình.']);
  const r2 = await call(h.handlePRSubmit, submitBody(company, people), as(people.treasurer));
  assert.deepEqual([r2.success, r2.message], [false, 'Bạn không thể tự phê duyệt đề nghị của chính mình.']);
  const n = (await pool.query('SELECT count(*)::int AS n FROM purchase_requests WHERE requester_email = $1', [people.treasurer])).rows[0].n;
  assert.equal(n, 0, 'nothing stored');
});

test('unknown company → GAS wording', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { companyName: 'Không Có', companyKey: 'ZZ.NONE' }), REQ);
  assert.deepEqual([r.success, r.message], [false, 'Không tìm thấy công ty trong Dữ liệu gốc: Không Có']);
});

test('router: purchaseRequest stays on GAS without p2p; with p2p it reaches the Postgres handler', { skip }, async () => {
  const saved = process.env.PG_WORKFLOWS;
  try {
    process.env.PG_WORKFLOWS = 'vouchers';
    const off = await import('../../api/router.js?pr-submit-off');
    assert.equal(off.isNewAction('purchaseRequest'), false);
    process.env.PG_WORKFLOWS = 'p2p';
    const on = await import('../../api/router.js?pr-submit-on');
    assert.equal(on.isNewAction('purchaseRequest'), true);
    const r = await new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
      on.routeNewAction('purchaseRequest', { body: submitBody(company, people), query: {}, headers: {} }, res).catch(reject);
    });
    assert.deepEqual([r.code, r.message], [401, 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.']);
  } finally {
    if (saved === undefined) delete process.env.PG_WORKFLOWS; else process.env.PG_WORKFLOWS = saved;
  }
});

test('full branch needs a contract reviewer from the company list', { skip }, async () => {
  const big = JSON.stringify([{ desc: 'Tủ lạnh', qty: '1', price: '25000000', total: '25000000' }]);
  const r1 = await call(h.handlePRSubmit, submitBody(company, people, { items: big }), REQ);
  assert.equal(r1.message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const r2 = await call(h.handlePRSubmit, submitBody(company, people, { items: big, contractApprover: people.accountant }), REQ);
  assert.equal(r2.success, true, r2.message);
  assert.equal((await pr(r2.prNo)).contract_approver_email, people.accountant);
});

test('requesterEmail of someone else is refused', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { requesterEmail: 'boss@x.vn' }), REQ);
  assert.equal(r.message, 'Bạn đang đăng nhập bằng req@pr-test.vn, không thể thao tác thay boss@x.vn.');
});

test('attachments go to R2; a refused file is recorded and the submit still succeeds', { skip }, async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.input.Key); } };
  const files = [
    { fileName: 'bao-gia.pdf', fileData: Buffer.from('%PDF-1').toString('base64'), mimeType: 'application/pdf' },
    { fileName: 'x.svg', fileData: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' },
  ];
  const r = await call(h.handlePRSubmit, submitBody(company, people, { attachments: files }), REQ, { s3 });
  assert.equal(r.success, true);
  const row = await pr(r.prNo);
  assert.equal(sent.length, 1);
  assert.match(row.attachments[0].fileUrl, /\/purchase-requests\/[0-9a-f]{32}-bao-gia\.pdf$/);
  assert.equal(row.attachments[1].error, 'Loại file không được hỗ trợ');
  assert.deepEqual(row.metadata.attachments, row.attachments);
});

test('requesterEmail claim in another case is the caller (accepted)', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { requesterEmail: ' REQ@PR-Test.vn ' }), REQ);
  assert.equal(r.success, true, r.message);
});

test('client line total ignored: stored items and grand_total from qty × price (decision #6)', { skip }, async () => {
  const items = JSON.stringify([{ section: 'hang-hoa', desc: 'Khăn', qty: '5', price: '29900', total: '1', hack: 'x' }]);
  const r = await call(h.handlePRSubmit, submitBody(company, people, { items }), REQ);
  assert.equal(r.success, true, r.message);
  const row = await pr(r.prNo);
  assert.equal(Number(row.grand_total), 149500);
  assert.equal(row.items[0].total, 149500);
  assert.equal(row.items[0].hack, undefined);
});

test('tx: prDeps is lazy about R2 and checks the login against the injected db; withLockedPR rolls back without saved', { skip }, async () => {
  const { prDeps, withLockedPR } = await import('../../api/handlers/pr/tx.js');
  assert.equal(prDeps({ s3: null }).s3, null);
  const seen = [];
  const fakeDb = { query: async (sql, params) => { seen.push(params); return { rows: [] }; } };
  const jwt = (await import('jsonwebtoken')).default;
  const { jwtSecret } = await import('../../api/handlers/auth.js');
  const token = jwt.sign({ id: 424242 }, jwtSecret());
  assert.equal(await prDeps({ db: fakeDb }).who({ headers: { authorization: 'Bearer ' + token } }), null);
  assert.deepEqual(seen.at(-1), [424242], 'caller looked up in the injected db');
  const body = submitBody(company, people);
  const made = await call(h.handlePRSubmit, body, REQ);
  assert.equal(made.success, true, made.message);
  const before = (await pr(made.prNo)).purpose;
  const r = await new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
    withLockedPR(pool, made.prNo, res, async (client, row) => {
      await client.query('UPDATE purchase_requests SET purpose = $2 WHERE id = $1', [row.id, 'changed']);
      return { message: 'x' }; // no saved row
    });
  });
  assert.equal(r.success, false);
  assert.equal((await pr(made.prNo)).purpose, before, 'rolled back');
});
