// tests/purchase-requests/fx.test.js — PR submit/resubmit on the VND threshold with admin rates (Plan 5b)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';
import { toVnd, normalizeCurrency, getRateToVnd } from '../../api/lib/fx/rates.js';

let s, d, r, pool, company, people;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
  r = await import('../../api/handlers/pr/reads.js');
  await pool.query(`DELETE FROM exchange_rates WHERE currency = 'XTS'`);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 26000 WHERE currency = 'USD'`);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL WHERE currency = 'EUR'`);
});
after(async () => {
  if (pool) {
    await pool.query(`DELETE FROM purchase_requests WHERE currency = 'XTS'`);
    await pool.query(`DELETE FROM exchange_rates WHERE currency = 'XTS'`);
    await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL WHERE currency IN ('USD', 'EUR')`);
  }
  await teardown(pool);
});

const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const items = (price) => JSON.stringify([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Máy in', qty: '1', unit: 'Cái', price, total: price, note: '' }]);
const submit = (over) => call(s.handlePRSubmit, submitBody(company, people, over), REQ);
const fx = (row) => [row.currency, Number(row.grand_total), Number(row.fx_rate), Number(row.grand_total_vnd), row.p2p_branch];

test('toVnd: exact integer arithmetic, no float drift on large totals', () => {
  assert.equal(toVnd(9999999999.99, 26000), 259999999999740);
  assert.equal(toVnd('9999999999.99', '26000.000000'), 259999999999740, 'pg NUMERIC strings');
  assert.equal(toVnd(0.1 + 0.2, 10), 3, '0.30000000000000004 × 10 → 3');
  assert.equal(toVnd(4.125, 3), 12, '12.375 → 12 (half-up only at .5)');
  assert.equal(toVnd(0.5, 1, 'VND'), 0.5, 'VND is never rounded');
  assert.equal(toVnd('1500.5', 1, 'VNĐ'), 1500.5, 'VNĐ is VND');
  assert.equal(toVnd(0.5, 1, 'USD'), 1, 'a non-VND currency at rate 1 is still rounded half-up');
  assert.equal(toVnd(2.4, 1, 'XTS'), 2, 'rate 1, non-VND: 2.4 → 2');
  assert.equal(toVnd(76.9, 26000), 1999400);
  assert.equal(toVnd(5733726.543, 2500), 14334316358, 'exact …357.5 → …358 (float multiply: …357)');
  assert.equal(toVnd(9074078460.88, 21579), 195809539107330, 'exact …329.52 → …330 (6-decimal scaling: …329)');
  assert.equal(normalizeCurrency(' vnđ '), 'VND');
  assert.equal(normalizeCurrency('usd'), 'USD');
  assert.equal(normalizeCurrency('US$'), '');
});

test('getRateToVnd: VND 1; NUMERIC string → number; missing row or NULL rate → null', { skip }, async () => {
  assert.equal(await getRateToVnd(pool, ''), 1);
  assert.equal(await getRateToVnd(pool, 'usd'), 26000);
  assert.equal(await getRateToVnd(pool, 'EUR'), null);
  assert.equal(await getRateToVnd(pool, 'JPY'), null);
  assert.equal(await getRateToVnd(pool, 'US$'), null);
});

test('USD 100 at 26,000 = 2,600,000 ₫: contract reviewer required; rate and VND total stored', { skip }, async () => {
  assert.equal((await submit({ currency: 'USD', items: items('100') })).message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const res = await submit({ currency: 'USD', items: items('100'), contractApprover: people.legal });
  assert.equal(res.success, true, res.message);
  assert.deepEqual(fx(await pr(res.prNo)), ['USD', 100, 26000, 2600000, 'full']);
});

test('USD 50 = 1,300,000 ₫ stays simplified; VND rows store rate 1', { skip }, async () => {
  const usd = await submit({ currency: 'USD', items: items('50') });
  assert.deepEqual(fx(await pr(usd.prNo)), ['USD', 50, 26000, 1300000, 'simplified']);
  const vnd = await submit({});
  assert.deepEqual(fx(await pr(vnd.prNo)), ['VND', 149500, 1, 149500, 'simplified']);
  const lower = await submit({ currency: 'usd', items: items('50') });
  assert.equal((await pr(lower.prNo)).currency, 'USD', 'stored normalised');
});

test('no EUR rate (NULL) or no row at all → refused with the Vietnamese message; nothing stored', { skip }, async () => {
  const n = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_requests')).rows[0].n;
  const before = await n();
  assert.deepEqual(await submit({ currency: 'EUR', items: items('10') }).then((x) => [x.success, x.message]),
    [false, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.']);
  assert.deepEqual(await submit({ currency: 'jpy', items: items('10') }).then((x) => [x.success, x.message]),
    [false, 'Chưa có tỷ giá cho JPY. Vui lòng liên hệ quản trị viên.']);
  assert.equal((await submit({ currency: 'US$', items: items('10') })).message, 'Loại tiền tệ không hợp lệ.');
  assert.equal(await n(), before);
});

test('resubmit converts with the rate of that day', { skip }, async () => {
  const first = await submit({ currency: 'USD', items: items('50') });
  const back = await call(d.handlePRSendBack, { prNo: first.prNo, approverRole: 'budget', targetStep: 1, sentBackNote: 'Kiểm tra giá' }, as(people.treasurer));
  assert.equal(back.success, true, back.message);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 50000 WHERE currency = 'USD'`);
  try {
    const again = (over) => call(s.handlePRResubmit, submitBody(company, people, { prNo: first.prNo, currency: 'USD', items: items('50'), ...over }), REQ);
    assert.equal((await again({})).message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
    const ok = await again({ contractApprover: people.legal });
    assert.equal(ok.success, true, ok.message);
    assert.deepEqual(fx(await pr(first.prNo)), ['USD', 50, 50000, 2500000, 'full']);
  } finally {
    await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 26000 WHERE currency = 'USD'`);
  }
});

// The admin delete locks the rate row FOR UPDATE and refuses while a PR uses the currency; submit reads the
// rate FOR SHARE inside its transaction, so a PR never commits in a currency removed at the same moment.
test('a currency removed while a submit is in flight: the submit waits for the delete, then refuses', { skip }, async () => {
  await pool.query(`INSERT INTO exchange_rates (currency, rate_to_vnd) VALUES ('XTS', 1000)`);
  const admin = await pool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`SELECT id FROM exchange_rates WHERE currency = 'XTS' FOR UPDATE`);
    await admin.query(`DELETE FROM exchange_rates WHERE currency = 'XTS'`);
    let done = false;
    const pending = submit({ currency: 'XTS', items: items('10') }).then((x) => { done = true; return x; });
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(done, false, 'the submit waits on the locked rate row');
    await admin.query('COMMIT');
    const res = await pending;
    assert.deepEqual([res.success, res.message], [false, 'Chưa có tỷ giá cho XTS. Vui lòng liên hệ quản trị viên.']);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM purchase_requests WHERE currency = 'XTS'`)).rows[0].n, 0);
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    admin.release();
  }
});

