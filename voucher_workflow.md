# Phiếu Thu/Chi — Complete System Workflow

## Overview

A financial voucher (Receipt/Payment) management system for TLCGroup. Built as a single-page app (`voucher.html`) backed by Google Apps Script (`TLCG_CASH_BACKEND.gs`). Employees create vouchers through a 5-step form; vouchers go through a sequential 3-tier approval chain via email.

---

## Architecture

```
voucher.html (SPA frontend)
        ↕  HTTPS POST/GET  (FormData, JSON body)
TLCG_CASH_BACKEND.gs  (Google Apps Script Web App)
        ↕
Google Sheets (ID: 1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g)
  ├── Voucher_History   ← all voucher records + approval history (18 cols)
  ├── Master Employee   ← employee directory + auth (18 cols, A–J used)
  └── Master Company    ← company info + 3 approvers per company (79 cols, A–N used)
        ↕
Google Drive (Folder: 1RBBUUAQIrYTWeBONIgkMtELL0hxZhtqG)
  └── Attachment uploads per voucher number sub-folder
        ↕
Gmail (GmailApp)
  └── Approval/notification emails
```

---

## Google Sheets Structure

### `Master Employee` Sheet

Backend reads by **index (0–9)**. Columns K–R are leave management — not used in voucher workflow.

| Col | Index | Actual Header | Backend field | Used in voucher workflow |
|-----|-------|--------------|---------------|--------------------------|
| A | 0 | `full_name` | `name` | Employee dropdown; stored in Voucher_History col E |
| B | 1 | `position` | `position` | Display only |
| C | 2 | `department_name` | `department` | Auto-fills `#department` field in Step 1 |
| D | 3 | `company_name` | `company` | Display only |
| E | 4 | `employee_email` | `email` | Maps name → email; stored in Voucher_History col F |
| F | 5 | `employee_phone` | `phone` | Not used in voucher flow |
| G | 6 | `employee_status` | `status` | **Filter**: only `Active` rows loaded |
| H | 7 | `employee_id` | `employeeId` | Not used in voucher flow |
| I | 8 | `employee_role` | `role` | Approver permission checks |
| J | 9 | `isAdmin` | `isAdmin` | Admin UI features |
| K–R | 10–17 | `login_password` … `Tồn phép hiện tại` | — | Login auth + leave module only — **ignored** |

**Loaded by**: `GET ?action=getEmployees` → `handleGetEmployees()` → returns rows where col G = `Active`

---

### `Master Company` Sheet

Backend reads **columns A–N only (indices 0–13)**. Columns O–BZ (79 total) are other business data — completely ignored by the voucher workflow.

| Col | Index | Actual Header | Used for |
|-----|-------|--------------|----------|
| A | 0 | `Company_Name` | **Primary lookup key** — must match exactly what frontend sends |
| B | 1 | `Company_Code` | Voucher number prefix (e.g. `EV` → `EV-PT20260322000001`) |
| C | 2 | `Company_Key_Or_Taxid` | **Secondary lookup key** — distinguishes companies with same name |
| D | 3 | `Legal_Representative_Name` | `legalRep.name` — 2nd approver in chain |
| E | 4 | `Legal_Representative_Email` | `legalRep.email` — 2nd approval email |
| F | 5 | `Legal_Representative_Signature` | `legalRep.signature` — signature URL for printed voucher |
| G | 6 | `Email_Director` | Read but not placed in approver object |
| H | 7 | `Chief_Accountant_Name` | `accountant.name` — **1st approver** |
| I | 8 | `Chief_Accountant_Email` | `accountant.email` — **first approval email sent on submission** |
| J | 9 | `Chief_Accountant_Signature` | `accountant.signature` — signature URL |
| K | 10 | `Effective_Date` | Not used |
| L | 11 | `Treasurer_Name` | `treasurer.name` — 3rd approver |
| M | 12 | `Treasurer_Email` | `treasurer.email` — 3rd approval email |
| N | 13 | `Treasurer_Signature` | `treasurer.signature` — signature URL |
| O–BZ | 14–78 | `Company_Full_Name` … `MST_NTNN_2` | **Not read** — bank, BOD, accounting, tax data |

