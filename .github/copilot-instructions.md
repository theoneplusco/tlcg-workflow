# TLCG Workflow - Copilot Instructions

## Project Overview

**TLCGroup Voucher Workflow System** - A Vietnamese language accounting workflow for expense vouchers (Phiếu Thu/Chi) with multi-company support, approval workflows, and Google Sheets integration.

**Stack:** HTML5/CSS3/JavaScript (frontend) + Google Apps Script (backend) + Google Sheets (data) + Netlify (hosting)

---

## Architecture

### Three-Tier Structure

1. **Frontend** ([phieu_thu_chi.html](../phieu_thu_chi.html), [index.html](../index.html))
   - Vanilla JS, embedded data (base64-encoded config), Tailwind CSS
   - **Key patterns:** Form state in global arrays (`expenseItems[]`, `approvalHistory[]`), localStorage auto-save
   - **External libs:** html2pdf.js, SheetJS (XLSX), font-awesome

2. **Google Apps Script Backend** ([TLCG_CASH_BACKEND.gs](../TLCG_CASH_BACKEND.gs), [TLCG_P2P_BACKEND.gs](../TLCG_P2P_BACKEND.gs), [TLCG_CORE_BACKEND.gs](../TLCG_CORE_BACKEND.gs))
   - Node-like `doPost()` handler receives JSON/form data
   - Routes requests by `action` field: `login`, `submit`, `approve`, `reject`, `sync`
   - **CRITICAL:** Sheet IDs hardcoded in constants at top of file

3. **Google Sheets** (TLCG Master Data + separate Voucher_History)
   - Column A row 1: "Nhân viên" (employees), "Công ty" (companies with metadata)
   - **Voucher_History sheet:** 14 columns (VoucherNumber, Status, Amount, etc.) with conditional formatting

### Data Flow

```
Form Fill (localStorage) 
  → Submit Button 
  → Fetch to GAS Web App URL 
  → doPost() routes by action 
  → Append to Sheets 
  → Send email notifications 
  → Return JSON response
```

---

## Critical Developer Workflows

### 1. Setup Google Apps Script
```bash
# Steps (not CLI-based, manual browser workflow):
1. Go to script.google.com
2. Create new project or open existing
3. Paste entire .gs file into Code.gs
4. Update sheet IDs at top:
   const USERS_SHEET_ID = 'XXXX';
   const VOUCHER_HISTORY_SHEET_ID = 'YYYY';
5. Deploy → New deployment → Web app
6. Execute as: Me, Access: Anyone
7. Copy Web App URL
```

### 2. Deploy to Netlify
```bash
cd "/Volumes/MacEx01/TLCG Workflow"
netlify login
netlify deploy --prod
# OR: Drag & drop folder to https://app.netlify.app/drop
```

### 3. Update frontend / Vercel after GAS deploy
1. Copy the new GAS Web App `/exec` URL.
2. In **Vercel** → Project → Environment Variables → set **`VOUCHER_BACKEND_URL`** to that URL (Production + Preview). Redeploy.
3. If you still maintain a standalone HTML deploy (non-Vercel), update the Web App URL in [script.js](../script.js) only if those pages bypass `/api/voucher` and hit GAS directly.

### 4. Debugging
- **Frontend console errors:** Check browser DevTools
- **GAS execution logs:** script.google.com → Execution logs → Search by timestamp
- **Debug sheet:** Automatically created at `Debug_Log` in Voucher_History spreadsheet
- **Common issue:** CORS - GAS requires `doPost()` to call `ContentService.createTextOutput()` at start

---

## Project-Specific Conventions

### 1. Data Embedding in Frontend
- **Config data is base64-encoded** in `script.js` line 1-2
  - Decode with: `JSON.parse(atob(b64))`
  - Contains: `form_title`, `voucher_types`, `company_names`, `employee_names`, `approver_names`, `companies_data`
  - **To update:** Edit `companies_data` array → Re-encode base64 → Paste into script.js
  - Use [create_password_hash.html](../create_password_hash.html) or online base64 encoder

