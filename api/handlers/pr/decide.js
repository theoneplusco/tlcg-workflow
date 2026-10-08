// api/handlers/pr/decide.js — approve / reject / send back a purchase request on Postgres.
// Rules: api/lib/purchase-requests/state.js. Who acts: the login token (never the body's email).
import { STATUS, isRole, BAD_ROLE, applyApprove, applyReject, sendBackInputError, applySendBack, pendingEmails, approvalState } from '../../lib/purchase-requests/state.js';
import { getPR, updatePR, recordChange } from '../../lib/purchase-requests/repo.js';
import { purchasingRequest, completed, rejectedNotice, sendBackNotices } from '../../lib/purchase-requests/emails.js';
import { fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { NO_SAMPLE } from '../../lib/approval/signature-check.js';
import { confirmPassword, verificationRecord, makeStamper, stampStillCurrent } from '../../lib/approval/step-up.js';
import { prDeps, withLockedPR, RETRY } from './tx.js';
import { autoAdvancePR, settleStamps, withoutConsentStamps } from './auto.js';

/** Login, PR number, body email = caller. Returns { caller, prNo, b } or null after answering. */
async function start(req, res, who, claimedKey = 'approverEmail') {
  const caller = await signedInCaller(req, res, who);
  if (!caller) return null;
  const b = req.body || {};
  const prNo = String(b.prNo || '').trim();
  if (!prNo) { fail(res, 'Thiếu số phiếu mua hàng.'); return null; }
  const claim = claimProblem(caller, b[claimedKey]);
  if (claim) { fail(res, claim); return null; }
  return { caller, prNo, b };
}

/**
 * Decision 2026-10-07 (option D): the login password of the signed-in caller confirms who approves, and the
 * server stamps their registered sample (company role sample, else Master Employee Signature). The client sends
 * no signature or verification any more; old rows keep theirs. Order: login → PR number → role → password (no
 * lock, nothing written on a wrong or locked one) → sample loaded outside the lock → lock, GAS rules, sample
 * unchanged → write. A sample that changed while loading is retried once, then refused with NO_SAMPLE.
 */
export async function handlePRApprove(req, res, d) {
  const { db, redis, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  if (!isRole(b.approverRole)) return fail(res, BAD_ROLE);
  const pw = await confirmPassword({ db, redis, email: caller.email, password: b.approverPassword, lang: 'vi' });
  if (!pw.ok) return fail(res, pw.message);
  const stamper = makeStamper('vi');
  const rule = (row, at) => applyApprove(row, row.metadata || {}, { email: caller.email, role: b.approverRole, note: b.note || '', at });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Outside the lock: the sample of someone whose turn it is (the rules answer first, never "no sample")
    const peek = await getPR(db, prNo);
    const pre = peek && !rule(peek, now().toISOString()).error ? await stamper(db, peek.company_id, null, caller.email) : null;
    const out = await withLockedPR(db, prNo, res, async (client, row) => {
      const at = now().toISOString();
      const check = rule(row, at); // GAS rules first: turn, assignment, status
      if (check.error) return check;
      if (!(await stampStillCurrent(client, pre, row.company_id, null, caller.email))) return { retry: true };
      if (!pre.ok) return { error: pre.message };
      const r = applyApprove(row, row.metadata || {}, { email: caller.email, role: b.approverRole, note: b.note || '', at,
        signature: pre.signature, verification: verificationRecord(pre.from, at) }); // one stamp on every slot this approval covers
      const meta = settleStamps(row, r.meta, r.status); // final, or no own slot left: the stamp copy is no longer needed
      const saved = await updatePR(client, row.id, { metadata: meta, status: r.status, pending_emails: pendingEmails(row, meta, r.status) });
      const extra = { auth: 'password', signatureStamped: true, sampleFrom: pre.from };
      await recordChange(client, saved, r.roles.map((role) => ({ action: 'Approve', role, actorEmail: caller.email, actorName: caller.name,
        prevStatus: row.status, newStatus: r.status, note: b.note || '', extra, at })));
      // Plan 5c: the requester's own next slot(s), when they consented at submit — same commit, real time
      const { state: final } = await autoAdvancePR(client, saved, now);
      const stage = approvalState(final, final.metadata || {}).stage;
      const mails = [];
      if (stage === 'purchasing' && r.before.stage !== 'purchasing') mails.push(purchasingRequest(final)); // both branches (B2)
      if (stage === 'complete') mails.push(completed(final));
      return { saved: final, mails, message: 'Đã duyệt thành công.', fields: { prNo: final.pr_no, status: final.status } };
    });
    if (out !== RETRY) return out;
  }
  return fail(res, NO_SAMPLE.vi);
}

export async function handlePRReject(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applyReject(row, row.metadata || {}, { email: caller.email, note: String(b.note || '').trim(), at });
    if (r.error) return r;
    const meta = withoutConsentStamps(r.meta); // final: the self-approval stamp copy is no longer needed
    const saved = await updatePR(client, row.id, { metadata: meta, status: STATUS.REJECTED, pending_emails: [] });
    await recordChange(client, saved, { action: 'Reject', role: r.role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: STATUS.REJECTED, note: r.meta.rejectionNote, at });
    return { saved, mails: [rejectedNotice(saved, { by: caller.name || caller.email, note: r.meta.rejectionNote })],
      message: 'Đã từ chối thành công.', fields: { prNo: saved.pr_no, status: STATUS.REJECTED } };
  });
}

export async function handlePRSendBack(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  const inputError = sendBackInputError(b);
  if (inputError) return fail(res, inputError);
  const role = String(b.approverRole).trim().toLowerCase();
  const targetStep = Number(b.targetStep);
  const note = String(b.sentBackNote).trim();
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applySendBack(row, row.metadata || {}, { email: caller.email, role, targetStep, note, at });
    if (r.error) return r;
    // Any send-back voids the consent (decision 2 reversed): the requester re-approves by hand or consents again at resubmit
    const meta = withoutConsentStamps(r.meta);
    const saved = await updatePR(client, row.id, { metadata: meta, status: r.status, pending_emails: pendingEmails(row, meta, r.status) });
    await recordChange(client, saved, { action: 'Return', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note, extra: { targetStep }, at });
    return { saved, mails: sendBackNotices(saved, { targetStep, byRole: role, note }),
      message: 'Đã trả lại thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
}
