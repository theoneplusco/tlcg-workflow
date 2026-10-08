# The Requester's Own Approval Steps Are Auto-Approved — Password Once at Submit, Across Workflows (Plan 5c of the GAS exit roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the user's decision of 2026-10-08 (memory `project_self_approval.md`) to the Postgres workflows. When the requester is an approver of any step of their own request, they confirm with their login password once, at submit or resubmit. Each of their steps is then approved automatically when the request reaches it:
- in order, never ahead of an earlier step;
- stamped with their registered sample (Plan 5b stamp);
- with the history and audit note `Tự động duyệt khi gửi phiếu (người đề nghị là <role>)` and the real time of the auto-approval.

The other rules:
- In a group step, only the requester's own entry is auto-approved.
- The requester gets no "please approve" email for a step that is auto-approved.
- If they cancel the prompt, the request is still submitted and they approve their own steps by hand.
- Purchase requests allow self-picks again. This replaces PR decision #3, `SELF_APPROVAL_ERROR` at pick time and in `applyApprove`.
- Old requests, which have no recorded consent, are approved by hand.
- GAS mode is unchanged.

Vouchers and purchase requests use it now. Payment requests (Plan 6), acceptance minutes and contracts (Plan 7) reuse the same server module.

**Architecture:**
- **One shared server module, `api/lib/approval/self-approval.js`:**
  - `requestConsent` checks the password with the Plan 5b `confirmPassword`, so it shares the same lockout counter. It loads the requester's stamp(s) with `stampSignature` and returns either a consent record or "ask the page".
  - `autoAdvance` is the workflow-neutral loop. While the open step holds the requester's pending entry and the consent is valid, it approves that entry and checks again.
  - Helpers: `planOwnSteps`, `planOwnOpen` and `planOwnLeft` for engine plans (vouchers now, payment requests in Plan 6). The texts, `askBody` and `withoutStamps`.
- **Each workflow gives the loop an adapter:**
  - Vouchers: `writeApproval`, extracted from `approveLocked`, is the single place that writes an approval (print fields, verification, state, history, Sheet copy, audit). The manual approval and the auto-approval both call it.
  - PRs: `api/handlers/pr/auto.js` uses `applyApprove`, so the same-person budget+supplier merge still applies, then `updatePR` and `recordChange`. `recordChange` also queues the Sheet copy.
- **Where the loop runs:** inside the existing transaction of submit and resubmit, and of every manual approval, single or bulk. An approval and the requester's next step(s) commit together. Emails are queued after commit from the final state.
- **Pages:**
  - `approval-password.js` gains `ApprovalPassword.selfApproval(result, resend)` and text overrides for `ask()`.
  - `voucher.html` and `purchase_request.html` call it only when the server answered `needSelfApproval: true`, which GAS never sends. JS-only edits; no locked section is touched.

**Tech Stack:** Node 24 ESM, Express 4, `pg`, `ioredis`, `bcryptjs`, `node:test`, Playwright (scratch e2e only).

## Global Constraints
- **GAS mode stays exactly as today.**
  - No new action is added.
  - The server changes are reached only through actions already gated by `PG_WORKFLOWS` (`vouchers`, `p2p`).
  - Each page change runs only after a response with `needSelfApproval === true`. Until then, every page code path is byte-for-byte the old one.
- Test command: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`.
  - 339 tests pass before Task 1.
  - Every task ends with the whole suite green (0 fail).
- Before Task 1: `psql tlcg_v_test -c "truncate approval_flows, email_queue, sheet_outbox"`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Request fields** (top level of the submit body, for both workflows):
  - `selfApprovalPassword` (string). Never logged, stored, echoed or put in an email.
  - `selfApprovalDeclined` (`true`).
  - A password wins over `selfApprovalDeclined`.
- **Who may consent.** Only the signed-in caller, using the token email and never an email from the body:
  - vouchers: only when the caller is the voucher's requester (`caller.email === lower(voucher.requestorEmail)`); no token means no prompt;
  - PRs: the caller is always the requester.
- **Response when the server needs consent.** HTTP 200 and nothing is saved:
  - Body: `{ success: false, needSelfApproval: true, message, selfApproval: { steps: [{ step, key, labels }], prompt } }`.
  - `message` is the prompt on the first ask. After a password was sent, it is the error: wrong password, locked, no sample or plan changed.
  - A page that does not know the field (an old cached page or GAS) shows `message` as a failure and has saved nothing.
- **Response after a submit that auto-approved something:**
  - The usual success message, plus `' '` (`'. '` for vouchers, whose message has no final period) and `Đã tự động duyệt bước <steps> của bạn.`
  - The field `autoApproved: [{ step, labels }]`.
  - Without auto-approval the response is exactly today's.
- **Step numbering and labels:**
  - Engine plans: `step` = 1-based step index, label = the entry's role label, else the step name, else `Bước <n>`.
  - PRs: the numbers of the status labels. Step 2 is budget & supplier (`Người duyệt Ngân sách`, `Người duyệt NCC`). Step 5 is purchasing (`Người mua hàng`). The contract stage (4) never opens (GAS parity), so it is never part of consent.
  - `<steps>` = `1 (Kế toán trưởng)`, `1 (Kế toán trưởng) và 3 (Thủ quỹ)`, `1 (A), 3 (B) và 5 (C)`. Labels within one step are joined with `, ` (English joins steps with ` and `).
- **Messages (`SELF_MSG`). Vouchers pick by `lang`; PRs always use `vi`; stored notes and emails are always Vietnamese:**
  - `prompt`:
    - vi: `Bạn cũng là người duyệt bước {steps} của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.`
    - en: `You are also the approver of step {steps} of this request. Enter your password to approve your steps automatically.`
  - `noSampleHint`, appended after `NO_SAMPLE` with one space:
    - vi: `Bạn có thể bấm "Bỏ qua, tôi duyệt sau" để gửi phiếu và tự duyệt sau.`
    - en: `You can choose "Skip, I will approve later" to submit now and approve your steps by hand.`
  - `planChanged`:
    - vi: `Quy trình duyệt của phiếu vừa thay đổi. Vui lòng xác nhận lại.`
    - en: `The approval flow of this request has just changed. Please confirm again.`
  - `note`, for history, audit and the PR `<role>Note`: `Tự động duyệt khi gửi phiếu (người đề nghị là {labels joined by ", "})`.
  - `done`: `Đã tự động duyệt bước {steps} của bạn.`
  - `emailLine`, a `<p>` in the requester's confirmation email: `Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu (đã xác nhận bằng mật khẩu): bước {steps}.`
  - Wrong, locked and unavailable password messages: the existing `STEP_UP_MSG`. No sample: the existing `NO_SAMPLE` + `noSampleHint`.
- **Dialog texts** (i18n keys, vi / en):
  - `sapTitle`: `Tự động duyệt bước của bạn` / `Approve your own steps`.
  - `sapConfirm`: `Gửi và tự động duyệt` / `Submit and approve`.
  - `sapCancel`: `Bỏ qua, tôi duyệt sau` / `Skip, I will approve later`.
  - The field label stays `apwLabel`.
  - Cancel and Escape both mean "declined": the page resends with `selfApprovalDeclined: true`.
- **Consent record**, stored in the request's `metadata.selfApproval`:
  ```
  { by, consentedAt, method: 'password', round, steps: [{ step, key, labels }],
    stamps: [{ key, companyId, url, from, signature }], auto: [{ step, labels, at }] }
  ```
  - `round` = the number of send-backs when the consent was given (vouchers: always 0).
  - A consent is valid only when `by` equals the request's requester, `round` equals the current send-back count, and a stamp with a `signature` exists.
  - `stamps` is emptied when the requester has no unapproved own entry left.
  - History rows and API views never carry `stamps[].signature` (`withoutStamps`).
- **Audit and metadata of an auto-approval:**
  - Verification record: the Plan 5b `{ verified: true, method: 'password', sampleFrom, verifiedAt }`.
  - Audit `extra`: `{ auth: 'password', signatureStamped: true, sampleFrom, auto: true, consentedAt }`.
  - Audit actor: the requester. Voucher `last_action` / `action`: `Duyệt bởi <name>`.
- **Locked UI** (memory `feedback_locked_sections.md`, `purchase_request_rules.md`, `project_voucher_logic.md`, `VOUCHER_WORKFLOW_RULES.md`): no HTML or CSS change in `voucher.html` or `purchase_request.html`. Only the JS lines listed in Task 4 change. The dialog is the shared overlay of `approval-password.js`.
- Do not switch production; `PG_WORKFLOWS` on the Mini stays as is.

## Decisions (made by this plan; the user's rule is in memory `project_self_approval.md`)
1. **Protocol: ask on the submit itself, not with a separate pre-check action.**
   - The first submit carries no password. If the requester holds a step, the server answers `needSelfApproval` before writing or uploading anything. The page shows the shared dialog and resends the same body with `selfApprovalPassword`, or with `selfApprovalDeclined: true` on cancel.
   - A pre-check action would need a new action name. In GAS mode it would be a round-trip to GAS answering "invalid action".
   - With this protocol the page does not need to know whether it runs on Postgres; it only reacts to a field GAS never sends.
   - The resend costs one extra upload of the body only for these requesters:
     - voucher files are already on R2/Drive before `sendApprovalEmail`, so the body holds URLs;
     - PR attachments ride base64 in the body, but `storeAttachments` runs after the consent step, so nothing is stored twice.
2. **The stamp is loaded at submit and kept in the consent record.** An auto-approval usually happens inside *another* approver's transaction: step 1 approves, and the requester's step 2 is approved in the same commit. There were two other options:
   - (a) Pre-resolve the requester's stamp next to the approver's before the lock. That needs to predict, outside the lock, whether the approval will reach the requester's step. It also ties approver X's approval to the requester's possibly broken sample; a slow or failing sample would delay or refuse X.
   - (b) Fetch under the lock, which Plan 5b forbids.

   At submit, the requester is present, nothing is locked yet, and a missing sample is reported to them at once ("No sample… you can skip and approve later"). Under the lock only `stampStillCurrent`, a DB lookup, checks that the sample is unchanged. A changed sample stops the auto-advance, and that step waits for the requester by hand, with the normal "please approve" email.

   Cost: one copy of the sample data URL (≤ 750 KB, one per distinct sample) in `metadata.selfApproval.stamps`, until the last own step is approved. It is kept out of history rows and API views.
3. **Consent is per request version.**
   - Vouchers have no resubmit: a rejected voucher is final and a new submit is a new voucher, so consent is per voucher.
   - PRs: a resubmit rebuilds the metadata, so the old consent is gone and the server asks again.
   - Any PR send-back increases `sentBackHistory.length`, which voids the consent's `round`. After a send-back to step 2 (re-review), the requester re-approves by hand. See Open question 2.
4. **Plan or flow changed between the prompt and the transaction (vouchers):** the steps are recomputed inside the transaction. If they differ from what the requester confirmed, the transaction rolls back and the page is asked again with `planChanged`. If the requester is no longer in the plan, the consent is simply dropped.
5. **Emails:**
   - The "please approve" email goes to whoever the final state waits for: the open step's not-yet-approved approvers, or the purchasing / completed email for PRs. The requester is never asked for a step that was just auto-approved.
   - Without consent (declined, or an old request), the emails are exactly today's, including the requester's own "please approve" email, which is their reminder to approve by hand. See Open question 3.
   - The page's own approver email is used only when nothing was auto-approved (today's rule). Otherwise the server template is used, which names the previous approver.
6. **Sheet copy:** an auto-approval writes through the same code as a manual one, so it gets a `Voucher_History` append and a `Voucher_Current` upsert (vouchers), or a PR upsert and one `PR_Audit_Log` append per slot (PRs).
7. **The PR manual path allows self-approval again.** A requester who declined approves their slot by hand. `SELF_APPROVAL_ERROR` is deleted. `MISSING_REQUESTER_ERROR` (fail closed) and the candidate-list checks stay, so a self-pick must still be on the company / Kế Toán Chi list.

## File Structure
- Create:
  - `api/lib/approval/self-approval.js`: `SELF_MSG`, `stepsText`, `promptText`, `selfNote`, `doneText`, `selfEmailHtml`, `publicAuto`, `entriesKey`, `planOwnSteps`, `planOwnOpen`, `planOwnLeft`, `sameOwnSteps`, `requestConsent`, `consentFor`, `recordAuto`, `withoutStamps`, `autoAdvance`, `askBody`, `planChangedBody`.
  - `api/handlers/pr/auto.js`: `autoAdvancePR(client, row, now)`.
  - Tests: `tests/approval/self-approval.test.js`, `tests/vouchers/self-approval.test.js`, `tests/purchase-requests/self-approval.test.js`.
- Modify:
  - `api/handlers/vouchers.js`: `resolvePlan`, `handleVoucherSubmit`, `writeApproval` (new, from `approveLocked`), `approveLocked`, `autoAdvanceVoucher`, and stripping the approval context.
  - `api/lib/purchase-requests/state.js`: delete `SELF_APPROVAL_ERROR`; add `ROLE_LABEL`, `prOwnSteps`, `prOwnOpen`, `prOwnLeft`, `picksAsRow`, `sentBackRound`.
  - `api/lib/purchase-requests/emails.js`: `ROLE_LABEL` re-exported from state; `approvalRequests(pr, to)`, `resubmitNotices(pr, to)`, `submitConfirmation(pr, auto)`, `openStageRequests(pr, kind)`.
  - `api/lib/purchase-requests/views.js`: `fullFromRow` strips stamps.
  - `api/handlers/pr/submit.js` (submit, resubmit), `api/handlers/pr/decide.js` (approve).
  - `approval-password.js`, `i18n.js`, `voucher.html`, `purchase_request.html`.
  - Tests: `tests/approval/approval-password.test.js`, `tests/purchase-requests/state.test.js`, `tests/purchase-requests/submit.test.js`, `tests/purchase-requests/decide.test.js`, `tests/purchase-requests/emails.test.js`.
  - Docs: `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`.

---

### Task 1: The shared self-approval module

**Files:**
- Create: `api/lib/approval/self-approval.js`, `tests/approval/self-approval.test.js`

**Interfaces:**
- Consumes:
  - `confirmPassword({ db, redis, email, password, lang })`, `stampSignature(db, companyId, entries, email, lang)` and `stampStillCurrent(client, pre, companyId, entries, email)` from `step-up.js`;
  - `pendingStep(plan)` from `engine.js`;
  - test helpers `PW`, `FAKE_STAMP`, `useStepUp` from `tests/approval/step-up-helpers.js`.
- Produces:
  - `OwnStep = { step: number, key: string, entries: [{ role, label }] | null, labels: string[], roles?: string[] }`. `entries` follows the `sampleSignatureFor` convention: `null` means derive from the company role emails, which is what PRs use.
  - `planOwnSteps(plan, email) → OwnStep[]`, `planOwnOpen(plan, email) → OwnStep | null`, `planOwnLeft(plan, email) → boolean`, `sameOwnSteps(a, b) → boolean`.
  - `requestConsent({ db, redis, email, password, declined, own, companyId, round = 0, lang, at })`. Returns one of:
    - `{ consent: null }`
    - `{ consent: null, declined: true }`
    - `{ ask: { steps, prompt }, message }`
    - `{ consent }`
  - `consentFor(meta, { requesterEmail, round = 0 }) → consent | null`; `recordAuto(consent, mine, at, left) → consent`; `withoutStamps(meta) → meta`.
  - `autoAdvance(client, { state, companyId, consentOf, pendingOwn, approve, now }) → { state, auto: [{ step, labels, at }] }`. Callbacks:
    - `consentOf(state) → consent | null`
    - `pendingOwn(state, email) → OwnStep | null`
    - `approve(state, { consent, mine, stamp, at, note }) → Promise<newState>`
  - `askBody({ ask, message })`, `planChangedBody(own, lang)`, `stepsText(steps, lang)`, `promptText(steps, lang)`, `selfNote(labels)`, `doneText(auto)`, `selfEmailHtml(auto)`, `publicAuto(auto)`, `entriesKey(entries)`, `SELF_MSG`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/approval/self-approval.test.js — Plan 5c shared module (pure parts always; DB parts need TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Redis from 'ioredis';
import {
  SELF_MSG, stepsText, promptText, selfNote, doneText, selfEmailHtml, planOwnSteps, planOwnOpen, planOwnLeft, sameOwnSteps,
  requestConsent, consentFor, recordAuto, withoutStamps, autoAdvance, askBody, planChangedBody,
} from '../../api/lib/approval/self-approval.js';
import { confirmPassword, failKey, lockKey, STEP_UP_MSG } from '../../api/lib/approval/step-up.js';
import { NO_SAMPLE } from '../../api/lib/approval/signature-check.js';
import { applyApproval } from '../../api/lib/approval/engine.js';
import { PW, FAKE_STAMP, useStepUp } from './step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
const redis = url ? new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15') : null;
const ME = 'sa-me@test.vn';
const NOSIG = 'sa-nosig@test.vn';
const AT = '2026-10-08T02:00:00.000Z';
const entry = (email, label = '', role = null) => ({ type: role ? 'role' : 'person', role, label, email, name: email, status: 'pending', at: null, signature: '' });
const PLAN = {
  flowId: null, version: 0, workflow: 'voucher', companyId: null, status: 'pending', rejectedBy: null,
  steps: [
    { name: 'Kiểm tra', status: 'pending', approvers: [entry(ME)] },
    { name: 'Phê duyệt', status: 'pending', approvers: [entry('other@test.vn', 'Kế toán trưởng', 'chief_accountant')] },
    { name: 'Nhóm cuối', status: 'pending', approvers: [entry(ME), entry('other2@test.vn')] },
  ],
};
let cleanup;
before(async () => {
  if (!db) return;
  cleanup = await useStepUp(db, redis, [ME, NOSIG]);
  await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me') WHERE LOWER(email) = $1`, [ME]);
  await db.query(`UPDATE employees SET extra = extra - 'Signature' WHERE LOWER(email) = $1`, [NOSIG]);
});
after(async () => {
  if (!db) return;
  await redis.del(failKey(ME), lockKey(ME));
  await cleanup();
  await db.end();
  await redis.quit();
});

