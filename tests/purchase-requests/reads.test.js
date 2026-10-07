// tests/purchase-requests/reads.test.js — PR reads on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody, SIG_OK } from './helpers.js';

let s, dd, r, pool, company, people, mine, theirs;
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  dd = await import('../../api/handlers/pr/decide.js');
  r = await import('../../api/handlers/pr/reads.js');
  mine = (await call(s.handlePRSubmit, submitBody(company, people, { purpose: 'Khăn giấy phòng họp' }), as('a@pr-test.vn'))).prNo;
  theirs = (await call(s.handlePRSubmit, submitBody(company, people, { purpose: 'Ly giấy' }), as('b@pr-test.vn'))).prNo;
});
after(async () => {
  if (pool) await pool.query(`DELETE FROM master_vendors WHERE extra->>'Vendor_Full_Name' LIKE 'NCC Plan5 %'; DELETE FROM purchase_order_types WHERE type LIKE 'Plan5 %'`);
  await teardown(pool);
});
const nos = (list) => list.map((x) => x.prNo).sort();

test('list: requester sees own, approver sees both, admin all, stranger none, no token 401', { skip }, async () => {
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as('a@pr-test.vn'))).requests), [mine]);
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as(people.treasurer))).requests), [mine, theirs].sort());
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as('x@x.vn', { isAdmin: true }))).requests), [mine, theirs].sort());
  const none = await call(r.handlePRHistory, {}, as('x@x.vn'));
  assert.deepEqual([none.success, none.message, none.requests, none.data.requests], [true, 'Thành công', [], []]);
  assert.equal((await call(r.handlePRHistory, {}, null)).code, 401);
});

test('list hides terminal PRs idle for 90 days and archived ones', { skip }, async () => {
  await pool.query(`UPDATE purchase_requests SET status = 'Hoàn thành', updated_at = NOW() - interval '91 days' WHERE pr_no = $1`, [theirs]);
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as(people.treasurer))).requests), [mine]);
  assert.deepEqual(nos((await call(r.handlePRSearch, { q: 'Ly giấy' }, as(people.treasurer))).requests), [theirs], 'search still finds it');
  await pool.query(`UPDATE purchase_requests SET status = 'Đang duyệt ngân sách & NCC (2/5)', updated_at = NOW(), archived_at = NOW() WHERE pr_no = $1`, [theirs]);
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as(people.treasurer))).requests), [mine], 'archived left out of the list');
  assert.equal((await call(r.handlePRDetail, { prNo: theirs }, as(people.treasurer))).request.prNo, theirs, 'detail finds archived (B6)');
  assert.deepEqual(nos((await call(r.handlePRSearch, { q: 'Ly giấy' }, as(people.treasurer))).requests), [theirs], 'search includes archived');
  await pool.query(`UPDATE purchase_requests SET archived_at = NULL WHERE pr_no = $1`, [theirs]);
});

test('detail: GAS shape with strings; visibility enforced; not-found wording', { skip }, async () => {
  const d = await call(r.handlePRDetail, { prNo: mine, submittedAt: 'anything' }, as('a@pr-test.vn'));
  assert.equal(d.success, true);
  assert.equal(typeof d.request.items, 'string');
  assert.equal(typeof d.request.metadata, 'string');
  assert.equal(d.data.request.prNo, mine);
  const no = await call(r.handlePRDetail, { prNo: mine }, as('b@pr-test.vn'));
  assert.deepEqual([no.code, no.message], [403, 'Bạn không có quyền xem đề nghị này.']);
  assert.equal((await call(r.handlePRDetail, { prNo: 'X-1' }, as('a@pr-test.vn'))).message, 'Không tìm thấy đề nghị: X-1');
  assert.equal((await call(r.handlePRDetail, {}, as('a@pr-test.vn'))).message, 'Thiếu số phiếu mua hàng.');
});

test('search: 2+ chars, substring on number/company/requester/purpose, visible only', { skip }, async () => {
  assert.deepEqual((await call(r.handlePRSearch, { q: 'K' }, as('a@pr-test.vn'))).requests, []);
  assert.deepEqual(nos((await call(r.handlePRSearch, { query: 'phòng họp' }, as('a@pr-test.vn'))).requests), [mine]);
  assert.deepEqual((await call(r.handlePRSearch, { q: 'Ly giấy' }, as('a@pr-test.vn'))).requests, []);
  assert.deepEqual((await call(r.handlePRSearch, { q: '100%_' }, as('x@x.vn', { isAdmin: true }))).requests, [], 'LIKE wildcards are literal');
  assert.equal((await call(r.handlePRSearch, { q: 'phòng họp' }, null)).code, 401);
});

