import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STEPS, validateSteps, buildPlan, pendingStep, applyApproval, applyRejection, progress,
} from '../../api/lib/approval/engine.js';

const company = {
  id: 4, company_name: 'MI',
  accountant_name: 'Nguyễn Thị Nhanh', accountant_email: 'nhanh@x.vn',
  legal_rep_name: 'Nguyễn Văn Chinh', legal_rep_email: 'chinh@x.vn',
  treasurer_name: 'Lê Thùy Linh', treasurer_email: 'linh@x.vn',
  extra: { Email_Director: '' },
};
const employeesByEmail = new Map([['boss@x.vn', { full_name: 'Big Boss' }], ['linh@x.vn', { full_name: 'Lê Thùy Linh' }]]);
const flow = (steps) => ({ id: 7, version: 2, steps });
const plan = (steps) => buildPlan({ flow: flow(steps), company, employeesByEmail, workflow: 'voucher' }).plan;
const AT = '2026-10-06T10:00:00.000Z';

test('default voucher flow is chief accountant → legal rep → treasurer', () => {
  assert.deepEqual(DEFAULT_STEPS.voucher.map((s) => s.approvers[0].role), ['chief_accountant', 'legal_rep', 'treasurer']);
});

test('validateSteps reports structural problems', () => {
  assert.deepEqual(validateSteps([]), ['Cần ít nhất một bước duyệt.']);
  assert.match(validateSteps([{ name: 'A', approvers: [] }])[0], /chưa có người duyệt/);
  assert.match(validateSteps([{ name: 'A', approvers: [{ type: 'role', role: 'janitor' }] }])[0], /không tồn tại/);
  assert.match(validateSteps([{ name: 'A', approvers: [{ type: 'person', email: 'nope' }] }])[0], /Email/);
  assert.match(validateSteps([{ name: 'A', approvers: [{ type: 'role', role: 'treasurer' }, { type: 'role', role: 'treasurer' }] }])[0], /trùng/);
  assert.deepEqual(validateSteps(DEFAULT_STEPS.voucher), []);
});

test('buildPlan resolves roles to today\'s people and keeps the flow version', () => {
  const p = plan(DEFAULT_STEPS.voucher);
  assert.equal(p.flowId, 7);
  assert.equal(p.version, 2);
  assert.equal(p.status, 'pending');
  assert.deepEqual(p.steps.map((s) => s.approvers[0].email), ['nhanh@x.vn', 'chinh@x.vn', 'linh@x.vn']);
  assert.equal(p.steps[0].approvers[0].label, 'Kế toán trưởng');
  assert.equal(p.steps[0].approvers[0].name, 'Nguyễn Thị Nhanh');
});

test('buildPlan reports roles with nobody and named people outside the employee list', () => {
  const { problems } = buildPlan({
    flow: flow([{ name: 'GĐ', approvers: [{ type: 'role', role: 'director' }, { type: 'person', email: 'boss@x.vn' }] }]),
    company, employeesByEmail, workflow: 'voucher',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Giám đốc/);
});

test('steps run in order: a later approver cannot approve first', () => {
  const p = plan(DEFAULT_STEPS.voucher);
  assert.throws(() => applyApproval(p, 'chinh@x.vn', { at: AT }), { code: 'NOT_YOUR_TURN' });
  const r = applyApproval(p, 'NHANH@x.vn', { at: AT, signature: 'sig' });
  assert.equal(r.stepDone, true);
  assert.equal(r.finished, false);
  assert.equal(pendingStep(r.plan), 1);
  assert.equal(r.plan.status, 'in_progress');
  assert.equal(r.plan.steps[0].approvers[0].signature, 'sig');
});

test('a group step needs every approver', () => {
  const p = plan([
    { name: 'Hai người', approvers: [{ type: 'role', role: 'chief_accountant' }, { type: 'person', email: 'boss@x.vn' }] },
    { name: 'Thủ quỹ', approvers: [{ type: 'role', role: 'treasurer' }] },
  ]);
  const a = applyApproval(p, 'boss@x.vn', { at: AT });
  assert.equal(a.stepDone, false);
  assert.equal(pendingStep(a.plan), 0);
  assert.throws(() => applyApproval(a.plan, 'boss@x.vn', { at: AT }), { code: 'ALREADY_APPROVED' });
  const b = applyApproval(a.plan, 'nhanh@x.vn', { at: AT });
  assert.equal(b.stepDone, true);
  assert.equal(pendingStep(b.plan), 1);
});

test('the same person in two steps approves each step in turn; last step finishes the plan', () => {
  let p = plan([
    { name: '1', approvers: [{ type: 'role', role: 'treasurer' }] },
    { name: '2', approvers: [{ type: 'person', email: 'linh@x.vn' }] },
  ]);
  p = applyApproval(p, 'linh@x.vn', { at: AT }).plan;
  const r = applyApproval(p, 'linh@x.vn', { at: AT });
  assert.equal(r.finished, true);
  assert.equal(r.plan.status, 'approved');
  assert.equal(pendingStep(r.plan), -1);
  assert.throws(() => applyApproval(r.plan, 'linh@x.vn', { at: AT }), { code: 'CLOSED' });
});

test('progress counts steps', () => {
  let p = plan(DEFAULT_STEPS.voucher);
  assert.deepEqual(progress(p), { done: 0, total: 3, text: '0/3' });
  p = applyApproval(p, 'nhanh@x.vn', { at: AT }).plan;
  assert.deepEqual(progress(p), { done: 1, total: 3, text: '1/3' });
});

test('only a current-step approver can reject; rejection closes the plan', () => {
  const p = plan(DEFAULT_STEPS.voucher);
  assert.throws(() => applyRejection(p, 'linh@x.vn', { at: AT, reason: 'x' }), { code: 'NOT_YOUR_TURN' });
  const r = applyRejection(p, 'nhanh@x.vn', { at: AT, reason: 'Sai số tiền' });
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.rejectedBy, { email: 'nhanh@x.vn', at: AT, reason: 'Sai số tiền' });
  assert.throws(() => applyApproval(r, 'nhanh@x.vn', { at: AT }), { code: 'CLOSED' });
});

test('a plan is a snapshot: later company changes do not alter it, inputs are not mutated', () => {
  const steps = DEFAULT_STEPS.voucher;
  const p = plan(steps);
  company.accountant_email = 'new@x.vn';
  assert.equal(p.steps[0].approvers[0].email, 'nhanh@x.vn');
  company.accountant_email = 'nhanh@x.vn';
  const before = JSON.stringify(p);
  applyApproval(p, 'nhanh@x.vn', { at: AT });
  assert.equal(JSON.stringify(p), before);
});

test('anyApprover: anyone in the plan may reject while open; outsiders and closed plans may not', () => {
  const p = plan(DEFAULT_STEPS.voucher);
  const r = applyRejection(p, 'linh@x.vn', { at: AT, reason: 'x', anyApprover: true });
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejectedBy.email, 'linh@x.vn');
  assert.throws(() => applyRejection(p, 'stranger@x.vn', { at: AT, anyApprover: true }), { code: 'NOT_IN_PLAN' });
  assert.throws(() => applyRejection(r, 'nhanh@x.vn', { at: AT, anyApprover: true }), { code: 'CLOSED' });
});
