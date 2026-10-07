# Purchase Request (Đề Nghị Mua Hàng): GAS behaviour spec for the Postgres port

Date: 2026-10-07. Status: reference spec (read-only research). Scope: what `TLCG_P2P_BACKEND.gs` (repo HEAD, last changed by commit `38c55fb`, 2026-10-02) does for the Purchase Request ("PR") workflow, what the pages expect back, and how far `api/handlers/purchase-request.js` is from it.

All `NNNN` line numbers are in `TLCG_P2P_BACKEND.gs` unless a file is named. "Row index" means the 0-based array index GAS uses; "col X" is the sheet letter.

> **Read this first: the live GAS deployment is probably not repo HEAD.** HEAD stopped writing PR event rows in `38c55fb` (2026-10-02 21:50 PDT). The live sheet still has PR event rows dated 2026-10-04 and 2026-10-05 (for example `EV-PR20261005000001`, Submit, `2026-10-05T10:50:11.901Z`). But `Purchase_Request_Archive` exists with two rows, so code from `38c55fb` (the archive) has run at some point. Before using this spec as the parity target, confirm which script version is deployed (open question Q1). This spec describes HEAD and points out where the live data shows different behaviour.

---

## 0. Architecture in one paragraph

The pages (`purchase_request.html`, `acceptance_minutes.html`, `contract.html`, `payment_request.html`) POST to `/api/voucher`. `server.js:104-121` sends an action to a Postgres handler only when it is in `migratedActions`, and that happens only when `PG_WORKFLOWS` contains `p2p` (`api/router.js:85-96`). Today `p2p` covers 5 actions (`api/router.js:89`). Everything else goes through `api/voucher.js:286-334` to the P2P Apps Script web app. GAS `doPost` (358-475) parses `data=<json>` (form-encoded) or a raw JSON body, calls `setReqLang_(data.lang)`, and routes on `data.action`. Every response is `createResponse(success, message, data)` (1528-1538), which **spreads `data` into the top level**: `{success, message, ...data}`. GAS never returns a `data` key. Several pages read `result.data?.x` anyway (see §3).

---

## 1. Data model

### 1.1 Sheets involved

| Sheet (master spreadsheet `MASTER_SPREADSHEET_ID`) | Role | Written by |
|---|---|---|
| `Purchase_Request_History` (`PR_SHEET_NAME`, 2038) | The working sheet. One **submit row** per PR plus legacy **event rows** | submit, approve, reject, send back, resubmit, archive sweep, contract sync |
| `Purchase_Request_Archive` (2091) | Finished PRs more than 90 days old (see §1.6) | archive sweep only |
| `PR_Audit_Log` | Append-only action log; the drawer history reads it | `_appendAuditLog_` (1997) |
| `Goods-KTT` | Goods catalog (read-only) | — |
| `Purchase Order` | PO types (read-only) | — |
| `Nhà cung cấp` | Supplier list that `addSupplier` writes to | `addSupplier` |
| `Payment_Request_History`, `Contract_History`, `Acceptance_Minutes_History` | Downstream workflows that look PRs up by number | — |
| Drive folder `PURCHASE_REQUEST_FOLDER_ID` (default `1SJ-pUa6jg2rmJTzle-TvvSNrKMUduvx3`) / `02.De_Nghi_Mua_Hang` / `<prNo>` | Attachments | submit, resubmit |

### 1.2 `Purchase_Request_History` columns (`PR_HEADERS_` 4633-4639 + `P2P_HISTORY_HEADERS_` 4665-4670)

| Col | Idx | Header | Meaning, format, live example | Written at |
|---|---|---|---|---|
| A | 0 | `pr_no` | PR number, text. `EV-PR20260805000003`. Not unique on its own in old data (see 1.7) | submit 2908 |
| B | 1 | `company_name` | Full legal name from the form. `CÔNG TY TNHH EGG VENTURES` | 2909 |
| C | 2 | `company_key` | Company key from the embed list. `E.V`, `E.V_205 NTP`, `E.V_KTT_Trạm`, `TLC`, `INS`, `W.S`, `M.I` | 2910 |
| D | 3 | `department` | Requester's department (read-only on the form, from Master Employee). `Phòng Bán Hàng` | 2911 |
| E | 4 | `requester_name` | Requester display name. `Anh Thư Thái Thị` | 2912 |
| F | 5 | `required_date` | Date needed. `YYYY-MM-DD` text from `<input type=date>`. The archive export shows `5/28/2026`, so Sheets sometimes turns it into a Date cell | 2913 |
| G | 6 | `priority` | `Gấp` / `Bình Thường` / `Không Gấp`. Mapped from `gap|binh_thuong|khong_gap|high|medium|low`. Unknown values are stored as given; empty becomes `Bình Thường` (2914-2918) | 2914 |
| H | 7 | `purpose` | Free text | 2919 |
| I | 8 | `suggested_vendor` | `data.vendorName || data.suggestedVendor`. Often empty (23/32 live) | 2920 |
| J | 9 | `budget_code` | `data.budgetCode`. The page never sends it, so always empty | 2921 |
| K | 10 | `budget_approver_email` | Email the requester chose. Case kept as sent; compared lower-cased | 2922 |
| L | 11 | `supplier_approver_email` | Same | 2923 |
| M | 12 | `items_json` | JSON **string** exactly as the client sent it (§1.3) | 2924 |
| N | 13 | `grand_total` | `parseFloat(data.grandTotal) || 0`. **Computed by the client; the server never adds up the items.** Rewritten by the contract sync (§2.7) | 2925 |
| O | 14 | `status` | §2.1 | 2926 |
| P | 15 | `submitted_at` | `data.submittedAt || new Date().toISOString()`. **The client's clock.** ISO text, e.g. `2026-08-05T08:34:20.857Z`. Together with A, this is the identity GAS uses to find a row | 2927 |
| Q | 16 | `metadata_json` | JSON string (§1.4) | 2928 |
| R | 17 | `contract_approver_email` | Kept only when the branch is `full`; otherwise `''` (2929) | 2929 |
| S | 18 | `purchasing_approver_email` | Optional | 2930 |
| T | 19 | `attachment_urls` | Uploaded Drive URLs joined with `', '` | 2931 |
| U | 20 | `row_type` | `submit` on PR rows, `event` on legacy history rows | 2932 |
| V–AD | 21–29 | `event_action, event_role, event_actor_email, event_actor_name, event_prev_status, event_new_status, event_timestamp, event_note, event_metadata_json` | Filled only on `event` rows (A = PR No, B–T empty) | legacy `appendP2PHistoryRow_` (4742) |

`PR_ROW_WIDTH = 21` (2094). Every read pads rows to 21 cells (`prPadRow_` 2134).

#### The repeated `event_*` groups in the header

The live header has 70 columns: the 20 base columns, then the 10-column history group four times in lower case, then a fifth time as `Row_Type, Event_Action, …, Event_Meta_JSON`. The archive header has 60 columns (four groups), because `getOrCreatePRArchive_` (2325) copied the working sheet's header at the width it had then.

How it happened. The first history version (`43c1476`, 2026-06-30) had an `ensureP2PHistoryColumns_` that checked header names case-sensitively and appended any it could not find after the last column. Each time the header names or casing changed (for example `Event_Meta_JSON` vs `event_metadata_json`), another 10-column group was added. HEAD now does two things. `applyStandardHeaders_` (4672) overwrites cols 1–30 with the canonical names. `ensureP2PHistoryColumns_` (4701) renames aliases in place and appends only names that are truly missing. That stops new groups, but the old ones stay.

How data uses them. **Only the first group (cols U–AD, idx 20–29) ever holds data.** In the export, every cell from idx 29 to 69 is empty in all 109 data rows (checked). Writers append rows positionally: base 20 cells plus 10 event cells (4742-4761), or 21 cells for a submit row. Readers use fixed indexes (`row[20]`, `row[21..29]`, 2096, 2462-2472). The extra header groups are dead. A Postgres port can ignore them. A Sheets mirror that writes this sheet must write positionally or by the *first* occurrence of each header.

HEAD writes no new event rows for PRs (`38c55fb` removed the five `appendP2PHistoryRow_(sheet, 20, …)` calls). Existing event rows are still:
- skipped by every list, search and lookup (`prIsEventRow_`, 2096)
- moved to the archive with their PR (2371-2375)
- used as a **fallback history** when `PR_Audit_Log` has no rows for that number (2455-2475)

### 1.3 `items_json` shape (built by `purchase_request.html:3252-3270`)

```json
[{"section":"hang-hoa","loai":"Hàng Hóa","desc":"Khăn Giấy rút","qty":"5","unit":"Cái","price":"29900","total":"149500","note":""}]
```

