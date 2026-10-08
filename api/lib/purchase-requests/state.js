// api/lib/purchase-requests/state.js — Purchase request approval rules (pure).
// GAS: computePRApprovalState_, handleApprove/Reject/SendBackPurchaseRequest (TLCG_P2P_BACKEND.gs),
// with the product decisions of 2026-10-07:
// - the same person on budget + supplier approves once for both slots;
// - send back to step 3 is refused: the PR has no contract stage (GAS bug B3);
// - reject uses the caller's slot in the open stage (GAS let a later role win, then refused);
// - the requester may pick themselves; with their password at submit their slots are auto-approved (Plan 5c, 2026-10-08).
export const STATUS = {
  PARALLEL: 'Đang duyệt ngân sách & NCC (2/5)',
  CONTRACT: 'Thẩm định Hợp đồng (4/5)',
  PURCHASING: 'Mua hàng (5/5)',
  DONE: 'Hoàn thành',
  REJECTED: 'Đã từ chối',
  RETURNED: 'Trả lại bổ sung',
};
export const TERMINAL_STATUSES = [STATUS.DONE, 'Approved', STATUS.REJECTED, 'Rejected'];
export const ROLES = ['budget', 'supplier', 'contract', 'purchasing'];
export const BAD_ROLE = 'Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".';
export const MAX_SEND_BACK = { budget: 1, supplier: 1, contract: 2, purchasing: 2 };
const ROLE_STAGE = { budget: 'parallel', supplier: 'parallel', contract: 'contract', purchasing: 'purchasing' };
const STAGE_LABEL = { parallel: 'duyệt ngân sách & NCC', contract: 'thẩm định hợp đồng', purchasing: 'mua hàng', complete: 'complete' };
const COL = { budget: 'budget_approver_email', supplier: 'supplier_approver_email', contract: 'contract_approver_email', purchasing: 'purchasing_approver_email' };

export const MISSING_REQUESTER_ERROR = 'Thiếu thông tin người đề nghị.';
const lower = (s) => String(s || '').trim().toLowerCase();
export const isRole = (r) => ROLES.includes(lower(r));
export const isRejected = (s) => s === STATUS.REJECTED || s === 'Rejected';
export const isComplete = (s) => s === STATUS.DONE || s === 'Approved';
export const isTerminal = (s) => isRejected(s) || isComplete(s);
export const isReturned = (s) => s === STATUS.RETURNED;
export const emailOf = (pr, role) => lower(pr[COL[role]]);