**Lookup logic**: `handleGetCompanyApprovers()` matches `row[0] === companyName AND row[2] === companyKey`

**Also embedded** as base64 blob in `voucher.html` (columns A–N only) for offline/fast initial load — company dropdown populates from this before API calls.

---

### `Voucher_History` Sheet

Each voucher generates **multiple rows**: 1 Submit row + 1 row per approval/rejection action.

| Col | Index | Actual Header | What is stored | Written by |
|-----|-------|--------------|----------------|-----------|
| A | 0 | `voucher_number` | e.g. `EV-PT20260322000001` | Submit |
| B | 1 | `voucher_type` | `Phiếu Thu` / `Phiếu Chi` | Submit |
| C | 2 | `company_name` | Company display name | Submit |
| D | 3 | `company_key` | Unique company key (e.g. `E.V`) | Submit |
| E | 4 | `employee_name` | The person the voucher is FOR | Submit |
| F | 5 | `submitted_email` | That employee's email | Submit |
| G | 6 | `submitted_by` | Who physically submitted (same as E unless proxy) | Submit |
| H | 7 | `submitted_at` | `new Date()` at moment of `appendRow` | Every row |
| I | 8 | `amount` | Total amount from expense table | Submit |
| J | 9 | `status` | `Pending` → `Đang duyệt (X/3)` → `Approved` / `Rejected` | Every row |
| K | 10 | `due_date` | Expected payment date (optional, from form) | Submit |
| L | 11 | `action` | `Submit` / `Approved by [name]` / `Fully Approved` / `Rejected by [name]` | Every row |
| M | 12 | `attachments` | Google Drive file URLs (newline-separated) | Submit |
| N | 13 | `description` | Voucher purpose/reason (`voucher.reason` from form) | Submit |
| O | 14 | `note` | Human comment for this action row | Every row |
| P | 15 | `approver_email` | Email of next/current approver | Every row |
| Q | 16 | `approved_at` | ISO timestamp of this approval step (empty on Submit row) | Approval rows |
| R | 17 | `metadata_json` | Full approval state JSON — see structure below | Every row |

---

## MetaJSON Structure (Voucher_History col R)

Stored as raw JSON string in column R. Written on every `appendRow`. Read by `getVoucherFromHistory()` via `row[17]`.

```json
{
  "requesterSignature": "base64...",
  "reason": "Mua văn phòng phẩm",
  "voucherDate": "2026-03-22",
  "department": "Kế toán",
  "payeeName": "Nguyễn Văn A",
  "amountInWords": "Một triệu đồng",
  "expenseItems": [
    { "content": "Mua giấy A4", "amount": 500000 }
  ],
  "submittedAt": "2026-03-22T08:00:00.000Z",
  "companyApprovers": {
    "approvers": {
      "accountant": { "name": "...", "email": "...", "status": "approved", "approvedAt": "ISO8601", "order": 1 },
      "legalRep":   { "name": "...", "email": "...", "status": "pending",  "approvedAt": null,      "order": 2 },
      "treasurer":  { "name": "...", "email": "...", "status": "pending",  "approvedAt": null,      "order": 3 }
    },
    "overallStatus": "Partially Approved",
    "currentApprover": "legalRep",
    "approvalSequence": ["accountant", "legalRep", "treasurer"],
    "displayStatus": "Đang duyệt (1/3)",
    "fullyApprovedAt": null,
    "rejectedAt": null,
    "rejectedBy": null
  },
  "approvedBy": "accountant@company.com"
}
```

`approvedBy` is added on each approval row so `getVoucherFromHistory()` can scan all rows and reconstruct the current approval state.

---

## Frontend Init Sequence (DOMContentLoaded)

