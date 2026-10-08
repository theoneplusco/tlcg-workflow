// api/handlers/pr/submit.js — purchaseRequest and resubmitPurchaseRequest on Postgres.
// Wire contract: TLCG_P2P_BACKEND.gs handlePurchaseRequest (spec §3.1); differences are listed in the plan.
import { findCompany } from '../../lib/vouchers/repo.js';
import { queueMail } from '../email-queue.js';
import { publishEvent } from '../sse.js';
import { STATUS, approverEmails, pendingEmails, approverPickError, isReturned, prOwnSteps, picksAsRow, sentBackRound } from '../../lib/purchase-requests/state.js';
import { checkSubmission, buildMetadata, normalizePriority } from '../../lib/purchase-requests/validate.js';
import { parseAttachmentList, storeAttachments } from '../../lib/purchase-requests/attachments.js';
import { allocatePRNo, prefixFor } from '../../lib/purchase-requests/numbering.js';
import { insertPR, updatePR, getPR, recordChange, approverCandidates } from '../../lib/purchase-requests/repo.js';
import { openStageRequests, submitConfirmation } from '../../lib/purchase-requests/emails.js';
import { ok, fail, signedInCaller, claimProblem, SYSTEM_ERROR } from '../../lib/purchase-requests/respond.js';
import { prDeps, withLockedPR } from './tx.js';
import { normalizeCurrency, getRateToVnd } from '../../lib/fx/rates.js';
import { requestConsent, askBody, doneText, publicAuto } from '../../lib/approval/self-approval.js';
import { autoAdvancePR } from './auto.js';

const str = (v) => String(v ?? '').trim();

/**
 * GAS checks, the company, then the server check of the requester's (caller's) approver picks. The branch is on
 * the VND total with the admin rate of the day (stored on the PR); `known.rateToVnd` skips the lookup.
 */
export async function prepareSubmission(db, b, caller, known = null) {
  const currency = normalizeCurrency(b.currency);
  const rateToVnd = known ? known.rateToVnd : currency ? await getRateToVnd(db, currency) : null;
  const sub = checkSubmission(b, { currency, rateToVnd });
  if (sub.error) return sub;
  const company = await findCompany(db, b.companyName, b.companyKey);
  if (!company) return { error: 'Không tìm thấy công ty trong Dữ liệu gốc: ' + str(b.companyName) };
  const pickError = approverPickError(sub.picks, await approverCandidates(db, company), sub.branch, caller && caller.email); // required: fails closed; self-picks allowed (Plan 5c)
  return pickError ? { error: pickError } : { company, sub };
}

/**
 * Inside the write transaction: the rate again, FOR SHARE. The admin delete locks the rate row FOR UPDATE and
 * refuses while a PR uses the currency, so a PR never commits in a currency removed at the same moment. When the
 * rate changed (or vanished) since `prep`, everything is checked again with the locked rate.
 */
async function lockedSubmission(client, b, caller, prep) {
  const rateToVnd = await getRateToVnd(client, prep.sub.currency, { lock: true });
  return rateToVnd === prep.sub.rateToVnd ? prep : prepareSubmission(client, b, caller, { rateToVnd });
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
    items: sub.items, grand_total: sub.grandTotal, currency: sub.currency, fx_rate: sub.rateToVnd, grand_total_vnd: sub.grandTotalVnd,
    status: STATUS.PARALLEL,
    p2p_branch: sub.branch, purchase_type: sub.purchaseType, attachments, metadata,
  };
  row.approver_emails = approverEmails(row);
  row.pending_emails = pendingEmails(row, metadata, STATUS.PARALLEL);
  return row;
}

/**
 * Plan 5c: the caller's (token) own slots among the picks — asked and confirmed before any upload, transaction or
 * lock (password check, stamp loaded and kept in the consent). `ref` = the PR number when known (resubmit); on a
 * submit the number is allocated in the transaction and set on the consent there.
 */
async function prConsent({ db, redis, now }, b, caller, { company, sub }, { round = 0, ref = null } = {}) {
  const sa = await requestConsent({ db, redis, email: caller.email, password: b.selfApprovalPassword, declined: b.selfApprovalDeclined,
    own: prOwnSteps(picksAsRow(sub.picks), caller.email), companyId: company.id, lang: 'vi', at: now().toISOString(), round, ref });
  // The submitter's name from the login token: the audit actor of the auto-approvals (never the body's requesterName)
  return sa.consent ? { ...sa, consent: { ...sa.consent, byName: caller.name || caller.email } } : sa;
}
const withAuto = (message, auto) => (auto.length ? `${message} ${doneText(auto)}` : message);
const autoFields = (auto) => (auto.length ? { autoApproved: publicAuto(auto) } : {});

