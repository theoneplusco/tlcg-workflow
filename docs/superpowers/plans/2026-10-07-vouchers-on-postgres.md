# Vouchers on Postgres Implementation Plan (Plan 2 of the approval-matrix roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every voucher action the pages use runs on Postgres with the same request/response contract as GAS, approvals follow the approval-matrix engine, and the 450 existing vouchers + history are imported — all behind `PG_WORKFLOWS=vouchers`, so production stays on GAS until Plan 3 verifies and switches.

**Architecture:** `vouchers` = one row per voucher (current state, like the Voucher_Current sheet) holding the engine plan snapshot in `metadata.approvalPlan`; `voucher_history` = append-only rows exactly like the Voucher_History sheet. A thin compatibility layer projects the plan into the legacy `meta.companyApprovers` (accountant / legalRep / treasurer, "N/3") so today's voucher.html keeps working for 3-step flows; Plan 3 teaches the UI N-step plans. Emails go through the existing Resend queue. Drive uploads and signature-image fetches stay on GAS (they store files, not workflow state).

**Tech Stack:** Node 24 ESM, Express handlers, `pg`, Resend queue (`api/handlers/email-queue.js`), engine from Plan 1 (`api/lib/approval/*`), `node:test`.

## Global Constraints

- Request/response shapes match GAS exactly (field names, `data` nesting, Vietnamese messages/status strings: `Đang treo`, `Đang duyệt (n/N)`, `Đã duyệt`, `Received`, `Đã từ chối`; history actions `Đã nộp phiếu`, `Duyệt bởi <name>`, `Từ chối bởi <name>`, `Đã xác nhận thu tiền` / `Đã xác nhận nhận tiền`).
- Approve / bulk approve require `approverSignature` and `signatureVerification.verified === true` (browser does the perceptual-hash check, as today).
- Rejection needs a reason; only a current-step approver may approve or reject (engine).
- Self-approval allowed (VOUCHER_WORKFLOW_RULES §6).
- Voucher numbers come from the browser (`{CODE}-{PT|PC}{YYYYMMDD}{6 digits}`); duplicates refused.
- Row lock (`SELECT … FOR UPDATE`) on every state change.
- Stays on GAS: `createVoucherUploadSession`, `finalizeVoucherUpload`, `uploadVoucherFile(Chunk)`, `fetchSignatureImage`, `refreshApproverEmails`, `importFromVHImport`. (`syncToSheets` is dead code — no GAS handler.)
- Nothing reaches production until Plan 3 sets `PG_WORKFLOWS=vouchers`.

## Contract reference (from TLCG_CASH_BACKEND.gs)

| Action | Request | Response `data` |
|---|---|---|
| `sendApprovalEmail` | `{ email:{to,subject,body,cc,replyTo}, requesterEmail:{to,subject,body}, voucher:{voucherNumber, voucherType, company, companyKey, employee, requestorEmail, submittedBy, amount, reason, description, dueDate, voucherDate, department, payeeName, amountInWords, expenseItems, requesterSignature, files:[{fileName,fileUrl,fileSize}], companyApprovers} }` | none; message `Đã gửi yêu cầu phê duyệt thành công` |
| `approveVoucher` | `{ voucher:{voucherNumber, approverEmail, approverName, approverSignature, signatureVerification:{verified,similarity,reason}} }` | none; message names next approver or "duyệt hoàn toàn" |
| `rejectVoucher` | `{ voucher:{voucherNumber, approverEmail, rejectReason} }` | none |
| `acknowledgeReceipt` | `{ voucherNumber, requesterEmail, requesterName, requesterSignature }` | none |
| `bulkApprove` | `{ voucherNumbers[], approverEmail, approverName, approverSignature, signatureVerification }` | `{ approved[], failed[{voucherNumber,error}] }` |
| `getVoucherSummary` | `{ callerEmail, callerRole, isAdmin }` (query or body) | `{ total, pending, approved, rejected, recent[], callerApproverRole, globalStats }` — `recent[i]`: `voucherNumber, voucherType, company, employee, requestorEmail, amount, status, action, timestamp, timestampFormatted, meta.companyApprovers.{approvalProgress, currentApprover}` |
| `getVoucherHistory` | `{ voucherNumber }` | array, newest first: `voucherNumber … approvedAt, meta` (sheet columns) |
| `getApprovalStatus` | `{ voucherNumber }` | `{ voucherNumber, overallStatus, displayStatus, approvalProgress, currentApprover, currentApproverName, approvers, requesterEmail, submittedAt, lastUpdatedAt }` |

## File Structure

