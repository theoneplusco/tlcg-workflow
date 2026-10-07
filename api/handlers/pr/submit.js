// api/handlers/pr/submit.js — purchaseRequest and resubmitPurchaseRequest on Postgres.
// Wire contract: TLCG_P2P_BACKEND.gs handlePurchaseRequest (spec §3.1); differences are listed in the plan.
import { findCompany } from '../../lib/vouchers/repo.js';
import { queueMail } from '../email-queue.js';
import { publishEvent } from '../sse.js';
import { STATUS, approverEmails, pendingEmails, approverPickError, isReturned } from '../../lib/purchase-requests/state.js';
import { checkSubmission, buildMetadata, normalizePriority } from '../../lib/purchase-requests/validate.js';
import { parseAttachmentList, storeAttachments } from '../../lib/purchase-requests/attachments.js';
import { allocatePRNo, prefixFor } from '../../lib/purchase-requests/numbering.js';
import { insertPR, updatePR, getPR, recordChange, approverCandidates } from '../../lib/purchase-requests/repo.js';
import { approvalRequests, submitConfirmation, resubmitNotices } from '../../lib/purchase-requests/emails.js';
import { ok, fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { prDeps, withLockedPR } from './tx.js';

const str = (v) => String(v ?? '').trim();

/** GAS checks, the company, then the server check of the requester's (caller's) approver picks. */
export async function prepareSubmission(db, b, caller) {
  const sub = checkSubmission(b);
  if (sub.error) return sub;
  const company = await findCompany(db, b.companyName, b.companyKey);
  if (!company) return { error: 'Không tìm thấy công ty trong Dữ liệu gốc: ' + str(b.companyName) };
  const pickError = approverPickError(sub.picks, await approverCandidates(db, company), sub.branch, caller && caller.email); // required: fails closed, refuses self-picks (decision #3)
  return pickError ? { error: pickError } : { company, sub };
}

/** The columns submit and resubmit both write (status back to the parallel stage, approvals from `metadata`). */
export function submissionColumns(b, { company, sub, caller, metadata, attachments }) {
  const row = {
    company_id: company.id, company_name: str(b.companyName), company_key: str(b.companyKey) || company.company_key || '',
    department: str(b.department), requester_name: str(b.requesterName), requester_email: caller.email,
    required_date: str(b.requiredDate), priority: normalizePriority(b.priority), purpose: str(b.purpose),
    vendor_name: str(b.vendorName || b.suggestedVendor), budget_code: str(b.budgetCode),
    budget_approver_email: sub.picks.budget, supplier_approver_email: sub.picks.supplier,
    contract_approver_email: sub.picks.contract, purchasing_approver_email: sub.picks.purchasing,
    items: sub.items, grand_total: sub.grandTotal, currency: str(b.currency) || 'VND', status: STATUS.PARALLEL,
    p2p_branch: sub.branch, purchase_type: sub.purchaseType, attachments, metadata,
  };
  row.approver_emails = approverEmails(row);
  row.pending_emails = pendingEmails(row, metadata, STATUS.PARALLEL);
  return row;
}

export async function handlePRSubmit(req, res, d) {
  const { db, s3, who, now } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    const prep = await prepareSubmission(db, b, caller);
    if (prep.error) return fail(res, prep.error);
    const { company, sub } = prep;
    const attachments = await storeAttachments(s3, parseAttachmentList(b.attachments)); // before the transaction
    const at = now();
    const metadata = buildMetadata(b, { companyKey: str(b.companyKey) || company.company_key, requesterEmail: caller.email,
      submittedAt: at.toISOString(), attachments, purchaseType: sub.purchaseType, branch: sub.branch, picks: sub.picks });
    const client = await db.connect();
    let row;
    try {
      await client.query('BEGIN');
      const prNo = await allocatePRNo(client, { prefix: prefixFor(company, b.prNo), requested: b.prNo, now: at });
      row = await insertPR(client, { pr_no: prNo, ...submissionColumns(b, { company, sub, caller, metadata, attachments }), submitted_at: at.toISOString() });
      await recordChange(client, row, { action: 'Submit', role: 'requester', actorEmail: caller.email, actorName: row.requester_name,
        prevStatus: '', newStatus: STATUS.PARALLEL, note: row.purpose, extra: { purchaseType: row.purchase_type, p2pBranch: row.p2p_branch }, at: at.toISOString() });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    for (const m of [...approvalRequests(row), submitConfirmation(row)].filter(Boolean)) await queueMail(m, db);
    publishEvent('pr:submitted', { prNo: row.pr_no, status: row.status });
    return ok(res, 'Đề nghị mua hàng đã được gửi thành công.', { prNo: row.pr_no });
  } catch (err) {
    console.error('[PR] submit:', err.message);
    return fail(res, 'Lỗi khi lưu đề nghị mua hàng: ' + err.message);
  }
}

/** resubmitPurchaseRequest (spec §3.8). submittedAt from the page is ignored: pr_no is unique (B1). */
export async function handlePRResubmit(req, res, d) {
  const { db, s3, who, now } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const prNo = str(b.prNo);
  if (!prNo) return fail(res, 'Thiếu số phiếu mua hàng.');
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    // Same checks as submit; picks re-checked against the caller (token) as requester: no self-approval.
    const prep = await prepareSubmission(db, b, caller);
    if (prep.error) return fail(res, prep.error);
    if (!(await getPR(db, prNo))) return fail(res, `Không tìm thấy đề nghị: ${prNo}`);
    const uploaded = await storeAttachments(s3, parseAttachmentList(b.attachments)); // S3 never runs under the row lock
    return await withLockedPR(db, prNo, res, async (client, row) => {
      if (!isReturned(row.status)) return { error: 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".' };
      const owner = str(row.requester_email || (row.metadata || {}).requesterEmail).toLowerCase();
      if (owner && owner !== caller.email) return { error: 'Bạn không phải người đề nghị ban đầu của phiếu này.' };
      const old = row.metadata || {};
      const at = now().toISOString();
      // The page cannot resend or remove the files already on the PR: keep them, add the new ones (decision #7).
      const attachments = [...(row.attachments || []), ...uploaded];
      const count = (Number(old.resubmitCount) || 0) + 1;
      const metadata = {
        ...buildMetadata(b, { companyKey: str(b.companyKey) || prep.company.company_key, requesterEmail: caller.email,
          submittedAt: old.submittedAt || new Date(row.submitted_at).toISOString(), attachments,
          purchaseType: prep.sub.purchaseType, branch: prep.sub.branch, picks: prep.sub.picks }),
        sentBackHistory: Array.isArray(old.sentBackHistory) ? old.sentBackHistory : [],
        resubmittedAt: at, resubmitCount: count,
      };
      const saved = await updatePR(client, row.id, submissionColumns(b, { ...prep, caller, metadata, attachments }));
      await recordChange(client, saved, { action: 'Resubmit', role: 'requester', actorEmail: caller.email, actorName: saved.requester_name,
        prevStatus: row.status, newStatus: STATUS.PARALLEL, note: `Gửi lại lần ${count}`,
        extra: { purchaseType: saved.purchase_type, p2pBranch: saved.p2p_branch }, at });
      return { saved, mails: resubmitNotices(saved), message: 'Đã gửi lại đề nghị thành công.', fields: { prNo: saved.pr_no } };
    });
  } catch (err) {
    console.error('[PR] resubmit:', err.message);
    return fail(res, 'Lỗi khi lưu đề nghị mua hàng: ' + err.message);
  }
}
