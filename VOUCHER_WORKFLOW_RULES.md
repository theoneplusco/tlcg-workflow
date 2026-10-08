# TLCG Voucher Workflow — Rules & Logic Reference

> Reusable specification for any flow built on top of the same GAS backend + HTML frontend pattern.

---

## 1. Roles

| Role | How resolved | Description |
|---|---|---|
| `accountant` | Email matches `IMPORT_APPROVERS.accountant.email` | Step 1 approver — Kế toán trưởng |
| `legalRep` | Email matches `IMPORT_APPROVERS.legalRep.email` | Step 2 approver — Đại diện pháp luật |
| `treasurer` | Email matches `IMPORT_APPROVERS.treasurer.email` | Step 3 approver — Thủ quỹ |
| `admin` | `user.isAdmin === true` AND not an approver | Full visibility, no approval duties |
| `submitter` | Fallback — none of the above | Sees only own vouchers |

**Priority rule:** If a user is both admin AND an approver (e.g. Linh = admin + treasurer), the **approver role takes priority** for backend visibility filtering. Admin privilege is used only for stats scope.

**Resolution chain (frontend `getCallerRole()`):**
1. `u._approverRole` (backend-resolved, stored in localStorage after first fetch)
2. `u.isAdmin === true` → `'admin'`
3. Role string pattern matching (fallback, unreliable)
4. Default: `'submitter'`

**Resolution chain (backend `handleGetVoucherSummary`):**
- `callerRole` param is matched via `resolveRole()` against English keys and Vietnamese title patterns
- `callerApproverRole` is resolved by direct email match against `IMPORT_APPROVERS` and returned to frontend

---

## 2. Voucher States

### 2.1 Raw status values (stored in sheet col J)

| Value | Meaning |
|---|---|
| `Đang treo` | Submitted, no approvals yet |
| `Đang duyệt (1/3)` | Approved by accountant |
| `Đang duyệt (2/3)` | Approved by legalRep |
| `Đang duyệt (3/3)` | Approved by treasurer (waiting submitter ack) |
| `Approved` / `Đã duyệt` | Fully approved (3/3) |
| `Received` | Submitter acknowledged receipt — fully complete |
| `Đã từ chối` / `Rejected` | Rejected by any approver — workflow stopped |

### 2.2 Normalized buckets (`normalizeVoucherState`)

Priority order — first match wins:

| Condition | `bucket` |
|---|---|
| status includes "rejected" / "từ chối" | `rejected` |
| status includes "received" / "xác nhận" / "đã thu" / "đã nhận" | `acknowledged` |
| progressNum >= 3 OR status includes "approved" / "đã duyệt" | `approved` |
| progressNum > 0 and < 3 | `in-progress` |
| fallback | `pending` |

`progressNum` = first segment of `meta.companyApprovers.approvalProgress` (e.g. `"2/3"` → `2`)

`isOverdue` = not rejected/approved AND more than 2 days since submit timestamp

---

## 3. Backend Visibility Filter (`shouldShow`)

```
shouldShow(voucher):
  isOwnVoucher = voucher.requestorEmail === callerEmail
  isApprover   = callerRole in [accountant, legalRep, treasurer]

  if isAdmin AND NOT isApprover → show all
  if isApprover:
    if voucher is fully approved (prog>=3) OR acknowledged AND not own → hide
    else → show
  else (submitter):
    show only if isOwnVoucher
```

**Key rule:** Admin+approver (e.g. treasurer who is also admin) is treated as **approver** — they do NOT see all vouchers by default.

---

## 4. My Task Filter (`isMyTask`)

Applied client-side when the ⚡ button is active.

| Role | Shows |
|---|---|
| `accountant` | progressNum === 0 OR own voucher not rejected |
| `legalRep` | progressNum === 1 OR own voucher not rejected |
| `treasurer` | progressNum === 2 OR own voucher not rejected |
| `admin` | progressNum === 0, not rejected |
| `submitter` | Own vouchers, not rejected |

**Own voucher detection:**
```
isOwnVoucher = voucher.requestorEmail === userEmail
             OR (no requestorEmail AND voucher.employee === userName)
```
The name fallback covers old vouchers that predate the `requestorEmail` field in col F.

---

## 5. Stats Bar — Scope Rules

