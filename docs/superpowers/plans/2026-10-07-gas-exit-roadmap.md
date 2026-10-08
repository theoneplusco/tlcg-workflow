# GAS Exit Roadmap: every workflow on the Mac Mini, then one switch

**Decision (user, 2026-10-07):** "migrate to Macmini server, dont use GAS no more".
- Build everything first, then switch everything on one day.
- Keep the Google Sheet updated by a one-way copy from Postgres to the Sheet.

## Where we start

The 36 + 4 GAS actions still in use are mapped below. Each is listed by the GAS file that handles it.

| Area | GAS file | Actions still on GAS | Postgres today |
|---|---|---|---|
| Vouchers (Phiếu Thu Chi) | TLCG_CASH_BACKEND.gs, TLCG_CORE_BACKEND.gs | createVoucherUploadSession, finalizeVoucherUpload, fetchSignatureImage, syncToSheets; also `/api/voucher-file` → Drive | Approvals done and e2e-tested (Plans 1–3) |
| Purchase requests (Đề Nghị Mua Hàng) | TLCG_P2P_BACKEND.gs | searchPurchaseRequests, sendBackPurchaseRequest, resubmitPurchaseRequest, getGoodsCatalog, getPurchaseOrderTypes, addSupplier, validatePRForDirectPayment, getP2PHistory | 5 handlers in api/handlers/purchase-request.js, never checked against GAS |
| Payment requests (Đề Nghị Thanh Toán) | TLCG_P2P_BACKEND.gs | sendPaymentRequest/submitPaymentRequest, approve, reject, getPaymentRequestHistory, getRecentPaymentRequests, getPaymentRequestDetails, getPaymentProgressByPR | none |
| Acceptance minutes (Biên Bản Nghiệm Thu) | TLCG_P2P_BACKEND.gs | create, approve, reject, getHistory, getDetail, getByPR | none |
| Contracts + amendments | TLCG_P2P_BACKEND.gs | createContract, approve, reject, getContractDetails, getContractsByPR, amendments (create, approve, reject, list) | none |
| Cash book / cash count | TLCG_CASH_BOOK.gs | none | handlers exist; no data imported |

GAS also uses these Google services:
- GmailApp (sender address changes to Resend at the switch).
- DriveApp (attachments and Drive folders → R2).
- Sheets as the database (→ Postgres, plus the one-way copy back to the Sheet).

## Plans (each one produces working, tested software; all stay behind `PG_WORKFLOWS` until the switch)

1. ✅ **Plan 4: Vouchers fully off GAS** (`2026-10-07-vouchers-off-gas.md`). Done 2026-10-07: e2e with every GAS URL dead passed 29/29 with zero GAS calls. A real R2 upload still has to be checked on the Mini (no R2 keys on the MacBook).
   - Attachments go to R2.
   - Signature images are fetched by the Mini.
   - `syncToSheets` is replaced.
   - The generic Sheet copy engine is built, then used for vouchers first.
2. ✅ **Plan 5: Purchase requests at GAS parity** (`2026-10-07-purchase-requests-on-postgres.md`). Done 2026-10-07: e2e with every GAS URL dead passed after two page bug fixes; zero PR calls to GAS (acceptance-minutes history still GAS → Plan 7); GAS-mode regression 11/11.
2b. ✅ **Plan 5b: Approve with the registered signature + password; VND threshold** (`2026-10-07-signature-stamp-and-vnd-threshold.md`). Done 2026-10-08: e2e with every GAS URL dead 50/53, with the 3 print failures fixed in 6327038; zero GAS calls; GAS-mode regression 14/14.
   - Check each existing handler against GAS.
   - Add the 8 missing actions.
   - Add an importer for Purchase_Request_History and Purchase_Request_Archive.
   - Add the Sheet copy and an e2e run.
3. **Plan 6: Payment requests.**
   - Schema, all 7 actions, approval through the approval-flow engine, importer for Payment_Request_History, Sheet copy, e2e.
4. **Plan 7: Acceptance minutes, contracts and amendments.**
   - Same pattern, including Contract_History and Contract_Amendments.
5. **Plan 8: Cash data and page clean-up.**
   - Import Cash_Count.
   - Every page talks only to `/api/*`, with no `script.google.com` URLs left in the code.
   - The GAS proxy refuses unknown actions once every workflow is on Postgres.
6. **Plan 9: Switch day.**
   - Run the checklist below, after a full rehearsal on mini.tl-c.us.

## Switch-day checklist (Plan 9, needs the user's go and a date)