test('texts: steps, prompt, note, done, email line (escaped)', () => {
  const one = [{ step: 1, labels: ['Kế toán trưởng'] }];
  const two = [{ step: 1, labels: ['Kế toán trưởng'] }, { step: 3, labels: ['Thủ quỹ'] }];
  assert.equal(stepsText(one), '1 (Kế toán trưởng)');
  assert.equal(stepsText(two), '1 (Kế toán trưởng) và 3 (Thủ quỹ)');
  assert.equal(stepsText([...two, { step: 5, labels: ['Người mua hàng'] }]), '1 (Kế toán trưởng), 3 (Thủ quỹ) và 5 (Người mua hàng)');
  assert.equal(stepsText(two, 'en'), '1 (Kế toán trưởng) and 3 (Thủ quỹ)');
  assert.equal(promptText(one, 'vi'), 'Bạn cũng là người duyệt bước 1 (Kế toán trưởng) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(promptText(one, 'en'), 'You are also the approver of step 1 (Kế toán trưởng) of this request. Enter your password to approve your steps automatically.');
  assert.equal(selfNote(['Người duyệt Ngân sách', 'Người duyệt NCC']), 'Tự động duyệt khi gửi phiếu (người đề nghị là Người duyệt Ngân sách, Người duyệt NCC)');
  assert.equal(doneText(two), 'Đã tự động duyệt bước 1 (Kế toán trưởng) và 3 (Thủ quỹ) của bạn.');
  assert.equal(selfEmailHtml([]), '');
  assert.equal(selfEmailHtml([{ step: 2, labels: ['<b>X</b>'] }]),
    '<p>Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu (đã xác nhận bằng mật khẩu): bước 2 (&lt;b&gt;X&lt;/b&gt;).</p>');
});

test('engine plans: own steps in order (label, else the step name), open entries only, group steps only mine', () => {
  assert.deepEqual(planOwnSteps(PLAN, ' SA-ME@test.vn').map(({ step, key, labels, entries }) => ({ step, key, labels, entries })), [
    { step: 1, key: 'person', labels: ['Kiểm tra'], entries: [{ role: null, label: '' }] },
    { step: 3, key: 'person', labels: ['Nhóm cuối'], entries: [{ role: null, label: '' }] },
  ]);
  assert.deepEqual(planOwnSteps(PLAN, 'other@test.vn').map((o) => [o.step, o.key, o.labels]), [[2, 'chief_accountant', ['Kế toán trưởng']]]);
  assert.deepEqual(planOwnSteps(PLAN, ''), []);
  assert.equal(planOwnOpen(PLAN, ME).step, 1);
  assert.equal(planOwnOpen(PLAN, 'other@test.vn'), null, 'step 2 is not open yet');
  const after1 = applyApproval(PLAN, ME, { at: AT }).plan;
  assert.equal(planOwnOpen(after1, ME), null, 'never ahead: step 2 belongs to another approver');
  const after2 = applyApproval(after1, 'other@test.vn', { at: AT }).plan;
  assert.deepEqual(planOwnOpen(after2, ME).entries, [{ role: null, label: '' }], 'group step: my entry only');
  assert.equal(planOwnLeft(after2, ME), true);
  assert.equal(planOwnLeft(applyApproval(after2, ME, { at: AT }).plan, ME), false);
  const pub = planOwnSteps(PLAN, ME).map(({ step, key, labels }) => ({ step, key, labels }));
  assert.equal(sameOwnSteps(planOwnSteps(PLAN, ME), pub), true);
  assert.equal(sameOwnSteps(planOwnSteps(PLAN, ME), pub.slice(1)), false);
});

test('consentFor / recordAuto / withoutStamps / askBody / planChangedBody', () => {
  const c = { by: 'me@x.vn', consentedAt: AT, method: 'password', round: 0, steps: [],
    stamps: [{ key: 'person', companyId: null, url: 'u', from: 'Master Employee', signature: 'data:image/png;base64,AA' }], auto: [] };
  assert.equal(consentFor({ selfApproval: c }, { requesterEmail: 'ME@x.vn' }), c);
  assert.equal(consentFor({}, { requesterEmail: 'me@x.vn' }), null, 'old requests: no consent');
  assert.equal(consentFor(null, { requesterEmail: 'me@x.vn' }), null);
  assert.equal(consentFor({ selfApproval: c }, { requesterEmail: 'other@x.vn' }), null);
  assert.equal(consentFor({ selfApproval: c }, { requesterEmail: 'me@x.vn', round: 1 }), null, 'sent back since: consent void');
  assert.equal(consentFor({ selfApproval: { ...c, stamps: [] } }, { requesterEmail: 'me@x.vn' }), null);
  const mine = { step: 1, key: 'person', labels: ['Kiểm tra'] };
  assert.deepEqual(recordAuto(c, mine, AT, true).auto, [{ step: 1, labels: ['Kiểm tra'], at: AT }]);
  assert.equal(recordAuto(c, mine, AT, true).stamps, c.stamps);
  assert.deepEqual(recordAuto(c, mine, AT, false).stamps, [], 'last own step: the stamp copy is dropped');
  const meta = { a: 1, selfApproval: c };
  assert.deepEqual(withoutStamps(meta).selfApproval.stamps, [{ key: 'person', companyId: null, url: 'u', from: 'Master Employee' }]);
  assert.equal(meta.selfApproval.stamps[0].signature.startsWith('data:'), true, 'input not mutated');
  assert.deepEqual(withoutStamps({ a: 1 }), { a: 1 });
  assert.deepEqual(askBody({ ask: { steps: [], prompt: 'P' }, message: 'M' }),
    { success: false, needSelfApproval: true, message: 'M', selfApproval: { steps: [], prompt: 'P' } });
  const changed = planChangedBody(planOwnSteps(PLAN, ME), 'vi');
  assert.equal(changed.message, SELF_MSG.vi.planChanged);
  assert.equal(changed.selfApproval.steps.length, 2);
});

test('requestConsent: nothing to ask, ask, declined, wrong password, no sample, consent with one stamp per sample', { skip }, async () => {
  const own = planOwnSteps(PLAN, ME);
  const base = { db, redis, email: ME, own, companyId: null, lang: 'vi', at: AT };
  assert.deepEqual(await requestConsent({ ...base, own: [] }), { consent: null });
  assert.deepEqual(await requestConsent({ ...base, email: '' }), { consent: null });
  const ask = await requestConsent(base);
  assert.deepEqual(ask.ask.steps, [{ step: 1, key: 'person', labels: ['Kiểm tra'] }, { step: 3, key: 'person', labels: ['Nhóm cuối'] }]);
  assert.equal(ask.message, 'Bạn cũng là người duyệt bước 1 (Kiểm tra) và 3 (Nhóm cuối) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(ask.ask.prompt, ask.message);
  assert.deepEqual(await requestConsent({ ...base, declined: true }), { consent: null, declined: true });
  assert.equal((await requestConsent({ ...base, password: 'wrong' })).message, STEP_UP_MSG.vi.wrongPassword);
  await redis.del(failKey(ME));
  const ok = await requestConsent({ ...base, password: PW, declined: true });
  assert.deepEqual(Object.keys(ok), ['consent'], 'a password wins over declined');
  assert.deepEqual(ok.consent, {
    by: ME, consentedAt: AT, method: 'password', round: 0, steps: ask.ask.steps, auto: [],
    stamps: [{ key: 'person', companyId: null, url: 'https://drive/sa-me', from: 'Master Employee', signature: FAKE_STAMP('https://drive/sa-me') }],
  });
  const noSigPlan = { ...PLAN, steps: [{ name: 'X', status: 'pending', approvers: [entry(NOSIG)] }] };
  const noSig = await requestConsent({ ...base, email: NOSIG, own: planOwnSteps(noSigPlan, NOSIG), password: PW });
  assert.equal(noSig.message, `${NO_SAMPLE.vi} ${SELF_MSG.vi.noSampleHint}`);
  assert.equal(noSig.consent, undefined);
});

test('requestConsent shares the approval lockout counter: 4 wrong at submit + 1 wrong at approve locks', { skip }, async () => {
  await redis.del(failKey(ME), lockKey(ME));
  const base = { db, redis, email: ME, own: planOwnSteps(PLAN, ME), companyId: null, lang: 'vi', at: AT };
  try {
    for (let i = 0; i < 4; i += 1) assert.equal((await requestConsent({ ...base, password: 'wrong' })).message, STEP_UP_MSG.vi.wrongPassword);
    assert.equal((await confirmPassword({ db, redis, email: ME, password: 'wrong', lang: 'vi' })).message, STEP_UP_MSG.vi.locked);
    const locked = await requestConsent({ ...base, password: PW });
    assert.equal(locked.message, STEP_UP_MSG.vi.locked);
    assert.equal(locked.consent, undefined);
  } finally { await redis.del(failKey(ME), lockKey(ME)); }
});

test('autoAdvance: own open steps in order, stops at another approver, group entry only, sample re-checked by DB lookup', { skip }, async () => {
  const { consent } = await requestConsent({ db, redis, email: ME, own: planOwnSteps(PLAN, ME), companyId: null, lang: 'vi', at: AT, password: PW });
  const notes = [];
  const run = (state) => autoAdvance(db, {
    state, companyId: null, now: () => new Date('2026-10-08T03:00:00.000Z'),
    consentOf: (s) => consentFor(s.metadata, { requesterEmail: ME }),
    pendingOwn: (s, me) => planOwnOpen(s.plan, me),
    approve: async (s, { consent: c, mine, stamp, at, note }) => {
      notes.push(note);
      const plan = applyApproval(s.plan, c.by, { at, signature: stamp.signature }).plan;
      return { plan, metadata: { selfApproval: recordAuto(c, mine, at, planOwnLeft(plan, c.by)) } };
    },
  });
  let out = await run({ plan: PLAN, metadata: { selfApproval: consent } });
  assert.deepEqual(out.auto, [{ step: 1, labels: ['Kiểm tra'], at: '2026-10-08T03:00:00.000Z' }]);
  assert.equal(out.state.plan.steps[0].approvers[0].signature, FAKE_STAMP('https://drive/sa-me'));
  assert.equal(out.state.plan.steps[1].status, 'pending', 'never ahead of another approver');
  out = await run({ ...out.state, plan: applyApproval(out.state.plan, 'other@test.vn', { at: AT }).plan });
  assert.deepEqual(out.auto.map((a) => a.step), [3]);
  assert.deepEqual(out.state.plan.steps[2].approvers.map((a) => a.status), ['approved', 'pending'], 'group step: only my entry');
  assert.deepEqual(out.state.metadata.selfApproval.stamps, [], 'no own step left');
  assert.deepEqual(notes, ['Tự động duyệt khi gửi phiếu (người đề nghị là Kiểm tra)', 'Tự động duyệt khi gửi phiếu (người đề nghị là Nhóm cuối)']);
  assert.deepEqual((await run(out.state)).auto, [], 'nothing left');
  // The sample changed after consent → no auto-approval; that step waits for the requester by hand
  await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me-new') WHERE LOWER(email) = $1`, [ME]);
  try {
    assert.deepEqual((await run({ plan: PLAN, metadata: { selfApproval: consent } })).auto, []);
  } finally {
    await db.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sa-me') WHERE LOWER(email) = $1`, [ME]);
  }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/approval/self-approval.test.js`. Expected: FAIL with `Cannot find module '…/api/lib/approval/self-approval.js'`.

- [ ] **Step 3: Write the module**

```js
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

/** The consent stored on a request, if it still applies (same requester, same send-back round, a stamp left). */
export function consentFor(meta, { requesterEmail, round = 0 }) {
  const c = meta && meta.selfApproval;
  if (!c || !c.by || c.by !== lower(requesterEmail) || (Number(c.round) || 0) !== round) return null;
  return Array.isArray(c.stamps) && c.stamps.some((s) => s && s.signature) ? c : null;
}

/** The consent after one auto-approval: logged in `auto`; the stamp copy dropped when no own entry is `left`. */
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
```

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail.

- [ ] **Step 5: Commit**

```bash
git add api/lib/approval/self-approval.js tests/approval/self-approval.test.js
git commit -m "feat(approval): shared self-approval module (consent at submit, auto-advance loop, texts)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Vouchers: consent at submit, auto-advance after submit and every approval

**Files:**
- Modify: `api/handlers/vouchers.js`
- Create: `tests/vouchers/self-approval.test.js`

**Interfaces:**
- Consumes: Task 1 (`requestConsent`, `askBody`, `planChangedBody`, `sameOwnSteps`, `planOwnSteps`, `planOwnOpen`, `planOwnLeft`, `consentFor`, `recordAuto`, `withoutStamps`, `autoAdvance`, `doneText`, `selfEmailHtml`, `publicAuto`).
- Produces:
  - Internal: `resolvePlan(db, v, lang)`, `writeApproval(client, row, { email, name, signature, from, at, auto })`, `autoAdvanceVoucher(client, row)`.
  - Wire: `sendApprovalEmail` accepts `selfApprovalPassword` / `selfApprovalDeclined` and may answer `needSelfApproval`. `approveLocked` returns `{ ok, view, plan, stepDone, finished, auto }`, where `plan` is the final plan after any auto-approval.

- [ ] **Step 1: Write the failing tests**

```js
// tests/vouchers/self-approval.test.js — Plan 5c on vouchers: the requester's own steps are auto-approved after one
// password at submit. Needs TEST_DATABASE_URL (master data imported) + Redis db 15, like handlers.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { failKey, lockKey } from '../../api/lib/approval/step-up.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
let h, pool, redis, saveVersion, company, people, cleanup;
const A = 'sa-a@x.vn';
const B = 'sa-b@x.vn';
const C = 'sa-c@x.vn';
const SIG = (e) => `https://drive/sample-${e}`;
const NOTE = (label) => `Tự động duyệt khi gửi phiếu (người đề nghị là ${label})`;

const callAs = (fn, body, auth) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: auth ? { authorization: auth } : {} }, res)).catch(reject);
});
const jwtFor = async (email) => {
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`SELECT id FROM employees WHERE LOWER(email) = $1`, [email]);
  return 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
};
let seq = 0;
const newNo = () => `MI-PC20261008${String(800000 + ++seq).padStart(6, '0')}`;
const submitBody = (no, requestor, extra = {}) => ({
  email: { to: people.accountant, subject: `[PHÊ DUYỆT] Phiếu ${no}`, body: '<p>page body</p>', replyTo: 'sub@x.vn' },
  requesterEmail: { to: requestor, subject: `[THÔNG BÁO] Phiếu ${no}`, body: '<p>Phiếu đã được gửi phê duyệt</p>' },
  voucher: { voucherNumber: no, voucherType: 'Phiếu Chi', company: company.company_name, companyKey: company.company_key,
    employee: 'Người Lập', requestorEmail: requestor, amount: '1.000.000', reason: 'Tự duyệt', files: [] },
  ...extra,
});
const submitAs = async (no, who, extra = {}) => callAs(h.handleVoucherSubmit, submitBody(no, who, extra), await jwtFor(who));
const approve = async (no, who, password = PW) => callAs(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverPassword: password } }, await jwtFor(who));
const voucher = async (no) => (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
const history = async (no) => (await pool.query(`SELECT status, action, note, approver_email, metadata FROM voucher_history WHERE voucher_number = $1 ORDER BY id`, [no])).rows;
const mails = async (no) => (await pool.query(`SELECT to_email, subject, body_html FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${no}%`])).rows;
const asked = async (no) => (await mails(no)).filter((m) => m.subject.startsWith('[PHÊ DUYỆT]')).map((m) => m.to_email);
const auditRows = async (no) => (await pool.query(`SELECT action, actor_email, note, extra FROM voucher_audit_log WHERE doc_no = $1 ORDER BY id`, [no])).rows;
const outbox = async (no) => (await pool.query(
  `SELECT tab, record FROM sheet_outbox WHERE record->>'voucher_number' = $1 OR record->>'voucherNumber' = $1 ORDER BY id`, [no])).rows;
