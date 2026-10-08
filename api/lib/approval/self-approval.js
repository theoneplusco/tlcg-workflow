// api/lib/approval/self-approval.js — Plan 5c (user decision 2026-10-08, memory project_self_approval.md).
// When the requester is also an approver of their own request, they confirm with their login password ONCE at
// submit (or resubmit). Each of their steps is then approved automatically when the request reaches it — in order,
// never ahead of an earlier step — with their registered sample stamped and the note "Tự động duyệt khi gửi phiếu".
// Shared by vouchers and purchase requests; payment requests (Plan 6) and acceptance minutes / contracts (Plan 7)
// use it the same way. Takes db/client/redis as arguments (no pool import).
//
// The stamp is loaded at submit and kept in the consent record (metadata.selfApproval.stamps): an auto-approval
// usually happens inside ANOTHER approver's transaction, where fetching would hold that row lock (Plan 5b forbids
// it) and tie their approval to the requester's sample. Under the lock only stampStillCurrent (a DB lookup) checks
// the sample is unchanged; a changed sample stops the auto-advance and the step is approved by hand.
import { confirmPassword, stampSignature, stampStillCurrent } from './step-up.js';
import { pendingStep } from './engine.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (t, a) => t.replace('{0}', a);
const MAX_AUTO = 50; // more steps than any plan has: a broken adapter can never loop forever

export const SELF_MSG = {
  vi: {
    prompt: 'Bạn cũng là người duyệt bước {0} của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.',
    noSampleHint: 'Bạn có thể bấm "Bỏ qua, tôi duyệt sau" để gửi phiếu và tự duyệt sau.',
    planChanged: 'Quy trình duyệt của phiếu vừa thay đổi. Vui lòng xác nhận lại.',
    and: ' và ',
    note: 'Tự động duyệt khi gửi phiếu (người đề nghị là {0})',
    done: 'Đã tự động duyệt bước {0} của bạn.',
    emailLine: 'Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu (đã xác nhận bằng mật khẩu): bước {0}.',
  },
  en: {
    prompt: 'You are also the approver of step {0} of this request. Enter your password to approve your steps automatically.',
    noSampleHint: 'You can choose "Skip, I will approve later" to submit now and approve your steps by hand.',
    planChanged: 'The approval flow of this request has just changed. Please confirm again.',
    and: ' and ',
  },
};
const L = (lang) => SELF_MSG[lang === 'en' ? 'en' : 'vi'];

/** "1 (Kế toán trưởng)", "1 (Kế toán trưởng) và 3 (Thủ quỹ)", "1 (A), 3 (B) và 5 (C)". */
export function stepsText(steps, lang = 'vi') {
  const items = steps.map((s) => `${s.step} (${s.labels.join(', ')})`);
  return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + L(lang).and + items[items.length - 1];
}
export const promptText = (steps, lang) => fill(L(lang).prompt, stepsText(steps, lang));
/** The history / audit note of one auto-approval (stored notes are always Vietnamese). */
export const selfNote = (labels) => fill(SELF_MSG.vi.note, labels.join(', '));
export const doneText = (auto) => fill(SELF_MSG.vi.done, stepsText(auto, 'vi'));
/** The line added to the requester's confirmation email ('' when nothing was auto-approved). */
export const selfEmailHtml = (auto) => (auto && auto.length ? `<p>${esc(fill(SELF_MSG.vi.emailLine, stepsText(auto, 'vi')))}</p>` : '');
export const publicAuto = (auto) => auto.map(({ step, labels }) => ({ step, labels }));
const pub = ({ step, key, labels }) => ({ step, key, labels });

/** Which stamp an own step uses: one per distinct set of roles ('person' = the employee's own sample; '*' = from the company emails). */
export const entriesKey = (entries) => (entries ? entries.map((e) => e.role || 'person').sort().join('+') : '*');

function ownOf(step, i, mine) {
  if (!mine.length) return null;
  return { step: i + 1, key: entriesKey(mine), entries: mine.map((a) => ({ role: a.role, label: a.label })),
    labels: mine.map((a) => a.label || step.name || `Bước ${i + 1}`) };
}

/** Engine plans (vouchers; payment requests in Plan 6): every step where `email` holds an entry, in order. */
export function planOwnSteps(plan, email) {
  const me = lower(email);
  if (!me || !plan) return [];
  return plan.steps.map((s, i) => ownOf(s, i, s.approvers.filter((a) => a.email === me))).filter(Boolean);
}

/** The requester's not-yet-approved entries on the OPEN step, or null. In a group step only their own entries. */
export function planOwnOpen(plan, email) {
  const me = lower(email);
  const i = plan ? pendingStep(plan) : -1;
  if (!me || i < 0) return null;
  return ownOf(plan.steps[i], i, plan.steps[i].approvers.filter((a) => a.email === me && a.status !== 'approved'));
}

/** Does `email` still have an entry to approve anywhere in the plan? */
export const planOwnLeft = (plan, email) => plan.steps.some((s) => s.approvers.some((a) => a.email === lower(email) && a.status !== 'approved'));

