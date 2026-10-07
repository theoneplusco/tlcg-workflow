# Purchase Requests on Postgres at GAS Parity Implementation Plan (Plan 5 of the GAS exit roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `PG_WORKFLOWS` contains `p2p`, every Purchase Request (Đề Nghị Mua Hàng) action is answered by Postgres. The answers keep the GAS wire contract that `purchase_request.html`, `contract.html` and `acceptance_minutes.html` read. The product decisions of 2026-10-07 are applied: identity from the login token, restricted visibility, server-checked approver picks, one approval for the same person on budget and supplier, the purchasing step emailed, attachments on R2, and the Sheet kept as a one-way copy.

**Architecture:**
- **State machine.** The rules are pure functions in `api/lib/purchase-requests/state.js`: status strings, `computePRApprovalState_`, and approve / reject / send back. They are not routed through the approval-flow engine, because the requester picks the approvers (decision 2026-10-07).
- **Handlers.** Thin Express handlers in `api/handlers/pr/` lock the row (`SELECT … FOR UPDATE`), apply the pure rule, then write the row and its audit row in one transaction. The audit write goes through the single funnel `recordChange`, which in Task 8 also queues the Sheet copy.
- **Emails.** Queued after commit.
- **Attachments.** The page keeps sending base64. The server writes the files to R2, so the page needs no attachment change.

**Tech Stack:** Node 24 ESM, Express 4, `pg`, `ioredis`, `@aws-sdk/client-s3` (installed), `googleapis` ^144 (installed), `node:test`.

## Global Constraints
- GAS mode stays unchanged. PR actions are registered only when `p2p` is in `PG_WORKFLOWS`. `validatePRForDirectPayment` is registered under a new key, `payments`, which Plan 6 turns on.
- Test command: `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`. Every task ends with the whole suite green. The suite has 135 tests before Task 1.
- Before Task 1, run `psql tlcg_v_test -c "truncate approval_flows, email_queue, sheet_outbox"`.
- Pure modules (`api/lib/purchase-requests/{state,numbering,emails,validate,views,respond}.js`, `api/lib/sheets/{grid,pr-records}.js`) must not import `db/pool.js` or `db/redis.js`. DB modules take `db`/`client` as an argument. DB tests `TRUNCATE` the tables they use.
- Identity comes only from `callerFromRequest` (`api/lib/auth-caller.js`).
  - Every PR read and write needs a valid login token, whatever `VOUCHER_REQUIRE_LOGIN` says. The exceptions are `getGoodsCatalog`, `getPurchaseOrderTypes`, and `getP2PHistory` for flows other than `PR`.
  - Without a token: HTTP 401 and `Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.`
  - An `approverEmail` or `requesterEmail` in the body may only repeat the caller's own email. Otherwise the answer is `Bạn đang đăng nhập bằng <caller>, không thể thao tác thay <claimed>.`
- Visibility: a PR is visible to its requester (`requester_email`), anyone in its `approver_emails` (budget, supplier, contract, purchasing), and admins (`employees.is_admin`). Anyone else gets HTTP 403 and `Bạn không có quyền xem đề nghị này.`
- Status strings are exact and never translated: `Đang duyệt ngân sách & NCC (2/5)`, `Thẩm định Hợp đồng (4/5)`, `Mua hàng (5/5)`, `Hoàn thành`, `Đã từ chối`, `Trả lại bổ sung`. The legacy values `Approved` and `Rejected` are treated as terminal.
- Response shape: `{ success, message, ...fields, data: { ...fields } }`.
  - GAS spread its fields at the top level; some pages read `result.data.x` (bug B8). Both keep working.
  - Business errors are HTTP 200 with `success:false`, as in GAS. Only login (401) and visibility (403) use other codes.
- Messages are Vietnamese with GAS wording where GAS had one. The PR pages never send `lang`.
- Emails:
  - Vietnamese, every value HTML-escaped.
  - A deep link `${APP_BASE_URL}/purchase_request.html?prNo=<số phiếu>`, and never an approve/reject token.
  - One email per distinct address.
  - Queued with `queueMail` only after commit. A failure never fails the action.
  - The sender is the worker's `hello@tl-c.us`.
- Approver picks:
  - budget, supplier and contract must be the company's `legal_rep_email`, `accountant_email` or `treasurer_email`.
  - purchasing must be an active employee whose department is `Kế Toán Chi`.
  - Do not use `api/lib/approval/flows-repo.js` for PRs.
- Sheet copy: written to `P2P_SPREADSHEET_ID`, which has no default. It is queued in the same transaction and never blocks or fails an action.
- `purchase_request.html` Step 1 HTML is locked (memory `purchase_request_rules.md`). The only page change allowed is the deep-link hook in Task 10.
- Do not switch production. `p2p` must not be turned on in production before the switch day (Plan 9): GAS contracts, acceptance minutes and payments still read PRs from the Sheet.

## File Structure
- Create:
  - `db/migrations/007_purchase_requests.sql`: GIN-indexed `approver_emails` / `pending_emails`, `imported_at`, `sheet_row`, audit `source`, the `purchase_order_types` table.
  - `api/lib/purchase-requests/repo.js`: row and audit storage, visibility SQL, approver candidates.
  - `api/lib/purchase-requests/state.js` (pure): statuses, chain, approve/reject/send-back rules, approver-pick check, direct-payment check.
  - `api/lib/purchase-requests/numbering.js`: the PR number (pure rules plus `allocatePRNo` under an advisory lock).
  - `api/lib/purchase-requests/emails.js` (pure): every PR email.
  - `api/lib/purchase-requests/validate.js` (pure): GAS submit checks, priority, server-side total, metadata.
  - `api/lib/purchase-requests/attachments.js`: base64 → R2.
  - `api/lib/purchase-requests/respond.js` (pure): response helpers, login, and body-email checks.
  - `api/lib/purchase-requests/views.js` (pure): list card, detail, history entry, goods row, supplier record.
  - `api/lib/purchase-requests/importer.js`: Sheet rows → Postgres, re-runnable.
  - `api/lib/sheets/grid.js` (pure): CSV parsing and grid → records (first occurrence of a repeated header wins).
  - `api/lib/sheets/pr-records.js` (pure): the `Purchase_Request_History` and `PR_Audit_Log` Sheet records.
  - `api/handlers/pr/tx.js`: default dependencies and the lock → apply → commit → mail helper.
  - `api/handlers/pr/submit.js`: `purchaseRequest`, `resubmitPurchaseRequest`.
  - `api/handlers/pr/decide.js`: `approvePurchaseRequest`, `rejectPurchaseRequest`, `sendBackPurchaseRequest`.
  - `api/handlers/pr/reads.js`: the list, detail, search, history, goods, PO types, addSupplier and validatePRForDirectPayment actions.
  - `scripts/import-purchase-requests.js`: the CLI (`--dir`, `--live`, `--dry-run`, `--notify-purchasing`).
- Modify:
  - `api/router.js`
  - `api/lib/files/r2.js`: add `prAttachmentKey`.
  - `api/lib/sheets/rows.js`: a repeated header fills only its first column.
  - `api/lib/sheets/mirror-run.js`: compound upsert key.
  - `api/jobs/sheet-mirror.js`: start when either target is set.
  - `api/lib/sheets/voucher-records.js`: export `metadataJson`.
  - `scripts/import-vouchers.js`: use `grid.js`.
  - `api/lib/startup-checks.js` and `server.js`: the migration 007 boot check.
  - `purchase_request.html`: the deep link.
  - `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`: tick Plan 5.
- Delete: `api/handlers/purchase-request.js`, `api/lib/pr-approval-state.js` (Task 7, once every action has moved).
- Tests (new): `tests/purchase-requests/{repo,state,numbering,emails,validate,submit,decide,views,reads,import-map,importer}.test.js`, `tests/purchase-requests/helpers.js` (shared setup, not a test file), `tests/sheets/pr-records.test.js`, `tests/server/router-p2p.test.js`.
- Tests (extended): `tests/sheets/{rows,outbox,mirror-job}.test.js`, `tests/server/startup.test.js`.

---

### Task 1: Schema migration 007 and the PR repository

**Files:**
- Create: `db/migrations/007_purchase_requests.sql`, `api/lib/purchase-requests/repo.js`
- Test: `tests/purchase-requests/repo.test.js`

**Interfaces:**
- Consumes: the tables `purchase_requests`, `pr_audit_log`, `employees` and `companies` (`db/schema.sql:6-45, 129-175`).
- Produces (all take `db` or a transaction `client` as the first argument):
  - `getPR(db, prNo) → row|null`
  - `lockPR(client, prNo) → row|null`, which does `FOR UPDATE`.
  - `insertPR(client, rec) → row`. Keys of `rec` are column names from `WRITABLE`; JSON columns take JS values.
  - `updatePR(client, id, fields) → row`. It always sets `updated_at = NOW()`.
  - `appendAudit(client, { docNo, company, action, role, actorEmail, actorName, prevStatus, newStatus, note, extra, at, source, sheetRow })`.
  - `recordChange(client, rowAfter, entry|entry[])`. This is the single funnel for every state change. Task 8 adds the Sheet copy here.
  - `auditFor(db, prNo, limit = 200) → rows`, oldest first.
  - `visibility(caller, start) → { sql, params }`: a WHERE fragment using `$start` and `$start+1`.
  - `canView(caller, row) → boolean`.
  - `approverCandidates(db, company) → { companyEmails: Set, purchasingEmails: Set }`.
  - `WRITABLE: string[]`.

- [ ] **Step 1: Write the migration and apply it**

```sql
-- db/migrations/007_purchase_requests.sql — Purchase requests on Postgres (Plan 5, 2026-10-07)
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/007_purchase_requests.sql
--
-- approver_emails = everyone named on the PR (visibility); pending_emails = who must act now
-- ("Việc của tôi", bell badge). Both are GIN-indexed like vouchers (migration 005).
-- imported_at: set by scripts/import-purchase-requests.js; a row is re-imported only while
-- updated_at <= imported_at (never after it changed in Postgres). pr_number_sequences is no
-- longer used (numbers come from an advisory lock + the existing numbers, Task 3).
BEGIN;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS approver_emails TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS pending_emails  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS imported_at     TIMESTAMPTZ;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS sheet_row       INT;
CREATE INDEX IF NOT EXISTS pr_approver_emails_idx ON purchase_requests USING GIN (approver_emails);
CREATE INDEX IF NOT EXISTS pr_pending_emails_idx  ON purchase_requests USING GIN (pending_emails);
CREATE INDEX IF NOT EXISTS pr_requester_email_idx ON purchase_requests (LOWER(requester_email));
DROP INDEX IF EXISTS idx_pr_active;
CREATE INDEX IF NOT EXISTS idx_pr_active ON purchase_requests (status)
  WHERE status NOT IN ('Hoàn thành', 'Đã từ chối', 'Approved', 'Rejected');

ALTER TABLE pr_audit_log ADD COLUMN IF NOT EXISTS source    TEXT NOT NULL DEFAULT 'app'; -- app | sheet | sheet-event
ALTER TABLE pr_audit_log ADD COLUMN IF NOT EXISTS sheet_row INT;
CREATE INDEX IF NOT EXISTS pr_audit_doc_time_idx ON pr_audit_log (doc_no, created_at, id);

-- 'Purchase Order' sheet (col A No, col B Type), read by getPurchaseOrderTypes
CREATE TABLE IF NOT EXISTS purchase_order_types (
  id        SERIAL PRIMARY KEY,
  no        TEXT DEFAULT '',
  type      TEXT NOT NULL,
  sheet_row INT
);
COMMIT;
```

Run `psql tlcg_v_test -f db/migrations/007_purchase_requests.sql`. Expected: `BEGIN`, `ALTER TABLE` / `CREATE INDEX` / `DROP INDEX` / `CREATE TABLE` lines, then `COMMIT`. Run it again: still `COMMIT`, with "already exists" notices.

- [ ] **Step 2: Write the failing test**

```js
// tests/purchase-requests/repo.test.js — needs TEST_DATABASE_URL (schema + migrations 001-007 + master data)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  insertPR, getPR, lockPR, updatePR, recordChange, auditFor, visibility, canView, approverCandidates,
} from '../../api/lib/purchase-requests/repo.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
before(async () => { if (db) await db.query('TRUNCATE purchase_requests, pr_audit_log, sheet_outbox'); });
after(async () => { if (db) await db.end(); });

const rec = (no, over = {}) => ({
  pr_no: no, company_name: 'CÔNG TY TEST', requester_email: 'req@x.vn', status: 'Đang duyệt ngân sách & NCC (2/5)',
  items: [{ desc: 'A', total: '1000' }], attachments: [], metadata: { budgetStatus: 'Pending' },
  approver_emails: ['linh@x.vn'], pending_emails: ['linh@x.vn'], submitted_at: '2026-10-07T01:00:00.000Z', ...over,
});

test('insertPR / getPR: JSON and array columns round-trip', { skip }, async () => {
  await insertPR(db, rec('ZZ-PR20261007000001'));
  const r = await getPR(db, 'ZZ-PR20261007000001');
  assert.deepEqual(r.items, [{ desc: 'A', total: '1000' }]);
  assert.deepEqual(r.metadata, { budgetStatus: 'Pending' });
  assert.deepEqual(r.pending_emails, ['linh@x.vn']);
  assert.equal(await getPR(db, 'nope'), null);
});

test('updatePR: changes the given fields and bumps updated_at', { skip }, async () => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const row = await lockPR(c, 'ZZ-PR20261007000001');
    const saved = await updatePR(c, row.id, { status: 'Mua hàng (5/5)', pending_emails: ['ap@x.vn'] });
    await c.query('COMMIT');
    assert.equal(saved.status, 'Mua hàng (5/5)');
    assert.deepEqual(saved.pending_emails, ['ap@x.vn']);
    assert.ok(saved.updated_at >= row.updated_at);
    assert.equal(saved.requester_email, 'req@x.vn', 'untouched columns kept');
  } finally { c.release(); }
});

test('recordChange writes audit rows; auditFor returns them oldest first', { skip }, async () => {
  const row = await getPR(db, 'ZZ-PR20261007000001');
  await recordChange(db, row, [
    { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z', extra: { signatureUploaded: true } },
    { action: 'Approve', role: 'supplier', actorEmail: 'linh@x.vn', prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z' },
  ]);
  await recordChange(db, row, { action: 'Submit', role: 'requester', actorEmail: 'req@x.vn', at: '2026-10-07T01:00:00.000Z' });
  const a = await auditFor(db, 'ZZ-PR20261007000001');
  assert.deepEqual(a.map((x) => `${x.action}/${x.role}`), ['Submit/requester', 'Approve/budget', 'Approve/supplier']);
  assert.equal(a[0].company, 'CÔNG TY TEST');
  assert.deepEqual(a[1].extra, { signatureUploaded: true });
  assert.equal(a[1].source, 'app');
});

test('visibility: admin all, requester own, approver named, stranger nothing', { skip }, async () => {
  await insertPR(db, rec('ZZ-PR20261007000002', { requester_email: 'other@x.vn', approver_emails: ['boss@x.vn'] }));
  const seen = async (caller) => {
    const v = visibility(caller, 1);
    const { rows } = await db.query(`SELECT pr_no FROM purchase_requests WHERE pr_no LIKE 'ZZ-%' AND ${v.sql} ORDER BY pr_no`, v.params);
    return rows.map((r) => r.pr_no.slice(-1));
  };
  assert.deepEqual(await seen({ email: 'admin@x.vn', isAdmin: true }), ['1', '2']);
  assert.deepEqual(await seen({ email: 'req@x.vn', isAdmin: false }), ['1']);
  assert.deepEqual(await seen({ email: 'boss@x.vn', isAdmin: false }), ['2']);
  assert.deepEqual(await seen({ email: 'nobody@x.vn', isAdmin: false }), []);
  assert.equal(canView({ email: 'boss@x.vn' }, { requester_email: 'Other@x.vn', approver_emails: ['boss@x.vn'] }), true);
  assert.equal(canView({ email: 'x@x.vn' }, { requester_email: 'Other@x.vn', approver_emails: [] }), false);
});

test('approverCandidates: Master Company roles + Kế Toán Chi staff', { skip }, async () => {
  const company = (await db.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  const c = await approverCandidates(db, company);
  assert.ok(c.companyEmails.has(company.treasurer_email.toLowerCase()));
  assert.ok(c.companyEmails.has(company.accountant_email.toLowerCase()));
  assert.ok(c.purchasingEmails.has('tlc.ap@tl-c.com.vn'));
  assert.equal(c.purchasingEmails.has(company.treasurer_email.toLowerCase()), false);
});
```

- [ ] **Step 3: Run the test and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test node --test tests/purchase-requests/repo.test.js`. Expected: FAIL with `Cannot find module …/purchase-requests/repo.js`.

- [ ] **Step 4: Implement repo.js**

```js
// api/lib/purchase-requests/repo.js — purchase_requests / pr_audit_log storage.
// Takes the db or transaction client as an argument (no pool import): handlers, tests and the importer share it.
const JSON_COLS = new Set(['items', 'attachments', 'metadata']);
export const WRITABLE = ['pr_no', 'company_id', 'company_name', 'company_key', 'department', 'requester_name',
  'requester_email', 'required_date', 'priority', 'purpose', 'vendor_name', 'budget_code',
  'budget_approver_email', 'supplier_approver_email', 'contract_approver_email', 'purchasing_approver_email',
  'items', 'grand_total', 'currency', 'status', 'p2p_branch', 'purchase_type', 'attachments', 'metadata',
  'submitted_at', 'archived_at', 'approver_emails', 'pending_emails', 'imported_at', 'sheet_row', 'updated_at'];

const val = (k, v) => (JSON_COLS.has(k) ? JSON.stringify(v ?? (k === 'metadata' ? {} : [])) : v);
const lower = (s) => String(s || '').trim().toLowerCase();

export async function getPR(db, prNo) {
  const { rows } = await db.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [String(prNo || '').trim()]);
  return rows[0] || null;
}

/** Inside a transaction: the row, locked until COMMIT (fixes GAS B11, two approvals racing). */
export async function lockPR(client, prNo) {
  const { rows } = await client.query('SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [String(prNo || '').trim()]);
  return rows[0] || null;
}

export async function insertPR(client, rec) {
  const keys = WRITABLE.filter((k) => rec[k] !== undefined);
  const { rows } = await client.query(
    `INSERT INTO purchase_requests (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => val(k, rec[k])));
  return rows[0];
}

export async function updatePR(client, id, fields) {
  const keys = WRITABLE.filter((k) => fields[k] !== undefined && k !== 'updated_at' && k !== 'pr_no');
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = NOW()');
  const { rows } = await client.query(
    `UPDATE purchase_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => val(k, fields[k]))]);
  return rows[0];
}

export async function appendAudit(client, e) {
  await client.query(
    `INSERT INTO pr_audit_log (doc_no, flow, company, action, role, actor_email, actor_name, prev_status, new_status,
                               note, extra, created_at, source, sheet_row)
     VALUES ($1, 'PR', $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()), $12, $13)`,
    [e.docNo, e.company || '', e.action, e.role || '', lower(e.actorEmail), e.actorName || '', e.prevStatus || '',
      e.newStatus || '', e.note || '', JSON.stringify(e.extra || {}), e.at || null, e.source || 'app', e.sheetRow ?? null]);
}

/**
 * Every PR state change goes through here, after the row is updated and in the same transaction.
 * `row` is the row AFTER the change; entries are audit rows (docNo/company filled from the row).
 */
export async function recordChange(client, row, entries) {
  const list = [].concat(entries).map((e) => ({ docNo: row.pr_no, company: row.company_name, ...e }));
  for (const e of list) await appendAudit(client, e);
}

export async function auditFor(db, prNo, limit = 200) {
  const { rows } = await db.query(
    'SELECT * FROM pr_audit_log WHERE doc_no = $1 ORDER BY created_at, id LIMIT $2', [String(prNo || '').trim(), limit]);
  return rows;
}

/** Requester, anyone named on the PR, or an admin (decision 2026-10-07). */
export function visibility(caller, start = 1) {
  return {
    sql: `($${start}::boolean OR LOWER(requester_email) = $${start + 1} OR $${start + 1} = ANY(approver_emails))`,
    params: [!!caller.isAdmin, lower(caller.email)],
  };
}

export function canView(caller, row) {
  if (!caller || !row) return false;
  const me = lower(caller.email);
  return !!caller.isAdmin || lower(row.requester_email) === me || (row.approver_emails || []).includes(me);
}

/**
 * Who the requester may pick (purchase_request.html seedApproversFromCompany): the company's
 * Đại diện pháp luật / Kế toán trưởng / Thủ quỹ for budget, supplier and contract; active
 * Kế Toán Chi staff for purchasing.
 */
export async function approverCandidates(db, company) {
  const companyEmails = new Set(['legal_rep_email', 'accountant_email', 'treasurer_email']
    .map((c) => lower(company && company[c])).filter(Boolean));
  const { rows } = await db.query(
    `SELECT LOWER(TRIM(email)) AS email FROM employees
     WHERE status = 'active' AND LOWER(TRIM(department)) = LOWER('Kế Toán Chi')`);
  return { companyEmails, purchasingEmails: new Set(rows.map((r) => r.email)) };
}
```

- [ ] **Step 5: Run the tests**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test node --test tests/purchase-requests/repo.test.js`. Expected: PASS (5 tests). Then run the full suite with the Global Constraints command. Expected: 140 pass.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/007_purchase_requests.sql api/lib/purchase-requests/repo.js tests/purchase-requests/repo.test.js
git commit -m "feat(pr): migration 007 and PR repository (visibility, audit funnel, approver candidates)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pure PR state machine

**Files:**
- Create: `api/lib/purchase-requests/state.js`
- Test: `tests/purchase-requests/state.test.js`

**Interfaces:**
- Consumes: nothing. The module is pure. A PR is any object with the `purchase_requests` column names. `meta` is its `metadata`.
- Produces:
  - Constants:
    - `STATUS {PARALLEL, CONTRACT, PURCHASING, DONE, REJECTED, RETURNED}`
    - `ROLES`
    - `TERMINAL_STATUSES`
    - `BAD_ROLE`
    - `MAX_SEND_BACK`
  - Status tests: `isRole(r)`, `isRejected(s)`, `isComplete(s)`, `isTerminal(s)`, `isReturned(s)`.
  - `emailOf(pr, role)`.
  - `computeBranch(purchaseType, grandTotal) → 'full'|'simplified'`.
  - `normalizePurchaseType(t) → 'goods'|'services'`.
  - `approvalState(pr, meta) → { stage: 'parallel'|'contract'|'purchasing'|'complete', statusLabel }`.
  - `pendingEmails(pr, meta, status) → string[]`.
  - `approverEmails(pr) → string[]`.
  - `parseVerification(v) → object`.
  - Rule functions. Each returns `{ error }` on failure:
    - `applyApprove(pr, meta, {email, role, note, signature, verification, at}) → { meta, roles, before, after, status }`.
    - `applyReject(pr, meta, {email, note, at}) → { role, meta, status }`.
    - `sendBackInputError({sentBackNote, targetStep, approverRole}) → string|null`.
    - `applySendBack(pr, meta, {email, role, targetStep, note, at}) → { meta, status }`.
  - `approverPickError(picks, candidates, branch) → string|null`.
  - `directPaymentProblem(row) → string|null`.

- [ ] **Step 1: Write the failing test**

