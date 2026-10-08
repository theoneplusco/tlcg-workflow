# Approve with the Registered Signature + Password, and a VND Threshold with Admin Exchange Rates (Plan 5b of the GAS exit roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the user's product decisions of 2026-10-07 (round 2, memory `project_pr_decisions.md`) to the Postgres workflows:
1. **Signature option D.** On Postgres, an approver no longer uploads a signature and there is no image-similarity check. The approver re-enters their login password; the server checks it like login (rate-limited, locked after repeated failures) and stamps the approver's registered sample signature onto the approval. Vouchers (single and bulk) and purchase requests use it now; acceptance minutes reuse the same server module in Plan 7.
2. **VND threshold.** The purchase-request "full branch" limit becomes 2,000,000 VND. Non-VND totals are converted with exchange rates that admins edit in Master Data (audited). A missing rate refuses the submit. The rate used and the VND total are stored on the PR, and `directPaymentProblem` uses the same VND branch.

**Architecture:**
- **One shared server module, `api/lib/approval/step-up.js`.** `confirmPassword` checks the login password against the employee's hash with the same code login uses (moved to `api/lib/auth/password.js`) and counts failures in Redis (`stepup:fail:<email>`). `stampSignature` resolves the sample with the existing `sampleSignatureFor` and turns it into an image data URL (fetched through the Drive/R2 allow-list fetcher that `fetchSignatureImage` already uses, moved to `api/lib/files/fetch-image.js`, cached 10 minutes per URL). Handlers call `confirmPassword` once before any row lock (once per batch for bulk), and `stampSignature` inside the transaction, after the business rules pass.
- **Old data stays readable.** The stamped data URL goes into the same metadata keys the print views already read (`accountantSignature`, `legalRepSignature`, `treasurerSignature`, `approverSignature`, `<role>Signature` on PRs). Old `signatureVerification` objects are left as they are; new ones are `{ verified: true, method: 'password', sampleFrom, verifiedAt }`. Only the dead rule (`signatureProblem`: verified === true / no_sample) is deleted.
- **Pages.** A tiny shared `approval-password.js` (plain script, own overlay, no page HTML restructured) asks for the password. Each page switches to it only when the server says so (`approvalAuth: 'password'` in the voucher approval context / PR detail, or the existing `window.__vouchersOnPostgres` / `VoucherSteps.onPostgres` detection). GAS mode never sees the new code paths.
- **Exchange rates.** A real table `exchange_rates` (migration 008) registered in `api/lib/master-registry.js` as an app-only table (`sheet: null`): the existing Master Data grid, review dialog and confirmation gate work unchanged. The registry gains `readOnly` columns and an `audit` flag; audited tables write `master_audit` in the same transaction as the cell change, and a History button shows it. `scripts/import-master-sheets.js` skips app-only tables.
- **Branch.** `checkSubmission` gets `{ currency, rateToVnd }` from `prepareSubmission` (async lookup) and computes `grandTotalVnd`; `computeBranch` compares that. `purchase_requests` gets `fx_rate` and `grand_total_vnd`. `branchOf(row)` (used by `directPaymentProblem`) recomputes from `grand_total_vnd` and falls back to the stored branch for rows imported from GAS. The page mirrors the rule with `fx-branch.js` and the new read action `getExchangeRates`.

**Tech Stack:** Node 24 ESM, Express 4, `pg`, `ioredis`, `bcryptjs`, `jsonwebtoken`, `node:test`, Playwright (scratch e2e only).

## Global Constraints
- GAS mode stays exactly as today: no page code path changes unless the server answered as Postgres (`approvalAuth === 'password'`, `window.__vouchersOnPostgres`, `VoucherSteps.onPostgres(v)`, or a successful `getExchangeRates`). New actions are registered only behind their `PG_WORKFLOWS` key (`getExchangeRates` → `p2p`); `adminMasterAudit` is an admin action (always Postgres, like the other `adminMaster*`).
- Test command: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`. 279 tests pass before Task 1; every task ends with the whole suite green (0 fail).
- Before Task 1: `psql tlcg_v_test -c "truncate approval_flows, email_queue, sheet_outbox"`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Request field for the password: `approverPassword` (vouchers single: `voucher.approverPassword`; vouchers bulk and PRs: top-level `approverPassword`). It is never logged, stored, echoed or put in an email.
- Password rules: compared with `verifyPassword(db, user, password)` from `api/lib/auth/password.js` (bcrypt, else the GAS SHA-256 with on-the-spot upgrade — the login code path). Active employees only, email matched with `LOWER(email)`. Longer than 200 characters → treated as wrong without hashing.
- Lockout: Redis key `stepup:fail:<lower email>`; `INCR` on each wrong password, `EXPIRE 900` set on the first failure; the 5th wrong password and every attempt while the counter is ≥ 5 answer the locked message; a correct password deletes the key. Redis error → refuse (fail closed). Login (`handleLogin`) is not changed.
- Step-up messages (`STEP_UP_MSG`, vouchers pick by `lang`, PRs always `vi`):
  - `needPassword` — vi `Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.` / en `Please enter your login password to confirm the approval.`
  - `wrongPassword` — vi `Mật khẩu không đúng.` / en `Incorrect password.`
  - `locked` — vi `Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.` / en `Too many wrong passwords. Please try again in 15 minutes.`
  - `unavailable` — vi `Không kiểm tra được mật khẩu lúc này. Vui lòng thử lại sau.` / en `The password cannot be checked right now. Please try again later.`
  - `sampleFetch` — vi `Không tải được chữ ký mẫu của bạn. Vui lòng thử lại hoặc liên hệ quản trị viên.` / en `Your sample signature could not be loaded. Please try again or contact an administrator.`
  - `sampleTooBig` — vi `Chữ ký mẫu của bạn quá lớn (tối đa 750 KB). Vui lòng nhờ quản trị viên thay ảnh nhỏ hơn.` / en `Your sample signature is too large (max 750 KB). Ask an administrator to replace it with a smaller image.`
  - No sample: the existing `NO_SAMPLE` (`api/lib/approval/signature-check.js`), unchanged.
- Stamp rules: sample = `sampleSignatureFor(db, companyId, entries, email)` (company role sample, else the employee's Signature column). A `data:image/…` sample is used as is; any other URL goes through `fetchImageDataUrl` (allow-list, 5 redirects, 15 s timeout). Decoded image ≤ 750 KB (`MAX_STAMP_BYTES = 768000`). In-process cache per URL, 10 minutes, at most 200 entries.
- Order of checks on approve: input checks (voucher number / PR number, role) → login/actor → **password** → row lock → GAS business rules (turn, assignment, status) → **stamp** → write. Bulk vouchers: one password check for the whole request; a wrong password refuses the whole request.
- Audit/metadata on a stamped approval: verification record `{ verified: true, method: 'password', sampleFrom, verifiedAt }`; audit `extra` `{ auth: 'password', signatureStamped: true, sampleFrom }`.
- Exchange rates: table `exchange_rates (currency TEXT UNIQUE ^[A-Z]{3}$, rate_to_vnd NUMERIC(18,6) NULL | > 0)`, seeded `USD`, `EUR` with no rate. VND is never stored (rate 1). Admin rule for `Rate_To_VND`: `{ type: 'number', min: 1, required: true }` (messages `Ô này không được để trống.`, `Cần nhập số.`, `Không được nhỏ hơn 1.`). `Currency` is read-only: `Cột này không sửa ở đây.` Audit-log read for a table without audit: `Bảng này không lưu lịch sử thay đổi.`
- Currency normalisation: empty, `VND`, `VNĐ` (any case) → `VND`; three letters → upper case; anything else → invalid.
- PR messages: missing rate `Chưa có tỷ giá cho <CUR>. Vui lòng liên hệ quản trị viên.` (CUR = normalised code); invalid currency `Loại tiền tệ không hợp lệ.`; both are reported at the point where the branch is computed (after the GAS checks 1–7 and the item checks), so the GAS message order is kept.
- Threshold: `FULL_BRANCH_MIN_VND = 2000000`. `grandTotalVnd` = the grand total when the currency is VND, else `Math.round(grandTotal × rate)`. Branch `full` when purchase type is `services` or `grandTotalVnd ≥ 2000000`. Stored on every submit and resubmit: `currency` (normalised), `fx_rate` (1 for VND), `grand_total_vnd`.
- Locked UI (memory `feedback_locked_sections.md`, `purchase_request_rules.md`, `project_voucher_logic.md`): never restructure Step 1 of `purchase_request.html` or the voucher filter/list blocks. Page edits are limited to: one `<script>` tag per page, the guarded early-return lines and new functions listed in Task 4 and Task 6, hiding the two upload blocks on Postgres, and the admin toolbar button.
- Do not switch production; `PG_WORKFLOWS` on the Mini stays as is.

## File Structure
- Create:
  - `api/lib/auth/password.js` — `verifyPassword(db, user, password)`, `sha256Hex`, `BCRYPT_ROUNDS` (moved out of `api/handlers/auth.js`).
  - `api/lib/files/fetch-image.js` — `fetchImageDataUrl(url, opts)`, `ImageFetchError` (moved out of `handleFetchSignatureImage`).
  - `api/lib/approval/step-up.js` — `confirmPassword`, `stampSignature`, `verificationRecord`, `stampDeps`, `clearStampCache`, constants and `STEP_UP_MSG`.
  - `api/lib/fx/rates.js` — `normalizeCurrency`, `getRateToVnd`, `listRates`, `toVnd`, `missingRateMessage`, `BAD_CURRENCY`.
  - `db/migrations/008_exchange_rates.sql` — `exchange_rates`, `master_audit`, `purchase_requests.fx_rate` / `grand_total_vnd`.
  - `approval-password.js` — browser: `ApprovalPassword.ask(opts)`, `ApprovalPassword.valid(pw)`.
  - `fx-branch.js` — browser: `FxBranch.toVnd`, `FxBranch.branch`.
  - Tests: `tests/approval/step-up.test.js`, `tests/approval/step-up-helpers.js` (shared setup, not a test file), `tests/approval/approval-password.test.js`, `tests/files/fetch-image.test.js`, `tests/admin/exchange-rates.test.js`, `tests/purchase-requests/fx.test.js`, `tests/purchase-requests/fx-branch.test.js`.
- Modify:
  - `api/handlers/auth.js` (use `api/lib/auth/password.js`), `api/handlers/files.js` (use `fetch-image.js`).
  - `api/lib/approval/signature-check.js` (delete `signatureProblem` and its messages).
  - `api/handlers/vouchers.js` (approve, bulk approve, approval context).
  - `api/handlers/pr/tx.js` (`redis` dependency), `api/handlers/pr/decide.js` (approve), `api/handlers/pr/reads.js` (`approvalAuth`, `handleExchangeRates`), `api/handlers/pr/submit.js` (rate lookup, stored columns).
  - `api/lib/purchase-requests/state.js` (`FULL_BRANCH_MIN_VND`, `branchOf`, `directPaymentProblem`), `api/lib/purchase-requests/validate.js` (`checkSubmission` fx), `api/lib/purchase-requests/repo.js` (`WRITABLE`).
  - `api/lib/master-registry.js` (`exchange_rates` entry), `api/handlers/admin-master.js` (read-only columns, audit, `handleAdminMasterAudit`, missing-table tolerance), `scripts/import-master-sheets.js` (skip app-only tables).
  - `api/router.js` (`getExchangeRates`, `adminMasterAudit`), `api/lib/startup-checks.js` (migration 008 for p2p).
  - `approve_voucher.html`, `voucher.html`, `purchase_request.html`, `admin.html`, `i18n.js`.
  - Tests: `tests/vouchers/handlers.test.js`, `tests/purchase-requests/decide.test.js`, `tests/purchase-requests/reads.test.js`, `tests/purchase-requests/validate.test.js`, `tests/purchase-requests/state.test.js`, `tests/server/router-p2p.test.js`, `tests/server/startup.test.js`.
  - Docs: `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`.

---

### Task 1: Shared server pieces — password check, image fetch, step-up module

**Files:**
- Create: `api/lib/auth/password.js`, `api/lib/files/fetch-image.js`, `api/lib/approval/step-up.js`, `tests/approval/step-up.test.js`, `tests/approval/step-up-helpers.js`, `tests/files/fetch-image.test.js`
- Modify: `api/handlers/auth.js`, `api/handlers/files.js`

**Interfaces:**
- Consumes: `sampleSignatureFor(db, companyId, entries, email) → { url, from }`, `NO_SAMPLE` (`api/lib/approval/signature-check.js`); `driveDownloadUrl`, `isAllowedImageUrl`, `MAX_IMAGE_BYTES` (`api/lib/files/signature-fetch.js`).
- Produces:
  - `verifyPassword(db, user, password) → Promise<boolean>`; `user` = `{ id, password_hash, legacy_password_sha256 }`.
  - `sha256Hex(text) → string`, `BCRYPT_ROUNDS = 10`.
  - `fetchImageDataUrl(url, { fetchImpl?, maxBytes? }) → Promise<string>` (throws `ImageFetchError` with the existing Vietnamese messages).
  - `confirmPassword({ db, redis, email, password, lang }) → Promise<{ ok: true } | { ok: false, message, locked? }>`.
  - `stampSignature(db, companyId, entries, email, lang) → Promise<{ ok: true, signature, from, url } | { ok: false, message }>`.
  - `verificationRecord(from, at) → { verified: true, method: 'password', sampleFrom, verifiedAt }`.
  - `stampDeps = { fetchImage(url) }` (test seam), `clearStampCache()`, `failKey(email)`, `MAX_PASSWORD_FAILS = 5`, `LOCK_SECONDS = 900`, `MAX_PASSWORD_LENGTH = 200`, `MAX_STAMP_BYTES = 768000`, `STEP_UP_MSG`.
  - Test helpers: `PW = 'Test#2026'`, `FAKE_STAMP(url)`, `useStepUp(pool, redis, emails) → Promise<cleanup()>`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/files/fetch-image.test.js — the allow-listed image fetcher shared by fetchSignatureImage and the approval stamp
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchImageDataUrl, ImageFetchError } from '../../api/lib/files/fetch-image.js';

const resp = (status, headers = {}, body = Buffer.from([0x89, 0x50, 0x4e, 0x47])) => ({
  status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), arrayBuffer: async () => body,
});

test('fetchImageDataUrl: Drive link → direct download → data URL with the served type', async () => {
  const seen = [];
  const out = await fetchImageDataUrl('https://drive.google.com/file/d/abc/view', {
    fetchImpl: async (u) => { seen.push(u); return resp(200, { 'content-type': 'image/png' }); } });
  assert.equal(seen[0], 'https://drive.google.com/uc?export=download&id=abc');
  assert.equal(out, 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
});

test('fetchImageDataUrl: refusals keep the fetchSignatureImage wording', async () => {
  const run = (url, fetchImpl, opts = {}) => fetchImageDataUrl(url, { fetchImpl, ...opts }).then(() => 'resolved', (e) => (e instanceof ImageFetchError ? e.message : 'other: ' + e.message));
  assert.equal(await run('https://127.0.0.1/x', async () => resp(200)), 'URL hình ảnh không được phép');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(302, { location: 'https://127.0.0.1/x' })), 'URL hình ảnh không được phép');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(302, { location: 'https://drive.google.com/again' })), 'Không tải được hình ảnh (chuyển hướng quá nhiều)');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(404)), 'Không tải được hình ảnh (HTTP 404)');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'text/html' })), 'Tệp không phải hình ảnh');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png', 'content-length': '10' }), { maxBytes: 4 }), 'Hình ảnh quá lớn');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png' }, Buffer.alloc(5))), 'resolved');
  assert.equal(await run('https://drive.google.com/file/d/a/view', async () => resp(200, { 'content-type': 'image/png' }, Buffer.alloc(5)), { maxBytes: 4 }), 'Hình ảnh quá lớn');
});
```