| Key | Type | Notes |
|---|---|---|
| `section` | string | `hang-hoa` / `thiet-bi` / `dich-vu` / `sua-chua` (`purchase_request.html:2416-2421`) |
| `loai` | string | `Hàng Hóa` / `Thiết Bị (TSCĐ/CCDC)` / `Dịch Vụ` / `Sửa Chữa (TSCĐ)` |
| `desc` | string | Rows with empty `desc` are dropped by the client |
| `qty`, `price`, `total` | **strings** | `price` can have leading zeros (`"02000000"`, `"051900"` live). `total` comes from the row's `data-value` (client math) |
| `unit`, `note` | string | |

GAS checks only that the JSON parses and is a non-empty array (2763-2772). It does not check keys, numbers, or `sum(total) == grand_total`. In live data all 32 PRs do match. Readers also accept `quantity`, `unitPrice`, `name`, `itemName` (`purchase_request.html:4684-4688`, `acceptance_minutes.html:1288`).

### 1.4 `metadata_json` keys

| Key | Set by | Value |
|---|---|---|
| `companyCode` | submit 2848 / resubmit | The company `<select>` **value**, e.g. `CÔNG TY TNHH EGG VENTURES (E.V_KTT_Trạm)` (not the short code) |
| `companyKey` | submit/resubmit | Same as col C |
| `requesterEmail` | submit (as sent) / resubmit (**lower-cased**, 3750) | From `localStorage.tlc_current_user.email` (`purchase_request.html:3303`). Missing on legacy archive rows |
| `budgetApproverNote`, `supplierApproverNote` | submit/resubmit | Requester's note to each approver (UI has no input today, so `''`) |
| `submittedAt` | submit | Same as col P. Resubmit keeps the original (3754) |
| `requesterSignature` | submit/resubmit | `data:image/jpeg;base64,...` data URL (12–18 KB live) |
| `attachments` | submit/resubmit | `[{fileName, fileUrl}]`; failed uploads add `error` with `fileUrl:''` |
| `purchaseType` | submit/resubmit | `goods` / `services` (anything else becomes `goods`, 2774-2775) |
| `p2pBranch` | submit/resubmit | `full` / `simplified` (`computeP2PBranch_` 4470). Missing on legacy rows; readers default to `full` |
| `budgetStatus`, `supplierStatus`, `purchasingStatus` | submit/resubmit, approve, send back | `Pending` when that approver email was given, else `N/A`; `Approved` after approval. **Never `Rejected`** |
| `contractStatus` | submit/resubmit | Always `N/A` (2863, 3768) |
| `vendorDetails` | submit/resubmit | `{vendorType, vendorTaxId, vendorAddress, vendorAccountName, vendorAccountNo, vendorBankName, vendorTransferNote}` |
| `{role}ApprovedAt`, `{role}Note` | approve 3330-3332 | ISO time; approver note (the page always sends `''`) |
| `{role}Signature` | approve 3335-3337 | Approver signature data URL |
| `{role}SignatureVerification` | approve 3338-3344 | Parsed object `{verified, similarity, reason, threshold?}` computed **in the browser**; `{raw:…}` when it does not parse |
| `rejectedAt`, `rejectedBy`, `rejectionNote` | reject 3462-3464 | `rejectedBy` is lower-cased |
| `sentBackHistory` | send back 3590-3597 | `[{targetStep, by, byRole, at, note}]`; resubmit keeps it |
| `resubmittedAt`, `resubmitCount` | resubmit 3755-3756 | |
| `previousPrNo` | maintenance split 2675 | Old number when a duplicate was renumbered (3 live rows) |
| `contractNo`, `contractValue`, `prGrandTotalBefore` | contract sync 4927-4929 | Written when a contract or amendment is approved |

Sheets limits a cell to 50,000 characters. Metadata holds the requester signature plus up to three approver signatures as base64, and the largest live cell is already 18,059 characters. A PR with large signatures can fail on approve. Postgres removes that limit; it is not a rule to copy.

### 1.5 Number format and allocation

| Who | Format | Rule |
|---|---|---|
| Browser (`purchase_request.html:2384-2404`) | `{CODE}-PR{YYYYMMDD}{NNNNNN}` | `CODE` = the selected company's `dataset.code` with non-alphanumerics removed, upper-cased (`EV`, `TL`, `IN`, `MI`, `WS` live). Date = **browser local date**. Counter = `localStorage['vc_{CODE}_PR_{YYYYMMDD}'] + 1`, so each device counts separately. After a success the page raises its counter to the issued number (`_rememberIssuedPRNo`, 2406) |
| Server fallback, no number sent (2783-2787) | `PR-{yyyyMMdd Asia/Ho_Chi_Minh}-{random 0–99999 padded to 6}` | Never seen live |
| Server dedupe `allocateUniquePRNoOnServer_` (2178-2199) | — | Keeps the requested number if neither the working sheet nor the archive has it in col A (exact, case-sensitive). If the number matches `^(.*-PR\d{8})(\d+)$`, it increments the numeric tail (same width) until free, up to 1000 tries. Otherwise it appends `-2`, `-3`, … |

Dedupe runs twice: once without a lock before the Drive upload (2791-2796), then again under `LockService.getScriptLock().waitLock(8000)` just before `appendRow` (2897-2906). If the lock times out the user gets `Hệ thống đang bận. Vui lòng gửi lại.` (2899). If the second pass picks a different number, the attachments are already in the folder named after the first number (bug B10).

Event rows count as "taken" because `prFindRowsByNo_` searches col A on all rows.

### 1.6 Archive semantics

- **Trigger:** the first `getPurchaseRequestHistory` call after 24 h (`PR_ARCHIVE_RAN_AT` script property), and only if `tryLock(1500)` gets the script lock (2409-2425). Also `runPurchaseRequestMaintenance()` from the editor (2540).
- **Rule** (`archiveOldPurchaseRequestsNow_` 2354-2407): a submit row moves when its status is terminal (`Hoàn thành | Approved | Đã từ chối | Rejected`, 2109) **and** its last activity is more than 90 days ago. Last activity = the latest of `submitted_at`, `rejectedAt`, `{budget,supplier,contract,purchasing}ApprovedAt`, `resubmittedAt`, and every `sentBackHistory[].at` (2115-2132). A number moves only if *no* non-archivable row shares it. All event rows with that number move too. Rows are copied as contiguous blocks at full sheet width, then deleted bottom-up.
- **After archiving:** the PR drops out of `getPurchaseRequestHistory`. `getPurchaseRequest`, `searchPurchaseRequests`, `findPRByNo_` and every approve/reject/send-back/resubmit lookup still find it, because `findPRSubmitLocation_` searches both sheets (2214-2229). **But `createAcceptanceMinutes` checks PR status on the working sheet only** (4030-4044). For an archived PR it returns `Không tìm thấy phiếu đề nghị mua hàng: <no>` (bug B6).
- **List window:** `prCollectWorkingRows_` (2300-2323) returns the last 5,000 rows (`PR_LIST_WINDOW`) plus any older non-terminal rows.

### 1.7 Duplicates and the maintenance split

Before server dedupe existed, devices with the same local counter created duplicate numbers. `repairDistinctDuplicatePRs_` (2635-2701), run by hand, keeps the number on the copy that has progressed furthest (`prProgressScore_` 2614). Each other copy gets the next free number and `metadata.previousPrNo`. Its submit event row and matching `PR_Audit_Log` rows are renamed too (same submitter within 2 min, or approval stamps within 20 s; 2579-2612, 2719-2741). Live: `EV-PR20260924000005/6` (from `…0004`, three identical 35,391,000₫ submissions within 90 s) and `EV-PR20260930000002` (from `…0001`).

Because a number could repeat, every lookup also takes `submittedAt`. `findPRSubmitLocation_(ss, prNo, submittedAt)` requires `prTimeKey_(col P) === prTimeKey_(submittedAt)` when `submittedAt` is non-empty, and returns `null` if nothing matches (2224-2228). In Postgres `pr_no` is unique, so `submittedAt` only matters for wire compatibility, plus bug B1.

### 1.8 `PR_Audit_Log` columns (`AUDIT_HEADERS_` 4659-4663, writer 1997-2028)

