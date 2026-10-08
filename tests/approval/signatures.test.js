// tests/approval/signatures.test.js — sample signatures stored in Postgres (migration 009): image checks, upload by the
// employee (password) or an admin, audit, and the stored signature stamped first. Needs TEST_DATABASE_URL + Redis db 15.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PW, useStepUp } from './step-up-helpers.js';
import { checkSignatureImage, STORED_FROM } from '../../api/lib/approval/signature-store.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const JPEG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString('base64');
const ME = 'sig-me@x.vn';
const ADMIN = 'sig-admin@x.vn';
let h, v, pool, redis, cleanup, company, stepUp;

const callAs = (fn, body, auth) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: auth ? { authorization: auth } : {} }, res)).catch(reject);
});
const jwtFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
const idOf = async (email) => (await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email])).rows[0].id;

test('image check: PNG/JPEG by their bytes, at most 750 KB', () => {
  assert.deepEqual(checkSignatureImage(PNG), { ok: true, bytes: 69 });
  assert.equal(checkSignatureImage(JPEG).ok, true);
  assert.equal(checkSignatureImage('').message, 'Vui lòng chọn ảnh chữ ký.');
  for (const bad of ['https://drive.google.com/x', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/gif;base64,R0lGODlh',
    PNG.replace('image/png', 'image/jpeg'), 'data:image/png;base64,' + Buffer.from('not a png').toString('base64')]) {
    assert.equal(checkSignatureImage(bad).message, 'Chữ ký phải là ảnh PNG hoặc JPG.', bad.slice(0, 40));
  }
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(768001)]).toString('base64');
  assert.equal(checkSignatureImage(big).message, 'Ảnh chữ ký quá lớn (tối đa 750 KB). Vui lòng chọn ảnh nhỏ hơn.');
});

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet';
  h = await import('../../api/handlers/signatures.js');
  v = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default;
  stepUp = await import('../../api/lib/approval/step-up.js');
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  cleanup = await useStepUp(pool, redis, [ME, ADMIN, company.accountant_email]);
  await pool.query(`UPDATE employees SET is_admin = TRUE WHERE email = $1`, [ADMIN]);
  await pool.query(`DELETE FROM employee_signatures WHERE employee_id IN (SELECT id FROM employees WHERE LOWER(email) = ANY($1))`,
    [[ME, ADMIN, company.accountant_email.toLowerCase()]]);
  await pool.query(`DELETE FROM master_audit WHERE table_key = 'signatures'`);
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC202610086%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC202610086%'; TRUNCATE approval_flows`);
});
after(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM employee_signatures WHERE employee_id IN (SELECT id FROM employees WHERE LOWER(email) = ANY($1))`,
    [[ME, ADMIN, company.accountant_email.toLowerCase()]]);
  if (cleanup) await cleanup();
  await pool.end();
  redis.quit?.();
});

test('the employee uploads their own signature with their password; it is audited without the image', { skip }, async () => {
  assert.equal((await callAs(h.handleSaveMySignature, { signature: PNG, password: PW }, null)).code, 401);
  const auth = await jwtFor(ME);
  assert.deepEqual((await callAs(h.handleGetMySignature, {}, auth)).data, { hasSignature: false });
  assert.equal((await callAs(h.handleSaveMySignature, { signature: PNG, password: 'wrong' }, auth)).message, 'Mật khẩu không đúng.');
  assert.equal((await callAs(h.handleSaveMySignature, { signature: 'data:text/plain;base64,eA==', password: PW }, auth)).message, 'Chữ ký phải là ảnh PNG hoặc JPG.');
  await redis.del(stepUp.failKey(ME));
  const r = await callAs(h.handleSaveMySignature, { signature: PNG, password: PW }, auth);
  assert.deepEqual([r.success, r.message], [true, 'Đã lưu chữ ký mẫu.']);
  const mine = (await callAs(h.handleGetMySignature, {}, auth)).data;
  assert.deepEqual([mine.hasSignature, mine.signature, mine.updatedBy], [true, PNG, ME]);
  const audit = (await pool.query(`SELECT row_id, old_value, new_value, actor_email FROM master_audit WHERE table_key = 'signatures' ORDER BY id`)).rows;
  assert.deepEqual(audit, [{ row_id: await idOf(ME), old_value: '', new_value: 'uploaded (0 KB)', actor_email: ME }]);
  // Replacing keeps one row per employee
  assert.equal((await callAs(h.handleSaveMySignature, { signature: JPEG, password: PW }, auth)).success, true);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM employee_signatures WHERE employee_id = $1`, [await idOf(ME)])).rows[0].n, 1);
  assert.equal((await callAs(h.handleGetMySignature, {}, auth)).data.signature, JPEG);
});

