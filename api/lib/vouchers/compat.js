// api/lib/vouchers/compat.js — Bridge between the approval engine's plan and
// the voucher shapes the existing pages and Google Sheet use (pure, no I/O).
//
// The pages read meta.companyApprovers with keys accountant / legalRep /
// treasurer and "N/3" progress (see TLCG_CASH_BACKEND.gs initializeApproversMeta).
// A voucher now stores an engine plan; legacyCompanyApprovers() projects it
// back into that shape, and planFromCompanyApprovers() lifts GAS vouchers into
// plans during import.
import { pendingStep, progress } from '../approval/engine.js';
import { roleLabel } from '../approval/roles.js';

const ROLE_TO_LEGACY = { chief_accountant: 'accountant', legal_rep: 'legalRep', treasurer: 'treasurer' };
const LEGACY_TO_ROLE = { accountant: 'chief_accountant', legalRep: 'legal_rep', treasurer: 'treasurer' };
const LEGACY_STEP_NAME = { accountant: 'Kế toán trưởng duyệt', legalRep: 'Đại diện pháp luật duyệt', treasurer: 'Thủ quỹ duyệt' };

export const STATUS = {
  submitted: 'Đang treo',
  approved: 'Đã duyệt',
  rejected: 'Đã từ chối',
  received: 'Received',
};

const lower = (s) => String(s || '').trim().toLowerCase();

/** GAS companyApprovers (accountant → legalRep → treasurer) → engine plan. */
export function planFromCompanyApprovers(ca, { companyId = null } = {}) {
  const approvers = (ca && ca.approvers) || {};
  const sequence = (ca && ca.approvalSequence) || ['accountant', 'legalRep', 'treasurer'];
  const steps = sequence.filter((k) => approvers[k]).map((k) => {
    const a = approvers[k];
    const approved = a.status === 'approved';
    return {
      name: LEGACY_STEP_NAME[k] || k,
      status: approved ? 'approved' : 'pending',
      approvers: [{
        type: 'role', role: LEGACY_TO_ROLE[k] || null, label: LEGACY_TO_ROLE[k] ? roleLabel(LEGACY_TO_ROLE[k]) : k,
        email: lower(a.email), name: a.name || '', status: approved ? 'approved' : 'pending',
        at: a.approvedAt || null, signature: a.signature || '',
      }],
    };
  });
  let status = 'pending';
  let rejectedBy = null;
  if (ca && ca.overallStatus === 'Rejected') {
    status = 'rejected';
    const who = Object.values(approvers).find((a) => a.status === 'rejected') || {};
    rejectedBy = { email: lower(ca.rejectedBy || who.email), at: ca.rejectedAt || who.rejectedAt || null, reason: who.rejectReason || '' };
  } else if (steps.length && steps.every((s) => s.status === 'approved')) {
    status = 'approved';
  } else if (steps.some((s) => s.status === 'approved')) {
    status = 'in_progress';
  }
  return { flowId: null, version: 0, workflow: 'voucher', companyId, source: 'legacy', steps, status, rejectedBy };
}

/**
 * Engine plan → GAS companyApprovers. Single-approver steps holding one of the
 * three classic roles keep their legacy key (accountant / legalRep / treasurer);
 * anything else becomes step<n> (or step<n>a, step<n>b… for group steps).
 */