test('getP2PHistory: PR flow from pr_audit_log, other flows go to GAS', { skip }, async () => {
  await call(dd.handlePRApprove, { prNo: mine, approverRole: 'budget', approverSignature: 'data:s', signatureVerification: SIG_OK }, as(people.treasurer));
  const h = await call(r.handleP2PHistory, { docNo: mine, flow: 'PR' }, as('a@pr-test.vn'));
  assert.equal(h.message, 'OK');
  assert.deepEqual(h.history.map((x) => `${x.action}/${x.role}`), ['Submit/requester', 'Approve/budget', 'Approve/supplier']);
  assert.equal((await call(r.handleP2PHistory, { docNo: mine, flow: 'PR' }, as('b@pr-test.vn'))).code, 403);
  let proxied = null;
  const gasProxy = (req, res) => { proxied = req.body; res.json({ success: true, history: ['gas'] }); };
  const am = await call(r.handleP2PHistory, { docNo: 'AM-1', flow: 'AM' }, null, { gasProxy });
  assert.deepEqual(am.history, ['gas']);
  assert.deepEqual(JSON.parse(proxied.data), { docNo: 'AM-1', flow: 'AM', action: 'getP2PHistory' });
});

test('getGoodsCatalog: Goods-KTT headers, no login', { skip }, async () => {
  const g = await call(r.handleGoodsCatalog, {}, null);
  assert.equal(g.message, 'Goods catalog fetched successfully');
  assert.ok(g.goods.length > 0);
  assert.deepEqual(Object.keys(g.goods[0]), ['Category', 'Items', 'Unit', 'Min. Order', 'Specificaton', 'Unit Price', 'CUKCUK/QBO Code', 'Status']);
});

test('getPurchaseOrderTypes', { skip }, async () => {
  await pool.query(`INSERT INTO purchase_order_types (no, type, sheet_row) VALUES ('1', 'Plan5 Hàng hóa', 2), ('2', '', 3)`);
  const t = await call(r.handlePurchaseOrderTypes, {}, null);
  assert.ok(t.types.some((x) => x.no === '1' && x.type === 'Plan5 Hàng hóa'));
  assert.ok(!t.types.some((x) => x.type === ''));
});

test('addSupplier: Master Vendor, duplicate refused, login needed', { skip }, async () => {
  const name = `NCC Plan5 ${Date.now()}`;
  const a = await call(r.handleAddSupplier, { name, taxCode: '0312', address: 'HCM' }, as('a@pr-test.vn'));
  assert.deepEqual([a.success, a.message, a.name], [true, 'Supplier added successfully', name]);
  assert.match(a.supplierId, /^VD\d{3,}$/);
  const row = (await pool.query(`SELECT extra FROM master_vendors WHERE extra->>'Vendor_Full_Name' = $1`, [name])).rows[0];
  assert.equal(row.extra['Tax ID'], '0312');
  assert.equal((await call(r.handleAddSupplier, { name: name.toUpperCase() }, as('a@pr-test.vn'))).message, `Supplier "${name.toUpperCase()}" already exists`);
  assert.equal((await call(r.handleAddSupplier, { name: '' }, as('a@pr-test.vn'))).message, 'Supplier name is required');
  assert.equal((await call(r.handleAddSupplier, { name }, null)).code, 401);
  const long = await call(r.handleAddSupplier, { name: `NCC Plan5 long ${Date.now()}`, address: 'x'.repeat(201) }, as('a@pr-test.vn'));
  assert.deepEqual([long.success, long.message], [false, 'Thông tin nhà cung cấp quá dài.']);
  const typed = `NCC Plan5 typed ${Date.now()}`;
  await call(r.handleAddSupplier, { name: typed, companyType: 'vietnam COMPANY' }, as('a@pr-test.vn'));
  assert.equal((await pool.query(`SELECT extra FROM master_vendors WHERE extra->>'Vendor_Full_Name' = $1`, [typed])).rows[0].extra['Vendor Type'], 'Vietnam company');
  const noCol = await call(r.handleAddSupplier, { name: `NCC Plan5 nocol ${Date.now()}` }, as('a@pr-test.vn'), {
    db: { connect: async () => ({ query: async (q) => (q.includes('master_columns') ? { rows: [{ name: 'Address' }] } : { rows: [] }), release() {} }) } });
  assert.deepEqual([noCol.success, noCol.message], [false, 'Lỗi hệ thống, vui lòng thử lại.'], 'no Vendor_Full_Name column: not a fake success');
});

