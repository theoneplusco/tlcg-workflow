# Production Hardening — 2-Week Plan

**Date:** 2026-09-22  
**Status:** Rewrite after code audit — awaiting review  
**Scope:** Voucher list/uploads + Payment Request list/approval gates. Ubuntu cutover runs beside this, not in front of it.

## What users feel

| Flow | Pain | Cause in the current code |
|------|------|---------------------------|
| **Voucher** | Slow list, HTTP 500 | `voucher.html` `renderNextVoucherBatch` calls `loadVoucherApprovalStatus` → `getApprovalStatus` **once per card**. `vercel.json` caps `/api/voucher` at **30s**. |
| **Voucher** | Attachment / signature failures | Client already sets `useDriveAPI = false`. Remaining risk is the Cash web app not deployed **Execute as: Me**, or Drive folder access. |
| **PMT** | Slow list | `handleGetRecentPaymentRequests` reads the **whole sheet** (`getDataRange()`). |
| **PMT** | Wrong step can be approved | `handleApprovePaymentRequest` trusts `data.stage` from the browser. It only blocks “this column is already Approved/Rejected.” |

Sheets and Drive stay the system of record. This plan does not move user data.

## Already done — do not redo

- `handleGetVoucherSummary` already skips MetaJSON column R and, after the read, only **processes** the last 5,000 rows (`allRows.slice(-5000)`). It still **loads every row** first. `headers` from `data[0]` is unused; rows are read by column index.
- Voucher submit already uses GAS base64 (`useDriveAPI = false` in `voucher.html`).
- PMT submit / approve / reject already call `_appendAuditLog_` → `PMT_Audit_Log`.
- PR already has `computePRApprovalState_` and out-of-order gates. Copy that idea onto PMT; do not rebuild PR.

## Quality bar (this sprint)

1. Voucher list renders badges from `getVoucherSummary` only. Opening the list does **not** call `getApprovalStatus` per row.
2. List and submit do not return HTTP 500 because the proxy gave up at 30s.
3. `handleApprovePaymentRequest` rejects a stage that is not the active one.
4. One non-owner account can submit a voucher with an attachment and get a Drive URL in the sheet.

p95 &lt; 5s is **not** the bar until we time a live `getVoucherSummary` and `getRecentPaymentRequests`. If those stay slow after the row cap, raise the row window or cache TTL. Do not start a Postgres replica in this sprint.

## Track 0 — same day, current host (Vercel)

Raise the function cap so slow GAS stops looking like a random 500 while the rest ships.

- In `vercel.json`, set `maxDuration` for `api/voucher.js` and `api/voucher/[action].js` from **30** to **120**.
- Redeploy. No data change.

This is a stopgap on Hobby. It is not the production host.

## Week 1 — Voucher

### 1. Remove the per-card status fetch

`voucher.html` `renderNextVoucherBatch` (around the `next.forEach` that calls `loadVoucherApprovalStatus`) must stop. Badges already come from summary fields via `deriveVoucherStatusBadge` / `(N/3)` in status.

- Keep `loadAndDisplayApprovalStatus` for the **detail modal** only (one voucher, on click).
- `index.html` still defines `loadVoucherApprovalStatus`. Do not wire it into a list loop. If the dashboard list does not call it, leave the function unused or delete the call site only.

**Done when:** Network tab on the voucher list shows one `getVoucherSummary` (plus master data), not N `getApprovalStatus`.

### 2. Stop reading rows the handler already throws away

`handleGetVoucherSummary` loads columns A–Q for the whole sheet, then keeps the last **5,000** data rows. Move that window into the read.

Apps Script `getRange(row, column, numRows, numColumns)` — the third argument is a **count**, not the end row:

```javascript
var WINDOW = 5000;
var startRow = Math.max(2, lastRow - WINDOW + 1);
var numRows = lastRow - startRow + 1;
var data = sheet.getRange(startRow, 1, numRows, 17).getValues();
```

Those values are all data rows (row 1 is the header and is not included). Do not `slice(1)` them. Keep the 5,000 limit; do not invent a second cap. Do not read column R.

**Done when:** a sheet with more than 5,000 rows does not `getRange` from row 1 through `lastRow`.

### 3. In-process read cache (not HTTP cache headers)

`/api/voucher` is **POST**. Cloudflare will not cache it. Do **not** add `Cache-Control: s-maxage` and expect a hit.

Add a small `Map` in `api/voucher.js` (same process as the rate limiter):

| Action | TTL | Cache key |
|--------|-----|-----------|
| `getVoucherSummary` | 30s | action + `callerEmail` + `callerRole` + `isAdmin` |
| `getEmployees` | 60s | action only (shared master list) |
| `getCompanyApprovers` | 60s | action + company id/name if present |

Skip the cache for every write (`submit`, `approve`, `reject`, uploads). On a successful voucher mutate from this process, delete summary keys for that caller (best-effort; TTL covers the rest).

Personalized responses must never share a key across emails.

**Done when:** two identical summary posts inside 30s from the same user produce one GAS call.

### 4. Upload check (no code unless the deploy is wrong)