export function legacyCompanyApprovers(plan) {
  const { done, total, text } = progress(plan);
  const used = new Set();
  const approvers = {};
  const approvalSequence = [];
  const keysByStep = plan.steps.map((step, i) => step.approvers.map((a, k) => {
    let key = step.approvers.length === 1 && ROLE_TO_LEGACY[a.role] && !used.has(ROLE_TO_LEGACY[a.role])
      ? ROLE_TO_LEGACY[a.role]
      : `step${i + 1}${step.approvers.length > 1 ? String.fromCharCode(97 + k) : ''}`;
    used.add(key);
    approvalSequence.push(key);
    const rejected = plan.status === 'rejected' && plan.rejectedBy && plan.rejectedBy.email === a.email && pendingStepAtReject(plan) === i;
    approvers[key] = {
      email: a.email, name: a.name || '', role: a.label || '', status: rejected ? 'rejected' : a.status,
      signature: a.signature || '', approvedAt: a.at || null,
      rejectedAt: rejected ? plan.rejectedBy.at : null, rejectReason: rejected ? plan.rejectedBy.reason : '',
      order: approvalSequence.length,
    };
    return key;
  }));

  const open = pendingStep(plan);
  let currentApprover = null;
  if (open >= 0) {
    const step = plan.steps[open];
    const k = step.approvers.findIndex((a) => a.status !== 'approved');
    currentApprover = keysByStep[open][k >= 0 ? k : 0];
  }

  const byStatus = {
    pending: ['Pending Approval', 'Chờ duyệt'],
    in_progress: ['Partially Approved', `Đang duyệt (${text})`],
    approved: ['Approved', STATUS.approved],
    rejected: ['Rejected', STATUS.rejected],
  }[plan.status] || ['Pending Approval', 'Chờ duyệt'];

  const lastApproval = plan.steps.flatMap((s) => s.approvers).map((a) => a.at).filter(Boolean).sort().pop() || null;
  return {
    approvers,
    overallStatus: byStatus[0],
    approvalProgress: `${done}/${total}`,
    currentApprover,
    approvalSequence,
    displayStatus: byStatus[1],
    fullyApprovedAt: plan.status === 'approved' ? lastApproval : null,
    rejectedAt: plan.rejectedBy ? plan.rejectedBy.at : null,
    rejectedBy: plan.rejectedBy ? plan.rejectedBy.email : null,
  };
}

// The step that was open when the plan was rejected (first not fully approved)
function pendingStepAtReject(plan) {
  return plan.steps.findIndex((s) => s.status !== 'approved');
}

/** Sheet status string for a plan (acknowledgement is tracked on the voucher, not the plan). */
export function statusText(plan) {
  if (plan.status === 'rejected') return STATUS.rejected;
  if (plan.status === 'approved') return STATUS.approved;
  const { done, text } = progress(plan);
  return done === 0 ? STATUS.submitted : `Đang duyệt (${text})`;
}

/** Fields stored on the vouchers row for fast lists: progress and who is involved. */
export function planIndex(plan) {
  const { done, total } = progress(plan);
  const open = pendingStep(plan);
  const pendingEmails = open >= 0
    ? plan.steps[open].approvers.filter((a) => a.status !== 'approved' && a.email).map((a) => a.email)
    : [];
  const approverEmails = [...new Set(plan.steps.flatMap((s) => s.approvers.map((a) => a.email)).filter(Boolean))];
  return { done, total, pendingEmails, approverEmails };
}

/** Bucket per VOUCHER_WORKFLOW_RULES §2.2 (first match wins). v: { status, done, total } */
export function bucket(v) {
  const s = lower(v.status);
  if (s.includes('rejected') || s.includes('từ chối')) return 'rejected';
  if (s.includes('received') || s.includes('xác nhận') || s.includes('đã thu') || s.includes('đã nhận')) return 'acknowledged';
  if ((v.total && v.done >= v.total) || s.includes('approved') || s.includes('đã duyệt')) return 'approved';
  if (v.done > 0) return 'in-progress';
  return 'pending';
}

/**
 * Who may see a voucher in lists. Same idea as GAS shouldShow, generalised to
 * per-company flows: approvers see vouchers whose flow includes them (GAS:
 * every voucher of every company) until finished, unless it is their own.
 * Deliberate change: a call without a caller sees nothing (GAS showed all).
 * v: { requestorEmail, employee, approverEmails[], status, done, total }
 * caller: { email, name, isAdmin }
 */
export function shouldShow(v, caller) {
  const email = lower(caller && caller.email);
  if (!email) return false;
  if (caller.isAdmin) return true;
  const own = lower(v.requestorEmail)
    ? lower(v.requestorEmail) === email
    : !!(caller.name && v.employee && String(v.employee).trim() === String(caller.name).trim());
  if (own) return true;
  if ((v.approverEmails || []).map(lower).includes(email)) {
    const b = bucket(v);
    return b !== 'approved' && b !== 'acknowledged';
  }
  return false;
}