/** Same steps (number, stamp key, labels) as the requester confirmed? */
export const sameOwnSteps = (a, b) => JSON.stringify(a.map(pub)) === JSON.stringify((b || []).map(pub));

/**
 * At submit / resubmit, BEFORE any transaction or upload. `own` = the requester's steps (OwnStep[]).
 * Nothing to ask → { consent: null }; declined → { consent: null, declined: true }; no password, a wrong or
 * locked one, or no usable sample → { ask: { steps, prompt }, message } (the page asks again); else { consent }.
 * The password check is Plan 5b's confirmPassword: the same lockout counter as approvals.
 * `email` is ALWAYS the signed-in caller (token), never a body field. Controller decision 1 (2026-10-08): when the
 * submitter files for another employee, `own` are the submitter's steps and the consent (`by`) is the submitter's.
 */
export async function requestConsent({ db, redis, email, password, declined, own, companyId, round = 0, lang, at }) {
  const me = lower(email);
  if (!me || !own || !own.length) return { consent: null };
  const steps = own.map(pub);
  const ask = { steps, prompt: promptText(steps, lang) };
  if (typeof password !== 'string' || !password) {
    return declined === true || declined === 'true' ? { consent: null, declined: true } : { ask, message: ask.prompt };
  }
  const pw = await confirmPassword({ db, redis, email: me, password, lang });
  if (!pw.ok) return { ask, message: pw.message };
  const stamps = [];
  for (const o of own) {
    if (stamps.some((s) => s.key === o.key)) continue;
    const s = await stampSignature(db, companyId, o.entries, me, lang);
    if (!s.ok) return { ask, message: `${s.message} ${L(lang).noSampleHint}` };
    stamps.push({ key: o.key, companyId: companyId || null, url: s.url, from: s.from, signature: s.signature });
  }
  return { consent: { by: me, consentedAt: at, method: 'password', round, steps, stamps, auto: [] } };
}

/**
 * The consent stored on a request, if it still applies (same owner, same send-back round, a stamp left).
 * `requesterEmail` = whoever consented at submit: the signed-in submitter recorded on the request (controller
 * decision 1), which is the requester except when filing for someone else. `round` = the send-back count that voids
 * a consent; controller decision 2 (PR sent back to step 2 keeps consent) means the caller counts only the
 * send-backs that should void it, not step-2 ones.
 */
export function consentFor(meta, { requesterEmail, round = 0 }) {
  const c = meta && meta.selfApproval;
  if (!c || !c.by || c.by !== lower(requesterEmail) || (Number(c.round) || 0) !== round) return null;
  return Array.isArray(c.stamps) && c.stamps.some((s) => s && s.signature) ? c : null;
}

/**
 * The consent after one auto-approval: logged in `auto`; the stamp copy dropped when no own entry is `left`.
 * Controller decision 2: a caller whose own slots can be reset later (PR send-back to step 2) passes `left` true
 * until that can no longer happen, so the reset slot is auto-approved again from the stored stamp.
 */
export function recordAuto(consent, mine, at, left) {
  return { ...consent, auto: [...(consent.auto || []), { step: mine.step, labels: mine.labels, at }], stamps: left ? consent.stamps : [] };
}

/** Metadata for history rows and API views: the consent without the stamp images. Input not mutated. */
export function withoutStamps(meta) {
  const c = meta && meta.selfApproval;
  if (!c || !Array.isArray(c.stamps)) return meta;
  return { ...meta, selfApproval: { ...c, stamps: c.stamps.map(({ signature, ...rest }) => rest) } };
}

/**
 * Inside the caller's transaction, after a submit or any approval: while the consent applies and the open step holds
 * the requester's pending entry, approve it (the workflow's `approve` writes state, history, Sheet copy and audit)
 * and look again. A sample that changed since the consent stops the loop (DB lookup only, never a fetch).
 */
export async function autoAdvance(client, { state, companyId, consentOf, pendingOwn, approve, now = () => new Date() }) {
  const auto = [];
  for (let n = 0; n < MAX_AUTO; n += 1) {
    const consent = consentOf(state);
    if (!consent) break;
    const mine = pendingOwn(state, consent.by);
    if (!mine) break;
    const stamp = consent.stamps.find((s) => s.key === mine.key && s.signature) || null;
    if (!(await stampStillCurrent(client, stamp, companyId, mine.entries, consent.by))) break;
    const at = new Date(now()).toISOString();
    state = await approve(state, { consent, mine, stamp, at, note: selfNote(mine.labels) });
    auto.push({ step: mine.step, labels: mine.labels, at });
  }
  return { state, auto };
}

/** The submit answer that makes the page ask (nothing was saved). */
export const askBody = ({ ask, message }) => ({ success: false, needSelfApproval: true, message, selfApproval: ask });
/** The flow changed between the prompt and the transaction: ask again with the new steps. */
export const planChangedBody = (own, lang) => {
  const steps = own.map(pub);
  return askBody({ ask: { steps, prompt: promptText(steps, lang) }, message: L(lang).planChanged });
};
