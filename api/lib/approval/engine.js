// api/lib/approval/engine.js — Pure approval engine (no I/O).
//
// A flow is an ordered list of steps; each step lists approvers (a company
// role or a named person) and needs ALL of them. At submit time a flow is
// resolved into a plan: a plain-data snapshot stored with the document, so
// later edits to the flow or to Master Data never change in-flight documents.
import { ROLES, resolveRole, roleLabel } from './roles.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Built-in flows, used when a workflow has no flow saved at all (today's behaviour). */
export const DEFAULT_STEPS = {
  voucher: [
    { name: 'Kế toán trưởng duyệt', approvers: [{ type: 'role', role: 'chief_accountant' }] },
    { name: 'Đại diện pháp luật duyệt', approvers: [{ type: 'role', role: 'legal_rep' }] },
    { name: 'Thủ quỹ duyệt', approvers: [{ type: 'role', role: 'treasurer' }] },
  ],
};

function engineError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const approverKey = (a) => (a.type === 'role' ? 'role:' + a.role : 'person:' + String(a.email || '').toLowerCase());

/** Structural problems in a flow (Vietnamese messages for the admin page). Empty = valid. */
export function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return ['Cần ít nhất một bước duyệt.'];
  const errors = [];
  steps.forEach((step, i) => {
    const label = `Bước ${i + 1}${step && step.name ? ` (${step.name})` : ''}`;
    const approvers = (step && step.approvers) || [];
    if (!approvers.length) { errors.push(`${label} chưa có người duyệt.`); return; }
    const seen = new Set();
    approvers.forEach((a) => {
      if (a.type === 'role') {
        if (!ROLES[a.role]) errors.push(`${label}: vai trò "${a.role}" không tồn tại.`);
      } else if (a.type === 'person') {
        if (!EMAIL_RE.test(String(a.email || ''))) errors.push(`${label}: Email "${a.email || ''}" không hợp lệ.`);
      } else {
        errors.push(`${label}: loại người duyệt không hợp lệ.`);
      }
      const k = approverKey(a);
      if (seen.has(k)) errors.push(`${label}: người duyệt bị trùng.`);
      seen.add(k);
    });
  });
  return errors;
}

/**
 * Resolve a flow for one company into a document plan.
 * Returns { plan, problems } — problems lists approvers with nobody to act
 * (e.g. a role this company has not filled). The plan is still built so the
 * caller can decide whether to block submission.
 */
export function buildPlan({ flow, company, employeesByEmail = new Map(), workflow }) {
  const problems = [];
  const steps = flow.steps.map((step, i) => ({
    name: step.name || `Bước ${i + 1}`,
    status: 'pending',
    approvers: step.approvers.map((a) => {
      if (a.type === 'role') {
        const who = resolveRole(a.role, company, employeesByEmail);
        if (!who) problems.push(`Bước ${i + 1}: công ty chưa có ${roleLabel(a.role)}.`);
        return { type: 'role', role: a.role, label: roleLabel(a.role), email: who ? who.email : '', name: who ? who.name : '',
          status: 'pending', at: null, signature: '' };
      }
      const email = String(a.email).trim().toLowerCase();
      const employee = employeesByEmail.get(email);
      return { type: 'person', role: null, label: '', email, name: (employee && employee.full_name) || a.name || email,
        status: 'pending', at: null, signature: '' };
    }),
  }));
  return {
    plan: {
      flowId: flow.id || null, version: flow.version || 0, workflow, companyId: company ? company.id : null,
      steps, status: 'pending', rejectedBy: null,
    },
    problems,
  };
}

/** Index of the first step not yet fully approved, or -1 when none is open. */
export function pendingStep(plan) {
  if (plan.status === 'approved' || plan.status === 'rejected') return -1;
  return plan.steps.findIndex((s) => s.status !== 'approved');
}

function openStepFor(plan, email) {
  if (plan.status === 'approved' || plan.status === 'rejected') throw engineError('CLOSED', 'Phiếu đã kết thúc quy trình duyệt.');
  const i = pendingStep(plan);
  const who = String(email || '').trim().toLowerCase();
  const step = plan.steps[i];
  const mine = step.approvers.filter((a) => a.email === who);
  if (!mine.length) {
    const waiting = step.approvers.filter((a) => a.status !== 'approved').map((a) => a.name || a.label || a.email).join(', ');
    throw engineError('NOT_YOUR_TURN', `Chưa đến lượt bạn. Đang chờ: ${waiting}.`);
  }
  return { i, who, mine };
}

/**
 * Record `email`'s approval on the current step. Returns a NEW plan (input is
 * not mutated) plus whether the step and the whole plan are now complete.
 */
export function applyApproval(plan, email, { at, signature = '' } = {}) {
  const next = structuredClone(plan);
  const { i, who } = openStepFor(next, email);
  const step = next.steps[i];
  const mine = step.approvers.filter((a) => a.email === who && a.status !== 'approved');
  if (!mine.length) throw engineError('ALREADY_APPROVED', 'Bạn đã duyệt bước này rồi.');
  mine.forEach((a) => { a.status = 'approved'; a.at = at; a.signature = signature; });
  const stepDone = step.approvers.every((a) => a.status === 'approved');
  if (stepDone) step.status = 'approved';
  const finished = next.steps.every((s) => s.status === 'approved');
  next.status = finished ? 'approved' : 'in_progress';
  return { plan: next, stepDone, finished };
}

/**
 * Reject the document. By default only the current step's approvers may
 * reject; with anyApprover, anyone in the plan may (GAS voucher behaviour:
 * any of the voucher's approvers can stop it while it is open).
 */
export function applyRejection(plan, email, { at, reason = '', anyApprover = false } = {}) {
  const next = structuredClone(plan);
  let who;
  if (anyApprover) {
    if (next.status === 'approved' || next.status === 'rejected') throw engineError('CLOSED', 'Phiếu đã kết thúc quy trình duyệt.');
    who = String(email || '').trim().toLowerCase();
    if (!next.steps.some((s) => s.approvers.some((a) => a.email === who))) {
      throw engineError('NOT_IN_PLAN', 'Bạn không có trong quy trình duyệt của phiếu này.');
    }
  } else {
    ({ who } = openStepFor(next, email));
  }
  next.status = 'rejected';
  next.rejectedBy = { email: who, at, reason };
  return next;
}

/** Progress in steps: { done, total, text: 'done/total' }. */
export function progress(plan) {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === 'approved').length;
  return { done, total, text: `${done}/${total}` };
}
