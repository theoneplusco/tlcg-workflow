# Session log: what each AI session did, newest first

Every AI session that works on this repo reads this file first and adds an entry before it ends:
Cursor (Claude Code), Claude Desktop (local), and Claude Code cloud sessions.
The plan of record is `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`. This log only says who did what, where, and what is left.

## Where things run (read this before deploying anything)

| Place | What it is | Notes |
|---|---|---|
| MacBook Pro, `/Volumes/MI 02 (SSD)/CN Personal Projects/TLCG Workflow` | The working folder (shared). Cursor and Claude Desktop (local) edit it. | Source of truth. Commit and push from here. |
| Mac Mini "theoneplus" | Runs **wf.tl-c.us** (the new Postgres server; was called mini.tl-c.us in older docs). PM2 + local Postgres + Redis + Cloudflare tunnel. | Rehearsal and new system. Deploy steps below. |
| **workflow.tl-c.us** | The current live site staff use (GAS + Google Sheet). | **Do not touch.** It moves only on switch day (roadmap Plan 9). |
| GitHub `theoneplusco/tlcg-workflow` | The only thing a cloud session can see. | Cloud work arrives in the folder by `git pull`. |

Working branch: `claude/gallant-heisenberg-mw8o7c` (not merged to `main`).

## ⏰ Reminders for the user (open items — remove when done)