const flow = (steps) => saveVersion(pool, { workflow: 'voucher', companyId: company.id, createdBy: 't@x.vn', steps });
const person = (email) => ({ type: 'person', email });

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.VOUCHER_SPREADSHEET_ID = 'test-voucher-sheet';
  h = await import('../../api/handlers/vouchers.js');
  pool = (await import('../../db/pool.js')).default;
  redis = (await import('../../db/redis.js')).default;
  ({ saveVersion } = await import('../../api/lib/approval/flows-repo.js'));
  await pool.query(`DELETE FROM vouchers WHERE voucher_number LIKE 'MI-PC20261008%'; DELETE FROM voucher_history WHERE voucher_number LIKE 'MI-PC20261008%';
                    TRUNCATE email_queue; TRUNCATE approval_flows; TRUNCATE sheet_outbox`);
  company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'M.I'`)).rows[0];
  people = { accountant: company.accountant_email.toLowerCase(), legal: company.legal_rep_email.toLowerCase(), treasurer: company.treasurer_email.toLowerCase() };
  cleanup = await useStepUp(pool, redis, [people.accountant, people.legal, people.treasurer, A, B, C]);
  for (const e of [A, B, C]) await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [e, SIG(e)]);
});
after(async () => {
  if (!pool) return;
  await pool.query(`TRUNCATE approval_flows`);
  if (cleanup) await cleanup();
  await pool.end();
  redis.quit?.();
});

test('requester = step 1 (default flow): asked once, nothing stored; with the password step 1 is auto-approved and stamped', { skip }, async () => {
  const no = newNo();
  const ask = await submitAs(no, people.accountant);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true]);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 1, key: 'chief_accountant', labels: ['Kế toán trưởng'] }]);
  assert.equal(ask.selfApproval.prompt, 'Bạn cũng là người duyệt bước 1 (Kế toán trưởng) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
  assert.equal(ask.message, ask.selfApproval.prompt);
  assert.equal(await voucher(no), undefined, 'nothing stored before consent');
  const r = await submitAs(no, people.accountant, { selfApprovalPassword: PW });
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Kế toán trưởng) của bạn.');
  assert.deepEqual(r.autoApproved, [{ step: 1, labels: ['Kế toán trưởng'] }]);
  const v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.deepEqual(v.pending_emails, [people.legal]);
  assert.equal(v.metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url), 'registered sample stamped');
  assert.deepEqual(Object.values(v.metadata.signatureVerification).map((x) => [x.verified, x.method]), [[true, 'password']]);
  assert.equal(v.metadata.selfApproval.by, people.accountant);
  assert.deepEqual(v.metadata.selfApproval.auto.map((x) => x.step), [1]);
  assert.deepEqual(v.metadata.selfApproval.stamps, [], 'no own step left: the stamp copy is dropped');
  const hist = await history(no);
  assert.deepEqual(hist.map((x) => [x.status, x.note]), [['Đang treo', 'Gửi phê duyệt'], ['Đang duyệt (1/3)', NOTE('Kế toán trưởng')]]);
  assert.match(hist[1].action, /^Duyệt bởi /);
  assert.ok(hist.every((x) => !JSON.stringify(x.metadata.selfApproval || {}).includes('data:')), 'history rows never carry the stamp copy');
  const log = await auditRows(no);
  assert.deepEqual(log.map((a) => [a.action, a.actor_email, a.note]), [['Submit', people.accountant, 'Tự duyệt'], ['Approve', people.accountant, NOTE('Kế toán trưởng')]]);
  assert.deepEqual([log[1].extra.auth, log[1].extra.auto, log[1].extra.signatureStamped], ['password', true, true]);
  const ob = await outbox(no);
  assert.deepEqual(ob.filter((o) => o.tab === 'Voucher_Current').map((o) => o.record.approvalProgress), [0, 1], 'auto-approval mirrored like any approval');
  assert.deepEqual(ob.filter((o) => o.tab === 'Voucher_History').map((o) => o.record.note), ['Gửi phê duyệt', NOTE('Kế toán trưởng')]);
  assert.deepEqual(await asked(no), [people.legal], 'no "please approve" email to the requester');
  const conf = (await mails(no)).find((m) => m.subject.startsWith('[THÔNG BÁO]'));
  assert.equal(conf.to_email, people.accountant);
  assert.match(conf.body_html, /Đã gửi email đến .+ để tiếp tục phê duyệt\./);
  assert.match(conf.body_html, /Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu \(đã xác nhận bằng mật khẩu\): bước 1 \(Kế toán trưởng\)\./);
  // A second submit of the same number is refused before any password is checked
  const dup = await submitAs(no, people.accountant, { selfApprovalPassword: 'wrong' });
  assert.match(dup.message, /đã được gửi trước đó/);
  assert.equal(await redis.get(failKey(people.accountant)), null, 'no password checked for a duplicate');
});

test('requester = step 2: nothing at submit; the step-1 approval auto-approves step 2 in the same commit; step 3 is asked', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    assert.equal((await submitAs(no, B)).selfApproval.prompt,
      'Bạn cũng là người duyệt bước 2 (Phê duyệt) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.');
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công', 'nothing auto-approved yet: step 1 is another approver');
    assert.equal(r.autoApproved, undefined);
    let v = await voucher(no);
    assert.equal(v.status, 'Đang treo');
    assert.deepEqual(v.metadata.selfApproval.steps, [{ step: 2, key: 'person', labels: ['Phê duyệt'] }]);
    const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(A));
    assert.equal(JSON.stringify(ctx.data.voucher.meta).includes('data:image'), false, 'the stamp copy is not sent to pages');
    const a = await approve(no, A);
    assert.equal(a.success, true, a.message);
    assert.equal(a.message, `Đã phê duyệt thành công. Đã gửi email đến ${C} để tiếp tục phê duyệt.`);
    v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (2/3)');
    assert.deepEqual(v.pending_emails, [C]);
    assert.equal(v.metadata.approvalPlan.steps[1].approvers[0].signature, FAKE_STAMP(SIG(B)));
    assert.deepEqual((await history(no)).slice(1).map((x) => [x.approver_email, x.note]),
      [[A, 'Đã duyệt bởi Người duyệt (1/3)'], [B, NOTE('Phê duyệt')]]);
    assert.deepEqual(await asked(no), [A, C], 'never the requester');
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('requester = steps 1 and 3: step 1 at submit, step 3 right after step 2; the plan finishes', { skip }, async () => {
  await flow([{ name: 'Lập', approvers: [person(B)] }, { name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Chi tiền', approvers: [person(B)] }]);
  try {
    const no = newNo();
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Lập) của bạn.');
    let v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/3)');
    assert.equal(v.metadata.selfApproval.stamps.length, 1, 'step 3 still to come: stamp kept');
    const a = await approve(no, A);
    assert.equal(a.message, 'Đã phê duyệt thành công. Phiếu đã được duyệt hoàn toàn.');
    v = await voucher(no);
    assert.equal(v.status, 'Đã duyệt');
    assert.deepEqual(v.metadata.selfApproval.auto.map((x) => x.step), [1, 3]);
    assert.deepEqual(v.metadata.selfApproval.stamps, []);
    const subjects = (await mails(no)).map((m) => m.subject);
    assert.ok(subjects.includes(`[ĐÃ DUYỆT HOÀN TOÀN] Phiếu ${no}`));
    assert.deepEqual(await asked(no), [A]);
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('group step: only the requester entry is auto-approved; the step waits for the other member', { skip }, async () => {
  await flow([{ name: 'Nhóm', approvers: [person(B), person(A)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    const r = await submitAs(no, B, { selfApprovalPassword: PW });
    assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công. Đã tự động duyệt bước 1 (Nhóm) của bạn.');
    let v = await voucher(no);
    assert.equal(v.status, 'Đang treo', 'step 1 not done yet');
    assert.deepEqual(v.metadata.approvalPlan.steps[0].approvers.map((x) => [x.email, x.status]), [[B, 'approved'], [A, 'pending']]);
    assert.deepEqual(v.pending_emails, [A]);
    assert.deepEqual(await asked(no), [A]);
    assert.equal((await approve(no, A)).message, `Đã phê duyệt thành công. Đã gửi email đến ${C} để tiếp tục phê duyệt.`);
    v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/2)');
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});

test('cancel path: declined → submitted as today; the requester is asked by email and approves by hand', { skip }, async () => {
  const no = newNo();
  const r = await submitAs(no, people.accountant, { selfApprovalDeclined: true });
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã gửi yêu cầu phê duyệt thành công');
  let v = await voucher(no);
  assert.equal(v.status, 'Đang treo');
  assert.equal(v.metadata.selfApproval, undefined);
  assert.deepEqual(await asked(no), [people.accountant], 'today: the page email to step 1');
  const a = await approve(no, people.accountant);
  assert.equal(a.success, true, a.message);
  v = await voucher(no);
  assert.equal(v.status, 'Đang duyệt (1/3)');
  assert.equal((await history(no)).pop().note, 'Đã duyệt bởi Kế toán trưởng (1/3)');
});

test('wrong password: asked again, nothing stored; the counter is the approval lockout (5th wrong anywhere locks)', { skip }, async () => {
  await redis.del(failKey(people.accountant), lockKey(people.accountant));
  try {
    const no = newNo();
    for (let i = 0; i < 4; i += 1) {
      const w = await submitAs(no, people.accountant, { selfApprovalPassword: 'wrong' });
      assert.deepEqual([w.success, w.needSelfApproval, w.message], [false, true, 'Mật khẩu không đúng.']);
    }
    assert.equal(await voucher(no), undefined);
    const other = newNo();
    assert.equal((await callAs(h.handleVoucherSubmit, submitBody(other, 'sub@x.vn'))).success, true, 'no token: submitted as today');
    assert.equal((await approve(other, people.accountant, 'wrong')).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
    const locked = await submitAs(no, people.accountant, { selfApprovalPassword: PW });
    assert.deepEqual([locked.needSelfApproval, locked.message], [true, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.']);
    assert.equal(await voucher(no), undefined);
  } finally { await redis.del(failKey(people.accountant), lockKey(people.accountant)); }
});

test('no prompt without a token or when the caller is not the requester (never a body email)', { skip }, async () => {
  const noToken = newNo();
  const r1 = await callAs(h.handleVoucherSubmit, submitBody(noToken, people.accountant, { selfApprovalPassword: PW }));
  assert.equal(r1.message, 'Đã gửi yêu cầu phê duyệt thành công');
  assert.equal((await voucher(noToken)).status, 'Đang treo');
  const onBehalf = newNo();
  const r2 = await callAs(h.handleVoucherSubmit, submitBody(onBehalf, 'sub@x.vn'), await jwtFor(people.accountant));
  assert.equal(r2.success, true, r2.message);
  assert.equal(r2.needSelfApproval, undefined);
  assert.equal((await voucher(onBehalf)).metadata.selfApproval, undefined);
});

test('the sample changed after consent: the step waits for the requester by hand (and they are emailed)', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const no = newNo();
    await submitAs(no, B, { selfApprovalPassword: PW });
    await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', 'https://drive/sample-new') WHERE LOWER(email) = $1`, [B]);
    assert.equal((await approve(no, A)).success, true);
    let v = await voucher(no);
    assert.equal(v.status, 'Đang duyệt (1/3)');
    assert.deepEqual(v.pending_emails, [B]);
    assert.deepEqual(await asked(no), [A, B]);
    assert.equal((await approve(no, B)).success, true);
    v = await voucher(no);
    assert.equal(v.metadata.approvalPlan.steps[1].approvers[0].signature, FAKE_STAMP('https://drive/sample-new'));
  } finally {
    await pool.query(`UPDATE employees SET extra = extra || jsonb_build_object('Signature', $2::text) WHERE LOWER(email) = $1`, [B, SIG(B)]);
    await pool.query(`TRUNCATE approval_flows`);
  }
});