| Col | Header | Values |
|---|---|---|
| A | `document_no` | PR number |
| B | `flow` | `PR` |
| C | `company_name` | Col B of the PR |
| D | `action` | `Submit`, `Approve`, `Reject`, `Return`, `Resubmit`, `ContractApproved_PRUpdated` |
| E | `role` | `requester`, `budget`, `supplier`, `contract`, `purchasing` |
| F | `actor_email` | As sent (approve/reject/send-back lower-case it) |
| G | `actor_name` | Only filled on Submit and Resubmit |
| H | `prev_status` / I `new_status` | Status strings |
| J | `timestamp` | `new Date().toISOString()` (server) |
| K | `note` | Submit: purpose. Approve/Reject/Return: note. Resubmit: `Gửi lại lần N` |
| L | `extra_json` | Submit `{purchaseType,p2pBranch}`. Approve `{signatureUploaded:true, verification:"<json string>"}` or empty. Return `{targetStep}`. Contract sync `{oldTotal,newTotal,contractNo}` |

Audit failures are logged and ignored (2025-2027). The audit write is not atomic with the sheet write. On submit it runs **inside** the number lock (2938-2951); on the other actions it runs after.

---

## 2. State machine

### 2.1 Statuses (col O). Exact strings, never translated (comment at 30-31)

| Status | Meaning | Terminal? | Set by |
|---|---|---|---|
| `Đang duyệt ngân sách & NCC (2/5)` | Budget and supplier approve in parallel | no | submit 2926, resubmit 3795, send back to step 2 (3574), approve while parallel is still open |
| `Thẩm định Hợp đồng (4/5)` | Contract review. **The computed stage never reaches it** (2.3). Only send back to step 3 writes it (3577) | no | send back step 3 |
| `Mua hàng (5/5)` | Waiting for the purchasing approver | no | approve (computed) |
| `Hoàn thành` | Fully approved | yes | approve (computed) |
| `Đã từ chối` | Rejected | yes | reject 3466 |
| `Trả lại bổ sung` | Returned to the requester for changes | no (blocks approve/reject/send back) | send back step 1 (3572) |

Legacy values still recognised by readers: `Approved` and `Rejected` (treated as terminal everywhere, 2109); `Đang duyệt ngân sách (2/5)`, `Đang duyệt nhà cung cấp (3/5)`, `pending` (page labels only, `purchase_request.html:4174-4207`). `patchRecomputeAllPRStatuses_` (3206) recomputes legacy labels on non-terminal rows.

Page buckets (`purchase_request.html:4217`): `hoan-thanh` = Hoàn thành/Approved; `tu-choi` = Đã từ chối/Rejected; `dang-xu-ly` = anything else non-empty, including `Trả lại bổ sung`.

### 2.2 Branch

`computeP2PBranch_(purchaseType, grandTotal)` (4470-4476): `services` **or** `grandTotal >= 2,000,000` → `full`; otherwise `simplified`. `grandTotal` is the client's value. The branch is fixed at submit or resubmit. Effects:
- `full` requires `contractApprover` (2777-2780; message hard-coded Vietnamese: `Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.`). Col R stores it; `simplified` stores `''`.
- Downstream: `full` means PR → Contract (`contract.html`, reviewer = PR col R) → Acceptance Minutes (needs a signed contract) → Payment, possibly in instalments. `simplified` means PR → AM (no contract) → Payment. There is also a "direct payment" path in GAS (§3.12) that the page cannot reach today.

### 2.3 Approval chain (`computePRApprovalState_` 3147-3200)

Inputs: emails in cols K, L, R, S (lower-cased, trimmed) and the metadata `*Status` values.

```
budgetDone     = !budgetEmail     || budgetStatus == 'Approved'
supplierDone   = !supplierEmail   || supplierStatus == 'Approved'
skipPRContract = (p2pBranch == 'full' || p2pBranch == 'simplified')   // always true in practice
contractDone   = skipPRContract || !contractEmail || contractStatus == 'Approved'
purchasingDone = !purchasingEmail || purchasingStatus == 'Approved'

if !(budgetDone && supplierDone)            → stage 'parallel',   'Đang duyệt ngân sách & NCC (2/5)'
elif !skipPRContract && contractEmail && !contractDone → 'contract', 'Thẩm định Hợp đồng (4/5)'   // unreachable
elif purchasingEmail && !purchasingDone     → 'purchasing', 'Mua hàng (5/5)'
else                                        → 'complete',   'Hoàn thành'
```

`skipPRContract` is true unless `p2pBranch` is some other non-empty string, so **the in-PR contract stage is dead code**. The live chain is:

| Step | Role key(s) | Who | Required? | Rule |
|---|---|---|---|---|
| 1 (parallel) | `budget`, `supplier` | Emails the **requester chose** on the form (cols K, L) | Both required at submit (2758-2761) | Both must approve, in any order. If budget and supplier are the same person, that person approves **twice**, once per role (all 32 live PRs use `linh.le@tl-c.com.vn` for both; the audit log shows two Approve rows about 20 s apart) |
| — | `contract` | Col R | Required on `full` | Never an in-PR stage. Used by the Contract module as the contract reviewer (4998, 5031) |
| 2 | `purchasing` | Col S | Optional | Opens after step 1. When empty, step 1 completes the PR |

**How approvers are chosen.** The server does not resolve anyone; it trusts the emails sent. The page (`purchase_request.html:3652-3728`) restricts the choice:
- `budget_approver`, `supplier_approver`, `contract_approver` options = the selected company's **Email Đại diện pháp luật**, **Email Kế toán trưởng**, **Email Thủ quỹ** from `tlcg_companies_embed.js` (Master Company), labelled with employee names. Budget and supplier default to the Treasurer. Contract has no default and offers "-- Không có --".
- `purchasing_approver` options = active employees whose department is exactly `Kế Toán Chi`, defaulting to the first one (live: `Tlc.ap@tl-c.com.vn` on all 32).
- No condition depends on amount, priority or company beyond that list. Amount and type only pick the branch, and the branch only changes whether a contract approver is required.

### 2.4 Transitions and permissions

| From | Action | Who (server check) | To | Metadata change |
|---|---|---|---|---|
| — | submit | anyone (no identity check) | `Đang duyệt ngân sách & NCC (2/5)` | full metadata (1.4) |
| parallel | approve `budget`/`supplier` | `approverEmail` == col K / L (case-insensitive) and that role is not yet Approved | recomputed (parallel / `Mua hàng (5/5)` / `Hoàn thành`) | `{role}Status=Approved`, `ApprovedAt`, `Note`, `Signature`, `SignatureVerification` |
| purchasing | approve `purchasing` | == col S | `Hoàn thành` | same |
| parallel or purchasing (not terminal, not returned) | reject | the email maps to a role whose stage is active (3432-3451) | `Đã từ chối` | `rejectedAt/By/Note` |
| parallel | send back step 1 | budget or supplier of the active stage | `Trả lại bổ sung` | push `sentBackHistory`; **no status reset** (3573) |
| purchasing | send back step 1 / 2 / 3 | purchasing approver | `Trả lại bổ sung` / `Đang duyệt ngân sách & NCC (2/5)` / `Thẩm định Hợp đồng (4/5)` | step 2: reset budget, supplier, contract, purchasing (only those not `N/A`) to `Pending` and delete their `ApprovedAt`/`Note` (signatures stay). Step 3: reset contract and purchasing |
| `Trả lại bổ sung` | resubmit | `requesterEmail` == stored `metadata.requesterEmail` (skipped when none is stored) | `Đang duyệt ngân sách & NCC (2/5)` | metadata rebuilt from the new form; only `submittedAt` and `sentBackHistory` are kept |
| `Thẩm định Hợp đồng (4/5)` (after send back step 3) | approve `purchasing` | col S | `Hoàn thành` | The status *label* says contract, but the computed stage is `purchasing`, so only the purchasing approver can act (bug B3) |

Maximum send-back target per role: `{budget:1, supplier:1, contract:2, purchasing:3}` (3562). `contract` can never act because its stage is never active.

Reaching `Hoàn thành` emails the requester (§3.5). `Đã từ chối` sends **no email**.

### 2.5 Final states and links downstream

| Downstream | Needs from the PR | GAS |
|---|---|---|
| Contract (`createContract` 4965) | `status === 'Hoàn thành'` (`prNotFullyApproved`), branch `full` (`prSimplifiedNoContract`), no open or signed contract already | `findPRByNo_` (both sheets). Reviewer email = PR col R |
| Contract approved / amendment approved | — | `syncPRGrandTotalFromContract_` (4917-4943) **rewrites PR col N** to the contract value, adds `contractNo/contractValue/prGrandTotalBefore` to metadata, and when the value changed writes audit action `ContractApproved_PRUpdated` (role `contract`, note `Cập nhật giá trị PR theo hợp đồng <no>`). Called at 5076 and 5290 |
| Acceptance Minutes (`createAcceptanceMinutes`) | `status === 'Hoàn thành'` read from the **working sheet only** (4030-4044, messages `prNotApprovedYet`, `prDocNotFoundPrefix`). On `full` it also needs a contract in `Đã ký`/`Có phụ lục` that belongs to this PR | |
| Payment (`sendPaymentRequest` 584-615) | AM path: ceiling = signed contract value, else PR col N; sum of non-rejected payments must stay within it. Direct path (`prRequestNo` without `amNo`): `_validatePRForDirectPayment_` | |
| Pages | `contract.html:191-210` and `acceptance_minutes.html:1078-1185` load the **whole list** via `getPurchaseRequestHistory` and filter on `status === 'Hoàn thành'`, `p2pBranch`, `company`, `suggestedVendor`, `grandTotal`, `requesterName`, `items` | see §3.2 |