test('catalog and supplier errors: generic message, details only in the server log', { skip }, async () => {
  const boom = { query: async () => { throw new Error('relation secret_table does not exist'); }, connect: async () => ({ query: async () => { throw new Error('secret'); }, release() {} }) };
  for (const [fn, caller] of [[r.handleGoodsCatalog, null], [r.handlePurchaseOrderTypes, null], [r.handleAddSupplier, as('a@pr-test.vn')]]) {
    const out = await call(fn, { name: 'NCC Plan5 boom' }, caller, { db: boom });
    assert.deepEqual([out.success, out.message], [false, 'Lỗi hệ thống, vui lòng thử lại.'], fn.name);
  }
});

test('validatePRForDirectPayment: GAS messages; vendorName from the PR (B9); open payment refused', { skip }, async () => {
  const v = (body, extra) => call(r.handleValidatePRForDirectPayment, body, as('a@pr-test.vn'), extra);
  assert.equal((await v({})).message, 'Thiếu số PR.');
  const unknown = await v({ prNo: 'X-1' });
  assert.deepEqual([unknown.code, unknown.message], [403, 'Bạn không có quyền xem đề nghị này.'], 'unknown number hidden from non-admins');
  assert.equal((await call(r.handleValidatePRForDirectPayment, { prNo: 'X-1' }, as('x@x.vn', { isAdmin: true }))).message, 'Không tìm thấy PR: X-1');
  assert.equal((await v({ prNo: mine })).message, 'PR chưa được phê duyệt hoàn tất.');
  await pool.query(`UPDATE purchase_requests SET status = 'Hoàn thành', vendor_name = 'NCC A' WHERE pr_no = $1`, [mine]);
  const okr = await v({ prNo: mine });
  assert.deepEqual([okr.success, okr.vendorName, okr.p2pBranch, okr.data.prNo], [true, 'NCC A', 'simplified', mine]);
  const stranger = await call(r.handleValidatePRForDirectPayment, { prNo: mine }, as('b@pr-test.vn'));
  assert.deepEqual([stranger.code, stranger.message], [403, 'Bạn không có quyền xem đề nghị này.'], 'completed PR, not visible');
  const busy = await v({ prNo: mine }, { paymentsForPR: async () => [{ status: 'Đang duyệt' }] });
  assert.equal(busy.message, 'Đã tồn tại đề nghị thanh toán cho PR này.');
  assert.equal((await v({ prNo: mine }, { paymentsForPR: async () => [{ status: 'Rejected' }] })).success, true);
});

test('detail: the pending approver gets their own registered sample (mySampleSignatureUrl, "" = none); others get null', { skip }, async () => {
  const { sampleSignatureFor } = await import('../../api/lib/approval/signature-check.js');
  const no = (await call(s.handlePRSubmit, submitBody(company, people, { purpose: 'Mẫu chữ ký' }), as('a@pr-test.vn'))).prNo;
  const sample = async (who) => (await call(r.handlePRDetail, { prNo: no }, as(who))).request.mySampleSignatureUrl;
  assert.equal(await sample('a@pr-test.vn'), null, 'requester: not pending');
  assert.equal(await sample(people.treasurer), (await sampleSignatureFor(pool, company.id, null, people.treasurer)).url, 'budget/supplier approver');
  assert.equal(await sample(people.ap), null, 'purchasing approver: not their turn yet');
  await call(dd.handlePRApprove, { prNo: no, approverRole: 'budget', note: '', approverSignature: 'data:sig', signatureVerification: SIG_OK }, as(people.treasurer));
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  try {
    await pool.query(`UPDATE employees SET extra = extra - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' || '{"Signature":"https://sig.test/ap.png"}'::jsonb WHERE LOWER(email) = $1`, [people.ap]);
    assert.equal(await sample(people.ap), 'https://sig.test/ap.png', 'purchasing approver (Kế Toán Chi): their Master Employee Signature');
    await pool.query(`UPDATE employees SET extra = extra - 'Signature' WHERE LOWER(email) = $1`, [people.ap]);
    assert.equal(await sample(people.ap), '', 'no sample registered → ""');
  } finally {
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
  assert.equal(await sample(people.treasurer), null, 'already approved: no longer pending');
});