| User | My Task | Stats source | Pipeline title |
|---|---|---|---|
| Admin | OFF | `globalStats` from backend (all vouchers) | "Toàn công ty" |
| Admin | ON | Computed from `allLoadedVouchers` | "Việc của tôi" |
| Non-admin | OFF | Computed from `allLoadedVouchers` | "Của tôi" |
| Non-admin | ON | Computed from `allLoadedVouchers` | "Việc của tôi" |

`globalStats` is computed server-side only when `isAdmin=true` and returned as a separate field alongside the role-scoped `recent` list. It is never affected by My Task state.

---

## 6. 3-Step Approval Chain

```
Step 1: accountant   (Kế toán trưởng)
Step 2: legalRep     (Đại diện pháp luật)
Step 3: treasurer    (Thủ quỹ)
Step 4: submitter acknowledges receipt → status = Received
```

Rules:
- Steps must be sequential — step N cannot approve before step N-1
- Self-approval allowed — if the requestor is also a designated approver (accountant/legalRep/treasurer) for the company, they approve their own step like any other approver. The self-approval block was removed (previously rejected with "Người đề nghị không thể phê duyệt phiếu của chính họ.") because it left vouchers permanently stuck with no possible approver when the submitter was also the sole accountant/legalRep/treasurer for their company.
- On Postgres (2026-10-08 decision): the requester confirms with their password once at submit, and each of their own steps is then auto-approved with their stamped signature when the voucher reaches it. The history note is "Tự động duyệt khi gửi phiếu". If they cancel the prompt, they approve by hand as before.
- Each approver must upload a signature image
- Signature is verified via perceptual hash (16×16 greyscale canvas, Hamming distance, ~75% similarity threshold)
- Rejection at any step stops the workflow entirely
- After step 3, two emails are sent to submitter: (1) approval notification, (2) acknowledge action prompt

---

## 7. Approval Progress Tracking

`approvalProgress` is stored as `"N/3"` string in `meta.companyApprovers.approvalProgress`.

Backend derives `progressNum` two ways (takes the max):
1. Regex `\((\d)\/3\)` on the status string — new format
2. Count of rows where `action` contains `"Duyệt bởi"` — fallback for old data

Frontend `normalizeVoucherState` reads `meta.companyApprovers.approvalProgress` directly.

---

## 8. Acknowledge Receipt Flow

- Triggered by submitter after voucher reaches `approved` bucket
- Requires submitter signature upload
- Label: "Đã xác nhận thu tiền" (Phiếu Thu) vs "Đã xác nhận nhận tiền" (Phiếu Chi)
- After confirm: status → `Received`, bucket → `acknowledged`
- `acknowledged` is intentionally separate from `approved` in filter dropdown and stats

---

## 9. Filter Bar

| ID | Type | Logic |
|---|---|---|
| `vf-search` | text | Substring match on voucherNumber + employee + company |
| `vf-status` | select | See options below |
| `vf-type` | select | Case-insensitive substring of voucherType |
| `vf-date-from` | date | Lower bound on timestamp |
| `vf-date-to` | date | Upper bound — inclusive (appends `T23:59:59`) |

Filter state persisted in `localStorage` key `tlcg_voucher_filter_state_v2`.

### Status filter options

| Value | Matches |
|---|---|
| `""` | No filter |
| `Pending` | bucket === 'pending' |
| `InProgress1` | bucket === 'in-progress' AND progressNum === 1 |
| `InProgress2` | bucket === 'in-progress' AND progressNum === 2 |
| `InProgress3` | bucket === 'in-progress' AND progressNum === 3 |
| `Approved` | bucket === 'approved' only |
| `Acknowledged` | bucket === 'acknowledged' only |
| `Rejected` | bucket === 'rejected' |

---

## 10. Voucher Number Format

Pattern: `{COMPANY_CODE}-{TYPE_CODE}{YYYYMMDD}{COUNTER_6_DIGITS}`

Examples: `TL-PT20260420000001`, `ABC-PC20260420000003`

- `PT` = Phiếu Thu, `PC` = Phiếu Chi
- Counter is per-company-per-type-per-day, persisted in `localStorage` key `vc_{code}_{type}_{date}`
- Validation regex: `/^[A-Z]+-(?:PT|PC)\d{14}$/`

---

## 11. Data Shape — Voucher Summary (from `getVoucherSummary`)