test('bulk approve: each voucher auto-advances the requester step; one batch email to the approver after it', { skip }, async () => {
  await flow([{ name: 'Kiểm tra', approvers: [person(A)] }, { name: 'Phê duyệt', approvers: [person(B)] }, { name: 'Chi tiền', approvers: [person(C)] }]);
  try {
    const nos = [newNo(), newNo()];
    for (const no of nos) assert.equal((await submitAs(no, B, { selfApprovalPassword: PW })).success, true);
    const r = await callAs(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverPassword: PW }, await jwtFor(A));
    assert.deepEqual(r.data.approved, nos);
    for (const no of nos) assert.equal((await voucher(no)).status, 'Đang duyệt (2/3)');
    const batch = (await pool.query(`SELECT to_email, body_html FROM email_queue WHERE subject LIKE '[PHÊ DUYỆT HÀNG LOẠT]%' ORDER BY id DESC LIMIT 1`)).rows[0];
    assert.equal(batch.to_email, C);
    assert.ok(nos.every((no) => batch.body_html.includes(no)));
  } finally { await pool.query(`TRUNCATE approval_flows`); }
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/vouchers/self-approval.test.js`. Expected: the first test fails on `ask.needSelfApproval` (`undefined`, because the voucher is stored at once).

- [ ] **Step 3: Implement in `api/handlers/vouchers.js`**

1. Imports (`pendingStep`, `statusText`, `legacyCompanyApprovers`, `verificationRecord` and `redis` are already imported). Add:
```js
import {
  requestConsent, askBody, planChangedBody, sameOwnSteps, planOwnSteps, planOwnOpen, planOwnLeft, consentFor, recordAuto,
  withoutStamps, autoAdvance, doneText, selfEmailHtml, publicAuto,
} from '../lib/approval/self-approval.js';
```
2. Add the header contract note after the line `// - Emails are queued only after the transaction commits.`:
```js
// - Plan 5c: a requester who is also an approver confirms with their password once at submit; their steps are then
//   auto-approved in order, inside the transaction that reaches them (api/lib/approval/self-approval.js).
```
3. Replace the whole `// ── sendApprovalEmail (submit) ──` section (from `export async function handleVoucherSubmit` to its closing brace) with:

```js
/** The company, its active voucher flow and the plan it resolves to; { error } in the GAS wording otherwise. */
async function resolvePlan(db, v, lang) {
  const company = await findCompany(db, v.company, v.companyKey);
  if (!company) return { error: msg(lang, 'companyNotFound') + (v.company || '') };
  const flow = await getActiveFlow(db, 'voucher', company.id);
  const built = buildPlan({ flow, company, employeesByEmail: await employeesByEmail(db), workflow: 'voucher' });
  if (built.problems.length) return { error: msg(lang, 'flowProblems', built.problems.join(' ')) };
  return { company, flow, plan: built.plan };
}

export async function handleVoucherSubmit(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const email = b.email || {};
  const reqMail = b.requesterEmail || null;
  const v = b.voucher || {};
  if (!email.to) return fail(res, msg(lang, 'missingRecipient'));
  const actor = await resolveActor(req, res, '', lang);
  if (!actor) return;
  const voucherNo = String(v.voucherNumber || 'AUTO-' + Date.now()).trim();

  // Plan 5c: only a signed-in caller who is this voucher's requester can consent (never a body email). Asked and
  // checked BEFORE the transaction: the password check and the sample load never run under a lock.
  const me = actor.caller && actor.caller.email === lower(v.requestorEmail) ? actor.caller.email : '';
  let consent = null;
  if (me) {
    const seen = await pool.query(`SELECT 1 FROM vouchers WHERE voucher_number = $1`, [voucherNo]);
    if (seen.rows.length) return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo));
    const pre = await resolvePlan(pool, v, lang);
    if (pre.error) return fail(res, pre.error);
    const sa = await requestConsent({ db: pool, redis, email: me, password: b.selfApprovalPassword, declined: b.selfApprovalDeclined,
      own: planOwnSteps(pre.plan, me), companyId: pre.company.id, lang, at: now() });
    if (sa.ask) return res.json(askBody(sa));
    consent = sa.consent;
  }

  const client = await pool.connect();
  let plan, view;
  let auto = [];
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT 1 FROM vouchers WHERE voucher_number = $1`, [voucherNo]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo)); }
    const resolved = await resolvePlan(client, v, lang);
    if (resolved.error) { await client.query('ROLLBACK'); return fail(res, resolved.error); }
    const { company, flow } = resolved;
    plan = resolved.plan;
    if (consent) {
      // The flow or Master Data changed since the prompt: never approve steps the requester did not see
      const fresh = planOwnSteps(plan, me);
      if (!fresh.length) consent = null;
      else if (!sameOwnSteps(fresh, consent.steps)) { await client.query('ROLLBACK'); return res.json(planChangedBody(fresh, lang)); }
    }

    const submittedAt = now();
    const meta = {
      requesterSignature: v.requesterSignature || '', reason: v.reason || '', voucherDate: v.voucherDate || '',
      department: v.department || '', payeeName: v.payeeName || '', amountInWords: v.amountInWords || '',
      expenseItems: v.expenseItems || [], submittedAt, approvalFlow: { id: flow.id, version: flow.version, source: flow.source },
      submittedByEmail: actor.email || lower(v.requestorEmail),
      ...(consent ? { selfApproval: consent } : {}),
    };
    const attachments = attachmentLines(v.files);
    const description = v.reason || v.description || '';
    const { rows } = await client.query(
      `INSERT INTO vouchers (voucher_number, voucher_type, company_id, company_name, company_key, employee_name,
         requestor_email, submitted_by, amount, status, due_date, description, attachments, metadata,
         submitted_at, last_action, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$14,$15,'Gửi phê duyệt') RETURNING *`,
      [voucherNo, v.voucherType || '', company.id, company.company_name, company.company_key || v.companyKey || '',
        v.employee || '', lower(v.requestorEmail), v.submittedBy || v.employee || '', toAmount(v.amount),
        STATUS.submitted, v.dueDate || '', description, attachments, submittedAt, 'Đã nộp phiếu']
    );
    const row = rows[0];
    const idx = await saveState(client, row, { plan, meta, status: STATUS.submitted, lastAction: 'Đã nộp phiếu' });
    view = voucherView(row);
    const hist = {
      ...view, status: STATUS.submitted, action: 'Đã nộp phiếu', attachments, note: 'Gửi phê duyệt',
      approverEmail: plan.steps[0].approvers.map((a) => a.email).join(','), meta: withoutStamps(meta),
    };
    await appendHistory(client, hist);
    await mirrorVoucher(client, hist, { at: submittedAt, submittedAt, progressDone: idx.done });
    await audit(client, { docNo: voucherNo, company: company.company_name, action: 'Submit', role: 'requester',
      actorEmail: lower(v.requestorEmail), actorName: v.employee, newStatus: STATUS.submitted, note: description });
    if (consent) {
      // The requester's own step(s) from step 1 on, in order, in this same commit
      const adv = await autoAdvanceVoucher(client, { ...row, metadata: meta, status: STATUS.submitted });
      auto = adv.auto;
      plan = planOf(adv.row);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo));
    console.error('[Vouchers] submit error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }

  // Emails after commit, from the plan AFTER any self-approval: the requester is never asked to approve a step that
  // was just approved for them. Without self-approval this is exactly the old behaviour (waiting = step 1).
  const waiting = stepWaiting(plan);
  const pageTo = String(email.to).split(',').map(lower).filter(Boolean);
  if (plan.status === 'approved') for (const m of finalApproved(view, plan)) await queueMail(m);
  for (const a of waiting) {
    if (!auto.length && waiting.length === 1 && pageTo.includes(a.email) && email.subject && email.body) {
      await queueMail({ to: a.email, cc: email.cc, replyTo: email.replyTo, subject: email.subject, html: email.body });
    } else {
      await queueMail({ ...approvalRequest(view, plan, a), replyTo: email.replyTo });
    }
  }
  if (reqMail && reqMail.to) {
    const link = `${baseUrl()}/voucher.html?viewStatus=${encodeURIComponent(voucherNo)}`;
    const sentTo = waiting.length ? ` Đã gửi email đến ${nameList(waiting)} để ${auto.length ? 'tiếp tục' : 'bắt đầu'} phê duyệt.` : '';
    const html = String(reqMail.body || '').replace(/đã được gửi phê duyệt/g, `đã được gửi phê duyệt.${sentTo}`) + selfEmailHtml(auto) +
      `<p style="margin-top: 15px;"><a href="${link}" style="background: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">🔍 Xem trạng thái phê duyệt</a></p>`;
    await queueMail({ to: reqMail.to, replyTo: email.replyTo, subject: reqMail.subject || '[THÔNG BÁO] Phiếu đã được gửi phê duyệt', html });
  }
  await publishEvent('voucher:submitted', { voucherNumber: voucherNo, status: statusText(plan) });
  return res.json(auto.length
    ? { success: true, message: `Đã gửi yêu cầu phê duyệt thành công. ${doneText(auto)}`, autoApproved: publicAuto(auto) }
    : { success: true, message: 'Đã gửi yêu cầu phê duyệt thành công' });
}
```

4. Replace the whole `approveLocked` function with `writeApproval`, `autoAdvanceVoucher` and the new `approveLocked`:

```js
/**
 * Approve the open step for `email` on the locked row and write everything an approval writes: print fields,
 * verification record, state, history, Sheet copy, audit. Shared by approveLocked and the Plan 5c auto-advance
 * (`auto` = { consent, mine, note }). Engine errors (NOT_YOUR_TURN, ALREADY_APPROVED, CLOSED) are thrown before
 * anything is written. Returns { row (as written), plan, stepDone, finished }.
 */
async function writeApproval(client, row, { email, name = '', signature, from, at, auto = null }) {
  const plan = planOf(row);
  const result = applyApproval(plan, email, { at, signature });
  const mine = plan.steps[pendingStep(plan)].approvers.filter((a) => a.email === email);
  const next = result.plan;
  const meta = { ...(row.metadata || {}) };
  const before = legacyCompanyApprovers(plan).approvers;
  const ca = legacyCompanyApprovers(next);
  // The legacy key of the entry approved just now (the same person may sit in two steps; two writes can share a time)
  const key = Object.keys(ca.approvers).find((k) => ca.approvers[k].email === email && ca.approvers[k].status === 'approved'
    && (!before[k] || before[k].status !== 'approved')) || '';
  const who = name || mine[0].name || email;
  // Role-specific fields read by the print templates (GAS names)
  if (key === 'accountant') { meta.accountantSignature = signature; meta.accountantName = who; }
  if (key === 'legalRep') { meta.legalRepSignature = signature; meta.legalRepName = who; }
  if (key === 'treasurer') { meta.treasurerSignature = signature; meta.treasurerName = who; meta.approverSignature = signature; }
  meta.signatureVerification = { ...(meta.signatureVerification || {}), [key || email]: verificationRecord(from, at) };
  meta.approvedBy = email;
  if (auto) meta.selfApproval = recordAuto(auto.consent, auto.mine, at, planOwnLeft(next, email));

  const status = statusText(next);
  const lastAction = 'Duyệt bởi ' + who;
  const idx = await saveState(client, row, { plan: next, meta, status, lastAction });
  const label = mine[0].label || 'Người duyệt';
  const note = auto ? auto.note
    : result.finished ? `Tất cả ${next.steps.length} bước phê duyệt đã duyệt` : `Đã duyệt bởi ${label} (${ca.approvalProgress})`;
  const hist = { ...voucherView(row), status, action: lastAction, approverEmail: email, approvedAt: at, meta: withoutStamps(meta), note };
  await appendHistory(client, hist);
  await mirrorVoucher(client, hist, { at, submittedAt: submittedAtOf(row), progressDone: idx.done });
  await audit(client, { docNo: row.voucher_number, company: row.company_name, action: 'Approve', role: key, actorEmail: email,
    actorName: who, prevStatus: row.status, newStatus: status, note: auto ? auto.note : '',
    extra: { auth: 'password', signatureStamped: !!signature, sampleFrom: from, ...(auto ? { auto: true, consentedAt: auto.consent.consentedAt } : {}) } });
  return { row: { ...row, metadata: meta, status, last_action: lastAction }, plan: next, stepDone: result.stepDone, finished: result.finished };
}

/** Plan 5c: inside the open transaction, approve the requester's own steps they consented to at submit. { row, auto } */
async function autoAdvanceVoucher(client, row) {
  const { state, auto } = await autoAdvance(client, {
    state: row, companyId: row.company_id,
    consentOf: (r) => consentFor(r.metadata, { requesterEmail: r.requestor_email }),
    pendingOwn: (r, me) => planOwnOpen(planOf(r), me),
    approve: async (r, { consent, mine, stamp, at, note }) => (await writeApproval(client, r,
      { email: consent.by, signature: stamp.signature, from: stamp.from, at, auto: { consent, mine, note } })).row,
  });
  return { row: state, auto };
}

