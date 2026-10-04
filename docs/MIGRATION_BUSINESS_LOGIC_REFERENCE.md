# TLCG Workflow — Complete Business Logic Reference

> Collected from `.cursor/rules/*.mdc` + actual GAS backend source code.
> This is the full spec that must be preserved when migrating to Postgres + R2.

---

## Table of Contents

1. [Workflow Language Rules](#1-workflow-language-rules)
2. [Voucher Flow (Phiếu Thu/Chi)](#2-voucher-flow-phiếu-thuchi)
3. [Voucher Approval Status Reconstruction](#3-voucher-approval-status-reconstruction)
4. [Voucher File Upload (Drive)](#4-voucher-file-upload-drive)
5. [Signature Upload Rules](#5-signature-upload-rules)
6. [Purchase Request Flow (P2P)](#6-purchase-request-flow-p2p)
7. [Purchase Request Catalog (Goods-KTT)](#7-purchase-request-catalog-goods-ktt)
8. [P2P Audit Trail](#8-p2p-audit-trail)
9. [Notification Bell](#9-notification-bell)
10. [Backend Action → Handler Map](#10-backend-action--handler-map)

---

## 1. Workflow Language Rules

**Source:** `.cursor/rules/workflow-language.mdc` (alwaysApply: true)

### Language setting
- `localStorage` key: `tlc_language`
- Order: saved choice → browser (`vi*` → VI, `en*` → EN) → Vietnamese default
- Picking EN or VI on any page applies to every workflow
- Implemented in `i18n.js`, loaded by every page via `<script src="i18n.js"></script>`

### What stays Vietnamese (never translated, no `data-i18n`)
- **Official document titles:** `PHIẾU THU/CHI`, `PHIẾU THU`, `PHIẾU CHI`, `SỔ QUỸ`, `Bảng kiểm kê quỹ`, Mẫu 08a
- **Buttons:** `Làm mới`, `Việc của tôi` (tooltip may translate)
- **Search placeholder**, `✕ Xóa lọc`
- **Pipeline line:** `Tiến độ phê duyệt · Toàn công ty` and `· Việc của tôi`
- **List counts:** `450 phiếu`, `quá hạn`, `(Cập nhật: …)`, empty-list sentence
- **Status text on rows:** `Đang duyệt (1/3)`, `Đã duyệt`

### What switches language
- Section headings (title case in EN: `Recent Vouchers`, not `Recent vouchers`)
- Pipeline step labels, status filter
- Form field labels
- Uses `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria`
- JS-built strings: `TLCI18n.t(key, fallback)` + redraw on `TLCI18n.onChange`

### Never translate stored values
- Status strings in comparisons stay Vietnamese: `Chờ duyệt`, `Đang duyệt (1/3)`, `Đã duyệt`
- `(1/3)` counter stays
- Unknown status shown unchanged
- `tStatus()` for display-only mapping
- Emails stay Vietnamese (go to approver, not submitter)
- Sheet names, column headers, comparison strings never translated
- **Postgres note:** table/column names stay English, but status VALUES stored in DB stay Vietnamese

---

## 2. Voucher Flow (Phiếu Thu/Chi)

**Source:** `.cursor/rules/voucher-flow.mdc` + `TLCG_CASH_BACKEND.gs`

### Submit (`sendForApproval` → action `sendApprovalEmail`)

1. Company, type (Phiếu Thu or Chi), employee
2. Payee and reason
3. At least one expense line with content and amount
4. Requester signature (compressed in browser, stored in col R MetaJSON — not Drive)
5. Review → `sendForApproval()`

### Approval chain (sequential, fixed order)

```
accountant (1/3) → legalRep (2/3) → treasurer (3/3) → requester acknowledges receipt
```

- Approver emails from `Master Company` Column I (comma-separated, role order) — **never hardcoded**
- `_approveVoucherCore_` / `_approveVoucherCoreWithSheet_` allows only the `currentApprover` role
- Repeat approve rejected: `"Bạn đã phê duyệt phiếu này rồi."`
- Rejected voucher cannot be approved: `"Phiếu đã bị từ chối."`
- Out-of-sequence rejected: `"Chưa đến lượt phê duyệt. Đang chờ: " + expectedRole`
- Each status change appends one history row
- `approvalProgress` stored as integer string: `"1/3"`, `"2/3"`, `"3/3"`

### Acknowledgement (`handleAcknowledgeReceipt`)

- Only allowed when voucher is fully approved (status `Approved` / `Đã duyệt` / `overallStatus === 'Approved'`)
- Prevent double acknowledgement (check `meta.acknowledgedSignature`)
- Stores `acknowledgedSignature` separately from submission `requesterSignature`
- Appends history row with status `Received`
- Action text: `Đã xác nhận thu tiền` (Thu) / `Đã xác nhận nhận tiền` (Chi)

### Voucher list (`getVoucherSummary`)

- Reads last 5000 data rows, NO MetaJSON column
- Do not call `getApprovalStatus` per card
- `approvalProgress` derived from status column `(N/3)` pattern (see §3)

### Attachments

| Size | Path |
|---|---|
| ≤ 700 KB | Base64 inside `sendApprovalEmail` JSON (GAS truncates form fields near 1MB) |
| 700 KB – 10 MB | Raw file to `POST /api/voucher-file` → GAS `createVoucherUploadSession` → Node PUTs bytes → GAS `finalizeVoucherUpload` (link sharing) |

- Folder: `DRIVE_VOUCHER_FOLDER_ID` script property (fallback: `1RBBUUAQIrYTWeBONIgkMtELL0hxZhtqG`)
- Subfolder per voucher number
- `setSharing` is non-fatal (try/catch)
- **Never use `/api/drive-upload`** (Service Account has no quota on personal Drive)
- Error format: `filename.jpg (Lỗi upload: <errorMessage>)`

---

## 3. Voucher Approval Status Reconstruction

**Source:** `.cursor/rules/voucher-approval-status.mdc` + `TLCG_CASH_BACKEND.gs`

### progressFromStatus (authoritative)

```js
function progressFromStatus(status) {
  const s = (status || '').toString();
  if (s === 'Approved' || s === 'Đã duyệt' || s === 'Received' || s === 'Fully Approved') return 3;
  const m = s.match(/\((\d)\/3\)/);
  if (m) return parseInt(m[1]);
  if (s === 'Partially Approved' || s === 'In Progress' || s.startsWith('Approved ')) return 1;
  return 0;
}
```

### Fallback: unique approver email Set (old data only)

- For rows without `(N/3)` in status
- Count **unique** approver emails from Column P — use `Set`, never plain counter
- `nhanh@x.com × 3 rows` → Set size = **1** → 1/3 ✓
- `nhanh@x.com + le@x.com + linh@x.com` → Set size = **3** → 3/3 ✓

### Combining primary + fallback

```js
const statusProgress = progressMap.get(vNum) || 0;
const actionProgress = Math.min((approvalEmailSetMap.get(vNum) || new Set()).size, 3);
const bestProgress = statusProgress > 0 ? statusProgress : actionProgress;
```

**NEVER use `Math.max(statusProgress, actionProgress)`** — lets duplicate rows override correct status.

### isApprovalAction (for fallback)

```js
function isApprovalAction(action) {
  const a = (action || '').toString();
  return a.includes('Duyệt bởi') || a === 'Approved' || a.startsWith('Approved by');
}
```

### Approval reconstruction (`getVoucherFromHistory` / `_getVoucherFromData_`)

Two independent checks per row — **never `else if`**:

```js
// 1. Email match
if (rowApproverEmail) {
  // match against companyApprovers[role].email for each role
}
// 2. Meta check (ALSO runs — independent if, not else if)
if (rowMeta && rowMeta.companyApprovers) {
  // apply stored approval state from this row's metaJson
}
```

**Why both:** If configured email changes (`gmail.com` → `tl-c.com.vn`), email branch may not match old rows, but meta branch can still reconstruct from stored `companyApprovers`.

### Backend guards (`_approveVoucherCoreWithSheet_`)

```js
// Guard 1 — same person re-approve
if (companyApprovers.approvers[approverRole].status === 'approved') {
  return { success: false, error: 'Bạn đã phê duyệt phiếu này rồi.' };
}
// Guard 2 — wrong person (out of sequence)
if (approverRole !== currentApprover) {
  return { success: false, error: 'Chưa đến lượt phê duyệt. Đang chờ: ' + expectedRole };
}
// Guard 3 — rejected
if (companyApprovers.overallStatus === 'Rejected') {
  return { success: false, error: 'Phiếu đã bị từ chối.' };
}
```

Both `handleApproveVoucher` (single) and `handleBulkApprove` (batch) route through the same core.

### Approver email consistency

- `Master Company` Column I email **must exactly match** `approvedBy` in Voucher_History MetaJSON col R
- Mismatch → reconstruction fails → duplicate approvals allowed

### Frontend display

```js
const progressRaw = voucher?.meta?.companyApprovers?.approvalProgress || '0/3';
const progressNum = parseInt(progressRaw.split('/')[0], 10) || 0;
// progressNum >= 3  → "Đã Duyệt (3/3)"  (approved)
// progressNum 1-2   → "Đang Duyệt (N/3)" (in-progress)
// progressNum === 0 → "Chờ Duyệt (0/3)"  (pending)
```

### cleanupDuplicateApprovalRows (one-time data migration)

- Groups rows by `(voucherNumber + approverEmail)`
- For groups with >1 entry: keeps latest timestamp, deletes the rest
- `DRY_RUN = true` first, then `false`
- Vouchers with legitimate multi-approver rows (different emails per step) not touched
- **→ Becomes a one-time SQL script in the migration**

---

## 4. Voucher File Upload (Drive)

**Source:** `.cursor/rules/voucher-file-upload.mdc` + `api/voucher-file.js`

### Front-end attachment rules
- Accepted types: any (`*`) — no restriction on hidden file input
- Max per file: **10 MB**
- Multiple files per row allowed (`multiple` attribute)
- ≤ 700 KB → base64 inside `sendApprovalEmail` JSON (`useDriveAPI = false`)
- Total encoded payload ceiling: 900 KB
- > 700 KB → raw bytes to `POST /api/voucher-file`

### `/api/voucher-file` flow (132 lines)
1. Browser sends raw file → Node parses multipart with busboy
2. Node calls GAS `createVoucherUploadSession` → gets Drive resumable upload URL
3. Node PUTs raw bytes to that Drive URL
4. Node calls GAS `finalizeVoucherUpload` → GAS sets link sharing, returns public URL
5. Max file size enforced: 10 MB (`MAX_BYTES = 10 * 1024 * 1024`)

### GAS Drive upload (`uploadFilesToDrive_`)
- Folder: `DRIVE_VOUCHER_FOLDER_ID` script property (fallback: `1RBBUUAQIrYTWeBONIgkMtELL0hxZhtqG`)
- Subfolder per voucher number
- **MUST deploy as "Execute as: Me"** — not "User accessing the web app"
- `setSharing` non-fatal:
  ```js
  try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (shareErr) { Logger.log('⚠️ Could not set sharing: ' + shareErr.message); }
  return { fileName, fileUrl: f.getUrl(), fileSize };
  ```
- Folder access errors caught outside per-file loop → `{ error: true, errorMessage }` for every file
- Error format: `filename.jpg (Lỗi upload: <errorMessage>)` — never swallow real error

### `/api/drive-upload` (Service Account) — DO NOT USE
- Service Accounts have no storage quota on personal Drive
- Only viable for Shared Drive (Team Drive) with SA as member
- **Dead code in this project** — mounted but rules say not to use

---

## 5. Signature Upload Rules

**Source:** `.cursor/rules/signature-upload.mdc`

### Accepted file types
- `accept="image/png,image/jpeg,image/jpg"` on every `<input type="file">`
- JS validation: `['image/png', 'image/jpeg', 'image/jpg'].includes(file.type)`
- Error: `'Vui lòng chọn file hình ảnh PNG hoặc JPG'`

### Compression (before size check)
- Max dimensions: **800 × 400 px** (maintain aspect ratio)
- JPEG quality: **0.7**
- **Always fill canvas with white** before drawing (prevents transparent PNG → black in JPEG):
  ```js
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const base64 = canvas.toDataURL('image/jpeg', quality);
  ```

### Max size after compression
- **500 KB** (base64 string length)
- Check: `base64Data.length > 500 * 1024`
- Error: `'Chữ ký vẫn quá lớn sau khi nén (tối đa 500KB). Vui lòng chọn ảnh nhỏ hơn.'`

### MANDATORY — every submission + every approval, no exceptions

| Page | Action | Signature required |
|---|---|---|
| `purchase_request.html` | PR submission (requester, Step 3) | Yes |
| `purchase_request.html` | PR approval (approver, drawer) | Yes |
| `voucher.html` | Voucher submission (requester) | Yes |
| `voucher.html` | Voucher approval (individual modal) | Yes |
| `voucher.html` | Voucher bulk approval | Yes |
| `payment_request.html` | Payment request submission | Yes |
| `approve_voucher.html` / `reject_voucher.html` | Approve/reject landing | Yes |
| `approve_payment_request.html` / `reject_payment_request.html` | Payment approve/reject landing | Yes |

### Signature verification (`compareSignatures`)

- Budget / Supplier / Contract approvers: run `compareSignatures` against registered sample from `Master Company` sheet via `getCompanyApprovers`
- **Block if similarity < 75%**
- Error: `'Chữ ký không hợp lệ. Độ tương đồng: X% (yêu cầu: 75%)'`
- Purchasing approver (Kế Toán Chi): **no registered sample** → upload required but similarity check **skipped** (`no_sample` fallback)
- Requester signatures: **no verification** against sample needed

### Sample signature source
- `getCompanyApprovers` action → `TLCG_CASH_BACKEND.gs` → Master Company sheet:
  - Column F → `legalRep.signature`
  - Column J → `accountant.signature`
  - Column N → `treasurer.signature`
- Approver email matched against `legalRep.email`, `accountant.email`, `treasurer.email`

### Verification result stored in metadata

```js
meta.signatureVerification[approverRole] = {
  verified: sigVerResult.verified,
  similarity: sigVerResult.similarity,
  reason: sigVerResult.reason,
  verifiedAt: nowIso
};
```

---

## 6. Purchase Request Flow (P2P)

**Source:** `.cursor/rules/purchase-request-flow.mdc` + `TLCG_P2P_BACKEND.gs`

### Branch logic (`computeP2PBranch_`)

```js
function computeP2PBranch_(purchaseType, grandTotal) {
  var pt = (purchaseType || 'goods').trim().toLowerCase();
  var gt = parseFloat(grandTotal) || 0;
  if (pt === 'services' || gt >= 2000000) return 'full';
  return 'simplified';
}
```

- **Full** (services OR grand total ≥ 2,000,000₫): PR → contract module → acceptance → payment
- **Simplified** (goods < 2,000,000₫): PR → payment → goods receipt
- Under 2M₫ can be a payment request with no PR (`noPurchaseRequest: true`, no AM/PR number)
- At 2M₫ or more, payment still needs a PR + accepted biên bản nghiệm thu

### Approval model

```
Submit → Parallel: Budget + Supplier
       → Purchasing (only if assigned)
       → Hoàn thành
```

- `skipPRContract = true` for **both** branches (contract review is `contract.html`, not an in-PR stage)
- Full branch still requires contract reviewer on the form
- Budget + Supplier required (FE + BE validation)
- Contract approver required on full branch (but not an in-PR approve stage)
- Purchasing optional — only opens when parallel complete AND assigned
- Unassigned optional roles auto-skipped (`N/A` initial status)

### `computePRApprovalState_` (single source of truth for active stage)

```js
function computePRApprovalState_(row, metadata) {
  var budgetEmail     = (row[10] || '').toLowerCase().trim();
  var supplierEmail   = (row[11] || '').toLowerCase().trim();
  var contractEmail   = (row[17] || '').toLowerCase().trim();
  var purchasingEmail = (row[18] || '').toLowerCase().trim();

  var budgetDone    = !budgetEmail    || metadata.budgetStatus    === 'Approved';
  var supplierDone  = !supplierEmail  || metadata.supplierStatus  === 'Approved';
  var p2pBranch     = metadata.p2pBranch || 'full';
  var skipPRContract = p2pBranch === 'full' || p2pBranch === 'simplified';
  var contractDone  = skipPRContract || !contractEmail || metadata.contractStatus === 'Approved';
  var purchasingDone = !purchasingEmail || metadata.purchasingStatus === 'Approved';

  var parallelComplete = budgetDone && supplierDone;

  if (!parallelComplete)        { stage = 'parallel';    statusLabel = 'Đang duyệt ngân sách & NCC (2/5)'; }
  else if (!skipPRContract && contractEmail && !contractDone) { stage = 'contract';  statusLabel = 'Thẩm định Hợp đồng (4/5)'; }
  else if (purchasingEmail && !purchasingDone) { stage = 'purchasing'; statusLabel = 'Mua hàng (5/5)'; }
  else                          { stage = 'complete';   statusLabel = 'Hoàn thành'; }

  return { stage, statusLabel, budgetEmail, supplierEmail, contractEmail, purchasingEmail,
           parallelComplete, contractDone };
}
```

**Stage advancement:**
- `parallel` active while any of {budget, supplier} assigned but not Approved
- Budget approving does NOT advance status until Supplier also approves (parallel stays open)
- `purchasing` opens only when parallel complete AND purchasing email assigned
- Unassigned roles auto-skipped (`N/A`)

### `_computePRStage` (frontend mirror — must stay in sync)

In `purchase_request.html` — mirrors backend, returns `{ stage, budgetEmail, supplierEmail, contractEmail, purchasingEmail }`. Used by `_isMyPRTask` and drawer action gating.

### Status labels (col O)

| Stage | Status text |
|---|---|
| After submit | `Đang duyệt ngân sách & NCC (2/5)` |
| Contract active | `Thẩm định Hợp đồng (4/5)` |
| Purchasing active | `Mua hàng (5/5)` |
| Done | `Hoàn thành` |
| Rejected | `Đã từ chối` |
| Returned | `Trả lại bổ sung` |

### PR number (`generateRequestNumber`)

- Pattern: `{COMPANY_CODE_CLEAN}-PR{YYYYMMDD}{counter}`
- Browser counter: `localStorage` key `vc_{RAW}_PR_{YYYYMMDD}`
- **Server is authoritative:** if number already on sheet, assign next free number, return as `prNo`
- `allocateUniquePRNoOnServer_`: checks if taken, increments counter until free, preserves zero-padding width
- Company code: from `opt.dataset.code`, cleaned to uppercase

### Step validation (`validateAndNext`)

**Step 1 — Công ty:**
- `company_code` required
- `requester_name` required
- `required_date` required (`min` = today)

**Step 2 — Hàng hóa:**
- At least one row with non-empty `.item-desc` in **any** SECTION
- `purpose` required (validated when leaving step 2)
- **Unit price:** blank on named row → blocks (`price-missing-flag`), toast `Chưa nhập đơn giá…`
- **Unit price = 0:** allowed, warns (`price-zero-flag`), does NOT block
- **Negative price:** blocks
- **Qty:** typed number + spinner arrows on `.item-qty` only
- **MOQ (hang-hoa only):** if `tr.dataset.moq` set, `qty >= moq`, else toast + `tr.moq-error`

**4 Sections:**
- `hang-hoa` → Hàng Hóa (has catalog autocomplete, MOQ enforcement)
- `thiet-bi` → Thiết Bị (TSCĐ/CCDC) (no MOQ)
- `dich-vu` → Dịch Vụ (no MOQ)
- `sua-chua` → Sửa Chữa (TSCĐ) (no MOQ)
- Each seeded with default row counts, expandable via chevron

**Step 3 — Phê duyệt:**
- `budget_approver` email **required** (FE + BE)
- `supplier_approver` **required** (FE + BE) — marked with `*`
- `contract_approver` required on **full** branch
- `purchasing_approver` optional
- Step 5 "Phê duyệt cuối" card **removed**, replaced with info callout

**Step 4 — Xác nhận:**
- `buildSummary()` → `submitForm()`

### Submit payload (`purchaseRequest` action)

Encoding: `data=<JSON>` field (not flat URL-encoded):
```js
const sendParams = new URLSearchParams();
sendParams.append('data', JSON.stringify(payload));
```

JSON payload fields:
```
action, prNo, companyCode, companyName, department, requesterName, requesterEmail,
requiredDate, priority, currency, items (JSON string), grandTotal, purpose,
vendorName, vendorType, vendorTaxId, vendorAddress,
vendorAccountName, vendorAccountNo, vendorBankName, vendorTransferNote,
budgetCode, budgetApprover (req), budgetApproverNote,
supplierApprover (req), supplierApproverNote,
contractApprover (opt), purchasingApprover (opt),
submittedAt, requesterSignature (base64),
attachments (JSON string of [{fileName, fileData, mimeType}])
```

### Items line object structure

```js
{ section, loai, desc, qty, unit, price, total, note }
```
**Key field is `desc`** (from `.item-desc` input) — NOT `name` or `itemName`.

Rendering: `item.desc || item.name || item.itemName || '—'`

### Metadata JSON (col Q) initialized at submit

```json
{
  "companyCode": "...",
  "companyKey": "...",
  "requesterEmail": "...",
  "budgetApproverNote": "...",
  "supplierApproverNote": "...",
  "submittedAt": "...",
  "requesterSignature": "base64...",
  "attachments": [{ "fileName": "...", "fileUrl": "..." }],
  "purchaseType": "goods|services",
  "p2pBranch": "full|simplified",
  "budgetStatus": "Pending|N/A",
  "supplierStatus": "Pending|N/A",
  "contractStatus": "N/A",
  "purchasingStatus": "Pending|N/A",
  "vendorDetails": { vendorType, vendorTaxId, vendorAddress, vendorAccountName, vendorAccountNo, vendorBankName, vendorTransferNote }
}
```

Roles not assigned at submit get `N/A` (auto-skipped by `computePRApprovalState_`).

### Gate checks (BE + FE)

**Approve (`handleApprovePurchaseRequest`):**
- `approverRole` must be in `['budget', 'supplier', 'contract', 'purchasing']`
- Status must not be `Đã từ chối` / `Rejected` / `Hoàn thành` / `Approved` / `Trả lại bổ sung`
- Email must match assigned column for role (col 10=budget, 11=supplier, 17=contract, 18=purchasing)
- `roleStage` (budget/supplier → 'parallel', contract → 'contract', purchasing → 'purchasing') must === `activeStage`
- If already Approved: `"Bạn đã duyệt đề nghị này rồi."`
- Out-of-order: `"Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: {stage}."`
- On approve: `metadata[role + 'Status'] = 'Approved'`, `[role + 'ApprovedAt']`, `[role + 'Note']`
- If `approverSignature`: store `metadata[role + 'Signature']`
- If `signatureVerification`: store parsed as `metadata[role + 'SignatureVerification']`

**Reject (`handleRejectPurchaseRequest`):**
- Map email → role via `emailRoleMap`
- Reject role stage must === activeStage
- Status must not be `Đã từ chối` / `Hoàn thành` / `Trả lại bổ sung`
- Sets `metadata.rejectedAt`, `metadata.rejectedBy`, `metadata.rejectionNote`
- Status → `Đã từ chối`
- No further actions allowed

**Send-back (`handleSendBackPurchaseRequest`):**
- `targetStep`: 1 (back to submitter) / 2 (back to budget+supplier) / 3 (back to contract)
- `maxTarget` per role: budget=1, supplier=1, contract=2, purchasing=3
- Step 1 → status `Trả lại bổ sung` (role statuses NOT reset — preserved for display, reset on resubmit)
- Step 2 → status `Đang duyệt ngân sách & NCC (2/5)`, reset roles: budget, supplier, contract, purchasing
- Step 3 → status `Thẩm định Hợp đồng (4/5)`, reset roles: contract, purchasing

### Email notifications

**On submit (`sendPurchaseRequestEmails_`):**
- Subject: `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - {prNo}`
- **Budget + Supplier approvers only** receive approval-request email
- Requester gets confirmation email
- Contract and Purchasing **NOT emailed at submit**
- Attachment links included in email HTML
- All email failures non-fatal (try/catch, log)

**On stage transition (`sendPurchaseRequestStageEmail_`):**
- Contract approver emailed when parallel completes (both budget + supplier approved)
- Purchasing approver emailed when contract completes (or parallel completes if contract not assigned)
- Subject: `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu {stageLabel} - {prNo}`

**On completion (`sendPurchaseRequestCompletionEmail_`):**
- Requester notified when PR reaches `Hoàn thành`
- Subject: `[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - {prNo}`

**All emails stay Vietnamese.** Go to recipient, not submitter. Sender name: `TLC Group Workflow`.

### Currency selector (global, header-only)

- `let _currency = 'VND'` (default)
- `<select id="currency-select">` in Hàng Hóa section `<th class="col-price">` — VND/USD/EUR
- Other section price headers use `class="col-price price-th"` — synced by `setCurrency()`
- `setCurrency(code)`: updates `_currency`, sets `.price-th` text, updates `step` on `.item-price` (1000 for VND, 0.01 for others), calls `recalcAllSections()`
- `formatMoney(n)`: uses `_currency` for code + decimal places (0 for VND, 2 for USD/EUR)
- **No per-row currency selector** — header only
- Summary total: `formatMoney(_grandTotal) + ' (' + _currency + ')'`
- Select sized: `width:3.4em; appearance:none; -webkit-appearance:none;` — do not widen

### Caching (`getMasterData`)

- Keys: `tlc_master_data`, `tlc_master_data_timestamp`
- TTL: **30 minutes** stale-while-revalidate
- Cache renders immediately, then background refresh
- **Shared** across `voucher.html`, `purchase_request.html`, all workflows — one cache
- Clearing `tlc_master_data` on any page refreshes for all

### Companies dropdown

- From `tlcg_companies_embed.js` (`TLCG_COMPANIES_DATA.companies_data`) — **NOT `getMasterData`**
- Missing embed → `"Không có dữ liệu"`
- `company_code` option value mixes display (`Tên (Mã định danh)`)
- `opt.dataset.code` drives the alphanumeric prefix, cleaned to uppercase
- Submit sends `companyCode` + `companyName`

### Master employees

- `seedRequesters` / `seedApprovers` use `getMasterData` → `employees` (same cache as voucher.html)
- Filter: `employee_status` or `Status` === `active`
- Approver selects: `option.value = employee_email`, display `full_name`
- Sidebar session: `tlc_current_user` (`name`, `email`, …)
- Requester pre-selected if `name` matches an option

### PR list (`handleGetPurchaseRequestHistory`)

- Calls `archiveOldPurchaseRequests_` first (once/day max)
- Returns slim `requests[]` — **no line items, no metadata JSON**
- Filters by `requesterName` if provided
- Sorted by `submittedAt` descending
- `getPurchaseRequest` loads full detail when drawer opens
- `searchPurchaseRequests` looks up archive

### Archive

- Finished PRs with no activity for **90 days** → `Purchase_Request_Archive`
- At most **once a day**
- Open approvals stay on `Purchase_Request_History`

### Stat pills / filter buckets

| Bucket | Statuses |
|---|---|
| `''` (All) | All |
| `'dang-xu-ly'` | Any in-progress (not Hoàn thành / Đã từ chối) |
| `'hoan-thanh'` | Hoàn thành / Approved |
| `'tu-choi'` | Đã từ chối / Rejected |

`_prStatusBucket(status)` maps any stored status string → correct bucket.

### Submit UX rules

- `resetForm()` must set `#submit-btn disabled = false`, restore label `Gửi đề nghị`, set `isSubmitting = false`
- Success path must also set `btn.disabled = false` before restoring label
- After successful send: keep form editable, call `generateRequestNumber()` for next request
- Do NOT hide `.form-step` behind `#success-screen`
- Network `catch` shows error toast

### Backend routing

| Action | Backend |
|---|---|
| `getMasterData` | `TLCG_CORE_BACKEND` (employees, goods, suppliers) |
| `purchaseRequest` | `TLCG_P2P_BACKEND` |
| `getPurchaseRequestHistory` | `TLCG_P2P_BACKEND` |
| `getPurchaseRequest` | `TLCG_P2P_BACKEND` |
| `searchPurchaseRequests` | `TLCG_P2P_BACKEND` |
| `approvePurchaseRequest` | `TLCG_P2P_BACKEND` |
| `rejectPurchaseRequest` | `TLCG_P2P_BACKEND` |
| `sendBackPurchaseRequest` | `TLCG_P2P_BACKEND` |

**`BACKEND_URL = '/api/voucher'`** — never hardcode direct GAS URL.

### Verification checklist

| Scenario | Expected |
|---|---|
| Submit without supplier | Blocked (FE toast + BE 400) |
| Named row, blank unit price | Blocked, red field, toast `Chưa nhập đơn giá` |
| Named row, unit price 0 | Allowed, orange field, gift warning |
| Budget + Supplier only | Parallel → Hoàn thành |
| Purchasing assigned | Parallel → purchasing email → purchasing approve → Hoàn thành |
| Full branch | Contract reviewer required on form; contract approval outside PR |
| Out-of-order approve | Rejected: `Chưa đến lượt duyệt của bạn` |
| Reject at any stage | `Đã từ chối`, no further actions |
| My Task filter | Only shows PRs where user's role is in active stage |
| Emails on submit | Budget + Supplier only (not Contract/Purchasing) |

---

## 7. Purchase Request Catalog (Goods-KTT)

**Source:** `.cursor/rules/purchase-request-catalog.mdc`

### Data source
- Goods from **`Goods-KTT`** Google Sheet via `getMasterData` → `data.goods`
- Shared `tlc_master_data` localStorage cache patched with goods after first fetch
- **CORE backend does NOT return goods** — never overwrite cached goods with empty array from CORE refresh

### Filter rules (`seedGoods`)
- `Status` lowercase === `active`
- `Items` trimmed non-empty → `name`
- `Min. Order` parses numeric; **`moq > 0` required** or row excluded
- Fields: `Items`, `Category`, `Min. Order`, `Unit`, `Unit Price`, `Specificaton` (sheet typo), `CUKCUK/QBO Code`, `Status`
- `Unit Price` → `price`; `selectGoodsItem` auto-fills `.item-price` when `g.price > 0`

### State variables
```js
let _catalogActiveCat = 'all';
let _catalogViewMode  = localStorage.getItem('catalog_view') || 'grid'; // 'grid' | 'list'
```

### Three render modes
1. **Grid**: 2-column cards. Un-added → `[+ Thêm]`. Added → `[−] qty [+] unit` stepper
2. **List**: 1-column rows, name+spec left, stepper right
3. **Summary** (`cat === '__selected__'`): always 1-column, editable qty stepper, unit

### Card interaction
- First "Thêm" → `addFromCatalog(name)` → adds row with MOQ qty, card turns green, stepper appears
- `[−]` → `setCatalogQty(name, -1)` → decrements by 1 MOQ step; qty ≤ 0 → `removeFromCatalog(name)` → card resets
- `[+]` → `setCatalogQty(name, 1)` → increments by 1 MOQ step
- Direct qty → `setCatalogQtyDirect(name, val)` → validates, syncs table row

### MOQ rules
- Default step: `g.moq > 0 ? g.moq : 1`
- `[+]` and `[−]` always move by exactly 1 step
- Direct input accepts any positive number (no MOQ rounding on edit)

### "Đã chọn" tab
- Appears automatically (green pill) when ≥ 1 item in basket
- Shows count: `✓ Đã chọn (N)`
- Clicking renders summary view (steppers + remove, no toggle)

### Cache safety
- `_fetchAndCacheMaster` preserves existing `goods` in cache when CORE returns no goods
- `_applyMasterData` skips `seedGoods([])` if `_goodsCatalog` already has items

### Table row sync (`selectGoodsItem`)
- Always sets **name**, **unit**, **MOQ metadata** (`dataset.moq`, `moqUnit`, `moqSpec`) on row
- Unit set with **case-insensitive matching** against existing `<option>` values; if no match, append as new option
- `g.unit` from Goods-KTT is source of truth — overrides default "Cái"
- qty set **before** `selectGoodsItem` in `addFromCatalog` so `recalcRow` uses correct MOQ qty
- `_setRowQty` re-applies unit fix so stepper adjustments stay consistent

### Row reuse rule (`addFromCatalog`)
- Before appending new row, scan `#tbody-hang-hoa tr` for first row where `.item-desc` is empty
- Fill that empty row instead of creating new
- Only call `addSectionRow('hang-hoa')` when all existing rows already filled

### Autocomplete
- Only `hang-hoa` section gets autocomplete
- `filterGoodsDropdown` shows up to 10 matches, fuzzy by substring on `name`
- Manual free text clears `dataset.moq` when description no longer exactly matches a catalog name
- Other sections (`thiet-bi`, `dich-vu`, `sua-chua`): plain description inputs, no MOQ enforcement

### Unit mapping examples

| Sheet `Unit` | Dropdown result |
|---|---|
| `Hộp` | new option → "Hộp" |
| `Cái` | existing → "Cái" |
| `kg` | case-insensitive → "Kg" |
| `Thùng` | existing → "Thùng" |

---

## 8. P2P Audit Trail

**Source:** `.cursor/rules/p2p-audit-trail.mdc` (alwaysApply: true)

### Requirement
Every workflow action that changes document status **MUST** call `_appendAuditLog_()` immediately after writing the new status.

### Pattern

```js
// 1. Write new status to sheet
sheet.getRange(rowIndex, STATUS_COL).setValue(newStatus);
sheet.getRange(rowIndex, METADATA_COL).setValue(JSON.stringify(metadata));
SpreadsheetApp.flush();

// 2. Append audit log (NEVER skip)
_appendAuditLog_({
  sheetName:  '<FLOW>_Audit_Log',   // 'PR_Audit_Log', 'AM_Audit_Log', 'PMT_Audit_Log'
  docNo:      docNo,
  flow:       '<FLOW>',             // 'PR' | 'AM' | 'PMT'
  company:    companyName,
  action:     '<ACTION>',           // 'Submit' | 'Approve' | 'Reject' | 'Return' | 'Resubmit'
  role:       '<ROLE>',             // 'requester' | 'budget' | 'supplier' | 'contract' | 'purchasing' | 'deptHead'
  actorEmail: actorEmail,
  actorName:  actorName || '',
  prevStatus: currentStatus,
  newStatus:  newStatus,
  note:       note || '',
  extra:      { /* optional */ }
});
```

### Audit log schema (12 columns)

| Col | Header | Description |
|---|---|---|
| A | Document No | PR No / AM No / PMT No |
| B | Flow | PR, AM, PMT |
| C | Company | Company name |
| D | Action | Submit / Approve / Reject / Return / Resubmit |
| E | Role | Actor's role in this step |
| F | Actor Email | Email of person who triggered |
| G | Actor Name | Display name (may be empty) |
| H | Prev Status | Status before action |
| I | New Status | Status after action |
| J | Timestamp | ISO 8601 UTC (auto-set) |
| K | Note | Approval note / rejection reason |
| L | Extra (JSON) | Serialised extra data (sig URL, step, etc.) |

### Rules

1. **One audit log table per flow** (`PR_Audit_Log`, `AM_Audit_Log`, `PMT_Audit_Log`)
2. **Call for every action:** submit, every approve step, reject, return, resubmit
3. **Never conditional** — helper swallows own errors, never breaks main flow
4. **Never delete/overwrite** — append-only. Corrections = new "Correction" row.
5. **Postgres migration:** enforce append-only at DB level — no UPDATE/DELETE on audit tables; use triggers or RLS

### Existing implementations

| Flow | Audit Log | Handlers wired |
|---|---|---|
| PR | `PR_Audit_Log` | submit, approve (4 roles), reject, return, resubmit |
| AM | `AM_Audit_Log` | create, approve (deptHead), reject (deptHead) |
| PMT | (not yet) | Follow same pattern when implementing |

---

## 9. Notification Bell

**Source:** `.cursor/rules/notification-bell.mdc`

### Overview
- Red bell badge in top nav (desktop + mobile) on `voucher.html` and `purchase_request.html`
- Shows count of items requiring current user's action
- Click → dropdown panel listing pending items; click row → open detail

### Voucher pending items (`_pendingVoucherItems`)

Role from `getCallerRole()` (reads `tlc_current_user` from localStorage):
- `accountant` → vouchers with `progressNum === 0`
- `legalRep` → vouchers with `progressNum === 1`
- `treasurer` → vouchers with `progressNum === 2`
- `admin` → vouchers at `progressNum === 0` that are **not rejected**
- `submitter` → not counted

### PR pending items (`_pendingPRItems`)

Mirrors `renderPRDrawer` gate logic:
- `parallel` stage: email matches `budgetApproverEmail` AND `budgetStatus !== 'Approved'`
- `parallel` stage: email matches `supplierApproverEmail` AND `supplierStatus !== 'Approved'`
- `contract` stage: email matches `contractApproverEmail`
- `purchasing` stage: email matches `purchasingApproverEmail`
- Any stage: `status === 'trả lại bổ sung'` AND `requestorEmail === myEmail` (submitter resubmit)

### Dropdown behavior
- **Vouchers:** voucher number (blue) + type + company; click → `openVoucherDetail(voucherNumber)`
- **PRs:** PR number (blue) + company; "Trả lại" amber tag for returned; click → `openPRDrawer(prNo)`
- Capped at **15 rows**; shows `+N phiếu khác` if more
- Empty: `Không có việc cần làm`
- Click outside `#notif-bell-wrapper` closes dropdown

### Rules
- **No separate backend call** for count — derived from already-loaded data (`allLoadedVouchers` / `_allPRs`)
- Count logic must stay in sync with `renderPRDrawer` gate checks
- If new approval stage added: update both `_pending*Items` AND `render*` together

---

## 10. Backend Action → Handler Map

### GAS file → domain mapping

| GAS file | Domain | Env var |
|---|---|---|
| `TLCG_CORE_BACKEND.gs` | Shared/Auth | `TLCG_CORE_BACKEND_URL` (fallback: `TLCGROUP_BACKEND_URL`) |
| `TLCG_P2P_BACKEND.gs` | P2P — Mua hàng | `TLCG_P2P_BACKEND_URL` (fallback: `PAYMENT_REQUEST_BACKEND_URL`) |
| `TLCG_CASH_BACKEND.gs` | Cash & Admin | `TLCG_CASH_BACKEND_URL` (fallback: `VOUCHER_BACKEND_URL`) |
| `TLCG_CASH_BOOK.gs` | Cash book (2nd file in Cash project) | Same as Cash |
| `TLCG_O2C_BACKEND.gs` | O2C (future) | `TLCG_O2C_BACKEND_URL` |

### Key handlers by file

**`TLCG_CASH_BACKEND.gs` (5,601 lines):**
- `handleSendApprovalEmail` — voucher submit
- `handleApproveVoucher` — single approve (→ `_approveVoucherCoreWithSheet_`)
- `handleBulkApprove` — batch approve (→ same core)
- `handleRejectVoucher` — reject
- `handleAcknowledgeReceipt` — requester acknowledges
- `handleGetVoucherSummary` — list (last 5000 rows, no MetaJSON)
- `handleGetVoucherSummaryFromCurrent_` — summary from current sheet
- `cleanupDuplicateApprovalRows` — one-time cleanup
- `uploadFilesToDrive_` — Drive upload

**`TLCG_P2P_BACKEND.gs` (5,346 lines):**
- `handlePurchaseRequest` — submit PR
- `handleApprovePurchaseRequest` — approve (4 roles)
- `handleRejectPurchaseRequest` — reject
- `handleSendBackPurchaseRequest` — return to earlier step
- `handleGetPurchaseRequestHistory` — list (slim cards)
- `handleGetPurchaseRequest` — single PR detail
- `computePRApprovalState_` — stage computation
- `computeP2PBranch_` — branch determination
- `allocateUniquePRNoOnServer_` — PR number allocation
- `_appendAuditLog_` — audit trail
- `sendPurchaseRequestEmails_` — submit emails
- `sendPurchaseRequestStageEmail_` — stage transition emails
- `sendPurchaseRequestCompletionEmail_` — completion email
- `archiveOldPurchaseRequests_` — 90-day archive

**`TLCG_CORE_BACKEND.gs` (2,197 lines):**
- `handleGetMasterData` — employees, goods, suppliers
- `handleGetEmployees` — employee directory
- Login / auth / password management

**`TLCG_CASH_BOOK.gs` (736 lines):**
- `getCashBook`, `getCashCount`, `getCashBookSummary`
- `getRecentCashCounts`, `saveCashCount`, `signCashCount`
- 3 roles: `nguoiChiuTrachNhiem`, `keToanTruong`, `thuQuy`

### API proxy (`api/voucher.js`, 743 lines)
- Rate limiting: 300 req/min per user (email → IP fallback)
- Sweeps expired entries (MAX_TRACKED_CLIENTS = 10000)
- Routes `action` param to correct GAS backend URL
- CORS handling
- `BACKEND_URL = '/api/voucher'` — never direct GAS URL in frontend

### File upload endpoints

| Endpoint | Purpose | Max |
|---|---|---|
| `POST /api/voucher-file` | Large voucher attachments (GAS-mediated) | 10 MB |
| `POST /api/drive-upload` | Service Account Drive (DO NOT USE for personal Drive) | — |
| `GET /api/config` | Whitelisted env IDs (folder IDs, spreadsheet ID) | — |
