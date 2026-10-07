// syncToSheets: the page's old "copy to Sheet" call is answered on the Mini (the outbox already
// queued the row); it stays on GAS until the vouchers workflow moves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const call = (fn, body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn('syncToSheets', { body, query: {}, headers: {} }, res)).catch(reject);
});

after(async () => {
  (await import('../../db/pool.js')).default.end();
  (await import('../../db/redis.js')).default.quit?.();
});

test('syncToSheets: answered on Postgres when vouchers are on, never calls Google', async () => {
  process.env.PG_WORKFLOWS = 'vouchers';
  const r = await import('../../api/router.js?vouchers-on');
  assert.equal(r.isNewAction('syncToSheets'), true);
  const out = await call(r.routeNewAction, { action: 'syncToSheets', data: { voucherNumber: 'X' } });
  assert.equal(out.success, true);
  assert.equal(out.code, 200);
});

test('syncToSheets: stays on GAS while vouchers are not on Postgres', async () => {
  process.env.PG_WORKFLOWS = '';
  const r = await import('../../api/router.js?vouchers-off');
  assert.equal(r.isNewAction('syncToSheets'), false);
});