```js
// tests/purchase-requests/state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, computeBranch, approvalState, pendingEmails, approverEmails, applyApprove, applyReject,
  sendBackInputError, applySendBack, approverPickError, directPaymentProblem,
} from '../../api/lib/purchase-requests/state.js';

const AT = '2026-10-07T03:00:00.000Z';
const pr = (over = {}) => ({
  pr_no: 'EV-PR20261007000001', status: STATUS.PARALLEL, requester_email: 'req@x.vn',
  budget_approver_email: 'linh@x.vn', supplier_approver_email: 'Linh@x.vn', contract_approver_email: '',
  purchasing_approver_email: 'Tlc.ap@x.vn', p2p_branch: 'simplified', ...over,
});
const meta = (over = {}) => ({ budgetStatus: 'Pending', supplierStatus: 'Pending', contractStatus: 'N/A', purchasingStatus: 'Pending', p2pBranch: 'simplified', ...over });

test('computeBranch: services or ≥ 2,000,000 → full', () => {
  assert.equal(computeBranch('services', 10), 'full');
  assert.equal(computeBranch('goods', 2000000), 'full');
  assert.equal(computeBranch('goods', 1999999), 'simplified');
  assert.equal(computeBranch('', 0), 'simplified');
});

test('approvalState: GAS chain (contract stage skipped on both branches)', () => {
  assert.equal(approvalState(pr(), meta()).statusLabel, STATUS.PARALLEL);
  assert.equal(approvalState(pr(), meta({ budgetStatus: 'Approved' })).stage, 'parallel');
  assert.equal(approvalState(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' })).statusLabel, STATUS.PURCHASING);
  assert.equal(approvalState(pr({ purchasing_approver_email: '' }), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' })).statusLabel, STATUS.DONE);
  const full = pr({ p2p_branch: 'full', contract_approver_email: 'kt@x.vn' });
  assert.equal(approvalState(full, meta({ p2pBranch: 'full', budgetStatus: 'Approved', supplierStatus: 'Approved' })).stage, 'purchasing');
});

test('approve: same person on budget + supplier → one approval covers both (decision 2026-10-07)', () => {
  const r = applyApprove(pr(), meta(), { email: 'LINH@x.vn', role: 'budget', note: '', signature: 'data:sig', verification: '{"verified":true,"similarity":99.6}', at: AT });
  assert.deepEqual(r.roles, ['budget', 'supplier']);
  assert.equal(r.status, STATUS.PURCHASING);
  assert.equal(r.before.stage, 'parallel');
  assert.equal(r.after.stage, 'purchasing');
  assert.equal(r.meta.supplierApprovedAt, AT);
  assert.equal(r.meta.supplierSignature, 'data:sig');
  assert.deepEqual(r.meta.budgetSignatureVerification, { verified: true, similarity: 99.6 });
});

test('approve: distinct people approve separately; legacy half-approved PR finishes with the open slot', () => {
  const two = pr({ supplier_approver_email: 'ncc@x.vn' });
  const r = applyApprove(two, meta(), { email: 'linh@x.vn', role: 'budget', at: AT });
  assert.deepEqual(r.roles, ['budget']);
  assert.equal(r.status, STATUS.PARALLEL);
  const half = applyApprove(pr(), meta({ budgetStatus: 'Approved' }), { email: 'linh@x.vn', role: 'supplier', at: AT });
  assert.deepEqual(half.roles, ['supplier']);
  assert.equal(half.status, STATUS.PURCHASING);
  assert.deepEqual(applyApprove(pr(), meta(), { email: 'linh@x.vn', role: 'budget', verification: 'not json', at: AT }).meta.budgetSignatureVerification, { raw: 'not json' });
});

test('approve: GAS checks in GAS order with GAS wording', () => {
  const a = (p, m, email, role) => applyApprove(p, m, { email, role, at: AT }).error;
  assert.equal(a(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn', 'budget'), 'Đề nghị này đã bị từ chối, không thể duyệt.');
  assert.equal(a(pr({ status: 'Approved' }), meta(), 'linh@x.vn', 'budget'), 'Đề nghị này đã được duyệt rồi.');
  assert.equal(a(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn', 'budget'), 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.');
  assert.equal(a(pr(), meta(), 'linh@x.vn', 'contract'), 'Vai trò "contract" chưa được phân công cho đề nghị này.');
  assert.equal(a(pr(), meta(), 'x@x.vn', 'budget'), 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
  assert.equal(a(pr(), meta(), 'tlc.ap@x.vn', 'purchasing'), 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
  const twoPeople = pr({ supplier_approver_email: 'ncc@x.vn' });
  assert.equal(a(twoPeople, meta({ budgetStatus: 'Approved' }), 'linh@x.vn', 'budget'), 'Bạn đã duyệt đề nghị này rồi.');
});

test('reject: permission, then turn, then status; picks the slot of the active stage', () => {
  const j = (p, m, email) => applyReject(p, m, { email, note: 'Sai giá', at: AT });
  assert.equal(j(pr(), meta(), 'x@x.vn').error, 'Bạn không có quyền từ chối đề nghị này.');
  assert.equal(j(pr(), meta(), 'tlc.ap@x.vn').error, 'Chưa đến lượt của bạn trong quy trình phê duyệt.');
  // GAS let the later role win (purchasing) and refused; we use the caller's slot in the open stage
  const ok = j(pr({ purchasing_approver_email: 'linh@x.vn' }), meta(), 'linh@x.vn');
  assert.equal(ok.role, 'budget');
  assert.equal(ok.status, STATUS.REJECTED);
  assert.equal(ok.meta.rejectedBy, 'linh@x.vn');
  assert.equal(ok.meta.rejectionNote, 'Sai giá');
  assert.equal(j(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn').error, 'Đề nghị này đã bị từ chối rồi.');
  assert.equal(j(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn').error, 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.');
});

test('send back: input checks before lookup', () => {
  assert.equal(sendBackInputError({ sentBackNote: ' ', targetStep: 1, approverRole: 'budget' }), 'Vui lòng nhập lý do trả lại.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: 4, approverRole: 'budget' }), 'Bước trả lại không hợp lệ.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: '2', approverRole: 'boss' }), 'Vai trò không hợp lệ.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: '2', approverRole: 'purchasing' }), null);
});

test('send back step 1 → Trả lại bổ sung, history pushed, approvals kept (GAS)', () => {
  const r = applySendBack(pr(), meta({ budgetStatus: 'Approved' }), { email: 'linh@x.vn', role: 'supplier', targetStep: 1, note: ' Thiếu báo giá ', at: AT });
  assert.equal(r.status, STATUS.RETURNED);
  assert.equal(r.meta.budgetStatus, 'Approved');
  assert.deepEqual(r.meta.sentBackHistory, [{ targetStep: 1, by: 'linh@x.vn', byRole: 'supplier', at: AT, note: 'Thiếu báo giá' }]);
});

test('send back step 2 by purchasing resets the chain; step 3 is refused (B3); GAS check order', () => {
  const m = meta({ budgetStatus: 'Approved', budgetApprovedAt: AT, budgetNote: 'ok', budgetSignature: 'data:s', supplierStatus: 'Approved' });
  const p = pr({ status: STATUS.PURCHASING });
  const r = applySendBack(p, m, { email: 'tlc.ap@x.vn', role: 'purchasing', targetStep: 2, note: 'Sai NCC', at: AT });
  assert.equal(r.status, STATUS.PARALLEL);
  assert.equal(r.meta.budgetStatus, 'Pending');
  assert.equal(r.meta.purchasingStatus, 'Pending');
  assert.equal(r.meta.contractStatus, 'N/A');
  assert.equal(r.meta.budgetApprovedAt, undefined);
  assert.equal(r.meta.budgetSignature, 'data:s', 'signatures stay (GAS)');
  assert.equal(applySendBack(p, m, { email: 'tlc.ap@x.vn', role: 'purchasing', targetStep: 3, note: 'x', at: AT }).error, 'Bước trả lại không hợp lệ với vai trò của bạn.');
  assert.equal(applySendBack(p, m, { email: 'x@x.vn', role: 'budget', targetStep: 1, note: 'x', at: AT }).error, 'Chưa đến lượt của bạn trong quy trình phê duyệt.', 'turn before assignment');
  assert.equal(applySendBack(p, m, { email: 'x@x.vn', role: 'purchasing', targetStep: 1, note: 'x', at: AT }).error, 'Bạn không được phân công vai trò "purchasing" cho đề nghị này.');
  assert.equal(applySendBack(pr({ status: STATUS.RETURNED }), meta(), { email: 'linh@x.vn', role: 'budget', targetStep: 1, note: 'x', at: AT }).error, 'Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.');
});

test('pendingEmails / approverEmails', () => {
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.PARALLEL), ['linh@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), STATUS.PURCHASING), ['tlc.ap@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.RETURNED), ['req@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.DONE), []);
  assert.deepEqual(approverEmails(pr({ contract_approver_email: 'KT@x.vn' })), ['linh@x.vn', 'kt@x.vn', 'tlc.ap@x.vn']);
});

test('approverPickError: server check of the requester picks (S3)', () => {
  const cands = { companyEmails: new Set(['linh@x.vn', 'kt@x.vn']), purchasingEmails: new Set(['tlc.ap@x.vn']) };
  const ok = { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' };
  assert.equal(approverPickError(ok, cands, 'full'), null);
  assert.match(approverPickError({ ...ok, budget: 'me@x.vn' }, cands, 'full'), /^Người phê duyệt ngân sách \(me@x\.vn\) không thuộc danh sách/);
  assert.equal(approverPickError({ ...ok, contract: 'me@x.vn' }, cands, 'simplified'), null, 'contract not used on simplified');
  assert.match(approverPickError({ ...ok, purchasing: 'linh@x.vn' }, cands, 'full'), /không thuộc phòng Kế Toán Chi/);
  assert.equal(approverPickError({ ...ok, purchasing: '' }, cands, 'full'), null, 'purchasing optional');
});

test('directPaymentProblem: GAS validatePRForDirectPayment rules', () => {
  assert.equal(directPaymentProblem({ status: STATUS.PURCHASING, p2p_branch: 'simplified' }), 'PR chưa được phê duyệt hoàn tất.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, p2p_branch: 'full' }), 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, p2p_branch: 'simplified' }), null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `node --test tests/purchase-requests/state.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement state.js**

```js
// api/lib/purchase-requests/state.js — Purchase request approval rules (pure).
// GAS: computePRApprovalState_, handleApprove/Reject/SendBackPurchaseRequest (TLCG_P2P_BACKEND.gs),
// with the product decisions of 2026-10-07:
// - the same person on budget + supplier approves once for both slots;
// - send back to step 3 is refused: the PR has no contract stage (GAS bug B3);
// - reject uses the caller's slot in the open stage (GAS let a later role win, then refused).
export const STATUS = {
  PARALLEL: 'Đang duyệt ngân sách & NCC (2/5)',
  CONTRACT: 'Thẩm định Hợp đồng (4/5)',
  PURCHASING: 'Mua hàng (5/5)',
  DONE: 'Hoàn thành',
  REJECTED: 'Đã từ chối',
  RETURNED: 'Trả lại bổ sung',
};
export const TERMINAL_STATUSES = [STATUS.DONE, 'Approved', STATUS.REJECTED, 'Rejected'];
export const ROLES = ['budget', 'supplier', 'contract', 'purchasing'];
export const BAD_ROLE = 'Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".';
export const MAX_SEND_BACK = { budget: 1, supplier: 1, contract: 2, purchasing: 2 };
const ROLE_STAGE = { budget: 'parallel', supplier: 'parallel', contract: 'contract', purchasing: 'purchasing' };
const STAGE_LABEL = { parallel: 'duyệt ngân sách & NCC', contract: 'thẩm định hợp đồng', purchasing: 'mua hàng', complete: 'complete' };
const COL = { budget: 'budget_approver_email', supplier: 'supplier_approver_email', contract: 'contract_approver_email', purchasing: 'purchasing_approver_email' };

const lower = (s) => String(s || '').trim().toLowerCase();
export const isRole = (r) => ROLES.includes(lower(r));
export const isRejected = (s) => s === STATUS.REJECTED || s === 'Rejected';
export const isComplete = (s) => s === STATUS.DONE || s === 'Approved';
export const isTerminal = (s) => isRejected(s) || isComplete(s);
export const isReturned = (s) => s === STATUS.RETURNED;
export const emailOf = (pr, role) => lower(pr[COL[role]]);

/** GAS computeP2PBranch_: services or grand total ≥ 2,000,000 ₫ → full (needs a contract reviewer). */
export function computeBranch(purchaseType, grandTotal) {
  return lower(purchaseType) === 'services' || (Number(grandTotal) || 0) >= 2000000 ? 'full' : 'simplified';
}
export const normalizePurchaseType = (t) => (lower(t) === 'services' ? 'services' : 'goods');

/** GAS computePRApprovalState_ line for line (the contract stage is unreachable on both branches). */
export function approvalState(pr, meta = {}) {
  const done = (r) => !emailOf(pr, r) || meta[`${r}Status`] === 'Approved';
  const branch = meta.p2pBranch || pr.p2p_branch || 'full';
  const skipContract = branch === 'full' || branch === 'simplified';
  if (!(done('budget') && done('supplier'))) return { stage: 'parallel', statusLabel: STATUS.PARALLEL };
  if (!skipContract && emailOf(pr, 'contract') && !done('contract')) return { stage: 'contract', statusLabel: STATUS.CONTRACT };
  if (emailOf(pr, 'purchasing') && !done('purchasing')) return { stage: 'purchasing', statusLabel: STATUS.PURCHASING };
  return { stage: 'complete', statusLabel: STATUS.DONE };
}

/** Who must act now: returned → the requester; open stage → its approvers who have not approved. */
export function pendingEmails(pr, meta = {}, status = pr.status) {
  if (isTerminal(status)) return [];
  if (isReturned(status)) return [lower(pr.requester_email || meta.requesterEmail)].filter(Boolean);
  const { stage } = approvalState(pr, meta);
  const open = ROLES.filter((r) => ROLE_STAGE[r] === stage && emailOf(pr, r) && meta[`${r}Status`] !== 'Approved');
  return [...new Set(open.map((r) => emailOf(pr, r)))];
}

/** Everyone named on the PR (visibility), contract reviewer included. */
export function approverEmails(pr) {
  return [...new Set(ROLES.map((r) => emailOf(pr, r)).filter(Boolean))];
}

/** The browser's signature check result: object as is, JSON string parsed, anything else kept raw (GAS). */
export function parseVerification(v) {
  if (v && typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : { raw: String(v) };
  } catch { return { raw: String(v) }; }
}

/** approvePurchaseRequest after the row is found (GAS checks 6–12, same order and wording). */
export function applyApprove(pr, meta = {}, { email, role, note = '', signature = '', verification = null, at }) {
  const r = lower(role);
  const me = lower(email);
  if (!isRole(r)) return { error: BAD_ROLE };
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối, không thể duyệt.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị này đã được duyệt rồi.' };
  if (isReturned(pr.status)) return { error: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.' };
  if (!emailOf(pr, r)) return { error: `Vai trò "${r}" chưa được phân công cho đề nghị này.` };
  if (emailOf(pr, r) !== me) return { error: `Bạn không được phân công là người duyệt "${r}" cho đề nghị này.` };
  const before = approvalState(pr, meta);
  if (ROLE_STAGE[r] !== before.stage) return { error: `Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: ${STAGE_LABEL[before.stage]}.` };
  if (meta[`${r}Status`] === 'Approved') return { error: 'Bạn đã duyệt đề nghị này rồi.' };
  // One approval covers every open slot this person holds in the same stage (decision 2026-10-07, GAS B12).
  const roles = ROLES.filter((x) => ROLE_STAGE[x] === before.stage && emailOf(pr, x) === me && meta[`${x}Status`] !== 'Approved');
  const next = { ...meta };
  for (const x of roles) {
    next[`${x}Status`] = 'Approved';
    next[`${x}ApprovedAt`] = at;
    next[`${x}Note`] = note || '';
    if (signature) next[`${x}Signature`] = signature;
    if (verification != null && verification !== '') next[`${x}SignatureVerification`] = parseVerification(verification);
  }
  const after = approvalState(pr, next);
  return { meta: next, roles, before, after, status: after.statusLabel };
}

/** rejectPurchaseRequest after the row is found (GAS checks 5–9: permission, turn, then status). */
export function applyReject(pr, meta = {}, { email, note = '', at }) {
  const me = lower(email);
  const mine = ROLES.filter((r) => emailOf(pr, r) === me);
  if (!mine.length) return { error: 'Bạn không có quyền từ chối đề nghị này.' };
  const { stage } = approvalState(pr, meta);
  const role = mine.find((r) => ROLE_STAGE[r] === stage);
  if (!role) return { error: 'Chưa đến lượt của bạn trong quy trình phê duyệt.' };
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối rồi.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị đã được duyệt, không thể từ chối.' };
  if (isReturned(pr.status)) return { error: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.' };
  return { role, meta: { ...meta, rejectedAt: at, rejectedBy: me, rejectionNote: note || '' }, status: STATUS.REJECTED };
}

/** sendBackPurchaseRequest checks 3–5 (before the lookup). */
export function sendBackInputError({ sentBackNote, targetStep, approverRole }) {
  if (!String(sentBackNote || '').trim()) return 'Vui lòng nhập lý do trả lại.';
  if (![1, 2, 3].includes(Number(targetStep))) return 'Bước trả lại không hợp lệ.';
  if (!isRole(approverRole)) return 'Vai trò không hợp lệ.';
  return null;
}

/** sendBackPurchaseRequest after the row is found (GAS checks 8–13: turn before assignment). */
export function applySendBack(pr, meta = {}, { email, role, targetStep, note, at }) {
  const r = lower(role);
  const step = Number(targetStep);
  if (isRejected(pr.status)) return { error: 'Đề nghị này đã bị từ chối.' };
  if (isComplete(pr.status)) return { error: 'Đề nghị này đã hoàn thành.' };
  if (isReturned(pr.status)) return { error: 'Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.' };
  if (ROLE_STAGE[r] !== approvalState(pr, meta).stage) return { error: 'Chưa đến lượt của bạn trong quy trình phê duyệt.' };
  if (emailOf(pr, r) !== lower(email)) return { error: `Bạn không được phân công vai trò "${r}" cho đề nghị này.` };
  if (step > MAX_SEND_BACK[r]) return { error: 'Bước trả lại không hợp lệ với vai trò của bạn.' };
  const history = Array.isArray(meta.sentBackHistory) ? meta.sentBackHistory : [];
  const next = { ...meta, sentBackHistory: [...history, { targetStep: step, by: lower(email), byRole: r, at, note: String(note).trim() }] };
  if (step === 1) return { meta: next, status: STATUS.RETURNED };
  for (const x of ROLES) {
    if (next[`${x}Status`] && next[`${x}Status`] !== 'N/A') {
      next[`${x}Status`] = 'Pending';
      delete next[`${x}ApprovedAt`];
      delete next[`${x}Note`];
    }
  }
  return { meta: next, status: STATUS.PARALLEL };
}

const PICK_LABEL = { budget: 'Người phê duyệt ngân sách', supplier: 'Người phê duyệt NCC', contract: 'Người thẩm định hợp đồng' };
/** The requester's picks must come from the lists the page offers (GAS trusted any email, S3). */
export function approverPickError(picks, { companyEmails, purchasingEmails }, branch) {
  for (const r of ['budget', 'supplier', 'contract']) {
    const e = lower(picks[r]);
    if (r === 'contract' && (branch !== 'full' || !e)) continue;
    if (!companyEmails.has(e)) {
      return `${PICK_LABEL[r]} (${e}) không thuộc danh sách người duyệt của công ty này (Đại diện pháp luật, Kế toán trưởng, Thủ quỹ).`;
    }
  }
  const p = lower(picks.purchasing);
  if (p && !purchasingEmails.has(p)) return `Người mua hàng (${p}) không thuộc phòng Kế Toán Chi.`;
  return null;
}

/** GAS _validatePRForDirectPayment_ PR-side rules (the payment check is the caller's). */
export function directPaymentProblem(row) {
  if (row.status !== STATUS.DONE) return 'PR chưa được phê duyệt hoàn tất.';
  if ((row.p2p_branch || (row.metadata || {}).p2pBranch || 'full') !== 'simplified') {
    return 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.';
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run `node --test tests/purchase-requests/state.test.js`. Expected: PASS (12 tests). Then run the full suite. Expected: 152 pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/purchase-requests/state.js tests/purchase-requests/state.test.js
git commit -m "feat(pr): pure approval rules (GAS chain, one approval per person, step-3 send back refused)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: PR number allocation

**Files:**
- Create: `api/lib/purchase-requests/numbering.js`
- Test: `tests/purchase-requests/numbering.test.js`

**Interfaces:**
- Consumes: `purchase_requests.pr_no`, `pr_audit_log.doc_no`.
- Produces:
  - `vnDate(d?: Date) → 'YYYYMMDD'` (Asia/Ho_Chi_Minh).
  - `cleanPrefix(code) → string`.
  - `PR_NO_RE`.
  - `choosePRNo({prefix, date, requested, taken:Set}) → string`.
  - `prefixFor(company, requested) → string`.
  - `allocatePRNo(client, {prefix, requested, now}) → Promise<string>`. It must run inside the caller's transaction, and the lock holds until COMMIT.

The rules fix the old handler's bugs: the prefix came from the company *name*, the date was UTC, and the sequence ignored existing numbers.
- Prefix: the company's `company_code` cleaned (`E.V` → `EV`). Fallback: the requested number's prefix, then `PR`.
- Date: today in Vietnam.
- The page's number is kept when it has today's date and the company prefix and is free. Otherwise the tail is incremented, as GAS did.
- Numbers seen only in `pr_audit_log` are also "taken". Three live numbers belonged to PRs deleted by hand.

- [ ] **Step 1: Write the failing test**

```js
// tests/purchase-requests/numbering.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { vnDate, cleanPrefix, choosePRNo, prefixFor, allocatePRNo } from '../../api/lib/purchase-requests/numbering.js';

test('vnDate: Vietnam calendar day (UTC+7)', () => {
  assert.equal(vnDate(new Date('2026-10-06T16:59:59Z')), '20261006');
  assert.equal(vnDate(new Date('2026-10-06T17:00:00Z')), '20261007');
});
test('cleanPrefix / prefixFor: company code, not the company name', () => {
  assert.equal(cleanPrefix('E.V'), 'EV');
  assert.equal(cleanPrefix(' w.s '), 'WS');
  assert.equal(prefixFor({ company_code: 'E.V' }, 'XX-PR20261007000001'), 'EV');
  assert.equal(prefixFor({ company_code: '' }, 'MI-PR20261007000004'), 'MI');
  assert.equal(prefixFor(null, 'CÔNG TY TNHH EGG VENTURES (E.V)'), 'PR');
});
test('choosePRNo: requested number kept when free', () => {
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261007000003', taken: new Set() }), 'EV-PR20261007000003');
});
test('choosePRNo: taken → next free tail (GAS allocateUniquePRNoOnServer_)', () => {
  const taken = new Set(['EV-PR20261007000003', 'EV-PR20261007000004']);
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261007000003', taken }), 'EV-PR20261007000005');
});
test('choosePRNo: other date / other prefix / garbage → today, first free from 1', () => {
  const taken = new Set(['EV-PR20261007000001']);
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'EV-PR20261006000009', taken }), 'EV-PR20261007000002');
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: 'TL-PR20261007000009', taken }), 'EV-PR20261007000002');
  assert.equal(choosePRNo({ prefix: 'EV', date: '20261007', requested: '', taken: new Set() }), 'EV-PR20261007000001');
});

const url = process.env.TEST_DATABASE_URL;
const db = url ? new pg.Pool({ connectionString: url }) : null;
after(async () => { if (db) await db.end(); });

test('allocatePRNo: two concurrent submits of the same number get different numbers', { skip: !url && 'needs TEST_DATABASE_URL' }, async () => {
  await db.query(`DELETE FROM purchase_requests WHERE pr_no LIKE 'QQ-%'; DELETE FROM pr_audit_log WHERE doc_no LIKE 'QQ-%'`);
  const now = new Date();
  const want = `QQ-PR${vnDate(now)}000001`;
  await db.query(`INSERT INTO pr_audit_log (doc_no, action) VALUES ($1, 'Submit')`, [`QQ-PR${vnDate(now)}000002`]); // audit-only number
  const a = await db.connect();
  const b = await db.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    const first = await allocatePRNo(a, { prefix: 'QQ', requested: want, now });
    await a.query(`INSERT INTO purchase_requests (pr_no) VALUES ($1)`, [first]);
    const second = allocatePRNo(b, { prefix: 'QQ', requested: want, now }); // waits for a's lock
    await a.query('COMMIT');
    assert.equal(first, want);
    assert.equal(await second, `QQ-PR${vnDate(now)}000003`);
    await b.query('ROLLBACK');
  } finally { a.release(); b.release(); }
  await db.query(`DELETE FROM purchase_requests WHERE pr_no LIKE 'QQ-%'; DELETE FROM pr_audit_log WHERE doc_no LIKE 'QQ-%'`);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test node --test tests/purchase-requests/numbering.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement numbering.js**

```js
// api/lib/purchase-requests/numbering.js — "{CODE}-PR{YYYYMMDD}{NNNNNN}" (purchase_request.html format).
// Pure rules + one DB function that must run inside the caller's transaction.
export const PR_NO_RE = /^([A-Z0-9]+)-PR(\d{8})(\d{6,})$/;

export function vnDate(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

/** Same cleaning as the page's dataset.code: accents dropped, non-alphanumerics removed, upper-cased. */
export const cleanPrefix = (code) => String(code || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export function prefixFor(company, requested) {
  const m = PR_NO_RE.exec(String(requested || '').trim());
  return cleanPrefix(company && company.company_code) || (m ? m[1] : '') || 'PR';
}

/** Keep the page's number when it is today's, has the company prefix and is free; else the next free tail. */
export function choosePRNo({ prefix, date, requested, taken }) {
  const base = `${prefix}-PR${date}`;
  const m = PR_NO_RE.exec(String(requested || '').trim());
  const sameBase = !!m && m[1] === prefix && m[2] === date;
  if (sameBase && !taken.has(m[0])) return m[0];
  const width = sameBase ? m[3].length : 6;
  const fmt = (n) => base + String(n).padStart(width, '0');
  let n = sameBase ? Number(m[3]) : 1;
  while (taken.has(fmt(n))) n += 1;
  return fmt(n);
}

/** One number per (prefix, Vietnam day) at a time: the advisory lock is held until the caller commits. */
export async function allocatePRNo(client, { prefix, requested, now = new Date() }) {
  const p = cleanPrefix(prefix) || 'PR';
  const date = vnDate(now);
  const base = `${p}-PR${date}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pr_no:' + base]);
  const { rows } = await client.query(
    `SELECT pr_no AS no FROM purchase_requests WHERE pr_no LIKE $1
     UNION SELECT doc_no FROM pr_audit_log WHERE doc_no LIKE $1`, [base + '%']);
  return choosePRNo({ prefix: p, date, requested, taken: new Set(rows.map((r) => r.no)) });
}
```

- [ ] **Step 4: Run the tests**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test node --test tests/purchase-requests/numbering.test.js`. Expected: PASS (6 tests). Then run the full suite. Expected: 158 pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/purchase-requests/numbering.js tests/purchase-requests/numbering.test.js
git commit -m "feat(pr): PR numbers by company code and Vietnam date, safe under concurrency

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: PR emails

