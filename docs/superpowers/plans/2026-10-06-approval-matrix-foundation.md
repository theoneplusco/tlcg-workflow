# Approval Matrix Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

> **Status 2026-10-06:** Tasks 1–5 done (21 tests; editor verified in Chrome). Extra: live "who will approve" preview (`adminApprovalFlowPreview`).

**Goal:** Admins can define, per company, a versioned approval flow (ordered steps; each step = roles and/or named people, all must approve), and the server can turn that flow into a concrete per-document approval plan and advance it.

**Architecture:** Flows live in Postgres (`approval_flows`, one row per version). A role registry maps role keys (chief_accountant, legal_rep, treasurer, director…) to the Master Company columns that hold the person, so a role resolves to today's person for a company. A pure engine (no I/O) builds a document's plan snapshot and applies approve / reject; workflows (vouchers in Plan 2) call it. An admin page edits flows with a confirmation gate and keeps every version.

**Tech Stack:** Node 24 ESM, Express handlers in `api/handlers`, `pg`, `node:test` (built in, no new deps), Playwright (scratch only) for UI checks.

## Global Constraints

- Admins only: every write goes through `requireAdmin` (api/handlers/admin-employees.js).
- Every admin change needs an explicit confirmation step in the UI (user rule).
- Labels follow the Master Data style; UI copy bilingual-friendly; Vietnamese role names first.
- A flow with no company = the workflow default; a company without its own flow uses the default; with no default at all, vouchers fall back to the built-in chain chief_accountant → legal_rep → treasurer (today's behaviour).
- A step with several approvers requires all of them. Steps run in order.
- Documents keep the plan they were submitted with (snapshot); editing a flow never changes in-flight documents.
- No GAS changes in this plan.

## File Structure

| File | Responsibility |
|---|---|
| `api/lib/approval/roles.js` | Role registry + `resolveRole(roleKey, company, employeesByEmail)` |
| `api/lib/approval/engine.js` | Pure: `buildPlan`, `pendingStep`, `applyApproval`, `applyRejection`, `progress`, `validateSteps` |
| `api/lib/approval/flows-repo.js` | DB: `getActiveFlow`, `listVersions`, `saveVersion`, `loadCompanyContext` |
| `db/migrations/004_approval_flows.sql` | `approval_flows` table |
| `api/handlers/admin-approval.js` | `adminApprovalFlowGet`, `adminApprovalFlowSave` |
| `approval_flows.html` | Editor page |
| `tests/approval/*.test.js` | Unit tests (roles, engine) + repo integration test |

## Data shapes (shared by all tasks)

```js
// A step as stored in approval_flows.steps (and edited in the UI)
{ name: 'Kế toán trưởng duyệt', approvers: [ { type: 'role', role: 'chief_accountant' }, { type: 'person', email: 'x@y.vn' } ] }

// A resolved approver inside a document plan snapshot
{ type: 'role', role: 'chief_accountant', label: 'Kế toán trưởng', email: 'nhanh.nguyen@tl-c.com.vn',
  name: 'Nguyễn Thị Nhanh', status: 'pending' | 'approved', at: null | ISO, signature: '' }

// A document plan snapshot (stored with the document, e.g. vouchers.metadata.approvalPlan)
{ flowId: 12, version: 3, workflow: 'voucher', companyId: 4,
  steps: [ { name, approvers: [ResolvedApprover…], status: 'pending' | 'approved' } ],
  status: 'pending' | 'in_progress' | 'approved' | 'rejected', rejectedBy: null | { email, at, reason } }
```

---

### Task 1: Role registry and resolver

**Files:** Create `api/lib/approval/roles.js`, `tests/approval/roles.test.js`; Modify `package.json` (add `"test": "node --test tests/"`).

**Interfaces:**
- Produces: `ROLES` (key → `{ vi, en, email: header|col, name?: header|col, signature?: col }`), `roleLabel(key, lang)`, `resolveRole(key, company, employeesByEmail) → { email, name, signature } | null`, `companyRoles(company, employeesByEmail) → [{ role, label, email, name }]`.

Role keys and sources (Master Company): `legal_rep` (legal_rep_name/email/sig_url), `chief_accountant` (accountant_*), `treasurer` (treasurer_*), `director` (extra.Email_Director), `financial_manager` (extra Financial_Manager_Name/Email), `chairperson` (Chairperson_*), `general_accountant` (General_Accountant-*), `hr_representative` (Dai_dien_HCNS-*), `authorized_director` (Uy_quyen_GD-*), `bank_approver` (Bank_Appover_*), `bod_1..3` (BOD_n-*). Name falls back to the employee's full_name by email.

- [x] Write tests: resolves chief_accountant from typed columns; director from `extra.Email_Director` with name from employees; empty role → `null`; unknown key → throws.
- [x] Run `npm test` → FAIL (module missing). Implement. Run → PASS. Commit `feat(approval): role registry`.

### Task 2: Pure approval engine

**Files:** Create `api/lib/approval/engine.js`, `tests/approval/engine.test.js`.

**Interfaces:**
- Consumes: `resolveRole` (Task 1).
- Produces:
  - `DEFAULT_STEPS.voucher` = 3 steps chief_accountant → legal_rep → treasurer
  - `validateSteps(steps) → string[]` (errors: no steps, empty step, unknown role, bad email, duplicate approver in a step)
  - `buildPlan({ flow, company, employeesByEmail, workflow }) → { plan, problems }` — problems lists roles with no person
  - `pendingStep(plan) → index | -1`
  - `applyApproval(plan, email, { at, signature }) → { plan, stepDone, finished }` — throws `NOT_YOUR_TURN`, `ALREADY_APPROVED`, `CLOSED`
  - `applyRejection(plan, email, { at, reason }) → plan` — only a pending-step approver may reject
  - `progress(plan) → { done, total, text: 'done/total' }` (counted in steps)

- [x] Tests: sequential order enforced; group step finishes only when **all** approve; same person in two steps approves each in turn; reject closes plan; progress text; problems for empty roles; snapshot unaffected by later company changes (plan is plain data).
- [x] FAIL → implement → PASS → commit `feat(approval): engine`.

### Task 3: Flow storage

**Files:** Create `db/migrations/004_approval_flows.sql`, `api/lib/approval/flows-repo.js`, `tests/approval/flows-repo.test.js` (skips unless `TEST_DATABASE_URL` set).

```sql
CREATE TABLE IF NOT EXISTS approval_flows (
  id SERIAL PRIMARY KEY,
  workflow TEXT NOT NULL,                -- 'voucher' (later: 'purchase_request', 'payment_request', …)
  company_id INT REFERENCES companies(id), -- NULL = default for the workflow
  version INT NOT NULL,
  steps JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_flows_version_uidx ON approval_flows (workflow, COALESCE(company_id, 0), version);
```

**Interfaces:** `getActiveFlow(db, workflow, companyId, at=new Date()) → { id, version, steps, companyId, source: 'company'|'default'|'builtin' }`; `listVersions(db, workflow, companyId)`; `saveVersion(db, { workflow, companyId, steps, effectiveFrom, note, createdBy }) → row` (version = max+1, validates with `validateSteps`); `loadCompanyContext(db, companyId) → { company, employeesByEmail }`.

- [x] Tests: no rows → builtin; default row → default; company row overrides default; future `effective_from` ignored until due; versions increment per (workflow, company).
- [x] FAIL → implement → PASS → commit `feat(approval): flow storage`.

### Task 4: Admin API

**Files:** Create `api/handlers/admin-approval.js`; Modify `api/router.js`.

- `adminApprovalFlowGet { workflow, companyId|null }` → `{ companies:[{id,name,key}], roles: companyRoles(...) for that company (or role list without people for default), employees:[{email,name,position}], active, versions }`
- `adminApprovalFlowSave { workflow, companyId|null, steps, effectiveFrom?, note }` → validates (`validateSteps` + person emails must be active employees) → `saveVersion` → `{ version, problems }`

- [x] Handler tests via direct calls against a test DB (non-admin → 403; invalid steps → message; save → version 1 then 2).
- [x] Commit `feat(approval): admin API`.

### Task 5: Approval Flows editor page

**Files:** Create `approval_flows.html`; Modify `admin.html` (header link), `index.html` (Admin page card), `i18n.js`.

Behaviour: company picker (Default + each company), workflow picker (Voucher; others disabled "coming soon"); vertical step cards joined by arrows; approver chips read "Kế toán trưởng (Nguyễn Thị Nhanh)" or the person's name; "+ Approver" popover with two tabs (Role — shows today's person per role, empty roles flagged; Person — search employees); step rename; ↑ ↓ reorder; delete step; "+ Step"; a step with 2+ approvers shows "All must approve"; warnings for roles with no person in this company; **Save** opens a review dialog (current vs new, effective date, note) → Confirm; version history list.

- [x] Playwright scratch test: load, add step, add role + person, reorder, save → version appears; reload shows it; non-admin blocked.
- [x] Commit `feat(approval): flows editor`.