1. Announce a short freeze. Put GAS into read-only: script property `READ_ONLY=true`, so write actions return "Hệ thống đang chuyển đổi".
2. Run the final import of every sheet into Postgres. Compare counts and totals per workflow.
3. Turn everything on on the Mini: `PG_WORKFLOWS=cash,vouchers,p2p,payments,acceptance,contracts,files` and `VOUCHER_REQUIRE_LOGIN=true`. Turn the Sheet copy on.
4. Delete every GAS time trigger (sendReminderEmails and the others) so nobody gets duplicate emails.
5. Point `workflow.tl-c.us` at the Mini's Cloudflare tunnel. mini.tl-c.us keeps working.
6. Smoke test each workflow on workflow.tl-c.us. Watch `/api/health` and the email queue for a day.
7. **Rollback:** point DNS back to the Ubuntu tunnel and set `READ_ONLY=false` in GAS.
   - Changes made on the Mini after the switch would have to be copied back by hand, so the rollback window is the first hours only.

## Gate C: checks on the Mini before turning on `files` or `SHEETS_MIRROR`
1. Apply `db/migrations/006_sheet_outbox.sql`. The server refuses to start with vouchers on while it is missing.
2. Redeploy PM2 with `pm2 delete tlcg-workflow && pm2 start ecosystem.config.cjs`, then check `pm2 env <id>`. The ecosystem file now passes only the variables that are set, so `.env` wins.
3. R2 CORS on `tlcg-attachments`:
   - allow `PUT` from https://workflow.tl-c.us and https://mini.tl-c.us;
   - `AllowedHeaders` must include `content-type` and `content-disposition`.
4. Do one real presigned upload of a pdf and of an xlsx. A PUT with a swapped Content-Type must get a 403. Test the `/api/voucher-file` fallback too.
5. Set `VOUCHER_SPREADSHEET_ID` to a scratch copy. Run `scripts/check-sheet-access.js` and one real Sheet write with `SHEETS_MIRROR=on`. Only then switch to the production id.
6. Attachment types are now allow-listed: pdf, raster images, Office files, csv, txt, zip. `.xlsm`, `.rar` and `.eml` are refused, where GAS accepted anything. Extend the list if users complain.

## Open items for the user (before Plan 9)

- Share the master spreadsheet with `tlcg-sheets-mirror@n8n-mediainsdier.iam.gserviceaccount.com` as **Editor**. This is needed for the Sheet copy.
- R2 CORS: allow `PUT` from `https://workflow.tl-c.us` and `https://mini.tl-c.us` on bucket `tlcg-attachments`.
- Email sender: confirm the Resend sending domain and the "from" address that replaces the Gmail account.

## Switch-day additions (Plan 5 review)

1. Stop the app and freeze PR submissions in GAS while `scripts/import-purchase-requests.js --live` runs, so no PR is written to the Sheet during the import.
2. After the import, check:
   - no PR has `company_id` NULL (`SELECT pr_no FROM purchase_requests WHERE company_id IS NULL`);
   - no open PR has empty `pending_emails`;
   - every company has a `company_code`.
3. Run the importer with `--notify-purchasing` once (and only once): it emails the purchasing approver of simplified PRs stuck at Mua hàng.
4. Check once on the real Sheet that the mirror's ISO audit timestamps stay text (not turned into dates by Sheets). The importer's dedupe of audit rows depends on it.
5. `P2P_SPREADSHEET_ID` must equal the GAS `MASTER_SPREADSHEET_ID`. The server refuses to start with `p2p` on and `P2P_SPREADSHEET_ID` unset, and the importer `--live` reads this id.
6. `p2p` and `payments` go on together with Plans 6–7, never `p2p` alone. Until Plan 6, the server refuses to start with `payments` in `PG_WORKFLOWS`, and the direct-payment check fails closed.


## Switch-day additions (Plan 5b)
1. Apply `db/migrations/008_exchange_rates.sql` on the Mini. The server refuses to start with `p2p` on while it is missing.
2. Before turning `p2p` on, an admin enters the USD and EUR rates in Master Data › Exchange rates. They are seeded empty, and a PR in a currency without a rate is refused.
3. Run the sample-size check (Plan 5b Task 7 step 3) against production data and fix every sample that fails or is over 750 KB. Known now: one Drive sample returns 404 (`1_7jJRd7…`, linh.le's sample as INS legal rep and RIOT chief accountant).
4. Tell approvers that on the new system they approve with their login password and no longer upload a signature.
5. The approval password check always requires a signed-in user, and its lockout counter belongs to that user, so nobody can lock out a colleague's approvals. Login and change-password are throttled per device+account (10 per 15 minutes) and per account (50 per hour), with no hard per-account lock. Ship index.html together with the server, because change-password now requires the login token.