```js
// tests/approval/step-up-helpers.js — setup for tests that approve on Postgres (password + stamped sample). Not a test file.
import bcrypt from 'bcryptjs';
import { stampDeps, clearStampCache } from '../../api/lib/approval/step-up.js';

export const PW = 'Test#2026'; // the e2e login password of tlcg_v_test
export const FAKE_STAMP = (url) => 'data:image/png;base64,' + Buffer.from(String(url)).toString('base64');
const lower = (s) => String(s || '').trim().toLowerCase();

/**
 * Give each email (an existing employee, else a new active one) the password PW, stamp samples without
 * network (FAKE_STAMP of the sample URL), and clear the lockout counters. Returns cleanup() that deletes
 * the employees it had to create.
 */
export async function useStepUp(pool, redis, emails) {
  const hash = await bcrypt.hash(PW, 4);
  const added = [];
  for (const e of [...new Set(emails.map(lower).filter(Boolean))]) {
    const upd = await pool.query(`UPDATE employees SET password_hash = $2, status = 'active' WHERE LOWER(email) = $1`, [e, hash]);
    if (!upd.rowCount) {
      await pool.query(`INSERT INTO employees (full_name, email, status, password_hash) VALUES ($1, $1, 'active', $2)`, [e, hash]);
      added.push(e);
    }
  }
  stampDeps.fetchImage = async (url) => FAKE_STAMP(url);
  clearStampCache();
  const keys = await redis.keys('stepup:fail:*');
  if (keys.length) await redis.del(...keys);
  return async () => { if (added.length) await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [added]); };
}
```

```js
// tests/approval/step-up.test.js — password step-up and the stamped sample (needs TEST_DATABASE_URL + Redis db 15)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import Redis from 'ioredis';
import {
  confirmPassword, stampSignature, stampDeps, clearStampCache, failKey, verificationRecord, STEP_UP_MSG, MAX_STAMP_BYTES,
} from '../../api/lib/approval/step-up.js';
import { sha256Hex } from '../../api/lib/auth/password.js';
import { NO_SAMPLE } from '../../api/lib/approval/signature-check.js';
import { PW, FAKE_STAMP, useStepUp } from './step-up-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
const redis = url ? new Redis(process.env.REDIS_URL || 'redis://localhost:6379/15') : null;
const ME = 'stepup@test.vn';
const LEGACY = 'stepup-legacy@test.vn';
const M = STEP_UP_MSG.vi;
let company, savedSig, cleanup;

before(async () => {
  if (!db) return;
  cleanup = await useStepUp(db, redis, [ME]);
  await db.query(`DELETE FROM employees WHERE email = $1`, [LEGACY]);
  await db.query(`INSERT INTO employees (full_name, email, status, password_hash, legacy_password_sha256) VALUES ('Legacy', $1, 'active', '', $2)`, [LEGACY, sha256Hex(PW)]);
  company = (await db.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  savedSig = company.treasurer_sig_url;
  await db.query(`UPDATE companies SET treasurer_sig_url = 'https://drive.google.com/file/d/stamp-test/view' WHERE id = $1`, [company.id]);
});
after(async () => {
  if (!db) return;
  await db.query(`UPDATE companies SET treasurer_sig_url = $2 WHERE id = $1`, [company.id, savedSig]);
  await db.query(`DELETE FROM employees WHERE email = $1`, [LEGACY]);
  await cleanup();
  await redis.del(failKey(ME), failKey(LEGACY));
  await db.end();
  await redis.quit();
});

const check = (password, email = ME, lang = 'vi', r = redis) => confirmPassword({ db, redis: r, email, password, lang });

test('confirmPassword: right password ok; wrong, empty and over-long refused', { skip }, async () => {
  assert.deepEqual(await check(PW), { ok: true });
  assert.deepEqual(await check('nope'), { ok: false, message: M.wrongPassword });
  assert.deepEqual(await check(''), { ok: false, message: M.needPassword });
  assert.deepEqual(await check(undefined), { ok: false, message: M.needPassword });
  assert.deepEqual(await check('x'.repeat(201)), { ok: false, message: M.wrongPassword });
  assert.equal((await check('nope', ME, 'en')).message, 'Incorrect password.');
  assert.deepEqual(await check(PW, 'nobody@test.vn'), { ok: false, message: M.wrongPassword });
  await redis.del(failKey(ME), failKey('nobody@test.vn'));
});

test('confirmPassword: the 5th wrong password locks, even the right one, until the counter expires', { skip }, async () => {
  for (let i = 1; i <= 4; i += 1) assert.equal((await check('nope')).message, M.wrongPassword, `attempt ${i}`);
  assert.deepEqual(await check('nope'), { ok: false, locked: true, message: M.locked });
  assert.deepEqual(await check(PW), { ok: false, locked: true, message: M.locked });
  const ttl = await redis.ttl(failKey(ME));
  assert.ok(ttl > 0 && ttl <= 900, `ttl ${ttl}`);
  await redis.del(failKey(ME));
  assert.deepEqual(await check(PW), { ok: true });
  assert.equal(await redis.exists(failKey(ME)), 0, 'a correct password clears the counter');
});

test('confirmPassword: GAS SHA-256 password accepted and upgraded to bcrypt (the login path)', { skip }, async () => {
  assert.deepEqual(await check(PW, LEGACY), { ok: true });
  const row = (await db.query(`SELECT password_hash, legacy_password_sha256 FROM employees WHERE email = $1`, [LEGACY])).rows[0];
  assert.match(row.password_hash, /^\$2[aby]\$/);
  assert.equal(row.legacy_password_sha256, '');
});

test('confirmPassword: Redis down → refused (fail closed)', { skip }, async () => {
  const down = { get: async () => { throw new Error('down'); } };
  assert.deepEqual(await check(PW, ME, 'vi', down), { ok: false, message: M.unavailable });
});

test('stampSignature: the role sample as an image data URL, fetched once per URL (cache)', { skip }, async () => {
  let calls = 0;
  stampDeps.fetchImage = async (u) => { calls += 1; return FAKE_STAMP(u); };
  clearStampCache();
  const entries = [{ role: 'treasurer', label: 'Thủ quỹ' }];
  const a = await stampSignature(db, company.id, entries, company.treasurer_email, 'vi');
  const b = await stampSignature(db, company.id, entries, company.treasurer_email, 'vi');
  assert.deepEqual(a, { ok: true, signature: FAKE_STAMP('https://drive.google.com/file/d/stamp-test/view'), from: 'Thủ quỹ', url: 'https://drive.google.com/file/d/stamp-test/view' });
  assert.deepEqual(b, a);
  assert.equal(calls, 1);
});

test('stampSignature: no sample, fetch failure, non-image and oversize refused; data URL samples used as is', { skip }, async () => {
  clearStampCache();
  assert.deepEqual(await stampSignature(db, null, null, ME, 'vi'), { ok: false, message: NO_SAMPLE.vi });
  stampDeps.fetchImage = async () => { throw new Error('HTTP 500'); };
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: M.sampleFetch });
  stampDeps.fetchImage = async () => 'data:text/html;base64,AAAA';
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: M.sampleFetch });
  stampDeps.fetchImage = async () => 'data:image/png;base64,' + Buffer.alloc(MAX_STAMP_BYTES + 1).toString('base64');
  assert.deepEqual(await stampSignature(db, company.id, null, company.treasurer_email, 'vi'), { ok: false, message: M.sampleTooBig });
  const inline = 'data:image/png;base64,' + Buffer.from('sig').toString('base64');
  await db.query(`UPDATE employees SET extra = COALESCE(extra, '{}'::jsonb) || jsonb_build_object('Signature', $2::text) WHERE email = $1`, [ME, inline]);
  stampDeps.fetchImage = async () => { throw new Error('must not fetch a data URL'); };
  assert.deepEqual(await stampSignature(db, null, null, ME, 'vi'), { ok: true, signature: inline, from: 'Master Employee', url: inline });
});

test('verificationRecord: what the metadata keeps for a password approval', () => {
  assert.deepEqual(verificationRecord('Thủ quỹ', '2026-10-07T01:00:00.000Z'),
    { verified: true, method: 'password', sampleFrom: 'Thủ quỹ', verifiedAt: '2026-10-07T01:00:00.000Z' });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/files/fetch-image.test.js tests/approval/step-up.test.js`
Expected: FAIL — `Cannot find module '…/api/lib/files/fetch-image.js'` and `…/api/lib/approval/step-up.js`.

- [ ] **Step 3: Move the password check out of auth.js**

```js
// api/lib/auth/password.js — the stored-password check shared by login and approval step-up (takes `db`, no pool import).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 10;

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

/**
 * Check a password against the stored bcrypt hash, or against the GAS SHA-256 hash (column L) carried over
 * by the migration. A legacy match is upgraded to bcrypt on the spot so the SHA-256 copy is used once.
 */
export async function verifyPassword(db, user, password) {
  if (user.password_hash) return bcrypt.compare(password, user.password_hash);
  const legacy = (user.legacy_password_sha256 || '').toLowerCase();
  if (!legacy) return false;
  const submitted = Buffer.from(sha256Hex(password));
  const stored = Buffer.from(legacy);
  if (submitted.length !== stored.length || !crypto.timingSafeEqual(submitted, stored)) return false;
  const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query(
    `UPDATE employees SET password_hash = $1, legacy_password_sha256 = '', updated_at = NOW() WHERE id = $2`,
    [upgraded, user.id]
  );
  return true;
}
```

In `api/handlers/auth.js`:
- delete the local `BCRYPT_ROUNDS`, `sha256Hex` and `verifyPassword` (lines 28–56 today);
- add `import { verifyPassword, BCRYPT_ROUNDS } from '../lib/auth/password.js';`;
- replace `verifyPassword(user, password)` (handleLogin) with `verifyPassword(pool, user, password)` and `verifyPassword(user, currentPassword)` (handleChangePassword) with `verifyPassword(pool, user, currentPassword)`.
- Remove `import crypto from 'crypto';` only if nothing else in the file uses `crypto` (the OTP/reset code does: keep it).

- [ ] **Step 4: Move the image fetch out of files.js**

```js
// api/lib/files/fetch-image.js — fetch an allow-listed image (Drive share link or R2) as a data URL.
// Used by fetchSignatureImage (the page) and by the approval stamp (api/lib/approval/step-up.js).
import { driveDownloadUrl, isAllowedImageUrl, MAX_IMAGE_BYTES } from './signature-fetch.js';

export class ImageFetchError extends Error {}

/** fetchImpl defaults to the global fetch at call time (tests replace globalThis.fetch). */
export async function fetchImageDataUrl(url, { fetchImpl = (...a) => globalThis.fetch(...a), maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!isAllowedImageUrl(url)) throw new ImageFetchError('URL hình ảnh không được phép');
  let target = driveDownloadUrl(url);
  let r;
  for (let hop = 0; ; hop += 1) {
    r = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status < 300 || r.status >= 400) break;
    const next = r.headers.get('location');
    if (!next || hop >= 4) throw new ImageFetchError('Không tải được hình ảnh (chuyển hướng quá nhiều)');
    target = new URL(next, target).toString();
    if (!isAllowedImageUrl(target)) throw new ImageFetchError('URL hình ảnh không được phép');
  }
  if (!r.ok) throw new ImageFetchError(`Không tải được hình ảnh (HTTP ${r.status})`);
  if (Number(r.headers.get('content-length')) > maxBytes) throw new ImageFetchError('Hình ảnh quá lớn');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new ImageFetchError('Hình ảnh quá lớn');
  const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
  if (!/^image\//.test(mime)) throw new ImageFetchError('Tệp không phải hình ảnh');
  return `data:${mime};base64,${buf.toString('base64')}`;
}
```

In `api/handlers/files.js`, `handleFetchSignatureImage` keeps its login check and its `Thiếu URL hình ảnh` / `URL hình ảnh không được phép` checks; replace the whole `try { … }` block with:

```js
  try {
    return ok(res, 'Success', { imageBase64: await fetchImageDataUrl(url) });
  } catch (e) { return fail(res, e instanceof ImageFetchError ? e.message : 'Lỗi: ' + e.message); }
```

and import `{ fetchImageDataUrl, ImageFetchError } from '../lib/files/fetch-image.js'` (drop `driveDownloadUrl` and `MAX_IMAGE_BYTES` from its imports if no longer used there).

- [ ] **Step 5: Write the step-up module**