/** approveOne's transaction: row lock, GAS rules, the pre-loaded stamp, write, then the requester's own next steps. */
async function approveLocked({ voucherNumber, email, approverName, lang, pre }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherNotFound') + voucherNumber }; }
    const plan = planOf(row);
    const mine = plan.steps.flatMap((s) => s.approvers).filter((a) => a.email === email);
    if (!mine.length) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'approverInfoNotFound') }; }
    if (plan.status === 'rejected') { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherRejectedCannotApprove') }; }
    if (plan.status === 'approved') {
      await client.query('ROLLBACK');
      return { ok: false, error: msg(lang, mine.every((a) => a.status === 'approved') ? 'alreadyApprovedByYouCash' : 'alreadyFullyApproved') };
    }

    // Approved every entry they have and the plan moved on → GAS "already approved"
    if (mine.every((a) => a.status === 'approved')) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') }; }

    // The registered sample is stamped (no upload, no comparison); none registered → refused.
    // Uses the stamp loaded before the lock; only a DB lookup here, never a fetch.
    const pendingMine = pendingOf(plan, email);
    let stamp = { signature: '', from: '' };
    if (pendingMine.length) {
      if (!(await stampStillCurrent(client, pre, row.company_id, pendingMine, email))) {
        await client.query('ROLLBACK');
        return { retry: true };
      }
      if (!pre.ok) { await client.query('ROLLBACK'); return { ok: false, error: pre.message }; }
      stamp = pre;
    }

    let done;
    try {
      done = await writeApproval(client, row, { email, name: approverName, signature: stamp.signature, from: stamp.from, at: now() });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'ALREADY_APPROVED') return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') };
      if (e.code === 'NOT_YOUR_TURN') {
        const order = plan.steps.map((s) => s.approvers.map((a) => a.label || a.name).join(' + ')).join(' → ');
        return { ok: false, error: `Vui lòng đợi ${nameList(stepWaiting(plan))} phê duyệt trước. Thứ tự phê duyệt: ${order}.` };
      }
      throw e;
    }
    // Plan 5c: the requester's own next step(s), when they consented at submit — same commit, real time
    const adv = await autoAdvanceVoucher(client, done.row);
    const finalPlan = planOf(adv.row);
    await client.query('COMMIT');
    const finished = finalPlan.status === 'approved';
    await publishEvent('voucher:approved', { voucherNumber, status: adv.row.status, isFinal: finished });
    return { ok: true, view: voucherView(row), plan: finalPlan, stepDone: done.stepDone || adv.auto.length > 0, finished, auto: adv.auto };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
```

`handleVoucherApprove` and `handleVoucherBulkApprove` stay as they are. They already read `r.plan`, `r.stepDone` and `r.finished`, which now describe the state after the auto-advance, so the next-step emails go to the real next approvers.

5. In `handleVoucherApprovalContext`, replace `meta: { ...(row.metadata || {}), approvalPlan: undefined }` with `meta: { ...withoutStamps(row.metadata || {}), approvalPlan: undefined }`.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail. `tests/vouchers/handlers.test.js` must pass unchanged: without consent the voucher path is identical.

- [ ] **Step 5: Commit**

```bash
git add api/handlers/vouchers.js tests/vouchers/self-approval.test.js
git commit -m "feat(vouchers): requester's own steps auto-approved after one password at submit (Plan 5c)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Purchase requests: self-picks allowed, consent at submit/resubmit, auto-advance after every approval

**Files:**
- Create: `api/handlers/pr/auto.js`, `tests/purchase-requests/self-approval.test.js`
- Modify:
  - `api/lib/purchase-requests/state.js`, `api/lib/purchase-requests/emails.js`, `api/lib/purchase-requests/views.js`
  - `api/handlers/pr/submit.js`, `api/handlers/pr/decide.js`
  - `tests/purchase-requests/state.test.js`, `tests/purchase-requests/submit.test.js`, `tests/purchase-requests/decide.test.js`, `tests/purchase-requests/emails.test.js`

**Interfaces:**
- Consumes: Task 1 (`requestConsent`, `askBody`, `consentFor`, `recordAuto`, `autoAdvance`, `withoutStamps`, `doneText`, `selfEmailHtml`, `publicAuto`); `verificationRecord` (`step-up.js`).
- Produces:
  - `state.js`:
    - `ROLE_LABEL`;
    - `prOwnSteps(prLike, email) → OwnStep[]` (step 2 / 5, `key: '*'`, `entries: null`, `roles`, `labels`);
    - `prOwnOpen(pr, meta, email) → OwnStep | null`;
    - `prOwnLeft(pr, meta, email) → boolean`;
    - `picksAsRow(picks)`, `sentBackRound(meta) → number`;
    - `SELF_APPROVAL_ERROR` is deleted.
  - `emails.js`: `approvalRequests(pr, to?)`, `resubmitNotices(pr, to?)`, `submitConfirmation(pr, auto = [])`, `openStageRequests(pr, kind = 'submit')`; `ROLE_LABEL` is re-exported.
  - `auto.js`: `autoAdvancePR(client, row, now) → { state: savedRow, auto }`.

- [ ] **Step 1: Write the failing tests**

In `tests/purchase-requests/state.test.js`:
- In the import list, replace `SELF_APPROVAL_ERROR, MISSING_REQUESTER_ERROR,` with `MISSING_REQUESTER_ERROR, prOwnSteps, prOwnOpen, prOwnLeft, picksAsRow, sentBackRound, ROLE_LABEL,`.
- Replace the two tests `approverPickError: refuses self-approval (decision #3), checked before candidate lists` and `applyApprove refuses the requester (defence in depth)` with:

```js
test('approverPickError: self-picks allowed again (Plan 5c) but must be on the lists; requester still required', () => {
  const cands = { companyEmails: new Set(['linh@x.vn', 'kt@x.vn']), purchasingEmails: new Set(['tlc.ap@x.vn']) };
  const ok = { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' };
  assert.equal(approverPickError(ok, cands, 'full', 'linh@x.vn'), null, 'requester on budget + supplier');
  assert.equal(approverPickError(ok, cands, 'full', 'TLC.AP@x.vn'), null, 'requester as purchasing');
  assert.equal(approverPickError(ok, cands, 'full', 'kt@x.vn'), null, 'requester as contract reviewer');
  assert.match(approverPickError({ ...ok, budget: 'me@x.vn' }, cands, 'full', 'me@x.vn'), /không thuộc danh sách/);
  assert.equal(approverPickError(ok, cands, 'full'), 'Thiếu thông tin người đề nghị.', 'requester omitted → fail closed');
  assert.equal(approverPickError(ok, cands, 'full', '  '), MISSING_REQUESTER_ERROR);
});

test('applyApprove: the requester approves their own slot by hand (declined consent, old PRs)', () => {
  const r = applyApprove(pr({ requester_email: 'Linh@x.vn' }), meta(), { email: 'linh@x.vn', role: 'budget', at: AT });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.roles, ['budget', 'supplier']);
});

test('own PR slots: steps 2 / 5 in order, open stage only, contract never, rounds', () => {
  assert.deepEqual(ROLE_LABEL, { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' });
  assert.deepEqual(prOwnSteps(pr(), 'LINH@x.vn'), [
    { step: 2, key: '*', entries: null, roles: ['budget', 'supplier'], labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.deepEqual(prOwnSteps(pr(), 'tlc.ap@x.vn').map((o) => [o.step, o.roles]), [[5, ['purchasing']]]);
  assert.deepEqual(prOwnSteps(pr({ p2p_branch: 'full', contract_approver_email: 'kt@x.vn' }), 'kt@x.vn'), [], 'the contract stage never opens');
  assert.deepEqual(prOwnSteps(pr(), ''), []);
  assert.deepEqual(prOwnSteps(picksAsRow({ budget: 'a@x.vn', supplier: 'b@x.vn', contract: '', purchasing: 'a@x.vn' }), 'a@x.vn').map((o) => [o.step, o.roles]),
    [[2, ['budget']], [5, ['purchasing']]]);
  assert.equal(prOwnOpen(pr(), meta(), 'tlc.ap@x.vn'), null, 'purchasing not open yet');
  assert.deepEqual(prOwnOpen(pr(), meta({ budgetStatus: 'Approved' }), 'linh@x.vn').roles, ['supplier']);
  assert.deepEqual(prOwnOpen(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'tlc.ap@x.vn').roles, ['purchasing']);
  assert.equal(prOwnOpen(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn'), null);
  assert.equal(prOwnOpen(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn'), null);
  assert.equal(prOwnLeft(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'linh@x.vn'), false);
  assert.equal(prOwnLeft(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'tlc.ap@x.vn'), true);
  assert.equal(sentBackRound({}), 0);
  assert.equal(sentBackRound({ sentBackHistory: [{}, {}] }), 2);
});
```

In `tests/purchase-requests/emails.test.js`, add:

```js
test('openStageRequests: who is asked after a submit/resubmit (and any self-approval)', () => {
  const at = (meta, over = {}) => m.openStageRequests({ ...pr, supplier_approver_email: 'ncc@x.vn', metadata: meta, ...over });
  assert.deepEqual(at({ budgetStatus: 'Pending', supplierStatus: 'Pending', purchasingStatus: 'Pending' }).map((x) => x.to), ['linh@x.vn', 'ncc@x.vn']);
  const half = at({ budgetStatus: 'Approved', supplierStatus: 'Pending', purchasingStatus: 'Pending' });
  assert.deepEqual(half.map((x) => [x.to, x.subject]), [['ncc@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - EV-PR20261007000001']]);
  const re = m.openStageRequests({ ...pr, supplier_approver_email: 'ncc@x.vn', metadata: { budgetStatus: 'Approved', supplierStatus: 'Pending', purchasingStatus: 'Pending' } }, 'resubmit');
  assert.deepEqual(re.map((x) => [x.to, x.subject]), [['ncc@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - EV-PR20261007000001']]);
  const buy = at({ budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Pending' });
  assert.deepEqual(buy.map((x) => [x.to, x.subject]), [['tlc.ap@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261007000001']]);
  const done = at({ budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Approved' });
  assert.deepEqual(done.map((x) => [x.to, x.subject]), [['req@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - EV-PR20261007000001']]);
});
test('submitConfirmation: names the auto-approved steps', () => {
  assert.doesNotMatch(m.submitConfirmation(pr).html, /tự động duyệt/);
  const c = m.submitConfirmation(pr, [{ step: 2, labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.match(c.html, /Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu \(đã xác nhận bằng mật khẩu\): bước 2 \(Người duyệt Ngân sách, Người duyệt NCC\)\./);
});
```

In `tests/purchase-requests/submit.test.js`, replace the test `the requester may not pick themselves (decision #3), even when on the company list` with:

```js
test('self-picks (Plan 5c): off the company list → list message; on it → the requester is asked to confirm, nothing stored', { skip }, async () => {
  const r1 = await call(h.handlePRSubmit, submitBody(company, people, { budgetApprover: 'REQ@pr-test.vn' }), REQ);
  assert.equal(r1.success, false);
  assert.match(r1.message, /^Người phê duyệt ngân sách \(req@pr-test\.vn\) không thuộc danh sách người duyệt của công ty này/);
  const r2 = await call(h.handlePRSubmit, submitBody(company, people), as(people.treasurer));
  assert.deepEqual([r2.success, r2.needSelfApproval], [false, true]);
  const n = (await pool.query('SELECT count(*)::int AS n FROM purchase_requests WHERE requester_email = $1', [people.treasurer])).rows[0].n;
  assert.equal(n, 0, 'nothing stored');
});
```

In `tests/purchase-requests/decide.test.js`:
- Replace the test `approve: the requester can never approve their own PR` with:
```js
test('approve: a requester with no slot on the PR cannot approve it', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, 'req@pr-test.vn', 'budget')).message, 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
});
```
- In the test `resubmit: the requester picking themselves is refused; the token decides who the requester is`, rename it to `resubmit: picks off the company list are refused; the token decides who the requester is`, and replace `assert.equal(self.message, 'Bạn không thể tự phê duyệt đề nghị của chính mình.');` with `assert.match(self.message, /^Người phê duyệt ngân sách \(req@pr-test\.vn\) không thuộc danh sách/);`.

Create `tests/purchase-requests/self-approval.test.js`:

