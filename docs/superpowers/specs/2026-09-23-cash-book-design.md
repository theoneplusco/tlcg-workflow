# Cash Book — Bảng kiểm kê quỹ

**Date:** 2026-09-23
**Status:** Revised after audit — awaiting spec review
**Scope:** A new page that lists one company’s vouchers from the first voucher through an end date, shows the cash-book balance, and saves a Mẫu 08a cash count.

## What this is

`cash_book.html` is a separate page. On the home page, under Cash & Vouchers, **Open Cash Book** opens it in a new tab. The user picks one company and one end date. The end date may be today or any earlier day. The open date is not picked. It is the calendar date in Asia/Ho_Chi_Minh on which the user opens the cash book, and it is the date printed on the form. It does not cut off older vouchers.

The page lists that company’s vouchers from the first voucher through the end date. Print shows the Mẫu 08a-TT cash-count form first (Thông tư 99/2025/TT-BTC), then the voucher list. The Google template spreadsheet is the layout reference only. This page does not write into that file.

## Entry

Two controls on `index.html` currently toast “Cash Book detail view will be implemented in the next phase.” Both open `cash_book.html` instead:

- The Cash Book Summary button, labeled **Open Cash Book**
- The Cash Book (Sổ quỹ) card, which opens the same page

The hardcoded “Balance today” figures on the home card stay as they are. This page does not replace that summary.

The page uses the same signed-in user as the other workflow pages (`tlc_current_user`). Anyone who can open Cash & Vouchers can open the cash book. No new role is added.

## Voucher list and book balance

The list and **Số dư theo sổ quỹ** use the same vouchers.

Voucher_History appends a new row for every action on a voucher. `appendHistory_` writes column H as the time of that append, so an approval row does not keep the original created date. `getCashBook` reads columns A–L and N on every data row (skip MetaJSON column R) and keeps one voucher number once:

- Created date is the earliest column H for that voucher number.
- Status, type, amount, description, and company come from the latest row for that voucher number.
- Amount text uses the same parse as `appendHistory_`: dots are thousands separators, a comma is the decimal mark. A numeric cell is used as-is.

A voucher is included when all of these are true:

- Company matches the selected company. Prefer Voucher_History column D (company key) when the picker has a key. Otherwise match column C to the company name.
- The created date is on or before the end date. Compare calendar dates in Asia/Ho_Chi_Minh. A voucher created on the end date counts for that whole day. There is no start cutoff. `due_date` and approval time are not used.
- The open date is the day the user opens this cash book. On a new count, that is today. On a saved count, it is the open date stored with that count, so a later visit does not change the date printed on the form. The user cannot type a different open date. An end date before the open date is allowed. That is a count for an earlier day, opened later.
- Voucher number, type (Thu or Chi), and amount are all present on the latest row. A voucher missing any of those is skipped.
- Latest status is not rejected. Rejected means status or action is `Rejected` or `Đã từ chối`. Every other non-empty status stays in. That includes pending (`Pending`, `Đang treo`, `Chờ duyệt`, `Đang duyệt (1/3)`, `Đang duyệt (2/3)`) and finished (`Approved`, `Đã duyệt`, `Fully Approved`, `Received`). An empty latest status is skipped. A voucher rejected on a later row is out, even if an earlier row was pending.

**Số dư theo sổ quỹ** is the sum of Thu amounts minus the sum of Chi amounts on that set. `voucher_type` is Thu or Chi. Amount is column I. An empty list has a balance of 0, and the count form still opens.

List columns, newest created date first: voucher number, created date, Thu/Chi, description, amount, status. The created date is the earliest column H for that voucher number.

The filter runs in the Cash Apps Script, in a new `getCashBook` action. The browser receives only the matching voucher lines and the balance. The script still reads the whole history, because a recent-row window would drop older cash and make line I wrong. It does not read column R.

## Cash-count form

The form follows Mẫu 08a, sheet for VNĐ.

Fixed labels: Bộ phận **Kế toán**, Số **08**, title **BẢNG KIỂM KÊ QUỸ (Dùng cho VNĐ)**. Đơn vị is the selected company. The line “Hôm nay, vào … giờ … phút, ngày … tháng … năm …” uses the open date for the day, month, and year. The user types the hour and minute. The page also shows “Số dư đến ngày” as the selected end date, so a count opened on 23/09 for an end date of 31/08 prints both dates. Those fields are saved.

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
- Line III, **Chênh lệch**, is line I minus line II, the same way the sample form does it.

Under the table, three optional text lines print with their labels. Empty text is allowed and does not block saving:

- Lý do — Thừa
- Lý do — Thiếu
- Kết luận sau khi kiểm kê quỹ

The sign of line III does not fill those lines.

## Representatives and signatures

After the company is chosen, four rows appear. Each row is a dropdown. The user must select a name on every row.

| Row | Role on the form | Source |
|-----|------------------|--------|
| 1 | Đại diện kế toán | Active employees of that company on Master Employee whose position or department is kế toán, and is not kế toán trưởng |
| 2 | Kế toán trưởng | Master Company column H, Chief_Accountant_Name |
| 3 | Thủ quỹ | Master Company column L, Treasurer_Name |
| 4 | Giám đốc | Master Company column D, Legal_Representative_Name |

Rows 2–4 use `getCompanyApprovers` for the selected company. Each of those rows has that one registered name.