```js
// api/lib/approval/step-up.js — who approves on Postgres (decision 2026-10-07, option D).
// The approver re-enters their login password (checked like login, failures counted in Redis), and the
// server stamps their registered sample signature on the approval. No upload, no image comparison.
// Shared by vouchers and purchase requests; acceptance minutes adopt it in Plan 7. Takes db/redis as arguments.
import { verifyPassword } from '../auth/password.js';
import { fetchImageDataUrl } from '../files/fetch-image.js';
import { sampleSignatureFor, NO_SAMPLE } from './signature-check.js';

export const MAX_PASSWORD_FAILS = 5;
export const LOCK_SECONDS = 900;
export const MAX_PASSWORD_LENGTH = 200;
export const MAX_STAMP_BYTES = 768000; // 750 KB decoded
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

export const STEP_UP_MSG = {
  vi: {
    needPassword: 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.',
    wrongPassword: 'Mật khẩu không đúng.',
    locked: 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.',
    unavailable: 'Không kiểm tra được mật khẩu lúc này. Vui lòng thử lại sau.',
    sampleFetch: 'Không tải được chữ ký mẫu của bạn. Vui lòng thử lại hoặc liên hệ quản trị viên.',
    sampleTooBig: 'Chữ ký mẫu của bạn quá lớn (tối đa 750 KB). Vui lòng nhờ quản trị viên thay ảnh nhỏ hơn.',
  },
  en: {
    needPassword: 'Please enter your login password to confirm the approval.',
    wrongPassword: 'Incorrect password.',
    locked: 'Too many wrong passwords. Please try again in 15 minutes.',
    unavailable: 'The password cannot be checked right now. Please try again later.',
    sampleFetch: 'Your sample signature could not be loaded. Please try again or contact an administrator.',
    sampleTooBig: 'Your sample signature is too large (max 750 KB). Ask an administrator to replace it with a smaller image.',
  },
};
const msgs = (lang) => STEP_UP_MSG[lang === 'en' ? 'en' : 'vi'];
const lower = (s) => String(s || '').trim().toLowerCase();
export const failKey = (email) => `stepup:fail:${lower(email)}`;

/** The login password of `email`, re-entered at approval time. Never logs the password. */
export async function confirmPassword({ db, redis, email, password, lang }) {
  const m = msgs(lang);
  const me = lower(email);
  const pw = typeof password === 'string' ? password : '';
  if (!me || !pw) return { ok: false, message: m.needPassword };
  let fails;
  try { fails = Number(await redis.get(failKey(me))) || 0; } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
  if (fails >= MAX_PASSWORD_FAILS) return { ok: false, locked: true, message: m.locked };
  const user = pw.length > MAX_PASSWORD_LENGTH ? null : (await db.query(
    `SELECT id, password_hash, legacy_password_sha256 FROM employees WHERE LOWER(email) = $1 AND status = 'active'`, [me])).rows[0];
  const valid = user ? await verifyPassword(db, user, pw) : false;
  try {
    if (valid) { await redis.del(failKey(me)); return { ok: true }; }
    const n = await redis.incr(failKey(me));
    if (n === 1) await redis.expire(failKey(me), LOCK_SECONDS);
    return n >= MAX_PASSWORD_FAILS ? { ok: false, locked: true, message: m.locked } : { ok: false, message: m.wrongPassword };
  } catch (e) {
    console.error('[StepUp] lockout counter unavailable:', e.message);
    return { ok: false, message: m.unavailable };
  }
}

/** Test seam: how a non-data sample URL becomes a data URL. */
export const stampDeps = { fetchImage: (url) => fetchImageDataUrl(url) };
const cache = new Map(); // url → { dataUrl, at }
export function clearStampCache() { cache.clear(); }

async function sampleImage(url) {
  if (/^data:image\//.test(url)) return url;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.dataUrl;
  const dataUrl = await stampDeps.fetchImage(url);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(url, { dataUrl, at: Date.now() });
  return dataUrl;
}

const decodedBytes = (dataUrl) => {
  const i = dataUrl.indexOf(',');
  return i < 0 ? 0 : Buffer.byteLength(dataUrl.slice(i + 1), 'base64');
};

/**
 * The approver's registered sample (company role sample, else the employee's Signature column) as the
 * image data URL stamped on the approval. `entries` as sampleSignatureFor (null = from the company emails).
 */
export async function stampSignature(db, companyId, entries, email, lang) {
  const m = msgs(lang);
  const { url, from } = await sampleSignatureFor(db, companyId, entries, email);
  if (!url) return { ok: false, message: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
  let signature;
  try { signature = await sampleImage(url); } catch (e) {
    console.error('[StepUp] sample fetch failed:', e.message);
    return { ok: false, message: m.sampleFetch };
  }
  if (typeof signature !== 'string' || !/^data:image\//.test(signature)) return { ok: false, message: m.sampleFetch };
  if (decodedBytes(signature) > MAX_STAMP_BYTES) return { ok: false, message: m.sampleTooBig };
  return { ok: true, signature, from, url };
}

/** What the metadata keeps for an approval confirmed by password (old browser-check records stay as they are). */
export const verificationRecord = (from, at) => ({ verified: true, method: 'password', sampleFrom: from || '', verifiedAt: at });
```

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/files/fetch-image.test.js tests/approval/step-up.test.js tests/files/handlers.test.js`
Expected: PASS (the existing `fetchSignatureImage` tests still pass with the same messages).

Then the whole suite: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail.

- [ ] **Step 7: Commit**

```bash
git add api/lib/auth/password.js api/lib/files/fetch-image.js api/lib/approval/step-up.js api/handlers/auth.js api/handlers/files.js \
  tests/files/fetch-image.test.js tests/approval/step-up.test.js tests/approval/step-up-helpers.js
git commit -m "feat(approval): password step-up with lockout and the stamped sample signature (shared module)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Vouchers on Postgres approve with the password and the stamped sample

**Files:**
- Modify: `api/handlers/vouchers.js`
- Test: `tests/vouchers/handlers.test.js`

**Interfaces:**
- Consumes: `confirmPassword`, `stampSignature`, `verificationRecord` (Task 1); `redis` (`db/redis.js`).
- Produces:
  - `approveVoucher` body `{ voucher: { voucherNumber, approverEmail?, approverName?, approverPassword } }`.
  - `bulkApprove` body `{ voucherNumbers[], approverEmail, approverName?, approverPassword }`.
  - `getApprovalContext` answer gains `data.approvalAuth = 'password'` (other fields unchanged).
  - `approveOne({ voucherNumber, approverEmail, approverName, lang })` (internal; no signature/verification arguments).
  - `vouchers.js` no longer imports `signatureProblem` (deleted in Task 3, once `pr/decide.js` stops using it too).

- [ ] **Step 1: Update the tests first**

In `tests/vouchers/handlers.test.js`:
1. Imports and setup:

```js
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
let redis, cleanupStepUp;
```
At the end of `before` (after `people` is set):
```js
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.accountant, people.legal, people.treasurer, 'stranger@x.vn']);
```
At the start of `after` (before `pool.end()`): `if (cleanupStepUp) await cleanupStepUp();`

2. Replace the `approve` helper and drop the `ok` constant:
```js
const approve = (no, email, extra = {}) => call(h.handleVoucherApprove, { voucher: { voucherNumber: no, approverEmail: email, approverPassword: PW, ...extra } });
```
3. In the test `approve: signature rules, order, …` rename it `approve: password, order, already-approved, then progress + next-step email` and replace its two signature assertions with:
```js
  assert.equal((await approve(no, people.accountant, { approverPassword: '' })).message, 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.');
  assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Mật khẩu không đúng.');
  await redis.del(`stepup:fail:${people.accountant}`);
```
and replace `assert.equal(v.metadata.accountantSignature, 'data:sig');` with:
```js
  assert.equal(v.metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url), 'the registered sample is stamped');
  assert.deepEqual(Object.values(v.metadata.signatureVerification).map((x) => [x.verified, x.method]), [[true, 'password']]);
```
4. In `full approval → final emails; …` replace the two `'data:sig'` assertions with:
```js
  assert.equal(v.metadata.treasurerSignature, FAKE_STAMP(company.treasurer_sig_url));
  assert.equal(v.metadata.approverSignature, FAKE_STAMP(company.treasurer_sig_url), 'print-template alias');
```
5. Every other call that sends `approverSignature: …, signatureVerification: ok` (the bulk test, the two `callAs` approve calls of the login test, and the `voucherNumber: 'X'` call) sends `approverPassword: PW` instead.
6. In `server refuses an approval when the approver has no sample signature …` add `await useStepUp(pool, redis, [person.e]);` before submitting, and call `approve(no, person.e)` without the `signatureVerification` extra.
7. Add these tests at the end of the file:

```js
test('approve: a wrong password approves nothing; the 5th locks the approver for 15 minutes', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  for (let i = 0; i < 4; i += 1) assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Mật khẩu không đúng.');
  assert.equal((await approve(no, people.accountant, { approverPassword: 'wrong' })).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await approve(no, people.accountant)).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await voucher(no)).status, 'Đang treo', 'nothing approved');
  await redis.del(`stepup:fail:${people.accountant}`);
  assert.equal((await approve(no, people.accountant)).success, true);
  const a = (await pool.query(`SELECT extra FROM voucher_audit_log WHERE doc_no = $1 AND action = 'Approve' ORDER BY id DESC LIMIT 1`, [no])).rows[0];
  assert.deepEqual([a.extra.auth, a.extra.signatureStamped], ['password', true]);
});

test('bulk approve: one password for the batch; a wrong one refuses every voucher', { skip }, async () => {
  const nos = [newNo(), newNo()];
  for (const no of nos) await call(h.handleVoucherSubmit, submitBody(no));
  const bad = await call(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverEmail: people.accountant, approverPassword: 'wrong' });
  assert.deepEqual([bad.success, bad.message], [false, 'Mật khẩu không đúng.']);
  for (const no of nos) assert.equal((await voucher(no)).status, 'Đang treo');
  await redis.del(`stepup:fail:${people.accountant}`);
  const good = await call(h.handleVoucherBulkApprove, { voucherNumbers: nos, approverEmail: people.accountant, approverPassword: PW });
  assert.deepEqual(good.data.approved, nos);
  for (const no of nos) assert.equal((await voucher(no)).metadata.accountantSignature, FAKE_STAMP(company.accountant_sig_url));
});

test('approval context tells the page to ask for the password', { skip }, async () => {
  const no = newNo();
  await call(h.handleVoucherSubmit, submitBody(no));
  const ctx = await callAs(h.handleVoucherApprovalContext, { voucherNumber: no }, await jwtFor(people.accountant));
  assert.equal(ctx.data.approvalAuth, 'password');
});
```
The audit query reads `voucher_audit_log`, the table `audit()` in `api/lib/vouchers/repo.js` writes (`extra` is JSONB).

- [ ] **Step 2: Run them to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/vouchers/handlers.test.js`
Expected: FAIL — approvals answer `Vui lòng tải lên chữ ký trước khi phê duyệt`; `approvalAuth` undefined.

- [ ] **Step 3: Change the handlers**

In `api/handlers/vouchers.js`:
1. Header comment lines 8–9 become:
```js
// - Approvals on Postgres: the approver re-enters their login password and the server stamps their
//   registered sample signature (decision 2026-10-07, option D; api/lib/approval/step-up.js).
```
2. Imports: replace the `signature-check.js` import with
```js
import redis from '../../db/redis.js';
import { confirmPassword, stampSignature, verificationRecord } from '../lib/approval/step-up.js';
import { sampleSignatureFor, NO_SAMPLE } from '../lib/approval/signature-check.js';
```
3. `approveOne` signature becomes `async function approveOne({ voucherNumber, approverEmail, approverName, lang })`. Replace the "No registered sample" block with:
```js
    // The registered sample is stamped (no upload, no comparison); none registered → refused
    const open = pendingStep(plan);
    const pendingMine = open >= 0 ? plan.steps[open].approvers.filter((a) => a.email === email && a.status !== 'approved') : [];
    let stamp = { signature: '', from: '' };
    if (pendingMine.length) {
      stamp = await stampSignature(client, row.company_id, pendingMine, email, lang);
      if (!stamp.ok) { await client.query('ROLLBACK'); return { ok: false, error: stamp.message }; }
    }
    const signature = stamp.signature;
```
   then replace the `meta.signatureVerification[key || email] = { verified: verification.verified, … }` line with
```js
    meta.signatureVerification[key || email] = verificationRecord(stamp.from, at);