```js
// tests/purchase-requests/self-approval.test.js — Plan 5c on PRs: self-picks allowed; the requester's own slots are
// auto-approved after one password at submit / resubmit (TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { sampleSignatureFor } from '../../api/lib/approval/signature-check.js';
import { failKey, lockKey } from '../../api/lib/approval/step-up.js';

let s, d, pool, company, people, redis, cleanupStepUp;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.treasurer, people.accountant, people.ap]);
});
after(async () => { if (cleanupStepUp) await cleanupStepUp(); await teardown(pool); });

const NOTE = (labels) => `Tự động duyệt khi gửi phiếu (người đề nghị là ${labels})`;
const BS = 'Người duyệt Ngân sách, Người duyệt NCC';
const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mailsTo = async (no, part) => (await pool.query(`SELECT to_email FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${part}%${no}`])).rows.map((r) => r.to_email);
const mailBody = async (no, part) => (await pool.query(`SELECT body_html FROM email_queue WHERE subject LIKE $1 ORDER BY id DESC LIMIT 1`, [`%${part}%${no}`])).rows[0].body_html;
const audit = async (no) => (await pool.query(`SELECT action, role, actor_email, note, extra FROM pr_audit_log WHERE doc_no = $1 ORDER BY id`, [no])).rows;
const approve = (no, who, role, password = PW) => call(d.handlePRApprove, { prNo: no, approverRole: role, note: '', approverPassword: password }, as(who));
const stampOf = async (email) => FAKE_STAMP((await sampleSignatureFor(pool, company.id, null, email)).url);

test('requester = budget + supplier: asked once (nothing stored), then both slots approved with one stamp; purchasing asked', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  const ask = await call(s.handlePRSubmit, body, T);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true]);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 2, key: '*', labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.equal(ask.message, `Bạn cũng là người duyệt bước 2 (${BS}) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.`);
  assert.equal(await pr(body.prNo), undefined);
  const saved = process.env.P2P_SPREADSHEET_ID;
  process.env.P2P_SPREADSHEET_ID = 'p2p-test';
  let r;
  try { r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T); }
  finally { if (saved === undefined) delete process.env.P2P_SPREADSHEET_ID; else process.env.P2P_SPREADSHEET_ID = saved; }
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, `Đề nghị mua hàng đã được gửi thành công. Đã tự động duyệt bước 2 (${BS}) của bạn.`);
  assert.deepEqual(r.autoApproved, [{ step: 2, labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Mua hàng (5/5)');
  const stamp = await stampOf(people.treasurer);
  assert.equal(row.metadata.budgetSignature, stamp);
  assert.equal(row.metadata.supplierSignature, stamp);
  assert.equal(row.metadata.budgetNote, NOTE(BS));
  assert.deepEqual([row.metadata.budgetSignatureVerification.verified, row.metadata.budgetSignatureVerification.method], [true, 'password']);
  assert.deepEqual(row.pending_emails, [people.ap]);
  assert.deepEqual(row.metadata.selfApproval.stamps, [], 'no own slot left');
  const log = await audit(body.prNo);
  assert.deepEqual(log.map((a) => [a.action, a.role, a.actor_email, a.extra.auto === true]), [
    ['Submit', 'requester', people.treasurer, false], ['Approve', 'budget', people.treasurer, true], ['Approve', 'supplier', people.treasurer, true]]);
  assert.equal(log[1].note, NOTE(BS));
  const ob = (await pool.query(`SELECT tab, record FROM sheet_outbox WHERE record->>'pr_no' = $1 OR record->>'document_no' = $1 ORDER BY id`, [body.prNo])).rows;
  assert.deepEqual(ob.filter((o) => o.tab === 'PR_Audit_Log').map((o) => o.record.action), ['Submit', 'Approve', 'Approve'], 'auto-approval mirrored');
  assert.equal(ob.filter((o) => o.tab === 'Purchase_Request_History').at(-1).record.status, 'Mua hàng (5/5)');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [], 'no "please approve" email to the requester');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap]);
  assert.match(await mailBody(body.prNo, 'Xác nhận gửi phiếu'), /đã được tự động duyệt khi gửi phiếu/);
});

test('requester = budget only: budget approved at submit; the supplier approver alone is asked', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people, { supplierApprover: people.accountant });
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công. Đã tự động duyệt bước 2 (Người duyệt Ngân sách) của bạn.');
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.deepEqual([row.metadata.budgetStatus, row.metadata.supplierStatus], ['Approved', 'Pending']);
  assert.deepEqual(row.pending_emails, [people.accountant]);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [people.accountant]);
  const a = await approve(body.prNo, people.accountant, 'supplier');
  assert.equal(a.status, 'Mua hàng (5/5)');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap]);
});

test('requester = purchasing: nothing at submit; the budget approval auto-approves purchasing and completes the PR', { skip }, async () => {
  const P = as(people.ap);
  const body = submitBody(company, people);
  const ask = await call(s.handlePRSubmit, body, P);
  assert.deepEqual(ask.selfApproval.steps, [{ step: 5, key: '*', labels: ['Người mua hàng'] }]);
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, P);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  assert.equal(r.autoApproved, undefined);
  assert.equal((await pr(body.prNo)).metadata.selfApproval.stamps.length, 1);
  const a = await approve(body.prNo, people.treasurer, 'budget');
  assert.equal(a.success, true, a.message);
  assert.equal(a.status, 'Hoàn thành');
  const row = await pr(body.prNo);
  assert.equal(row.metadata.purchasingSignature, await stampOf(people.ap));
  assert.equal(row.metadata.purchasingNote, NOTE('Người mua hàng'));
  assert.deepEqual(row.pending_emails, []);
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [], 'never asked for their own step');
  assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã hoàn thành'), [people.ap]);
  assert.deepEqual((await audit(body.prNo)).at(-1).role, 'purchasing');
});

test('declined: submitted as today; the requester is emailed and approves by hand', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  const r = await call(s.handlePRSubmit, { ...body, selfApprovalDeclined: true }, T);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  const row = await pr(body.prNo);
  assert.equal(row.metadata.selfApproval, undefined);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu phê duyệt'), [people.treasurer]);
  const a = await approve(body.prNo, people.treasurer, 'budget');
  assert.equal(a.success, true, a.message);
  assert.equal(a.status, 'Mua hàng (5/5)');
  assert.equal((await audit(body.prNo)).at(-1).extra.auto, undefined);
});

test('wrong password: asked again, nothing stored; same lockout counter as approvals', { skip }, async () => {
  await redis.del(failKey(people.treasurer), lockKey(people.treasurer));
  const T = as(people.treasurer);
  try {
    const body = submitBody(company, people);
    for (let i = 0; i < 4; i += 1) {
      const w = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: 'wrong' }, T);
      assert.deepEqual([w.needSelfApproval, w.message], [true, 'Mật khẩu không đúng.']);
    }
    assert.equal(await pr(body.prNo), undefined);
    const other = (await call(s.handlePRSubmit, submitBody(company, people), REQ)).prNo;
    assert.equal((await approve(other, people.treasurer, 'budget', 'wrong')).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
    const locked = await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T);
    assert.deepEqual([locked.needSelfApproval, locked.message], [true, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.']);
  } finally { await redis.del(failKey(people.treasurer), lockKey(people.treasurer)); }
});

test('send-back to step 2 is re-approved by hand; a resubmit asks for consent again', { skip }, async () => {
  const T = as(people.treasurer);
  const body = submitBody(company, people);
  assert.equal((await call(s.handlePRSubmit, { ...body, selfApprovalPassword: PW }, T)).success, true);
  const back2 = await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'purchasing', targetStep: 2, sentBackNote: 'Xem lại' }, as(people.ap));
  assert.equal(back2.success, true, back2.message);
  let row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.equal(row.metadata.budgetStatus, 'Pending', 'not auto-approved again');
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  const back1 = await call(d.handlePRSendBack, { prNo: body.prNo, approverRole: 'budget', targetStep: 1, sentBackNote: 'Bổ sung' }, T);
  assert.equal(back1.success, true, back1.message);
  const re = submitBody(company, people, { prNo: body.prNo });
  const ask = await call(s.handlePRResubmit, re, T);
  assert.deepEqual([ask.success, ask.needSelfApproval], [false, true], 'the old consent is not reused');
  assert.equal((await pr(body.prNo)).status, 'Trả lại bổ sung');
  const r = await call(s.handlePRResubmit, { ...re, selfApprovalPassword: PW }, T);
  assert.equal(r.message, `Đã gửi lại đề nghị thành công. Đã tự động duyệt bước 2 (${BS}) của bạn.`);
  row = await pr(body.prNo);
  assert.equal(row.status, 'Mua hàng (5/5)');
  assert.equal(row.metadata.selfApproval.round, 2);
  assert.deepEqual(await mailsTo(body.prNo, 'Phiếu đã được cập nhật và gửi lại'), [], 'nobody left to ask at step 2');
  assert.deepEqual(await mailsTo(body.prNo, 'Yêu cầu Mua hàng'), [people.ap, people.ap], 'submit, then resubmit');
  assert.deepEqual((await audit(body.prNo)).slice(-3).map((a) => a.action), ['Resubmit', 'Approve', 'Approve']);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`. Expected failures:
- `state.test.js`: `prOwnSteps` is not exported.
- `self-approval.test.js`: the first ask answers `Bạn không thể tự phê duyệt…`.
- `emails.test.js`: `openStageRequests` is not a function.

- [ ] **Step 3: `api/lib/purchase-requests/state.js`**

1. In the header comment, replace `// - the requester may not pick themselves as an approver (decision #3).` with `// - the requester may pick themselves; with their password at submit their slots are auto-approved (Plan 5c, 2026-10-08).`
2. Delete the line `export const SELF_APPROVAL_ERROR = 'Bạn không thể tự phê duyệt đề nghị của chính mình.';`.
3. In `applyApprove`, delete the line `if (me && me === lower(pr.requester_email || meta.requesterEmail)) return { error: SELF_APPROVAL_ERROR };`.
4. Replace the doc comment and the first three lines of `approverPickError` with the following. The rest of the function is unchanged.
```js
/**
 * The requester's picks must come from the lists the page offers (GAS trusted any email, S3).
 * requesterEmail (4th arg) is required (fail closed). The requester may pick themselves (Plan 5c).
 */
export function approverPickError(picks, { companyEmails, purchasingEmails }, branch, requesterEmail = '') {
  if (!lower(requesterEmail)) return MISSING_REQUESTER_ERROR;
```
5. Add after `emailOf`:
```js
/** Role names in emails and in the self-approval texts. */
export const ROLE_LABEL = { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' };
/** Step numbers of the PR status labels: (2/5) budget & supplier, (4/5) contract, (5/5) purchasing. */
const STAGE_STEP = { parallel: 2, contract: 4, purchasing: 5 };
const REACHABLE = ['parallel', 'purchasing']; // approvalState never opens the contract stage (GAS parity)
const ownEntry = (stage, roles) => ({ step: STAGE_STEP[stage], key: '*', entries: null, roles, labels: roles.map((r) => ROLE_LABEL[r]) });

/** The submit picks as the approver columns of a row (for prOwnSteps before the PR exists). */
export const picksAsRow = (picks) => ({ budget_approver_email: picks.budget, supplier_approver_email: picks.supplier,
  contract_approver_email: picks.contract, purchasing_approver_email: picks.purchasing });

/** Plan 5c: every reachable stage where `email` holds a slot, in order (what the requester consents to). */
export function prOwnSteps(pr, email) {
  const me = lower(email);
  if (!me) return [];
  return REACHABLE.map((stage) => [stage, ROLES.filter((r) => ROLE_STAGE[r] === stage && emailOf(pr, r) === me)])
    .filter(([, roles]) => roles.length).map(([stage, roles]) => ownEntry(stage, roles));
}

/** Plan 5c: the requester's not-yet-approved slots in the OPEN stage (null when none, or the PR is not open). */
export function prOwnOpen(pr, meta, email) {
  const me = lower(email);
  if (!me || isTerminal(pr.status) || isReturned(pr.status)) return null;
  const { stage } = approvalState(pr, meta);
  if (!REACHABLE.includes(stage)) return null;
  const roles = ROLES.filter((r) => ROLE_STAGE[r] === stage && emailOf(pr, r) === me && meta[`${r}Status`] !== 'Approved');
  return roles.length ? ownEntry(stage, roles) : null;
}

/** Plan 5c: does `email` still hold a reachable slot that is not approved? */
export const prOwnLeft = (pr, meta, email) => ['budget', 'supplier', 'purchasing'].some((r) => emailOf(pr, r) === lower(email) && meta[`${r}Status`] !== 'Approved');

/** How many times the PR was sent back: a consent given in an earlier round no longer applies. */
export const sentBackRound = (meta) => (Array.isArray((meta || {}).sentBackHistory) ? meta.sentBackHistory.length : 0);
```

- [ ] **Step 4: `api/lib/purchase-requests/emails.js`**

1. Replace the line `export const ROLE_LABEL = { … };` with:
```js
import { ROLE_LABEL, approvalState, pendingEmails } from './state.js';
import { selfEmailHtml } from '../approval/self-approval.js';
export { ROLE_LABEL };
```
Move the two `import` lines up next to the existing `import { baseUrl, money } …` line.
2. Replace `approvalRequests`, `submitConfirmation` and `resubmitNotices` with the versions below, and add `openStageRequests`:
```js
/** `to` defaults to budget + supplier (GAS); after a self-approval only the slots still open are asked. */
export function approvalRequests(pr, to = [pr.budget_approver_email, pr.supplier_approver_email]) {
  return distinct(...to).map((t) => mail(t, `${P} Yêu cầu phê duyệt - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Có một <strong>Đề nghị mua hàng</strong> mới đang chờ phê duyệt của bạn.</p>${table(pr)}
     <p>Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>${button(pr.pr_no)}${attachmentList(pr)}`));
}

/** `auto` = the requester's steps auto-approved at submit (Plan 5c): named in the email. */
export function submitConfirmation(pr, auto = []) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Xác nhận gửi phiếu - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng của bạn đã được gửi thành công.</p>${table(pr, { requester: false })}
     <p>Người phê duyệt đã được thông báo qua email và sẽ xử lý đề nghị của bạn.</p>${selfEmailHtml(auto)}${button(pr.pr_no)}${attachmentList(pr)}`);
}

export function resubmitNotices(pr, to = [pr.budget_approver_email, pr.supplier_approver_email]) {
  return distinct(...to).map((t) => mail(t,
    `${P} Phiếu đã được cập nhật và gửi lại - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Người đề nghị đã cập nhật và gửi lại <strong>Đề nghị mua hàng</strong>. Vui lòng xem lại và phê duyệt.</p>
     ${table(pr)}${button(pr.pr_no)}${attachmentList(pr)}`));
}

/**
 * After a submit or resubmit (and any self-approval): ask whoever the PR now waits for. The open stage's approvers
 * who still have to act, or the purchasing request, or the completion notice when nothing is left.
 */
export function openStageRequests(pr, kind = 'submit') {
  const meta = pr.metadata || {};
  const { stage } = approvalState(pr, meta);
  if (stage === 'complete') return [completed(pr)];
  if (stage === 'purchasing') return [purchasingRequest(pr)];
  const to = pendingEmails(pr, meta, pr.status);
  return kind === 'resubmit' ? resubmitNotices(pr, to) : approvalRequests(pr, to);
}
```

- [ ] **Step 5: `api/lib/purchase-requests/views.js`**

Add `import { withoutStamps } from '../approval/self-approval.js';` and change `fullFromRow` to `metadata: JSON.stringify(withoutStamps(row.metadata || {})),`.

- [ ] **Step 6: `api/handlers/pr/auto.js`**

```js
// api/handlers/pr/auto.js — Plan 5c: the requester's own PR slots, auto-approved inside the caller's transaction
// (after submit, resubmit and every approval). One approval covers every open slot of the requester in the stage
// (applyApprove's same-person merge); each is stamped with the sample confirmed at submit.
import { autoAdvance, consentFor, recordAuto } from '../../lib/approval/self-approval.js';
import { verificationRecord } from '../../lib/approval/step-up.js';
import { applyApprove, pendingEmails, prOwnOpen, prOwnLeft, sentBackRound } from '../../lib/purchase-requests/state.js';
import { updatePR, recordChange } from '../../lib/purchase-requests/repo.js';