### 2. Form Validation Patterns
- Validate on blur, real-time feedback on input
- Invalid fields get `.invalid` class → red border
- Show error messages in `.error-message` elements below fields
- Always `validateAllFields()` before submit/export

### 3. Auto-Save with localStorage
- 2-second debounce delay (const `AUTO_SAVE_DELAY = 2000`)
- Saves to `localStorage.getItem('voucher_draft')` as JSON
- Load on page init with `loadFromLocalStorage()`
- **Limitation:** Files can't be restored (only metadata)

### 4. Expense Table Structure
```javascript
expenseItems = [
  { content: string, amount: number, attachments: File[] },
  ...
]
```
- Rendered with `renderExpenseTable()` → adds/removes rows dynamically
- Grand total calculated in `updateGrandTotal()` (loops all items)

### 5. Approval Workflow
```javascript
approvalHistory = [
  { timestamp, action ('Submit'|'Approved'|'Rejected'), by: email, to: email },
  ...
]
```
- Append with `approvalHistory.push({...})` after each action
- Rendered in approval timeline section
- Locked after final approval/rejection (check `canApproveOrReject()`)

### 6. Email Integration
- All emails sent via **Gmail**: GAS has built-in `MailApp.sendEmail()` (limited) or `GmailApp` (requires user auth)
- **Pattern:** Link in email is generated with `approval_link = `https://workflow.domain/approve_voucher.html?vid=${voucherNumber}&token=...`
- Links redirect to [approve_voucher.html](../approve_voucher.html) or [reject_voucher.html](../reject_voucher.html)

---

## Integration Points & External Dependencies

### 1. Google Apps Script Web App Endpoint
- **URL format:** `https://script.google.com/macros/s/{DEPLOYMENT_ID}/exec`
- **Request format:** FormData or JSON POST
- **Response:** `{ success: true/false, message: string, data?: object }`
- **All requests must include `action` field** (e.g., `action=login`, `action=approve`)

### 2. Google Sheets Integration
- **Reading:** `SpreadsheetApp.openById(SHEET_ID).getSheetByName(name)`
- **Writing:** `.appendRow([...])` or `.getRange(...).setValues(...)`
- **Queries:** Linear scan (no native SQL) - loop all rows with `getDataRange().getValues()`

### 3. Library Dependencies
| Lib | URL | Usage |
|-----|-----|-------|
| html2pdf.js | CDN | PDF export from DOM |
| SheetJS (XLSX) | CDN | Excel import/export |
| Font Awesome | CDN | Icons in UI |
| Tailwind CSS | CDN | Styling (no local build) |

### 4. DNS/Subdomain Setup (Wix)
- Add CNAME record: `Name: workflow`, `Value: [netlify-site].netlify.app`
- Wait DNS propagation (~5-30 min)
- Test: `https://wf.tl-c.us/index.html`

---

## Common Patterns & Examples

### Add New Voucher Type
1. Update base64 data in `script.js` → add to `voucher_types` array
2. Re-encode base64, replace in script.js
3. Redeploy to Netlify

### Add New Company
1. Add row to Google Sheet "Công ty" column with full metadata
2. Add to `companies_data` array in base64 config
3. Update company email mappings in `script.js`

### Debug Failed Email
1. Check GAS logs: script.google.com → Execution logs
2. Log in `doPost()`: `Logger.log('Email sent to: ' + email)`
3. Verify email exists in USERS_SHEET_ID
4. Test with `MailApp.sendEmail(testEmail, 'Test', 'test')` in GAS editor

### Handle Form Errors
- Add `.invalid` class to field: `field.classList.add('invalid')`
- Show error: `.error-message` sibling element (must have `.show` class to display)
- Clear error on input event: remove `.invalid` class

---

## Deployment Checklist

- [ ] Update GAS sheet IDs in `.gs` files
- [ ] Deploy GAS → copy Web App URL
- [ ] Update GOOGLE_APPS_SCRIPT_WEB_APP_URL in script.js
- [ ] Test form submission with test voucher
- [ ] Verify email notification received
- [ ] Deploy to Netlify: `netlify deploy --prod`
- [ ] Test at production domain: `https://wf.tl-c.us`
- [ ] Update DNS CNAME if domain changed

