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