| File | Responsibility |
|---|---|
| `db/migrations/005_vouchers_engine.sql` | vouchers: `submitted_at`, `last_action`, `progress_done`, `progress_total`, `pending_emails TEXT[]`, `approver_emails TEXT[]` + GIN indexes; voucher_history: `acknowledged_at`, `acknowledged_by`, `signature_url`, `rejection_reason`, `sheet_row` |
| `api/lib/vouchers/compat.js` | Pure: plan → legacy `companyApprovers`; legacy `companyApprovers` → plan (import); status text; bucket rules; visibility `shouldShow` |
| `api/lib/vouchers/emails.js` | Pure: subject/HTML for next-approver (approve/reject links), progress, final + acknowledge prompt, rejection, acknowledged, batch, reminder |
| `api/lib/vouchers/repo.js` | DB: load/lock voucher, append history, update state, summary query |
| `api/handlers/vouchers.js` | The 8 actions above (replaces `voucher-approve.js`) |
| `api/jobs/voucher-reminders.js` | Daily reminder (1 day before due date) with a Redis lock so one of the 12 workers runs it |
| `scripts/import-vouchers.js` | Voucher_Current + Voucher_History CSV → Postgres (idempotent upsert; builds plans from legacy meta) |
| `tests/vouchers/*.test.js` | compat, emails, handlers (DB), import |

## Tasks

### Task 1: Schema + compatibility layer (pure, tested)
- `planFromCompanyApprovers(ca, companyId)` — legacy 3-role meta → engine plan (statuses, approvedAt, signatures, rejected).
- `legacyCompanyApprovers(plan)` — engine plan → `{approvers:{accountant,legalRep,treasurer…}, approvalProgress:'d/N', currentApprover, overallStatus, displayStatus, approvalSequence}`; role keys mapped chief_accountant→accountant, legal_rep→legalRep, treasurer→treasurer, others → `step<n>`.
- `statusText(plan)` — `Đang treo` / `Đang duyệt (d/N)` / `Đã duyệt` / `Đã từ chối`.
- `shouldShow(voucher, caller)` — admin: all; own (email, or name for pre-email vouchers); caller in `approver_emails`: shown unless fully approved/acknowledged and not own.
- Tests: round-trip legacy↔plan for pending / 1/3 / 3/3 / rejected; status text; visibility matrix (admin, own, approver open, approver closed, stranger).

### Task 2: Submit / approve / reject / acknowledge / bulk (DB handlers)
- Submit: resolve active flow for the company (`getActiveFlow`) → `buildPlan`; refuse when `problems` (role empty); store voucher + first history row (`Đang treo`, `Đã nộp phiếu`, attachments as `name (size)\nurl` lines); queue email to **all** step-1 approvers using the browser's subject/body, plus requester email with status link.
- Approve: lock row, `applyApproval`, history row `Duyệt bởi <name>` with legacy note, emails: next step approvers (all), progress to requester, final + acknowledge prompt when finished.
- Reject: reason required, `applyRejection`, history row, email requester + every plan approver.
- Acknowledge: only when approved; once; history `Received`; email first-step approver(s) cc others.
- Bulk: same checks per voucher; group next-step emails per approver (batch email).
- Tests against a test DB with a 2-step custom flow and the default flow.

### Task 3: Reads — summary, history, approval status
- Summary from `vouchers` (indexed), GAS field names, `globalStats` for admins, `callerApproverRole` = legacy role if the caller holds chief_accountant / legal_rep / treasurer in any company.
- History from `voucher_history` (newest first, `meta` parsed).
- Approval status from the plan via `legacyCompanyApprovers` + `currentApproverName`.
- Tests: field-by-field parity against GAS fixtures captured from the live GAS endpoint for 5 real vouchers.

### Task 4: Emails + reminders
- Port the GAS email bodies (approve/reject links to approve_voucher.html / reject_voucher.html with the same query params; status link `/voucher.html?viewStatus=`).
- Daily reminder job (Redis lock `tlcg:job:voucher-reminders:<date>`).
- Tests: snapshot of subjects/links per email type.

### Task 5: Import
- `scripts/import-vouchers.js --dir <csv>`: Voucher_History rows → `voucher_history` (signature data URLs kept in meta); per voucher the latest state from Voucher_Current; plan built from the richest legacy meta; idempotent (upsert by voucher_number; history replaced per voucher).
- Verify: counts (450 / 1,865), every voucher's status/progress equals Voucher_Current, 20 random vouchers' history identical to GAS `getVoucherHistory`.

### Task 6: Shadow verification (no cutover)
- With `PG_WORKFLOWS=vouchers` on a local server, compare `getVoucherSummary` / `getVoucherHistory` / `getApprovalStatus` responses against GAS for all 450 vouchers and the three caller types; list every difference. Cutover itself is Plan 3.

## Open decision (needs the user)
- After cutover, should Postgres keep writing vouchers back to the Google Sheet (for the pivot tables / reports that read Voucher_History), or is the sheet frozen as an archive?
