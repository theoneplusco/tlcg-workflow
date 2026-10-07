// tests/server/router-p2p.test.js — with p2p on, every PR action is served by Postgres; payments stays on GAS.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_WORKFLOWS = 'p2p';
const { migratedActions } = await import('../../api/router.js');
after(async () => { (await import('../../db/redis.js')).default.quit(); await (await import('../../db/pool.js')).default.end(); });

test('p2p actions are all migrated; validatePRForDirectPayment waits for payments', () => {
  for (const a of ['purchaseRequest', 'resubmitPurchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'sendBackPurchaseRequest',
    'getPurchaseRequestHistory', 'getPurchaseRequest', 'searchPurchaseRequests', 'getP2PHistory', 'getGoodsCatalog',
    'getPurchaseOrderTypes', 'addSupplier']) assert.ok(migratedActions.includes(a), a);
  assert.equal(migratedActions.includes('validatePRForDirectPayment'), false);
  assert.equal(migratedActions.includes('getPaymentProgressByPR'), false, 'payment-side, Plan 6');
});
