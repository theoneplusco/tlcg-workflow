import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
// Load it the way the browser does (a plain <script>), in a sandbox
const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../voucher-steps.js', import.meta.url), 'utf8'), sandbox);
const raw = sandbox.self.VoucherSteps;
// Objects from the sandbox have another realm's prototypes: compare as plain JSON
const VS = new Proxy(raw, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { const r = t[k](...a); return r && typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r; } : t[k]) });

const plan = {
  status: 'in_progress', rejectedBy: null,
  steps: [
    { name: 'KTT', status: 'approved', approvers: [{ label: 'Kế toán trưởng', name: 'Nhanh', email: 'k@x.vn', status: 'approved', at: '2026-10-07T03:00:00Z' }] },
    { name: 'GĐ + ĐDPL', status: 'pending', approvers: [
      { label: 'Giám đốc', name: 'Anh', email: 'a@x.vn', status: 'approved', at: '2026-10-07T04:00:00Z' },
      { label: '', name: 'Linh <b>', email: 'l@x.vn', status: 'pending', at: null }] },
    { name: 'Thủ quỹ', status: 'pending', approvers: [{ label: 'Thủ quỹ', name: 'Linh', email: 't@x.vn', status: 'pending', at: null }] },
  ],
};

test('progress reads d/N from rows, statusData and plain strings; GAS defaults to /3', () => {
  assert.deepEqual(VS.progress({ meta: { companyApprovers: { approvalProgress: '1/4' } } }), { done: 1, total: 4, percent: 25, text: '1/4' });
  assert.equal(VS.progress({ approvalProgress: '2/3' }).percent, 67);
  assert.deepEqual(VS.progress(undefined), { done: 0, total: 3, percent: 0, text: '0/3' });
});
test('onPostgres detects engine answers only', () => {
  assert.equal(VS.onPostgres({ myTurn: false }), true);
  assert.equal(VS.onPostgres({ meta: { approvalPlan: plan } }), true);
  assert.equal(VS.onPostgres({ meta: { companyApprovers: {} } }), false);
});
test('isPendingFor: only the not-yet-approved people of the open step', () => {
  assert.equal(VS.isPendingFor(plan, 'L@x.vn'), true);
  assert.equal(VS.isPendingFor(plan, 'a@x.vn'), false, 'already approved in the group step');
  assert.equal(VS.isPendingFor(plan, 't@x.vn'), false, 'later step');
  assert.equal(VS.isPendingFor({ ...plan, status: 'rejected' }, 'l@x.vn'), false);
});
test('stepsHtml shows every step and approver, group label, escaping', () => {
  const html = VS.stepsHtml(plan);
  assert.equal((html.match(/Bước \d/g) || []).length, 3);
  assert.match(html, /Tất cả phải duyệt/);
  assert.match(html, /Linh &lt;b&gt;/);
  assert.match(html, /Đang chờ phê duyệt/);
  assert.equal(VS.waitingText(plan), 'Linh <b>');
});