/** `row` = the PR as just written in this transaction. Returns { state: the PR as last written, auto }. */
export function autoAdvancePR(client, row, now = () => new Date()) {
  return autoAdvance(client, {
    state: row, companyId: row.company_id, now,
    consentOf: (r) => consentFor(r.metadata, { requesterEmail: r.requester_email || (r.metadata || {}).requesterEmail, round: sentBackRound(r.metadata) }),
    pendingOwn: (r, me) => prOwnOpen(r, r.metadata || {}, me),
    approve: async (r, { consent, mine, stamp, at, note }) => {
      const a = applyApprove(r, r.metadata || {}, { email: consent.by, role: mine.roles[0], note, at,
        signature: stamp.signature, verification: verificationRecord(stamp.from, at) });
      if (a.error) throw new Error(`self-approval refused: ${a.error}`); // rolls back; never half-written
      const metadata = { ...a.meta, selfApproval: recordAuto(consent, mine, at, prOwnLeft(r, a.meta, consent.by)) };
      const saved = await updatePR(client, r.id, { metadata, status: a.status, pending_emails: pendingEmails(r, metadata, a.status) });
      const extra = { auth: 'password', signatureStamped: true, sampleFrom: stamp.from, auto: true, consentedAt: consent.consentedAt };
      await recordChange(client, saved, a.roles.map((role) => ({ action: 'Approve', role, actorEmail: consent.by,
        actorName: saved.requester_name, prevStatus: r.status, newStatus: a.status, note, extra, at })));
      return saved;
    },
  });
}
```

- [ ] **Step 7: `api/handlers/pr/submit.js`**

1. Imports:
   - Change the `state.js` import to `import { STATUS, approverEmails, pendingEmails, approverPickError, isReturned, prOwnSteps, picksAsRow, sentBackRound } from '../../lib/purchase-requests/state.js';`.
   - Change the emails import to `import { openStageRequests, submitConfirmation } from '../../lib/purchase-requests/emails.js';`.
   - Add `import { requestConsent, askBody, doneText, publicAuto } from '../../lib/approval/self-approval.js';` and `import { autoAdvancePR } from './auto.js';`.
2. In `prepareSubmission`, change the trailing comment of the `pickError` line to `// required: fails closed; self-picks allowed (Plan 5c)`.
3. Add above `handlePRSubmit`:
```js
/** Plan 5c: the requester's own slots among `picks` — asked and confirmed before any upload, transaction or lock. */
function prConsent({ db, redis, now }, b, caller, { company, sub }, round = 0) {
  return requestConsent({ db, redis, email: caller.email, password: b.selfApprovalPassword, declined: b.selfApprovalDeclined,
    own: prOwnSteps(picksAsRow(sub.picks), caller.email), companyId: company.id, lang: 'vi', at: now().toISOString(), round });
}
const withAuto = (message, auto) => (auto.length ? `${message} ${doneText(auto)}` : message);
const autoFields = (auto) => (auto.length ? { autoApproved: publicAuto(auto) } : {});
```
4. `handlePRSubmit`:
   - `const { db, s3, who, now, redis } = prDeps(d);`
   - After `if (early.error) return fail(res, early.error);` add:
```js
    const sa = await prConsent({ db, redis, now }, b, caller, early);
    if (sa.ask) return res.json(askBody(sa));
```
   - Change `let row;` to `let row; let auto = [];`.
   - After the `buildMetadata(...)` statement add `if (sa.consent) metadata.selfApproval = sa.consent;`.
   - After the `recordChange(client, row, { action: 'Submit', … });` statement add `({ state: row, auto } = await autoAdvancePR(client, row, now));`.
   - Replace the email loop and the answer with:
```js
    for (const m of [...openStageRequests(row), submitConfirmation(row, auto)].filter(Boolean)) await queueMail(m, db);
    publishEvent('pr:submitted', { prNo: row.pr_no, status: row.status });
    return ok(res, withAuto('Đề nghị mua hàng đã được gửi thành công.', auto), { prNo: row.pr_no, ...autoFields(auto) });
```
5. `handlePRResubmit`:
   - `const { db, s3, who, now, redis } = prDeps(d);`
   - After `if (early) return fail(res, early);` add:
```js
    // A resubmit is a new version: consent is asked again (the old one is gone with the old metadata)
    const sa = await prConsent({ db, redis, now }, b, caller, prep, sentBackRound(current.metadata));
    if (sa.ask) return res.json(askBody(sa));
```
   - In the `metadata` literal, after `resubmittedAt: at, resubmitCount: count,` add `...(sa.consent ? { selfApproval: sa.consent } : {}),`.
   - Replace the last line of the work function (`return { saved, mails: resubmitNotices(saved), … };`) with:
```js
      const { state: final, auto } = await autoAdvancePR(client, saved, now);
      return { saved: final, mails: openStageRequests(final, 'resubmit'), message: withAuto('Đã gửi lại đề nghị thành công.', auto),
        fields: { prNo: final.pr_no, ...autoFields(auto) } };
```

- [ ] **Step 8: `api/handlers/pr/decide.js`**

1. Add `approvalState` to the `state.js` import. Add `import { autoAdvancePR } from './auto.js';`.
2. In `handlePRApprove`, replace the four lines from `const mails = [];` through `return { saved, mails, message: 'Đã duyệt thành công.', … };` with:
```js
      // Plan 5c: the requester's own next slot(s), when they consented at submit — same commit, real time
      const { state: final } = await autoAdvancePR(client, saved, now);
      const stage = approvalState(final, final.metadata || {}).stage;
      const mails = [];
      if (stage === 'purchasing' && r.before.stage !== 'purchasing') mails.push(purchasingRequest(final)); // both branches (B2)
      if (stage === 'complete') mails.push(completed(final));
      return { saved: final, mails, message: 'Đã duyệt thành công.', fields: { prNo: final.pr_no, status: final.status } };
```

- [ ] **Step 9: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail. `grep -rn "SELF_APPROVAL_ERROR" api tests` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add api/lib/purchase-requests/state.js api/lib/purchase-requests/emails.js api/lib/purchase-requests/views.js \
  api/handlers/pr/auto.js api/handlers/pr/submit.js api/handlers/pr/decide.js \
  tests/purchase-requests/self-approval.test.js tests/purchase-requests/state.test.js tests/purchase-requests/submit.test.js \
  tests/purchase-requests/decide.test.js tests/purchase-requests/emails.test.js
git commit -m "feat(pr): self-picks allowed; requester's own slots auto-approved after one password at submit/resubmit (Plan 5c)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pages: the shared prompt (JS only; GAS answers pass through untouched)

**Files:**
- Modify: `approval-password.js`, `i18n.js`, `voucher.html`, `purchase_request.html`, `tests/approval/approval-password.test.js`

**Interfaces:**
- Consumes: the Task 2 / Task 3 wire contract (`needSelfApproval`, `selfApproval.prompt`, `message`, `autoApproved`).
- Produces:
  - `ApprovalPassword.ask(opts)` accepts `title`, `hint`, `error`, `confirmLabel`, `cancelLabel` (old callers unchanged).
  - `ApprovalPassword.selfApproval(result, resend) → Promise<result>`. `resend(extra)` resends the same submit with `{ selfApprovalPassword }` or `{ selfApprovalDeclined: true }`.

- [ ] **Step 1: Write the failing tests** (in `tests/approval/approval-password.test.js`)

1. In `fakeDocument`, change the id list in `set innerHTML` to `['apw-title', 'apw-hint', 'apw-error', 'apw-label', 'apw-input', 'apw-cancel', 'apw-ok', 'form']`.
2. Add:
```js
const tick = () => new Promise((r) => setImmediate(r));
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm context have another Object prototype

test('ApprovalPassword.selfApproval: a GAS answer (or any answer without needSelfApproval) passes through, no dialog, no resend', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  let resent = 0;
  const gas = { success: true, message: 'Đã gửi' };
  assert.equal(await box.self.ApprovalPassword.selfApproval(gas, async () => { resent += 1; }), gas);
  const err = { success: false, message: 'Lỗi' };
  assert.equal(await box.self.ApprovalPassword.selfApproval(err, async () => { resent += 1; }), err);
  assert.equal(resent, 0);
  assert.equal(doc.body.children.length, 0);
});

test('ApprovalPassword.selfApproval: server prompt; password resent; error shown on the retry; cancel → declined', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  const sent = [];
  const answers = [
    { success: false, needSelfApproval: true, message: 'Mật khẩu không đúng.', selfApproval: { prompt: 'P', steps: [] } },
    { success: true, message: 'done' },
  ];
  const first = { success: false, needSelfApproval: true, message: 'P', selfApproval: { prompt: 'P', steps: [] } };
  const p = box.self.ApprovalPassword.selfApproval(first, async (extra) => { sent.push(extra); return answers.shift(); });
  await tick();
  let dlg = doc.body.children[0];
  assert.equal(dlg.querySelector('#apw-title').textContent, 'Tự động duyệt bước của bạn');
  assert.equal(dlg.querySelector('#apw-hint').textContent, 'P');
  assert.equal(dlg.querySelector('#apw-error').textContent, '', 'no error before a password was sent');
  assert.equal(dlg.querySelector('#apw-ok').textContent, 'Gửi và tự động duyệt');
  assert.equal(dlg.querySelector('#apw-cancel').textContent, 'Bỏ qua, tôi duyệt sau');
  dlg.querySelector('#apw-input').value = 'wrong';
  dlg.querySelector('form').fire('submit');
  await tick(); await tick();
  dlg = doc.body.children[0];
  assert.equal(dlg.querySelector('#apw-error').textContent, 'Mật khẩu không đúng.');
  dlg.querySelector('#apw-cancel').fire('click');
  assert.deepEqual(await p, { success: true, message: 'done' });
  assert.deepEqual(plain(sent), [{ selfApprovalPassword: 'wrong' }, { selfApprovalDeclined: true }]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test tests/approval/approval-password.test.js`. Expected: FAIL with `selfApproval is not a function`.

- [ ] **Step 3: Replace `approval-password.js`**

```js
// approval-password.js — Postgres approvals: ask the approver for their login password (decision 2026-10-07, option D),
// and Plan 5c's self-approval prompt at submit (selfApproval). Plain <script>, no dependencies, its own overlay (no
// page HTML touched). GAS mode never opens it: GAS never answers needSelfApproval, and approvals ask only on Postgres.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApprovalPassword = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 200;

  function t(key, fallback) {
    var i18n = typeof TLCI18n !== 'undefined' ? TLCI18n : null;
    return i18n && i18n.t ? i18n.t(key, fallback) : fallback;
  }

  function valid(pw) { return typeof pw === 'string' && pw.length > 0 && pw.length <= MAX; }

  var open = false; // one dialog at a time

  /**
   * Resolves the typed password, or null when cancelled. opts.count > 1 shows the number of documents (bulk).
   * opts.title / hint / error / confirmLabel / cancelLabel replace the default texts (Plan 5c prompt).
   * A call while a dialog is already open is ignored: no second dialog, resolves null (the caller does nothing).
   */
  function ask(opts) {
    opts = opts || {};
    if (open) return Promise.resolve(null);
    open = true;
    return new Promise(function (resolve) {
      var doc = document;
      var overlay = doc.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'apw-title');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;';
      overlay.innerHTML =
        '<form style="background:#fff;color:#0f172a;border-radius:12px;max-width:380px;width:100%;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:14px system-ui,sans-serif;">' +
          '<h3 id="apw-title" style="margin:0 0 8px;font-size:16px;"></h3>' +
          '<p id="apw-hint" style="margin:0 0 12px;color:#475569;line-height:1.4;"></p>' +
          '<p id="apw-error" role="alert" style="margin:0 0 12px;color:#b91c1c;font-weight:600;line-height:1.4;"></p>' +
          '<label for="apw-input" id="apw-label" style="display:block;font-weight:600;margin-bottom:4px;"></label>' +
          '<input id="apw-input" type="password" autocomplete="current-password" maxlength="' + MAX + '" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">' +
            '<button type="button" id="apw-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;"></button>' +
            '<button type="submit" id="apw-ok" style="padding:8px 16px;border-radius:8px;border:none;background:#0056CC;color:#fff;cursor:pointer;"></button>' +
          '</div>' +
        '</form>';
      var count = opts.count > 1 ? ' (' + opts.count + ')' : '';
      overlay.querySelector('#apw-title').textContent = (opts.title || t('apwTitle', 'Xác nhận phê duyệt')) + count;
      overlay.querySelector('#apw-hint').textContent = opts.hint || t('apwHint', 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.');
      var err = overlay.querySelector('#apw-error');
      err.textContent = opts.error || '';
      err.style.display = opts.error ? '' : 'none';
      overlay.querySelector('#apw-label').textContent = t('apwLabel', 'Mật khẩu đăng nhập');
      overlay.querySelector('#apw-cancel').textContent = opts.cancelLabel || t('apwCancel', 'Hủy');
      overlay.querySelector('#apw-ok').textContent = opts.confirmLabel || t('apwConfirm', 'Duyệt');
      var input = overlay.querySelector('#apw-input');
      function onKey(e) { if (e.key === 'Escape') done(null); }
      function done(value) {
        open = false;
        doc.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      overlay.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        if (valid(input.value)) done(input.value); else input.focus();
      });
      overlay.querySelector('#apw-cancel').addEventListener('click', function () { done(null); });
      doc.addEventListener('keydown', onKey);
      doc.body.appendChild(overlay);
      input.focus();
    }).catch(function (e) { open = false; throw e; }); // a dialog that failed to open never blocks the next one
  }

  /**
   * Plan 5c. `result` = the submit answer. While the server answers needSelfApproval, show its prompt (with its
   * error once a password was sent) and call resend({ selfApprovalPassword }) or, on cancel / Escape,
   * resend({ selfApprovalDeclined: true }) — the request is then submitted and approved by hand later.
   * Any other answer (every GAS answer) is returned untouched: no dialog, no resend.
   */
  function selfApproval(result, resend) {
    var sentPassword = false;
    function step(r) {
      if (!r || r.needSelfApproval !== true) return Promise.resolve(r);
      var sa = r.selfApproval || {};
      return ask({
        title: t('sapTitle', 'Tự động duyệt bước của bạn'),
        hint: sa.prompt || r.message || '',
        error: sentPassword ? (r.message || '') : '',
        confirmLabel: t('sapConfirm', 'Gửi và tự động duyệt'),
        cancelLabel: t('sapCancel', 'Bỏ qua, tôi duyệt sau'),
      }).then(function (pw) {
        sentPassword = pw !== null;
        return resend(pw === null ? { selfApprovalDeclined: true } : { selfApprovalPassword: pw });
      }).then(step);
    }
    return step(result);
  }

  return { ask: ask, valid: valid, selfApproval: selfApproval, MAX: MAX };
});
```

- [ ] **Step 4: `i18n.js`**

In the `vi` block, after `apwCancel: 'Hủy',`, add:
```js
      sapTitle: 'Tự động duyệt bước của bạn',
      sapConfirm: 'Gửi và tự động duyệt',
      sapCancel: 'Bỏ qua, tôi duyệt sau',
```
In the `en` block, after `apwCancel: 'Cancel',`, add:
```js
      sapTitle: 'Approve your own steps',
      sapConfirm: 'Submit and approve',
      sapCancel: 'Skip, I will approve later',
```

