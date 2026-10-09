import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, formatTimestamp } from '../../api/lib/vouchers/summary.js';

const old = new Date(Date.now() - 5 * 86400000).toISOString();
const fresh = new Date().toISOString();
const row = (no, o = {}) => ({
  voucher_number: no, voucher_type: 'Phiếu Chi', company_name: 'MI', employee_name: 'A', requestor_email: 'a@x.vn',
  amount: '1500000', status: 'Đang treo', last_action: 'Đã nộp phiếu', updated_at: fresh, progress_done: 0, progress_total: 3,
  approver_emails: ['k@x.vn', 'l@x.vn', 't@x.vn'], current_approver: 'accountant', ...o,
});
const rows = [
  row('V1'),
  row('V2', { status: 'Đang duyệt (1/3)', progress_done: 1, current_approver: 'legalRep', updated_at: old }),
  row('V3', { status: 'Đã duyệt', progress_done: 3, current_approver: '' }),
  row('V4', { status: 'Received', progress_done: 3, current_approver: '' }),
  row('V5', { status: 'Đã từ chối', progress_done: 1, current_approver: '' }),
  row('V6', { requestor_email: 'other@x.vn', approver_emails: ['z@x.vn'] }),
];

test('admin sees everything with GAS-shaped rows and global stats', () => {
  const s = summarize(rows, { email: 'boss@x.vn', isAdmin: true });
  assert.equal(s.total, 6);
  const v2 = s.recent.find((r) => r.voucherNumber === 'V2');
  assert.deepEqual(v2.meta, { companyApprovers: { approvalProgress: '1/3', currentApprover: 'legalRep' } });
  assert.equal(v2.amount, 1500000);
  assert.match(v2.timestampFormatted, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.deepEqual(s.globalStats, { pending: 2, s1: 1, s2: 0, s3: 1, approved: 1, acknowledged: 1, rejected: 1, overdue: 1, total: 6 });
  assert.equal(s.recent[s.recent.length - 1].voucherNumber, 'V2', 'oldest update last');
});

test('approver sees open vouchers in their flows, not finished ones; no global stats', () => {
  const s = summarize(rows, { email: 'l@x.vn' }, 'legalRep');
  assert.deepEqual(s.recent.map((r) => r.voucherNumber).sort(), ['V1', 'V2', 'V5']);
  assert.equal(s.callerApproverRole, 'legalRep');
  assert.equal(s.globalStats, null);
});

test('submitter sees only their own, with GAS counters', () => {
  const s = summarize(rows, { email: 'a@x.vn' });
  assert.equal(s.total, 5);
  assert.equal(s.pending, 1);
  assert.equal(s.approved, 2);
  assert.equal(s.rejected, 1);
});

test('rows carry the reason and the name of the open step (overview page)', () => {
  const s = summarize([row('R1', { description: 'Mua văn phòng phẩm', step_name: 'Kế toán trưởng duyệt' }),
    row('R2', { status: 'Đã duyệt', progress_done: 3, step_name: 'x' }), row('R3')], { email: 'a@x.vn' });
  const by = (no) => s.recent.find((r) => r.voucherNumber === no);
  assert.equal(by('R1').reason, 'Mua văn phòng phẩm');
  assert.equal(by('R1').stepName, 'Kế toán trưởng duyệt');
  assert.equal(by('R2').stepName, '', 'finished: no open step');
  assert.equal(by('R3').reason, '');
});

test('rejected vouchers have no current approver', () => {
  const s = summarize(rows, { email: 'a@x.vn' });
  assert.equal(s.recent.find((r) => r.voucherNumber === 'V5').meta.companyApprovers.currentApprover, null);
});

test('formatTimestamp uses Vietnam time like the GAS script', () => {
  assert.equal(formatTimestamp('2026-10-06T18:30:00.000Z'), '07/10/2026 01:30');
  assert.equal(formatTimestamp(''), '');
});