test('an admin views and replaces anyone\'s signature; others cannot', { skip }, async () => {
  const id = await idOf(ME);
  assert.equal((await callAs(h.handleAdminSaveSignature, { id, signature: PNG }, await jwtFor(ME))).code, 403);
  const auth = await jwtFor(ADMIN);
  const r = await callAs(h.handleAdminSaveSignature, { id, signature: PNG }, auth);
  assert.equal(r.success, true, r.message);
  const got = (await callAs(h.handleAdminGetSignature, { id }, auth)).data;
  assert.deepEqual([got.signature, got.updatedBy], [PNG, ADMIN]);
  assert.equal((await callAs(h.handleAdminSaveSignature, { id: 999999, signature: PNG }, auth)).message, 'Không tìm thấy nhân viên.');
  const last = (await pool.query(`SELECT old_value, actor_email FROM master_audit WHERE table_key = 'signatures' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.deepEqual(last, { old_value: 'uploaded', actor_email: ADMIN });
});

test('approving stamps the stored signature first, even when the company\'s Drive sample is broken', { skip }, async () => {
  const acc = company.accountant_email.toLowerCase();
  // The Drive sample fails (like linh.le's 404); before the upload the approval is refused
  stepUp.stampDeps.fetchImage = async () => { throw new Error('Không tải được hình ảnh (HTTP 404)'); };
  stepUp.clearStampCache();
  const no = 'MI-PC20261008600001';
  const submit = await callAs(v.handleVoucherSubmit, {
    email: { to: acc, subject: `[PHÊ DUYỆT] Phiếu ${no}`, body: '<p>x</p>' },
    voucher: { voucherNumber: no, voucherType: 'Phiếu Chi', company: company.company_name, companyKey: company.company_key,
      employee: 'Người Lập', requestorEmail: 'sig-req@x.vn', amount: '100.000', reason: 'Kiểm tra chữ ký', files: [] },
  }, null);
  assert.equal(submit.success, true, submit.message);
  const approve = async () => callAs(v.handleVoucherApprove, { voucher: { voucherNumber: no, approverPassword: PW } }, await jwtFor(acc));
  const refused = await approve();
  assert.match(refused.message, /^Chưa có chữ ký mẫu của bạn/);
  await redis.del(stepUp.failKey(acc));
  assert.equal((await callAs(h.handleSaveMySignature, { signature: PNG, password: PW }, await jwtFor(acc))).success, true);
  const ok = await approve();
  assert.equal(ok.success, true, ok.message);
  const row = (await pool.query(`SELECT status, metadata FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
  assert.equal(row.status, 'Đang duyệt (1/3)');
  assert.equal(row.metadata.accountantSignature, PNG, 'the stored signature is stamped');
  const ctx = await callAs(v.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(acc));
  assert.equal(ctx.success, true);
  const { sampleSignatureFor } = await import('../../api/lib/approval/signature-check.js');
  assert.deepEqual(await sampleSignatureFor(pool, company.id, null, acc), { url: PNG, from: STORED_FROM });
});
