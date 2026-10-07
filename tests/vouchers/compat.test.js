import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, applyApproval, applyRejection, DEFAULT_STEPS } from '../../api/lib/approval/engine.js';
import {
  planFromCompanyApprovers, legacyCompanyApprovers, statusText, planIndex, bucket, shouldShow,
} from '../../api/lib/vouchers/compat.js';

const AT = '2026-10-07T03:00:00.000Z';
const company = {
  id: 4, company_name: 'MI',
  accountant_name: 'Nguyễn Thị Nhanh', accountant_email: 'nhanh@x.vn',
  legal_rep_name: 'Nguyễn Văn Chinh', legal_rep_email: 'chinh@x.vn',
  treasurer_name: 'Lê Thùy Linh', treasurer_email: 'linh@x.vn', extra: {},
};
const plan3 = () => buildPlan({ flow: { steps: DEFAULT_STEPS.voucher }, company, workflow: 'voucher' }).plan;

// A legacy companyApprovers as GAS stores it (initializeApproversMeta + 1 approval)
const legacy = {
  approvers: {
    accountant: { email: 'Nhanh@x.vn', name: 'Nguyễn Thị Nhanh', status: 'approved', signature: 'data:sigA', approvedAt: AT, order: 1 },
    legalRep: { email: 'chinh@x.vn', name: 'Nguyễn Văn Chinh', status: 'pending', signature: '', approvedAt: null, order: 2 },
    treasurer: { email: 'linh@x.vn', name: 'Lê Thùy Linh', status: 'pending', signature: '', approvedAt: null, order: 3 },
  },
  overallStatus: 'Partially Approved', approvalProgress: '1/3', currentApprover: 'legalRep',
  approvalSequence: ['accountant', 'legalRep', 'treasurer'], displayStatus: 'Đang duyệt (1/3)',
};

test('legacy companyApprovers → plan keeps order, people, approvals and signatures', () => {
  const p = planFromCompanyApprovers(legacy, { companyId: 4 });
  assert.equal(p.steps.length, 3);
  assert.deepEqual(p.steps.map((s) => s.approvers[0].role), ['chief_accountant', 'legal_rep', 'treasurer']);
  assert.equal(p.steps[0].status, 'approved');
  assert.equal(p.steps[0].approvers[0].email, 'nhanh@x.vn');
  assert.equal(p.steps[0].approvers[0].signature, 'data:sigA');
  assert.equal(p.status, 'in_progress');
  assert.equal(p.source, 'legacy');
});

test('legacy rejected voucher → rejected plan with who/why', () => {
  const rej = structuredClone(legacy);
  rej.overallStatus = 'Rejected';
  rej.rejectedBy = 'chinh@x.vn';
  rej.rejectedAt = AT;
  rej.approvers.legalRep.status = 'rejected';
  rej.approvers.legalRep.rejectReason = 'Sai số tiền';
  const p = planFromCompanyApprovers(rej, { companyId: 4 });
  assert.equal(p.status, 'rejected');
  assert.deepEqual(p.rejectedBy, { email: 'chinh@x.vn', at: AT, reason: 'Sai số tiền' });
});

test('plan → legacy companyApprovers matches the GAS shape for the 3-step flow', () => {
  const p = applyApproval(plan3(), 'nhanh@x.vn', { at: AT, signature: 'data:sigA' }).plan;
  const ca = legacyCompanyApprovers(p);
  assert.deepEqual(ca.approvalSequence, ['accountant', 'legalRep', 'treasurer']);
  assert.equal(ca.approvalProgress, '1/3');
  assert.equal(ca.currentApprover, 'legalRep');
  assert.equal(ca.overallStatus, 'Partially Approved');
  assert.equal(ca.displayStatus, 'Đang duyệt (1/3)');
  assert.equal(ca.approvers.accountant.status, 'approved');
  assert.equal(ca.approvers.accountant.approvedAt, AT);
  assert.equal(ca.approvers.accountant.signature, 'data:sigA');
  assert.equal(ca.approvers.accountant.order, 1);
  assert.equal(ca.approvers.treasurer.email, 'linh@x.vn');
});

test('plan → legacy: new and finished plans', () => {
  const fresh = legacyCompanyApprovers(plan3());
  assert.equal(fresh.overallStatus, 'Pending Approval');
  assert.equal(fresh.displayStatus, 'Chờ duyệt');
  assert.equal(fresh.currentApprover, 'accountant');
  let p = plan3();
  for (const e of ['nhanh@x.vn', 'chinh@x.vn', 'linh@x.vn']) p = applyApproval(p, e, { at: AT }).plan;
  const done = legacyCompanyApprovers(p);
  assert.equal(done.overallStatus, 'Approved');
  assert.equal(done.displayStatus, 'Đã duyệt');
  assert.equal(done.currentApprover, null);
  assert.equal(done.approvalProgress, '3/3');
});