```
   and the audit `extra: { signatureUploaded: !!signature }` with `extra: { auth: 'password', signatureStamped: !!signature, sampleFrom: stamp.from }`.
4. `handleVoucherApprove`:
```js
export async function handleVoucherApprove(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const v = b.voucher || {};
  if (!v.voucherNumber) return fail(res, msg(lang, 'missingVoucherNo'));
  const actor = await resolveActor(req, res, v.approverEmail, lang);
  if (!actor) return;
  if (!actor.email) return fail(res, msg(lang, 'missingApproverInfo'));
  const pw = await confirmPassword({ db: pool, redis, email: actor.email, password: v.approverPassword, lang });
  if (!pw.ok) return fail(res, pw.message);
  try {
    const r = await approveOne({ voucherNumber: v.voucherNumber, approverEmail: actor.email, approverName: v.approverName, lang });
    // … the rest of the function is unchanged
```
5. `handleVoucherBulkApprove`: delete the `signatureProblem` lines; right after `if (!actor) return;` add
```js
  const pw = await confirmPassword({ db: pool, redis, email: actor.email, password: b.approverPassword, lang }); // once for the batch
  if (!pw.ok) return fail(res, pw.message);
```
   and call `approveOne({ voucherNumber: no, approverEmail: actor.email, approverName: b.approverName, lang })`.
6. `handleVoucherApprovalContext`: add `approvalAuth: 'password',` to `data` (after `sampleFrom`). Update its doc comment: "the sample that will be stamped" instead of "the sample signature to verify against".

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/vouchers/handlers.test.js`
Expected: PASS. Then the whole suite (`npm test` with the same variables) → 0 fail.

- [ ] **Step 5: Commit**

```bash
git add api/handlers/vouchers.js tests/vouchers/handlers.test.js
git commit -m "feat(vouchers): approve on Postgres with the login password; the registered sample is stamped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Purchase requests on Postgres approve with the password and the stamped sample

**Files:**
- Modify: `api/handlers/pr/tx.js`, `api/handlers/pr/decide.js`, `api/handlers/pr/reads.js`, `api/lib/approval/signature-check.js`
- Test: `tests/purchase-requests/decide.test.js`, `tests/purchase-requests/reads.test.js`

**Interfaces:**
- Consumes: `confirmPassword`, `stampSignature`, `verificationRecord` (Task 1); `applyApprove` (`state.js`, unchanged signature).
- Produces:
  - `prDeps(d)` also returns `redis` (default `db/redis.js`).
  - `approvePurchaseRequest` body `{ prNo, approverRole, note?, approverEmail?, approverPassword }`.
  - `getPurchaseRequest` answer: `request.approvalAuth = 'password'` (next to `mySampleSignatureUrl`).
  - `signature-check.js` exports only `ROLE_SAMPLE`, `sampleSignatureFor`, `NO_SAMPLE`.

- [ ] **Step 1: Update the tests first**

In `tests/purchase-requests/decide.test.js`:
1. Imports/setup:
```js
import { PW, FAKE_STAMP, useStepUp } from '../approval/step-up-helpers.js';
import { sampleSignatureFor } from '../../api/lib/approval/signature-check.js';
let redis, cleanupStepUp;
```
In `before`, after `setup()`:
```js
  redis = (await import('../../db/redis.js')).default;
  cleanupStepUp = await useStepUp(pool, redis, [people.treasurer, people.accountant, people.legal, people.ap, 'req@pr-test.vn', 'stranger@x.vn']);
```
`after(async () => { if (cleanupStepUp) await cleanupStepUp(); await teardown(pool); });`
2. Helper: `const approve = (no, who, role, extra = {}) => call(d.handlePRApprove, { prNo: no, approverRole: role, note: '', approverPassword: PW, ...extra }, as(who));` and drop `SIG_OK` from the helpers import.
3. In the first test replace the `budgetSignatureVerification` and `signatureUploaded` assertions with:
```js
  const sample = (await sampleSignatureFor(pool, company.id, null, people.treasurer)).url;
  assert.equal(row.metadata.budgetSignature, FAKE_STAMP(sample), 'the registered sample is stamped on both slots');
  assert.equal(row.metadata.supplierSignature, FAKE_STAMP(sample));
  assert.deepEqual([row.metadata.budgetSignatureVerification.verified, row.metadata.budgetSignatureVerification.method], [true, 'password']);
```
and `assert.equal(audit[0].extra.signatureUploaded, true);` with `assert.deepEqual([audit[0].extra.auth, audit[0].extra.signatureStamped], ['password', true]);`.
4. Delete `NOT_SIGNED` and the three tests `approve needs a signature the browser verified …`, `approve: an approver with no registered sample …` and `approve: "no_sample" claimed …`. Add:

```js
test('approve: password required, wrong one refused, 5th wrong locks; nothing approved meanwhile', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: '' })).message, 'Vui lòng nhập mật khẩu đăng nhập để xác nhận phê duyệt.');
  for (let i = 0; i < 4; i += 1) assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: 'x' })).message, 'Mật khẩu không đúng.');
  assert.equal((await approve(no, people.treasurer, 'budget', { approverPassword: 'x' })).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await approve(no, people.treasurer, 'budget')).message, 'Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.');
  assert.equal((await pr(no)).metadata.budgetStatus, 'Pending');
  await redis.del(`stepup:fail:${people.treasurer}`);
  assert.equal((await approve(no, people.treasurer, 'budget')).success, true);
});

test('approve: an approver with no registered sample is refused (ask an admin)', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const { extra } = (await pool.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [people.ap])).rows[0];
  try {
    await pool.query(`UPDATE employees SET extra = extra - 'Signature' - 'Chữ ký' - 'Chu_ky' - 'employee_signature' - 'Signature_URL' WHERE LOWER(email) = $1`, [people.ap]);
    const r = await approve(no, people.ap, 'purchasing');
    assert.deepEqual([r.success, r.message], [false, 'Chưa có chữ ký mẫu của bạn. Vui lòng nhờ quản trị viên bổ sung trong Dữ liệu gốc (Nhân viên › Signature).']);
    assert.equal((await pr(no)).status, 'Mua hàng (5/5)', 'unchanged');
  } finally {
    await pool.query(`UPDATE employees SET extra = $2 WHERE LOWER(email) = $1`, [people.ap, extra]);
  }
  const ok = await approve(no, people.ap, 'purchasing');
  assert.deepEqual([ok.success, ok.status], [true, 'Hoàn thành'], ok.message);
});

test('approve: the business rules answer before the stamp (not your turn is not a sample problem)', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
});
```
The existing tests that call `approve(no, 'stranger@x.vn', …)` and `approve(no, 'req@pr-test.vn', …)` keep their expected messages: both emails now exist with password `PW`, so the password passes and the PR rules answer.

5. In `tests/purchase-requests/reads.test.js`: replace `approverSignature: 'data:image/png;base64,AAAA', signatureVerification: SIG_OK` with `approverPassword: PW`; in its `before` add `cleanupStepUp = await useStepUp(pool, (await import('../../db/redis.js')).default, [people.treasurer, people.ap]);` and call `cleanupStepUp()` in `after` before `teardown`; add one assertion where the test reads a PR detail as the pending approver: `assert.equal(detail.request.approvalAuth, 'password');` (use the variable that holds that detail answer). Drop `SIG_OK` from the import. If `SIG_OK` is now unused in `tests/purchase-requests/helpers.js`, delete it there.

- [ ] **Step 2: Run them to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/purchase-requests/decide.test.js tests/purchase-requests/reads.test.js`
Expected: FAIL (`SyntaxError`/import error for `signatureProblem`, or `Vui lòng tải lên chữ ký trước khi phê duyệt`).

- [ ] **Step 3: Change the handlers**

`api/handlers/pr/tx.js`: `import redis from '../../../db/redis.js';` and add `redis,` to the object `prDeps` returns (before `...d`, so tests can override it).

`api/handlers/pr/decide.js`: imports become
```js
import { STATUS, isRole, BAD_ROLE, applyApprove, applyReject, sendBackInputError, applySendBack, pendingEmails } from '../../lib/purchase-requests/state.js';
import { updatePR, recordChange } from '../../lib/purchase-requests/repo.js';
import { purchasingRequest, completed, rejectedNotice, sendBackNotices } from '../../lib/purchase-requests/emails.js';
import { fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { confirmPassword, stampSignature, verificationRecord } from '../../lib/approval/step-up.js';
import { prDeps, withLockedPR } from './tx.js';
```
(delete `verificationText`), and `handlePRApprove` becomes:
```js
export async function handlePRApprove(req, res, d) {
  const { db, redis, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  if (!isRole(b.approverRole)) return fail(res, BAD_ROLE);
  // Decision 2026-10-07 (option D): the login password confirms who approves; the server stamps the registered sample.
  const pw = await confirmPassword({ db, redis, email: caller.email, password: b.approverPassword, lang: 'vi' });
  if (!pw.ok) return fail(res, pw.message);
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const base = { email: caller.email, role: b.approverRole, note: b.note || '', at };
    const check = applyApprove(row, row.metadata || {}, base); // GAS rules first: turn, assignment, status
    if (check.error) return check;
    const stamp = await stampSignature(client, row.company_id, null, caller.email, 'vi');
    if (!stamp.ok) return { error: stamp.message };
    const r = applyApprove(row, row.metadata || {}, { ...base, signature: stamp.signature, verification: verificationRecord(stamp.from, at) });
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: r.status, pending_emails: pendingEmails(row, r.meta, r.status) });
    const extra = { auth: 'password', signatureStamped: true, sampleFrom: stamp.from };
    await recordChange(client, saved, r.roles.map((role) => ({ action: 'Approve', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note: b.note || '', extra, at })));
    const mails = [];
    if (r.after.stage === 'purchasing' && r.before.stage !== 'purchasing') mails.push(purchasingRequest(saved)); // both branches (B2)
    if (r.after.stage === 'complete') mails.push(completed(saved));
    return { saved, mails, message: 'Đã duyệt thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
}
```
`parseVerification` stays exported from `state.js` (old rows and `applyApprove` still use it). `signatureFormatOk`/`BAD_SIGNATURE` stay in `validate.js` for the requester signature at submit.

In `api/lib/approval/signature-check.js`: delete `MSG` and `signatureProblem`, and make the header comment:
```js
// api/lib/approval/signature-check.js — which registered sample signature belongs to an approver.
// On Postgres the server stamps this sample on the approval after a password check (step-up.js);
// the old browser image comparison and its verified === true rule are gone. Old approvals keep their
// stored signatureVerification objects. Takes `db` as an argument (no pool import).
```

`api/handlers/pr/reads.js` `handlePRDetail`: the comment above `pending` becomes `// The sample the server will stamp when this caller approves ('' = none registered → approval refused, null = not their turn)`, and the answer `{ request: { ...fullFromRow(row), mySampleSignatureUrl, approvalAuth: 'password' } }`.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`
Expected: 0 fail. `grep -rn "signatureProblem\|signatureVerification: SIG_OK" api tests` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add api/handlers/pr/tx.js api/handlers/pr/decide.js api/handlers/pr/reads.js api/lib/approval/signature-check.js tests/purchase-requests/decide.test.js tests/purchase-requests/reads.test.js tests/purchase-requests/helpers.js
git commit -m "feat(pr): approve on Postgres with the login password; the registered sample is stamped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Pages ask for the password on Postgres (upload/compare hidden on Postgres only)

**Files:**
- Create: `approval-password.js`, `tests/approval/approval-password.test.js`
- Modify: `i18n.js`, `approve_voucher.html`, `voucher.html`, `purchase_request.html`

**Interfaces:**
- Consumes: the server answers of Tasks 2–3 (`approvalAuth`, `approverPassword`), `pgApi` (voucher.html), `VoucherSteps.onPostgres`, `TLCI18n.t` (optional).
- Produces: `window.ApprovalPassword = { ask(opts) → Promise<string|null>, valid(pw) → boolean, MAX: 200 }`; page functions `approveVoucherWithPassword()` (approve_voucher.html), `approveFromModalWithPassword()`, `bulkApproveWithPassword(voucherNumbers, user)` (voucher.html), `approvePRWithPassword(prNo, role)` (purchase_request.html).

- [ ] **Step 1: Write the failing test**

```js
// tests/approval/approval-password.test.js — the browser password prompt, loaded like a plain <script>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), sandbox);
const AP = sandbox.self.ApprovalPassword;

test('ApprovalPassword: defines ask(); valid() accepts 1–200 characters, never trims', () => {
  assert.equal(typeof AP.ask, 'function');
  assert.equal(AP.MAX, 200);
  assert.equal(AP.valid(''), false);
  assert.equal(AP.valid(null), false);
  assert.equal(AP.valid(' '), true, 'spaces are part of a password');
  assert.equal(AP.valid('Test#2026'), true);
  assert.equal(AP.valid('x'.repeat(200)), true);
  assert.equal(AP.valid('x'.repeat(201)), false);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test tests/approval/approval-password.test.js`
Expected: FAIL — `ENOENT … approval-password.js`.

- [ ] **Step 3: Write the prompt**

```js
// approval-password.js — Postgres approvals: ask the approver for their login password (decision 2026-10-07, option D).
// Plain <script>, no dependencies, its own overlay (no page HTML touched). GAS pages never call it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApprovalPassword = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 200;

  function t(key, fallback) {
    var i18n = typeof TLCI18n !== 'undefined' ? TLCI18n : null;
    return i18n && i18n.t ? i18n.t(key, fallback) : fallback;
  }

  function valid(pw) { return typeof pw === 'string' && pw.length > 0 && pw.length <= MAX; }

  /** Resolves the typed password, or null when cancelled. opts.count > 1 shows the number of documents (bulk). */
  function ask(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var doc = document;
      var overlay = doc.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'apw-title');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;';
      overlay.innerHTML =
        '<form style="background:#fff;color:#0f172a;border-radius:12px;max-width:380px;width:100%;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:14px system-ui,sans-serif;">' +
          '<h3 id="apw-title" style="margin:0 0 8px;font-size:16px;"></h3>' +
          '<p id="apw-hint" style="margin:0 0 12px;color:#475569;line-height:1.4;"></p>' +
          '<label for="apw-input" id="apw-label" style="display:block;font-weight:600;margin-bottom:4px;"></label>' +
          '<input id="apw-input" type="password" autocomplete="current-password" maxlength="' + MAX + '" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
            '<button type="button" id="apw-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;"></button>' +
            '<button type="submit" id="apw-ok" style="padding:8px 16px;border-radius:8px;border:none;background:#0056CC;color:#fff;cursor:pointer;"></button>' +
          '</div>' +
        '</form>';
      var count = opts.count > 1 ? ' (' + opts.count + ')' : '';
      overlay.querySelector('#apw-title').textContent = t('apwTitle', 'Xác nhận phê duyệt') + count;
      overlay.querySelector('#apw-hint').textContent = t('apwHint', 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.');
      overlay.querySelector('#apw-label').textContent = t('apwLabel', 'Mật khẩu đăng nhập');
      overlay.querySelector('#apw-cancel').textContent = t('apwCancel', 'Hủy');
      overlay.querySelector('#apw-ok').textContent = t('apwConfirm', 'Duyệt');
      var input = overlay.querySelector('#apw-input');
      function onKey(e) { if (e.key === 'Escape') done(null); }
      function done(value) {
        doc.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      overlay.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        if (valid(input.value)) done(input.value); else input.focus();
      });
      overlay.querySelector('#apw-cancel').addEventListener('click', function () { done(null); });
      doc.addEventListener('keydown', onKey);
      doc.body.appendChild(overlay);
      input.focus();
    });
  }

  return { ask: ask, valid: valid, MAX: MAX };
});
```

In `i18n.js`, add to the shared `vi` table:
```js
      apwTitle: 'Xác nhận phê duyệt',
      apwHint: 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.',
      apwLabel: 'Mật khẩu đăng nhập',
      apwConfirm: 'Duyệt',
      apwCancel: 'Hủy',
```
and to the `en` table:
```js
      apwTitle: 'Confirm approval',
      apwHint: 'Enter your login password. Your registered sample signature will be stamped on the document.',
      apwLabel: 'Login password',
      apwConfirm: 'Approve',
      apwCancel: 'Cancel',