test('a rate changed while a submit is in flight: the PR stores the rate it read under the lock', { skip }, async () => {
  await pool.query(`INSERT INTO exchange_rates (currency, rate_to_vnd) VALUES ('XTS', 1000) ON CONFLICT (currency) DO UPDATE SET rate_to_vnd = 1000`);
  const admin = await pool.connect();
  try {
    await admin.query('BEGIN');
    await admin.query(`UPDATE exchange_rates SET rate_to_vnd = 300000 WHERE currency = 'XTS'`);
    const pending = submit({ currency: 'XTS', items: items('10') });
    await new Promise((ok) => setTimeout(ok, 300));
    await admin.query('COMMIT');
    const res = await pending;
    assert.equal(res.message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.',
      'validated again at 300,000: 3,000,000 ₫ needs a contract reviewer');
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    admin.release();
    await pool.query(`DELETE FROM exchange_rates WHERE currency = 'XTS'`);
  }
});

test('imported rows (no VND total) keep their stored branch on the direct-payment check', { skip }, async () => {
  const res = await submit({ currency: 'USD', items: items('100'), contractApprover: people.legal });
  await pool.query(`UPDATE purchase_requests SET grand_total_vnd = NULL, fx_rate = NULL, p2p_branch = 'simplified', status = 'Hoàn thành' WHERE pr_no = $1`, [res.prNo]);
  const out = await call(r.handleValidatePRForDirectPayment, { prNo: res.prNo }, as(people.legal), { paymentsForPR: async () => [] });
  assert.deepEqual([out.success, out.p2pBranch], [true, 'simplified']);
  await pool.query(`UPDATE purchase_requests SET grand_total_vnd = 2600000, p2p_branch = 'simplified' WHERE pr_no = $1`, [res.prNo]);
  const full = await call(r.handleValidatePRForDirectPayment, { prNo: res.prNo }, as(people.legal), { paymentsForPR: async () => [] });
  assert.equal(full.message, 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.');
});

test('getExchangeRates: signed-in only; VND base and the admin rates', { skip }, async () => {
  assert.equal((await call(r.handleExchangeRates, {}, null)).code, 401);
  const ok = await call(r.handleExchangeRates, {}, REQ);
  assert.deepEqual([ok.success, ok.base, ok.rates.USD, ok.rates.EUR], [true, 'VND', 26000, null]);
});