export async function handlePRSubmit(req, res, d) {
  const { db, s3, who, now, redis } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    const early = await prepareSubmission(db, b, caller);
    if (early.error) return fail(res, early.error);
    const sa = await prConsent({ db, redis, now }, b, caller, early);
    if (sa.ask) return res.json(askBody(sa));
    const attachments = await storeAttachments(s3, parseAttachmentList(b.attachments)); // before the transaction
    const at = now();
    const client = await db.connect();
    let row; let auto = [];
    try {
      await client.query('BEGIN');
      const prep = await lockedSubmission(client, b, caller, early);
      if (prep.error) {
        await client.query('ROLLBACK');
        return fail(res, prep.error);
      }
      const { company, sub } = prep;
      const metadata = buildMetadata(b, { companyKey: str(b.companyKey) || company.company_key, requesterEmail: caller.email,
        submittedAt: at.toISOString(), attachments, purchaseType: sub.purchaseType, branch: sub.branch, picks: sub.picks });
      const prNo = await allocatePRNo(client, { prefix: prefixFor(company, b.prNo), requested: b.prNo, now: at });
      if (sa.consent) metadata.selfApproval = { ...sa.consent, ref: prNo }; // bound to this PR number
      row = await insertPR(client, { pr_no: prNo, ...submissionColumns(b, { company, sub, caller, metadata, attachments }), submitted_at: at.toISOString() });
      await recordChange(client, row, { action: 'Submit', role: 'requester', actorEmail: caller.email, actorName: row.requester_name,
        prevStatus: '', newStatus: STATUS.PARALLEL, note: row.purpose, extra: { purchaseType: row.purchase_type, p2pBranch: row.p2p_branch }, at: at.toISOString() });
      ({ state: row, auto } = await autoAdvancePR(client, row, now)); // the requester's own step-2 slots, same commit
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    for (const m of [...openStageRequests(row), submitConfirmation(row, auto)].filter(Boolean)) await queueMail(m, db);
    publishEvent('pr:submitted', { prNo: row.pr_no, status: row.status });
    return ok(res, withAuto('Đề nghị mua hàng đã được gửi thành công.', auto), { prNo: row.pr_no, ...autoFields(auto) });
  } catch (err) {
    console.error('[PR] submit:', err.message);
    return fail(res, SYSTEM_ERROR);
  }
}

/** Who may resubmit this row: only a returned PR, only by its requester (fails closed when the PR names none). */
function resubmitProblem(row, caller) {
  if (!isReturned(row.status)) return 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".';
  const owner = str(row.requester_email || (row.metadata || {}).requesterEmail).toLowerCase();
  if (!owner || owner !== caller.email) return 'Bạn không phải người đề nghị ban đầu của phiếu này.';
  return null;
}

/** resubmitPurchaseRequest (spec §3.8). submittedAt from the page is ignored: pr_no is unique (B1). */
export async function handlePRResubmit(req, res, d) {
  const { db, s3, who, now, redis } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const prNo = str(b.prNo);
  if (!prNo) return fail(res, 'Thiếu số phiếu mua hàng.');
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    // Same checks as submit; picks re-checked against the caller (token) as requester (self-picks allowed, Plan 5c).
    const prep = await prepareSubmission(db, b, caller);
    if (prep.error) return fail(res, prep.error);
    const current = await getPR(db, prNo);
    if (!current) return fail(res, `Không tìm thấy đề nghị: ${prNo}`);
    const early = resubmitProblem(current, caller); // before any upload: refused callers never write to R2
    if (early) return fail(res, early);
    // A resubmit is a new version: consent is asked again (the old one is gone with the old metadata)
    const sa = await prConsent({ db, redis, now }, b, caller, prep, { round: sentBackRound(current.metadata), ref: current.pr_no });
    if (sa.ask) return res.json(askBody(sa));
    const uploaded = await storeAttachments(s3, parseAttachmentList(b.attachments)); // S3 never runs under the row lock
    return await withLockedPR(db, prNo, res, async (client, row) => {
      const problem = resubmitProblem(row, caller); // re-checked under the lock
      if (problem) return { error: problem };
      const locked = await lockedSubmission(client, b, caller, prep);
      if (locked.error) return { error: locked.error };
      const old = row.metadata || {};
      const at = now().toISOString();
      const submittedAt = old.submittedAt || (row.submitted_at ? new Date(row.submitted_at).toISOString() : at);
      // The page cannot resend or remove the files already on the PR: keep them, add the new ones (decision #7).
      const attachments = [...(row.attachments || []), ...uploaded];
      const count = (Number(old.resubmitCount) || 0) + 1;
      const metadata = {
        ...buildMetadata(b, { companyKey: str(b.companyKey) || locked.company.company_key, requesterEmail: caller.email,
          submittedAt, attachments,
          purchaseType: locked.sub.purchaseType, branch: locked.sub.branch, picks: locked.sub.picks }),
        sentBackHistory: Array.isArray(old.sentBackHistory) ? old.sentBackHistory : [],
        resubmittedAt: at, resubmitCount: count,
        ...(sa.consent ? { selfApproval: sa.consent } : {}),
      };
      const saved = await updatePR(client, row.id, submissionColumns(b, { ...locked, caller, metadata, attachments }));
      await recordChange(client, saved, { action: 'Resubmit', role: 'requester', actorEmail: caller.email, actorName: saved.requester_name,
        prevStatus: row.status, newStatus: STATUS.PARALLEL, note: `Gửi lại lần ${count}`,
        extra: { purchaseType: saved.purchase_type, p2pBranch: saved.p2p_branch }, at });
      const { state: final, auto } = await autoAdvancePR(client, saved, now);
      return { saved: final, mails: openStageRequests(final, 'resubmit'), message: withAuto('Đã gửi lại đề nghị thành công.', auto),
        fields: { prNo: final.pr_no, ...autoFields(auto) } };
    });
  } catch (err) {
    console.error('[PR] resubmit:', err.message);
    return fail(res, SYSTEM_ERROR);
  }
}