Live: no PR on the working sheet is `Hoàn thành`. 21 sit at `Mua hàng (5/5)`. So right now no contract or AM can be created from any working-sheet PR.

---

## 3. Actions

Notation: **R** = request fields the server reads (`data.*`), **V** = validation in order (exact `msg_` key → Vietnamese text from `MSG_.vi` 34-112; English exists in `MSG_.en` and is used only when the payload has `lang:'en'`). Note that `i18n.js:709-758` adds `lang` only to raw-JSON or FormData `data` bodies, so the form-encoded PR calls arrive without `lang` and get Vietnamese. **S** = side effects. **Resp** = the JSON keys in the response (top level, because `createResponse` spreads them).

Common errors: `errParse` `Lỗi parse dữ liệu: …`, `errServer` `Lỗi server: …`, unknown action `Invalid action: <a>` (471).

### 3.1 `purchaseRequest`: submit (`handlePurchaseRequest` 2743-2970)

**R:** `prNo, companyName, companyCode, companyKey, department, requesterName, requesterEmail, requiredDate, priority, purpose, vendorName|suggestedVendor, budgetCode, budgetApprover, budgetApproverNote, supplierApprover, supplierApproverNote, contractApprover, purchasingApprover, items (JSON string), grandTotal, purchaseType, requesterSignature, submittedAt, attachments ([{fileName,fileData(base64 or dataURL),mimeType}] array or JSON string), vendorType, vendorTaxId, vendorAddress, vendorAccountName, vendorAccountNo, vendorBankName, vendorTransferNote`. The page also sends `currency` and `p2pBranch`; **both are ignored** (the server recomputes the branch).

**V (in order):**
1. `companyName` empty → `Thiếu tên công ty.`
2. `requesterName` empty → `Thiếu tên người đề nghị.`
3. `requiredDate` empty → `Thiếu ngày cần hàng.`
4. `budgetApprover` empty → `Vui lòng chọn người phê duyệt ngân sách.`
5. `supplierApprover` empty → `Vui lòng chọn người phê duyệt NCC.`
6. `items` does not parse → `Dữ liệu hàng hóa không hợp lệ: <JS error>`
7. not an array, or empty → `Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.`
8. branch `full` and no `contractApprover` → `Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.`
9. lock timeout → `Hệ thống đang bận. Vui lòng gửi lại.`
10. any exception → `Lỗi khi lưu đề nghị mua hàng: <msg>` (`errSaveContract`)

Not validated: email formats, `requesterEmail` presence, `purpose`, `requiredDate` format or past dates, item contents, `grandTotal` vs items, approvers belonging to the company.

**S:**
1. Number allocation (§1.5).
2. Attachments: each file with `fileData` is decoded and saved to `<folder>/02.De_Nghi_Mua_Hang/<prNo>/`, then shared **ANYONE_WITH_LINK / VIEW** (2836-2839). Records are `{fileName, fileUrl}`, or `{…, fileUrl:'', error}` on failure. Upload errors never fail the submit. Page limits: 5 files, 10 MB each, 30 MB total (`purchase_request.html:2005-2008`).
3. Creates the sheet with headers if it is missing; otherwise standardises the headers.
4. `appendRow` of the 21-cell row (2907-2933) under the script lock, then `flush`.
5. Audit `Submit` / `requester` / prev `''` / new `Đang duyệt ngân sách & NCC (2/5)` / note = purpose / extra `{purchaseType,p2pBranch}`.
6. Emails (`sendPurchaseRequestEmails_` 2972-3040). Failures are ignored. Sent by `GmailApp` as the script owner, display name `TLC Group Workflow`, HTML only, **no link to the app**, values **not HTML-escaped**:
   - To `budgetApprover` and `supplierApprover`, **one email each, even when they are the same address**: subject `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - <prNo>`. Body: "Kính gửi," plus "Có một **Đề nghị mua hàng** mới đang chờ phê duyệt của bạn." Table: Số phiếu, Công ty, Người đề nghị, Mục đích, Tổng cộng (`toLocaleString('vi-VN') + ' ₫'`), Ngày cần hàng. Then "Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.", the attachment links list `Tệp đính kèm:`, and the signature "Trân trọng,<br>Hệ thống Workflow TLC Group".
   - To `requesterEmail` if given: subject `[ĐỀ NGHỊ MUA HÀNG] Xác nhận gửi phiếu - <prNo>`. Same table without Người đề nghị, plus "Người phê duyệt đã được thông báo qua email…".
   - The purchasing and contract approvers are **not** emailed at submit.

**Resp:** `{success:true, message:'Đề nghị mua hàng đã được gửi thành công.', prNo}`. The page reads `result.prNo` (`purchase_request.html:3347`) and falls back to its own number.

### 3.2 `getPurchaseRequestHistory`: list (3098-3132)

**R:** `requesterName` (optional; exact case-insensitive match on col E). No caller sends it. **Caller identity is not read.**

**S:** standardises the headers, may run the daily archive sweep (§1.6).

**Resp:** `{success, message:'Thành công', requests:[card…]}`, sorted by `submittedAt` string, newest first. Empty sheet → `requests:[]`. A card (`prListCardFromRow_` 2231-2278) has exactly these keys:

`prNo, company, department, requesterName, requesterEmail, requestorEmail, requiredDate, priority, purpose, suggestedVendor, grandTotal, status, submittedAt, budgetApprover, supplierApprover, contractApprover, purchasingApprover, budgetApproverEmail, supplierApproverEmail, contractApproverEmail, purchasingApproverEmail, budgetStatus, supplierStatus, contractStatus, purchasingStatus, activeStage, purchaseType, p2pBranch, hasAttachments`

- For **terminal** rows the metadata is not parsed. So `requesterEmail`, `requestorEmail` and all `*Status` are `''`, `purchaseType` defaults to `'goods'`, `p2pBranch` to `'full'`, and `activeStage` is `'complete'` or `'rejected'` (bug B5: the branch of a finished simplified PR is reported as `full`).
- Non-terminal: `activeStage` ∈ `parallel|purchasing|complete` from `computePRApprovalState_`. It is **not** `returned` for `Trả lại bổ sung`; the server reports the underlying stage. The page's own `_computePRStage` returns `returned`.
- `submittedAt` = `prTimeKey_(col P)` (ISO text or Date → ISO).
- `grandTotal` is the raw cell (number).
- No `items`, `metadata`, `budgetCode`, `attachmentUrls`.

Callers read `result.data?.requests || result.requests` (`purchase_request.html:4479`, `contract.html:199`, `acceptance_minutes.html:1089, 1265`). `acceptance_minutes.html:1277-1290` still expects `pr.items` on cards, which have not had items since `38c55fb` (bug B7).

### 3.3 `getPurchaseRequest`: one PR (2479-2486)

**R:** `prNo`, `submittedAt` (optional; when present it must match exactly). **V:** empty `prNo` → `Thiếu số phiếu mua hàng.`; not found → `Không tìm thấy đề nghị: <prNo>`.
**Resp:** `{success, message:'Thành công', request:{…card…, items:<JSON string>, metadata:<JSON string>, attachmentUrls, budgetCode}}` (`prFullFromRow_` 2280-2298). `requesterEmail` is filled from metadata even for terminal rows. **`items` and `metadata` are strings**; the page `JSON.parse`s them (`purchase_request.html:4664-4667`). Reads both sheets. The page reads `result.request || result.data?.request` (4602).

### 3.4 `searchPurchaseRequests` (2488-2533)

**R:** `q` or `query`. Fewer than 2 characters after trim → `{success:true, requests:[]}`.
**Logic:** a case-insensitive *substring* `TextFinder` over cols A (no), B (company), E (requester), H (purpose), in that order. It searches the **archive first, then the working sheet**, up to 30 hits per sheet and at most 40 finder steps per column. Event rows are skipped. Results are deduped by `prNo|submittedAt` and capped at 30 cards. **Not sorted.** No identity check.
**Resp:** `{success, message:'Thành công', requests:[card…]}` (same card as 3.2). The page merges them into the list while a search is typed (`purchase_request.html:4254-4277`).

