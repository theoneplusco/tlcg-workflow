// api/handlers/pr/decide.js — approve / reject / send back a purchase request on Postgres.
// Rules: api/lib/purchase-requests/state.js. Who acts: the login token (never the body's email).
import { STATUS, isRole, BAD_ROLE, applyApprove, applyReject, sendBackInputError, applySendBack, pendingEmails, parseVerification } from '../../lib/purchase-requests/state.js';
import { updatePR, recordChange } from '../../lib/purchase-requests/repo.js';
import { purchasingRequest, completed, rejectedNotice, sendBackNotices } from '../../lib/purchase-requests/emails.js';
import { fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { signatureProblem, sampleSignatureFor, NO_SAMPLE } from '../../lib/approval/signature-check.js';
import { prDeps, withLockedPR } from './tx.js';

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

const verificationText = (v) => (v == null || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v));

export async function handlePRApprove(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  if (!isRole(b.approverRole)) return fail(res, BAD_ROLE);
  // Decision #13, as vouchers: a signature the browser verified against the registered sample (GAS S5 stored anything).
  const raw = b.signatureVerification;
  const verification = raw == null || raw === '' ? null : parseVerification(raw);
  const sigErr = signatureProblem('vi', b.approverSignature, verification);
  if (sigErr) return fail(res, sigErr);
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applyApprove(row, row.metadata || {}, { email: caller.email, role: b.approverRole, note: b.note || '',
      signature: b.approverSignature, verification, at });
    if (r.error) return r;
    // No registered sample = nothing the browser could have verified against: refuse (GAS let "no_sample" through).
    if (!(await sampleSignatureFor(client, row.company_id, null, caller.email)).url) return { error: NO_SAMPLE.vi };
    // A sample exists, so "no_sample" means the page never compared against it (e.g. it fell back to the list card): refuse.
    if (verification && verification.reason === 'no_sample') return { error: 'Không xác minh được chữ ký. Vui lòng tải lại trang và thử lại.' };
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: r.status, pending_emails: pendingEmails(row, r.meta, r.status) });
    const extra = { signatureUploaded: true, verification: verificationText(raw) };
    await recordChange(client, saved, r.roles.map((role) => ({ action: 'Approve', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note: b.note || '', extra, at })));
    const mails = [];
    if (r.after.stage === 'purchasing' && r.before.stage !== 'purchasing') mails.push(purchasingRequest(saved)); // both branches (B2)
    if (r.after.stage === 'complete') mails.push(completed(saved));
    return { saved, mails, message: 'Đã duyệt thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
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
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: STATUS.REJECTED, pending_emails: [] });
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
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: r.status, pending_emails: pendingEmails(row, r.meta, r.status) });
    await recordChange(client, saved, { action: 'Return', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note, extra: { targetStep }, at });
    return { saved, mails: sendBackNotices(saved, { targetStep, byRole: role, note }),
      message: 'Đã trả lại thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
}
