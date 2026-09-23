# Cash Book — Bảng kiểm kê quỹ

**Date:** 2026-09-23
**Status:** Revised after challenge — awaiting spec review
**Scope:** A new page that shows one company’s cash book through an end date, separates pending vouchers from the book balance, and saves a Mẫu 08a cash count.

## What this is

`cash_book.html` is a separate page. On the home page, under Cash & Vouchers, one control opens it: the Cash Book (Sổ quỹ) card, labeled **Open Cash Book**. The top Cash Book Summary strip, including the fake “Balance today: 145,000,000 ₫” and “Entries today”, is removed.

The user picks one company and one end date. That end date is the only date on the form. It is both “Số dư đến ngày” and the day, month, and year in “Hôm nay, vào … giờ … phút, ngày … tháng … năm …”. The user types the hour and minute. The day the page is opened is not printed and is not stored.

The end date may be today or any earlier day in Asia/Ho_Chi_Minh. A future end date is refused.

Print shows the Mẫu 08a-TT form first (Thông tư 99/2025/TT-BTC), then the book voucher list, then the pending list. The Google template spreadsheet is the layout reference only. This page does not write into that file.

## Who can view and save

The page uses the same signed-in user as the other workflow pages (`tlc_current_user`). Anyone who can open Cash & Vouchers can view the book and the count.

Save is allowed only when the signed-in user is an admin, or their email is one of the four representatives on the form (Đại diện kế toán, Kế toán trưởng, Thủ quỹ, Giám đốc). The button and `saveCashCount` both enforce this. Anyone else sees the form and the message “Chỉ người đại diện của công ty này mới lưu được bảng kiểm kê.”

## Page order

The screen is one column, in this order:

1. Company, then end date. The date input cannot go past today.
2. Balance strip: **Số dư theo sổ quỹ**, “Số dư đến ngày”, total Thu, total Chi, and how many book vouchers. Under that, a separate line **Phiếu chưa vào quỹ** with pending Thu, pending Chi, and the pending net. That line is not part of line I.
3. The book voucher list, 20 rows per page, newest created date first.
4. The pending voucher list, 20 rows per page, under its own heading.
5. Hour and minute, then the ten denominations. Line II and line III update as quantities change.
6. Lý do — Thừa, Lý do — Thiếu, and Kết luận, directly under line III.
7. The four representatives, one block each: role, name, signature.
8. A bar that stays at the bottom: **Lưu bảng kiểm kê** and **In**. While save is blocked, the bar names the first missing item, for example “Còn thiếu chữ ký Thủ quỹ”.

Line III is red when line I is higher than line II (thiếu) and amber when line II is higher (thừa). The matching reason field is highlighted. The text stays empty until the user writes it.

## Voucher list and book balance

Voucher_History appends a new row for every action on a voucher. `appendHistory_` writes column H as the time of that append, so an approval row does not keep the original created date. `getCashBook` reads columns A–L and N on every data row (skip MetaJSON column R) and keeps one voucher number once:

- Created date is the earliest column H for that voucher number.
- Status, type, amount, description, and company come from the latest row for that voucher number.
- Amount text uses the same parse as `appendHistory_`: dots are thousands separators, a comma is the decimal mark. A numeric cell is used as-is.

A voucher is a candidate when all of these are true:

- Company matches the selected company. Prefer Voucher_History column D (company key) when the picker has a key. Otherwise match column C to the company name.
- The created date is on or before the end date. Compare calendar dates in Asia/Ho_Chi_Minh. A voucher created on the end date counts for that whole day. There is no start cutoff. `due_date` and approval time are not used.
- Voucher number, type (Thu or Chi), and amount are all present on the latest row.

Candidates then split:

- **Book** (line I): latest status is `Received`, `Đã duyệt`, `Approved`, or `Fully Approved`.
- **Pending** (Phiếu chưa vào quỹ): latest status is `Pending`, `Đang treo`, `Chờ duyệt`, `Đang duyệt (1/3)`, or `Đang duyệt (2/3)`.
- **Out**: latest status or action is `Rejected` or `Đã từ chối`, or the latest status is empty or anything else. A voucher rejected on a later row is out, even if an earlier row was pending.