/** Role names in emails and in the self-approval texts. */
export const ROLE_LABEL = { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' };
/** Step numbers of the PR status labels: (2/5) budget & supplier, (4/5) contract, (5/5) purchasing. */
const STAGE_STEP = { parallel: 2, contract: 4, purchasing: 5 };
const REACHABLE = ['parallel', 'purchasing']; // approvalState never opens the contract stage (GAS parity)
// PR stamps are the person's own sample (entries null → stamp key '*', as entriesKey(null) in self-approval.js)
const ownEntry = (stage, roles) => ({ step: STAGE_STEP[stage], key: '*', entries: null, roles, labels: roles.map((r) => ROLE_LABEL[r]) });
const stageSlots = (pr, stage, me) => ROLES.filter((r) => ROLE_STAGE[r] === stage && emailOf(pr, r) === me);

/** The submit picks as the approver columns of a row (for prOwnSteps before the PR exists). */
export const picksAsRow = (picks) => ({ budget_approver_email: picks.budget, supplier_approver_email: picks.supplier,
  contract_approver_email: picks.contract, purchasing_approver_email: picks.purchasing });

/** Plan 5c: every reachable stage where `email` holds a slot, in order (what the requester consents to). */
export function prOwnSteps(pr, email) {
  const me = lower(email);
  if (!me) return [];
  return REACHABLE.map((stage) => [stage, stageSlots(pr, stage, me)])
    .filter(([, roles]) => roles.length).map(([stage, roles]) => ownEntry(stage, roles));
}

/**
 * Plan 5c: the requester's not-yet-approved slots in the OPEN stage (null when none, or the PR is not open).
 * step and key come from the stage (its full slot set), so they match what prOwnSteps recorded at consent;
 * roles / labels are the slots still to approve (applyApprove's same-person merge clears them all at once).
 */
export function prOwnOpen(pr, meta, email) {
  const me = lower(email);
  if (!me || isTerminal(pr.status) || isReturned(pr.status)) return null;
  const { stage } = approvalState(pr, meta);
  if (!REACHABLE.includes(stage)) return null;
  const roles = stageSlots(pr, stage, me).filter((r) => meta[`${r}Status`] !== 'Approved');
  return roles.length ? ownEntry(stage, roles) : null;
}

/** Plan 5c: does `email` still hold a reachable slot that is not approved? */
export const prOwnLeft = (pr, meta, email) => ['budget', 'supplier', 'purchasing'].some((r) => emailOf(pr, r) === lower(email) && meta[`${r}Status`] !== 'Approved');

/**
 * The consent round: send-backs to step 1 only (the requester edits and resubmits, and is asked again).
 * A step-2 send-back keeps the consent (controller decision 2, 2026-10-08): content is unchanged.
 */
export const consentRound = (meta) => (Array.isArray((meta || {}).sentBackHistory)
  ? meta.sentBackHistory.filter((h) => h && Number(h.targetStep) === 1).length : 0);

/** The full-branch limit is in VND (decision 2026-10-07): other currencies are converted with the admin rate first. */
export const FULL_BRANCH_MIN_VND = 2000000;

/** GAS computeP2PBranch_ on the VND total: services or ≥ 2,000,000 ₫ → full (needs a contract reviewer). */
export function computeBranch(purchaseType, grandTotalVnd) {
  return lower(purchaseType) === 'services' || (Number(grandTotalVnd) || 0) >= FULL_BRANCH_MIN_VND ? 'full' : 'simplified';
}

/**
 * The branch of a stored PR: from its VND total when it has one (every submit/resubmit on Postgres stores it);
 * rows imported from GAS have none and keep the branch GAS chose (decision 4: never recomputed in VND).
 */
export function branchOf(row) {
  if (row.grand_total_vnd != null && row.grand_total_vnd !== '') return computeBranch(row.purchase_type, Number(row.grand_total_vnd));
  return row.p2p_branch || (row.metadata || {}).p2pBranch || 'full';
}
export const normalizePurchaseType = (t) => (lower(t) === 'services' ? 'services' : 'goods');

/** GAS computePRApprovalState_ line for line (the contract stage is unreachable on both branches). */
export function approvalState(pr, meta = {}) {
  const done = (r) => !emailOf(pr, r) || meta[`${r}Status`] === 'Approved';
  const branch = meta.p2pBranch || pr.p2p_branch || 'full';
  const skipContract = branch === 'full' || branch === 'simplified';
  if (!(done('budget') && done('supplier'))) return { stage: 'parallel', statusLabel: STATUS.PARALLEL };
  if (!skipContract && emailOf(pr, 'contract') && !done('contract')) return { stage: 'contract', statusLabel: STATUS.CONTRACT };
  if (emailOf(pr, 'purchasing') && !done('purchasing')) return { stage: 'purchasing', statusLabel: STATUS.PURCHASING };
  return { stage: 'complete', statusLabel: STATUS.DONE };
}

/** Who must act now: returned → the requester; open stage → its approvers who have not approved. */
export function pendingEmails(pr, meta = {}, status = pr.status) {
  if (isTerminal(status)) return [];
  if (isReturned(status)) return [lower(pr.requester_email || meta.requesterEmail)].filter(Boolean);
  const { stage } = approvalState(pr, meta);
  const open = ROLES.filter((r) => ROLE_STAGE[r] === stage && emailOf(pr, r) && meta[`${r}Status`] !== 'Approved');
  return [...new Set(open.map((r) => emailOf(pr, r)))];
}

/** Everyone named on the PR (visibility), contract reviewer included. */
export function approverEmails(pr) {
  return [...new Set(ROLES.map((r) => emailOf(pr, r)).filter(Boolean))];
}

/** The browser's signature check result: object as is, JSON string parsed, anything else kept raw (GAS). */
export function parseVerification(v) {
  if (v && typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : { raw: String(v) };
  } catch { return { raw: String(v) }; }
}

/** approvePurchaseRequest after the row is found (GAS checks 6–12, same order and wording). */
export function applyApprove(pr, meta = {}, { email, role, note = '', signature = '', verification = null, at }) {
  const r = lower(role);
  const me = lower(email);
  if (!isRole(r)) return { error: BAD_ROLE };
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối, không thể duyệt.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị này đã được duyệt rồi.' };
  if (isReturned(pr.status)) return { error: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.' };
  if (!emailOf(pr, r)) return { error: `Vai trò "${r}" chưa được phân công cho đề nghị này.` };
  if (emailOf(pr, r) !== me) return { error: `Bạn không được phân công là người duyệt "${r}" cho đề nghị này.` };
  const before = approvalState(pr, meta);
  if (ROLE_STAGE[r] !== before.stage) return { error: `Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: ${STAGE_LABEL[before.stage]}.` };
  if (meta[`${r}Status`] === 'Approved') return { error: 'Bạn đã duyệt đề nghị này rồi.' };
  // One approval covers every open slot this person holds in the same stage (decision 2026-10-07, GAS B12).
  const roles = ROLES.filter((x) => ROLE_STAGE[x] === before.stage && emailOf(pr, x) === me && meta[`${x}Status`] !== 'Approved');
  const next = { ...meta };
  for (const x of roles) {
    next[`${x}Status`] = 'Approved';
    next[`${x}ApprovedAt`] = at;
    next[`${x}Note`] = note || '';
    if (signature) next[`${x}Signature`] = signature;
    if (verification != null && verification !== '') next[`${x}SignatureVerification`] = parseVerification(verification);
  }
  const after = approvalState(pr, next);
  return { meta: next, roles, before, after, status: after.statusLabel };
}

/** rejectPurchaseRequest after the row is found (GAS checks 5–9: permission, turn, then status). */
export function applyReject(pr, meta = {}, { email, note = '', at }) {
  const me = lower(email);
  const mine = ROLES.filter((r) => emailOf(pr, r) === me);
  if (!mine.length) return { error: 'Bạn không có quyền từ chối đề nghị này.' };
  const { stage } = approvalState(pr, meta);
  const role = mine.find((r) => ROLE_STAGE[r] === stage);
  if (!role) return { error: 'Chưa đến lượt của bạn trong quy trình phê duyệt.' };
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối rồi.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị đã được duyệt, không thể từ chối.' };
  if (isReturned(pr.status)) return { error: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.' };
  return { role, meta: { ...meta, rejectedAt: at, rejectedBy: me, rejectionNote: note || '' }, status: STATUS.REJECTED };
}

/** sendBackPurchaseRequest checks 3–5 (before the lookup). */
export function sendBackInputError({ sentBackNote, targetStep, approverRole }) {
  if (!String(sentBackNote || '').trim()) return 'Vui lòng nhập lý do trả lại.';
  if (![1, 2, 3].includes(Number(targetStep))) return 'Bước trả lại không hợp lệ.';
  if (!isRole(approverRole)) return 'Vai trò không hợp lệ.';
  return null;
}

/** sendBackPurchaseRequest after the row is found (GAS checks 8–13: turn before assignment). */
export function applySendBack(pr, meta = {}, { email, role, targetStep, note, at }) {
  const r = lower(role);
  const step = Number(targetStep);
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị này đã hoàn thành.' };
  if (isReturned(pr.status)) return { error: 'Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.' };
  if (ROLE_STAGE[r] !== approvalState(pr, meta).stage) return { error: 'Chưa đến lượt của bạn trong quy trình phê duyệt.' };
  if (emailOf(pr, r) !== lower(email)) return { error: `Bạn không được phân công vai trò "${r}" cho đề nghị này.` };
  if (step > MAX_SEND_BACK[r]) return { error: 'Bước trả lại không hợp lệ với vai trò của bạn.' };
  const history = Array.isArray(meta.sentBackHistory) ? meta.sentBackHistory : [];
  const next = { ...meta, sentBackHistory: [...history, { targetStep: step, by: lower(email), byRole: r, at, note: String(note || '').trim() }] };
  if (step === 1) return { meta: next, status: STATUS.RETURNED };
  for (const x of ROLES) {
    if (next[`${x}Status`] && next[`${x}Status`] !== 'N/A') {
      next[`${x}Status`] = 'Pending';
      delete next[`${x}ApprovedAt`];
      delete next[`${x}Note`];
    }
  }
  return { meta: next, status: STATUS.PARALLEL };
}

const PICK_LABEL = { budget: 'Người phê duyệt ngân sách', supplier: 'Người phê duyệt NCC', contract: 'Người thẩm định hợp đồng' };
/**
 * The requester's picks must come from the lists the page offers (GAS trusted any email, S3).
 * requesterEmail (4th arg) is required (fail closed). The requester may pick themselves (Plan 5c).
 */
export function approverPickError(picks, { companyEmails, purchasingEmails }, branch, requesterEmail = '') {
  if (!lower(requesterEmail)) return MISSING_REQUESTER_ERROR;
  for (const r of ['budget', 'supplier', 'contract']) {
    const e = lower(picks[r]);
    if (r === 'contract' && (branch !== 'full' || !e)) continue;
    if (!companyEmails.has(e)) {
      return `${PICK_LABEL[r]} (${e}) không thuộc danh sách người duyệt của công ty này (Đại diện pháp luật, Kế toán trưởng, Thủ quỹ).`;
    }
  }
  const p = lower(picks.purchasing);
  if (p && !purchasingEmails.has(p)) return `Người mua hàng (${p}) không thuộc phòng Kế Toán Chi.`;
  return null;
}

/** GAS _validatePRForDirectPayment_ PR-side rules (the payment check is the caller's). */
export function directPaymentProblem(row) {
  if (row.status !== STATUS.DONE) return 'PR chưa được phê duyệt hoàn tất.';
  if (branchOf(row) !== 'simplified') {
    return 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.';
  }
  return null;
}
