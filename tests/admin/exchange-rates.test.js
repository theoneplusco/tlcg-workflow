// tests/admin/exchange-rates.test.js — exchange rates in Master Data: rules, read-only currency, add/remove, audit (DB)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { checkRule, MASTER_TABLES, FX_RATE_MESSAGE } from '../../api/lib/master-registry.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const FX = 'Tỷ giá phải là số nguyên dương (VND cho 1 đơn vị).';
let h, pool, auth, usd;
const call = (fn, body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: { authorization: auth } }, res)).catch(reject);
});
const set = (column, value) => call(h.handleAdminMasterUpdateCell, { table: 'exchange_rates', id: usd, column, value });
const cleanup = async () => {
  await pool.query(`DELETE FROM exchange_rates WHERE currency NOT IN ('USD', 'EUR')`);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL, extra = '{}'`);
  await pool.query(`DELETE FROM master_audit WHERE table_key = 'exchange_rates'`);
  await pool.query(`DELETE FROM purchase_requests WHERE pr_no LIKE 'FX-TEST-%'`);
};

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  h = await import('../../api/handlers/admin-master.js');
  pool = (await import('../../db/pool.js')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`INSERT INTO employees (full_name, email, status, is_admin) VALUES ('FX Admin', 'fx-admin@test.vn', 'active', TRUE)
    ON CONFLICT (email) DO UPDATE SET is_admin = TRUE, status = 'active' RETURNING id`);
  auth = 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
  await cleanup();
  usd = (await pool.query(`SELECT id FROM exchange_rates WHERE currency = 'USD'`)).rows[0].id;
});
after(async () => {
  if (!pool) return;
  await cleanup();
  await pool.query(`DELETE FROM employees WHERE email = 'fx-admin@test.vn'`);
  await pool.end();
  (await import('../../db/redis.js')).default.quit?.();
});

test('rate rule (pure): a whole number of VND ≥ 1; decimals, zero, negatives and text refused with one message', () => {
  const rule = MASTER_TABLES.exchange_rates.rules.Rate_To_VND;
  assert.equal(FX_RATE_MESSAGE, FX);
  assert.deepEqual(checkRule(rule, ' 26000 '), { ok: true, value: '26000' });
  assert.deepEqual(checkRule(rule, '26,000'), { ok: true, value: '26,000' });
  assert.deepEqual(checkRule(rule, '1'), { ok: true, value: '1' });
  assert.equal(checkRule(rule, '').message, 'Ô này không được để trống.');
  for (const bad of ['26000.5', '26.000', '0', '-5', 'abc', '1e4', '2,6000', '26 000']) {
    assert.deepEqual(checkRule(rule, bad), { ok: false, message: FX }, bad);
  }
});

test('exchange rates are listed and read like the sheet tables; USD and EUR seeded without a rate', { skip }, async () => {
  const t = await call(h.handleAdminMasterTables, {});
  const fx = t.data.tables.find((x) => x.key === 'exchange_rates');
  assert.deepEqual([fx.title, fx.sheet, fx.audit], ['Exchange rates', null, true]);
  assert.equal(t.data.tables.find((x) => x.key === 'companies').audit, false);
  const g = await call(h.handleAdminMasterGet, { table: 'exchange_rates' });
  assert.deepEqual(g.data.columns.map((c) => [c.name, c.readOnly]), [['Currency', true], ['Rate_To_VND', false]]);
  assert.equal(g.data.table.audit, true);
  assert.deepEqual(g.data.rows.map((r) => r.v), [['USD', ''], ['EUR', '']]);
});

test('a rate must be a whole positive number; the currency cannot be edited', { skip }, async () => {
  assert.equal((await set('Rate_To_VND', '')).message, 'Ô này không được để trống.');
  for (const bad of ['abc', '0', '-5', '26000.5']) assert.equal((await set('Rate_To_VND', bad)).message, FX, bad);
  assert.equal((await set('Currency', 'GBP')).message, 'Cột này không sửa ở đây.');
  const ok = await set('Rate_To_VND', '26,000');
  assert.equal(ok.success, true, ok.message);
  assert.equal(Number((await pool.query(`SELECT rate_to_vnd FROM exchange_rates WHERE id = $1`, [usd])).rows[0].rate_to_vnd), 26000);
});

test('every saved change is audited (who, old, new), newest first; refused edits are not', { skip }, async () => {
  await set('Rate_To_VND', '26500');
  const a = await call(h.handleAdminMasterAudit, { table: 'exchange_rates' });
  assert.equal(a.success, true, a.message);
  assert.deepEqual(a.data.entries.map((e) => [e.rowId, e.column, e.oldValue, e.newValue, e.actorEmail]), [
    [usd, 'Rate_To_VND', '26,000', '26500', 'fx-admin@test.vn'],
    [usd, 'Rate_To_VND', '', '26,000', 'fx-admin@test.vn'],
  ]);
  assert.ok(a.data.entries.every((e) => e.at));
  assert.equal((await call(h.handleAdminMasterAudit, { table: 'companies' })).message, 'Bảng này không lưu lịch sử thay đổi.');
});

test('add a currency: 3 letters, upper-cased, unique, not VND, with a whole rate; audited', { skip }, async () => {
  const add = (currency, rate) => call(h.handleAdminExchangeRateAdd, { currency, rate });
  assert.equal((await add('', '33000')).message, 'Ô này không được để trống.');
  assert.equal((await add('GB', '33000')).message, 'Sai định dạng — ví dụ: USD.');
  assert.equal((await add('vnd', '1')).message, 'VND là tiền gốc, không cần tỷ giá.');
  assert.equal((await add('usd', '26000')).message, 'Loại tiền USD đã có.');
  assert.equal((await add('gbp', '33000.5')).message, FX);
  assert.equal((await add('gbp', '')).message, 'Ô này không được để trống.');
  const ok = await add(' gbp ', '33,000');
  assert.equal(ok.success, true, ok.message);
  const row = (await pool.query(`SELECT id, currency, rate_to_vnd, sheet_row FROM exchange_rates WHERE currency = 'GBP'`)).rows[0];
  assert.deepEqual([row.currency, Number(row.rate_to_vnd), row.sheet_row], ['GBP', 33000, 3]);
  assert.equal(ok.data.id, row.id);
  const g = await call(h.handleAdminMasterGet, { table: 'exchange_rates' });
  assert.deepEqual(g.data.rows.map((r) => r.v), [['USD', '26500'], ['EUR', ''], ['GBP', '33,000']]);
  const a = await call(h.handleAdminMasterAudit, { table: 'exchange_rates' });
  assert.deepEqual(a.data.entries.slice(0, 2).map((e) => [e.rowId, e.column, e.oldValue, e.newValue]), [
    [row.id, 'Rate_To_VND', '', '33,000'],
    [row.id, 'Currency', '', 'GBP'],
  ]);
});

test('remove a currency: refused while a PR uses it (any case), removed and audited otherwise', { skip }, async () => {
  const del = (id) => call(h.handleAdminExchangeRateDelete, { id });
  const gbp = (await pool.query(`SELECT id FROM exchange_rates WHERE currency = 'GBP'`)).rows[0].id;
  await pool.query(`INSERT INTO purchase_requests (pr_no, currency) VALUES ('FX-TEST-1', 'gbp')`);
  assert.equal((await del(gbp)).message, 'Không xoá được GBP: đã có đề nghị mua hàng dùng loại tiền này.');
  await pool.query(`DELETE FROM purchase_requests WHERE pr_no = 'FX-TEST-1'`);
  const ok = await del(gbp);
  assert.equal(ok.success, true, ok.message);
  assert.equal((await pool.query(`SELECT 1 FROM exchange_rates WHERE id = $1`, [gbp])).rowCount, 0);
  const a = await call(h.handleAdminMasterAudit, { table: 'exchange_rates' });
  assert.deepEqual(a.data.entries.slice(0, 2).map((e) => [e.rowId, e.column, e.oldValue, e.newValue]), [
    [gbp, 'Rate_To_VND', '33,000', ''],
    [gbp, 'Currency', 'GBP', ''],
  ]);
  assert.equal((await del(gbp)).message, 'Không tìm thấy dòng.');
});

test('add/remove/audit are admin-only', { skip }, async () => {
  const saved = auth;
  auth = '';
  try {
    for (const fn of [h.handleAdminExchangeRateAdd, h.handleAdminExchangeRateDelete, h.handleAdminMasterAudit]) {
      const r = await call(fn, { table: 'exchange_rates', currency: 'JPY', rate: '170', id: usd });
      assert.equal(r.success, false);
      assert.equal(r.code, 401);
    }
  } finally { auth = saved; }
  assert.equal((await pool.query(`SELECT 1 FROM exchange_rates WHERE currency = 'JPY'`)).rowCount, 0);
});