```

- [ ] **Step 4: approve_voucher.html (Postgres only)**

1. After `<script src="voucher-steps.js"></script>` add `<script src="approval-password.js"></script>`.
2. In `initPgContext()`, right after `pgContext = json.data;`:
```js
            if (pgContext.approvalAuth === 'password') {
                // Postgres: no upload or comparison; the password confirms it is me and the server stamps my registered sample
                document.getElementById('signature-section').style.display = 'none';
            }
```
3. First line of `approveVoucher()`:
```js
            if (pgContext && pgContext.approvalAuth === 'password') return approveVoucherWithPassword();
```
4. New function next to `approveVoucher()`:
```js
        /** Postgres: the login password confirms the approval; the server stamps the registered sample. */
        async function approveVoucherWithPassword() {
            const password = await ApprovalPassword.ask({});
            if (password === null) return;
            document.getElementById('loading').classList.add('show');
            document.querySelector('.button-group').style.display = 'none';
            document.getElementById('approve-btn').disabled = true;
            let result;
            try {
                const formData = new FormData();
                formData.append('data', JSON.stringify({ action: 'approveVoucher',
                    voucher: { voucherNumber: voucherNumber, approverEmail: approverEmail, approverPassword: password } }));
                const response = await fetch(GOOGLE_APPS_SCRIPT_WEB_APP_URL, { method: 'POST', body: formData });
                result = await response.json();
            } catch (e) {
                result = { success: false, message: 'Lỗi kết nối: ' + e.message };
            }
            document.getElementById('loading').classList.remove('show');
            if (result && result.success) {
                showMessage(result.message || 'Đã phê duyệt thành công.', 'success');
                setTimeout(() => { window.close(); }, 3000);
                return;
            }
            showMessage('Lỗi: ' + ((result && result.message) || 'Có lỗi xảy ra khi phê duyệt'), 'error');
            document.querySelector('.button-group').style.display = 'flex';
            document.getElementById('approve-btn').disabled = false;
        }