### 3.5 `approvePurchaseRequest` (3261-3405)

**R:** `prNo, approverEmail, approverRole ('budget'|'supplier'|'contract'|'purchasing'), note, submittedAt, approverSignature (data URL), signatureVerification (JSON string)`. The page sends `note:''` and requires a signature in the browser (`purchase_request.html:4993-5034`).

**V (in order):**
1. `prNo` empty → `Thiếu số phiếu mua hàng.`
2. `approverEmail` empty → `Thiếu email người duyệt.`
3. bad role → `Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".`
4. sheet missing → `Không tìm thấy sheet Purchase_Request_History.`
5. not found (using `submittedAt`) → `Không tìm thấy đề nghị: <prNo>`
6. status `Đã từ chối`/`Rejected` → `Đề nghị này đã bị từ chối, không thể duyệt.`
7. `Hoàn thành`/`Approved` → `Đề nghị này đã được duyệt rồi.`
8. `Trả lại bổ sung` → `Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.`
9. role column empty → `Vai trò "<role>" chưa được phân công cho đề nghị này.`
10. email ≠ role column → `Bạn không được phân công là người duyệt "<role>" cho đề nghị này.`
11. role's stage ≠ active stage → `Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: <duyệt ngân sách & NCC | thẩm định hợp đồng | mua hàng | complete>.` (hard-coded Vietnamese, 3319-3323)
12. role already Approved → `Bạn đã duyệt đề nghị này rồi.`
13. exception → `Lỗi: <msg>`

