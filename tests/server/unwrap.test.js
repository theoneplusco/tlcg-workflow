import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrap } from '../../api/middleware/unwrap-payload.js';

test('query-string action wins', () => {
  assert.equal(unwrap({ action: 'b' }, { action: 'a' }).action, 'a');
});
test('top-level body fields', () => {
  const r = unwrap({ action: 'getCompanyApprovers', companyName: 'MI' });
  assert.equal(r.action, 'getCompanyApprovers');
  assert.equal(r.payload.companyName, 'MI');
});
test('data={json} is unwrapped and merged; the data field is removed from the payload', () => {
  const r = unwrap({ data: JSON.stringify({ action: 'sendApprovalEmail', voucher: { voucherNumber: 'MI-PC20261007000001' } }) });
  assert.equal(r.action, 'sendApprovalEmail');
  assert.equal(r.payload.voucher.voucherNumber, 'MI-PC20261007000001');
  assert.equal('data' in r.payload, false);
});
test('a data field that is not JSON is left alone', () => {
  const r = unwrap({ action: 'x', data: 'hello' });
  assert.equal(r.action, 'x');
  assert.equal(r.payload.data, 'hello');
});
test('broken JSON in data is left alone (no throw)', () => {
  const r = unwrap({ data: '{"action": ' });
  assert.equal(r.action, '');
});
test('empty / missing body', () => {
  assert.deepEqual(unwrap(undefined, {}), { action: '', payload: {} });
});