**Files:**
- Create: `api/lib/purchase-requests/emails.js`
- Test: `tests/purchase-requests/emails.test.js`

**Interfaces:**
- Consumes: `baseUrl()` and `money(amount)` from `api/lib/vouchers/emails.js`, and a PR row (column names).
- Produces:
  - `prLink(prNo) → string`.
  - `ROLE_LABEL`.
  - These return `{to, subject, html}` or `null`:
    - `submitConfirmation(pr)`
    - `purchasingRequest(pr)`
    - `completed(pr)`
    - `rejectedNotice(pr, {by, note})`
  - These return arrays of `{to, subject, html}`:
    - `approvalRequests(pr)`
    - `sendBackNotices(pr, {targetStep, byRole, note})`
    - `resubmitNotices(pr)`
- Every message's `to` is lower-case and unique within its array.

- [ ] **Step 1: Write the failing test**

```js
// tests/purchase-requests/emails.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_BASE_URL = 'https://wf.test';
const m = await import('../../api/lib/purchase-requests/emails.js');

const pr = {
  pr_no: 'EV-PR20261007000001', company_name: 'CÔNG TY <b>EV</b>', requester_name: 'Thư', requester_email: 'Req@x.vn',
  purpose: 'Mua <script>x</script>', grand_total: '149500', required_date: '2026-10-20',
  budget_approver_email: 'Linh@x.vn', supplier_approver_email: 'linh@x.vn', purchasing_approver_email: 'Tlc.ap@x.vn',
  attachments: [{ fileName: 'bao-gia.pdf', fileUrl: 'https://attachments.tl-c.us/purchase-requests/a-bao-gia.pdf' }, { fileName: 'x', fileUrl: '', error: 'e' }],
};

test('approvalRequests: one email when budget and supplier are the same person (B12)', () => {
  const list = m.approvalRequests(pr);
  assert.equal(list.length, 1);
  assert.equal(list[0].to, 'linh@x.vn');
  assert.equal(list[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - EV-PR20261007000001');
  assert.match(list[0].html, /Đề nghị mua hàng<\/strong> mới đang chờ phê duyệt của bạn/);
  assert.match(list[0].html, /149\.500 ₫/);
  assert.match(list[0].html, /Ngày cần hàng/);
  assert.match(list[0].html, /https:\/\/attachments\.tl-c\.us\/purchase-requests\/a-bao-gia\.pdf/);
  assert.equal(m.approvalRequests({ ...pr, supplier_approver_email: 'ncc@x.vn' }).length, 2);
});
test('every value is HTML-escaped (S7) and every email links to the PR, without action tokens (S10)', () => {
  const html = m.approvalRequests(pr)[0].html;
  assert.doesNotMatch(html, /<script>|<b>EV/);
  assert.match(html, /Mua &lt;script&gt;/);
  assert.match(html, /href="https:\/\/wf\.test\/purchase_request\.html\?prNo=EV-PR20261007000001"/);
  assert.equal(m.prLink('A B'), 'https://wf.test/purchase_request.html?prNo=A%20B');
});
test('submitConfirmation: to the requester, no "Người đề nghị" row', () => {
  const c = m.submitConfirmation(pr);
  assert.equal(c.to, 'req@x.vn');
  assert.equal(c.subject, '[ĐỀ NGHỊ MUA HÀNG] Xác nhận gửi phiếu - EV-PR20261007000001');
  assert.match(c.html, /Người phê duyệt đã được thông báo qua email/);
  assert.doesNotMatch(c.html, />Người đề nghị</);
  assert.equal(m.submitConfirmation({ ...pr, requester_email: '' }), null);
});
test('purchasingRequest (B2: sent on both branches) and completed', () => {
  const p = m.purchasingRequest(pr);
  assert.equal(p.to, 'tlc.ap@x.vn');
  assert.equal(p.subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261007000001');
  assert.equal(m.purchasingRequest({ ...pr, purchasing_approver_email: '' }), null);
  const d = m.completed(pr);
  assert.equal(d.to, 'req@x.vn');
  assert.equal(d.subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - EV-PR20261007000001');
  assert.match(d.html, /phê duyệt hoàn tất/);
});
test('rejectedNotice: new in Postgres (B13)', () => {
  const r = m.rejectedNotice(pr, { by: 'Lê Linh', note: 'Giá <cao>' });
  assert.equal(r.to, 'req@x.vn');
  assert.equal(r.subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu bị từ chối - EV-PR20261007000001');
  assert.match(r.html, /Lý do từ chối:<\/strong><br>Giá &lt;cao&gt;/);
});
test('sendBackNotices: step 1 → requester, step 2 → budget + supplier once', () => {
  const one = m.sendBackNotices(pr, { targetStep: 1, byRole: 'budget', note: 'Thiếu báo giá' });
  assert.deepEqual(one.map((x) => x.to), ['req@x.vn']);
  assert.equal(one[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu được trả lại để bổ sung - EV-PR20261007000001');
  assert.match(one[0].html, /Chỉnh sửa &amp; Gửi lại/);
  assert.match(one[0].html, /Người duyệt Ngân sách/);
  const two = m.sendBackNotices(pr, { targetStep: 2, byRole: 'purchasing', note: 'Sai NCC' });
  assert.deepEqual(two.map((x) => x.to), ['linh@x.vn']);
  assert.equal(two[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Ngân sách & NCC - EV-PR20261007000001');
});
test('resubmitNotices: budget + supplier once', () => {
  const r = m.resubmitNotices(pr);
  assert.deepEqual(r.map((x) => x.to), ['linh@x.vn']);
  assert.equal(r[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - EV-PR20261007000001');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `node --test tests/purchase-requests/emails.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement emails.js**

```js
// api/lib/purchase-requests/emails.js — Purchase request emails (pure). Ported from GAS
// sendPurchaseRequestEmails_, sendPurchaseRequestStageEmail_, sendPurchaseRequestSendBackEmail_,
// sendPurchaseRequestResubmitEmails_ (TLCG_P2P_BACKEND.gs), with on purpose:
// - values HTML-escaped (S7) and a plain deep link to the PR (login required; no action tokens, S10);
// - one email per distinct address (B12); the purchasing email on both branches (B2);
// - a rejection email to the requester (B13).
import { baseUrl, money } from '../vouchers/emails.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = (s) => String(s || '').trim().toLowerCase();
const distinct = (...emails) => [...new Set(emails.map(lower).filter(Boolean))];
const P = '[ĐỀ NGHỊ MUA HÀNG]';
const SIGN_OFF = '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
export const ROLE_LABEL = { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' };

export const prLink = (no) => `${baseUrl()}/purchase_request.html?prNo=${encodeURIComponent(no)}`;
const button = (no) => `<p style="margin:16px 0;"><a href="${esc(prLink(no))}" style="background:#4285f4;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Mở đề nghị ${esc(no)}</a></p>`;

function table(pr, { requester = true, requiredDate = true } = {}) {
  const rows = [['Số phiếu', pr.pr_no], ['Công ty', pr.company_name]];
  if (requester) rows.push(['Người đề nghị', pr.requester_name]);
  rows.push(['Mục đích', pr.purpose], ['Tổng cộng', money(Number(pr.grand_total) || 0)]);
  if (requiredDate) rows.push(['Ngày cần hàng', pr.required_date]);
  return `<table style="border-collapse:collapse;margin:12px 0;">${rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px;border:1px solid #e2e8f0;font-weight:600;">${k}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${esc(v)}</td></tr>`).join('')}</table>`;
}
function attachmentList(pr) {
  const files = (pr.attachments || []).filter((a) => a && a.fileUrl);
  if (!files.length) return '';
  return `<p><strong>Tệp đính kèm:</strong></p><ul>${files.map((a) => `<li><a href="${esc(a.fileUrl)}">${esc(a.fileName || a.fileUrl)}</a></li>`).join('')}</ul>`;
}
const box = (title, text) => `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin:12px 0;"><strong>${title}</strong><br>${esc(text)}</div>`;
const mail = (to, subject, body) => ({ to, subject, html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;">${body}${SIGN_OFF}</div>` });

export function approvalRequests(pr) {
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to, `${P} Yêu cầu phê duyệt - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Có một <strong>Đề nghị mua hàng</strong> mới đang chờ phê duyệt của bạn.</p>${table(pr)}
     <p>Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>${button(pr.pr_no)}${attachmentList(pr)}`));
}

export function submitConfirmation(pr) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Xác nhận gửi phiếu - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng của bạn đã được gửi thành công.</p>${table(pr, { requester: false })}
     <p>Người phê duyệt đã được thông báo qua email và sẽ xử lý đề nghị của bạn.</p>${button(pr.pr_no)}${attachmentList(pr)}`);
}

export function purchasingRequest(pr) {
  const to = lower(pr.purchasing_approver_email);
  if (!to) return null;
  return mail(to, `${P} Yêu cầu Mua hàng - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Giai đoạn <strong>Mua hàng</strong> của Đề nghị mua hàng đã mở và đang chờ xử lý của bạn.</p>${table(pr)}${button(pr.pr_no)}`);
}

export function completed(pr) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Phiếu đã hoàn thành - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng <strong>${esc(pr.pr_no)}</strong> của bạn đã được <strong>phê duyệt hoàn tất</strong>.</p>
     <p>Công ty: ${esc(pr.company_name)}</p>${button(pr.pr_no)}`);
}

export function rejectedNotice(pr, { by, note }) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Phiếu bị từ chối - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng <strong>${esc(pr.pr_no)}</strong> của bạn đã bị <strong>từ chối</strong> bởi ${esc(by)}.</p>
     ${table(pr, { requester: false })}${note ? box('Lý do từ chối:', note) : ''}${button(pr.pr_no)}`);
}

export function sendBackNotices(pr, { targetStep, byRole, note }) {
  const who = ROLE_LABEL[byRole] || byRole;
  const reason = box('Lý do trả lại:', note);
  if (Number(targetStep) === 1) {
    const to = lower(pr.requester_email);
    return to ? [mail(to, `${P} Phiếu được trả lại để bổ sung - ${pr.pr_no}`,
      `<p>Kính gửi ${esc(pr.requester_name)},</p><p>${esc(who)} đã trả lại đề nghị mua hàng của bạn để bổ sung thông tin.</p>
       ${table(pr, { requiredDate: false })}${reason}<p>Vui lòng mở đề nghị và chọn <strong>"Chỉnh sửa &amp; Gửi lại"</strong>.</p>${button(pr.pr_no)}`)] : [];
  }
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to,
    `${P} Yêu cầu xem lại - Bước Ngân sách & NCC - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>${esc(who)} đã trả lại đề nghị mua hàng về bước <strong>Duyệt ngân sách &amp; NCC</strong>. Vui lòng xem lại và phê duyệt lại.</p>
     ${table(pr, { requiredDate: false })}${reason}${button(pr.pr_no)}`));
}

export function resubmitNotices(pr) {
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to,
    `${P} Phiếu đã được cập nhật và gửi lại - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Người đề nghị đã cập nhật và gửi lại <strong>Đề nghị mua hàng</strong>. Vui lòng xem lại và phê duyệt.</p>
     ${table(pr)}${button(pr.pr_no)}${attachmentList(pr)}`));
}
```

- [ ] **Step 4: Run the tests**

Run `node --test tests/purchase-requests/emails.test.js`. Expected: PASS (7 tests). Then run the full suite. Expected: 165 pass.

- [ ] **Step 5: Commit**

```bash
git add api/lib/purchase-requests/emails.js tests/purchase-requests/emails.test.js
git commit -m "feat(pr): Vietnamese PR emails with deep links, escaped, one per address

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Submit (`purchaseRequest`) with R2 attachments

**Files:**
- Create:
  - `api/lib/purchase-requests/validate.js`
  - `api/lib/purchase-requests/attachments.js`
  - `api/lib/purchase-requests/respond.js`
  - `api/handlers/pr/tx.js`
  - `api/handlers/pr/submit.js`
  - `tests/purchase-requests/helpers.js`
- Modify:
  - `api/lib/files/r2.js`: add `prAttachmentKey`.
  - `api/router.js`: point `purchaseRequest` at the new handler.
- Test: `tests/purchase-requests/validate.test.js`, `tests/purchase-requests/submit.test.js`

**Interfaces:**
- Consumes:
  - From Task 1: `insertPR`, `recordChange`, `approverCandidates`, `lockPR`, `updatePR`.
  - From Task 2: `STATUS`, `approverEmails`, `pendingEmails`, `approverPickError`, `computeBranch`, `normalizePurchaseType`.
  - From Task 3: `allocatePRNo`, `prefixFor`.
  - From Task 4: `approvalRequests`, `submitConfirmation`.
  - Existing:
    - `findCompany(db, name, key)` from `api/lib/vouchers/repo.js`.
    - `toAmount` from `api/lib/vouchers/repo.js`.
    - `queueMail(msg, db)`.
    - `publishEvent(type, data)`.
    - `callerFromRequest`.
    - `getS3`, `validateUpload`, `baseType`, `contentDisposition`, `R2_BUCKET`, `R2_PUBLIC_URL` from r2.js.
- Produces:
  - validate.js:
    - `normalizePriority(p)`
    - `num(v)`
    - `parseItems(items) → {items}|{error}`
    - `itemsTotal(items) → number`
    - `checkSubmission(b) → {error}|{items, purchaseType, grandTotal, branch, picks:{budget,supplier,contract,purchasing}}`
    - `buildMetadata(b, {companyKey, requesterEmail, submittedAt, attachments, purchaseType, branch, picks}) → object`
  - attachments.js:
    - `MAX_FILES = 5`
    - `parseAttachmentList(v) → array`
    - `decodeFile(a) → {fileName, mimeType, body: Buffer}`
    - `storeAttachments(s3, list) → [{fileName, fileUrl, fileSize}|{fileName, fileUrl:'', error}]`
  - respond.js:
    - `LOGIN_MSG`, `NO_ACCESS_MSG`
    - `ok(res, message, fields)`
    - `fail(res, message, status = 200)`
    - `signedInCaller(req, res, who) → caller|null`. It answers 401 itself.
    - `claimProblem(caller, claimed) → string|null`
  - tx.js:
    - `prDeps(d) → {db, s3, who, now, gasProxy, paymentsForPR, ...d}`
    - `withLockedPR(db, prNo, res, work)`. `work(client, row)` returns `{error}` or `{saved, mails, message, fields}`.
  - submit.js:
    - `prepareSubmission(db, b) → {error}|{company, sub}`
    - `submissionColumns(b, {company, sub, caller, metadata, attachments}) → row fields`
    - `handlePRSubmit(req, res, d?)`
  - r2.js: `prAttachmentKey(fileName, rand?) → 'purchase-requests/<32 hex>-<safe name>'`.
  - Every handler takes an optional third argument `d` that overrides `prDeps`. The router passes none.

Response: `{success:true, message:'Đề nghị mua hàng đã được gửi thành công.', prNo, data:{prNo}}`.

The validation order is GAS's (spec §3.1, checks 1–8), then:
- Company: `Không tìm thấy công ty trong Dữ liệu gốc: <name>`.
- The approver-pick check.
- Any exception: `Lỗi khi lưu đề nghị mua hàng: <msg>`.

Differences from GAS, on purpose:
- `grand_total` and the branch come from the items, not the client (S4).
- `submitted_at` and `metadata.submittedAt` are server time (S9).
- `requester_email` is the caller.
- Attachments go to R2 before the transaction, under keys without the PR number (B10).

- [ ] **Step 1: Write the failing pure tests**

```js
// tests/purchase-requests/validate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriority, itemsTotal, checkSubmission, buildMetadata } from '../../api/lib/purchase-requests/validate.js';
import { decodeFile, storeAttachments, parseAttachmentList } from '../../api/lib/purchase-requests/attachments.js';

const items = (total = '149500') => JSON.stringify([{ section: 'hang-hoa', desc: 'Khăn', qty: '5', price: '029900', total }]);
const body = (over = {}) => ({ companyName: 'CT', requesterName: 'Thư', requiredDate: '2026-10-20', budgetApprover: 'Linh@x.vn',
  supplierApprover: 'linh@x.vn', items: items(), purchaseType: 'goods', purchasingApprover: 'Tlc.ap@x.vn', ...over });

