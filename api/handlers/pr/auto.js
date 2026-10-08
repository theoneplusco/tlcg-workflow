// api/handlers/pr/auto.js — Plan 5c: the requester's own PR slots, auto-approved inside the caller's transaction
// (after submit, resubmit and every approval). One approval covers every open slot of the
// requester in the stage (applyApprove's same-person merge); each is stamped with the sample confirmed at submit.
// Only DB work here (stampStillCurrent): this runs under the PR row lock.
import { autoAdvance, consentFor, recordAuto } from '../../lib/approval/self-approval.js';
import { verificationRecord } from '../../lib/approval/step-up.js';
import { applyApprove, pendingEmails, prOwnOpen, prOwnLeft, sentBackRound, isTerminal } from '../../lib/purchase-requests/state.js';
import { updatePR, recordChange } from '../../lib/purchase-requests/repo.js';

/**
 * The consent that applies to this PR row. The submitter is requester_email: submit and resubmit write it from the
 * login token (submissionColumns: requester_email = caller.email), never from the body or metadata.requesterEmail.
 */
export const prConsentOf = (r) => consentFor(r.metadata, { submitterEmail: r.requester_email, round: sentBackRound(r.metadata), ref: r.pr_no });

/** The consent without its stored stamp copy (the PR is final, or a send-back voided the consent). */
export function withoutConsentStamps(meta) {
  const c = meta && meta.selfApproval;
  return c && Array.isArray(c.stamps) && c.stamps.length ? { ...meta, selfApproval: { ...c, stamps: [] } } : meta;
}
/** After a manual approval: drop the stamp copy once the PR is final or the consenting submitter has no unapproved own slot left. */
export function settleStamps(pr, meta, status) {
  const c = meta && meta.selfApproval;
  if (!c) return meta;
  return isTerminal(status) || !prOwnLeft(pr, meta, c.by) ? withoutConsentStamps(meta) : meta;
}

/** `row` = the PR as just written in this transaction. Returns { state: the PR as last written, auto }. */
export function autoAdvancePR(client, row, now = () => new Date()) {
  return autoAdvance(client, {
    state: row, companyId: row.company_id, now,
    consentOf: prConsentOf,
    pendingOwn: (r, me) => prOwnOpen(r, r.metadata || {}, me),
    approve: async (r, { consent, mine, stamp, at, note }) => {
      const a = applyApprove(r, r.metadata || {}, { email: consent.by, role: mine.roles[0], note, at,
        signature: stamp.signature, verification: verificationRecord(stamp.from, at) });
      if (a.error) throw new Error(`self-approval refused: ${a.error}`); // rolls back; never half-written
      if (mine.roles.some((x) => !a.roles.includes(x))) throw new Error('self-approval did not cover every own slot of the stage');
      const metadata = { ...a.meta, selfApproval: recordAuto(consent, mine, at, !isTerminal(a.status) && prOwnLeft(r, a.meta, consent.by)) };
      const saved = await updatePR(client, r.id, { metadata, status: a.status, pending_emails: pendingEmails(r, metadata, a.status) });
      const extra = { auth: 'password', signatureStamped: true, sampleFrom: stamp.from, auto: true, consentedAt: consent.consentedAt };
      await recordChange(client, saved, a.roles.map((role) => ({ action: 'Approve', role, actorEmail: consent.by,
        // actor name: the token name stored at submit, never the body's requester name
        actorName: consent.byName || consent.by, prevStatus: r.status, newStatus: a.status, note, extra, at })));
      return saved;
    },
  });
}