Row 1 uses `getEmployees`. An employee is in that list when status is Active and column D matches the selected company’s Company_Name, Company_Full_Name, or Company_Code (trimmed, case-insensitive). The title match uses position. Department is used only when position is blank, so a non-accountant who sits in a kế toán department is not listed. The title matches when it contains “kế toán” or “ke toan” and does not contain “trưởng” or “chief”. The role key `accountant` is not used here. In this app that key means Kế toán trưởng, who is row 2. The same person may hold two of the four roles. Each row still needs its own signature upload.

A blank master cell or an empty kế toán list leaves that dropdown empty.

Each selected person uploads a signature on that row before the count can be saved. Accepted files, compression, and the 500 KB limit follow `.cursor/rules/signature-upload.mdc` (PNG or JPG, max 800×400, JPEG quality 0.7, white canvas fill). The uploaded image is what prints. The sample signature URL already stored on Master Company is not copied onto the form, and this page does not run the 75% similarity check. That check belongs to voucher and payment approval.

Voucher signatures are stored as base64 inside MetaJSON. A cash-count signature does not do that. Four images would overflow a sheet cell. `saveCashCount` uploads each image with the existing Cash Drive helper `uploadFilesToDrive_`, into a `Cash_Count` subfolder, and stores the file URL on the row. The upload goes through `/api/voucher`, not `/api/drive-upload`. Hour is 0–23 and minute is 0–59. Anything else blocks save.

Printed signature titles, in this order:

1. Thủ quỹ
2. Kế toán trưởng
3. Người chịu trách nhiệm kiểm kê quỹ — the đại diện kế toán from row 1
4. Giám đốc

The header “Chúng tôi gồm” lists all four names with those roles. Giám đốc is an added line. The official form’s three signature blocks stay, and Giám đốc is the fourth.

## Save and reopen

One count exists per company and end date. The key is the company key (company name when the key is missing) plus the end date `YYYY-MM-DD`. The open date is stored on that row. It is the day the count was opened, and a later visit does not replace it. It is not used when summing vouchers.

Saving writes that one row. Saving again asks “Đã có bảng kiểm kê cho ngày này. Lưu sẽ thay thế bản cũ.” and then replaces the row. Voucher_History is not changed. This is not a document status change, so it does not call `_appendAuditLog_`. The row stores who saved it and when.

Save is blocked, with a message that names the missing row, when any of these is missing: company, end date, one of the four names, one of the four signatures. Thừa, Thiếu, and Kết luận may be blank.

Opening the same company and end date restores the stored open date, quantities, hour, minute, the four names, the four signatures, and the three text lines. Line I is calculated again from the first voucher through the end date, so the difference can change if vouchers with a created date on or before that end date were added later.

## Where data is stored

New sheet `Cash_Count` in the Cash workbook (the same spreadsheet as Voucher_History). The Cash script creates it if it is missing. One row per company and end date.

| Col | Field |
|-----|--------|
| A | company_key |
| B | company_name |
| C | end_date (`YYYY-MM-DD`) |
| D | opened_on (`YYYY-MM-DD`), the day printed on the form. Not a voucher filter. |
| E | count_hour |
| F | count_minute |
| G | quantities JSON, ten integers in denomination order |
| H | book_balance at last save (display only; reopen recalculates) |
| I | counted_total at last save |
| J | reason_thua |
| K | reason_thieu |
| L | conclusion |
| M | reps JSON: four objects `{ role, name, email, signatureUrl }` in row order |
| N | saved_by_email |
| O | saved_at ISO 8601 UTC |

Signatures are files in the Cash Drive folder `Cash_Count`, uploaded by `uploadFilesToDrive_` through `/api/voucher`, not `/api/drive-upload`. The sheet stores the Drive URL.

## Actions

All three new actions go to the Cash Apps Script through `/api/voucher`. They are not payment-request actions and must not be sent to the P2P script.

| Action | Does |
|--------|------|
| `getCashBook` | Company + end date → included voucher lines and the book balance. No start date. |
| `getCashCount` | Company + end date → the saved row, or empty when none exists |
| `saveCashCount` | Replace the row for that company and end date |

`getCompanyApprovers` and `getEmployees` stay as they are.

`api/voucher.js` routes the three new actions to the Cash backend URL.

## Print

The browser print dialog prints the Mẫu 08a form first, then the voucher list. Screen controls (company picker, date, save, upload buttons) are hidden in print.

## Errors

- No company or no end date: do not call the backend.
- End date after today in Asia/Ho_Chi_Minh: do not call the backend. Tell the user the end date cannot be in the future. An end date before the open date is valid.
- Company not on Master Company: show the backend message and do not open the count form.
- `getCashBook` or `getCashCount` fails: show the message. Do not show a zero balance as if the book were empty.
- Save fails: leave the form as the user filled it and show the message.
- A second save without confirm does not happen. Cancel leaves the stored row unchanged.

## Deploy

The HTML ships with the Ubuntu app (`deploy/update.sh`). `TLCG_CASH_BACKEND.gs` is pasted only into the Cash Apps Script project, then deployed as a new version of the existing web app, Execute as: Me. It is not pasted into Core or P2P.

## Out of scope

- Writing the user’s private Google template file
- A start-date picker, and using the open date as the first day of the voucher list. The open date is only the date printed on the form.
- Changing voucher status, approval, or Voucher_History
- Replacing the placeholder balance on the home Cash Book Summary
- Signature similarity check against the Master Company sample
- An audit-log sheet for cash counts