**Số dư theo sổ quỹ** is book Thu minus book Chi. Pending amounts are not in that sum and are not in line III. An empty book has a balance of 0, and the count form still opens. Pending totals still show when the book is empty.

List columns, newest created date first: voucher number, created date, Thu/Chi, description, amount, status. The created date is the earliest column H for that voucher number.

`getCashBook` returns the book lines, the book balance, the pending lines, pending Thu, and pending Chi. The browser does not download the whole sheet. The script still reads the whole history, because a recent-row window would drop older cash and make line I wrong. It does not read column R.

## Cash-count form

The form follows Mẫu 08a, sheet for VNĐ.

Fixed labels: Bộ phận **Kế toán**, Số **08**, title **BẢNG KIỂM KÊ QUỸ (Dùng cho VNĐ)**. Đơn vị is the selected company. Day, month, and year are the selected end date. Hour and minute are typed. Hour is 0–23 and minute is 0–59.

Denominations, in this order, quantity times face value:

| Line | Face value (₫) |
|------|----------------|
| 1 | 500.000 |
| 2 | 200.000 |
| 3 | 100.000 |
| 4 | 50.000 |
| 5 | 20.000 |
| 6 | 10.000 |
| 7 | 5.000 |
| 8 | 2.000 |
| 9 | 1.000 |
| 10 | 500 |

An empty quantity is 0. Quantities are whole numbers, zero or greater.

- Line I, **Số dư theo sổ quỹ**, is the live book balance. It is not typed and not frozen.
- Line II, **Số kiểm kê thực tế**, is the sum of the ten denomination amounts.
- Line III, **Chênh lệch**, is line I minus line II.

Under the table, three optional text lines print with their labels. Empty text is allowed and does not block saving:

- Lý do — Thừa
- Lý do — Thiếu
- Kết luận sau khi kiểm kê quỹ

## Representatives and signatures

After the company is chosen, four rows appear.

| Row | Role on the form | Name source |
|-----|------------------|-------------|
| 1 | Đại diện kế toán | Active employees of that company whose position is kế toán and is not kế toán trưởng. If none match, every active employee of that company |
| 2 | Kế toán trưởng | Master Company column H, Chief_Accountant_Name |
| 3 | Thủ quỹ | Master Company column L, Treasurer_Name |
| 4 | Giám đốc | Master Company column D, Legal_Representative_Name |

Rows 2–4 use `getCompanyApprovers`. Each of those rows has that one registered name, already selected. A blank master cell leaves that dropdown empty and blocks save.

Row 1 uses `getEmployees`. An employee belongs to the company when column D matches Company_Name, Company_Full_Name, or Company_Code (trimmed, case-insensitive) and status is Active. The kế toán match uses position. Department is used only when position is blank. The title matches when it contains “kế toán” or “ke toan” and does not contain “trưởng” or “chief”. The role key `accountant` is not used for this filter. In this app that key means Kế toán trưởng. If the kế toán list has one person, that person is already selected. If the list is empty, the dropdown lists every active employee of the company and nothing is preselected. The same person may hold two of the four roles.

Signatures:

- Rows 2–4 use the signature URL already on Master Company (columns F, J, and N). No new upload is required when that URL exists.
- A role with a name and no signature URL needs an upload before save.
- Row 1 always needs an upload. Master Employee has no signature column.
- One image per person. If that person holds two roles, the same URL is used on both rows.
- This page does not run the 75% similarity check.

Accepted uploads follow `.cursor/rules/signature-upload.mdc` (PNG or JPG, max 800×400, JPEG quality 0.7, white canvas fill, 500 KB after compression). A new upload goes through `uploadFilesToDrive_` into a `Cash_Count` subfolder via `/api/voucher`, not `/api/drive-upload`. The sheet stores the file URL. Voucher signatures stored as base64 in MetaJSON are not copied into this sheet.