test('round trip legacy → plan → legacy keeps the meaningful fields', () => {
  const back = legacyCompanyApprovers(planFromCompanyApprovers(legacy, { companyId: 4 }));
  for (const k of ['approvalProgress', 'currentApprover', 'overallStatus', 'displayStatus']) assert.equal(back[k], legacy[k], k);
  assert.equal(back.approvers.legalRep.email, 'chinh@x.vn');
});

test('custom flows: group step and extra role get step keys; progress counts steps', () => {
  const flow = { steps: [
    { name: 'KTT', approvers: [{ type: 'role', role: 'chief_accountant' }] },
    { name: 'GĐ + ĐDPL', approvers: [{ type: 'person', email: 'boss@x.vn' }, { type: 'role', role: 'legal_rep' }] },
  ] };
  let p = buildPlan({ flow, company, workflow: 'voucher' }).plan;
  p = applyApproval(p, 'nhanh@x.vn', { at: AT }).plan;
  const ca = legacyCompanyApprovers(p);
  assert.equal(ca.approvalProgress, '1/2');
  assert.deepEqual(ca.approvalSequence, ['accountant', 'step2a', 'step2b']);
  assert.equal(ca.currentApprover, 'step2a');
  assert.equal(ca.displayStatus, 'Đang duyệt (1/2)');
});

test('statusText uses the sheet status strings', () => {
  let p = plan3();
  assert.equal(statusText(p), 'Đang treo');
  p = applyApproval(p, 'nhanh@x.vn', { at: AT }).plan;
  assert.equal(statusText(p), 'Đang duyệt (1/3)');
  assert.equal(statusText(applyRejection(p, 'chinh@x.vn', { at: AT })), 'Đã từ chối');
});

test('planIndex lists who must act now and everyone in the flow', () => {
  const flow = { steps: [{ name: 'A', approvers: [{ type: 'person', email: 'a@x.vn' }, { type: 'person', email: 'b@x.vn' }] }, { name: 'B', approvers: [{ type: 'person', email: 'c@x.vn' }] }] };
  let p = buildPlan({ flow, company, workflow: 'voucher' }).plan;
  p = applyApproval(p, 'a@x.vn', { at: AT }).plan;
  assert.deepEqual(planIndex(p), { done: 0, total: 2, pendingEmails: ['b@x.vn'], approverEmails: ['a@x.vn', 'b@x.vn', 'c@x.vn'] });
});

test('bucket follows VOUCHER_WORKFLOW_RULES §2.2 priority', () => {
  assert.equal(bucket({ status: 'Đã từ chối', done: 1, total: 3 }), 'rejected');
  assert.equal(bucket({ status: 'Received', done: 3, total: 3 }), 'acknowledged');
  assert.equal(bucket({ status: 'Đã duyệt', done: 3, total: 3 }), 'approved');
  assert.equal(bucket({ status: 'Đang duyệt (1/3)', done: 1, total: 3 }), 'in-progress');
  assert.equal(bucket({ status: 'Đang treo', done: 0, total: 3 }), 'pending');
});

test('visibility: admin all; own; in the flow while open; strangers nothing', () => {
  const v = { requestorEmail: 'sub@x.vn', employee: 'Người Lập', approverEmails: ['nhanh@x.vn', 'chinh@x.vn'], status: 'Đang duyệt (1/3)', done: 1, total: 3 };
  const closed = { ...v, status: 'Đã duyệt', done: 3, total: 3 };
  assert.equal(shouldShow(v, { email: 'boss@x.vn', isAdmin: true }), true);
  assert.equal(shouldShow(v, { email: 'SUB@x.vn' }), true);
  assert.equal(shouldShow({ ...v, requestorEmail: '' }, { email: 'p@x.vn', name: 'Người Lập' }), true, 'pre-email vouchers match by name');
  assert.equal(shouldShow(v, { email: 'chinh@x.vn' }), true);
  assert.equal(shouldShow(closed, { email: 'chinh@x.vn' }), false, 'finished vouchers leave approvers\' lists');
  assert.equal(shouldShow({ ...closed, requestorEmail: 'chinh@x.vn' }, { email: 'chinh@x.vn' }), true, '…unless they are their own');
  assert.equal(shouldShow(v, { email: 'stranger@x.vn' }), false);
  assert.equal(shouldShow(v, { email: '' }), false, 'no caller → nothing (GAS showed everything)');
});