```
1. Auth check: localStorage['tlc_current_user'] → { name, email }
   └── Missing/invalid → redirect to index.html

2. initDriveAPI()              ← Initialize Google Drive OAuth

3. loadEmployeesFromBackend()
   └── GET ?action=getEmployees
   └── Master Employee A–J → populates #employee + #submitted-by dropdowns
   └── Builds: employeeEmailMap { fullName → email }

4. initializeForm()
   └── Reads embedded base64 blob (Master Company cols A–N, 10 companies)
   └── Populates #company dropdown
       Each <option>: value="Name (Key)", dataset.name=A, dataset.code=B, dataset.key=C

5. generateVoucherNumber()
   └── Reads: companyOption.dataset.code (e.g. "EV")
   └── Key: localStorage['vc_{Code}_{PT|PC}_{YYYYMMDD}'] → sequential counter
   └── Result: e.g. EV-PT20260322000001

6. renderExpenseTable()        ← Empty table with 1 blank row
7. loadFromLocalStorage()      ← If draft exists → prompt user to restore
8. loadSavedSignature()        ← Load signature from localStorage
9. loadRecentVouchers()        ← POST action=getVoucherSummary → populate recent panel
10. setInterval(loadRecentVouchers, 60000)
11. Check URL ?viewStatus=voucherNumber → open status modal if present
```

---

## 5-Step Form Workflow

### Step 1 — Thông tin chung (General Info)

| Element ID | Type | Required | Data source | On change |
|-----------|------|----------|-------------|-----------|
| `#company` | SELECT | Yes | Embedded base64 blob (Master Company col A+B+C) | `updateCompanyDetails()` → fetch approvers, regenerate voucher number |
| `#voucher-type` | SELECT | Yes | Hardcoded: Phiếu Thu / Phiếu Chi | `updateVoucherTitle()` → regenerate voucher number |
| `#voucher-number` | TEXT readonly | Auto | `generateVoucherNumber()` | — |
| `#voucher-date` | DATE | Yes | Default: today | — |
| `#employee` | SELECT | Yes | Master Employee col A (full_name), filtered Active | `updateEmployeeDepartment()` |
| `#department` | TEXT readonly | Auto | Master Employee col C (department_name) | — |
| `#proxy-checkbox` | CHECKBOX | No | — | `toggleProxySubmit()` → shows/hides submitted-by row |
| `#submitted-by` | SELECT | Conditional | Same employee list | — |
| `#due-date` | DATE | No | — | — |

**On company change (`updateCompanyDetails`)**:
1. Reads `companyOption.dataset.name` and `.dataset.key`
2. Shows address from embedded data
3. `POST ?action=getCompanyApprovers { companyName, companyKey }`
   - Backend: Master Company — finds row where `row[0]=name AND row[2]=key`
   - Returns: `{ accountant:{name,email,sig}, legalRep:{...}, treasurer:{...} }`
   - Stored in: `data.selectedCompanyApprovers`
4. `updateApproversDisplay()` → updates Step 4 panel
5. `generateVoucherNumber()` → updates `#voucher-number`

---

### Step 2 — Thông tin đối tượng (Payee Info)

| Element ID | Type | Required | Notes |
|-----------|------|----------|-------|
| `#payee-dropdown` | SELECT | No | Pre-fills payee-name from employee list |
| `#payee-name` | TEXT | Yes | Min 2 chars — person receiving/paying money |
| `#reason` | TEXTAREA | Yes | Min 10 chars — voucher purpose → stored as `description` in Voucher_History col N |
| `#amount` | TEXT readonly | Auto | Calculated from expense table |
| `#signature-upload` | FILE | Yes | Requestor's signature → compressed → base64 |

---

### Step 3 — Chi tiết (Expense Items)

Dynamic table of line items. Each row: content (required) + amount (>0) + optional file attachments.

**File upload path**:
- If Drive configured (`isDriveConfigured()`): `uploadToDrive(file, voucherNumber)` → OAuth2 → creates folder `{DRIVE_FOLDER_ID}/{voucherNumber}/` → returns shareable URL
- If not: base64 stored for backend upload

---

### Step 4 — Phê duyệt (Approvers Display)

Read-only. Shows 3 approvers loaded from Master Company in Step 1.