- **Emails are OFF on wf.tl-c.us** (`RESEND_API_KEY` commented out in the Mini's `.env` on 2026-10-08 for testing). Effect: no approval emails, and **"Issue a new temporary password" + "Email it to the employee" does not send** — the admin page shows the password to hand over instead. Failed emails are dropped after 3 tries, never sent later.
  - Turn back on (on the Mini): `cd /Users/theoneplus_server/tlcg-workflow && sed -i '' 's/^#RESEND_API_KEY=/RESEND_API_KEY=/' .env && pm2 delete tlcg-workflow && pm2 start ecosystem.config.cjs && pm2 save` — then every test voucher emails real approvers.
  - Option offered, not built yet: let account emails (temporary passwords) go out even while workflow emails are off.
- **Every approver uploads their signature** in My Profile (or an admin does it in admin.html › Account). Until then, approvals fall back to the Drive links (linh.le's is broken: 404).

## Entry template

```
### YYYY-MM-DD: <tool> (Cursor / Claude Desktop local / cloud session)
- Did: ...
- Commits: ...
- Found: ...
- Left / next: ...
```

---

### 2026-10-10 (later): cloud session — sidebar labels, official titles, speed
- **Did:**
  - **Sidebar labels:** hovering (or tabbing to) a rail icon shows its name next to it, in the chosen language (Trang chủ / Home, Trao đổi / Communications, Thu chi – Sổ quỹ / Cash & Vouchers, …). It replaces the slow native tooltip.
  - **Official titles in capitals on every page:** PHIẾU THU/CHI (the one-page layout had lower-cased it), SỔ QUỸ, HỢP ĐỒNG MUA SẮM, next to ĐỀ NGHỊ MUA HÀNG / ĐỀ NGHỊ THANH TOÁN / BIÊN BẢN NGHIỆM THU. They stay Vietnamese in English mode, as on the paper forms.
  - **Mislabelled page fixed:** `approve_payment_request.html` said "PHÊ DUYỆT ĐỀ NGHỊ MUA HÀNG" but approves payment requests. It now says PHÊ DUYỆT ĐỀ NGHỊ THANH TOÁN.
  - **Speed: Tailwind is prebuilt.** `tailwind.css` (23 KB) replaces the cdn.tailwindcss.com compiler (366 KB, recompiling in every browser).
    - It uses the same Tailwind v3 and is linked last in `<head>`. Screenshots of all 14 page views match the CDN version pixel for pixel; only clocks differ.
    - Measured with a phone-speed CPU, first paint: Phiếu Thu Chi 804 → 508 ms, Đề nghị mua hàng 468 → 216 ms. Main-thread work is about halved.
    - `npm run build:css` rebuilds it. `tests/static/tailwind.test.js` fails if a page gains classes and the file is not rebuilt.
  - **Speed: the server compresses** pages, scripts and JSON (voucher.html 563 KB → 104 KB). Files with `?v=` are cached for a year.
  - **Speed: no Google call when opening forms.** Phiếu Thu Chi and Đề nghị thanh toán loaded the employee list from Google Apps Script in the browser (2–4 s). They now use the server's `getMasterData` (Postgres).
  - **Speed: approvals.** On the server an approval takes about 30 ms. The slow part was downloading a Drive sample signature at the click. Opening the approval page now starts that download, and a loaded sample is kept 6 h instead of 10 min. Approvers who uploaded their signature in My Profile never wait on Drive.
- **Commits:** 551920e (labels, titles), 974f578 (speed).
- **Tests:**
  - Full suite 401/401.
  - Browser checks: labels and titles 19/19, sidebar 90/90, Tổng quan 17/17, Sổ Quỹ 16/16, one-page voucher 14/14, submit + delete 7/7, self-approval 41/41.
- **Found:**
  - **Voucher numbers can collide between people.** The number comes from a counter kept in each browser (`vc_<company>_<PT|PC>_<date>` in localStorage), so two people creating a Phiếu chi for the same company on the same day both get …000001. The second is refused with "Phiếu này đã được gửi trước đó". The GAS site has the same logic. Fix proposed, not built: the server hands out the next free number.
  - Sổ Quỹ still reads the cash book from GAS (the `cash` workflow is not on Postgres on the Mini), so that page still waits on Google.
- **Deploy on the Mini (one command at a time):**
  1. `git pull`
  2. `npm install --omit=dev` (new package: `compression`)
  3. `pm2 delete tlcg-workflow && pm2 start ecosystem.config.cjs && pm2 save` (also loads the new Resend key)
- **Left / next:** the test email after the restart; the Mini clean-up; the voucher-number fix (if wanted); the opening-balance decision.

---

### 2026-10-10: cloud session — Cash & Vouchers content redesign implemented
- **Did:** the three pages from the approved samples (`docs/design/cash-vouchers/`). New shared `ui-kit.css` (cards, buttons, tabs, chips, grid tables). It uses container queries, so layouts adapt to the sidebar being open as well as to the window.
  - **Tổng quan** (index.html › Thu chi – Sổ quỹ): new `cash-overview.js` draws `#cash-overview`; the old section and its functions were removed.
    - "Cần bạn xử lý" first: vouchers waiting for me, oldest first, with Xem / Duyệt (`voucher.html?approveVoucher=`).
    - Four numbers; the first two filter the table.
    - Recent vouchers table: status tabs, search, "Hiện thêm".
    - One company picker for the whole page (remembered in `tlc_cash_company`).
    - Kiểm kê quỹ row.
    - Server: `getVoucherSummary` rows now include `reason` (description) and `stepName` (the open step of the approval plan).
  - **Sổ Quỹ** (cash_book.html): same data, cash count, signers, save and print.
    - Header with company, dates and quick ranges.
    - Numbers: Tổng thu, Tổng chi, Số dư theo sổ quỹ, Phiếu chưa vào quỹ.
    - Tabs Sổ quỹ / Chưa vào sổ / Kiểm kê quỹ; the tab is in the URL (`#pending`, `#count`).
    - The cash book table shows Thu / Chi / Lũy kế, oldest first, with a totals row, a Thu/Chi filter and search.
  - **Phiếu Thu Chi** (voucher.html): new `voucher-onepage.js` re-arranges the existing form; fields, ids, checks and the submit flow are unchanged.
    - Steps 1–4 are cards on one page; a Thu/Chi choice drives the "Loại phiếu" select.
    - Summary panel: total and amount in words, approvers mirrored from step 4, and a checklist built from the page's own `validateStep` / `getSignatureData`.
    - The page's own buttons moved into the panel: Gửi phê duyệt, plus the rest under "Thao tác khác".
    - The stepper, back/next buttons and the review step are hidden.
- **Tests:**
  - Full suite 397/397.
  - Browser checks: Tổng quan 17/17, Sổ Quỹ 16/16 (sample cash-book lines, because GAS is not reachable from the container), one-page voucher 14/14, submit + delete 7/7, self-approval 41/41.
  - Test fix: two "approver has no sample" tests picked an unordered `LIMIT 1` employee and could get TLC AP (who has a sample), and a leftover approval flow then broke three more tests. They now pick a person without a sample, ordered by id, and always clear the flow.
- **Found / decisions for the user:**
  - **Sổ Quỹ balance:** "Số dư theo sổ quỹ" (and the cash count's line I) is Thu − Chi *from the chosen start date*, not since the beginning. This is the existing logic. A true opening balance (Tồn đầu kỳ) needs a decision: should the count compare cash with the balance since the beginning?
  - **"Chưa vào sổ"** means vouchers still in approval; they enter the book automatically once approved. There is no "confirm paid" step, so the design's "Xác nhận đã thu/chi" button was not built.
  - Cash-book lines carry no payer/payee name (GAS `cashBookLine_`), so the table shows the description only.
  - **Test data:** browser runs leave vouchers / sheet_outbox rows dated today in the scratch DB; a fresh browser then re-uses voucher numbers (the known collision). Clear them before re-running.
- **Deploy on the Mini:** `git pull` then `pm2 reload tlcg-workflow` (no migration).
- **Left / next:** Purchase to Pay pages the same way; the opening-balance decision.

---

### 2026-10-09 (later): cloud session — email key, redesign of the Cash & Vouchers content (design only)
- **Email on wf.tl-c.us:** the Mini's `RESEND_API_KEY` was rejected by Resend ("API key is invalid", so emails to chinh.nguyen failed and were dropped). The user created a new key; the Mini's `.env` has it, and Resend accepts it (HTTP 200; domains tl-c.us, mediainsider.us and theoneplus.co are verified).
  - **Still to do:** restart (`pm2 delete tlcg-workflow && pm2 start ecosystem.config.cjs && pm2 save`), send one test email, then remove the "Emails are OFF" reminder above.
  - The first new key was pasted into the chat, so it should be deleted in Resend. The key now in use is full-access; a sending-only key would be safer.
- **Sidebar initials fix** (0abb966): first + last word ("Nguyễn Văn Chinh" → NC).
- **Redesign of the content (not the sidebar) of Tổng quan, Phiếu Thu Chi and Sổ Quỹ:** design canvas https://claude.ai/artifact/QHJk8yzmjzjUjRHA3mQuDT; sample images in `docs/design/cash-vouchers/` (example data).
  - Tổng quan: "Cần bạn xử lý" first, 4 numbers, full-width recent table with status filters, and Kiểm kê quỹ as one row.
  - Phiếu Thu Chi: one page instead of the 5-step wizard, a big Thu/Chi choice, attachments per line, the profile signature, and a summary panel (total, approvers, checklist, Gửi duyệt).
  - Sổ Quỹ: a Thu/Chi/Tồn ledger with a running balance, plus the Chưa vào sổ and Kiểm kê quỹ tabs (counts each note value; shows Khớp/Thừa/Thiếu).
- **Left / next:** the user reviews the samples, then implement these three pages; afterwards the P2P pages the same way.

---

### 2026-10-09: cloud session — one shared sidebar on every page
- **Why:** each page had its own sidebar. voucher.html listed the documents, cash_book.html listed the three workflows, and contract, admin and approval flows had none. The user approved a design ("TLCG sidebar redesign" canvas): an icon rail plus a panel, workflow groups that open, EN/VI following the switch, applied to every page.
- **Did:**
  - New `app-sidebar.js` + `app-sidebar.css` (plain script, no dependencies). Each page includes them with its place: `data-active="cash-voucher"`; index.html adds `data-spa="index"`.
  - Pages using it: index, voucher, purchase_request, payment_request, acceptance_minutes, cash_book, contract, admin, approval_flows. The old sidebars, their CSS and JS were removed, along with index's dead phone drawer (nothing opened it).
  - Layout by width:
    - Wide (≥1100px): rail + panel (340px). The toggle or Cmd/Ctrl+B folds the panel into the rail (64px); this is remembered (`tlc_sidebar_collapsed`).
    - Tablet (768–1099px): rail only; the toggle opens the panel over the page.
    - Phone: a menu button in each page header (`.asb-burger[data-asb-open]`) opens it as a drawer.
  - Panel contents, top to bottom:
    - Brand and org card.
    - Find box (Cmd/Ctrl+K): finds pages in EN or VI (accents optional) and opens a PR number (`?prNo=`) or a voucher number (`?viewStatus=`).
    - Trang chủ; Việc của tôi (the documents waiting for you); Trao đổi; Quản trị (admins only).
    - Workflow groups:
      - Order to Cash: one link.
      - Purchase to Pay: Tổng quan / Đề Nghị Mua Hàng / Hợp Đồng / Biên Bản Nghiệm Thu / Đề Nghị Thanh Toán.
      - Cash & Vouchers: Tổng quan / Phiếu Thu Chi / Sổ Quỹ.
    - EN/VI switch, then your name, role and sign out.
  - Groups: the current page's group opens; others remember whether they are open (`tlc_sidebar_groups`). In the rail, a group tile shows a pop-out list of its documents.
  - Badges: new always-on action `getMyTaskCounts` (`api/handlers/my-tasks.js`) counts documents whose `pending_emails` include you. It counts only workflows on Postgres (vouchers → Phiếu Thu Chi, p2p → Đề Nghị Mua Hàng); a workflow still on GAS gets no badge rather than a wrong one. The browser caches the counts for 60 s (sessionStorage).
  - index.html: sidebar links open its pages with `showPage` (the URL becomes `?page=…`), and the current item follows `showPage`. After login or logout, `updateUI` calls `AppSidebar.refresh()`.
  - Tests:
    - `tests/server/my-tasks.test.js` (2); full suite 396/396.
    - Browser check 90/90: every page at wide/tablet/phone sizes, current item, badges, groups, EN/VI, find, fold, pop-out, drawer, index navigation, admin item, sign out.
    - Earlier voucher/cash checks still pass.
- **Found:**
  - index.html has no Communications page: `showPage('comm')` shows the home page (it did before too). The "Trao đổi" item is kept as before; it needs a page.
  - The voucher-number collision (fresh browser counter) showed up again in the scratch DB; not related.
  - payment_request.html has one stray `</div>` (before this change too).
- **Deploy on the Mini:** `git pull` then `pm2 reload tlcg-workflow` (no migration). Script tags carry `?v=20261009-2` (initials fixed: first + last word, "Nguyễn Văn Chinh" → NC); bump it when `app-sidebar.*` changes.
- **Left / next:**
  - A Communications page, or drop the item.
  - Badges for payment requests, acceptance minutes and cash book come with their move to Postgres (Plans 6–8).
  - The email approve/reject pages (`approve_*.html`, `reject_*.html`) stay without a sidebar on purpose; they are one-action pages opened from emails.

---

### 2026-10-08 (night): cloud session — profile signature used in every workflow
- **Checked:** vouchers and purchase requests on Postgres already stamp the profile signature (shared `sampleSignatureFor`). Pages that still take a signature *image* did not: voucher (requester signature, receipt confirmation, GAS-path approval), purchase request (requester, GAS-path approval), acceptance minutes (receiver, department head), `approve_voucher.html`, `approve_payment_request.html`, cash book (signer). `payment_request.html` and `contract.html` take no signature.
- **Did:** new `my-signature.js` (`MySignature.get / fillInput / watch`), included on those 6 pages.
  - The page's signature upload is filled with the signed-in person's profile signature as if they had picked the file, so each page's own handler runs unchanged; a note "✓ Đã dùng chữ ký mẫu trong Hồ sơ của bạn" shows; they can still pick another file. Cash book fills only while that signer has not chosen one.
  - The pages' similarity checks (`compareSignatures`, `_prCompareSignatures`, `_amCompareSignatures`) now use the person's profile signature as their sample, else the Drive sample — so a profile signature passes even when the Drive sample is broken (linh.le).
  - Cash book keeps PNG uploads as PNG (transparent) instead of JPEG on white.
  - Without login (e.g. an approve page opened from an email without a session) or without a profile signature, nothing changes.
  - Tests: full suite 394/394; browser checks 10/10 (pages) + 3/3 (cash book path).
- **Left / next:** see Reminders at the top. Server-side stamping for payment requests, acceptance minutes and cash book comes with their move to Postgres (Plans 6–8).

---

### 2026-10-08 (evening): cloud session — signatures stored in Postgres (no more Drive links)
- **Why:** linh.le could not approve RI-PC20260820000001. Her RIOT accountant sample is a Drive link (`1_7jJRd7…`) that answers HTTP 404 to the server (private or deleted file). GAS read Drive with the owner's permission; the new server reads links like any visitor, so every Drive sample must be public or it blocks approvals.
- **Did (user's choice: both employee and admin can upload):**
  - Migration `009_employee_signatures.sql`: one signature per employee (`employee_signatures`, PNG/JPEG data URL, max 750 KB). The server refuses to start with vouchers or p2p on while it is missing.
  - `sampleSignatureFor` now uses the person's **uploaded** signature first, for every role they approve in; the company Drive links and the employee `Signature` column are only a fallback.
  - My Profile (`index.html`): card "Chữ ký mẫu" with the current signature and "Tải chữ ký lên"; saving asks for the login password (same 5-tries lockout as approvals).
  - admin.html › Account: "Chữ ký mẫu" section; an admin views and replaces anyone's signature (saved at once, no password).
  - Every upload is written to `master_audit` (table_key `signatures`, size only, never the image). New shared `signature-image.js` resizes to ≤ 900×400 on white before upload; the server re-checks type (by bytes) and size.
  - New actions (always on): `getMySignature`, `saveMySignature`, `adminGetSignature`, `adminSaveSignature`.
  - NO_SAMPLE now says: upload in My Profile or ask an administrator.
  - Tests: `tests/approval/signatures.test.js` (4); full suite 389/389; browser check 10/10.
  - **Transparent signatures (same day, user's request):** `signature-image.js` now removes the paper on upload: it measures the paper brightness from the image border (works on grey/yellow phone photos), makes it transparent with a soft edge, keeps the ink's look, crops to the ink and saves a PNG with transparency (≤ 900×400). Very dark photos and blank images are refused with a message. The voucher print (`.signature-img`) also uses `mix-blend-mode: multiply`, so older samples with a white background (Drive links, uploads before this change) print without a white box. Tests: `tests/approval/signature-image.test.js` (5); full suite 394/394; browser check 6/6 (a 754 KB grey photo became a 43 KB transparent PNG, stamped and printed cleanly). People who uploaded before this change can re-upload to get a transparent one.
  - Follow-up: the server lets browsers cache `.js` for an hour, so after a deploy a browser could still run the old `signature-image.js` (Linh's first upload kept its white background). The script tags are now `signature-image.js?v=20261008-2` — bump the `?v=` whenever that file changes. The previews in My Profile and admin.html › Account show a checkerboard, so a white box (not transparent) is visible at a glance.
- **Deploy on the Mini:** `git pull`, `psql tlcg_workflow -f db/migrations/009_employee_signatures.sql`, `pm2 reload tlcg-workflow`. Then Linh uploads her signature in My Profile (or an admin does it in admin.html › Account) and approves again.
- **Left / next:** ask every approver to upload their signature; afterwards the Drive sample links can be retired.

---

### 2026-10-08 (later): cloud session — wf.tl-c.us deployed; requester can delete a voucher
- **Did (with the user, on the Mac Mini):** wf.tl-c.us now runs this branch.
  - The Mini's app folder is `/Users/theoneplus_server/tlcg-workflow` (its own git copy, not the MacBook folder). It was on `cursor/purchase-request-slim-list` with many uncommitted files: a full copy is in `/Users/theoneplus_server/tlcg-workflow-backup-20261008` and the changes are in `git stash` ("mini local changes before plan 5c").
  - Database `tlcg_workflow`: backup `/Users/theoneplus_server/tlcg_workflow-backup-20261008.sql`, then migrations 001–008 applied.
  - `.env` (backup `.env.bak-20261008`): `PG_WORKFLOWS=vouchers,files`, `APP_BASE_URL=https://wf.tl-c.us`, `RESEND_API_KEY` commented out (no emails while testing; a failed email is retried 3 times, then dropped, never sent later). `p2p` is not on yet: it needs `P2P_SPREADSHEET_ID` and the USD/EUR rates.
  - Vouchers imported from the Sheet: `node scripts/import-vouchers.js --live` (450 vouchers, 1865 history rows). Re-run it to pick up vouchers made on workflow.tl-c.us since.
  - Verified by the user: the self-approval prompt appears on wf.tl-c.us.
- **Did: requester can delete a voucher** (user's rule: only while nobody has approved).
  - New action `deleteVoucher` (vouchers on Postgres only). Allowed for the requester or the signed-in person who submitted it, while the flow is open and nobody **else** has approved. The deleter's own Plan 5c auto-approval does not block it.
  - Not erased: status becomes `Đã xóa`, the voucher leaves every list and reminder, approve/reject refuse it ("Phiếu này đã bị người đề nghị xóa."), history + audit (`Delete`) + Sheet copy record it, the number is never reused. The approvers who were waiting get `[ĐÃ XÓA] Phiếu <số>`.
  - Page: a red "Xóa phiếu" button in the voucher modal, shown only when the server says `canDelete` (getApprovalContext); confirm dialog, then the list reloads.
  - Tests: `tests/vouchers/delete.test.js` (4); full suite 385/385; browser check 7/7.
- **Found:** voucher numbers come from a counter in each browser's localStorage (`voucher.html` ~line 8222). Two devices of the same person on the same day can produce the same number; the server then refuses the second with "đã được gửi trước đó". Existing behaviour, not fixed.
- **Left / next:** deploy this change to wf.tl-c.us (on the Mini: `git pull`, `pm2 reload tlcg-workflow`); turn emails back on when testing is done; then p2p on the Mini, `gas-regress.cjs`, Plan 6. The "no password reset for admins" patch below is still pending.

---

### 2026-10-08: cloud session (Claude Code on the web)
Picked up after Cursor hit its limit. Cursor had finished Plan 5c Tasks 1–4 (self-approval module, vouchers, purchase requests, page prompt) and pushed them with a "WIP from Cursor" commit.

- **Did: Plan 5c Task 5** (end-to-end with GAS dead, GAS-mode regression, roadmap update).
  - Unit tests 381/381 against a rebuilt `tlcg_v_test`.
  - Browser e2e with every GAS URL dead: 41/41 (the plan's 11 scenarios plus Hủy/Escape from decision 5).
  - GAS mode against a local GAS stub: 6/6 (no prompt, exactly one `sendApprovalEmail` / `purchaseRequest`, unchanged toasts).
  - The cloud container could not reach Google Drive or `script.google.com`, so the stamp fetch used a test-only Drive stub and the Tailwind/html2pdf/xlsx CDNs were served from npm copies. None of that is in the repo.
- **Commits:** `4e4a3ea` docs: GAS exit roadmap - plan 5c done (roadmap entry 2c + "Switch-day additions (Plan 5c)").
- **Found:**
  1. `voucher.html` (~line 3468, `_MASTER_GAS_URL`) loads master data (the employee list) straight from GAS, not through `/api`. With GAS gone, "Người đề nghị" is empty. Already Plan 8 scope ("every page talks only to `/api/*`"); now written in the roadmap.
  2. After "Bỏ qua, tôi duyệt sau", the requester's reminder email subject is `[PHIẾU CHI] Yêu cầu phê duyệt - <số phiếu>`, not `[PHÊ DUYỆT] …` as the plan said. Decision 3 (keep the reminder) holds.
  3. The server assigns the final PR number; the number the page shows before submit can differ. Tests must read it back from the database.
  4. `purchase_request.html` builds its approver dropdowns from the client-side company file (`tlcg_companies_embed.json`), so it can offer an email (e.g. `nguyennhanh863@gmail.com`) that the server's company data no longer has.
  5. `tests/sheets/outbox.test.js` has no skip guard: without `TEST_DATABASE_URL` its 10 tests fail on ECONNREFUSED instead of skipping.
- **Rebuilding `tlcg_v_test` from scratch** (how the cloud run did it): `db/schema.sql`, then `db/migrations/001…008`, then companies from `tlcg_companies_embed.json` with `nguyennhanh863@gmail.com` → `nhanh.nguyen@tl-c.com.vn`, one employee per approver plus `tlc.ap@tl-c.com.vn` (department "Kế Toán Chi", with a `Signature` sample in `extra`), password `Test#2026`, `master_columns` for vendors and goods, two goods rows. Only the AP purchaser gets a `Signature` sample; the voucher tests expect other staff to have none.
- **Left / next:**
  1. Run the read-only `gas-regress.cjs` against live GAS (Plan 5b, 14 checks) on the MacBook or Mini. The only Plan 5c check not done.
  2. Deploy the branch to **wf.tl-c.us** (Mac Mini), steps below.
  3. Pending decision (not applied): "an admin cannot reset another admin's password" (patch below).
  4. Leftovers from the "WIP from Cursor" commit: `.claude/settings.local.json` (personal permissions; normally not committed) and `policy.yaml` (a Google Cloud org policy that turns off the service-account-key block). Remove them, or keep them on purpose.
  5. Next roadmap item: Plan 6 (payment requests on Postgres).

#### Deploy this branch to wf.tl-c.us (Mac Mini)
1. In the folder the Mini runs from: `git fetch origin claude/gallant-heisenberg-mw8o7c && git checkout claude/gallant-heisenberg-mw8o7c && git pull --ff-only`, then `npm install --omit=dev` (if the Mini keeps its own copy).
2. `for f in db/migrations/00{5,6,7,8}_*.sql; do psql tlcg_workflow -f "$f"; done` (use the Mini's database name).
3. In the Mini's `.env`: `PG_WORKFLOWS=vouchers,p2p,files`, `APP_BASE_URL=https://wf.tl-c.us`, `P2P_SPREADSHEET_ID=<master spreadsheet id>`.
4. `pm2 delete tlcg-workflow && pm2 start ecosystem.config.cjs`, then `pm2 logs tlcg-workflow`. Expect `Workflows on Postgres: vouchers, p2p, files` and no `FATAL`.
5. An admin enters the USD and EUR rates in Master Data › Exchange rates.
6. Cautions: with `RESEND_API_KEY` set, real staff get the emails. Keep `SHEETS_MIRROR` off, or point `VOUCHER_SPREADSHEET_ID` at a scratch copy (roadmap Gate C), or test vouchers land in the real Sheet.

To see the self-approval prompt on wf.tl-c.us: send a **new** voucher (step 5 "Gửi phê duyệt") where the signed-in person is the requester and also an approver of that company (e.g. nhanh at TLC). Old vouchers such as TL-PC20260828000001 have no consent and are approved by hand.

#### Pending patch: no password reset for admins (not applied; apply only if the user says yes)
The user asked that an admin can reset a current employee's password in `admin.html` (Account button on every employee row; this already works) **except for admins**. The patch below adds that rule on the server and in the dialog, plus a database test. It was written but not run or committed. To apply: save the block to a file and run `git apply <file>`, then `npm test`.

```diff
diff --git a/admin.html b/admin.html
index 7c65303..a387406 100755
--- a/admin.html
+++ b/admin.html
@@ -268,6 +268,7 @@
       <label><input type="checkbox" name="isAdmin"> Admin rights</label>
       <label><input type="checkbox" name="resetPassword"> Issue a new temporary password</label>
       <label style="padding-left:24px;"><input type="checkbox" name="sendEmail" checked> Email it to the employee</label>
+      <div id="acct-admin-note" style="color:var(--muted);font-size:13px;" hidden>Admins cannot have their password reset here. They change it themselves or use "Quên mật khẩu".</div>
     </div>
     <div class="body" id="acct-summary" style="margin-top:14px;"></div>
     <div class="actions">
@@ -1257,6 +1258,12 @@
     return out;
   }
   function renderAcctSummary() {
+    // No password reset for admins (or for someone this change makes an admin); the server refuses it too
+    const adminTarget = acctRow.account.isAdmin || acctForm.isAdmin.checked;
+    if (adminTarget) acctForm.resetPassword.checked = false;
+    acctForm.resetPassword.disabled = adminTarget;
+    acctForm.sendEmail.disabled = adminTarget || !acctForm.resetPassword.checked;
+    document.getElementById('acct-admin-note').hidden = !adminTarget;
     const ch = acctChanges();
     document.getElementById('acct-summary').innerHTML = ch.length
       ? '<b>This will:</b><ul class="summary">' + ch.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>'
diff --git a/api/handlers/admin-employees.js b/api/handlers/admin-employees.js
index ca6b32a..761bb14 100755
--- a/api/handlers/admin-employees.js
+++ b/api/handlers/admin-employees.js
@@ -10,6 +10,8 @@ import { MASTER_TABLES, checkRule } from '../lib/master-registry.js';
 
 const EMPLOYEE_RULES = MASTER_TABLES.employees.rules;
 
+export const ADMIN_RESET_REFUSED = 'Không thể đặt lại mật khẩu của quản trị viên. Quản trị viên tự đổi mật khẩu hoặc dùng "Quên mật khẩu".';
+
 const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
 const str = (v) => (v == null ? '' : String(v)).trim();
 const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
@@ -288,6 +290,12 @@ export async function handleAdminUpdateEmployee(req, res) {
 
   let tempPassword = '';
   if (b.resetPassword === true || b.resetPassword === 'true') {
+    // Admins change their own password (or use "Quên mật khẩu"); no admin resets another admin's
+    const { rows: target } = await pool.query('SELECT is_admin FROM employees WHERE id = $1', [id]);
+    if (!target[0]) return res.json({ success: false, message: 'Không tìm thấy nhân viên.' });
+    if (target[0].is_admin || b.isAdmin === true || b.isAdmin === 'true') {
+      return res.json({ success: false, message: ADMIN_RESET_REFUSED });
+    }
     tempPassword = generateTempPassword();
     set('password_hash', await bcrypt.hash(tempPassword, 10));
     set('legacy_password_sha256', '');
diff --git a/tests/admin/employees-reset.test.js b/tests/admin/employees-reset.test.js
new file mode 100644
index 0000000..d5836e0
--- /dev/null
+++ b/tests/admin/employees-reset.test.js
@@ -0,0 +1,65 @@
+// tests/admin/employees-reset.test.js — an admin resets a current employee's password; never an admin's (DB)
+import { test, before, after } from 'node:test';
+import assert from 'node:assert/strict';
+import bcrypt from 'bcryptjs';
+
+const url = process.env.TEST_DATABASE_URL;
+const skip = !url && 'set TEST_DATABASE_URL to run';
+const EMAILS = ['reset-admin@test.vn', 'reset-admin2@test.vn', 'reset-staff@test.vn'];
+let h, pool, auth, ids;
+const call = (fn, body) => new Promise((resolve, reject) => {
+  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
+  Promise.resolve(fn({ body, query: {}, headers: { authorization: auth } }, res)).catch(reject);
+});
+const row = async (id) => (await pool.query('SELECT password_hash, legacy_password_sha256, must_change_password, is_admin FROM employees WHERE id = $1', [id])).rows[0];
+
+before(async () => {
+  if (!url) return;
+  process.env.DATABASE_URL = url;
+  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
+  h = await import('../../api/handlers/admin-employees.js');
+  pool = (await import('../../db/pool.js')).default;
+  const jwt = (await import('jsonwebtoken')).default;
+  const hash = await bcrypt.hash('Old#2026', 4);
+  ids = {};
+  for (const [email, isAdmin] of [[EMAILS[0], true], [EMAILS[1], true], [EMAILS[2], false]]) {
+    const { rows } = await pool.query(`INSERT INTO employees (full_name, email, status, is_admin, password_hash, legacy_password_sha256)
+      VALUES ($1, $1, 'active', $2, $3, 'abc') ON CONFLICT (email) DO UPDATE SET is_admin = $2, status = 'active', password_hash = $3,
+      legacy_password_sha256 = 'abc', must_change_password = FALSE RETURNING id`, [email, isAdmin, hash]);
+    ids[email] = rows[0].id;
+  }
+  auth = 'Bearer ' + jwt.sign({ id: ids[EMAILS[0]] }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
+});
+after(async () => {
+  if (!pool) return;
+  await pool.query('DELETE FROM employees WHERE email = ANY($1)', [EMAILS]);
+  await pool.end();
+  (await import('../../db/redis.js')).default.quit?.();
+});
+
+test('a current employee gets a new temporary password; the old one stops working; must change at next login', { skip }, async () => {
+  const staff = ids[EMAILS[2]];
+  const r = await call(h.handleAdminUpdateEmployee, { id: staff, resetPassword: true, sendEmail: false });
+  assert.equal(r.success, true, r.message);
+  assert.match(r.data.tempPassword, /^.{8,}$/);
+  assert.equal(r.data.emailed, false);
+  const after = await row(staff);
+  assert.equal(await bcrypt.compare(r.data.tempPassword, after.password_hash), true);
+  assert.equal(await bcrypt.compare('Old#2026', after.password_hash), false);
+  assert.deepEqual([after.legacy_password_sha256, after.must_change_password], ['', true]);
+});
+
+test('an admin\'s password cannot be reset: another admin, yourself, or someone this change makes an admin', { skip }, async () => {
+  for (const [id, extra] of [[ids[EMAILS[1]], {}], [ids[EMAILS[0]], {}], [ids[EMAILS[2]], { isAdmin: true }]]) {
+    const before = await row(id);
+    const r = await call(h.handleAdminUpdateEmployee, { id, resetPassword: true, sendEmail: false, ...extra });
+    assert.deepEqual([r.success, r.message, r.data], [false, h.ADMIN_RESET_REFUSED, undefined]);
+    assert.deepEqual(await row(id), before, 'nothing changed');
+  }
+});
+
+test('other account changes on an admin still work', { skip }, async () => {
+  const r = await call(h.handleAdminUpdateEmployee, { id: ids[EMAILS[1]], isAdmin: false });
+  assert.equal(r.success, true, r.message);
+  assert.equal((await row(ids[EMAILS[1]])).is_admin, false);
+});
```