- [ ] **Step 5: `voucher.html`** (JS only, inside the submit function around line 9886)

1. Replace
```js
            const submitToGAS = async () => {
                console.log('🚀 Sending request to backend...');
                const formData = new FormData();
                formData.append('data', payloadString);
```
with
```js
            const submitToGAS = async (extra) => {
                console.log('🚀 Sending request to backend...');
                const formData = new FormData();
                // Plan 5c: a resend after the self-approval prompt adds selfApprovalPassword / selfApprovalDeclined
                formData.append('data', extra ? JSON.stringify(Object.assign({}, payload, extra)) : payloadString);
```
2. Inside `submitToGAS`, replace
```js
                if (!result.success) throw new Error(result.message || 'Failed to send approval email');
                return result;
```
with
```js
                if (result.needSelfApproval === true) return result; // Postgres only (Plan 5c): GAS never answers it
                if (!result.success) throw new Error(result.message || 'Failed to send approval email');
                return result;
```
3. Replace the first line inside the following `try {`, `const result = await submitToGAS();` at line ~9908 (not the one in `retryLoop`), with:
```js
                const firstAnswer = await submitToGAS();
                // Plan 5c: the requester is also an approver → one password, or "approve later" (GAS answers skip this)
                const result = firstAnswer.needSelfApproval === true ? await ApprovalPassword.selfApproval(firstAnswer, submitToGAS) : firstAnswer;
```
4. Replace
```js
                showToast(`Đã gửi yêu cầu phê duyệt cho ${validRecipients.join(', ')}${validCCRecipients.length > 0 ? ' (CC: ' + validCCRecipients.join(', ') + ')' : ''}`, 'success', 'Gửi thành công');
```
with
```js
                showToast(Array.isArray(result.autoApproved) && result.autoApproved.length ? result.message
                    : `Đã gửi yêu cầu phê duyệt cho ${validRecipients.join(', ')}${validCCRecipients.length > 0 ? ' (CC: ' + validCCRecipients.join(', ') + ')' : ''}`, 'success', 'Gửi thành công');
```

- [ ] **Step 6: `purchase_request.html`** (JS only, in `submitForm`, around line 3355)

1. Replace
```js
            const sendParams = new URLSearchParams();
            sendParams.append('data', JSON.stringify(payload));
            const res    = await fetch(BACKEND_URL, {
                method: 'POST', mode: 'cors', redirect: 'follow',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: sendParams.toString(),
            });
            const result = JSON.parse(await res.text());
```
with
```js
            const send = async (extra) => {
                const sendParams = new URLSearchParams();
                sendParams.append('data', JSON.stringify(extra ? Object.assign({}, payload, extra) : payload));
                const res    = await fetch(BACKEND_URL, {
                    method: 'POST', mode: 'cors', redirect: 'follow',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: sendParams.toString(),
                });
                return JSON.parse(await res.text());
            };
            const firstAnswer = await send();
            // Plan 5c (Postgres only; GAS never answers needSelfApproval): the requester confirms their own approval steps
            const result = firstAnswer && firstAnswer.needSelfApproval === true ? await ApprovalPassword.selfApproval(firstAnswer, send) : firstAnswer;
```
2. Replace
```js
                showToast(resubmitPrNo ? '✅ Đã gửi lại đề nghị thành công!' : 'ĐỀ NGHỊ MUA HÀNG đã được gửi thành công!', 'success', 4000);
```
with
```js
                showToast(Array.isArray(result.autoApproved) && result.autoApproved.length ? result.message
                    : (resubmitPrNo ? '✅ Đã gửi lại đề nghị thành công!' : 'ĐỀ NGHỊ MUA HÀNG đã được gửi thành công!'), 'success', 4000);
```

- [ ] **Step 7: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail. Also run `git diff --stat voucher.html purchase_request.html`: only the lines above have changed, and there are no HTML/CSS hunks.

- [ ] **Step 8: Commit**

```bash
git add approval-password.js i18n.js voucher.html purchase_request.html tests/approval/approval-password.test.js
git commit -m "feat(pages): self-approval prompt at submit on Postgres (one password or approve later); GAS answers untouched

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: End-to-end with GAS dead, GAS-mode regression, roadmap

**Files:**
- Scratch (not committed):
  - `e2e-self.cjs`: model it on the scratch `e2e-stamp.cjs`. Log in through `#login-email` / `#login-pass` with `Test#2026`; each line below is one PASS/FAIL check.
  - `gas-stub.cjs`.
- Modify: `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`.

- [ ] **Step 1: Start with every GAS URL dead**

```bash
psql tlcg_v_test -c "truncate email_queue, sheet_outbox, approval_flows"
redis-cli -n 15 --scan --pattern 'stepup:*' | xargs -r redis-cli -n 15 del
PORT=3999 HOST=127.0.0.1 PG_WORKFLOWS=vouchers,p2p,files APP_BASE_URL=http://127.0.0.1:3999 P2P_SPREADSHEET_ID=test-p2p-sheet VOUCHER_SPREADSHEET_ID=test-voucher-sheet \
TLCG_CASH_BACKEND_URL=http://127.0.0.1:9/gas TLCG_CORE_BACKEND_URL=http://127.0.0.1:9/gas TLCG_P2P_BACKEND_URL=http://127.0.0.1:9/gas \
DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 RESEND_API_KEY= node server.js 2>&1 | tee /tmp/self-e2e.log
```
Expected: no `FATAL` in the log.

- [ ] **Step 2: Browser scenario (e2e-self.cjs)**

1. `voucher.html` as the M.I chief accountant (nhanh.nguyen@tl-c.com.vn), requester = herself, company M.I. Submit opens the dialog:
   - title `Tự động duyệt bước của bạn`;
   - text `Bạn cũng là người duyệt bước 1 (Kế toán trưởng) của phiếu này. Nhập mật khẩu để tự động duyệt các bước của bạn.`;
   - buttons `Gửi và tự động duyệt` / `Bỏ qua, tôi duyệt sau`.

   No `vouchers` row exists yet.
2. Wrong password: the dialog comes back with `Mật khẩu không đúng.` in red; still no row.
3. Right password:
   - the toast contains `Đã tự động duyệt bước 1 (Kế toán trưởng) của bạn.`;
   - the row has status `Đang duyệt (1/3)`, and `metadata.accountantSignature` is the data URL of the company's accountant sample;
   - the last history note is `Tự động duyệt khi gửi phiếu (người đề nghị là Kế toán trưởng)`;
   - `email_queue` has `[PHÊ DUYỆT]` only to the legal representative;
   - `sheet_outbox` has 4 rows for the voucher.
4. The voucher print view shows the stamped accountant signature.
5. A second voucher with Cancel: it is stored as `Đang treo`, and `[PHÊ DUYỆT]` goes to nhanh. She approves it by hand from the voucher modal with her password: `Đang duyệt (1/3)`.
6. Set M.I's voucher flow in `admin.html` › Luồng phê duyệt to Đại diện pháp luật → Kế toán trưởng → Thủ quỹ. nhanh submits a voucher with her password; the toast has no auto-approval text, because step 1 belongs to chinh. Then chinh approves it in `voucher.html`:
   - his toast says `Đã gửi email đến <treasurer name> để tiếp tục phê duyệt.`;
   - the voucher is `Đang duyệt (2/3)`, with nhanh's step auto-approved in the same click.

   Reset the flow afterwards (`truncate approval_flows`).
7. `purchase_request.html` as linh.le@tl-c.com.vn (E.V treasurer). Pick herself as budget and supplier, and an AP purchaser:
   - the dialog says `bước 2 (Người duyệt Ngân sách, Người duyệt NCC)`;
   - after the password, the toast mentions the auto-approval;
   - the PR is `Mua hàng (5/5)`, and the drawer shows both slots approved with the note;
   - `Yêu cầu Mua hàng` is sent to the AP purchaser, and no `Yêu cầu phê duyệt` email is sent.
8. A PR whose requester is the AP purchaser (purchasing = self): the treasurer approves in the drawer and the PR becomes `Hoàn thành` at once. No `Yêu cầu Mua hàng` email is sent.
9. A PR sent back to step 1, then "Chỉnh sửa & Gửi lại": the dialog appears again. Cancel resubmits with linh.le's slots pending.
10. Secrets and samples stay out of emails and logs:
    - `SELECT count(*) FROM email_queue WHERE body_html LIKE '%data:image%' OR body_html LIKE '%Test#2026%'` → 0;
    - `grep -c 'Test#2026' /tmp/self-e2e.log` → 0;
    - `SELECT count(*) FROM voucher_history WHERE jsonb_path_exists(metadata, '$.selfApproval.stamps[*].signature')` → 0 (no stamp copy in history).
11. `grep -c "127.0.0.1:9" /tmp/self-e2e.log` → `0`.

- [ ] **Step 3: GAS-mode regression**

1. Read-only against the real GAS: restart the server without `PG_WORKFLOWS` and with the real GAS URLs. Rerun the scratch `gas-regress.cjs` (Plan 5b: 14 checks). Do not submit, approve or reject anything against live GAS.
2. Submit path against a stub (`gas-stub.cjs`):
   - The stub is a 20-line Node `http` server on 127.0.0.1:9911. It logs the `action` of every POST (`/"action":"([^"]+)"/` on the body, else `action=` in a form body). It answers `getVoucherSummary` with `{"success":true,"data":{"recent":[],"stats":{}}}` and everything else with `{"success":true,"message":"stub ok","data":{}}`.
   - Restart the server without `PG_WORKFLOWS` and with all three `TLCG_*_BACKEND_URL` set to `http://127.0.0.1:9911/gas`.
   - Checks (no attachments: with `files` off, uploads would go to the stub too):
     - In `voucher.html`, submit a voucher as nhanh with herself as requester. Exactly one `sendApprovalEmail` reaches the stub, no dialog opens (`#apw-title` is never in the DOM), and the toast starts with `Đã gửi yêu cầu phê duyệt cho`.
     - In `purchase_request.html`, submit as linh.le with herself as budget. Exactly one `purchaseRequest` reaches the stub, no dialog opens, and the toast is `ĐỀ NGHỊ MUA HÀNG đã được gửi thành công!`.

- [ ] **Step 4: Clean up and update the roadmap**

`psql tlcg_v_test -c "truncate email_queue, sheet_outbox, approval_flows"`.

In `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`:
- After the `2b.` item, add: `2c. ✅ **Plan 5c: the requester's own approval steps auto-approved (password once at submit)** (\`2026-10-08-self-approval-auto.md\`). Done <date>: e2e with every GAS URL dead <n>/<n>; GAS-mode regression <m>/<m>; Plans 6–7 call \`api/lib/approval/self-approval.js\` from their submit and approval paths.`. Fill in the real date and counts.
- Append the section "Switch-day additions (Plan 5c)" below.

```bash
git add docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md
git commit -m "docs: GAS exit roadmap - plan 5c done (self-approval at submit)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Switch-day additions (Plan 5c)
1. No schema change: the consent lives in `metadata.selfApproval`. Nothing to migrate.
2. **Old requests are not auto-approved:** they have no consent. After the import, list the open requests waiting for their own requester, so each requester approves them by hand once (one password per voucher, or one for a bulk approve):
   ```sql
   SELECT voucher_number, requestor_email, status FROM vouchers
    WHERE status NOT IN ('Đã duyệt','Đã từ chối','Received') AND LOWER(requestor_email) = ANY(pending_emails);
   SELECT pr_no, requester_email, status FROM purchase_requests
    WHERE LOWER(requester_email) = ANY(pending_emails) AND status <> 'Trả lại bổ sung';
   ```
   TL-PC20260828000001 (Nguyễn Thị Nhanh, 0/3 since 28/08) is expected in the first list. Send the list to the user.
3. Requesters who are also approvers need a working registered sample. Without one, the prompt shows `NO_SAMPLE` and they can only "approve later". The Plan 5b sample check (Plan 5b Task 7 step 3) covers them; re-run it on production data.
4. Tell staff: on the new system, a requester who is also an approver is asked for their login password once when they send the request. "Bỏ qua, tôi duyệt sau" sends it anyway, and they then approve their own step by hand.
5. Wrong passwords at submit count toward the same 5-failure / 15-minute approval lock as approvals (Plan 5b decision 1). Support should know that a locked submitter can still submit with "Bỏ qua".

## Open questions
1. **Submitted on behalf of someone else.** The voucher page lets a submitter pick another employee as the requester. Self-approval applies only when the signed-in submitter *is* the requester. Two cases follow:
   - An assistant submitting for the chief accountant cannot consent for her; she approves by hand.
   - A chief accountant submitting for an employee approves her own step by hand.

   Should the second case (the submitter's own steps, when the submitter is not the requester) also be auto-approved?
2. **PR sent back to step 2 (re-review).** The purchaser can send a PR back to the budget & supplier step. The requester-as-budget-approver must then re-approve by hand; the original consent does not carry over, because the point of a send-back is a fresh look. Is that right, or should their slot be re-approved automatically?
3. **Declined consent and the "please approve" email.** When the requester presses "Bỏ qua, tôi duyệt sau" (or the request predates Plan 5c), they still get today's "please approve" email for their own step, as their reminder to approve by hand. Keep it, or suppress every email to the requester about their own steps?

## Decisions on the open questions (controller, 2026-10-08; these override the tasks where they differ)
1. **Submitting for someone else.** When the signed-in submitter files for another employee and is an approver of any step, the rule applies to the submitter's own steps: the same prompt, password and auto-approval, with the history note naming the submitter's role. The consent belongs to the signed-in submitter (token), never to the employee named on the form.
2. **PR sent back to step 2.** The requester's consent carries over. Their reset slots are auto-approved again when the request reaches them, with a fresh stamp from the stored consent record and the same history note. Content is unchanged on a step-2 send-back. A step-1 send-back followed by a resubmit asks for fresh consent, as planned.
3. **Requester who skips the prompt.** Keep the normal "please approve" email to the requester for their own step, as a reminder.
4. **Decision 2 is reversed (controller, 2026-10-08, after Task 3).** If the requester holds every budget/supplier slot, carrying consent over a step-2 send-back would re-approve them at once, which defeats the point of sending back. So the consent does NOT carry over ANY send-back. After a step-2 send-back the requester re-approves their reset slots by hand. A step-1 send-back followed by a resubmit asks for fresh consent, as before.
5. **Prompt outcomes (controller, after Task 4).** The submit prompt has three choices: "Gửi và tự động duyệt" (with the password), "Bỏ qua, tôi duyệt sau" (declined, submit normally) and "Hủy" (nothing is submitted). **Escape = Hủy**, the safe choice. This overrides the earlier "Cancel and Escape both mean declined".