| Approval order | Role | Master Company column |
|---------------|------|-----------------------|
| 1st | Kế toán trưởng | H (Chief_Accountant_Name) + I (email) |
| 2nd | Đại diện pháp luật | D (Legal_Representative_Name) + E (email) |
| 3rd | Thủ quỹ | L (Treasurer_Name) + M (email) |

---

### Step 5 — Xem lại & Gửi (Review & Submit)

Read-only summary. Buttons: Lưu bản nháp / Gửi phê duyệt / Xuất PDF / Xuất Excel.

---

## Submission Flow

```
sendForApproval() triggered
│
├─ Read from form:
│   companyName    = companyOption.dataset.name          → Voucher_History col C
│   companyKey     = companyOption.dataset.key           → Voucher_History col D
│   requestorName  = #employee.value                     → Voucher_History col E
│   requestorEmail = employeeEmailMap[requestorName]     → Voucher_History col F
│   submittedBy    = #submitted-by.value OR requestorName → Voucher_History col G
│   amount         = #amount.value                       → Voucher_History col I
│   dueDate        = #due-date.value                     → Voucher_History col K
│   reason         = #reason.value                       → Voucher_History col N (description)
│   department     = #department.value                   → MetaJSON
│   payeeName      = #payee-name.value                   → MetaJSON
│
├─ Upload files → Drive URLs                             → Voucher_History col M
│
├─ POST action=sendApprovalEmail
│   payload.voucher = { voucherNumber, voucherType, company, companyKey,
│                       employee, submittedBy, amount, requestorEmail,
│                       dueDate, reason, department, payeeName,
│                       amountInWords, expenseItems[], files[],
│                       companyApprovers, requesterSignature }
│
└─ handleSendEmail() — TLCG_CASH_BACKEND.gs
    │
    ├─ Duplicate check: scan Voucher_History col A + col L for existing Submit row
    │
    ├─ initializeApproversMeta(companyApprovers)
    │   └─ Builds MetaJSON with all 3 approvers status=pending
    │   └─ currentApprover = 'accountant'
    │
    ├─ appendHistory_() → writes ROW to Voucher_History (all 18 columns):
    │   col A: voucherNumber
    │   col B: voucherType
    │   col C: company (name)
    │   col D: companyKey
    │   col E: employee (requestorName)
    │   col F: requestorEmail
    │   col G: submittedBy
    │   col H: new Date()
    │   col I: amount
    │   col J: 'Pending'
    │   col K: dueDate
    │   col L: 'Submit'
    │   col M: fileLinks (Drive URLs)
    │   col N: voucher.reason          ← description/purpose
    │   col O: 'Gửi phê duyệt'        ← action note
    │   col P: accountant.email        ← 1st approver
    │   col Q: ''                      ← no approval yet
    │   col R: JSON.stringify(submitMetaData)
    │
    └─ GmailApp.sendEmail() → to: Master Company col I (Chief_Accountant_Email)
        Subject: "[PHIẾU CHI] Yêu cầu phê duyệt - {voucherNumber}"
        Body: voucher details + [✅ Phê duyệt] / [❌ Từ chối] links
```

---

## Sequential Approval Workflow

### Approval Chain

```
[Submit] → Kế toán trưởng (1/3) → Đại diện pháp luật (2/3) → Thủ quỹ (3/3) → [Done]
  col J: Pending    Đang duyệt (1/3)       Đang duyệt (2/3)      Approved
```

### On Each Approval (`handleApproveVoucher`)