Printed signature titles, in this order:

1. Thủ quỹ
2. Kế toán trưởng
3. Người chịu trách nhiệm kiểm kê quỹ — the đại diện kế toán from row 1
4. Giám đốc

The header “Chúng tôi gồm” lists all four names with those roles.

## Save and reopen

The screen shows one current count per company and end date. The key is the company key (company name when the key is missing) plus the end date `YYYY-MM-DD`.

Saving appends a new row with `row_status` `current`. If a current row already exists for that key, the user must confirm “Đã có bảng kiểm kê cho ngày này. Lưu sẽ giữ bản cũ và ghi bản mới.” Confirm marks the previous row `replaced` and appends the new row. Cancel leaves the sheet unchanged. Rows are not deleted. Voucher_History is not changed. This is not a voucher status change, so it does not call `_appendAuditLog_`. The replaced rows are the history.

Save is blocked, with a message that names the missing piece, when any of these is missing: company, end date, a valid hour and minute, one of the four names, or a signature for a role that has none on file. The caller must also be allowed to save. Thừa, Thiếu, and Kết luận may be blank.

Opening the same company and end date restores the current row: quantities, hour, minute, the four names, the four signature URLs, and the three text lines. Line I and the pending totals are calculated again from vouchers, so they can change if vouchers were added later.

## Where data is stored

New sheet `Cash_Count` in the Cash workbook (the same spreadsheet as Voucher_History). The Cash script creates it if it is missing. Several rows may exist per company and end date. Only one has `row_status` `current`.

| Col | Field |
|-----|--------|
| A | company_key |
| B | company_name |
| C | end_date (`YYYY-MM-DD`) |
| D | count_hour |
| E | count_minute |
| F | quantities JSON, ten integers in denomination order |
| G | book_balance at last save (display only; reopen recalculates) |
| H | counted_total at last save |
| I | reason_thua |
| J | reason_thieu |
| K | conclusion |
| L | reps JSON: four objects `{ role, name, email, signatureUrl }` in row order |
| M | saved_by_email |
| N | saved_at ISO 8601 UTC |
| O | row_status: `current` or `replaced` |

## Actions

All three new actions go to the Cash Apps Script through `/api/voucher`. They are not payment-request actions and must not be sent to the P2P script.

| Action | Does |
|--------|------|
| `getCashBook` | Company + end date → book lines, book balance, pending lines, pending Thu, pending Chi |
| `getCashCount` | Company + end date → the current row, or empty when none exists |
| `saveCashCount` | Mark the previous current row replaced, then append the new current row. Reject when the caller may not save |

`getCompanyApprovers` and `getEmployees` stay as they are.

`api/voucher.js` routes the three new actions to the Cash backend URL.

## Print

The browser print dialog prints the Mẫu 08a form first, then every book voucher, then every pending voucher under “Phiếu chưa vào quỹ”. Screen controls (company picker, date, paging, save, upload buttons) are hidden in print.

## Errors

- No company or no end date: do not call the backend.
- End date after today in Asia/Ho_Chi_Minh: do not call the backend. Tell the user the end date cannot be in the future.
- Company not on Master Company: show the backend message and do not open the count form.
- `getCashBook` or `getCashCount` fails: show the message. Do not show a zero balance as if the book were empty.
- Save fails, or the caller is not allowed to save: leave the form as the user filled it and show the message.
- A second save without confirm does not happen. Cancel leaves both the current row and the replaced rows unchanged.

## Deploy

The HTML ships with the Ubuntu app (`deploy/update.sh`). `TLCG_CASH_BACKEND.gs` is pasted only into the Cash Apps Script project, then deployed as a new version of the existing web app, Execute as: Me. It is not pasted into Core or P2P.

## Out of scope

- Writing the user’s private Google template file
- A start-date picker, or a second date for the day the page was opened
- Changing voucher status, approval, or Voucher_History
- Signature similarity check against the Master Company sample
- A separate audit-log sheet. Replaced `Cash_Count` rows are the history