There is **no lock** (two parallel approvals at the same moment can overwrite each other's metadata cell).

**S:** sets the metadata (1.4). Recomputes the state, writes col O and col Q, flushes. Audit `Approve` / role / actorName `''` / prev / new / note / extra `{signatureUploaded:true, verification:<raw string>|null}` only when a signature was sent, else no extra. Then emails, failures ignored:
- `stateAfter=contract` after `parallel`: contract stage email (unreachable).
- `stateAfter=purchasing` **and** (`before=contract` **or** (`before=parallel` **and branch `full`**)): `sendPurchaseRequestStageEmail_(…,'purchasing')` (3046-3075). Subject `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - <prNo>`. Body: "Giai đoạn **Mua hàng** của Đề nghị mua hàng đã mở và đang chờ xử lý của bạn." plus the same 6-row table. **On `simplified` PRs the purchasing approver is never emailed** (bug B2; 11 live simplified PRs sit at `Mua hàng (5/5)`).
- `stateAfter=complete`: to `metadata.requesterEmail`, subject `[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - <prNo>`. Body: "Đề nghị mua hàng **<no>** của bạn đã được **phê duyệt hoàn tất**." plus "Công ty: …".

**Resp:** `{success, message:'Đã duyệt thành công.', prNo, status}`. The page reads `result.data?.status` (5040), which is undefined with GAS, so the page keeps the old status and only recomputes `activeStage` locally.

### 3.6 `rejectPurchaseRequest` (3409-3490)

**R:** `prNo, approverEmail, note, submittedAt`. No role is sent. **The reason is not required on the server**; the page's modal does not require it either.

**V (in order; permission is checked before status):**
1. `Thiếu số phiếu mua hàng.`
2. `Thiếu email người từ chối.`
3. sheet missing
4. not found → `Không tìm thấy đề nghị: <prNo>`
5. email not in {K, L, R, S} → `Bạn không có quyền từ chối đề nghị này.` The email→role map is built in the order budget, supplier, contract, purchasing, so **a later role wins when one email holds several roles** (3436-3440).
6. that role's stage is not active → `Chưa đến lượt của bạn trong quy trình phê duyệt.`
7. `Đã từ chối`/`Rejected` → `Đề nghị này đã bị từ chối rồi.`
8. `Hoàn thành`/`Approved` → `Đề nghị đã được duyệt, không thể từ chối.`
9. `Trả lại bổ sung` → `Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.`

Edge case: if the same person is budget **and** purchasing, the map says `purchasing`. During the parallel stage they get `notYourTurn` and cannot reject as budget.

**S:** `rejectedAt/By/Note`, status `Đã từ chối`, flush, audit `Reject`/role/prev/new/note (no extra). **No email.**
**Resp:** `{success, message:'Đã từ chối thành công.', prNo, status:'Đã từ chối'}`.

### 3.7 `sendBackPurchaseRequest` (3500-3630)

**R:** `prNo, approverEmail, approverRole, targetStep (1|2|3), sentBackNote, submittedAt`.

**V (in order):**
1. `Thiếu số phiếu mua hàng.`
2. `Thiếu email người thực hiện.`
3. empty note → `Vui lòng nhập lý do trả lại.`
4. `targetStep` not 1–3 → `Bước trả lại không hợp lệ.`
5. bad role → `Vai trò không hợp lệ.`
6. sheet missing
7. not found
8. rejected → `Đề nghị này đã bị từ chối.`
9. complete → `Đề nghị này đã hoàn thành.`
10. returned → `Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.`
11. role stage ≠ active → `Chưa đến lượt của bạn trong quy trình phê duyệt.`
12. email ≠ role column → `Bạn không được phân công vai trò "<role>" cho đề nghị này.`
13. target > max for role → `Bước trả lại không hợp lệ với vai trò của bạn.`

Note: the turn check (11) comes **before** the assignment check (12). Approve does the reverse.

**S:** the status and resets from §2.4. Push `{targetStep, by, byRole, at, note}`. Write cols O and Q. Audit `Return`/role/prev/new/note/extra `{targetStep}`. Email (`sendPurchaseRequestSendBackEmail_` 3841-3914). All share a table (Số phiếu, Công ty, Người đề nghị, Mục đích, Tổng cộng) and a yellow box "**Lý do trả lại:**<br><note>". `senderRoleLabel` is one of `Người duyệt Ngân sách`, `Người duyệt NCC`, `Người thẩm định Hợp đồng`, `Người mua hàng`.
- step 1 → requester: `[ĐỀ NGHỊ MUA HÀNG] Phiếu được trả lại để bổ sung - <prNo>`. Body asks them to open the request and choose **"Chỉnh sửa & Gửi lại"**.
- step 2 → budget and supplier, one each even when they are the same address: `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Ngân sách & NCC - <prNo>`.
- step 3 → contract approver (col R): `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Thẩm định Hợp đồng - <prNo>`. That person cannot act in the PR (bug B3).

**Resp:** `{success, message:'Đã trả lại thành công.', prNo, status}`. The page reads `result.data?.status || (targetStep===1 ? 'Trả lại bổ sung' : '')` (5182-5185).

### 3.8 `resubmitPurchaseRequest` (3638-3831)

**R:** same fields as submit, plus `prNo` (the returned PR), `requesterEmail` (required), `submittedAt`, and `attachments`, where `{fileName,fileUrl}` without `fileData` keeps an existing file.

**V (in order):**
1. `Thiếu số phiếu mua hàng.`
2. `Thiếu email người đề nghị.`
3. then the submit validations 1–8 (same messages)
4. sheet missing
5. not found → `Không tìm thấy đề nghị: <prNo>`
6. status ≠ `Trả lại bổ sung` → `Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".`
7. stored `requesterEmail` present and ≠ sent (lower-cased) → `Bạn không phải người đề nghị ban đầu của phiếu này.`

**S:** uploads new files to the same Drive folder. Not inside a try/catch for the folder, but the whole attachment block is inside one, so errors are ignored. Rebuilds metadata (3749-3776). **Overwrites cols A–T in place** (3780-3801): status → `Đang duyệt ngân sách & NCC (2/5)`, col P = original `submittedAt`, branch and approvers re-read from the form, all approvals cleared (signatures, `rejected*`, `previousPrNo`, `contract*` dropped). Audit `Resubmit`/`requester`/note `Gửi lại lần N`. Email (`sendPurchaseRequestResubmitEmails_` 4426-4468) to budget and supplier: subject `[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - <prNo>`, 6-row table and attachments.
**Resp:** `{success, message:'Đã gửi lại đề nghị thành công.', prNo}`.

> **Bug B1 (blocking): resubmit cannot succeed from the page.** `submitForm()` always sends `submittedAt: new Date().toISOString()` (`purchase_request.html:3305`), including in resubmit mode. `findPRSubmitLocation_` then demands an exact match with col P, finds nothing, and returns `Không tìm thấy đề nghị: <prNo>`. A PR sent back to step 1 therefore stays in `Trả lại bổ sung` for good. (Before `38c55fb` the lookup ignored `submittedAt`.) There are no `Trả lại bổ sung` rows live.

### 3.9 `getGoodsCatalog` (1844-1866)

**R:** none. Reads the `Goods-KTT` sheet. Row 1 = headers; each later row becomes an object keyed by the **raw header text**. Rows whose first column is empty are dropped. No filtering by status.
**Resp:** `{success:true, message:'Goods catalog fetched successfully', goods:[{<header>:<cell>}…]}`. Missing sheet → `{success:true, message:'Goods-KTT sheet not found', goods:[]}`. Error → `Lỗi: <msg>`.
Callers (`purchase_request.html:3461-3482, 3778-3800`) read `(j.data || j).goods`, but only as a fallback when `getMasterData` (now Postgres) returned no `goods`. The page uses the headers `Items, Category, Min. Order, Unit, Unit Price|Price|Đơn giá|Giá bán, Specificaton|Specification, CUKCUK/QBO Code, Status` (3524-3545).

### 3.10 `getPurchaseOrderTypes` (1790-1838; also available by GET, 488-489)

Reads the `Purchase Order` sheet: col A `No`, col B `Type`. Rows with an empty B are skipped.
**Resp:** `{success, message:'Thành công', types:[{no, type}]}`. Missing sheet → `Sheet "Purchase Order" không tồn tại`. **No caller in any page.**

### 3.11 `addSupplier` (1643-1720)

**R:** `name, address, phone, email, taxCode, companyType`.
**V:** empty name → `Supplier name is required`; missing sheet → `Sheet "Nhà cung cấp" not found`; duplicate of col C (trimmed, case-insensitive) → `Supplier "<name>" already exists` (English in both languages).
**S:** appends a 25-column row to `Nhà cung cấp`. ID = `'VD' + String(lastRow).padStart(3,'0')`, which can repeat after deletions. B = name truncated to 50 characters, F = `companyType||'Others'`, K = `VND`, Y = `Yes`; the other columns are as given or empty.
**Resp:** `{success, message:'Supplier added successfully', supplierId, name}`. **No caller in any page.** `getSuppliers` reads `Master Vendor` (1550), so suppliers added here never appear in the vendor picker.

### 3.12 `validatePRForDirectPayment` (4526-4566)

**R:** `prNo`.
**V:**
- empty → `Thiếu số PR.`
- not found (both sheets) → `Không tìm thấy PR: <no>`
- status ≠ `Hoàn thành` → `PR chưa được phê duyệt hoàn tất.`
- branch ≠ `simplified` → `PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.`
- any payment request on `Payment_Request_History` with `pr_no` = this one and status not `Rejected`/`Từ chối` → `Đã tồn tại đề nghị thanh toán cho PR này.`

Literal strings, not `msg_`.
**Resp:** `{success:true, message:'OK', prNo, vendorName, department, grandTotal, requesterName, purchaseType, p2pBranch}`. `vendorName` reads `metadata.vendorDetails.vendorName`, which is never stored, so it always falls back to col I (bug B9).
**Callers:** none in the pages. It is used inside `sendPaymentRequest` when `prRequestNo` is sent without `amNo` (608). `payment_request.html:1831` sends `prRequestNo` only in AM mode, so that path cannot be reached from the UI.

### 3.13 `getP2PHistory` (4765-4813)

**R:** `docNo, flow`. For `flow==='PR'`: empty docNo → `Invalid docNo or flow.`; otherwise `prHistoryFromAuditLog_(docNo)` (2427-2477). It collects `PR_Audit_Log` rows with col A exactly equal to docNo (case-sensitive), at most 200, in sheet order. **Only if there are none**, it falls back to event rows on the working sheet and the archive (2455-2475).
**Resp:** `{success, message:'OK', history:[{action, role, actorEmail, actorName, prevStatus, newStatus, timestamp (ISO), note, metaJson}]}`. Other flows (PMT/AM/CT) read event rows from their own sheets.
**Caller:** `purchase_request.html:4636-4644` posts **multipart FormData** `data={"action":"getP2PHistory","docNo","flow":"PR"}`, reads `json.history`, and sorts by `timestamp` ascending. The drawer labels actions `Approve/Reject/Return/Submit/Resubmit/AmendmentApproved` and roles `budget/supplier/contract/purchasing/requester/deptHead` (4887-4893). `ContractApproved_PRUpdated` shows as its raw name.

### 3.14 Cross-workflow: `getPaymentProgressByPR` (4568-4605)

**R:** `prNo`. **V:** `Thiếu số PR.`; not found → `Không tìm thấy PR: <no>`.
Ceiling = value of the **last** contract in `Đã ký`/`Có phụ lục`, else PR col N. Instalments = non-rejected payments for that PR (from `getPMTsByPR_` 4490: `requestId, amount, status, amNo, installmentNo, installmentNote, submittedAt`).
**Resp:** top-level `{prNo, grandTotal, installments, paidTotal, remaining}`. **`payment_request.html:2054-2061` reads `result.data`**, which is undefined with GAS, so the progress panel shows but stays empty (bug B8). The Postgres port should return both shapes.

---

## 4. Visibility

| Surface | GAS rule | Page rule |
|---|---|---|
| List (`getPurchaseRequestHistory`) | **Everyone gets every PR of every company** (5,000-row window plus older open ones). Only the unused `requesterName` filter exists. No login check (the proxy forwards the request without auth) | Stats pills count the whole list. The **"Việc của tôi"** toggle (`_isMyPRTask` 4543-4574) and the bell badge (`_pendingPRItems` 4370-4395) show: `Trả lại bổ sung` → the requester (metadata email); parallel → budget or supplier whose status ≠ Approved; contract → col R; purchasing → col S; never terminal ones. "Me" = `localStorage.tlc_current_user.email` |
| Search | Every PR, archive included | merged into the list while typing |
| Detail (`getPurchaseRequest`) | Any PR by number, **including base64 signatures and vendor bank accounts** | Drawer action buttons appear only for the user whose role is active (4904-4916). Resubmit button only for the requester (4744-4754). "Tạo Biên Bản Nghiệm Thu" only on `Hoàn thành` |
| History | Any PR | — |
| index.html | The P2P panel (`index.html:3057-3200`) is a **static mock** (`approveStep('p2p-pr', n)`); it reads no PR data | — |
| Admin | No admin concept in PR GAS | none |

---

## 5. GAS gaps and bugs not to copy (each flagged)

### Security

| # | Issue | Where |
|---|---|---|
| S1 | **Identity comes from the request body.** `approverEmail` / `requesterEmail` decide who may approve, reject, send back or resubmit. Anyone who can POST can act as anyone. The pages already send `Authorization: Bearer <token>` (`i18n.js:766-783`); the port must use `callerFromRequest` (`api/lib/auth-caller.js`) and ignore body emails | 3264, 3411, 3503, 3640 |
| S2 | No authentication on reads. Every PR, with signatures, bank accounts and Drive links, is readable by anyone | 2479, 2514, 3098 |
| S3 | Approvers are whatever emails the requester sends. The server never checks them against company roles or the Kế Toán Chi list, so a requester can name themselves as budget, supplier and purchasing and approve their own PR | 2758-2761 |
| S4 | `grandTotal` and the branch are trusted from the client. Sending a goods `grandTotal < 2,000,000` skips the contract (full) branch whatever the items add up to | 2752, 2776 |
| S5 | Signature "verification" happens in the browser (`purchase_request.html:5000-5023`). The server stores whatever it receives | 3335-3344 |
| S6 | Drive attachments are shared `ANYONE_WITH_LINK` | 2837, 3723 |
| S7 | Emails build HTML from user text without escaping (purpose, names, notes, file names): HTML injection into approvers' mailboxes | 2972-3040, 3841-3914, 4426-4468 |
| S8 | `addSupplier` is an unauthenticated write to master data | 1643 |
| S9 | `submittedAt` (col P) is the client's clock. The archive uses it for ageing and the lookup uses it as an identity key | 2798 |
| S10 | Emails contain no links, so there are no signed links to worry about. If the port adds deep links (Q7), make them plain app URLs that require login. Do not put approve/reject tokens in links | — |

### Functional bugs

| # | Bug | Where |
|---|---|---|
| B1 | Resubmit always fails: new client `submittedAt` vs exact match | `purchase_request.html:3305` + 2224-2228 |
| B2 | Purchasing approver is not emailed on the `simplified` branch | 3381-3389 |
| B3 | Send back to step 3 writes `Thẩm định Hợp đồng (4/5)` although the PR has no contract stage. The real stage is purchasing, and the email goes to the contract reviewer, who cannot act | 3576-3578, 3902-3913 |
| B4 | The `contract` role can never approve, reject or send back (its stage is never active), yet the page offers send-back targets up to 2 for it | 3161 |
| B5 | List cards for terminal rows have empty `requesterEmail` and `*Status`, and `p2pBranch` defaults to `full` | 2235-2240, 2276 |
| B6 | AM creation checks only the working sheet, so it fails for archived PRs | 4030-4044 |
| B7 | `acceptance_minutes.html` reads `pr.items` from list cards, which have none, so the AM item table is empty | `acceptance_minutes.html:1277` |
| B8 | `payment_request.html` reads `result.data` for `getPaymentProgressByPR`; approve and send back read `result.data?.status`. GAS returns them at top level | `payment_request.html:2054`, `purchase_request.html:5040, 5183` |
| B9 | `validatePRForDirectPayment.vendorName` reads a key that is never written | 4550 |
| B10 | Attachments go to the folder of the pre-lock number; the lock may assign another number | 2791-2833 vs 2902-2906 |
| B11 | Approve has no lock: two parallel approvals (budget and supplier at once) can lose one metadata write | 3261-3352 |
| B12 | The same person in budget and supplier must approve twice and gets two copies of every email | 3005-3013, 4456 |
| B13 | Reject sends no email to the requester | 3409-3490 |
| B14 | `addSupplier` writes to `Nhà cung cấp`, but the picker reads `Master Vendor` | 1655 vs 1550 |
| B15 | `validatePRForDirectPayment` cannot be reached from the UI | `payment_request.html:1831` |
| B16 | Response messages for the full-branch rule and the turn check are hard-coded Vietnamese (not `msg_`) | 2779, 3321 |

---

## 6. Existing Postgres attempt vs this spec

Files: `api/handlers/purchase-request.js` (502 lines), `api/lib/pr-approval-state.js` (55), DDL `db/schema.sql:129-183`, routing `api/router.js:53-57, 89`.

### 6.1 Coverage

Only 5 of the 13 actions exist: `purchaseRequest, approvePurchaseRequest, rejectPurchaseRequest, getPurchaseRequestHistory, getPurchaseRequest`. **This is the biggest parity risk.** Setting `PG_WORKFLOWS=p2p` moves only those five. `sendBack`, `resubmit`, `search`, `getP2PHistory`, `validatePRForDirectPayment`, `getPaymentProgressByPR`, and all of contract, AM and payment would keep running on GAS against a sheet that no longer receives new PRs (split brain). The file header (line 1) claims send-back, but there is none.

### 6.2 Per action

| Action | Matches? | Differences (file:line in `api/handlers/purchase-request.js` unless noted) |
|---|---|---|
| `computePRApprovalState` (`api/lib/pr-approval-state.js:10-46`) | Yes, line for line | Reads branch from `metadata.p2pBranch || pr.p2p_branch` (fine) |
| `computeP2PBranch` (`pr-approval-state.js:51-55`) | Yes | — |
| submit | **No** | (a) Missing `requiredDate` check (27-30); messages differ from GAS (`Thiếu người đề nghị` vs `Thiếu tên người đề nghị.`, `Thiếu người duyệt ngân sách`, `Cần ít nhất 1 hàng hóa`, no trailing dots). Errors use HTTP 400 (GAS always 200 + `success:false`). (b) **Attachments are not uploaded.** The raw `[{fileName,fileData(base64)}]` is stored in both `attachments` and `metadata.attachments` (38-40, 63, 105). The page then shows links with no `fileUrl`, and rows hold megabytes of base64. (c) **Number allocation is wrong** (410-434): the prefix is `companyCode.toUpperCase()`, and the page sends `companyCode` = the select value (`CÔNG TY TNHH EGG VENTURES (E.V)`), so a taken number becomes `CÔNG TY TNHH EGG VENTURES (E.V)-PR…`. The date is UTC (`toISOString`), not Vietnam time. The sequence starts at 1 and ignores existing numbers and the client's tail, so it can hit the `UNIQUE` constraint → 500. GAS increments the requested tail (2188-2198). (d) `vendor_name` and `budget_code` are never inserted (88-106), so `suggestedVendor` is lost. (e) `submitted_at` = DB `NOW()`; GAS = client value; `metadata.submittedAt` = Node time (61). (f) `requesterEmail` comes from the body (S1). (g) Response `{success, message:'Đề nghị mua hàng đã được gửi thành công', data:{prNo,id}}`: the page reads `result.prNo` (`purchase_request.html:3347`), so a reassigned number is shown wrong. GAS message has a trailing `.`. (h) Emails: body differs (no Ngày cần hàng, no attachments, no `Người phê duyệt đã được thông báo qua email…`). One email per approver even when both are the same person (same as GAS). Builders at 471-495 do not escape HTML (S7). (i) No `currency` in GAS; Postgres stores `currency`, which is harmless |
| approve | Partly | (a) Identity from body (151), S1. (b) Messages differ: `Thiếu số PR hoặc email`, `Không tìm thấy PR` (vs `Không tìm thấy đề nghị: <no>`), `Đã bị từ chối`, `Đã hoàn thành`, `Đang trả lại bổ sung`, `Vai trò … chưa được phân công`, the turn message drops "của bạn" and the trailing `.` (154-195). (c) `signatureVerification` is stored as a string, not parsed (203). Audit extra is `{signatureUploaded}` without `verification` (217). (d) Purchasing stage email goes on **both** branches (223-228), which fixes B2 but is not parity. Body is one line instead of the GAS template. (e) Has `FOR UPDATE` (fixes B11). (f) Response `{data:{prNo,status,stage}}` without top-level `prNo,status`. The page reads `data.status`, which works. (g) `submittedAt` ignored (fine) |
| reject | Partly | Same check order as GAS. Status check lumps 3 statuses into one `Không thể từ chối` and **omits `Rejected`/`Approved`** legacy values (286). Sends a rejection email to the requester (306-310); GAS does not. Response lacks `prNo,status` (314). Identity from body (257) |
| `getPurchaseRequestHistory` | **No** | Returns only `prNo, company, requester (not requesterName), purpose, grandTotal, currency, status, submittedAt` (341-350). Missing `requesterName, requesterEmail, department, requiredDate, priority, suggestedVendor`, all approver emails, all `*Status`, `activeStage, purchaseType, p2pBranch, hasAttachments`. That breaks the drawer, "Việc của tôi", the badge, and the `contract.html` / `acceptance_minutes.html` filters (`p2pBranch`, `suggestedVendor`). No requester filter. No window rule for old open PRs. `submittedAt` is a Date object. The archive uses `updated_at` and excludes legacy `Approved`/`Rejected` (459-464); GAS uses the last-activity stamps |
| `getPurchaseRequest` | **No** | Returns `{data:{…}}`; the page reads `result.request || result.data?.request`, gets null and falls back to the slim card. `items`/`metadata` are JSONB objects, but the page `JSON.parse`s strings (4664-4667), so a string or stringify is needed. Uses `company` but not `suggestedVendor` (`vendorName` instead), no `attachmentUrls`, no `activeStage`, no card fields. Reads `req.body || req.query`: after `unwrapPayload` the body is always an object, so this works. Not-found message differs |
| search, sendBack, resubmit, getP2PHistory, getGoodsCatalog, getPurchaseOrderTypes, addSupplier, validatePRForDirectPayment, getPaymentProgressByPR | **Missing** | — |

### 6.3 Schema (`db/schema.sql:129-183`)

| Gap | Recommendation |
|---|---|
| No `vendor_name` writes; column exists | Write `vendorName || suggestedVendor` |
| `attachments` JSONB duplicates `metadata.attachments` and holds base64 | Store `{fileName, fileUrl or R2 key}` only. Upload via the R2 path vouchers use, or Drive (Q9). `attachment_urls` can be derived |
| `submitted_at TIMESTAMPTZ` | Fine, but import GAS col P as is (ISO text). The GAS identity was `(pr_no, submitted_at)`. Imports must keep the 3 renamed numbers |
| `required_date TEXT` | Keep text (live values are `YYYY-MM-DD`, archive has `M/D/YYYY`); normalise on import |
| No columns for `resubmit_count`, `sent_back_history`, `rejected_*`, approvals | Fine inside `metadata` JSONB. For engine reuse, add `metadata.approvalPlan` plus `pending_emails TEXT[]` / `approver_emails TEXT[]` with GIN indexes like `vouchers` (migration 005) so "my tasks" is an index lookup |
| `pr_number_sequences` keyed by `company_code` | Key by the cleaned code prefix (`EV`, `TL`, …) and the **Asia/Ho_Chi_Minh** date. On conflict, increment past the client's tail and past existing numbers (GAS rule) |
| `pr_audit_log` | Columns match GAS (doc_no/company/created_at/extra). Add an index on `(doc_no, created_at)`; there is one on `doc_no` |
| No archive table | `archived_at` is enough. Keep search covering archived rows and lists excluding them |
| `idx_pr_active` partial index uses Vietnamese literals | OK, but include `Approved`/`Rejected` |
| No `company_id` for most rows if `company_name` does not exactly match `companies.company_name` (82-85) | Resolve by `company_key` first |
| No imported event rows | Import `PR_Audit_Log` (80 rows), plus event rows only for PRs without audit rows (`EV-PR20260528000001`, `IN-PR20260615000001` have none, and they have no event rows either) |

### 6.4 Mapping the GAS chain onto the approval engine (`api/lib/approval/*`)

| GAS behaviour | Engine today | Fit |
|---|---|---|
| Approvers picked **per PR by the requester** from 3 company roles (legal_rep, chief_accountant, treasurer) and the `Kế Toán Chi` employees | Plan resolved from an admin-saved flow per company (`buildPlan` engine.js:62-90). Approvers are `role` (resolved from Master Company via `roles.js`) or fixed `person` | Partial. Either (a) build the plan at submit from the form's emails as `person` approvers (keeps GAS behaviour, but keeps S3 unless the server checks the emails against `companyRoles()` plus the Kế Toán Chi list), or (b) move to admin-configured flows (`legal_rep`/`chief_accountant`/`treasurer` roles; "purchasing" needs a new role or a person). Product decision Q4 |
| Step 1 is a parallel group: budget and supplier, all must approve | A step with several approvers, all must approve (engine.js:116-128) | Yes |
| **Same email in two slots needs two approvals** | `applyApproval` approves every entry of `mine` in one call (engine.js:120-122), and `validateSteps` rejects duplicate *role* keys but allows two `person` entries only if the emails differ | Behaviour differs. GAS needs the slot (`approverRole`). The engine needs a slot or label key per approver, or accept "one click" (Q3) |
| Purchasing optional; empty step skipped | `validateSteps` refuses empty steps; `buildPlan` reports unfilled roles as `problems` | Leave the step out of the plan when there is no purchasing approver |
| Contract approver stored but not a PR step | — | Keep it as a PR field (`contract_approver_email`), outside the plan; the Contract module reads it |
| Branch by type/amount (≥ 2,000,000₫ or services) | No conditions | Not needed for the approver chain (the branch only changes the required fields). If future flows vary by amount, the engine needs conditions |
| Reject only by the active stage's approvers | `applyRejection` default `anyApprover=false` | Yes |
| **Send back** to step 1 (requester), 2 (reset all), 3 (reset contract+purchasing); max target per role | Not supported | Needs a new engine operation `applyReturn(plan, email, toStep)` and a `returned` plan status. Step 3 should be dropped or redefined (B3) |
| Resubmit resets the whole chain, keeps history, may change approvers and branch | Not supported | Rebuild the plan at resubmit and keep `sentBackHistory` |
| Status strings `… (2/5)`, `Mua hàng (5/5)`, `Hoàn thành` | Engine is status-agnostic (`progress()` gives `done/total`) | Map plan → GAS status labels exactly; downstream compares `status === 'Hoàn thành'` |
| `DEFAULT_STEPS` | Has only `voucher`; `getActiveFlow` throws for other workflows (flows-repo.js:24) | Add a `purchase_request` default or build plans directly |

---

## 7. Data facts from the export (2026-10-06)

| Fact | Value |
|---|---|
| `Purchase_Request_History` rows | 109 data rows (the CSV is 112 lines because of quoted newlines): **32 `submit`**, **77 `event`** (32 Submit, 24 Approve budget, 21 Approve supplier) |
| Distinct PR numbers (working) | 32, no duplicate submit rows left. 3 rows carry `previousPrNo` |
| Status (working) | `Mua hàng (5/5)` 21 (11 simplified, 10 full); `Đang duyệt ngân sách & NCC (2/5)` 11 (budget+supplier Pending 8, budget Approved/supplier Pending 3). **0** `Hoàn thành`, `Đã từ chối`, `Trả lại bổ sung` |
| Archive | 2 rows: `EV-PR20260528000001` `Đã từ chối`, `IN-PR20260615000001` `Hoàn thành`. Old metadata format (no `requesterEmail/purchaseType/p2pBranch/contractStatus`), `required_date` as `5/28/2026` |
| Branch / type | goods+full 15, goods+simplified 15, services+full 2 |
| Priority | `Bình Thường` 21, `Gấp` 11 |
| Companies (key) | E.V_205 NTP 16, E.V 5, TLC 4, E.V_KTT_Trạm 3, INS 2, W.S 1, M.I 1 (5 legal entities) |
| Number prefixes | `EV` 24, `TL` 4, `IN` 2, `MI` 1, `WS` 1. Dates 2026-08-05 … 2026-10-05 |
| Approvers | budget = supplier = `linh.le@tl-c.com.vn` on all 32. Purchasing `Tlc.ap@tl-c.com.vn` (mixed case) on all 32. Contract: empty 15, linh.le 11, anh.le 3, `nguyennhanh863@gmail.com` 3 (a personal Gmail) |
| Items | 316 lines: `hang-hoa` 313, `dich-vu` 2, `thiet-bi` 1. All numeric fields are strings; 3 prices have leading zeros. Σ item totals = grand_total on all 32 |
| Attachments | 1 file 23 PRs, 2 files 5, 5 files 1, none 3 |
| Signatures | requester data URL on all 32. Approver signatures on 24 (budget) and 21 (supplier). Verification similarity 99.6/89.1 or `no_sample` |
| `submitted_at` | ISO-8601 UTC text, always equal to `metadata.submittedAt` |
| `PR_Audit_Log` | 80 rows: Submit 34, Approve 46 (budget 24, supplier 22); 35 document numbers. 3 numbers have audit rows but no sheet row (`EV-PR20260528000002`, `EV-PR20260922000003`, `EV-PR20260925000002`, apparently deleted by hand). 2 archived PRs have no audit rows (older than the audit log, which starts 2026-06-30). Event rows exactly match audit rows otherwise |
| Live-vs-HEAD | Event rows still written on 2026-10-04/05, after HEAD removed event writes (see banner at top) |
| `DNMH.csv` | **Not the GAS PR workflow.** A legacy purchase-order register exported from an earlier tool (`_id` keys like `PkCKxM1Uram3`): 1,107 rows, columns `Status` (Completed 923, Rejected 83, Withdrawn 79, Inprogress/InProgress 22), `PO Request No` (`PO2019-…` to `PO2025-1101`, unique), vendor, `Total Budget VND` (with and without VAT; they differ on 178 rows), company (8 entities, mostly M.I/E.V/INS/TLC/WS), `Signed Date` (889 empty), `Contract No` (143 filled), `Name`, `Final Vendor Type`. No code references it |

---

## 8. Open questions for the product owner

1. **Which GAS version is live?** The live sheet shows event rows written after HEAD stopped writing them. Should parity target HEAD or the deployed script? (Get the deployed script version from the Apps Script project.)
2. **Visibility.** GAS shows every PR of every company to anyone. Keep that, or limit to requester + assigned approvers (+ admins / same company)?
3. **Same person as budget and supplier** (all live PRs): keep two separate approvals and two emails, or one approval that covers both slots?
4. **Who picks approvers.** Keep "requester picks from the company's legal rep / chief accountant / treasurer, purchasing from Kế Toán Chi" (server should then check the choice), or switch to admin-configured per-company flows in the approval engine?
5. **Contract reviewer and send back to step 3.** The PR has no contract stage, but the full branch requires a contract reviewer (used by the Contract module), and "send back to step 3" produces a mislabelled status. Drop step 3 (purchasing can send back to 1 or 2 only)?
6. **Bugs: replicate or fix?** Specifically B1 (resubmit broken), B2 (no purchasing email on simplified), B13 (no rejection email), B6/B7 (AM vs archive and items). Recommendation: fix all four.
7. **Emails.** Add a deep link to the PR in the app (GAS has none), and keep emails Vietnamese-only?
8. **Purchasing stage in practice.** 21 PRs wait on `Tlc.ap@tl-c.com.vn` at `Mua hàng (5/5)` and none has ever completed in the new system. Is the purchasing step meant to be approved in this app, or is it done elsewhere (in which case should it be optional or off by default)?
9. **Attachments storage.** Drive (as GAS, public links) or R2 like vouchers?
10. **Legacy data.** Import `DNMH.csv` (1,107 old POs) for search and reference, or leave it out? Keep the 3 audit-only numbers of deleted PRs?