```
POST action=approveVoucher { voucherNumber, approverEmail, approverRole, approverSignature }
│
├─ getVoucherFromHistory(voucherNumber)
│   └─ Voucher_History: find first row for this voucher
│   └─ row[17] (MetaJSON) → parse → get companyApprovers structure
│   └─ Scan ALL rows for voucher → reconstruct current approval state via approvedBy field
│
├─ Validate: approverEmail matches companyApprovers.approvers[role].email
├─ Validate: requestorEmail ≠ approverEmail (no self-approval)
├─ Validate: status not already Approved/Rejected
│
├─ Update meta: approvers[role].status='approved', approvedAt=now, meta.approvedBy=approverEmail
│
├─ [If approvalCount < 3] Partial:
│   ├─ appendHistory_() → new row:
│   │   col J: 'Đang duyệt (X/3)'
│   │   col L: 'Approved by [name]'
│   │   col O: 'Đã duyệt bởi [role] (X/3)'
│   │   col P: nextApprover.email
│   │   col Q: new Date().toISOString()
│   │   col R: updated MetaJSON
│   ├─ Email next approver (from Master Company col E or M)
│   └─ Email requester: progress X/3
│
└─ [If approvalCount = 3] Final:
    ├─ appendHistory_() → new row:
    │   col J: 'Approved'
    │   col L: 'Fully Approved'
    │   col Q: new Date().toISOString()
    │   col R: final MetaJSON (overallStatus='Approved')
    └─ Email requester: fully approved
```

### On Rejection (`handleRejectVoucher`)

```
├─ appendHistory_() → new row:
│   col J: 'Rejected'
│   col L: 'Rejected by [name]'
│   col O: 'Từ chối bởi [role]\nLý do: [reason]'
│   col Q: ''
│   col R: MetaJSON (overallStatus='Rejected', currentApprover=null)
└─ Email requester: rejection reason
```

### Email Triggers

| Event | To | Subject prefix |
|-------|----|----------------|
| Voucher submitted | Master Company col I (Chief_Accountant_Email) | `[PHIẾU THU/CHI]` |
| Accountant approves | Master Company col E (Legal_Representative_Email) | `[PHÊ DUYỆT]` |
| Legal Rep approves | Master Company col M (Treasurer_Email) | `[PHÊ DUYỆT]` |
| Each approval | Voucher_History col F (submited_email) | `[ĐANG DUYỆT (X/3)]` |
| All 3 approved | Voucher_History col F | `[ĐÃ DUYỆT HOÀN TOÀN]` |
| Any rejection | Voucher_History col F | `[TỪ CHỐI]` |

### Action Links in Emails

```
Approve: https://workflow.tl-c.us/approve_voucher.html
         ?voucherNumber=...&approverEmail=...&approverRole=...&submittedBy=...

Reject:  https://workflow.tl-c.us/reject_voucher.html
         ?voucherNumber=...&approverEmail=...

Status:  https://workflow.tl-c.us/voucher.html
         ?viewStatus={voucherNumber}
```

---

## Proxy Submission

Any logged-in user can submit a voucher on behalf of another employee. This is standard BPM behaviour — the 3-tier approval chain is the control mechanism.

- **Enable**: check "Nộp thay cho người khác" in Step 1 → `#submitted-by` dropdown appears
- **Result**: `employee_name` (col E) = person the voucher is FOR; `submitted_by` (col G) = person who filled and sent the form
- **Audit**: approval emails show "Người nộp phiếu: [name]" when col G ≠ col E

---

## Voucher Number Format

```
{CompanyCode}-{PT|PC}{YYYYMMdd}{######}
     ↑               ↑           ↑
Master Company     Phiếu Thu   Counter resets
col B (Company_Code)  = PT      daily per company+type
                   Phiếu Chi   Stored in localStorage:
                     = PC      key: vc_{Code}_{PT|PC}_{YYYYMMDD}

Example: EV-PT20260322000001
```

---

## Status Display (Recent Vouchers Panel)

```
loadRecentVouchers() → POST action=getVoucherSummary
│
└─ handleGetVoucherSummary()
    └─ Reads all rows from Voucher_History
    └─ Groups by col A (voucher_number)
    └─ Keeps latest row per voucher by col H (submitted_at)
    └─ Returns: { pending, approved, rejected, total, recent[] }

Click voucher card → openVoucherDetail(voucherNumber)
│
└─ POST action=getVoucherHistory { voucherNumber }
    └─ handleGetVoucherHistory()
        └─ Returns ALL rows for this voucher (full audit trail)
        └─ Each row: col O = human comment, col R = MetaJSON for approval state
        └─ Renders: progress bar + expense items + history timeline + action buttons
```