Confirm the **Cash** web app is deployed **Execute as: Me**. Submit one voucher with an attachment **and** a signature as a normal employee (not the script owner). The Attachments cell must contain a Drive URL, not `Lỗi upload`.

If it fails, fix the GAS deploy / folder permission. Do not switch the client back to `/api/drive-upload`.

## Week 2 — Payment Request

### 1. Bound the list users actually wait on

`handleGetRecentPaymentRequests` in `TLCG_P2P_BACKEND.gs` is the dashboard list (`payment_request.html` posts `getRecentPaymentRequests`). It calls `getDataRange()` on the whole sheet.

Read only the columns the list object uses (indexed by `CONFIG.COLUMNS`), and only the last **5,000** data rows — same window as the voucher summary. `getRange(startRow, startCol, numRows, numCols)` uses a row **count**. Keep the email filter and newest-first sort on that window.

`handleGetPaymentRequestHistory` is a per-`requestId` scan. Bound its columns the same way if it is on a hot path; do not spend the week on it if the recent-list call is the one that times out.

**Done when:** the recent-list handler no longer calls `getDataRange()` on the full used range.

### 2. Reject out-of-order approve

In `handleApprovePaymentRequest`, **before** writing `Approved`:

- Read the row’s stage status columns (`BUDGET`, `SUPPLIER`, `LEGAL`, `ACCOUNTING`, `DIRECTOR`, `FINAL`).
- Active stage = first stage in that order whose status is not `Approved` and not `N/A` (empty approver on an optional stage counts as skip — match how the sheet already marks unassigned stages).
- If `data.stage` is not that active stage, return an error and write nothing.
- Keep the existing “already Approved / Rejected” checks and the signature requirement.
- Keep the existing `_appendAuditLog_` call after a successful write + `SpreadsheetApp.flush()`.

Do not add a PMT notification bell in this sprint.

**Done when:** approving `director` while `budget` is still pending returns an error and the sheet row is unchanged.

### 3. Upload check

Same as voucher: signature required (already enforced when `data.signature` is missing), attachments go through GAS/DriveApp, folder ID is the existing `PAYMENT_REQUEST_FOLDER_ID`. One non-owner submit with a file must store a Drive URL.

## Track H — Ubuntu (parallel, not a gate)

Production host remains **Path A**: the existing Ubuntu box, Cloudflare tunnel, app on **port 3001** (`deploy/README.md`). Path B (Railway/Render) and Vercel Pro are not this sprint.

- Copy current env (`TLCG_*_BACKEND_URL`, `MASTER_SPREADSHEET_ID`, Drive folder IDs, `APP_BASE_URL=https://workflow.tl-c.us`) before any DNS change.
- Smoke `getEmployees` and `getVoucherSummary` and confirm **known live rows**, not an empty sheet.
- Set `APP_BASE_URL` on the server and in CASH + P2P Script Properties.
- Keep Vercel DNS as rollback for **24–48 hours**. Rollback is the website only. Do not copy or replace Sheets.
- nginx/Caddy already allow **120s**. `api/voucher.js` `fetch` to GAS has no AbortSignal; the proxy timeout is what cuts the request. Leave that as-is for this sprint.

Week 1–2 code ships to whatever origin users hit today (Vercel), then the same commit is what Ubuntu runs. Do not block the voucher N+1 fix on the cutover.

## Explicitly out of this sprint

- New spreadsheets, new Drive folders, data migration.
- Postgres / Supabase read replica.
- O2C backend.
- PMT notification bell.
- Rewriting PR approval (`computePRApprovalState_` stays).
- Public-IP + certbot runbook path. The live box uses the tunnel.

## Order of work

1. Track 0: `maxDuration` 120 and redeploy (same day).
2. Week 1 items 1 → 2 → 3, then the upload check.
3. Week 2 items 1 → 2, then the upload check.
4. Track H whenever the box is free; it does not reorder 1–3.

## Risks

| Risk | What to do |
|------|------------|
| Last-5,000 window hides an older open voucher | Same window the summary already applies after a full read. Do not go back to reading the whole sheet to avoid it. |
| 30s cache shows a stale badge after approve | Delete that caller’s summary key on mutate; 30s TTL is the backstop. |
| Summary cache key omits role | Admin and employee would share a list. Key must include email + role + isAdmin. |
| PMT “active stage” skips a blank optional column incorrectly | Treat blank + no approver as skip; treat `Pending` as blocking. Verify with one real multi-stage row before shipping. |
| Wrong spreadsheet ID on Ubuntu | Smoke-test against a voucher number you already know. |

## References

- `voucher.html` — `renderNextVoucherBatch`, `loadVoucherApprovalStatus`
- `TLCG_CASH_BACKEND.gs` — `handleGetVoucherSummary`
- `TLCG_P2P_BACKEND.gs` — `handleGetRecentPaymentRequests`, `handleApprovePaymentRequest`
- `api/voucher.js` — rate-limit `Map` (same place for the read cache)
- `vercel.json` — `maxDuration: 30`
- `deploy/README.md` — tunnel, port 3001
- `.cursor/rules/voucher-approval-status.mdc`, `voucher-file-upload.mdc`, `p2p-audit-trail.mdc`