```

- [ ] **Step 5: voucher.html (Postgres only)**

1. After `<script src="voucher-steps.js"></script>` add `<script src="approval-password.js"></script>`.
2. Modal approver signature block: the condition `if ((vStateForSig.bucket === 'pending' || vStateForSig.bucket === 'in-progress') && (!isRequester || isAlsoCurrentApprover)) {` gains `&& !(window.__vouchersOnPostgres || VoucherSteps.onPostgres(voucher))` (Postgres: nothing to upload).
3. `openBulkApproveModal()`, before `overlay.classList.add('show');`:
```js
            // Postgres: the password is asked on confirm; no signature upload
            const pgBulk = !!window.__vouchersOnPostgres;
            const sigSection = document.getElementById('bulk-signature-section');
            sigSection.style.display = pgBulk ? 'none' : '';
            if (sigSection.previousElementSibling) sigSection.previousElementSibling.textContent = pgBulk
                ? 'Bạn sẽ nhập mật khẩu đăng nhập một lần để xác nhận. Hệ thống đóng chữ ký mẫu đã đăng ký của bạn lên các phiếu.'
                : 'Vui lòng tải lên chữ ký của bạn để xác nhận phê duyệt tất cả các phiếu đã chọn.';
```
4. `approveFromModal()`: right after `if (!currentModalVoucher) return;` add
```js
            if (window.__vouchersOnPostgres || VoucherSteps.onPostgres(currentModalVoucher)) return approveFromModalWithPassword();
```
5. `bulkApproveSelected()`: right after the block that checks `user` (before `// 1. Require signature`) add
```js
            if (window.__vouchersOnPostgres) return bulkApproveWithPassword(voucherNumbers, user);
```
6. New functions after `bulkApproveSelected()`:
```js
        /** Postgres: one password for the selected vouchers, one request; the server stamps each approval. */
        async function bulkApproveWithPassword(voucherNumbers, user) {
            const password = await ApprovalPassword.ask({ count: voucherNumbers.length });
            if (password === null) return;
            const confirmBtn = document.getElementById('bulk-modal-confirm-btn');
            if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Đang duyệt...'; }
            try {
                const result = await pgApi('bulkApprove', { voucherNumbers: voucherNumbers, approverEmail: user.email,
                    approverName: user.name || user.email, approverPassword: password });
                if (!result.success) { showToast(result.message || 'Lỗi duyệt hàng loạt', 'error'); return; }
                const failed = (result.data && result.data.failed) || [];
                showToast(result.message, 'success');
                if (failed.length) {
                    const MAX_SHOWN = 5;
                    const detail = failed.slice(0, MAX_SHOWN).map(f => `${f.voucherNumber}: ${f.error}`).join('<br>') +
                        (failed.length > MAX_SHOWN ? `<br>...và ${failed.length - MAX_SHOWN} phiếu khác` : '');
                    showToast(detail, 'warning', `${failed.length} phiếu chưa duyệt được`);
                }
                clearBulkSelection();
                document.getElementById('bulk-approve-modal-overlay').classList.remove('show');
                loadRecentVouchers(true);
            } catch (err) {
                showToast('Lỗi kết nối khi duyệt: ' + err.message, 'error');
            } finally {
                if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Xác nhận Duyệt'; }
            }
        }

        /** Postgres: approve the open voucher with the login password; the server stamps the registered sample. */
        async function approveFromModalWithPassword() {
            const no = currentModalVoucher.voucherNumber;
            const password = await ApprovalPassword.ask({});
            if (password === null) return;
            const modalLoading = document.getElementById('modal-loading');
            const modalContent = document.getElementById('modal-content');
            const modalFooter = document.getElementById('modal-footer');
            modalLoading.classList.add('show');
            modalContent.style.opacity = '0.5';
            modalFooter.querySelectorAll('button').forEach(btn => btn.disabled = true);
            try {
                const result = await pgApi('approveVoucher', { voucher: { voucherNumber: no, approverEmail: getCurrentUserEmail() || '',
                    approverName: getCurrentUserName() || '', approverPassword: password } });
                modalLoading.classList.remove('show');
                modalContent.style.opacity = '1';
                if (result.success) {
                    showToast(result.message || 'Đã phê duyệt phiếu thành công!', 'success');
                    voucherHistoryCache.delete(no);
                    closeVoucherModal();
                    loadRecentVouchers(true);
                } else {
                    showToast(result.message || 'Lỗi phê duyệt', 'error');
                    modalFooter.querySelectorAll('button').forEach(btn => btn.disabled = false);
                }
            } catch (error) {
                modalLoading.classList.remove('show');
                modalContent.style.opacity = '1';
                modalFooter.querySelectorAll('button').forEach(btn => btn.disabled = false);
                showToast('Lỗi khi phê duyệt: ' + error.message, 'error');
            }
        }
```

- [ ] **Step 6: purchase_request.html (Postgres only; Step 1 untouched)**

1. After `<script src="i18n.js"></script>` add `<script src="approval-password.js"></script>`.
2. In the drawer actions render, inside `if (approveRole) {`, before `actionsHtml += \``, add
```js
            const pwMode = !!(_prDetail && _prDetail.prNo === pr.prNo && _prDetail.approvalAuth === 'password');
```
   and wrap the `<div style="width:100%;border:1px dashed #cbd5e1;…">…</div>` signature block of that template literal in `${pwMode ? '' : `…the existing block unchanged…`}`. The three buttons stay as they are.
3. `approvePR()`: right after `if (!myEmail) { … return; }` add
```js
        // Postgres: the login password confirms the approval and the server stamps the registered sample
        if (_prDetail && _prDetail.prNo === prNo && _prDetail.approvalAuth === 'password') return approvePRWithPassword(prNo, role);
```
4. New function after `approvePR()`:
```js
    async function approvePRWithPassword(prNo, role) {
        const password = await ApprovalPassword.ask({});
        if (password === null) return;
        try {
            const params = new URLSearchParams({ action: 'approvePurchaseRequest', prNo, approverRole: role, note: '', approverPassword: password });
            const res = await fetch(BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
            const result = JSON.parse(await res.text());
            if (result.success) {
                showToast('✅ Đã duyệt thành công!', 'success');
                _patchLocalPR(prNo, result.data?.status, { [role + 'Status']: 'Approved' });
                _redrawOpenPR(prNo);
            } else {
                showToast(result.message || 'Lỗi khi duyệt.', 'error');
            }
        } catch (err) {
            showToast('Lỗi kết nối: ' + err.message, 'error');
        }
    }
```

- [ ] **Step 7: Run the tests and check the pages load**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail.
Open each page once with the dev server (any mode) and check the browser console has no syntax error (`node -e` cannot parse inline scripts; the Task 7 e2e covers behaviour).

- [ ] **Step 8: Commit**

```bash
git add approval-password.js i18n.js approve_voucher.html voucher.html purchase_request.html tests/approval/approval-password.test.js
git commit -m "feat(pages): approve with the login password on Postgres; signature upload hidden there only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Exchange-rate storage, Master Data admin UI and audit

**Files:**
- Create: `db/migrations/008_exchange_rates.sql`, `tests/admin/exchange-rates.test.js`
- Modify: `api/lib/master-registry.js`, `api/handlers/admin-master.js`, `scripts/import-master-sheets.js`, `api/router.js`, `api/lib/startup-checks.js`, `admin.html`, `tests/server/startup.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `clearMasterDataCache` (`admin-employees.js`); the registry helpers.
- Produces:
  - Tables `exchange_rates(id, currency, rate_to_vnd, extra, sheet_row, updated_at)`, `master_audit(id, table_key, row_id, column_name, old_value, new_value, actor_email, created_at)`; columns `purchase_requests.fx_rate NUMERIC(18,6)`, `purchase_requests.grand_total_vnd NUMERIC(20,2)`.
  - Registry entry `MASTER_TABLES.exchange_rates` with `sheet: null`, `readOnly: ['Currency']`, `audit: true`.
  - `adminMasterTables` rows gain `audit`; `adminMasterGet` columns gain `readOnly`, `table` gains `audit`.
  - `adminMasterAudit { table } → { success, data: { entries: [{ rowId, column, oldValue, newValue, actorEmail, at }] } }` (newest first, max 200).
  - `missingP2PSchema` also requires `exchange_rates`.

- [ ] **Step 1: Write the migration and apply it**

```sql
-- db/migrations/008_exchange_rates.sql — admin exchange rates for the PR VND threshold, master-data audit,
-- and the rate/VND total stored on each PR (Plan 5b, 2026-10-07). Safe to re-run:
--   psql tlcg_workflow -f db/migrations/008_exchange_rates.sql
-- exchange_rates is app-only (not a Google Sheet tab): it is edited in admin.html › Master Data and
-- never imported by scripts/import-master-sheets.js. VND is the base and is never stored.
BEGIN;
CREATE TABLE IF NOT EXISTS exchange_rates (
  id          SERIAL PRIMARY KEY,
  currency    TEXT NOT NULL UNIQUE CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'VND'),
  rate_to_vnd NUMERIC(18,6) CHECK (rate_to_vnd IS NULL OR rate_to_vnd > 0), -- NULL = no rate yet: PR submit refused
  extra       JSONB NOT NULL DEFAULT '{}',
  sheet_row   INT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO exchange_rates (currency, sheet_row) VALUES ('USD', 1), ('EUR', 2) ON CONFLICT (currency) DO NOTHING;

-- Who changed a master value, from what to what (tables with audit: true in the registry)
CREATE TABLE IF NOT EXISTS master_audit (
  id          BIGSERIAL PRIMARY KEY,
  table_key   TEXT NOT NULL,
  row_id      INT NOT NULL,
  column_name TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  actor_email TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS master_audit_table_idx ON master_audit (table_key, id DESC);

-- The rate used and the VND total at submit/resubmit (NULL on rows imported from GAS)
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS fx_rate         NUMERIC(18,6);
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS grand_total_vnd NUMERIC(20,2);
COMMIT;
```

Run `psql tlcg_v_test -f db/migrations/008_exchange_rates.sql` → `BEGIN … COMMIT`; run it again → `COMMIT` with "already exists" notices.

- [ ] **Step 2: Write the failing tests**

```js
// tests/admin/exchange-rates.test.js — exchange rates in Master Data: rules, read-only currency, audit (DB)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
let h, pool, auth, usd;
const call = (fn, body) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
  Promise.resolve(fn({ body, query: {}, headers: { authorization: auth } }, res)).catch(reject);
});
const set = (column, value) => call(h.handleAdminMasterUpdateCell, { table: 'exchange_rates', id: usd, column, value });

before(async () => {
  if (!url) return;
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  h = await import('../../api/handlers/admin-master.js');
  pool = (await import('../../db/pool.js')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { rows } = await pool.query(`INSERT INTO employees (full_name, email, status, is_admin) VALUES ('FX Admin', 'fx-admin@test.vn', 'active', TRUE)
    ON CONFLICT (email) DO UPDATE SET is_admin = TRUE, status = 'active' RETURNING id`);
  auth = 'Bearer ' + jwt.sign({ id: rows[0].id }, process.env.JWT_SECRET || 'dev-secret-change-in-production');
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL, extra = '{}' WHERE currency IN ('USD', 'EUR')`);
  await pool.query(`DELETE FROM master_audit WHERE table_key = 'exchange_rates'`);
  usd = (await pool.query(`SELECT id FROM exchange_rates WHERE currency = 'USD'`)).rows[0].id;
});
after(async () => {
  if (!pool) return;
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL, extra = '{}'`);
  await pool.query(`DELETE FROM employees WHERE email = 'fx-admin@test.vn'`);
  await pool.end();
  (await import('../../db/redis.js')).default.quit?.();
});

test('exchange rates are listed and read like the sheet tables; USD and EUR seeded without a rate', { skip }, async () => {
  const t = await call(h.handleAdminMasterTables, {});
  const fx = t.data.tables.find((x) => x.key === 'exchange_rates');
  assert.deepEqual([fx.title, fx.sheet, fx.audit], ['Exchange rates', null, true]);
  assert.equal(t.data.tables.find((x) => x.key === 'companies').audit, false);
  const g = await call(h.handleAdminMasterGet, { table: 'exchange_rates' });
  assert.deepEqual(g.data.columns.map((c) => [c.name, c.readOnly]), [['Currency', true], ['Rate_To_VND', false]]);
  assert.equal(g.data.table.audit, true);
  assert.deepEqual(g.data.rows.map((r) => r.v), [['USD', ''], ['EUR', '']]);
});

test('a rate must be a number of at least 1; the currency cannot be edited', { skip }, async () => {
  assert.equal((await set('Rate_To_VND', '')).message, 'Ô này không được để trống.');
  assert.equal((await set('Rate_To_VND', 'abc')).message, 'Cần nhập số.');
  assert.equal((await set('Rate_To_VND', '0')).message, 'Không được nhỏ hơn 1.');
  assert.equal((await set('Rate_To_VND', '-5')).message, 'Không được nhỏ hơn 1.');
  assert.equal((await set('Currency', 'GBP')).message, 'Cột này không sửa ở đây.');
  const ok = await set('Rate_To_VND', '26,000');
  assert.equal(ok.success, true, ok.message);
  assert.equal(Number((await pool.query(`SELECT rate_to_vnd FROM exchange_rates WHERE id = $1`, [usd])).rows[0].rate_to_vnd), 26000);
});

test('every saved change is audited (who, old, new), newest first; refused edits are not', { skip }, async () => {
  await set('Rate_To_VND', '26500');
  const a = await call(h.handleAdminMasterAudit, { table: 'exchange_rates' });
  assert.equal(a.success, true, a.message);
  assert.deepEqual(a.data.entries.map((e) => [e.rowId, e.column, e.oldValue, e.newValue, e.actorEmail]), [
    [usd, 'Rate_To_VND', '26,000', '26500', 'fx-admin@test.vn'],
    [usd, 'Rate_To_VND', '', '26,000', 'fx-admin@test.vn'],
  ]);
  assert.ok(a.data.entries.every((e) => e.at));
  assert.equal((await call(h.handleAdminMasterAudit, { table: 'companies' })).message, 'Bảng này không lưu lịch sử thay đổi.');
});
```

In `tests/server/startup.test.js` change `fakeDb2` and add a case:
```js
const fakeDb2 = (t, o, x = 'exchange_rates') => ({ query: async () => ({ rows: [{ t, o, x }] }) });
test('missingP2PSchema: p2p on without migration 008 → names the file', async () => {
  assert.match(await missingP2PSchema(['p2p'], fakeDb2('purchase_order_types', 'sheet_outbox', null)), /008_exchange_rates\.sql/);
});
```
and rename the real-database test to `… has migrations 006, 007 and 008`.

- [ ] **Step 3: Run them to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/admin/exchange-rates.test.js tests/server/startup.test.js`
Expected: FAIL — `exchange_rates` not in the tables list; `handleAdminMasterAudit` is not a function; startup 008 case returns null.

- [ ] **Step 4: Registry entry**

In `api/lib/master-registry.js`, append to `MASTER_TABLES` (after `goods`), and document the two new keys in the file header (`readOnly`: shown, never edited; `audit`: every change written to `master_audit`; `sheet: null`: app-only, never imported):
```js
  // App-only (no Google Sheet tab): the PR full-branch threshold is 2,000,000 VND (decision 2026-10-07);
  // other currencies are converted with these rates. A row without a rate refuses PR submits in that currency.
  exchange_rates: {
    title: 'Exchange rates',
    sheet: null,
    gid: null,
    table: 'exchange_rates',
    core: {
      Currency:    { col: 'currency', type: required },
      Rate_To_VND: { col: 'rate_to_vnd', type: number },
    },
    hidden: [],
    locked: [],
    readOnly: ['Currency'],
    audit: true,
    rules: {
      Currency: { type: 'pattern', pattern: '^[A-Z]{3}$', example: 'USD', upper: true, required: true },
      Rate_To_VND: { type: 'number', min: 1, required: true },
    },
  },
```

- [ ] **Step 5: Admin handler changes**

In `api/handlers/admin-master.js`:
1. `visibleColumns`: add `readOnly: (def.readOnly || []).includes(c.name),` to each column object.
2. `handleAdminMasterTables`: replace the counting with a version that skips a table whose migration is missing (`42P01`), and send `audit`:
```js
    const entries = Object.entries(MASTER_TABLES);
    const counts = await Promise.all(entries.map(([, def]) =>
      pool.query(`SELECT COUNT(*)::int AS n FROM ${def.table}`).then((r) => r.rows[0].n)
        .catch((e) => { if (e.code === '42P01') return null; throw e; }))); // table of a migration not applied yet
    return res.json({
      success: true,
      data: {
        tables: entries.map(([key, def], i) => ({ key, title: def.title, sheet: def.sheet, audit: !!def.audit, rows: counts[i] }))
          .filter((t) => t.rows !== null),
      },
    });
```
3. `handleAdminMasterGet`: `table: { key, title: def.title, sheet: def.sheet, audit: !!def.audit },`.
4. Replace `handleAdminMasterUpdateCell` with this version (same checks and messages as today, plus read-only columns and the audit row in the same transaction):
```js
/** Write one checked value on `q` (pool or transaction client). Returns { value } | { error }. */
async function writeCell(q, key, def, id, column, clean, admin) {
  const core = def.core[column];
  if (!core) {
    const { rowCount } = await q.query(
      `UPDATE ${def.table} SET extra = jsonb_set(extra, ARRAY[$1::text], to_jsonb($2::text), true), updated_at = NOW() WHERE id = $3`,
      [column, clean, id]);
    return rowCount ? { value: clean } : { error: 'Không tìm thấy dòng.' };
  }
  let value;
  try { value = core.type.parse(clean); } catch (e) { return { error: e.message }; }
  if (key === 'employees' && id === admin.id) {
    if (core.col === 'is_admin' && !value) return { error: 'Không thể tự bỏ quyền quản trị của mình.' };
    if (core.col === 'status' && value !== 'active') return { error: 'Không thể tự vô hiệu hoá tài khoản của mình.' };
  }
  // Keep the text as typed beside the typed value (see coreCellValue)
  const { rows } = await q.query(
    `UPDATE ${def.table}
        SET ${core.col} = $1, extra = jsonb_set(extra, ARRAY[$3::text], to_jsonb($4::text), true), updated_at = NOW()
      WHERE id = $2
      RETURNING ${core.col}`,
    [value, id, column, clean]);
  return rows[0] ? { value: coreCellValue(core, clean, rows[0][core.col]) } : { error: 'Không tìm thấy dòng.' };
}

/** adminMasterUpdateCell — edit one value. Typed columns are validated; audited tables log who changed what. */
export async function handleAdminMasterUpdateCell(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  const id = parseInt(req.body.id, 10);
  const column = String(req.body.column || '');
  const raw = req.body.value == null ? '' : String(req.body.value);
  if (!id || !column) return res.json({ success: false, message: 'Thiếu thông tin.' });
  if (def.hidden.includes(column) || (def.readOnly || []).includes(column)) return res.json({ success: false, message: 'Cột này không sửa ở đây.' });

  let client = null;
  try {
    const names = await loadColumns(key, def);
    if (!names.includes(column)) return res.json({ success: false, message: 'Cột không tồn tại.' });

    // Column rule first (allowed values / format), then the typed column's own parse
    const checked = checkRule(columnRule(def, column), raw);
    if (!checked.ok) return res.json({ success: false, message: checked.message });

    let out;
    if (def.audit) {
      client = await pool.connect();
      await client.query('BEGIN');
      const before = (await client.query(`SELECT id, extra, ${coreColumns(def).join(', ')} FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      out = before ? await writeCell(client, key, def, id, column, checked.value, admin) : { error: 'Không tìm thấy dòng.' };
      if (out.error) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          `INSERT INTO master_audit (table_key, row_id, column_name, old_value, new_value, actor_email) VALUES ($1, $2, $3, $4, $5, $6)`,
          [key, id, column, cellValue(def, before, column), out.value, admin.email]);
        await client.query('COMMIT');
      }
    } else {
      out = await writeCell(pool, key, def, id, column, checked.value, admin);
    }
    if (out.error) return res.json({ success: false, message: out.error });

    clearMasterDataCache();
    console.log(`[AdminMaster] ${admin.email} set ${key}#${id}.${column}`);
    return res.json({ success: true, data: { value: out.value } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.json({ success: false, message: 'Giá trị này đã tồn tại ở dòng khác.' });
    console.error('[AdminMaster] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    if (client) client.release();
  }
}

/** adminMasterAudit — the last 200 changes of an audited table, newest first. */
export async function handleAdminMasterAudit(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  if (!t.def.audit) return res.json({ success: false, message: 'Bảng này không lưu lịch sử thay đổi.' });
  try {
    const { rows } = await pool.query(
      `SELECT row_id, column_name, old_value, new_value, actor_email, created_at FROM master_audit
        WHERE table_key = $1 ORDER BY id DESC LIMIT 200`, [t.key]);
    return res.json({ success: true, data: { entries: rows.map((r) => ({ rowId: r.row_id, column: r.column_name,
      oldValue: r.old_value, newValue: r.new_value, actorEmail: r.actor_email, at: r.created_at })) } });
  } catch (err) {
    console.error('[AdminMaster] audit error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}
```

`api/router.js`: import `handleAdminMasterAudit` and add `adminMasterAudit: handleAdminMasterAudit,` after `adminMasterRenameColumn`.

`scripts/import-master-sheets.js` `main()`:
```js
  const sheetKeys = Object.keys(MASTER_TABLES).filter((k) => MASTER_TABLES[k].sheet); // app-only tables (exchange_rates) are never imported
  const keys = ONLY.length ? ONLY : sheetKeys;
  for (const k of keys) if (!MASTER_TABLES[k] || !MASTER_TABLES[k].sheet) throw new Error(`Unknown table "${k}". Use: ${sheetKeys.join(', ')}`);
```

`api/lib/startup-checks.js` `missingP2PSchema`:
```js
    const { rows } = await db.query(`SELECT to_regclass('public.purchase_order_types') AS t, to_regclass('public.sheet_outbox') AS o,
      to_regclass('public.exchange_rates') AS x`);
    const r = rows[0] || {};
    if (!r.t) return 'PG_WORKFLOWS includes p2p but migration 007 is missing: run db/migrations/007_purchase_requests.sql';
    if (!r.o) return 'PG_WORKFLOWS includes p2p but table sheet_outbox does not exist: run db/migrations/006_sheet_outbox.sql';
    if (!r.x) return 'PG_WORKFLOWS includes p2p but migration 008 is missing: run db/migrations/008_exchange_rates.sql';
    return null;
```
and its doc comment: `p2p on Postgres needs migrations 007 and 008 (and 006 for its Sheet copy).`

- [ ] **Step 6: admin.html**

1. Toolbar in `renderShell()`: after the `+ Column` button add
```js
          '<button class="btn btn-ghost" id="audit-btn" type="button" hidden>History</button>' +
```
   and with the other listeners: `document.getElementById('audit-btn').addEventListener('click', showAudit);`
2. In `openTab()`, after `state.data = cache[key];`: `document.getElementById('audit-btn').hidden = !state.data.table.audit;`
3. First lines of `startEdit(cell)`, after `const col = state.data.columns[j];`:
```js
    if (col.readOnly) return showHint(cell, 'This value is fixed. It is used by the app.', true);
```
4. New function next to `addColumn`:
```js
  /** Who changed what in an audited table (exchange rates). */
  async function showAudit() {
    let data;
    try { data = await api('adminMasterAudit', { table: state.tab }); } catch (err) { return handleError(err); }
    const label = (id) => { const r = state.data.rows.find((x) => x.id === id); return r ? rowLabel(r) : '#' + id; };
    const rows = data.entries.map((e) => '<tr><td>' + esc(new Date(e.at).toLocaleString()) + '</td><td>' + esc(label(e.rowId)) + '</td><td>' +
      esc(formatLabel(e.column)) + '</td><td>' + esc(e.oldValue || '—') + ' → ' + esc(e.newValue || '—') + '</td><td>' + esc(e.actorEmail) + '</td></tr>').join('');
    await ask({
      title: 'History — ' + state.data.table.title,
      html: data.entries.length
        ? '<div style="overflow-x:auto"><table class="grid"><thead><tr><th>When</th><th>Row</th><th>Column</th><th>Change</th><th>By</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<p>No changes yet.</p>',
      buttons: [{ text: 'Close', value: null, kind: 'ghost' }],
    });
  }
```
   (`api`, `esc`, `rowLabel`, `formatLabel`, `ask`, `handleError` already exist in the page.) The rate edit itself goes through the existing click-to-edit → review → confirm flow; nothing else changes.

- [ ] **Step 7: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail.

- [ ] **Step 8: Commit**

```bash
git add db/migrations/008_exchange_rates.sql api/lib/master-registry.js api/handlers/admin-master.js scripts/import-master-sheets.js \
  api/router.js api/lib/startup-checks.js admin.html tests/admin/exchange-rates.test.js tests/server/startup.test.js
git commit -m "feat(admin): exchange rates in Master Data (app-only table, read-only currency, audited edits)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The PR branch on the VND total, with the stored rate

**Files:**
- Create: `api/lib/fx/rates.js`, `fx-branch.js`, `tests/purchase-requests/fx.test.js`, `tests/purchase-requests/fx-branch.test.js`
- Modify: `api/lib/purchase-requests/state.js`, `api/lib/purchase-requests/validate.js`, `api/lib/purchase-requests/repo.js`, `api/handlers/pr/submit.js`, `api/handlers/pr/reads.js`, `api/router.js`, `purchase_request.html`, `tests/purchase-requests/validate.test.js`, `tests/purchase-requests/state.test.js`, `tests/server/router-p2p.test.js`

**Interfaces:**
- Consumes: `exchange_rates`, `purchase_requests.fx_rate` / `grand_total_vnd` (Task 5).
- Produces:
  - `normalizeCurrency(c) → 'VND' | 'USD' | … | ''` ('' = invalid), `getRateToVnd(db, currency) → Promise<number|null>` (1 for VND), `listRates(db) → Promise<{ [currency]: number|null }>`, `toVnd(total, rate) → number`, `missingRateMessage(cur) → string`, `BAD_CURRENCY`.
  - `FULL_BRANCH_MIN_VND = 2000000`, `computeBranch(purchaseType, grandTotalVnd)`, `branchOf(row) → 'full'|'simplified'`, `directPaymentProblem(row)` (uses `branchOf`).
  - `checkSubmission(b, fx?)` with `fx = { currency, rateToVnd }`; result gains `currency`, `rateToVnd`, `grandTotalVnd`.
  - `WRITABLE` gains `fx_rate`, `grand_total_vnd`.
  - `handleExchangeRates(req, res, d)` → `{ success, base: 'VND', rates: { USD: 26000, EUR: null } }` (login required); action `getExchangeRates` under `p2p`.
  - Browser: `window.FxBranch = { toVnd(total, currency, rates) → number|null, branch(purchaseType, total, currency, rates) → 'full'|'simplified', FULL_MIN_VND }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/purchase-requests/validate.test.js` (add `checkSubmission` to its import if missing):
```js
const fxBody = (over = {}) => ({ companyName: 'C', requesterName: 'R', requiredDate: '2026-10-20', budgetApprover: 'b@x.vn',
  supplierApprover: 's@x.vn', purchaseType: 'goods', items: JSON.stringify([{ desc: 'A', qty: '1', price: '100' }]), ...over });

test('checkSubmission: the 2,000,000 limit is in VND; other currencies use the given rate, never a guess', () => {
  const vnd = checkSubmission(fxBody({ items: JSON.stringify([{ desc: 'A', qty: '1', price: '1999999' }]) }));
  assert.deepEqual([vnd.currency, vnd.rateToVnd, vnd.grandTotalVnd, vnd.branch], ['VND', 1, 1999999, 'simplified']);
  assert.equal(checkSubmission(fxBody({ currency: 'USD' }), { currency: 'USD', rateToVnd: 26000 }).error,
    'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const full = checkSubmission(fxBody({ currency: 'USD', contractApprover: 'c@x.vn' }), { currency: 'USD', rateToVnd: 26000 });
  assert.deepEqual([full.grandTotal, full.grandTotalVnd, full.branch, full.picks.contract], [100, 2600000, 'full', 'c@x.vn']);
  const small = checkSubmission(fxBody({ currency: 'USD', items: JSON.stringify([{ desc: 'A', qty: '1', price: '76.9' }]) }), { currency: 'USD', rateToVnd: 26000 });
  assert.deepEqual([small.grandTotalVnd, small.branch], [1999400, 'simplified']);
  assert.equal(checkSubmission(fxBody({ currency: 'EUR' }), { currency: 'EUR', rateToVnd: null }).error, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.');
  assert.equal(checkSubmission(fxBody({ currency: 'eur' })).error, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.', 'no rate given → refused');
  assert.equal(checkSubmission(fxBody({ currency: 'US$' })).error, 'Loại tiền tệ không hợp lệ.');
  assert.equal(checkSubmission(fxBody({ companyName: '', currency: 'EUR' })).error, 'Thiếu tên công ty.', 'GAS checks keep their order');
  assert.equal(checkSubmission(fxBody({ currency: 'VNĐ' })).currency, 'VND');
});
```

Append to `tests/purchase-requests/state.test.js` (add `branchOf` to its import):
```js
test('branchOf: from the stored VND total; rows imported from GAS keep their stored branch', () => {
  assert.equal(branchOf({ purchase_type: 'goods', grand_total_vnd: '2600000', p2p_branch: 'simplified' }), 'full');
  assert.equal(branchOf({ purchase_type: 'goods', grand_total_vnd: '149500.00', p2p_branch: 'full' }), 'simplified');
  assert.equal(branchOf({ purchase_type: 'services', grand_total_vnd: '10' }), 'full');
  assert.equal(branchOf({ p2p_branch: 'simplified', grand_total_vnd: null }), 'simplified');
  assert.equal(branchOf({ metadata: { p2pBranch: 'simplified' } }), 'simplified');
  assert.equal(branchOf({}), 'full');
});
test('directPaymentProblem: the VND branch decides', () => {
  assert.equal(directPaymentProblem({ status: STATUS.DONE, purchase_type: 'goods', grand_total_vnd: '2600000', p2p_branch: 'simplified' }),
    'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, purchase_type: 'goods', grand_total_vnd: '1300000', p2p_branch: 'simplified' }), null);
});
```

```js
// tests/purchase-requests/fx-branch.test.js — the page's branch rule matches the server's (fx-branch.js vs state.js/rates.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import { computeBranch } from '../../api/lib/purchase-requests/state.js';
import { toVnd, normalizeCurrency } from '../../api/lib/fx/rates.js';

const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../fx-branch.js', import.meta.url), 'utf8'), sandbox);
const FB = sandbox.self.FxBranch;
const rates = { USD: 26000, EUR: null };

test('FxBranch.branch agrees with the server for VND, USD and services', () => {
  for (const [type, total, cur] of [['goods', 1999999, 'VND'], ['goods', 2000000, ''], ['goods', 76.9, 'USD'], ['goods', 77, 'USD'], ['services', 1, 'USD']]) {
    const server = computeBranch(type, normalizeCurrency(cur) === 'VND' ? total : toVnd(total, rates[normalizeCurrency(cur)]));
    assert.equal(FB.branch(type, total, cur, rates), server, `${type} ${total} ${cur}`);
  }
});
test('FxBranch: no rate → the raw total (GAS rule), never a guess sent to the server', () => {
  assert.equal(FB.toVnd(100, 'EUR', rates), null);
  assert.equal(FB.toVnd(100, 'USD', null), null);
  assert.equal(FB.branch('goods', 100, 'EUR', rates), 'simplified');
  assert.equal(FB.branch('goods', 2500000, 'USD', null), 'full', 'GAS mode: raw total');
  assert.equal(FB.toVnd(1500.5, 'VNĐ', rates), 1500.5);
});
```

```js
// tests/purchase-requests/fx.test.js — PR submit/resubmit on the VND threshold with admin rates (Plan 5b)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';

let s, d, r, pool, company, people;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
  r = await import('../../api/handlers/pr/reads.js');
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 26000 WHERE currency = 'USD'`);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL WHERE currency = 'EUR'`);
});
after(async () => {
  if (pool) await pool.query(`UPDATE exchange_rates SET rate_to_vnd = NULL WHERE currency IN ('USD', 'EUR')`);
  await teardown(pool);
});

const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const items = (price) => JSON.stringify([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Máy in', qty: '1', unit: 'Cái', price, total: price, note: '' }]);
const submit = (over) => call(s.handlePRSubmit, submitBody(company, people, over), REQ);
const fx = (row) => [row.currency, Number(row.grand_total), Number(row.fx_rate), Number(row.grand_total_vnd), row.p2p_branch];

test('USD 100 at 26,000 = 2,600,000 ₫: contract reviewer required; rate and VND total stored', { skip }, async () => {
  assert.equal((await submit({ currency: 'USD', items: items('100') })).message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const res = await submit({ currency: 'USD', items: items('100'), contractApprover: people.legal });
  assert.equal(res.success, true, res.message);
  assert.deepEqual(fx(await pr(res.prNo)), ['USD', 100, 26000, 2600000, 'full']);
});

test('USD 50 = 1,300,000 ₫ stays simplified; VND rows store rate 1', { skip }, async () => {
  const usd = await submit({ currency: 'USD', items: items('50') });
  assert.deepEqual(fx(await pr(usd.prNo)), ['USD', 50, 26000, 1300000, 'simplified']);
  const vnd = await submit({});
  assert.deepEqual(fx(await pr(vnd.prNo)), ['VND', 149500, 1, 149500, 'simplified']);
});

test('no EUR rate → refused with the Vietnamese message; nothing stored', { skip }, async () => {
  const n = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM purchase_requests')).rows[0].n;
  const before = await n();
  assert.deepEqual(await submit({ currency: 'EUR', items: items('10') }).then((x) => [x.success, x.message]),
    [false, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.']);
  assert.equal(await n(), before);
});

test('resubmit converts with the rate of that day', { skip }, async () => {
  const first = await submit({ currency: 'USD', items: items('50') });
  const back = await call(d.handlePRSendBack, { prNo: first.prNo, approverRole: 'budget', targetStep: 1, sentBackNote: 'Kiểm tra giá' }, as(people.treasurer));
  assert.equal(back.success, true, back.message);
  await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 50000 WHERE currency = 'USD'`);
  try {
    const again = (over) => call(s.handlePRResubmit, submitBody(company, people, { prNo: first.prNo, currency: 'USD', items: items('50'), ...over }), REQ);
    assert.equal((await again({})).message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
    const ok = await again({ contractApprover: people.legal });
    assert.equal(ok.success, true, ok.message);
    assert.deepEqual(fx(await pr(first.prNo)), ['USD', 50, 50000, 2500000, 'full']);
  } finally {
    await pool.query(`UPDATE exchange_rates SET rate_to_vnd = 26000 WHERE currency = 'USD'`);
  }
});

test('getExchangeRates: signed-in only; VND base and the admin rates', { skip }, async () => {
  assert.equal((await call(r.handleExchangeRates, {}, null)).code, 401);
  const ok = await call(r.handleExchangeRates, {}, REQ);
  assert.deepEqual([ok.success, ok.base, ok.rates.USD, ok.rates.EUR], [true, 'VND', 26000, null]);
});
```

In `tests/server/router-p2p.test.js` add `'getExchangeRates'` to the list of p2p actions.

- [ ] **Step 2: Run them to see them fail**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/purchase-requests/validate.test.js tests/purchase-requests/state.test.js tests/purchase-requests/fx-branch.test.js tests/purchase-requests/fx.test.js tests/server/router-p2p.test.js`
Expected: FAIL — `branchOf` not exported, `api/lib/fx/rates.js` / `fx-branch.js` missing, USD 100 submitted as simplified.

- [ ] **Step 3: Rates module**

```js
// api/lib/fx/rates.js — exchange rates to VND for the PR threshold (decision 2026-10-07). Admins edit them in
// Master Data (table exchange_rates, migration 008). VND is the base (rate 1, never stored). Takes `db`.
export const BAD_CURRENCY = 'Loại tiền tệ không hợp lệ.';
export const missingRateMessage = (cur) => `Chưa có tỷ giá cho ${cur}. Vui lòng liên hệ quản trị viên.`;

/** '' / VND / VNĐ → 'VND'; three letters → upper case; anything else → '' (invalid). */
export function normalizeCurrency(c) {
  const s = String(c ?? '').trim().toUpperCase();
  if (s === '' || s === 'VND' || s === 'VNĐ') return 'VND';
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

/** VND equivalent: whole đồng (a VND total is never rounded — callers pass rate 1 only for VND). */
export const toVnd = (total, rate) => (rate === 1 ? Number(total) : Math.round(Number(total) * Number(rate)));

/** 1 for VND; the admin rate for another currency; null when there is none (callers refuse, never guess). */
export async function getRateToVnd(db, currency) {
  const cur = normalizeCurrency(currency);
  if (!cur) return null;
  if (cur === 'VND') return 1;
  const { rows } = await db.query(`SELECT rate_to_vnd FROM exchange_rates WHERE currency = $1`, [cur]);
  const n = rows[0] && rows[0].rate_to_vnd != null ? Number(rows[0].rate_to_vnd) : null;
  return n > 0 ? n : null;
}

/** { USD: 26000, EUR: null, … } for the page. */
export async function listRates(db) {
  const { rows } = await db.query(`SELECT currency, rate_to_vnd FROM exchange_rates ORDER BY sheet_row NULLS LAST, id`);
  return Object.fromEntries(rows.map((r) => [r.currency, r.rate_to_vnd != null && Number(r.rate_to_vnd) > 0 ? Number(r.rate_to_vnd) : null]));
}
```

- [ ] **Step 4: State and validation**

`api/lib/purchase-requests/state.js`:
```js
/** The full-branch limit is in VND (decision 2026-10-07): other currencies are converted with the admin rate first. */
export const FULL_BRANCH_MIN_VND = 2000000;

/** GAS computeP2PBranch_ on the VND total: services or ≥ 2,000,000 ₫ → full (needs a contract reviewer). */
export function computeBranch(purchaseType, grandTotalVnd) {
  return lower(purchaseType) === 'services' || (Number(grandTotalVnd) || 0) >= FULL_BRANCH_MIN_VND ? 'full' : 'simplified';
}

/** The branch of a stored PR: from its VND total when it has one; rows imported from GAS keep the branch GAS chose. */
export function branchOf(row) {
  if (row.grand_total_vnd != null && row.grand_total_vnd !== '') return computeBranch(row.purchase_type, Number(row.grand_total_vnd));
  return row.p2p_branch || (row.metadata || {}).p2pBranch || 'full';
}
```
and in `directPaymentProblem` replace `(row.p2p_branch || (row.metadata || {}).p2pBranch || 'full') !== 'simplified'` with `branchOf(row) !== 'simplified'`.

`api/lib/purchase-requests/validate.js`:
- import `{ normalizeCurrency, toVnd, missingRateMessage, BAD_CURRENCY } from '../fx/rates.js'` (pure: no db).
- `checkSubmission` becomes `export function checkSubmission(b, fx = defaultFx(b.currency))` with
```js
/** Without a looked-up rate only VND is known (rate 1); anything else is refused, never guessed. */
const defaultFx = (currency) => {
  const cur = normalizeCurrency(currency);
  return { currency: cur, rateToVnd: cur === 'VND' ? 1 : null };
};
```
  and, between `const grandTotal = sumTotals(norm.items);` and the branch line:
```js
  if (!fx.currency) return { error: BAD_CURRENCY };
  if (fx.rateToVnd == null) return { error: missingRateMessage(fx.currency) };
  const grandTotalVnd = toVnd(grandTotal, fx.rateToVnd);
  const branch = computeBranch(purchaseType, grandTotalVnd);
```
  (delete the old `const branch = computeBranch(purchaseType, grandTotal);`), and add `currency: fx.currency, rateToVnd: fx.rateToVnd, grandTotalVnd,` to the returned object. Update the doc comment: "Total and branch from the items (S4); the branch on the VND total (decision 2026-10-07)".

`api/lib/purchase-requests/repo.js`: append `'fx_rate', 'grand_total_vnd'` to `WRITABLE`.

`api/handlers/pr/submit.js`:
- import `{ normalizeCurrency, getRateToVnd } from '../../lib/fx/rates.js'`;
- `prepareSubmission` first lines:
```js
export async function prepareSubmission(db, b, caller) {
  const currency = normalizeCurrency(b.currency);
  const rateToVnd = currency ? await getRateToVnd(db, currency) : null; // the rate of the day, stored on the PR
  const sub = checkSubmission(b, { currency, rateToVnd });
  if (sub.error) return sub;
  // … unchanged
```
- `submissionColumns`: `currency: sub.currency, fx_rate: sub.rateToVnd, grand_total_vnd: sub.grandTotalVnd,` (replacing `currency: str(b.currency) || 'VND',`).

`api/handlers/pr/reads.js`: import `{ listRates } from '../../lib/fx/rates.js'` and add
```js
/** getExchangeRates — the admin rates the page uses to show the same branch the server will compute. */
export async function handleExchangeRates(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  try {
    return ok(res, 'Thành công', { base: 'VND', rates: await listRates(db) });
  } catch (err) {
    console.error('[PR] exchange rates:', err.message);
    return fail(res, SYSTEM_ERROR);
  }
}
```
`api/router.js`: import `handleExchangeRates`, add `getExchangeRates: handleExchangeRates,` to `NEW_HANDLERS` after `getPurchaseOrderTypes`, and add `'getExchangeRates'` to `WORKFLOW_ACTIONS.p2p`.

- [ ] **Step 5: The page shows the same branch**

```js
// fx-branch.js — the PR full/simplified rule for the page, same as the server (state.js computeBranch on the
// VND total, rates.js toVnd). rates null (GAS mode) → the raw total, exactly as GAS. Plain <script>.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FxBranch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var FULL_MIN_VND = 2000000;
  function isVnd(c) { var s = String(c == null ? '' : c).trim().toUpperCase(); return s === '' || s === 'VND' || s === 'VNĐ'; }
  /** The total in VND, or null when no rate is known for the currency. rates: { USD: 26000, … }. */
  function toVnd(total, currency, rates) {
    var n = Number(total) || 0;
    if (isVnd(currency)) return n;
    var r = rates ? Number(rates[String(currency).trim().toUpperCase()]) : NaN;
    return r > 0 ? Math.round(n * r) : null;
  }
  function branch(purchaseType, total, currency, rates) {
    if (String(purchaseType || '').toLowerCase() === 'services') return 'full';
    var v = rates ? toVnd(total, currency, rates) : null;
    if (v === null) v = Number(total) || 0; // GAS mode, or no rate yet (the server will refuse the submit and say why)
    return v >= FULL_MIN_VND ? 'full' : 'simplified';
  }
  return { toVnd: toVnd, branch: branch, FULL_MIN_VND: FULL_MIN_VND };
});
```

`purchase_request.html` (outside Step 1):
1. After `<script src="approval-password.js"></script>` add `<script src="fx-branch.js"></script>`.
2. Replace `getP2PBranch()` with:
```js
    let _fxRates = null; // Postgres: { USD: 26000, … } from getExchangeRates; null on GAS (raw total, as GAS)
    function getP2PBranch() {
        const pt = document.getElementById('purchase_type_value')?.value || _purchaseType || 'goods';
        return FxBranch.branch(pt, _grandTotal || 0, _currency, _fxRates);
    }

    async function loadFxRates() {
        try {
            const res = await fetch(BACKEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'action=getExchangeRates' });
            const d = JSON.parse(await res.text());
            if (d && d.success && d.rates) { _fxRates = d.rates; renderBranchBanner(); }
        } catch (e) { /* GAS mode or offline: keep the raw-total rule */ }
    }
```
3. In `renderBranchBanner()` change `const gtFmt = formatMoney(_grandTotal);` to
```js
        const vnd = _fxRates ? FxBranch.toVnd(_grandTotal, _currency, _fxRates) : null;
        const gtFmt = formatMoney(_grandTotal) + (vnd !== null && _currency !== 'VND' ? ' ≈ ' + new Intl.NumberFormat('vi-VN').format(vnd) + ' ₫' : '');
```
4. In the `DOMContentLoaded` handler, after `preloadVendors();` add `loadFxRates();`.
5. `setCurrency(code)`: add `renderBranchBanner();` after `recalcAllSections();` (the branch can change with the currency even when the total does not).

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test` → 0 fail.

- [ ] **Step 7: Commit**

```bash
git add api/lib/fx/rates.js fx-branch.js api/lib/purchase-requests/state.js api/lib/purchase-requests/validate.js api/lib/purchase-requests/repo.js \
  api/handlers/pr/submit.js api/handlers/pr/reads.js api/router.js purchase_request.html \
  tests/purchase-requests/fx.test.js tests/purchase-requests/fx-branch.test.js tests/purchase-requests/validate.test.js \
  tests/purchase-requests/state.test.js tests/server/router-p2p.test.js
git commit -m "feat(pr): 2,000,000 VND full-branch limit with admin exchange rates; rate and VND total stored

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: End-to-end with GAS dead, GAS-mode regression, roadmap

**Files:**
- Scratch (not committed): `e2e-stamp.cjs` (model it on the scratch `e2e-pr.cjs` / `e2e-nogas.cjs`: login through `#login-email` / `#login-pass` with `Test#2026`), `check-samples.mjs`.
- Modify: `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`.

- [ ] **Step 1: Start with every GAS URL dead**

```bash
psql tlcg_v_test -f db/migrations/008_exchange_rates.sql
psql tlcg_v_test -c "truncate email_queue, sheet_outbox; update exchange_rates set rate_to_vnd = 26000 where currency = 'USD'; update exchange_rates set rate_to_vnd = null where currency = 'EUR'"
redis-cli -n 15 --scan --pattern 'stepup:fail:*' | xargs -r redis-cli -n 15 del
PORT=3999 HOST=127.0.0.1 PG_WORKFLOWS=vouchers,p2p,files APP_BASE_URL=http://127.0.0.1:3999 P2P_SPREADSHEET_ID=test-p2p-sheet VOUCHER_SPREADSHEET_ID=test-voucher-sheet \
TLCG_CASH_BACKEND_URL=http://127.0.0.1:9/gas TLCG_CORE_BACKEND_URL=http://127.0.0.1:9/gas TLCG_P2P_BACKEND_URL=http://127.0.0.1:9/gas \
DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 RESEND_API_KEY= node server.js 2>&1 | tee /tmp/stamp-e2e.log
```
Expected: no `FATAL` in the log.

- [ ] **Step 2: Browser scenario (each line is one PASS/FAIL check in e2e-stamp.cjs)**

1. The chief accountant of M.I opens `approve_voucher.html?voucherNumber=<new voucher>`: no signature upload block; Approve opens the password dialog; Cancel sends nothing (no `approveVoucher` request in the network log).
2. Wrong password → `Lỗi: Mật khẩu không đúng.`; the voucher is unchanged.
3. Right password → success; `vouchers.metadata.accountantSignature` starts with `data:image/` and equals the data URL of the company's registered accountant sample (compare with `fetchSignatureImage` of `accountant_sig_url`); the print view (`printVoucher`) shows that image.
4. In `voucher.html`, the legal representative opens the voucher modal: no upload block; Approve → password → `Đã phê duyệt thành công…`; the list refreshes.
5. Bulk: select 2 vouchers waiting for the treasurer; the bulk modal shows the password text, not the upload block; one password approves both (one `bulkApprove` request); the batch email goes to the next approver.
6. Five wrong passwords in a row → the 5th answer and the next (right) one show `Bạn đã nhập sai mật khẩu quá 5 lần. Vui lòng thử lại sau 15 phút.`; clear `stepup:fail:<email>` in Redis db 15 afterwards.
7. An approver without any sample (remove the Signature column value of a test employee named in a flow) → `Chưa có chữ ký mẫu của bạn…` and nothing approved; restore the value.
8. `purchase_request.html`: the treasurer opens a pending PR drawer: no upload block; Duyệt → password → `Đã duyệt thành công!`; `metadata.budgetSignature` is the stamped sample; the printed PR shows it.
9. PR form: currency USD, one line 100 USD → banner says `Quy trình đầy đủ` and `≈ 2.600.000 ₫`, contract reviewer marked required; submitting without one shows the server message; with one it succeeds and the row has `fx_rate = 26000`, `grand_total_vnd = 2600000`.
10. Currency EUR (no rate) → submit answers `Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.`
11. `admin.html` as an admin: tab `Exchange rates` shows USD/EUR; `Currency` cells refuse editing; set EUR to `28,000` through the review dialog; History lists the change with the admin's email; resubmitting step 10 now succeeds.
12. No email in `email_queue` contains `data:image` or the password text (`SELECT count(*) FROM email_queue WHERE body_html LIKE '%data:image%' OR body_html LIKE '%Test#2026%'` → 0); the server log never contains `Test#2026` (`grep -c 'Test#2026' /tmp/stamp-e2e.log` → 0).
13. `grep -c "127.0.0.1:9" /tmp/stamp-e2e.log` prints `0`.

- [ ] **Step 3: Sample sizes on real data**

`check-samples.mjs` (scratch): for every non-empty `companies.{legal_rep,accountant,treasurer}_sig_url` and employee `extra->>'Signature'` in `tlcg_v_test`, call `fetchImageDataUrl` (Task 1) and print `ok <bytes>`, `TOO BIG <bytes>` (> 768000) or `FAIL <message>`. Report the counts. Any `TOO BIG` or `FAIL` sample would block that approver after the switch: list them for the user (open item 3).

- [ ] **Step 4: GAS-mode regression**

Restart the server without `PG_WORKFLOWS` and with the real GAS URLs. Rerun the scratch `gas-regress.cjs` (Plan 5: 11 checks). Add three read-only checks and run them:
- `approve_voucher.html?voucherNumber=<live number>` still shows the signature upload block (GAS answers `getApprovalContext` with invalid action).
- `voucher.html` bulk modal shows the upload block (`window.__vouchersOnPostgres` false).
- `purchase_request.html` makes no successful `getExchangeRates` call (`_fxRates` stays null) and the banner uses the raw total.
Do not approve, submit or reject anything against live GAS.

- [ ] **Step 5: Clean up and update the roadmap**

`psql tlcg_v_test -c "truncate email_queue, sheet_outbox; update exchange_rates set rate_to_vnd = null"`.

In `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`, after item 2 add:
`3. ✅ **Plan 5b: Approve with the registered signature + password; VND threshold** (\`2026-10-07-signature-stamp-and-vnd-threshold.md\`). Done <date>: e2e with every GAS URL dead passed <n>/<n>; GAS-mode regression <m>/<m>.` with the real date and counts filled in (renumber the following items), and under "Switch-day additions" add:
```
## Switch-day additions (Plan 5b)

1. Apply `db/migrations/008_exchange_rates.sql` on the Mini. The server refuses to start with `p2p` on while it is missing.
2. Before turning `p2p` on, an admin enters the USD and EUR rates in Master Data › Exchange rates. Without a rate, PRs in that currency are refused.
3. Run the sample-size check (Plan 5b Task 7 step 3) against production data; fix every sample that fails or is over 750 KB, or those approvers cannot approve.
4. Tell approvers: on the new system they approve with their login password and no longer upload a signature.
5. `VOUCHER_REQUIRE_LOGIN=true` (already in the checklist) also stops anyone from triggering another person's password lockout without signing in.
```

```bash
git add docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md
git commit -m "docs: GAS exit roadmap - plan 5b done (stamped signature + password, VND threshold)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Notes for later plans
- **Plan 7 (acceptance minutes, contracts):** approve with `confirmPassword` + `stampSignature` from `api/lib/approval/step-up.js` exactly as `handlePRApprove` does (password before the lock, stamp after the rules). Contracts and acceptance minutes are created by the requester (decision 2026-10-07 #3), so the PR visibility rule (requester, approvers, admins) is enough for their PR pickers.
- **Not changed here:** the voucher receipt acknowledgement (`acknowledgeReceipt`) and the PR requester signature at submit still take an uploaded signature; neither is an approval.

## Open items (need the product owner)
1. **Login lockout.** The approval password is locked after 5 failures, but `handleLogin` has no lockout (only the general 300/min rate limit). Should login share the same counter? It would also let anyone lock a colleague out of login by guessing wrong on purpose.
2. **Lockout without login on vouchers.** Until `VOUCHER_REQUIRE_LOGIN=true` (switch day), the voucher approve endpoint accepts the approver email from the body, so anyone can burn an approver's 5 attempts. Acceptable until the switch?
3. **Sample images over 750 KB or unreachable** block their owners from approving. Task 7 step 3 lists them; the admin must replace them before the switch.
4. **Legacy non-VND PRs** imported from GAS keep the branch GAS chose (raw total), because their approver chain was built for it. Recomputing them with today's rate would change `validatePRForDirectPayment` answers for old USD/EUR PRs. Confirm.
5. **Rate input format.** The admin grid reads `26,000` and `26000` as 26000 but `25.400` as 25.4 (English decimal point; the rule `≥ 1` does not catch it). Should the Master Data page show the rate as "1 USD = 25.400 ₫" in the review dialog, or accept only whole numbers?
6. **Currencies offered.** The PR page offers VND, USD, EUR; only USD and EUR rows are seeded. Adding a currency means a new `exchange_rates` row (SQL) and a page option; there is no "add row" in the admin grid.

## Decisions on the open questions (controller, 2026-10-07; these override the tasks where they differ)
1. **Lockout counter.** The approval step-up has its own counter, separate from login: 5 failures lock approvals for that user for 15 minutes. Login itself is never locked by this counter.
2. **Login required.** The password step-up always requires a signed-in caller, whatever the value of VOUCHER_REQUIRE_LOGIN, and the counter is keyed on that caller's email from the token. Without a token: 401 'Vui lòng đăng nhập'.
3. **Oversized or unreachable samples.** Their owners are refused with NO_SAMPLE. Task 7 prints the list for admins to fix.
4. **Imported PRs.** PRs imported from GAS keep their stored branch and are not recomputed in VND.
5. **Exchange rates.** A rate is a whole number of VND per 1 unit of the currency (e.g. 26000). The admin UI and the API refuse decimals and non-positive values with 'Tỷ giá phải là số nguyên dương (VND cho 1 đơn vị).'
6. **Currencies.** Admins can add a currency in the exchange-rate view: a 3-letter code, upper-cased and unique, plus a rate. A currency can be removed only if no PR uses it. Seed USD and EUR as before.
7. **Lockout window.** The failure counter slides: each wrong password resets the 15-minute expiry. The 5th failure inside the window sets a separate lock key for 15 minutes. Accepted as the stricter, safer behaviour.