---

## Deployment Checklist

### 1. Google Apps Script (`TLCG_CASH_BACKEND.gs`)
1. Open [script.google.com](https://script.google.com) → open project
2. Paste updated `TLCG_CASH_BACKEND.gs` content
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy the new deployment URL
5. If URL changed → set **`VOUCHER_BACKEND_URL`** on Vercel (Project → Settings → Environment Variables) and redeploy. If you open `voucher.html` over `file://`, also update the `GOOGLE_APPS_SCRIPT_WEB_APP_URL` constant (normally `/api/voucher` behind Vercel).

### 2. Google Sheet — `Voucher_History` Headers
Ensure row 1 contains exactly these 18 headers (A1–R1):

```
voucher_number | voucher_type | company_name | company_key_or_taxid | employee_name |
submited_email | submitted_by | submitted_at | amount | status | due_date | action |
attachments | description | note | approver_email | approved_at | MetaJSON
```

> ⚠️ **Historical data**: Rows submitted before this deployment have the old 13-column structure. Old data in cols D–R will be misaligned. New submissions will be correct from this deployment forward.

### 3. Frontend (`voucher.html`)
1. Save file
2. Deploy to web server (Netlify drag-and-drop or git push)
3. Hard-refresh browser (`Ctrl+Shift+R` / `Cmd+Shift+R`) to clear cached JS

---

## Backend API Reference

**Base URL**: In production this is normally the `/api/voucher` proxy (`GOOGLE_APPS_SCRIPT_WEB_APP_URL` in `voucher.html`). The real GAS `/exec` URL is configured server-side as **`VOUCHER_BACKEND_URL`** on Vercel (`api/voucher.js`).

| Action | Method | Handler | Key Input | Key Output |
|--------|--------|---------|-----------|-----------|
| `getEmployees` | GET | `handleGetEmployees` | — | `{ employees: [{name, dept, email, role}] }` |
| `getCompanyApprovers` | GET/POST | `handleGetCompanyApprovers` | `companyName`, `companyKey` | `{ approvers: {accountant, legalRep, treasurer} }` |
| `getVoucherSummary` | GET/POST | `handleGetVoucherSummary` | — | `{ pending, approved, rejected, total, recent[] }` |
| `getVoucherHistory` | GET/POST | `handleGetVoucherHistory` | `voucherNumber` | `{ voucher, history[] }` |
| `getApprovalStatus` | GET/POST | `handleGetApprovalStatus` | `voucherNumber` | `{ approvers, approvalProgress, currentApprover }` |
| `sendApprovalEmail` | POST | `handleSendEmail` | full voucher + email + companyApprovers | `{ success, voucherNumber }` |
| `approveVoucher` | GET/POST | `handleApproveVoucher` | `voucherNumber, approverEmail, approverRole, approverSignature` | `{ success, approvalProgress }` |
| `rejectVoucher` | GET/POST | `handleRejectVoucher` | `voucherNumber, approverEmail, rejectReason` | `{ success }` |
| `refreshApproverEmails` | POST | `handleRefreshApproverEmails` | — | Updates MetaJSON col R for all pending vouchers |
| `fetchSignatureImage` | POST | `handleFetchSignatureImage` | `imageUrl` | base64 data URL |
| `login` | POST | `handleLogin_` | `email` | `{ name, email, role }` |

All responses: `{ "success": true|false, "message": "...", "data": {...} }`

---

## Key Business Rules

1. **Sequential approval only** — cannot skip: accountant → legalRep → treasurer
2. **No self-approval** — requestor email ≠ any approver email
3. **No double approval** — once Approved/Rejected, locked
4. **Signature required** — requestor on submit; each approver on approve
5. **Duplicate prevention** — backend scans Voucher_History col A + col L before accepting new Submit
6. **Proxy allowed** — submitting for another employee is permitted; col G records actual submitter
7. **Auto-save** — form saves to localStorage every 3s; restored on reload with prompt
8. **Fallback data** — embedded base64 blob used if backend unreachable (company list only)