test('checkSubmission: GAS checks 1–8 in order, same wording', () => {
  const e = (over) => checkSubmission(body(over)).error;
  assert.equal(e({ companyName: '' }), 'Thiếu tên công ty.');
  assert.equal(e({ requesterName: ' ' }), 'Thiếu tên người đề nghị.');
  assert.equal(e({ requiredDate: '' }), 'Thiếu ngày cần hàng.');
  assert.equal(e({ budgetApprover: '' }), 'Vui lòng chọn người phê duyệt ngân sách.');
  assert.equal(e({ supplierApprover: '' }), 'Vui lòng chọn người phê duyệt NCC.');
  assert.match(e({ items: '[{' }), /^Dữ liệu hàng hóa không hợp lệ: /);
  assert.equal(e({ items: '[]' }), 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.');
  assert.equal(e({ purchaseType: 'services' }), 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
});
test('checkSubmission: total and branch from the items, never the client (S4); picks lower-cased', () => {
  const s = checkSubmission(body({ grandTotal: 1, items: items('2500000'), contractApprover: 'KT@x.vn' }));
  assert.equal(s.grandTotal, 2500000);
  assert.equal(s.branch, 'full');
  assert.deepEqual(s.picks, { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' });
  assert.equal(checkSubmission(body({ contractApprover: 'kt@x.vn' })).picks.contract, '', 'simplified stores no contract reviewer');
});
test('itemsTotal: totals, else qty × price; leading zeros and dotted thousands', () => {
  assert.equal(itemsTotal([{ total: '149500' }, { qty: '2', price: '02000000' }, { total: '1.500.000' }]), 149500 + 4000000 + 1500000);
});
test('normalizePriority: GAS mapping, unknown kept, empty → Bình Thường', () => {
  assert.deepEqual(['gap', 'binh_thuong', 'khong_gap', 'high', '', 'Khác'].map(normalizePriority),
    ['Gấp', 'Bình Thường', 'Không Gấp', 'Gấp', 'Bình Thường', 'Khác']);
});
test('buildMetadata: GAS keys and statuses', () => {
  const s = checkSubmission(body());
  const m = buildMetadata(body({ companyCode: 'CT (E.V)', vendorTaxId: '0312' }), { companyKey: 'E.V', requesterEmail: 'req@x.vn', submittedAt: 'T', attachments: [], purchaseType: s.purchaseType, branch: s.branch, picks: s.picks });
  assert.equal(m.budgetStatus, 'Pending');
  assert.equal(m.contractStatus, 'N/A');
  assert.equal(m.purchasingStatus, 'Pending');
  assert.equal(m.p2pBranch, 'simplified');
  assert.equal(m.companyCode, 'CT (E.V)');
  assert.equal(m.vendorDetails.vendorTaxId, '0312');
  assert.equal(m.submittedAt, 'T');
});
test('decodeFile: data URL or bare base64', () => {
  const a = decodeFile({ fileName: 'a.pdf', fileData: 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64') });
  assert.equal(a.mimeType, 'application/pdf');
  assert.equal(a.body.toString(), '%PDF');
  assert.equal(decodeFile({ fileName: 'b.txt', fileData: Buffer.from('hi').toString('base64'), mimeType: 'text/plain' }).body.toString(), 'hi');
  assert.deepEqual(parseAttachmentList('[{"fileName":"a"}]'), [{ fileName: 'a' }]);
  assert.deepEqual(parseAttachmentList('nope'), []);
});
test('storeAttachments: R2 keys without the PR number; bad files recorded, never thrown (GAS)', async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.input); } };
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64');
  const out = await storeAttachments(s3, [
    { fileName: 'Báo giá.pdf', fileData: pdf },
    { fileName: 'x.html', fileData: Buffer.from('<p>').toString('base64'), mimeType: 'text/html' },
    { fileName: 'old.pdf', fileUrl: 'https://evil.example/x' },
  ]);
  assert.equal(out.length, 2, 'entries without fileData are ignored');
  assert.match(out[0].fileUrl, /^https:\/\/attachments\.tl-c\.us\/purchase-requests\/[0-9a-f]{32}-Bao_gia\.pdf$/);
  assert.equal(out[0].fileSize, 4);
  assert.deepEqual(out[1], { fileName: 'x.html', fileUrl: '', error: 'Loại file không được hỗ trợ' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ContentType, 'application/pdf');
  const none = await storeAttachments(null, [{ fileName: 'a.pdf', fileData: pdf }]);
  assert.deepEqual(none, [{ fileName: 'a.pdf', fileUrl: '', error: 'R2 chưa cấu hình' }]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run `node --test tests/purchase-requests/validate.test.js`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement validate.js, attachments.js, respond.js and r2.js prAttachmentKey**

```js
// api/lib/purchase-requests/validate.js — GAS handlePurchaseRequest checks and the stored metadata (pure).
import { toAmount } from '../vouchers/repo.js';
import { computeBranch, normalizePurchaseType } from './state.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const PRIORITY = { gap: 'Gấp', high: 'Gấp', binh_thuong: 'Bình Thường', medium: 'Bình Thường', khong_gap: 'Không Gấp', low: 'Không Gấp' };
export function normalizePriority(p) {
  const s = String(p || '').trim();
  return s ? PRIORITY[s.toLowerCase()] || s : 'Bình Thường';
}

/** "149500", "029900", "1.500.000", 2000000 → number (plain decimals kept, dotted thousands read as VND). */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(s) && !/^\d{1,3}\.\d{3}$/.test(s) ? Number(s) : toAmount(s);
}

export function parseItems(items) {
  let list;
  try { list = typeof items === 'string' || items == null ? JSON.parse(items ?? '') : items; }
  catch (e) { return { error: 'Dữ liệu hàng hóa không hợp lệ: ' + e.message }; }
  if (!Array.isArray(list) || !list.length) return { error: 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.' };
  return { items: list };
}

export const itemsTotal = (items) => Math.round(items.reduce((s, it) =>
  s + (num(it.total) || num(it.qty ?? it.quantity) * num(it.price ?? it.unitPrice)), 0) * 100) / 100;

/** Checks 1–8 of GAS handlePurchaseRequest, in order. Total and branch come from the items (S4). */
export function checkSubmission(b) {
  const empty = (k) => !String(b[k] ?? '').trim();
  if (empty('companyName')) return { error: 'Thiếu tên công ty.' };
  if (empty('requesterName')) return { error: 'Thiếu tên người đề nghị.' };
  if (empty('requiredDate')) return { error: 'Thiếu ngày cần hàng.' };
  if (empty('budgetApprover')) return { error: 'Vui lòng chọn người phê duyệt ngân sách.' };
  if (empty('supplierApprover')) return { error: 'Vui lòng chọn người phê duyệt NCC.' };
  const parsed = parseItems(b.items);
  if (parsed.error) return parsed;
  const purchaseType = normalizePurchaseType(b.purchaseType);
  const grandTotal = itemsTotal(parsed.items);
  const branch = computeBranch(purchaseType, grandTotal);
  if (branch === 'full' && empty('contractApprover')) {
    return { error: 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.' };
  }
  return {
    items: parsed.items, purchaseType, grandTotal, branch,
    picks: { budget: lower(b.budgetApprover), supplier: lower(b.supplierApprover),
      contract: branch === 'full' ? lower(b.contractApprover) : '', purchasing: lower(b.purchasingApprover) },
  };
}

/** metadata_json as GAS wrote it at submit (spec §1.4). */
export function buildMetadata(b, { companyKey, requesterEmail, submittedAt, attachments, purchaseType, branch, picks }) {
  const s = (k) => String(b[k] ?? '').trim();
  return {
    companyCode: s('companyCode'), companyKey: companyKey || '', requesterEmail,
    budgetApproverNote: s('budgetApproverNote'), supplierApproverNote: s('supplierApproverNote'),
    submittedAt, requesterSignature: String(b.requesterSignature || ''), attachments, purchaseType, p2pBranch: branch,
    budgetStatus: picks.budget ? 'Pending' : 'N/A', supplierStatus: picks.supplier ? 'Pending' : 'N/A',
    contractStatus: 'N/A', purchasingStatus: picks.purchasing ? 'Pending' : 'N/A',
    vendorDetails: {
      vendorType: s('vendorType'), vendorTaxId: s('vendorTaxId'), vendorAddress: s('vendorAddress'),
      vendorAccountName: s('vendorAccountName'), vendorAccountNo: s('vendorAccountNo'), vendorBankName: s('vendorBankName'),
      vendorTransferNote: s('vendorTransferNote'),
    },
  };
}
```

`num`: `/^\d{1,3}\.\d{3}$/` makes `"1.500"` read as 1,500 ₫, not 1.5. This matches how the voucher sheet stored amounts.

```js
// api/lib/purchase-requests/attachments.js — the page's base64 attachments → R2 (GAS: Drive, shared publicly).
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { R2_BUCKET, R2_PUBLIC_URL, prAttachmentKey, validateUpload, baseType, contentDisposition } from '../files/r2.js';

export const MAX_FILES = 5; // purchase_request.html MAX_ATTACH_FILES

export function parseAttachmentList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
}

export function decodeFile(a) {
  const raw = String(a.fileData || '');
  const m = raw.match(/^data:([^;,]*)(?:;[^,]*)?,(.*)$/s);
  return { fileName: String(a.fileName || 'attachment'), mimeType: baseType(a.mimeType || (m && m[1])), body: Buffer.from(m ? m[2] : raw, 'base64') };
}

/**
 * Like GAS, a file that cannot be stored never fails the request: it is recorded with fileUrl ''
 * and the reason. Entries without fileData are ignored (links are never taken from the client).
 * Keys carry no PR number, so a renumbered PR cannot point at another folder (B10).
 */
export async function storeAttachments(s3, list) {
  const out = [];
  let count = 0;
  for (const a of list) {
    if (!a || typeof a !== 'object' || !a.fileData) continue;
    count += 1;
    const f = decodeFile(a);
    const bad = count > MAX_FILES ? `Tối đa ${MAX_FILES} tệp`
      : validateUpload({ fileSize: f.body.length, fileName: f.fileName, mimeType: f.mimeType });
    if (bad) { out.push({ fileName: f.fileName, fileUrl: '', error: bad }); continue; }
    if (!s3) { out.push({ fileName: f.fileName, fileUrl: '', error: 'R2 chưa cấu hình' }); continue; }
    const key = prAttachmentKey(f.fileName);
    try {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: f.body, ContentType: f.mimeType,
        ContentDisposition: contentDisposition(f.mimeType) }));
      out.push({ fileName: f.fileName, fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: f.body.length });
    } catch (e) {
      out.push({ fileName: f.fileName, fileUrl: '', error: e.message });
    }
  }
  return out;
}
```

```js
// api/lib/purchase-requests/respond.js — PR response helpers (pure).
export const LOGIN_MSG = 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.';
export const NO_ACCESS_MSG = 'Bạn không có quyền xem đề nghị này.';

/** GAS spread its data into the top level; some pages read result.data.x (B8): send both. */
export const ok = (res, message, fields = {}) => res.json({ success: true, message, ...fields, data: fields });
export const fail = (res, message, status = 200) => res.status(status).json({ success: false, message });

/** The signed-in user, or null after answering 401. PR actions never trust emails in the body (S1). */
export async function signedInCaller(req, res, who) {
  let caller = null;
  try { caller = await who(req); } catch (e) { console.error('[PR] caller check:', e.message); }
  if (!caller) fail(res, LOGIN_MSG, 401);
  return caller;
}

/** approverEmail / requesterEmail sent by the page may only repeat the signed-in user's own. */
export function claimProblem(caller, claimed) {
  const want = String(claimed || '').trim().toLowerCase();
  return want && want !== caller.email ? `Bạn đang đăng nhập bằng ${caller.email}, không thể thao tác thay ${want}.` : null;
}
```

In `api/lib/files/r2.js`, add this below `attachmentKey`:

```js
/** Purchase request attachments: no PR number in the key, so the number may still change (GAS B10). */
export function prAttachmentKey(fileName, rand = crypto.randomBytes(16).toString('hex')) {
  return `purchase-requests/${rand}-${safe(fileName) || 'attachment'}`;
}
```

- [ ] **Step 4: Run the pure tests**

Run `node --test tests/purchase-requests/validate.test.js`. Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing handler test and the shared helper**

```js
// tests/purchase-requests/helpers.js — shared setup for the PR handler tests (TEST_DATABASE_URL + Redis db 15).
import { vnDate } from '../../api/lib/purchase-requests/numbering.js';

export const url = process.env.TEST_DATABASE_URL;
export const skip = !url && 'set TEST_DATABASE_URL to run';
export const SIG_OK = JSON.stringify({ verified: true, similarity: 92, reason: 'ok' });
const lower = (s) => String(s || '').trim().toLowerCase();

export async function setup() {
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.APP_BASE_URL = 'https://wf.test';
  const pool = (await import('../../db/pool.js')).default;
  await pool.query('TRUNCATE purchase_requests, pr_audit_log, email_queue, sheet_outbox');
  const company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  const ap = (await pool.query(`SELECT LOWER(email) AS e FROM employees WHERE status = 'active'
    AND LOWER(TRIM(department)) = LOWER('Kế Toán Chi') ORDER BY id LIMIT 1`)).rows[0].e;
  const people = { treasurer: lower(company.treasurer_email), accountant: lower(company.accountant_email), legal: lower(company.legal_rep_email), ap };
  return { pool, company, people };
}

export async function teardown(pool) {
  if (!pool) return;
  await pool.end();
  (await import('../../db/redis.js')).default.quit?.();
}

export const as = (email, extra = {}) => ({ id: 0, email: lower(email), name: email.split('@')[0], isAdmin: false, ...extra });

/** Call a handler as `caller` (null = no token), without R2 unless extra.s3 is given. */
export function call(fn, body, caller = null, extra = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
    Promise.resolve(fn({ body, query: {}, headers: {} }, res, { who: async () => caller, s3: null, ...extra })).catch(reject);
  });
}

let seq = 0;
/** What purchase_request.html submitForm() sends (simplified branch: 149,500 ₫, same person on budget + supplier). */
export function submitBody(company, people, over = {}) {
  seq += 1;
  return {
    prNo: `EV-PR${vnDate()}${String(seq).padStart(6, '0')}`, companyCode: `${company.company_name} (${company.company_key})`,
    companyName: company.company_name, companyKey: company.company_key, department: 'Phòng Bán Hàng', requesterName: 'Người Đề Nghị',
    requiredDate: '2026-10-20', priority: 'binh_thuong', purpose: 'Mua khăn giấy',
    items: JSON.stringify([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Khăn giấy', qty: '5', unit: 'Cái', price: '29900', total: '149500', note: '' }]),
    grandTotal: 149500, purchaseType: 'goods', p2pBranch: 'simplified', budgetApprover: people.treasurer, supplierApprover: people.treasurer,
    contractApprover: '', purchasingApprover: people.ap, requesterSignature: 'data:image/png;base64,AAAA',
    submittedAt: '2020-01-01T00:00:00.000Z', ...over,
  };
}
```

```js
// tests/purchase-requests/submit.test.js — purchaseRequest on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody } from './helpers.js';

let h, pool, company, people;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  h = await import('../../api/handlers/pr/submit.js');
});
after(() => teardown(pool));
const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mails = async (no) => (await pool.query(`SELECT to_email, subject FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${no}`])).rows;

test('no login token → 401', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people), null);
  assert.equal(r.code, 401);
  assert.equal(r.message, 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.');
});

test('submit: stored with the GAS shape, caller as requester, one email to the shared approver', { skip }, async () => {
  const body = submitBody(company, people, { grandTotal: 999999999 });
  const r = await call(h.handlePRSubmit, body, REQ);
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đề nghị mua hàng đã được gửi thành công.');
  assert.equal(r.prNo, body.prNo, 'page number kept');
  assert.equal(r.data.prNo, body.prNo);
  const row = await pr(body.prNo);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.equal(row.requester_email, 'req@pr-test.vn');
  assert.equal(Number(row.grand_total), 149500, 'server total, not the client figure (S4)');
  assert.equal(row.p2p_branch, 'simplified');
  assert.equal(row.company_id, company.id);
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  assert.deepEqual(row.approver_emails, [people.treasurer, people.ap]);
  assert.notEqual(row.metadata.submittedAt, '2020-01-01T00:00:00.000Z', 'server clock (S9)');
  assert.equal(row.metadata.requesterEmail, 'req@pr-test.vn');
  assert.equal(row.priority, 'Bình Thường');
  const m = await mails(body.prNo);
  assert.deepEqual(m.map((x) => x.to_email), [people.treasurer, 'req@pr-test.vn']);
  const audit = (await pool.query('SELECT action, role, new_status, extra FROM pr_audit_log WHERE doc_no = $1', [body.prNo])).rows;
  assert.deepEqual(audit.map((a) => [a.action, a.role]), [['Submit', 'requester']]);
  assert.deepEqual(audit[0].extra, { purchaseType: 'goods', p2pBranch: 'simplified' });
});

test('same number twice → next free tail, response carries the issued number', { skip }, async () => {
  const body = submitBody(company, people);
  await call(h.handlePRSubmit, body, REQ);
  const r = await call(h.handlePRSubmit, body, REQ);
  assert.equal(r.success, true);
  assert.notEqual(r.prNo, body.prNo);
  assert.equal(r.prNo.slice(0, -6), body.prNo.slice(0, -6));
});

test('GAS validation wording comes first', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { requiredDate: '' }), REQ);
  assert.deepEqual([r.success, r.message], [false, 'Thiếu ngày cần hàng.']);
});

test('approver outside the company list is refused (S3)', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { budgetApprover: 'req@pr-test.vn' }), REQ);
  assert.equal(r.success, false);
  assert.match(r.message, /^Người phê duyệt ngân sách \(req@pr-test\.vn\) không thuộc danh sách người duyệt của công ty này/);
});

test('full branch needs a contract reviewer from the company list', { skip }, async () => {
  const big = JSON.stringify([{ desc: 'Tủ lạnh', qty: '1', price: '25000000', total: '25000000' }]);
  const r1 = await call(h.handlePRSubmit, submitBody(company, people, { items: big }), REQ);
  assert.equal(r1.message, 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const r2 = await call(h.handlePRSubmit, submitBody(company, people, { items: big, contractApprover: people.accountant }), REQ);
  assert.equal(r2.success, true, r2.message);
  assert.equal((await pr(r2.prNo)).contract_approver_email, people.accountant);
});

test('requesterEmail of someone else is refused', { skip }, async () => {
  const r = await call(h.handlePRSubmit, submitBody(company, people, { requesterEmail: 'boss@x.vn' }), REQ);
  assert.equal(r.message, 'Bạn đang đăng nhập bằng req@pr-test.vn, không thể thao tác thay boss@x.vn.');
});

test('attachments go to R2; a refused file is recorded and the submit still succeeds', { skip }, async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.input.Key); } };
  const files = [
    { fileName: 'bao-gia.pdf', fileData: Buffer.from('%PDF-1').toString('base64'), mimeType: 'application/pdf' },
    { fileName: 'x.svg', fileData: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' },
  ];
  const r = await call(h.handlePRSubmit, submitBody(company, people, { attachments: files }), REQ, { s3 });
  assert.equal(r.success, true);
  const row = await pr(r.prNo);
  assert.equal(sent.length, 1);
  assert.match(row.attachments[0].fileUrl, /\/purchase-requests\/[0-9a-f]{32}-bao-gia\.pdf$/);
  assert.equal(row.attachments[1].error, 'Loại file không được hỗ trợ');
  assert.deepEqual(row.metadata.attachments, row.attachments);
});
```

- [ ] **Step 6: Run the handler test and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/purchase-requests/submit.test.js`. Expected: FAIL (`…/handlers/pr/submit.js` not found).

- [ ] **Step 7: Implement tx.js and submit.js; route purchaseRequest**

```js
// api/handlers/pr/tx.js — default dependencies and the lock → rule → commit → email pattern of PR writes.
import pool from '../../../db/pool.js';
import { getS3 } from '../../lib/files/r2.js';
import { callerFromRequest } from '../../lib/auth-caller.js';
import gasProxy from '../../voucher.js';
import { queueMail } from '../email-queue.js';
import { publishEvent } from '../sse.js';
import { lockPR } from '../../lib/purchase-requests/repo.js';
import { ok, fail } from '../../lib/purchase-requests/respond.js';

/**
 * Handlers take `d` (tests) over these defaults. paymentsForPR(db, prNo) → [{status}] is the payment
 * side of validatePRForDirectPayment; Plan 6 replaces it when payments move to Postgres.
 */
export const prDeps = (d = {}) => ({
  db: pool, s3: getS3(), who: callerFromRequest, now: () => new Date(), gasProxy, paymentsForPR: async () => [], ...d,
});

/**
 * Lock the PR, run `work(client, row)` → { error } | { saved, mails, message, fields }, commit,
 * then queue the emails (never before commit) and answer in the GAS shape.
 */
export async function withLockedPR(db, prNo, res, work) {
  const client = await db.connect();
  let out;
  try {
    await client.query('BEGIN');
    const row = await lockPR(client, prNo);
    out = row ? await work(client, row) : { error: `Không tìm thấy đề nghị: ${prNo}` };
    await client.query(out.error ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PR] write failed:', e.message);
    return fail(res, 'Lỗi: ' + e.message);
  } finally { client.release(); }
  if (out.error) return fail(res, out.error);
  for (const m of (out.mails || []).filter(Boolean)) await queueMail(m, db);
  publishEvent('pr:updated', { prNo: out.saved.pr_no, status: out.saved.status });
  return ok(res, out.message, out.fields);
}
```

```js
// api/handlers/pr/submit.js — purchaseRequest (and, from Task 6, resubmitPurchaseRequest) on Postgres.
// Wire contract: TLCG_P2P_BACKEND.gs handlePurchaseRequest (spec §3.1); differences are listed in the plan.
import { findCompany } from '../../lib/vouchers/repo.js';
import { queueMail } from '../email-queue.js';
import { publishEvent } from '../sse.js';
import { STATUS, approverEmails, pendingEmails, approverPickError } from '../../lib/purchase-requests/state.js';
import { checkSubmission, buildMetadata, normalizePriority } from '../../lib/purchase-requests/validate.js';
import { parseAttachmentList, storeAttachments } from '../../lib/purchase-requests/attachments.js';
import { allocatePRNo, prefixFor } from '../../lib/purchase-requests/numbering.js';
import { insertPR, recordChange, approverCandidates } from '../../lib/purchase-requests/repo.js';
import { approvalRequests, submitConfirmation } from '../../lib/purchase-requests/emails.js';
import { ok, fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { prDeps } from './tx.js';

const str = (v) => String(v ?? '').trim();

/** GAS checks, the company, then the server check of the requester's approver picks. */
export async function prepareSubmission(db, b) {
  const sub = checkSubmission(b);
  if (sub.error) return sub;
  const company = await findCompany(db, b.companyName, b.companyKey);
  if (!company) return { error: 'Không tìm thấy công ty trong Dữ liệu gốc: ' + str(b.companyName) };
  const pickError = approverPickError(sub.picks, await approverCandidates(db, company), sub.branch);
  return pickError ? { error: pickError } : { company, sub };
}

/** The columns submit and resubmit both write (status back to the parallel stage, approvals from `metadata`). */
export function submissionColumns(b, { company, sub, caller, metadata, attachments }) {
  const row = {
    company_id: company.id, company_name: str(b.companyName), company_key: str(b.companyKey) || company.company_key || '',
    department: str(b.department), requester_name: str(b.requesterName), requester_email: caller.email,
    required_date: str(b.requiredDate), priority: normalizePriority(b.priority), purpose: str(b.purpose),
    vendor_name: str(b.vendorName || b.suggestedVendor), budget_code: str(b.budgetCode),
    budget_approver_email: sub.picks.budget, supplier_approver_email: sub.picks.supplier,
    contract_approver_email: sub.picks.contract, purchasing_approver_email: sub.picks.purchasing,
    items: sub.items, grand_total: sub.grandTotal, currency: str(b.currency) || 'VND', status: STATUS.PARALLEL,
    p2p_branch: sub.branch, purchase_type: sub.purchaseType, attachments, metadata,
  };
  row.approver_emails = approverEmails(row);
  row.pending_emails = pendingEmails(row, metadata, STATUS.PARALLEL);
  return row;
}

export async function handlePRSubmit(req, res, d) {
  const { db, s3, who, now } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    const prep = await prepareSubmission(db, b);
    if (prep.error) return fail(res, prep.error);
    const { company, sub } = prep;
    const attachments = await storeAttachments(s3, parseAttachmentList(b.attachments)); // before the transaction
    const at = now();
    const metadata = buildMetadata(b, { companyKey: str(b.companyKey) || company.company_key, requesterEmail: caller.email,
      submittedAt: at.toISOString(), attachments, purchaseType: sub.purchaseType, branch: sub.branch, picks: sub.picks });
    const client = await db.connect();
    let row;
    try {
      await client.query('BEGIN');
      const prNo = await allocatePRNo(client, { prefix: prefixFor(company, b.prNo), requested: b.prNo, now: at });
      row = await insertPR(client, { pr_no: prNo, ...submissionColumns(b, { company, sub, caller, metadata, attachments }), submitted_at: at.toISOString() });
      await recordChange(client, row, { action: 'Submit', role: 'requester', actorEmail: caller.email, actorName: row.requester_name,
        prevStatus: '', newStatus: STATUS.PARALLEL, note: row.purpose, extra: { purchaseType: row.purchase_type, p2pBranch: row.p2p_branch }, at: at.toISOString() });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
    for (const m of [...approvalRequests(row), submitConfirmation(row)].filter(Boolean)) await queueMail(m, db);
    publishEvent('pr:submitted', { prNo: row.pr_no, status: row.status });
    return ok(res, 'Đề nghị mua hàng đã được gửi thành công.', { prNo: row.pr_no });
  } catch (err) {
    console.error('[PR] submit:', err.message);
    return fail(res, 'Lỗi khi lưu đề nghị mua hàng: ' + err.message);
  }
}
```

`api/router.js`: replace `handlePRSubmit` in the old import with `import { handlePRSubmit } from './handlers/pr/submit.js';`, and keep the four other old imports. `NEW_HANDLERS.purchaseRequest` stays `handlePRSubmit`.

- [ ] **Step 8: Run the tests**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test --test-concurrency=1 tests/purchase-requests/`. Expected: PASS (8 submit + 7 validate + the earlier files). Then run the full suite. Expected: 180 pass.

- [ ] **Step 9: Commit**

```bash
git add api/lib/purchase-requests/{validate,attachments,respond}.js api/lib/files/r2.js api/handlers/pr/tx.js api/handlers/pr/submit.js api/router.js tests/purchase-requests/{helpers.js,validate.test.js,submit.test.js}
git commit -m "feat(pr): submit on Postgres - GAS checks, server-checked approvers, R2 attachments, deduped emails

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Approve, reject, send back, resubmit

**Files:**
- Create: `api/handlers/pr/decide.js`
- Modify:
  - `api/handlers/pr/submit.js`: add `handlePRResubmit`.
  - `api/router.js`: approve, reject, send back and resubmit point at the new handlers; `WORKFLOW_ACTIONS.p2p` gains `resubmitPurchaseRequest` and `sendBackPurchaseRequest`.
- Test: `tests/purchase-requests/decide.test.js`

**Interfaces:**
- Consumes:
  - From Task 2: `applyApprove`, `applyReject`, `sendBackInputError`, `applySendBack`, `pendingEmails`, `isRole`, `BAD_ROLE`, `isReturned`, `STATUS`.
  - From Task 1: `updatePR`, `recordChange`, `getPR`.
  - From Task 4: `purchasingRequest`, `completed`, `rejectedNotice`, `sendBackNotices`, `resubmitNotices`.
  - From Task 5: `prDeps`, `withLockedPR`, `prepareSubmission`, `submissionColumns`, `buildMetadata`, `storeAttachments`, `parseAttachmentList`, `signedInCaller`, `claimProblem`, `fail`.
- Produces: `handlePRApprove`, `handlePRReject`, `handlePRSendBack` (decide.js), and `handlePRResubmit` (submit.js). All have the signature `(req, res, d?)`.

Responses and order of checks:

| Action | Pre-lookup checks (in order) | After the row is found | Success |
|---|---|---|---|
| approve | login; `Thiếu số phiếu mua hàng.`; body email = caller; `BAD_ROLE` | not found `Không tìm thấy đề nghị: <no>`; `applyApprove` | `Đã duyệt thành công.` `{prNo, status}` |
| reject | login; `Thiếu số phiếu mua hàng.`; body email = caller | not found; `applyReject` | `Đã từ chối thành công.` `{prNo, status:'Đã từ chối'}` |
| send back | login; `Thiếu số phiếu mua hàng.`; body email = caller; `sendBackInputError` | not found; `applySendBack` | `Đã trả lại thành công.` `{prNo, status}` |
| resubmit | login; `Thiếu số phiếu mua hàng.`; body requesterEmail = caller; GAS submit checks 1–8 + company + picks | not found; status ≠ returned `Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".`; `Bạn không phải người đề nghị ban đầu của phiếu này.` | `Đã gửi lại đề nghị thành công.` `{prNo}` |

Resubmit ignores `submittedAt`, because `pr_no` is unique. This fixes B1, so no page change is needed.

On resubmit:
- Attachments are the existing ones plus the newly uploaded ones. The page cannot resend or remove the existing files.
- The metadata is rebuilt from the form. It keeps the original `submittedAt` and `sentBackHistory`, plus `resubmittedAt` and `resubmitCount`.

Emails after commit:

| Event | Email |
|---|---|
| Approve opens the purchasing stage, on either branch (B2) | `purchasingRequest` |
| Approve completes the PR | `completed` |
| Reject | `rejectedNotice` (B13) |
| Send back | `sendBackNotices` |
| Resubmit | `resubmitNotices` |

Audit:
- Approve writes one `Approve` row per slot it covered (budget and supplier rows when it is the same person), as the live data shows. `extra` is `{signatureUploaded:true, verification:<string>}` when a signature was sent.
- The other actions write `Reject`, `Return` (extra `{targetStep}`) or `Resubmit` (note `Gửi lại lần N`).

- [ ] **Step 1: Write the failing test**

```js
// tests/purchase-requests/decide.test.js — approve / reject / send back / resubmit on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody, SIG_OK } from './helpers.js';

let s, d, pool, company, people;
const REQ = as('req@pr-test.vn');
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  d = await import('../../api/handlers/pr/decide.js');
});
after(() => teardown(pool));

const pr = async (no) => (await pool.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [no])).rows[0];
const mailsTo = async (no, subjectPart) => (await pool.query(
  `SELECT to_email FROM email_queue WHERE subject LIKE $1 ORDER BY id`, [`%${subjectPart}%${no}`])).rows.map((r) => r.to_email);
const submit = async (over = {}) => (await call(s.handlePRSubmit, submitBody(company, people, over), REQ)).prNo;
const approve = (no, who, role, extra = {}) => call(d.handlePRApprove, { prNo: no, approverRole: role, note: '', approverSignature: 'data:sig', signatureVerification: SIG_OK, ...extra }, as(who));

test('approve: the shared budget/supplier approver approves once; purchasing emailed on a simplified PR (B2)', { skip }, async () => {
  const no = await submit();
  const r = await approve(no, people.treasurer, 'budget');
  assert.equal(r.success, true, r.message);
  assert.equal(r.message, 'Đã duyệt thành công.');
  assert.equal(r.status, 'Mua hàng (5/5)');
  assert.equal(r.data.status, 'Mua hàng (5/5)', 'page reads result.data.status (B8)');
  const row = await pr(no);
  assert.equal(row.metadata.supplierStatus, 'Approved');
  assert.deepEqual(row.metadata.budgetSignatureVerification, JSON.parse(SIG_OK));
  assert.deepEqual(row.pending_emails, [people.ap]);
  const audit = (await pool.query(`SELECT role, extra FROM pr_audit_log WHERE doc_no = $1 AND action = 'Approve' ORDER BY id`, [no])).rows;
  assert.deepEqual(audit.map((a) => a.role), ['budget', 'supplier']);
  assert.equal(audit[0].extra.signatureUploaded, true);
  assert.deepEqual(await mailsTo(no, 'Yêu cầu Mua hàng'), [people.ap]);
});

test('approve: purchasing completes; requester told; nobody pending', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'supplier');
  const r = await approve(no, people.ap, 'purchasing');
  assert.equal(r.status, 'Hoàn thành');
  assert.deepEqual((await pr(no)).pending_emails, []);
  assert.deepEqual(await mailsTo(no, 'Phiếu đã hoàn thành'), ['req@pr-test.vn']);
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Đề nghị này đã được duyệt rồi.');
});

test('approve: turn, assignment, role and identity checks', { skip }, async () => {
  const no = await submit();
  assert.equal((await approve(no, people.ap, 'purchasing')).message, 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
  assert.equal((await approve(no, 'stranger@x.vn', 'budget')).message, 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
  assert.equal((await approve(no, people.treasurer, 'boss')).message, 'Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".');
  assert.equal((await approve(no, people.treasurer, 'budget', { approverEmail: people.ap })).message,
    `Bạn đang đăng nhập bằng ${people.treasurer}, không thể thao tác thay ${people.ap}.`);
  assert.equal((await approve('EV-PR19990101000001', people.treasurer, 'budget')).message, 'Không tìm thấy đề nghị: EV-PR19990101000001');
  assert.equal((await call(d.handlePRApprove, { prNo: no, approverRole: 'budget' }, null)).code, 401);
});

test('reject: requester emailed (B13); a second reject and an approve are refused', { skip }, async () => {
  const no = await submit();
  const r = await call(d.handlePRReject, { prNo: no, note: 'Giá cao' }, as(people.treasurer));
  assert.deepEqual([r.success, r.message, r.status], [true, 'Đã từ chối thành công.', 'Đã từ chối']);
  const row = await pr(no);
  assert.equal(row.metadata.rejectionNote, 'Giá cao');
  assert.deepEqual(row.pending_emails, []);
  assert.deepEqual(await mailsTo(no, 'Phiếu bị từ chối'), ['req@pr-test.vn']);
  assert.equal((await call(d.handlePRReject, { prNo: no }, as(people.treasurer))).message, 'Đề nghị này đã bị từ chối rồi.');
  assert.equal((await approve(no, people.treasurer, 'budget')).message, 'Đề nghị này đã bị từ chối, không thể duyệt.');
});

test('reject: someone not on the PR has no right', { skip }, async () => {
  const no = await submit();
  assert.equal((await call(d.handlePRReject, { prNo: no }, as('stranger@x.vn'))).message, 'Bạn không có quyền từ chối đề nghị này.');
});

test('send back step 1 → returned to the requester, who is emailed; approvals blocked', { skip }, async () => {
  const no = await submit();
  const r = await call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Thiếu báo giá' }, as(people.treasurer));
  assert.deepEqual([r.success, r.status], [true, 'Trả lại bổ sung']);
  assert.deepEqual((await pr(no)).pending_emails, ['req@pr-test.vn']);
  assert.deepEqual(await mailsTo(no, 'Phiếu được trả lại để bổ sung'), ['req@pr-test.vn']);
  assert.equal((await approve(no, people.treasurer, 'budget')).message, 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.');
});

test('send back step 2 by purchasing resets the chain; step 3 refused (B3); note required', { skip }, async () => {
  const no = await submit();
  await approve(no, people.treasurer, 'budget');
  const bad = await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 3, sentBackNote: 'x' }, as(people.ap));
  assert.equal(bad.message, 'Bước trả lại không hợp lệ với vai trò của bạn.');
  assert.equal((await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 2, sentBackNote: '' }, as(people.ap))).message, 'Vui lòng nhập lý do trả lại.');
  const r = await call(d.handlePRSendBack, { prNo: no, approverRole: 'purchasing', targetStep: 2, sentBackNote: 'Sai NCC' }, as(people.ap));
  assert.equal(r.status, 'Đang duyệt ngân sách & NCC (2/5)');
  const row = await pr(no);
  assert.equal(row.metadata.budgetStatus, 'Pending');
  assert.deepEqual(row.pending_emails, [people.treasurer]);
  assert.deepEqual(await mailsTo(no, 'Bước Ngân sách & NCC'), [people.treasurer]);
  const ret = (await pool.query(`SELECT role, extra FROM pr_audit_log WHERE doc_no = $1 AND action = 'Return'`, [no])).rows;
  assert.deepEqual(ret.map((x) => [x.role, x.extra.targetStep]), [['purchasing', 2]]);
});

test('resubmit works from the page even with a new client submittedAt (B1); history kept; approvals cleared', { skip }, async () => {
  const no = await submit();
  await call(d.handlePRSendBack, { prNo: no, approverRole: 'budget', targetStep: 1, sentBackNote: 'Thêm báo giá' }, as(people.treasurer));
  const body = submitBody(company, people, { prNo: no, purpose: 'Mua khăn giấy (đã bổ sung)', submittedAt: new Date().toISOString(),
    attachments: [{ fileName: 'bao-gia.pdf', fileData: Buffer.from('%PDF').toString('base64'), mimeType: 'application/pdf' }] });
  const other = await call(s.handlePRResubmit, body, as('other@pr-test.vn'));
  assert.equal(other.message, 'Bạn không phải người đề nghị ban đầu của phiếu này.');
  const sent = [];
  const r = await call(s.handlePRResubmit, body, REQ, { s3: { send: async (c) => { sent.push(c.input.Key); } } });
  assert.deepEqual([r.success, r.message, r.prNo], [true, 'Đã gửi lại đề nghị thành công.', no]);
  const row = await pr(no);
  assert.equal(row.status, 'Đang duyệt ngân sách & NCC (2/5)');
  assert.equal(row.purpose, 'Mua khăn giấy (đã bổ sung)');
  assert.equal(row.metadata.resubmitCount, 1);
  assert.equal(row.metadata.sentBackHistory.length, 1);
  assert.equal(row.metadata.budgetStatus, 'Pending');
  assert.equal(row.attachments.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(await mailsTo(no, 'Phiếu đã được cập nhật và gửi lại'), [people.treasurer]);
  const audit = (await pool.query(`SELECT note FROM pr_audit_log WHERE doc_no = $1 AND action = 'Resubmit'`, [no])).rows;
  assert.deepEqual(audit.map((a) => a.note), ['Gửi lại lần 1']);
  assert.equal((await call(s.handlePRResubmit, body, REQ)).message, 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/purchase-requests/decide.test.js`. Expected: FAIL (`…/handlers/pr/decide.js` not found).

- [ ] **Step 3: Implement decide.js**

```js
// api/handlers/pr/decide.js — approve / reject / send back a purchase request on Postgres.
// Rules: api/lib/purchase-requests/state.js. Who acts: the login token (never the body's email).
import { STATUS, isRole, BAD_ROLE, applyApprove, applyReject, sendBackInputError, applySendBack, pendingEmails } from '../../lib/purchase-requests/state.js';
import { updatePR, recordChange } from '../../lib/purchase-requests/repo.js';
import { purchasingRequest, completed, rejectedNotice, sendBackNotices } from '../../lib/purchase-requests/emails.js';
import { fail, signedInCaller, claimProblem } from '../../lib/purchase-requests/respond.js';
import { prDeps, withLockedPR } from './tx.js';

/** Login, PR number, body email = caller. Returns { caller, prNo } or null after answering. */
async function start(req, res, who, claimedKey = 'approverEmail') {
  const caller = await signedInCaller(req, res, who);
  if (!caller) return null;
  const b = req.body || {};
  const prNo = String(b.prNo || '').trim();
  if (!prNo) { fail(res, 'Thiếu số phiếu mua hàng.'); return null; }
  const claim = claimProblem(caller, b[claimedKey]);
  if (claim) { fail(res, claim); return null; }
  return { caller, prNo, b };
}

const verificationText = (v) => (v == null || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v));

export async function handlePRApprove(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  if (!isRole(b.approverRole)) return fail(res, BAD_ROLE);
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applyApprove(row, row.metadata || {}, { email: caller.email, role: b.approverRole, note: b.note || '',
      signature: b.approverSignature || '', verification: b.signatureVerification, at });
    if (r.error) return r;
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: r.status, pending_emails: pendingEmails(row, r.meta, r.status) });
    const extra = b.approverSignature ? { signatureUploaded: true, verification: verificationText(b.signatureVerification) } : {};
    await recordChange(client, saved, r.roles.map((role) => ({ action: 'Approve', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note: b.note || '', extra, at })));
    const mails = [];
    if (r.after.stage === 'purchasing' && r.before.stage !== 'purchasing') mails.push(purchasingRequest(saved)); // both branches (B2)
    if (r.after.stage === 'complete') mails.push(completed(saved));
    return { saved, mails, message: 'Đã duyệt thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
}

export async function handlePRReject(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applyReject(row, row.metadata || {}, { email: caller.email, note: String(b.note || '').trim(), at });
    if (r.error) return r;
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: STATUS.REJECTED, pending_emails: [] });
    await recordChange(client, saved, { action: 'Reject', role: r.role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: STATUS.REJECTED, note: r.meta.rejectionNote, at });
    return { saved, mails: [rejectedNotice(saved, { by: caller.name || caller.email, note: r.meta.rejectionNote })],
      message: 'Đã từ chối thành công.', fields: { prNo: saved.pr_no, status: STATUS.REJECTED } };
  });
}

export async function handlePRSendBack(req, res, d) {
  const { db, who, now } = prDeps(d);
  const s = await start(req, res, who);
  if (!s) return;
  const { caller, prNo, b } = s;
  const inputError = sendBackInputError(b);
  if (inputError) return fail(res, inputError);
  const role = String(b.approverRole).trim().toLowerCase();
  const targetStep = Number(b.targetStep);
  const note = String(b.sentBackNote).trim();
  return withLockedPR(db, prNo, res, async (client, row) => {
    const at = now().toISOString();
    const r = applySendBack(row, row.metadata || {}, { email: caller.email, role, targetStep, note, at });
    if (r.error) return r;
    const saved = await updatePR(client, row.id, { metadata: r.meta, status: r.status, pending_emails: pendingEmails(row, r.meta, r.status) });
    await recordChange(client, saved, { action: 'Return', role, actorEmail: caller.email, actorName: caller.name,
      prevStatus: row.status, newStatus: r.status, note, extra: { targetStep }, at });
    return { saved, mails: sendBackNotices(saved, { targetStep, byRole: role, note }),
      message: 'Đã trả lại thành công.', fields: { prNo: saved.pr_no, status: saved.status } };
  });
}
```

- [ ] **Step 4: Add handlePRResubmit to submit.js**

Add these imports to `api/handlers/pr/submit.js`: `isReturned` from state.js, `getPR` and `updatePR` from repo.js, `resubmitNotices` from emails.js, and `withLockedPR` from `./tx.js`. Then append:

```js
/** resubmitPurchaseRequest (spec §3.8). submittedAt from the page is ignored: pr_no is unique (B1). */
export async function handlePRResubmit(req, res, d) {
  const { db, s3, who, now } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = req.body || {};
  const prNo = str(b.prNo);
  if (!prNo) return fail(res, 'Thiếu số phiếu mua hàng.');
  const claim = claimProblem(caller, b.requesterEmail);
  if (claim) return fail(res, claim);
  try {
    const prep = await prepareSubmission(db, b);
    if (prep.error) return fail(res, prep.error);
    if (!(await getPR(db, prNo))) return fail(res, `Không tìm thấy đề nghị: ${prNo}`);
    const uploaded = await storeAttachments(s3, parseAttachmentList(b.attachments)); // S3 never runs under the row lock
    return await withLockedPR(db, prNo, res, async (client, row) => {
      if (!isReturned(row.status)) return { error: 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".' };
      const owner = str(row.requester_email || (row.metadata || {}).requesterEmail).toLowerCase();
      if (owner && owner !== caller.email) return { error: 'Bạn không phải người đề nghị ban đầu của phiếu này.' };
      const old = row.metadata || {};
      const at = now().toISOString();
      // The page cannot resend or remove the files already on the PR: keep them, add the new ones.
      const attachments = [...(row.attachments || []), ...uploaded];
      const count = (Number(old.resubmitCount) || 0) + 1;
      const metadata = {
        ...buildMetadata(b, { companyKey: str(b.companyKey) || prep.company.company_key, requesterEmail: caller.email,
          submittedAt: old.submittedAt || new Date(row.submitted_at).toISOString(), attachments,
          purchaseType: prep.sub.purchaseType, branch: prep.sub.branch, picks: prep.sub.picks }),
        sentBackHistory: Array.isArray(old.sentBackHistory) ? old.sentBackHistory : [],
        resubmittedAt: at, resubmitCount: count,
      };
      const saved = await updatePR(client, row.id, submissionColumns(b, { ...prep, caller, metadata, attachments }));
      await recordChange(client, saved, { action: 'Resubmit', role: 'requester', actorEmail: caller.email, actorName: saved.requester_name,
        prevStatus: row.status, newStatus: STATUS.PARALLEL, note: `Gửi lại lần ${count}`,
        extra: { purchaseType: saved.purchase_type, p2pBranch: saved.p2p_branch }, at });
      return { saved, mails: resubmitNotices(saved), message: 'Đã gửi lại đề nghị thành công.', fields: { prNo: saved.pr_no } };
    });
  } catch (err) {
    console.error('[PR] resubmit:', err.message);
    return fail(res, 'Lỗi khi lưu đề nghị mua hàng: ' + err.message);
  }
}
```

- [ ] **Step 5: Route the actions**

In `api/router.js`:
- Import: `import { handlePRSubmit, handlePRResubmit } from './handlers/pr/submit.js';` and `import { handlePRApprove, handlePRReject, handlePRSendBack } from './handlers/pr/decide.js';`.
- Narrow the old import to `import { handlePRHistory, handlePRDetail } from './handlers/purchase-request.js';`.
- In `NEW_HANDLERS`, add `resubmitPurchaseRequest: handlePRResubmit` and `sendBackPurchaseRequest: handlePRSendBack`.
- Set `WORKFLOW_ACTIONS.p2p` to:

```js
  p2p: ['purchaseRequest', 'resubmitPurchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'sendBackPurchaseRequest',
    'getPurchaseRequestHistory', 'getPurchaseRequest'],
```

- [ ] **Step 6: Run the tests**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test --test-concurrency=1 tests/purchase-requests/`. Expected: PASS (decide: 8 tests). Then run the full suite. Expected: 188 pass.

- [ ] **Step 7: Commit**

```bash
git add api/handlers/pr/decide.js api/handlers/pr/submit.js api/router.js tests/purchase-requests/decide.test.js
git commit -m "feat(pr): approve/reject/send back/resubmit on Postgres (one approval per person, B1/B2/B3/B13 fixed)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reads, catalogs, addSupplier, validatePRForDirectPayment

**Files:**
- Create: `api/lib/purchase-requests/views.js`, `api/handlers/pr/reads.js`
- Modify: `api/router.js`
- Delete: `api/handlers/purchase-request.js`, `api/lib/pr-approval-state.js`
- Test: `tests/purchase-requests/views.test.js`, `tests/purchase-requests/reads.test.js`, `tests/server/router-p2p.test.js`

**Interfaces:**
- Consumes:
  - From Task 1: `getPR`, `auditFor`, `visibility`, `canView`.
  - From Task 2: `approvalState`, `isComplete`, `isRejected`, `TERMINAL_STATUSES`, `directPaymentProblem`.
  - From Task 5: `prDeps`, `ok`, `fail`, `signedInCaller`, `NO_ACCESS_MSG`.
  - `MASTER_TABLES` and `coreCellValue` from `api/lib/master-registry.js`.
- Produces:
  - views.js:
    - `cardFromRow(row)` returns exactly these keys: `prNo, company, department, requesterName, requesterEmail, requestorEmail, requiredDate, priority, purpose, suggestedVendor, grandTotal, status, submittedAt, budgetApprover, supplierApprover, contractApprover, purchasingApprover, budgetApproverEmail, supplierApproverEmail, contractApproverEmail, purchasingApproverEmail, budgetStatus, supplierStatus, contractStatus, purchasingStatus, activeStage, purchaseType, p2pBranch, hasAttachments, items`.
    - `fullFromRow(row)`: the card plus `metadata` (a JSON string), `attachmentUrls`, `budgetCode`.
    - `historyEntry(auditRow)`
    - `goodsRecord(headers, row, core)`
    - `supplierExtra(body, knownHeaders:Set)`
    - `likePattern(q)`
  - reads.js: `handlePRHistory`, `handlePRDetail`, `handlePRSearch`, `handleP2PHistory`, `handleGoodsCatalog`, `handlePurchaseOrderTypes`, `handleAddSupplier`, `handleValidatePRForDirectPayment`. All have the signature `(req, res, d?)`.
  - For Plan 7: `getPR(db, prNo)` ignores `archived_at`, so acceptance minutes and contracts find archived PRs (B6). For Plan 6: `prDeps().paymentsForPR`.

Contract per action (fields are top level and in `data`):

| Action | Login | Rule | Success |
|---|---|---|---|
| `getPurchaseRequestHistory {requesterName?}` | yes | visible PRs; not `archived_at`; terminal PRs idle more than 90 days are left out (GAS archive window); optional exact case-insensitive `requesterName`; newest first | `Thành công` `{requests:[card]}` |
| `getPurchaseRequest {prNo, submittedAt?}` | yes | `Thiếu số phiếu mua hàng.`; `Không tìm thấy đề nghị: <no>`; not visible → 403. `submittedAt` is ignored | `Thành công` `{request: full}` |
| `searchPurchaseRequests {q\|query}` | yes | under 2 chars → `requests: []`; ILIKE on pr_no, company_name, requester_name, purpose; archived included; visible only; at most 30, newest first | `Thành công` `{requests:[card]}` |
| `getP2PHistory {docNo, flow}` | PR flow only | flow ≠ `PR` → GAS proxy (contract, AM and payment flows stay on GAS until Plans 6–7); empty docNo → `Invalid docNo or flow.`; PR not visible → 403; no PR row → admins get the audit rows, others `[]` | `OK` `{history:[entry]}` |
| `getGoodsCatalog` | no | goods_catalog rows keyed by the Goods-KTT headers (master_columns order); every status, as in GAS; rows with an empty first column dropped | `Goods catalog fetched successfully` `{goods}` |
| `getPurchaseOrderTypes` | no | `purchase_order_types` rows with a type | `Thành công` `{types:[{no,type}]}` |
| `addSupplier {name,address,phone,email,taxCode,companyType}` | yes | `Supplier name is required`; duplicate Vendor_Full_Name (trimmed, case-insensitive) → `Supplier "<name>" already exists`; writes **Master Vendor** (`master_vendors`), the sheet the picker reads (B14) | `Supplier added successfully` `{supplierId:'VD'+id(3), name}` |
| `validatePRForDirectPayment {prNo}` | yes | `Thiếu số PR.`; `Không tìm thấy PR: <no>`; `directPaymentProblem`; an open payment from `paymentsForPR` → `Đã tồn tại đề nghị thanh toán cho PR này.` | `OK` `{prNo, vendorName, department, grandTotal, requesterName, purchaseType, p2pBranch}` (vendorName from `vendor_name`, B9) |

- [ ] **Step 1: Write the failing pure test**

```js
// tests/purchase-requests/views.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFromRow, fullFromRow, historyEntry, goodsRecord, supplierExtra, likePattern } from '../../api/lib/purchase-requests/views.js';
import { MASTER_TABLES } from '../../api/lib/master-registry.js';

const row = {
  pr_no: 'EV-PR20261007000001', company_name: 'CT', department: 'Bán Hàng', requester_name: 'Thư', requester_email: 'req@x.vn',
  required_date: '2026-10-20', priority: 'Gấp', purpose: 'Mua', vendor_name: 'NCC A', grand_total: '149500', status: 'Hoàn thành',
  submitted_at: new Date('2026-10-07T01:00:00Z'), budget_approver_email: 'linh@x.vn', supplier_approver_email: 'linh@x.vn',
  contract_approver_email: '', purchasing_approver_email: 'ap@x.vn', p2p_branch: 'simplified', purchase_type: 'goods',
  items: [{ desc: 'Khăn', qty: '5' }], attachments: [{ fileName: 'a.pdf', fileUrl: 'https://r2/a.pdf' }, { fileName: 'b', fileUrl: '' }],
  metadata: { budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Approved', contractStatus: 'N/A' }, budget_code: '',
};
const KEYS = ['prNo', 'company', 'department', 'requesterName', 'requesterEmail', 'requestorEmail', 'requiredDate', 'priority', 'purpose',
  'suggestedVendor', 'grandTotal', 'status', 'submittedAt', 'budgetApprover', 'supplierApprover', 'contractApprover', 'purchasingApprover',
  'budgetApproverEmail', 'supplierApproverEmail', 'contractApproverEmail', 'purchasingApproverEmail', 'budgetStatus', 'supplierStatus',
  'contractStatus', 'purchasingStatus', 'activeStage', 'purchaseType', 'p2pBranch', 'hasAttachments', 'items'];

test('cardFromRow: GAS card keys + items string (B7); terminal rows keep statuses and branch (B5)', () => {
  const c = cardFromRow(row);
  assert.deepEqual(Object.keys(c), KEYS);
  assert.equal(c.submittedAt, '2026-10-07T01:00:00.000Z');
  assert.equal(c.grandTotal, 149500);
  assert.equal(c.activeStage, 'complete');
  assert.equal(c.p2pBranch, 'simplified');
  assert.equal(c.budgetStatus, 'Approved');
  assert.equal(c.requesterEmail, 'req@x.vn');
  assert.equal(c.items, '[{"desc":"Khăn","qty":"5"}]');
  assert.equal(c.hasAttachments, true);
  assert.equal(cardFromRow({ ...row, status: 'Trả lại bổ sung', metadata: { budgetStatus: 'Pending', supplierStatus: 'Pending' } }).activeStage, 'parallel');
  assert.equal(cardFromRow({ ...row, status: 'Rejected' }).activeStage, 'rejected');
});
test('fullFromRow: metadata as a string, attachmentUrls, budgetCode', () => {
  const f = fullFromRow(row);
  assert.equal(typeof f.metadata, 'string');
  assert.equal(JSON.parse(f.metadata).budgetStatus, 'Approved');
  assert.equal(f.attachmentUrls, 'https://r2/a.pdf');
  assert.equal(f.budgetCode, '');
});
test('historyEntry: drawer shape', () => {
  const e = historyEntry({ action: 'Return', role: 'purchasing', actor_email: 'ap@x.vn', actor_name: 'AP', prev_status: 'a', new_status: 'b',
    created_at: new Date('2026-10-07T02:00:00Z'), note: 'x', extra: { targetStep: 2 } });
  assert.deepEqual(e, { action: 'Return', role: 'purchasing', actorEmail: 'ap@x.vn', actorName: 'AP', prevStatus: 'a', newStatus: 'b',
    timestamp: '2026-10-07T02:00:00.000Z', note: 'x', metaJson: '{"targetStep":2}' });
  assert.equal(historyEntry({ action: 'Submit', created_at: new Date(), extra: {} }).metaJson, '');
});
test('goodsRecord / supplierExtra / likePattern', () => {
  const core = MASTER_TABLES.goods.core;
  const g = goodsRecord(['Category', 'Items', 'Unit Price', 'Status', 'Extra'], { category: 'Giấy', name: 'Khăn', unit_price: 29900, status: 'active', extra: { Status: 'Active', Extra: 'x' } }, core);
  assert.deepEqual(g, { Category: 'Giấy', Items: 'Khăn', 'Unit Price': '29900', Status: 'Active', Extra: 'x' });
  const known = new Set(['Vendor_Full_Name', 'Vendor Type', 'Tax ID', 'Address', 'Active']);
  assert.deepEqual(supplierExtra({ name: ' NCC B ', taxCode: '0312', address: 'HCM', phone: '09' }, known),
    { Vendor_Full_Name: 'NCC B', 'Vendor Type': 'Others', 'Tax ID': '0312', Address: 'HCM', Active: 'Yes' });
  assert.equal(likePattern('50%_a\\'), '%50\\%\\_a\\\\%');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run `node --test tests/purchase-requests/views.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement views.js**

```js
// api/lib/purchase-requests/views.js — Postgres rows → the shapes the PR pages read (pure).
import { approvalState, isComplete, isRejected } from './state.js';
import { coreCellValue } from '../master-registry.js';

const iso = (t) => (t ? new Date(t).toISOString() : '');
const lower = (s) => String(s || '').trim().toLowerCase();

/** GAS prListCardFromRow_ keys + `items` (JSON string; acceptance_minutes.html parses it, B7). Metadata read for every row (B5). */
export function cardFromRow(row) {
  const meta = row.metadata || {};
  const status = row.status || '';
  const requesterEmail = lower(row.requester_email || meta.requesterEmail);
  const e = (k) => lower(row[k]);
  return {
    prNo: row.pr_no, company: row.company_name || '', department: row.department || '', requesterName: row.requester_name || '',
    requesterEmail, requestorEmail: requesterEmail, requiredDate: row.required_date || '', priority: row.priority || '',
    purpose: row.purpose || '', suggestedVendor: row.vendor_name || '', grandTotal: Number(row.grand_total) || 0, status,
    submittedAt: iso(row.submitted_at),
    budgetApprover: e('budget_approver_email'), supplierApprover: e('supplier_approver_email'),
    contractApprover: e('contract_approver_email'), purchasingApprover: e('purchasing_approver_email'),
    budgetApproverEmail: e('budget_approver_email'), supplierApproverEmail: e('supplier_approver_email'),
    contractApproverEmail: e('contract_approver_email'), purchasingApproverEmail: e('purchasing_approver_email'),
    budgetStatus: meta.budgetStatus || '', supplierStatus: meta.supplierStatus || '',
    contractStatus: meta.contractStatus || '', purchasingStatus: meta.purchasingStatus || '',
    activeStage: isComplete(status) ? 'complete' : isRejected(status) ? 'rejected' : approvalState(row, meta).stage,
    purchaseType: row.purchase_type || meta.purchaseType || 'goods', p2pBranch: row.p2p_branch || meta.p2pBranch || 'full',
    hasAttachments: (row.attachments || []).some((a) => a && a.fileUrl),
    items: JSON.stringify(row.items || []),
  };
}

/** GAS prFullFromRow_: items and metadata are strings (purchase_request.html JSON.parses them). */
export function fullFromRow(row) {
  return {
    ...cardFromRow(row),
    metadata: JSON.stringify(row.metadata || {}),
    attachmentUrls: (row.attachments || []).filter((a) => a && a.fileUrl).map((a) => a.fileUrl).join(', '),
    budgetCode: row.budget_code || '',
  };
}

export function historyEntry(a) {
  const extra = a.extra && Object.keys(a.extra).length ? JSON.stringify(a.extra) : '';
  return { action: a.action, role: a.role || '', actorEmail: a.actor_email || '', actorName: a.actor_name || '',
    prevStatus: a.prev_status || '', newStatus: a.new_status || '', timestamp: iso(a.created_at), note: a.note || '', metaJson: extra };
}

/** One Goods-KTT row keyed by its sheet headers, typed cells shown the way the sheet wrote them. */
export function goodsRecord(headers, row, core) {
  const extra = row.extra || {};
  return Object.fromEntries(headers.map((h) => [h, core[h] ? coreCellValue(core[h], extra[h], row[core[h].col]) : String(extra[h] ?? '')]));
}

/** GAS addSupplier values, keyed by the Master Vendor headers that exist (others are dropped). */
export function supplierExtra(b, known) {
  const s = (k) => String(b[k] ?? '').trim();
  const all = { Vendor_Full_Name: s('name'), 'Vendor Type': s('companyType') || 'Others', 'Tax ID': s('taxCode'), Address: s('address'),
    'Payment Currency': 'VND', Contact_phone: s('phone'), Email_lien_he: s('email'), Dia_chi_lien_he: s('address'), Active: 'Yes' };
  return Object.fromEntries(Object.entries(all).filter(([k]) => known.has(k)));
}

export const likePattern = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
```

- [ ] **Step 4: Run it**

Run `node --test tests/purchase-requests/views.test.js`. Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing handler test and router test**

```js
// tests/purchase-requests/reads.test.js — PR reads on Postgres
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown, call, as, submitBody, SIG_OK } from './helpers.js';

let s, dd, r, pool, company, people, mine, theirs;
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  s = await import('../../api/handlers/pr/submit.js');
  dd = await import('../../api/handlers/pr/decide.js');
  r = await import('../../api/handlers/pr/reads.js');
  mine = (await call(s.handlePRSubmit, submitBody(company, people, { purpose: 'Khăn giấy phòng họp' }), as('a@pr-test.vn'))).prNo;
  theirs = (await call(s.handlePRSubmit, submitBody(company, people, { purpose: 'Ly giấy' }), as('b@pr-test.vn'))).prNo;
});
after(async () => {
  if (pool) await pool.query(`DELETE FROM master_vendors WHERE extra->>'Vendor_Full_Name' LIKE 'NCC Plan5 %'; DELETE FROM purchase_order_types WHERE type LIKE 'Plan5 %'`);
  await teardown(pool);
});
const nos = (list) => list.map((x) => x.prNo).sort();

test('list: requester sees own, approver sees both, admin all, stranger none, no token 401', { skip }, async () => {
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as('a@pr-test.vn'))).requests), [mine]);
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as(people.treasurer))).requests), [mine, theirs].sort());
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as('x@x.vn', { isAdmin: true }))).requests), [mine, theirs].sort());
  const none = await call(r.handlePRHistory, {}, as('x@x.vn'));
  assert.deepEqual([none.success, none.message, none.requests, none.data.requests], [true, 'Thành công', [], []]);
  assert.equal((await call(r.handlePRHistory, {}, null)).code, 401);
});

test('list hides terminal PRs idle for 90 days and archived ones', { skip }, async () => {
  await pool.query(`UPDATE purchase_requests SET status = 'Hoàn thành', updated_at = NOW() - interval '91 days' WHERE pr_no = $1`, [theirs]);
  assert.deepEqual(nos((await call(r.handlePRHistory, {}, as(people.treasurer))).requests), [mine]);
  assert.deepEqual(nos((await call(r.handlePRSearch, { q: 'Ly giấy' }, as(people.treasurer))).requests), [theirs], 'search still finds it');
  await pool.query(`UPDATE purchase_requests SET status = 'Đang duyệt ngân sách & NCC (2/5)', updated_at = NOW() WHERE pr_no = $1`, [theirs]);
});

test('detail: GAS shape with strings; visibility enforced; not-found wording', { skip }, async () => {
  const d = await call(r.handlePRDetail, { prNo: mine, submittedAt: 'anything' }, as('a@pr-test.vn'));
  assert.equal(d.success, true);
  assert.equal(typeof d.request.items, 'string');
  assert.equal(typeof d.request.metadata, 'string');
  assert.equal(d.data.request.prNo, mine);
  const no = await call(r.handlePRDetail, { prNo: mine }, as('b@pr-test.vn'));
  assert.deepEqual([no.code, no.message], [403, 'Bạn không có quyền xem đề nghị này.']);
  assert.equal((await call(r.handlePRDetail, { prNo: 'X-1' }, as('a@pr-test.vn'))).message, 'Không tìm thấy đề nghị: X-1');
  assert.equal((await call(r.handlePRDetail, {}, as('a@pr-test.vn'))).message, 'Thiếu số phiếu mua hàng.');
});

test('search: 2+ chars, substring on number/company/requester/purpose, visible only', { skip }, async () => {
  assert.deepEqual((await call(r.handlePRSearch, { q: 'K' }, as('a@pr-test.vn'))).requests, []);
  assert.deepEqual(nos((await call(r.handlePRSearch, { query: 'phòng họp' }, as('a@pr-test.vn'))).requests), [mine]);
  assert.deepEqual((await call(r.handlePRSearch, { q: 'Ly giấy' }, as('a@pr-test.vn'))).requests, []);
});

test('getP2PHistory: PR flow from pr_audit_log, other flows go to GAS', { skip }, async () => {
  await call(dd.handlePRApprove, { prNo: mine, approverRole: 'budget', approverSignature: 'data:s', signatureVerification: SIG_OK }, as(people.treasurer));
  const h = await call(r.handleP2PHistory, { docNo: mine, flow: 'PR' }, as('a@pr-test.vn'));
  assert.equal(h.message, 'OK');
  assert.deepEqual(h.history.map((x) => `${x.action}/${x.role}`), ['Submit/requester', 'Approve/budget', 'Approve/supplier']);
  assert.equal((await call(r.handleP2PHistory, { docNo: mine, flow: 'PR' }, as('b@pr-test.vn'))).code, 403);
  let proxied = null;
  const gasProxy = (req, res) => { proxied = req.body; res.json({ success: true, history: ['gas'] }); };
  const am = await call(r.handleP2PHistory, { docNo: 'AM-1', flow: 'AM' }, null, { gasProxy });
  assert.deepEqual(am.history, ['gas']);
  assert.deepEqual(JSON.parse(proxied.data), { docNo: 'AM-1', flow: 'AM', action: 'getP2PHistory' });
});

test('getGoodsCatalog: Goods-KTT headers, no login', { skip }, async () => {
  const g = await call(r.handleGoodsCatalog, {}, null);
  assert.equal(g.message, 'Goods catalog fetched successfully');
  assert.ok(g.goods.length > 0);
  assert.deepEqual(Object.keys(g.goods[0]), ['Category', 'Items', 'Unit', 'Min. Order', 'Specificaton', 'Unit Price', 'CUKCUK/QBO Code', 'Status']);
});

test('getPurchaseOrderTypes', { skip }, async () => {
  await pool.query(`INSERT INTO purchase_order_types (no, type, sheet_row) VALUES ('1', 'Plan5 Hàng hóa', 2), ('2', '', 3)`);
  const t = await call(r.handlePurchaseOrderTypes, {}, null);
  assert.ok(t.types.some((x) => x.no === '1' && x.type === 'Plan5 Hàng hóa'));
  assert.ok(!t.types.some((x) => x.type === ''));
});

test('addSupplier: Master Vendor, duplicate refused, login needed', { skip }, async () => {
  const name = `NCC Plan5 ${Date.now()}`;
  const a = await call(r.handleAddSupplier, { name, taxCode: '0312', address: 'HCM' }, as('a@pr-test.vn'));
  assert.deepEqual([a.success, a.message, a.name], [true, 'Supplier added successfully', name]);
  assert.match(a.supplierId, /^VD\d{3,}$/);
  const row = (await pool.query(`SELECT extra FROM master_vendors WHERE extra->>'Vendor_Full_Name' = $1`, [name])).rows[0];
  assert.equal(row.extra['Tax ID'], '0312');
  assert.equal((await call(r.handleAddSupplier, { name: name.toUpperCase() }, as('a@pr-test.vn'))).message, `Supplier "${name.toUpperCase()}" already exists`);
  assert.equal((await call(r.handleAddSupplier, { name: '' }, as('a@pr-test.vn'))).message, 'Supplier name is required');
  assert.equal((await call(r.handleAddSupplier, { name }, null)).code, 401);
});

test('validatePRForDirectPayment: GAS messages; vendorName from the PR (B9); open payment refused', { skip }, async () => {
  const v = (body, extra) => call(r.handleValidatePRForDirectPayment, body, as('a@pr-test.vn'), extra);
  assert.equal((await v({})).message, 'Thiếu số PR.');
  assert.equal((await v({ prNo: 'X-1' })).message, 'Không tìm thấy PR: X-1');
  assert.equal((await v({ prNo: mine })).message, 'PR chưa được phê duyệt hoàn tất.');
  await pool.query(`UPDATE purchase_requests SET status = 'Hoàn thành', vendor_name = 'NCC A' WHERE pr_no = $1`, [mine]);
  const okr = await v({ prNo: mine });
  assert.deepEqual([okr.success, okr.vendorName, okr.p2pBranch, okr.data.prNo], [true, 'NCC A', 'simplified', mine]);
  const busy = await v({ prNo: mine }, { paymentsForPR: async () => [{ status: 'Đang duyệt' }] });
  assert.equal(busy.message, 'Đã tồn tại đề nghị thanh toán cho PR này.');
  assert.equal((await v({ prNo: mine }, { paymentsForPR: async () => [{ status: 'Rejected' }] })).success, true);
});
```

```js
// tests/server/router-p2p.test.js — with p2p on, every PR action is served by Postgres; payments stays on GAS.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PG_WORKFLOWS = 'p2p';
const { migratedActions } = await import('../../api/router.js');
after(async () => { (await import('../../db/redis.js')).default.quit(); await (await import('../../db/pool.js')).default.end(); });

test('p2p actions are all migrated; validatePRForDirectPayment waits for payments', () => {
  for (const a of ['purchaseRequest', 'resubmitPurchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'sendBackPurchaseRequest',
    'getPurchaseRequestHistory', 'getPurchaseRequest', 'searchPurchaseRequests', 'getP2PHistory', 'getGoodsCatalog',
    'getPurchaseOrderTypes', 'addSupplier']) assert.ok(migratedActions.includes(a), a);
  assert.equal(migratedActions.includes('validatePRForDirectPayment'), false);
  assert.equal(migratedActions.includes('getPaymentProgressByPR'), false, 'payment-side, Plan 6');
});
```

- [ ] **Step 6: Run them and confirm they fail**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test --test-concurrency=1 tests/purchase-requests/reads.test.js tests/server/router-p2p.test.js`. Expected: FAIL (`reads.js` not found, then missing actions).

- [ ] **Step 7: Implement reads.js**

```js
// api/handlers/pr/reads.js — PR reads and the small P2P actions on Postgres (spec §3.2–3.4, 3.9–3.13).
import { getPR, auditFor, visibility, canView } from '../../lib/purchase-requests/repo.js';
import { TERMINAL_STATUSES, directPaymentProblem } from '../../lib/purchase-requests/state.js';
import { cardFromRow, fullFromRow, historyEntry, goodsRecord, supplierExtra, likePattern } from '../../lib/purchase-requests/views.js';
import { ok, fail, signedInCaller, NO_ACCESS_MSG } from '../../lib/purchase-requests/respond.js';
import { MASTER_TABLES } from '../../lib/master-registry.js';
import { prDeps } from './tx.js';

const src = (req) => ({ ...(req.query || {}), ...(req.body || {}) });
const str = (v) => String(v ?? '').trim();

export async function handlePRHistory(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const v = visibility(caller, 1);
  const { rows } = await db.query(
    `SELECT * FROM purchase_requests
     WHERE ${v.sql} AND archived_at IS NULL
       AND NOT (status = ANY($3) AND updated_at < NOW() - interval '90 days')
       AND ($4 = '' OR LOWER(requester_name) = LOWER($4))
     ORDER BY submitted_at DESC NULLS LAST, id DESC`, [...v.params, TERMINAL_STATUSES, str(src(req).requesterName)]);
  return ok(res, 'Thành công', { requests: rows.map(cardFromRow) });
}

export async function handlePRDetail(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const prNo = str(src(req).prNo);
  if (!prNo) return fail(res, 'Thiếu số phiếu mua hàng.');
  const row = await getPR(db, prNo); // archived rows included
  if (!row) return fail(res, `Không tìm thấy đề nghị: ${prNo}`);
  if (!canView(caller, row)) return fail(res, NO_ACCESS_MSG, 403);
  return ok(res, 'Thành công', { request: fullFromRow(row) });
}

export async function handlePRSearch(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const q = str(src(req).q || src(req).query);
  if (q.length < 2) return ok(res, 'Thành công', { requests: [] });
  const v = visibility(caller, 2);
  const { rows } = await db.query(
    `SELECT * FROM purchase_requests
     WHERE (pr_no ILIKE $1 OR company_name ILIKE $1 OR requester_name ILIKE $1 OR purpose ILIKE $1) AND ${v.sql}
     ORDER BY submitted_at DESC NULLS LAST, id DESC LIMIT 30`, [likePattern(q), ...v.params]);
  return ok(res, 'Thành công', { requests: rows.map(cardFromRow) });
}

export async function handleP2PHistory(req, res, d) {
  const { db, who, gasProxy } = prDeps(d);
  const b = src(req);
  if (str(b.flow) !== 'PR') {
    // Payment / AM / contract history stays on GAS until Plans 6–7
    req.body = { action: 'getP2PHistory', data: JSON.stringify({ ...(req.body || {}), action: 'getP2PHistory' }) };
    return gasProxy(req, res);
  }
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const docNo = str(b.docNo);
  if (!docNo) return fail(res, 'Invalid docNo or flow.');
  const row = await getPR(db, docNo);
  if (row && !canView(caller, row)) return fail(res, NO_ACCESS_MSG, 403);
  if (!row && !caller.isAdmin) return ok(res, 'OK', { history: [] }); // audit-only numbers (deleted PRs): admins only
  return ok(res, 'OK', { history: (await auditFor(db, docNo)).map(historyEntry) });
}

export async function handleGoodsCatalog(req, res, d) {
  const { db } = prDeps(d);
  try {
    const [{ rows: cols }, { rows }] = await Promise.all([
      db.query(`SELECT name FROM master_columns WHERE table_key = 'goods' ORDER BY position, name`),
      db.query('SELECT * FROM goods_catalog ORDER BY sheet_row NULLS LAST, id'),
    ]);
    const headers = cols.map((c) => c.name);
    const goods = rows.map((r) => goodsRecord(headers, r, MASTER_TABLES.goods.core)).filter((g) => headers.length && str(g[headers[0]]));
    return ok(res, 'Goods catalog fetched successfully', { goods });
  } catch (e) { return fail(res, 'Lỗi: ' + e.message); }
}

export async function handlePurchaseOrderTypes(req, res, d) {
  const { db } = prDeps(d);
  const { rows } = await db.query(`SELECT no, type FROM purchase_order_types WHERE TRIM(type) <> '' ORDER BY sheet_row NULLS LAST, id`);
  return ok(res, 'Thành công', { types: rows.map((r) => ({ no: r.no || '', type: r.type })) });
}

export async function handleAddSupplier(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = src(req);
  const name = str(b.name);
  if (!name) return fail(res, 'Supplier name is required');
  const dup = await db.query(`SELECT 1 FROM master_vendors WHERE LOWER(TRIM(extra->>'Vendor_Full_Name')) = LOWER($1) LIMIT 1`, [name]);
  if (dup.rows.length) return fail(res, `Supplier "${name}" already exists`);
  const { rows: cols } = await db.query(`SELECT name FROM master_columns WHERE table_key = 'vendors'`);
  const extra = supplierExtra(b, new Set(cols.map((c) => c.name)));
  const { rows } = await db.query('INSERT INTO master_vendors (extra) VALUES ($1) RETURNING id', [JSON.stringify(extra)]);
  return ok(res, 'Supplier added successfully', { supplierId: 'VD' + String(rows[0].id).padStart(3, '0'), name });
}

export async function handleValidatePRForDirectPayment(req, res, d) {
  const { db, who, paymentsForPR } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const prNo = str(src(req).prNo);
  if (!prNo) return fail(res, 'Thiếu số PR.');
  const row = await getPR(db, prNo);
  if (!row) return fail(res, `Không tìm thấy PR: ${prNo}`);
  const problem = directPaymentProblem(row);
  if (problem) return fail(res, problem);
  const open = (await paymentsForPR(db, prNo)).filter((p) => !['Rejected', 'Từ chối'].includes(p.status));
  if (open.length) return fail(res, 'Đã tồn tại đề nghị thanh toán cho PR này.');
  return ok(res, 'OK', { prNo: row.pr_no, vendorName: row.vendor_name || '', department: row.department || '',
    grandTotal: Number(row.grand_total) || 0, requesterName: row.requester_name || '', purchaseType: row.purchase_type || 'goods',
    p2pBranch: row.p2p_branch || 'full' });
}
```

- [ ] **Step 8: Route everything; delete the old handler**

`api/router.js`:
- Remove the `./handlers/purchase-request.js` import.
- Add `import { handlePRHistory, handlePRDetail, handlePRSearch, handleP2PHistory, handleGoodsCatalog, handlePurchaseOrderTypes, handleAddSupplier, handleValidatePRForDirectPayment } from './handlers/pr/reads.js';`.
- Replace the `// P2P (Phase 4)` block of `NEW_HANDLERS` with:

```js
  // Purchase requests (Plan 5, workflow key p2p)
  purchaseRequest:             handlePRSubmit,
  resubmitPurchaseRequest:     handlePRResubmit,
  approvePurchaseRequest:      handlePRApprove,
  rejectPurchaseRequest:       handlePRReject,
  sendBackPurchaseRequest:     handlePRSendBack,
  getPurchaseRequestHistory:   handlePRHistory,
  getPurchaseRequest:          handlePRDetail,
  searchPurchaseRequests:      handlePRSearch,
  getP2PHistory:               handleP2PHistory,
  getGoodsCatalog:             handleGoodsCatalog,
  getPurchaseOrderTypes:       handlePurchaseOrderTypes,
  addSupplier:                 handleAddSupplier,
  // Payment side of a PR (workflow key payments, turned on by Plan 6)
  validatePRForDirectPayment:  handleValidatePRForDirectPayment,
```

Then add to `WORKFLOW_ACTIONS`:

```js
  p2p: ['purchaseRequest', 'resubmitPurchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'sendBackPurchaseRequest',
    'getPurchaseRequestHistory', 'getPurchaseRequest', 'searchPurchaseRequests', 'getP2PHistory', 'getGoodsCatalog',
    'getPurchaseOrderTypes', 'addSupplier'],
  payments: ['validatePRForDirectPayment'],
```

Run `git rm api/handlers/purchase-request.js api/lib/pr-approval-state.js`, then `grep -rn "purchase-request.js\|pr-approval-state" api server.js scripts tests`. Expected: no output.

- [ ] **Step 9: Run the tests**

Run the full suite. Expected: all pass, about 202 (views 4, reads 9, router 1).

- [ ] **Step 10: Commit**

```bash
git add api/lib/purchase-requests/views.js api/handlers/pr/reads.js api/router.js tests/purchase-requests/views.test.js tests/purchase-requests/reads.test.js tests/server/router-p2p.test.js
git commit -m "feat(pr): list/detail/search/history/catalog/supplier on Postgres with visibility; old PR handler removed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sheet copy for Purchase_Request_History and PR_Audit_Log

**Files:**
- Create: `api/lib/sheets/pr-records.js`
- Modify:
  - `api/lib/sheets/rows.js`: first occurrence only.
  - `api/lib/sheets/mirror-run.js`: compound key.
  - `api/jobs/sheet-mirror.js`: start when either id is set.
  - `api/lib/sheets/voucher-records.js`: export `metadataJson`.
  - `api/lib/purchase-requests/repo.js`: `recordChange` also enqueues.
- Test:
  - `tests/sheets/pr-records.test.js` (new)
  - `tests/sheets/rows.test.js`, `tests/sheets/outbox.test.js`, `tests/sheets/mirror-job.test.js`, `tests/purchase-requests/repo.test.js` (extended)

**Interfaces:**
- Consumes:
  - `enqueue(client, {spreadsheetId, tab, mode, keyColumn, record})`.
  - `metadataJson(meta)`: keeps the cell under 45,000 characters by replacing data URLs with `[đã lưu trong hệ thống]`.
- Produces:
  - `p2pSpreadsheetId() → string`. It reads `P2P_SPREADSHEET_ID` at call time and has no default.
  - `PR_TAB = 'Purchase_Request_History'`, `AUDIT_TAB = 'PR_Audit_Log'`, `PR_KEY = 'pr_no,row_type'`.
  - `prRecord(row) → {pr_no … attachment_urls, row_type:'submit'}`.
  - `auditRecord(entry) → {document_no … extra_json}`.
  - `rowForHeader`: a header that repeats (compared trimmed and case-folded) gets the value in its first column only. Later copies stay `''`.
  - Upserts: `key_column` may list several comma-separated columns, and all must match.

Why both matter for PRs:
- The live header has 70 columns. `row_type` and the nine `event_*` columns repeat five times (spec §1.2, header in the CSV). GAS reads `row[20]` only.
- Event rows share `pr_no` with their PR. An upsert keyed on `pr_no` alone could overwrite a legacy event row, so the key is `pr_no` plus `row_type = 'submit'`.

The copy keeps GAS-side contracts, acceptance minutes and payments working during a rehearsal. They read col O (status), col R (contract reviewer) and the metadata `p2pBranch`.

- [ ] **Step 1: Write the failing tests**

```js
// tests/sheets/pr-records.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prRecord, auditRecord, PR_KEY } from '../../api/lib/sheets/pr-records.js';
import { rowForHeader } from '../../api/lib/sheets/rows.js';

// The live Purchase_Request_History header (exported 2026-10-06): 20 base columns, then row_type + event_* five times.
const G = 'row_type,event_action,event_role,event_actor_email,event_actor_name,event_prev_status,event_new_status,event_timestamp,event_note,event_metadata_json';
const HEADER = ('pr_no,company_name,company_key,department,requester_name,required_date,priority,purpose,suggested_vendor,budget_code,'
  + 'budget_approver_email,supplier_approver_email,items_json,grand_total,status,submitted_at,metadata_json,contract_approver_email,'
  + `purchasing_approver_email,attachment_urls,${G},${G},${G},${G},`
  + 'Row_Type,Event_Action,Event_Role,Event_Actor_Email,Event_Actor_Name,Event_Prev_Status,Event_New_Status,Event_Timestamp,Event_Note,Event_Meta_JSON').split(',');

const row = {
  pr_no: 'EV-PR20261007000001', company_name: 'CT', company_key: 'E.V', department: 'BH', requester_name: 'Thư', required_date: '2026-10-20',
  priority: 'Gấp', purpose: 'Mua', vendor_name: 'NCC', budget_code: '', budget_approver_email: 'linh@x.vn', supplier_approver_email: 'linh@x.vn',
  items: [{ desc: 'Khăn', price: '029900' }], grand_total: '149500', status: 'Mua hàng (5/5)', submitted_at: new Date('2026-10-07T01:00:00Z'),
  metadata: { p2pBranch: 'simplified', requesterSignature: 'data:image/png;base64,' + 'A'.repeat(50000) }, contract_approver_email: '',
  purchasing_approver_email: 'tlc.ap@x.vn', attachments: [{ fileName: 'a', fileUrl: 'https://r2/a' }, { fileName: 'b', fileUrl: 'https://r2/b' }],
};

test('the live header has 70 columns; the PR row lands positionally where GAS reads it', () => {
  assert.equal(HEADER.length, 70);
  const cells = rowForHeader(HEADER, prRecord(row));
  assert.equal(cells.length, 70);
  assert.equal(cells[0], 'EV-PR20261007000001');
  assert.equal(cells[13], 149500);
  assert.equal(cells[14], 'Mua hàng (5/5)');
  assert.equal(cells[15], '2026-10-07T01:00:00.000Z');
  assert.equal(cells[19], 'https://r2/a, https://r2/b');
  assert.equal(cells[20], 'submit', 'first row_type column (GAS row[20])');
  assert.deepEqual(cells.slice(21), Array(49).fill(''), 'repeated row_type/event_* columns stay empty');
  const meta = JSON.parse(cells[16]);
  assert.equal(meta.p2pBranch, 'simplified');
  assert.equal(meta.requesterSignature, '[đã lưu trong hệ thống]', 'cell limit');
  assert.equal(JSON.parse(cells[12])[0].price, '029900');
});
test('PR_KEY matches the submit row, never an event row', () => {
  assert.equal(PR_KEY, 'pr_no,row_type');
});
test('auditRecord: PR_Audit_Log columns', () => {
  assert.deepEqual(auditRecord({ docNo: 'EV-1', company: 'CT', action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', actorName: '',
    prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z', note: '', extra: { signatureUploaded: true } }), {
    document_no: 'EV-1', flow: 'PR', company_name: 'CT', action: 'Approve', role: 'budget', actor_email: 'linh@x.vn', actor_name: '',
    prev_status: 'a', new_status: 'b', timestamp: '2026-10-07T02:00:00.000Z', note: '', extra_json: '{"signatureUploaded":true}',
  });
});
```

Add to `tests/sheets/rows.test.js`:

```js
test('rowForHeader: a repeated header (any case) gets the value in its first column only', () => {
  assert.deepEqual(rowForHeader(['a', 'row_type', 'b', 'Row_Type', 'ROW_TYPE '], { a: 1, row_type: 'submit', b: 2 }), [1, 'submit', 2, '', '']);
});
```

Add to `tests/sheets/outbox.test.js`:

```js
test('upsert with a compound key updates the matching submit row, not the event row of the same PR', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { P: [['pr_no', 'status', 'row_type'], ['EV-1', '', 'event'], ['EV-1', 'old', 'submit']] };
  await enqueue(db, { spreadsheetId: 's', tab: 'P', mode: 'upsert', keyColumn: 'pr_no,row_type', record: { pr_no: 'EV-1', status: 'new', row_type: 'submit' } });
  await enqueue(db, { spreadsheetId: 's', tab: 'P', mode: 'upsert', keyColumn: 'pr_no,row_type', record: { pr_no: 'EV-2', status: 'x', row_type: 'submit' } });
  assert.deepEqual(await runSheetMirrorOnce(fakeSheets(tabs), db), { done: 2, failed: 0 });
  assert.deepEqual(tabs.P.slice(1), [['EV-1', '', 'event'], ['EV-1', 'new', 'submit'], ['EV-2', 'x', 'submit']]);
});
```

Add to `tests/sheets/mirror-job.test.js`:

```js
test('SHEETS_MIRROR=on with only P2P_SPREADSHEET_ID: starts', async () => {
  await withEnv({ SHEETS_MIRROR: 'on', VOUCHER_SPREADSHEET_ID: undefined, P2P_SPREADSHEET_ID: 'p2p-456' }, async () => {
    const { result, lines } = await capture(() => startSheetMirrorJob({ sheets: { authorize: async () => {} }, intervalMs: 3600000 }));
    assert.equal(typeof result, 'object');
    clearInterval(result);
    assert.match(lines.join('\n'), /p2p-456/);
  });
});
```

Add to `tests/purchase-requests/repo.test.js`:

```js
test('recordChange queues the Sheet copy (PR upsert + audit append) when P2P_SPREADSHEET_ID is set', { skip }, async () => {
  await db.query('TRUNCATE sheet_outbox');
  const row = await getPR(db, 'ZZ-PR20261007000001');
  delete process.env.P2P_SPREADSHEET_ID;
  await recordChange(db, row, { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', at: '2026-10-07T04:00:00.000Z' });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sheet_outbox')).rows[0].n, 0, 'no target → nothing queued');
  process.env.P2P_SPREADSHEET_ID = 'p2p-test';
  try {
    await recordChange(db, row, { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', at: '2026-10-07T04:00:00.000Z' });
  } finally { delete process.env.P2P_SPREADSHEET_ID; }
  const ob = (await db.query('SELECT tab, mode, key_column, record FROM sheet_outbox ORDER BY id')).rows;
  assert.deepEqual(ob.map((o) => [o.tab, o.mode, o.key_column]), [['Purchase_Request_History', 'upsert', 'pr_no,row_type'], ['PR_Audit_Log', 'append', null]]);
  assert.equal(ob[0].record.row_type, 'submit');
  assert.equal(ob[1].record.document_no, 'ZZ-PR20261007000001');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test --test-concurrency=1 tests/sheets/ tests/purchase-requests/repo.test.js`. Expected: FAIL. `pr-records.js` is missing, the duplicate header fills every copy, the compound key throws `Key column pr_no,row_type not in P`, the mirror job refuses to start, and the outbox is empty.

- [ ] **Step 3: Implement**

```js
// api/lib/sheets/pr-records.js — Postgres PR changes → Purchase_Request_History / PR_Audit_Log rows (pure).
// Header facts (live export 2026-10-06): 20 base columns + row_type/event_* repeated 5× (only the first
// group is ever read; rowForHeader fills first occurrences only). PR rows are upserted on pr_no + row_type,
// so legacy event rows of the same PR are never overwritten. Times are ISO text, as GAS wrote them.
import { metadataJson } from './voucher-records.js';

export const p2pSpreadsheetId = () => String(process.env.P2P_SPREADSHEET_ID || '').trim();
export const PR_TAB = 'Purchase_Request_History';
export const AUDIT_TAB = 'PR_Audit_Log';
export const PR_KEY = 'pr_no,row_type';

const iso = (t) => (t ? new Date(t).toISOString() : '');

export function prRecord(row) {
  return {
    pr_no: row.pr_no, company_name: row.company_name || '', company_key: row.company_key || '', department: row.department || '',
    requester_name: row.requester_name || '', required_date: row.required_date || '', priority: row.priority || '',
    purpose: row.purpose || '', suggested_vendor: row.vendor_name || '', budget_code: row.budget_code || '',
    budget_approver_email: row.budget_approver_email || '', supplier_approver_email: row.supplier_approver_email || '',
    items_json: JSON.stringify(row.items || []), grand_total: Number(row.grand_total) || 0, status: row.status || '',
    submitted_at: iso(row.submitted_at), metadata_json: metadataJson(row.metadata || {}),
    contract_approver_email: row.contract_approver_email || '', purchasing_approver_email: row.purchasing_approver_email || '',
    attachment_urls: (row.attachments || []).filter((a) => a && a.fileUrl).map((a) => a.fileUrl).join(', '),
    row_type: 'submit',
  };
}

export function auditRecord(e) {
  return {
    document_no: e.docNo, flow: 'PR', company_name: e.company || '', action: e.action, role: e.role || '',
    actor_email: String(e.actorEmail || '').trim().toLowerCase(), actor_name: e.actorName || '',
    prev_status: e.prevStatus || '', new_status: e.newStatus || '', timestamp: e.at || new Date().toISOString(),
    note: e.note || '', extra_json: e.extra && Object.keys(e.extra).length ? JSON.stringify(e.extra) : '',
  };
}
```

`api/lib/sheets/voucher-records.js`: change `function metadataJson(meta)` to `export function metadataJson(meta)`.

`api/lib/sheets/rows.js`: replace `rowForHeader` with:

```js
/** A repeated header (Purchase_Request_History repeats row_type/event_* 5×) gets the value in its first column only. */
export function rowForHeader(header, record) {
  const byKey = {};
  for (const [k, v] of Object.entries(record || {})) byKey[norm(k)] = v;
  const seen = new Set();
  return header.map((h) => {
    const k = norm(h);
    if (seen.has(k)) return '';
    seen.add(k);
    return cell(byKey[k]);
  });
}
```

`api/lib/sheets/mirror-run.js`: replace the `else { … }` upsert branch inside `runSheetMirrorOnce` with:

```js
        } else {
          // key_column may list several columns ("pr_no,row_type"): the target row must match all of them
          const keys = String(it.key_column).split(',').map((k) => k.trim()).filter(Boolean);
          const cols = keys.map((k) => header.findIndex((h) => norm(h) === norm(k)));
          const missing = keys.filter((_, j) => cols[j] < 0);
          if (missing.length) throw new Error(`Key column ${missing.join(', ')} not in ${it.tab}`);
          const want = keys.map((k) => String(it.record[k] ?? it.record[norm(k)] ?? ''));
          const columns = [];
          for (const c of cols) columns.push(await sheets.getColumn(it.spreadsheet_id, it.tab, c));
          const row = rowForHeader(header, it.record);
          const height = Math.max(0, ...columns.map((c) => c.length));
          let target = -1;
          for (let n = 1; n < height && target < 0; n++) {
            if (columns.every((c, j) => String(c[n] ?? '') === want[j])) target = n;
          }
          if (target > 0) await sheets.update(it.spreadsheet_id, it.tab, target + 1, row);
          else await sheets.append(it.spreadsheet_id, it.tab, [row]);
        }
```

`api/jobs/sheet-mirror.js`:
- Import `p2pSpreadsheetId` from `../lib/sheets/pr-records.js`.
- In `startSheetMirrorJob`, replace the `target` lines and the "started" log with:

```js
  const targets = [voucherSpreadsheetId(), p2pSpreadsheetId()].filter(Boolean);
  if (!targets.length) {
    console.error('[sheet-mirror] NOT started: SHEETS_MIRROR=on but neither VOUCHER_SPREADSHEET_ID nor P2P_SPREADSHEET_ID is set (no default target)');
    return false;
  }
```

```js
  console.log(`[sheet-mirror] started: copying to spreadsheet ${targets.join(', ')}`);
```

`api/lib/purchase-requests/repo.js`: add the imports and replace `recordChange`:

```js
import { enqueue } from '../sheets/outbox.js';
import { p2pSpreadsheetId, PR_TAB, AUDIT_TAB, PR_KEY, prRecord, auditRecord } from '../sheets/pr-records.js';

/**
 * Every PR state change goes through here, after the row is updated and in the same transaction:
 * audit row(s), then the Sheet copy (PR row upserted, audit rows appended) when P2P_SPREADSHEET_ID is set.
 */
export async function recordChange(client, row, entries) {
  const list = [].concat(entries).map((e) => ({ docNo: row.pr_no, company: row.company_name, ...e }));
  for (const e of list) await appendAudit(client, e);
  const spreadsheetId = p2pSpreadsheetId();
  if (!spreadsheetId) return;
  await enqueue(client, { spreadsheetId, tab: PR_TAB, mode: 'upsert', keyColumn: PR_KEY, record: prRecord(row) });
  for (const e of list) await enqueue(client, { spreadsheetId, tab: AUDIT_TAB, mode: 'append', record: auditRecord(e) });
}
```

`voucher-records.js` imports `../vouchers/repo.js` and `../vouchers/compat.js`, which are both pure, so `repo.js` still needs no pool.

- [ ] **Step 4: Run the tests**

Run the full suite. Expected: all pass, about 209.

- [ ] **Step 5: Commit**

```bash
git add api/lib/sheets/pr-records.js api/lib/sheets/rows.js api/lib/sheets/mirror-run.js api/lib/sheets/voucher-records.js api/jobs/sheet-mirror.js api/lib/purchase-requests/repo.js tests/sheets tests/purchase-requests/repo.test.js
git commit -m "feat(sheets): PR changes copied to Purchase_Request_History (first-occurrence headers, pr_no+row_type key) and PR_Audit_Log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Importer for the live PR data

**Files:**
- Create:
  - `api/lib/sheets/grid.js`
  - `api/lib/purchase-requests/importer.js`
  - `scripts/import-purchase-requests.js`
- Modify: `scripts/import-vouchers.js`. Its local `parseCsv` is removed; it is imported from `../api/lib/sheets/grid.js`.
- Test: `tests/purchase-requests/import-map.test.js`, `tests/purchase-requests/importer.test.js`

**Interfaces:**
- Consumes:
  - `sheetTime(s)`.
  - `findCompany`.
  - From Task 1: `insertPR`, `appendAudit`.
  - From Task 2: `approverEmails`, `pendingEmails`, `STATUS`.
  - `num` (Task 5).
  - From Task 4: `purchasingRequest`.
  - `queueMail(msg, db)`.
- Produces:
  - `parseCsv(text) → string[][]`.
  - `recordsFromGrid(grid) → [{sheetRow, <lower-case header>: string}]`. A repeated header keeps its first column.
  - importer.js:
    - `normalizeRequiredDate(s)`
    - `lastActivity(submittedAt, meta) → ISO|null`
    - `isSubmitRow(r)`
    - `prFromSheetRow(r, {archived})`
    - `auditFromSheetRow(r)`
    - `auditFromEventRow(r)`
    - `importPurchaseRequests(db, {working, archive, audit, poTypes, dryRun, notifyPurchasing}) → stats`

Rules:
- **Sources.**
  - The working sheet wins over the archive for the same number.
  - `PR_Audit_Log` rows are imported with `source='sheet'`.
  - Legacy event rows become history (`source='sheet-event'`) only for numbers with no audit rows, which is GAS's fallback.
- **Re-runs.**
  - A re-run replaces only rows it imported that have not changed since (`updated_at <= imported_at`).
  - Rows created or changed in Postgres are never overwritten.
  - Audit rows from the Sheet are deleted and re-inserted; `app` rows are untouched.
- **Timestamps.** `updated_at` is GAS's last-activity stamp. Archive rows get `archived_at` equal to that stamp.
- **Legacy defaults.**
  - Rows without `p2pBranch` default to `full`, as GAS readers did.
  - A `M/D/YYYY` `required_date` becomes `YYYY-MM-DD`.
  - Attachments come from `metadata.attachments`, falling back to `attachment_urls`.
- **Spec §1.7.** The 3 renamed numbers keep their `previousPrNo` in metadata. The 3 audit-only numbers stay in the audit log and are visible to admins only.
- **Live vs repo GAS (open item 1).** The importer targets the live data. It accepts every shape the live export contains: rows with and without `requesterEmail`, `purchaseType` and `p2pBranch`, and event rows written after HEAD stopped writing them.
- **`--notify-purchasing`.** It queues one purchasing-stage email for each imported, non-archived `Mua hàng (5/5)` PR on the simplified branch. Those PRs were never emailed (B2; 11 live). It stamps `metadata.importNotifiedAt`, so a re-run never re-sends. The flag is off by default and used once on switch day.

- [ ] **Step 1: Write the failing pure test**

```js
// tests/purchase-requests/import-map.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, recordsFromGrid } from '../../api/lib/sheets/grid.js';
import { normalizeRequiredDate, lastActivity, isSubmitRow, prFromSheetRow, auditFromSheetRow, auditFromEventRow } from '../../api/lib/purchase-requests/importer.js';

test('parseCsv: quoted commas, quotes and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""","line1\nline2"\n'), [['a', 'b'], ['x, "y"', 'line1\nline2']]);
});
test('recordsFromGrid: lower-case keys; a repeated header keeps its first column; empty rows dropped', () => {
  const grid = [['pr_no', 'row_type', 'event_action', 'row_type', 'Row_Type'], ['EV-1', 'event', 'Submit', '', ''], ['', '', '', '', '']];
  assert.deepEqual(recordsFromGrid(grid), [{ sheetRow: 2, pr_no: 'EV-1', row_type: 'event', event_action: 'Submit' }]);
});
test('normalizeRequiredDate / isSubmitRow', () => {
  assert.equal(normalizeRequiredDate('5/28/2026'), '2026-05-28');
  assert.equal(normalizeRequiredDate('2026-10-20'), '2026-10-20');
  assert.equal(isSubmitRow({ row_type: 'submit' }), true);
  assert.equal(isSubmitRow({ row_type: '' }), true);
  assert.equal(isSubmitRow({ row_type: 'event' }), false);
});
test('lastActivity: latest of submit, approvals, rejection, resubmit, send backs (GAS prLastActivity_)', () => {
  assert.equal(lastActivity('2026-08-05T08:34:20.857Z', { budgetApprovedAt: '2026-08-06T01:00:00.000Z', sentBackHistory: [{ at: '2026-08-07T01:00:00.000Z' }] }), '2026-08-07T01:00:00.000Z');
  assert.equal(lastActivity('', {}), null);
});
test('prFromSheetRow: live row and legacy archive row', () => {
  const live = prFromSheetRow({ sheetRow: 5, pr_no: 'EV-PR20260805000003', company_name: 'CT', company_key: 'E.V', department: 'BH',
    requester_name: 'Thư', required_date: '2026-08-10', priority: 'Bình Thường', purpose: 'Kem', suggested_vendor: '', budget_code: '',
    budget_approver_email: 'Linh@x.vn', supplier_approver_email: 'linh@x.vn', items_json: '[{"desc":"Kem","total":"2000000"}]',
    grand_total: '2000000', status: 'Mua hàng (5/5)', submitted_at: '2026-08-05T08:34:20.857Z', contract_approver_email: 'kt@x.vn',
    purchasing_approver_email: 'Tlc.ap@x.vn', attachment_urls: 'https://drive.google.com/file/d/1/view', row_type: 'submit',
    metadata_json: JSON.stringify({ requesterEmail: 'Thu@x.vn', p2pBranch: 'full', purchaseType: 'goods', budgetStatus: 'Approved',
      supplierStatus: 'Approved', purchasingStatus: 'Pending', budgetApprovedAt: '2026-08-06T00:00:00.000Z' }) });
  assert.equal(live.requester_email, 'thu@x.vn');
  assert.equal(live.submitted_at, '2026-08-05T08:34:20.857Z');
  assert.equal(live.updated_at, '2026-08-06T00:00:00.000Z');
  assert.equal(live.archived_at, null);
  assert.deepEqual(live.pending_emails, ['tlc.ap@x.vn']);
  assert.deepEqual(live.attachments, [{ fileName: 'view', fileUrl: 'https://drive.google.com/file/d/1/view' }]);
  assert.equal(live.grand_total, 2000000);
  const old = prFromSheetRow({ sheetRow: 2, pr_no: 'EV-PR20260528000001', company_name: 'CT', required_date: '5/28/2026', status: 'Đã từ chối',
    submitted_at: '2026-05-28T02:00:00.000Z', items_json: '[]', grand_total: '100', metadata_json: '{"rejectedAt":"2026-05-29T00:00:00.000Z"}', row_type: 'submit' }, { archived: true });
  assert.equal(old.p2p_branch, 'full', 'GAS readers default legacy rows to full');
  assert.equal(old.required_date, '2026-05-28');
  assert.equal(old.archived_at, '2026-05-29T00:00:00.000Z');
  assert.deepEqual(old.pending_emails, []);
});
test('audit rows: PR_Audit_Log and legacy event rows', () => {
  const a = auditFromSheetRow({ sheetRow: 3, document_no: 'EV-1', flow: 'PR', company_name: 'CT', action: 'Approve', role: 'supplier',
    actor_email: 'Anh@x.vn', actor_name: '', prev_status: 'p', new_status: 'n', timestamp: '2026-06-30T09:15:55.135Z', note: '',
    extra_json: '{"signatureUploaded":true}' });
  assert.deepEqual([a.docNo, a.actorEmail, a.at, a.extra.signatureUploaded, a.source, a.sheetRow], ['EV-1', 'anh@x.vn', '2026-06-30T09:15:55.135Z', true, 'sheet', 3]);
  const e = auditFromEventRow({ sheetRow: 9, pr_no: 'EV-2', row_type: 'event', event_action: 'Submit', event_role: 'requester',
    event_actor_email: 'a@x.vn', event_actor_name: 'A', event_prev_status: '', event_new_status: 'n', event_timestamp: '2026-10-05T10:50:11.901Z',
    event_note: 'Kem', event_metadata_json: '' });
  assert.deepEqual([e.docNo, e.action, e.at, e.source, e.extra.fromEventRow], ['EV-2', 'Submit', '2026-10-05T10:50:11.901Z', 'sheet-event', true]);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run `node --test tests/purchase-requests/import-map.test.js`. Expected: FAIL (modules not found).

- [ ] **Step 3: Implement grid.js and the importer's pure part**

```js
// api/lib/sheets/grid.js — Sheet exports (CSV or API values) → records (pure).
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/**
 * Header row → lower-case keys. A header that repeats keeps its FIRST column: Purchase_Request_History
 * repeats row_type/event_* five times and only the first group ever holds data (spec §1.2).
 */
export function recordsFromGrid(grid) {
  const first = new Map();
  (grid[0] || []).forEach((h, i) => {
    const k = String(h || '').trim().toLowerCase();
    if (k && !first.has(k)) first.set(k, i);
  });
  return grid.slice(1).map((r, i) => {
    const rec = { sheetRow: i + 2 };
    for (const [k, idx] of first) rec[k] = String(r[idx] ?? '').trim();
    return rec;
  }).filter((rec) => Object.keys(rec).some((k) => k !== 'sheetRow' && rec[k]));
}
```

```js
// api/lib/purchase-requests/importer.js — Purchase_Request_History / _Archive / PR_Audit_Log → Postgres.
// Re-runnable: rows created or changed in Postgres (imported_at null, or updated_at > imported_at) are never touched.
import { sheetTime } from '../sheets/voucher-records.js';
import { findCompany } from '../vouchers/repo.js';
import { queueMail } from '../../handlers/email-queue.js';
import { STATUS, approverEmails, pendingEmails } from './state.js';
import { num } from './validate.js';
import { insertPR, appendAudit } from './repo.js';
import { purchasingRequest } from './emails.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

export function normalizeRequiredDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}

/** GAS prLastActivity_: latest of submit, rejection, approvals, resubmit and every send back. */
export function lastActivity(submittedAt, meta = {}) {
  const sb = Array.isArray(meta.sentBackHistory) ? meta.sentBackHistory.map((h) => h && h.at) : [];
  const t = [submittedAt, meta.rejectedAt, meta.budgetApprovedAt, meta.supplierApprovedAt, meta.contractApprovedAt,
    meta.purchasingApprovedAt, meta.resubmittedAt, ...sb].map((s) => (s ? new Date(s).getTime() : NaN)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
}

export const isSubmitRow = (r) => (lower(r.row_type) || 'submit') === 'submit';

export function prFromSheetRow(r, { archived = false } = {}) {
  const meta = parseJson(r.metadata_json, {}) || {};
  const submittedAt = sheetTime(r.submitted_at) || sheetTime(meta.submittedAt);
  const attachments = Array.isArray(meta.attachments)
    ? meta.attachments.map((a) => ({ fileName: a.fileName || '', fileUrl: a.fileUrl || '', ...(a.error ? { error: a.error } : {}) }))
    : String(r.attachment_urls || '').split(',').map((u) => u.trim()).filter(Boolean)
      .map((u) => ({ fileName: u.split('/').pop(), fileUrl: u }));
  const row = {
    pr_no: r.pr_no, company_name: r.company_name || '', company_key: r.company_key || '', department: r.department || '',
    requester_name: r.requester_name || '', requester_email: lower(meta.requesterEmail), required_date: normalizeRequiredDate(r.required_date),
    priority: r.priority || 'Bình Thường', purpose: r.purpose || '', vendor_name: r.suggested_vendor || '', budget_code: r.budget_code || '',
    budget_approver_email: lower(r.budget_approver_email), supplier_approver_email: lower(r.supplier_approver_email),
    contract_approver_email: lower(r.contract_approver_email), purchasing_approver_email: lower(r.purchasing_approver_email),
    items: parseJson(r.items_json, []), grand_total: num(r.grand_total), currency: 'VND', status: r.status || '',
    p2p_branch: meta.p2pBranch || 'full', purchase_type: meta.purchaseType || 'goods', attachments, metadata: meta,
    submitted_at: submittedAt, sheet_row: r.sheetRow,
  };
  row.approver_emails = approverEmails(row);
  row.pending_emails = pendingEmails(row, meta, row.status);
  const last = lastActivity(submittedAt, meta) || submittedAt;
  row.updated_at = last;
  row.archived_at = archived ? last : null;
  return row;
}

export function auditFromSheetRow(r) {
  return { docNo: r.document_no, company: r.company_name || '', action: r.action, role: r.role || '', actorEmail: lower(r.actor_email),
    actorName: r.actor_name || '', prevStatus: r.prev_status || '', newStatus: r.new_status || '', at: sheetTime(r.timestamp),
    note: r.note || '', extra: parseJson(r.extra_json, {}) || {}, source: 'sheet', sheetRow: r.sheetRow };
}

export function auditFromEventRow(r) {
  return { docNo: r.pr_no, company: '', action: r.event_action, role: r.event_role || '', actorEmail: lower(r.event_actor_email),
    actorName: r.event_actor_name || '', prevStatus: r.event_prev_status || '', newStatus: r.event_new_status || '',
    at: sheetTime(r.event_timestamp), note: r.event_note || '',
    extra: { ...(parseJson(r.event_metadata_json, {}) || {}), fromEventRow: true }, source: 'sheet-event', sheetRow: r.sheetRow };
}
```

- [ ] **Step 4: Run the pure test**

Run `node --test tests/purchase-requests/import-map.test.js`. Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing DB test**

```js
// tests/purchase-requests/importer.test.js — import is re-runnable and never overwrites Postgres changes
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown } from './helpers.js';

let imp, repo, pool, company, people;
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  imp = await import('../../api/lib/purchase-requests/importer.js');
  repo = await import('../../api/lib/purchase-requests/repo.js');
});
after(() => teardown(pool));

const meta = (o) => JSON.stringify({ requesterEmail: 'thu@x.vn', p2pBranch: 'simplified', purchaseType: 'goods', budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Pending', ...o });
const sub = (no, o = {}) => ({ sheetRow: 2, pr_no: no, company_name: company.company_name, company_key: company.company_key, requester_name: 'Thư',
  required_date: '2026-10-20', status: 'Mua hàng (5/5)', submitted_at: '2026-10-01T01:00:00.000Z', items_json: '[{"desc":"K","total":"100"}]',
  grand_total: '100', budget_approver_email: people.treasurer, supplier_approver_email: people.treasurer, purchasing_approver_email: people.ap,
  row_type: 'submit', metadata_json: meta(), ...o });
const tabs = () => ({
  working: [sub('EV-PR20261001000001'), sub('EV-PR20261001000002', { metadata_json: meta({ p2pBranch: 'full' }) }),
    { sheetRow: 9, pr_no: 'EV-PR20261001000002', row_type: 'event', event_action: 'Submit', event_role: 'requester', event_timestamp: '2026-10-01T01:00:00.000Z' }],
  archive: [sub('EV-PR20260528000001', { status: 'Đã từ chối', metadata_json: '{}' }), sub('EV-PR20261001000001', { status: 'Đã từ chối' })],
  audit: [{ sheetRow: 2, document_no: 'EV-PR20261001000001', action: 'Submit', role: 'requester', timestamp: '2026-10-01T01:00:00.000Z', extra_json: '' }],
  poTypes: [{ sheetRow: 2, no: '1', type: 'Hàng hóa' }],
});
const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;

test('import: working wins, archive flagged, audit + event fallback, PO types; dry run writes nothing', { skip }, async () => {
  const dry = await imp.importPurchaseRequests(pool, { ...tabs(), dryRun: true });
  assert.equal(dry.prs, 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM purchase_requests'), 0);
  const s = await imp.importPurchaseRequests(pool, tabs());
  assert.deepEqual([s.prs, s.archived, s.audit, s.eventAudit, s.poTypes, s.skippedNative], [3, 1, 1, 1, 1, 0]);
  const w = (await pool.query(`SELECT * FROM purchase_requests WHERE pr_no = 'EV-PR20261001000001'`)).rows[0];
  assert.equal(w.status, 'Mua hàng (5/5)', 'working sheet wins');
  assert.equal(w.company_id, company.id);
  assert.ok(w.imported_at);
  assert.deepEqual(w.pending_emails, [people.ap]);
  const a = (await pool.query(`SELECT archived_at FROM purchase_requests WHERE pr_no = 'EV-PR20260528000001'`)).rows[0];
  assert.ok(a.archived_at);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pr_audit_log WHERE doc_no = 'EV-PR20261001000002' AND source = 'sheet-event'`), 1);
});

test('re-run: same rows, no duplicate audit rows', { skip }, async () => {
  const before = await count('SELECT count(*)::int AS n FROM pr_audit_log');
  const s = await imp.importPurchaseRequests(pool, tabs());
  assert.equal(s.prs, 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM pr_audit_log'), before);
  assert.equal(await count('SELECT count(*)::int AS n FROM purchase_requests'), 3);
});

test('rows changed or created in Postgres are never overwritten', { skip }, async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = await repo.lockPR(c, 'EV-PR20261001000001');
    await repo.updatePR(c, row.id, { status: 'Hoàn thành' });
    await c.query('COMMIT');
  } finally { c.release(); }
  await repo.insertPR(pool, { pr_no: 'EV-PR20261001000009', status: 'Đang duyệt ngân sách & NCC (2/5)', company_name: 'native' });
  const t = tabs();
  t.working.push(sub('EV-PR20261001000009'));
  const s = await imp.importPurchaseRequests(pool, t);
  assert.equal(s.skippedNative, 2);
  assert.equal((await repo.getPR(pool, 'EV-PR20261001000001')).status, 'Hoàn thành');
  assert.equal((await repo.getPR(pool, 'EV-PR20261001000009')).company_name, 'native');
});

test('--notify-purchasing: one email per stuck simplified PR, never twice', { skip }, async () => {
  await pool.query(`TRUNCATE purchase_requests, email_queue`);
  const s1 = await imp.importPurchaseRequests(pool, { ...tabs(), notifyPurchasing: true });
  assert.equal(s1.notified, 1, 'EV-…0001 is simplified at Mua hàng; …0002 is full (GAS emailed it)');
  const s2 = await imp.importPurchaseRequests(pool, { ...tabs(), notifyPurchasing: true });
  assert.equal(s2.notified, 0);
  const m = (await pool.query(`SELECT to_email, subject FROM email_queue`)).rows;
  assert.deepEqual(m.map((x) => x.to_email), [people.ap]);
  assert.equal(m[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261001000001');
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/purchase-requests/importer.test.js`. Expected: FAIL (`importPurchaseRequests is not a function`).

- [ ] **Step 7: Implement importPurchaseRequests and the CLI**

Append to `api/lib/purchase-requests/importer.js`:

```js
/** One transaction for the whole import (dry run = ROLLBACK). Returns counts for the report. */
export async function importPurchaseRequests(db, { working = [], archive = [], audit = [], poTypes = null, dryRun = false, notifyPurchasing = false }) {
  const stats = { prs: 0, archived: 0, skippedNative: 0, noCompany: 0, audit: 0, eventAudit: 0, poTypes: 0, notified: 0, byStatus: {} };
  const prs = new Map();
  for (const r of archive) if (r.pr_no && isSubmitRow(r)) prs.set(r.pr_no, prFromSheetRow(r, { archived: true }));
  for (const r of working) if (r.pr_no && isSubmitRow(r)) prs.set(r.pr_no, prFromSheetRow(r)); // working sheet wins
  const auditEntries = audit.filter((r) => r.document_no).map(auditFromSheetRow);
  const withAudit = new Set(auditEntries.map((e) => e.docNo));
  const eventEntries = [...working, ...archive].filter((r) => r.pr_no && !isSubmitRow(r) && !withAudit.has(r.pr_no)).map(auditFromEventRow);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const pr of prs.values()) {
      const old = (await client.query(
        'SELECT id, imported_at, updated_at, metadata FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [pr.pr_no])).rows[0];
      if (old && (!old.imported_at || old.updated_at > old.imported_at)) { stats.skippedNative += 1; continue; }
      const company = await findCompany(client, pr.company_name, pr.company_key);
      if (!company) stats.noCompany += 1;
      const notifiedAt = old && old.metadata && old.metadata.importNotifiedAt;
      const metadata = notifiedAt ? { ...pr.metadata, importNotifiedAt: notifiedAt } : pr.metadata;
      if (old) await client.query('DELETE FROM purchase_requests WHERE id = $1', [old.id]);
      const row = await insertPR(client, { ...pr, metadata, company_id: company ? company.id : null });
      await client.query('UPDATE purchase_requests SET imported_at = NOW() WHERE id = $1', [row.id]); // DB clock, like later updates
      stats.prs += 1;
      if (pr.archived_at) stats.archived += 1;
      stats.byStatus[pr.status] = (stats.byStatus[pr.status] || 0) + 1;
      if (notifyPurchasing && !notifiedAt && !pr.archived_at && pr.status === STATUS.PURCHASING && pr.p2p_branch === 'simplified') {
        const m = purchasingRequest(row);
        if (m) {
          await queueMail(m, client);
          await client.query(`UPDATE purchase_requests SET metadata = metadata || jsonb_build_object('importNotifiedAt', NOW()::text) WHERE id = $1`, [row.id]);
          stats.notified += 1;
        }
      }
    }
    await client.query(`DELETE FROM pr_audit_log WHERE source IN ('sheet', 'sheet-event')`);
    for (const e of auditEntries) { await appendAudit(client, e); stats.audit += 1; }
    for (const e of eventEntries) { await appendAudit(client, e); stats.eventAudit += 1; }
    if (poTypes) {
      await client.query('DELETE FROM purchase_order_types');
      for (const t of poTypes.filter((x) => String(x.type || '').trim())) {
        await client.query('INSERT INTO purchase_order_types (no, type, sheet_row) VALUES ($1, $2, $3)', [t.no || '', t.type.trim(), t.sheetRow]);
        stats.poTypes += 1;
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  return stats;
}
```

```js
#!/usr/bin/env node
/**
 * scripts/import-purchase-requests.js — Purchase requests from the Google Sheet into Postgres.
 *
 *   node scripts/import-purchase-requests.js --dir ./sheets              # Purchase_Request_History.csv, Purchase_Request_Archive.csv,
 *                                                                        # PR_Audit_Log.csv, optional "Purchase Order.csv"
 *   node scripts/import-purchase-requests.js --live                      # read with SHEETS_MIRROR_KEY_FILE
 *   node scripts/import-purchase-requests.js --dir ./sheets --dry-run
 *   node scripts/import-purchase-requests.js --live --notify-purchasing  # switch day only: email the purchasing approver
 *                                                                        # of simplified PRs stuck at Mua hàng (GAS bug B2)
 * Needs migrations 001–007 and Master Data. Re-runnable (see api/lib/purchase-requests/importer.js).
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import 'dotenv/config';
import { parseCsv, recordsFromGrid } from '../api/lib/sheets/grid.js';
import { SPREADSHEET_ID } from '../api/lib/master-registry.js';
import { importPurchaseRequests } from '../api/lib/purchase-requests/importer.js';

const args = process.argv.slice(2);
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
const LIVE = args.includes('--live');
if (!DIR && !LIVE) { console.error('Use --dir <folder> or --live'); process.exit(1); }

async function readTab(name, { optional = false } = {}) {
  try {
    if (DIR) return recordsFromGrid(parseCsv(fs.readFileSync(path.join(DIR, `${name}.csv`), 'utf-8').replace(/^﻿/, '')));
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.SHEETS_MIRROR_KEY_FILE || 'secrets/sheets-mirror.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${name}'` });
    return recordsFromGrid((r.data.values || []).map((row) => row.map((v) => (v == null ? '' : String(v)))));
  } catch (e) {
    if (optional) { console.warn(`[ImportPR] ${name} not read (${e.message}); skipped`); return null; }
    throw e;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow', max: 2 });
try {
  const [working, archive, audit, poTypes] = [await readTab('Purchase_Request_History'), await readTab('Purchase_Request_Archive', { optional: true }),
    await readTab('PR_Audit_Log'), await readTab('Purchase Order', { optional: true })];
  const stats = await importPurchaseRequests(pool, { working, archive: archive || [], audit, poTypes,
    dryRun: args.includes('--dry-run'), notifyPurchasing: args.includes('--notify-purchasing') });
  console.log(`[ImportPR] ${DIR ? 'CSV ' + DIR : 'live sheet'}${args.includes('--dry-run') ? ' (dry run, rolled back)' : ''}`);
  console.log(JSON.stringify(stats, null, 2));
  console.log('Export 2026-10-06 expectation: prs 34 (32 working + 2 archive), byStatus Mua hàng (5/5) 21 / Đang duyệt ngân sách & NCC (2/5) 11, audit 80');
} finally { await pool.end(); }
```

In `scripts/import-vouchers.js`, delete the local `function parseCsv(text) { … }` and add `import { parseCsv } from '../api/lib/sheets/grid.js';`.

- [ ] **Step 8: Run the tests and a dry run on the real export**

Run the full suite. Expected: all pass, about 219.

Then run:

```bash
DATABASE_URL=postgres://localhost:5432/tlcg_v_test node scripts/import-purchase-requests.js --dir /private/tmp/claude-501/-Volumes-MI-02--SSD--CN-Personal-Projects-TLCG-Workflow/e910dcc6-8e83-4857-b272-2b705d6a5ca8/scratchpad/wf-sheets --dry-run
```

Expected:
- `prs: 34`, `archived: 2`, `audit: 80`, `noCompany: 0`.
- `byStatus` has `Mua hàng (5/5)` 21, `Đang duyệt ngân sách & NCC (2/5)` 11, `Đã từ chối` 1 and `Hoàn thành` 1.
- `eventAudit: 0`. All live event rows have audit rows; the two archived PRs have neither.

If `noCompany > 0`, list those keys and fix `findCompany` inputs before going on. Do not change Master Data from the importer.

- [ ] **Step 9: Commit**

```bash
git add api/lib/sheets/grid.js api/lib/purchase-requests/importer.js scripts/import-purchase-requests.js scripts/import-vouchers.js tests/purchase-requests/import-map.test.js tests/purchase-requests/importer.test.js
git commit -m "feat(pr): re-runnable importer for Purchase_Request_History/_Archive/PR_Audit_Log (+ --notify-purchasing)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Boot check and the deep link in the page

**Files:**
- Modify:
  - `api/lib/startup-checks.js`
  - `server.js` (next to the `missingVoucherSchema` check, `server.js:164-172`)
  - `purchase_request.html` (`DOMContentLoaded` handler, the `loadRecentPR();` line near `purchase_request.html:5544`; outside the locked Step 1 block)
- Test: `tests/server/startup.test.js`

**Interfaces:**
- Produces: `missingP2PSchema(workflows, db) → string|null`. It is null when `p2p` is off, when both `purchase_order_types` (migration 007) and `sheet_outbox` (006) exist, or when the DB is unreachable (logged).
- The page opens `purchase_request.html?prNo=<số phiếu>` straight to that PR's drawer, which is the link every PR email carries. In GAS mode the same code works against GAS's list.

The page needs no other change:
- `i18n.js` already adds `Authorization: Bearer` to same-origin `/api/` calls.
- Resubmit's `submittedAt` is ignored by the server (B1).
- `result.data.status` is now present (B8).
- Attachments are still sent as base64 and stored on R2 by the server.
- Send back to step 3 is answered with a clear message (see Open items).

- [ ] **Step 1: Write the failing test**

Add to `tests/server/startup.test.js` (and extend the import with `missingP2PSchema`):

```js
const fakeDb2 = (t, o) => ({ query: async () => ({ rows: [{ t, o }] }) });
test('missingP2PSchema: p2p off → not checked', async () => {
  assert.equal(await missingP2PSchema(['vouchers'], fakeDb2(null, null)), null);
});
test('missingP2PSchema: p2p on without migration 007 → names the file', async () => {
  assert.match(await missingP2PSchema(['p2p'], fakeDb2(null, 'sheet_outbox')), /007_purchase_requests\.sql/);
  assert.match(await missingP2PSchema(['p2p'], fakeDb2('purchase_order_types', null)), /006_sheet_outbox\.sql/);
});
test('missingP2PSchema: real test database has migrations 006 and 007', { skip: !process.env.TEST_DATABASE_URL && 'needs TEST_DATABASE_URL' }, async () => {
  const pg = (await import('pg')).default;
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  try { assert.equal(await missingP2PSchema(['p2p'], db), null); } finally { await db.end(); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test tests/server/startup.test.js`. Expected: FAIL (`missingP2PSchema` is not exported).

- [ ] **Step 3: Implement**

Append to `api/lib/startup-checks.js`:

```js
/** p2p on Postgres needs migration 007 (and 006 for its Sheet copy). Message when missing, else null. */
export async function missingP2PSchema(workflows, db) {
  if (!workflows.includes('p2p')) return null;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.purchase_order_types') AS t, to_regclass('public.sheet_outbox') AS o`);
    const r = rows[0] || {};
    if (!r.t) return 'PG_WORKFLOWS includes p2p but migration 007 is missing: run db/migrations/007_purchase_requests.sql';
    if (!r.o) return 'PG_WORKFLOWS includes p2p but table sheet_outbox does not exist: run db/migrations/006_sheet_outbox.sql';
    return null;
  } catch (e) {
    console.error('[server] could not check the p2p schema (database unreachable?):', e.message);
    return null;
  }
}
```

In `server.js`, import `missingP2PSchema` with `missingVoucherSchema`, and after the voucher check add:

```js
const p2pProblem = await missingP2PSchema(postgresWorkflows, pool);
if (p2pProblem) {
  console.error(`[server] FATAL: ${p2pProblem}`);
  process.exit(1);
}
if (postgresWorkflows.includes('p2p') && !process.env.P2P_SPREADSHEET_ID) {
  console.warn('[server] PR Sheet copy disabled: P2P_SPREADSHEET_ID not set');
}
```

In `purchase_request.html`, inside `window.addEventListener('DOMContentLoaded', () => { … })`, replace the single line `loadRecentPR();` with:

```js
        loadRecentPR().then(() => {
            // Links in PR emails: purchase_request.html?prNo=<số phiếu> opens that request's drawer
            const linkedPrNo = new URLSearchParams(location.search).get('prNo');
            if (linkedPrNo) openPRDrawer(linkedPrNo, '');
        });
```

- [ ] **Step 4: Run the tests and check the page by hand**

Run the full suite. Expected: all pass, about 222.

Then start the server locally:

```bash
PORT=3999 HOST=127.0.0.1 PG_WORKFLOWS=p2p DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node server.js
```

Sign in as a requester of an imported PR (test password `Test#2026`) and open `http://127.0.0.1:3999/purchase_request.html?prNo=<that number>`. Expected: the drawer opens on that PR with its history.

Stop the server. Start it without `PG_WORKFLOWS` and repeat with a live PR number. Expected: the drawer opens through GAS.

- [ ] **Step 5: Commit**

```bash
git add api/lib/startup-checks.js server.js purchase_request.html tests/server/startup.test.js
git commit -m "feat(pr): refuse to boot p2p without migration 007; email deep link opens the PR drawer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end with GAS dead, plus a GAS-mode regression run

**Files:**
- Scratch Playwright script `e2e-pr.cjs`, not committed. Model it on the scratch `e2e-nogas.cjs`, which logs in through `#login-email` / `#login-pass` with `Test#2026`.
- Modify: `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md` (tick Plan 5).

- [ ] **Step 1: Import the live export and start with every GAS URL dead**

```bash
psql tlcg_v_test -c "truncate purchase_requests, pr_audit_log, email_queue, sheet_outbox"
DATABASE_URL=postgres://localhost:5432/tlcg_v_test node scripts/import-purchase-requests.js --dir /private/tmp/claude-501/-Volumes-MI-02--SSD--CN-Personal-Projects-TLCG-Workflow/e910dcc6-8e83-4857-b272-2b705d6a5ca8/scratchpad/wf-sheets
PORT=3999 HOST=127.0.0.1 PG_WORKFLOWS=p2p APP_BASE_URL=http://127.0.0.1:3999 P2P_SPREADSHEET_ID=test-p2p-sheet \
TLCG_CASH_BACKEND_URL=http://127.0.0.1:9/gas TLCG_CORE_BACKEND_URL=http://127.0.0.1:9/gas TLCG_P2P_BACKEND_URL=http://127.0.0.1:9/gas \
DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 RESEND_API_KEY= node server.js 2>&1 | tee /tmp/pr-e2e.log
```

Expected from the import:
- 34 PRs and 80 audit rows.
- The server log has no `FATAL`, and has `PR Sheet copy disabled` only if `P2P_SPREADSHEET_ID` is unset.

- [ ] **Step 2: Browser scenario (each line is one PASS/FAIL check in e2e-pr.cjs)**

1. A requester (any active employee) logs in. The list shows only their PRs, and the "Việc của tôi" toggle and the bell badge work.
2. The requester submits a simplified PR for company E.V with a 1 MB PDF. Budget and supplier are both the treasurer, purchasing is `tlc.ap@tl-c.com.vn`.
   - The success banner shows the number.
   - The row's attachment has `fileUrl` on R2, or `error: 'R2 chưa cấu hình'` on the MacBook without R2 keys. The submit still succeeds.
   - `email_queue` has exactly one approval email to the treasurer and one confirmation.
3. Open the deep link from the queued email body (`/purchase_request.html?prNo=…`). The drawer opens.
4. The treasurer logs in and approves once with a signature. The drawer shows budget and supplier approved and `Mua hàng (5/5)`. `email_queue` has `Yêu cầu Mua hàng` to tlc.ap (B2).
5. tlc.ap logs in and sees that PR and the 21 imported `Mua hàng (5/5)` PRs. Approving gives `Hoàn thành`, and the requester gets `Phiếu đã hoàn thành`.
6. Second PR: the treasurer sends it back with step 1. The requester clicks "Chỉnh sửa & Gửi lại" and sends. Expected: success (B1), status `Đang duyệt ngân sách & NCC (2/5)`, and the history shows Submit, Return, Resubmit.
7. Third PR: the treasurer rejects it. The requester gets `Phiếu bị từ chối` (B13).
8. A user who is neither requester nor approver nor admin sees none of these PRs. A direct `getPurchaseRequest` call answers 403.
9. Search for two letters of a purpose. Only visible PRs are merged into the list.
10. `acceptance_minutes.html?prNo=<the Hoàn thành PR>`: the item table is filled (B7). Creating the AM itself is Plan 7 and is not tested here.
11. `sheet_outbox` has one `Purchase_Request_History` upsert per change and one `PR_Audit_Log` append per audit row, all for `test-p2p-sheet`.
12. With `SHEETS_MIRROR=on`, a scratch copy of the spreadsheet as `P2P_SPREADSHEET_ID`, and the mirror key, the submit row lands in columns A–U. `row_type` is in column U only, and the legacy event rows are untouched. Skip this check if the scratch copy is not shared yet (roadmap open item), and say so in the report.
13. `grep -c "127.0.0.1:9" /tmp/pr-e2e.log` prints `0`. The drawer's history uses flow `PR` only.

- [ ] **Step 3: GAS-mode regression**

Restart the server without `PG_WORKFLOWS` and with the real GAS URLs. Rerun the scratch `gas-regress.cjs`. Expected: the same 7 PASS as Plan 4.

Then add three read-only PR checks to it and run them:
- `purchase_request.html` loads the list from GAS.
- A drawer opens with GAS history.
- `?prNo=<live number>` opens the drawer.

Do not submit, approve or reject anything against live GAS.

- [ ] **Step 4: Clean up and tick the roadmap**

Run `psql tlcg_v_test -c "truncate purchase_requests, pr_audit_log, email_queue, sheet_outbox"`.

In `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md`, change item 2 to `2. ✅ **Plan 5: Purchase requests at GAS parity** (\`2026-10-07-purchase-requests-on-postgres.md\`). Done <date>: e2e with every GAS URL dead passed <n>/<n> with zero GAS calls.` Fill in the date and the real count.

```bash
git add docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md
git commit -m "docs: GAS exit roadmap - plan 5 done

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Open items (need the product owner)

1. **Which GAS version is live (spec Q1).** The live sheet got PR event rows on 2026-10-04/05, after repo HEAD stopped writing them, so the deployed script is not HEAD.
   - **How the plan handles it:**
     - Parity targets the live data where repo and data disagree. The importer accepts every row shape in the 2026-10-06 export, and event rows are history only when a PR has no audit rows.
     - Response shapes follow what the pages read. They do not depend on the script version.
     - Task 11 step 3 re-checks GAS mode read-only against the deployed script.
   - **Owner action:** get the deployed version number from the Apps Script project before the switch day.
2. **Send back to step 3 (spec Q5).** The server refuses it with `Bước trả lại không hợp lệ với vai trò của bạn.` (B3), but the page still offers step 3 to the purchasing approver. Does the owner agree to remove that option from the send-back modal? It is a one-line change outside the locked section.
3. **Self-approval.** A requester who is also the treasurer, chief accountant or legal representative may still pick themselves, because the decision only restricts picks to the candidate lists. Should that be refused?
4. **Legacy approver picks.** Live PRs name `nguyennhanh863@gmail.com` (a personal Gmail) and others as contract reviewer. These are not in the company lists, so a resubmit of such a PR must pick again. Master Data may need updating first.
5. **Who uses the PR lists in `contract.html` and `acceptance_minutes.html`.** With the new visibility rule, only the requester, the PR's approvers and admins see a PR there. If someone else creates contracts or acceptance minutes, they need to be named on the PR or made admin. Confirm before Plan 7.
6. **Grand total from the items (S4).** The server ignores the client's total. On the live data both agree on all 32 PRs.
7. **Resubmit keeps the old attachments and adds the new ones.** GAS dropped the old files, because the page never resends them. Confirm.
8. **p2p must be switched on with Plans 6–7, not alone.** Until then:
   - GAS-side contract approval rewrites the PR total in the Sheet copy, not in Postgres.
   - `validatePRForDirectPayment` waits behind the `payments` key; Plan 6 supplies `paymentsForPR`.
   - `getPaymentProgressByPR` is payment-side and belongs to Plan 6.
9. **addSupplier** now writes Master Vendor in Postgres (B14 fixed), which is the list the picker reads. It is not copied to the Sheet, and a re-run of `scripts/import-master-sheets.js` would drop it. There is no caller in any page today.
10. **Switch-day email.** `--notify-purchasing` would email `tlc.ap@tl-c.com.vn` about the 11 simplified PRs stuck at `Mua hàng (5/5)`. Confirm before running it.
11. **Deferred.** DNMH legacy PO import (decision). The 3 audit-only numbers of deleted PRs are kept in the audit log and are visible to admins only.
12. **Sheet copy.** `P2P_SPREADSHEET_ID` must name a scratch copy for the rehearsal, and the production id only on switch day. The mirror account needs Editor access (roadmap open item).
13. **Signature check stays in the browser (S5).** PR approval stores the browser's verification result as GAS did. It does not require `verified === true` the way vouchers do. Should PRs follow the voucher rule?

## Decisions on the open items (controller, 2026-10-07, consistent with the voucher rules)
- **#2:** remove the "step 3" option from the send-back modal. It is outside the locked section, and the server already refuses it.
- **#3:** refuse self-approval. A requester may not be picked for any approver slot on their own PR. This matches the voucher rule that removed self-approval. Message: `Bạn không thể tự phê duyệt đề nghị của chính mình.`
- **#6:** the server computes the grand total from the items.
- **#7:** resubmit keeps the existing attachments and adds the new ones.
- **#13:** follow the voucher rule. The server refuses a PR approval unless the signature check reports `verified === true`, against the approver's registered sample.
- **Deferred to the user:**
  - #1: the deployed GAS version, needed before switch day.
  - #5: who uses PR lists in the contract and acceptance-minutes pages, before Plan 7.
  - #10: emailing Tlc.ap about the stuck PRs, on switch day.
- **Informational only:** #4, #8, #9, #11, #12.