| Field | Source | Description |
|---|---|---|
| `voucherNumber` | col A | Unique ID |
| `voucherType` | col B | "Phiếu Thu" or "Phiếu Chi" |
| `company` | col C | Company name |
| `companyKey` | col D | Tax ID or company code |
| `employee` | col E | Submitter name |
| `requestorEmail` | col F | Submitter email (may be blank in old records) |
| `submittedBy` | col G | Person who physically submitted |
| `timestamp` | col H | Submit datetime |
| `amount` | col I | Number |
| `status` | col J | Raw status string |
| `dueDate` | col K | Due date |
| `action` | col L | Last action label |
| `attachments` | col M | Drive file links |
| `description` | col N | Reason / description |
| `meta.companyApprovers` | derived | approvalProgress, accountant, legalRep, treasurer |

---

## 12. Sheet Column Map — Voucher_History

| Col | Index | Field |
|---|---|---|
| A | 0 | voucher_number |
| B | 1 | voucher_type |
| C | 2 | company_name |
| D | 3 | company_key_or_taxid |
| E | 4 | employee_name |
| F | 5 | submited_email |
| G | 6 | submitted_by |
| H | 7 | submitted_at |
| I | 8 | amount |
| J | 9 | status |
| K | 10 | due_date |
| L | 11 | action |
| M | 12 | attachments |
| N | 13 | description |
| O | 14 | note |
| P | 15 | approver_email |
| Q | 16 | approved_at |
| R | 17 | MetaJSON |
| S | 18 | acknowledged_at |
| T | 19 | acknowledged_by |
| U | 20 | signature_url |
| V | 21 | rejection_reason |

---

## 13. Sheet Column Map — Master Company

| Col | Index | Field |
|---|---|---|
| A | 0 | Company_Name |
| B | 1 | Company_Code |
| C | 2 | Company_Key_Or_Taxid |
| D | 3 | Legal_Representative_Name |
| E | 4 | Legal_Representative_Email |
| F | 5 | Legal_Representative_Signature |
| G | 6 | Email_Director |
| H | 7 | Chief_Accountant_Name |
| I | 8 | Chief_Accountant_Email |
| J | 9 | Chief_Accountant_Signature |
| K | 10 | Effective_Date |
| L | 11 | Treasurer_Name |
| M | 12 | Treasurer_Email |
| N | 13 | Treasurer_Signature |
| O | 14 | Company_Full_Name |
| P | 15 | Tax_ID |
| Q | 16 | Address |

---

## 14. Sheet Column Map — Master Employee

| Col | Index | Field |
|---|---|---|
| A | 0 | Họ và tên (Name) |
| B | 1 | Chức vụ (Position) |
| C | 2 | Phòng ban (Department) |
| D | 3 | Công ty (Company) |
| E | 4 | Email |
| F | 5 | Điện thoại (Phone) |
| G | 6 | Status (Active / inactive) |
| H | 7 | EmployeeId |
| I | 8 | Role (semantic role key) |
| J | 9 | isAdmin (TRUE/FALSE) |

---

## 15. Caching

| Key | TTL | Contents |
|---|---|---|
| `tlcg_voucher_summary_cache_v2` | 60s | Full voucher list from backend |
| `tlcg_voucher_filter_state_v2` | Permanent | Last filter bar state |
| `tlcg_approver_signature` | Permanent | Approver signature base64 |
| `tlc_current_user` | Session | User profile incl. `_approverRole` |
| `vc_{code}_{type}_{date}` | Daily | Voucher number counter |

---

## 16. Key Invariants

1. **`_approverRole` beats `role`** — the raw `role` string ("Executive 4") is useless for matching; always use `_approverRole` which is resolved by backend email lookup.
2. **Admin+approver = approver** for list visibility; admin privilege only unlocks global stats.
3. **`acknowledged` ≠ `approved`** — they are separate buckets, separate filter options, separate stat tiles.
4. **Stats bar is always computed from `allLoadedVouchers`** (role-scoped), except admin with My Task OFF which uses `globalStatsCache`.
5. **My Task toggle does not change the backend data fetched** — it is purely a client-side filter on `allLoadedVouchers`.
6. **Old vouchers** (pre-`requestorEmail`) use name matching as fallback: `voucher.employee === userName`.
7. **MetaJSON (col R) is skipped** in `getVoucherSummary` for performance — only `approvalProgress` is inferred from status/action columns.
