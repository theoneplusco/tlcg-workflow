# Voucher Pages for Approval Flows Implementation Plan (Plan 3 of the approval-matrix roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** voucher.html, approve_voucher.html, reject_voucher.html and the index.html dashboard work with any approval flow (N steps, group steps, any role or person), act as the signed-in user, and keep today's behaviour unchanged while vouchers still run on GAS.

**Architecture:** Postgres answers carry extra fields (`myTurn`, progress `done/total`, `approvalPlan`); the pages use them when present and fall back to today's logic for GAS answers, so one page works in both modes. A shared `voucher-steps.js` renders steps and progress. Identity comes from the login JWT, added to same-origin `/api/` calls by the existing fetch wrapper in `i18n.js`.

**Tech Stack:** vanilla JS in the existing pages, Express handlers, `node:test`, Playwright (scratch) for end-to-end checks.

## Global Constraints
- GAS mode (PG_WORKFLOWS without `vouchers`) must behave exactly as today — every change is guarded by "field present".
- Vietnamese status strings unchanged; bilingual labels via `i18n.js` where pages already use it.
- Approving/rejecting requires being signed in; the actor is the token's user, never a URL parameter.
- No signature check is skipped: an approver without a registered sample is told to ask an admin.
- Cutover only with the user's explicit approval.

## Tasks

### Task 1: Identity from the login token (server + fetch wrapper)
- `i18n.js` fetch wrapper: for same-origin `/api/` requests, add `Authorization: Bearer <tlc_current_user.token>` when present (never for other origins).
- `api/lib/auth-caller.js`: `callerFromRequest(req) → { email, isAdmin, name } | null` (verifies JWT, re-checks the employee is active; admin from DB).
- vouchers handlers: summary/history/status use the token's user when present (ignore `callerEmail` / `isAdmin` params then); submit/approve/reject/acknowledge/bulk: when a token is present the actor must be the token's user; when `VOUCHER_REQUIRE_LOGIN=true` (set at cutover) a token is required.
- Tests: spoofed callerEmail ignored with a token; approve as someone else refused; no token + require-login refused.

### Task 2: Step-aware data for the pages
- Summary rows: `myTurn` (caller is pending on the current step), `approvalTotal`, progress `done/total`.
- New action `getApprovalContext { voucherNumber }` (token required): voucher fields, `approvalPlan`, `myEntries` (my pending entries on the current step), `canApprove` + reason, `sampleSignatureUrl` (role sample from Master Company for chief accountant / legal rep / treasurer; otherwise Master Employee column `Signature`), `canReject`.
- Tests for each case incl. "no sample → canApprove false with message".

### Task 3: `voucher-steps.js` (shared, tested in Node)
- `progressOf(v)` → `{ done, total }` from `meta.companyApprovers.approvalProgress` ("d/N"; GAS "0/3").
- `stepsTimelineHtml(plan)` — steps top-down, group steps with every approver and "Tất cả phải duyệt", ✅ / ⏳ / ✖ states, times.

### Task 4: voucher.html
- `normalizeVoucherState`: N-step aware (`done >= total` = approved).
- My Task, notification bell, pending counts: `v.myTurn` when present, else today's role/progress logic.
- List progress text and status modal: `done/total`; modal renders `approvalPlan` steps when present.
- Approve / bulk approve from the page: sample signature from `getApprovalContext` when on Postgres.

### Task 5: approve_voucher.html / reject_voucher.html
- Require sign-in (redirect to index.html with return URL); actor = signed-in user; context + sample from `getApprovalContext`; clear messages when it is not your turn or you are not in the flow. GAS mode unchanged.

### Task 6: index.html dashboard
- Voucher widgets / status modal use `done/total` and steps when present.

### Task 7: End-to-end checks (local, PG_WORKFLOWS=vouchers)
- Playwright: submit → custom company flow with a group step → each approver signs in and approves (email link + list) → acknowledge; reject path; My Task shows exactly the vouchers waiting on me; GAS-mode regression run with the same pages.

### Then: Sheet mirror (Plan 2 Task 7) and the cutover checklist
- Re-import vouchers fresh; set `PG_WORKFLOWS=vouchers`, `VOUCHER_REQUIRE_LOGIN=true`; disable the GAS `sendReminderEmails` trigger; watch for a day with the mirror on.
