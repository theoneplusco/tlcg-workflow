# TLCG Workflow — Migration Plan: GAS + Sheets → Postgres + R2

> **Goal:** Replace Google Apps Script + Google Sheets with Postgres + Cloudflare R2,
> hosted on a Mac Mini (M1 Pro, 8-core, 16 GB RAM) behind a Cloudflare Tunnel,
> supporting 100 concurrent users with fast (<50ms) approval responses.
>
> **Server:** "theoneplus" — Mac Mini, always-on, local Postgres + local Redis.
> **Migration:** Parallel — the current Ubuntu server keeps running while the
> Mac Mini is set up. Cutover when Phase 3 (Vouchers) is verified.
>
> **Principle:** The 12 HTML pages never change. The `action`-based API contract
> stays the same. Only the backend behind the proxy moves. One domain at a time.

---

## Target Architecture

```
                          Cloudflare
                              │
                    Cloudflare Tunnel (cloudflared)
                     zero open ports, zero-trust
                              │
                          Mac Mini (M1 Pro, 8-core, 16 GB)
                          ┌───────────────────────────┐
                          │  PM2 Cluster (8 workers)    │
                          │  Express + pg pool + Redis   │
                          │  Rate limiter: Redis          │
                          │  Email: queue → worker        │
                          │  Signature: worker_threads   │
                          │  SSE: Redis pub/sub          │
                          ├──────────────────────────────┤
                          │  Postgres (local, homebrew)   │
                          │  ├── employees                │
                          │  ├── companies                │
                          │  ├── goods_catalog            │
                          │  ├── vouchers + history        │
                          │  ├── purchase_requests        │
                          │  ├── audit logs (append-only) │
                          │  ├── cash_counts              │
                          │  ├── email_queue              │
                          │  └── pr_number_sequences      │
                          │                               │
                          │  Redis (local, homebrew)       │
                          │  ├── rate limiter              │
                          │  ├── SSE pub/sub               │
                          │  └── master data cache         │
                          └──────────────────────────────┘
                              Cloudflare R2          Resend (email)
                              (attachments)         (background)
```

### Why a Mac Mini as the server

| Factor | Benefit |
|---|---|
| **8-core M1 Pro** | 8 PM2 workers = 8 parallel event loops — no need for a bigger server |
| **16 GB RAM** | Postgres + Redis + Node all in memory; ~4 GB for Postgres shared buffers, ~2 GB for Redis, ~2 GB for Node pool — plenty of headroom |
| **Local Postgres** | Zero network latency — queries return in <1ms instead of 10-20ms to Neon |
| **Local Redis** | Rate limiter + SSE + cache with <0.5ms latency |
| **Cloudflare Tunnel** | No open ports on the router; zero-trust; `cloudflared` daemon on the Mini connects outbound to Cloudflare |
| **Always-on** | `pmset -a sleep 0` prevents system sleep; display sleep OK |
| **Home network** | SSD storage (fast I/O), no cloud egress costs, no per-connection limits |

### Why each piece

| Piece | Why | 100-user impact |
|---|---|---|
| **PM2 cluster (8 workers)** | M1 Pro has 8 cores — 8 parallel Node event loops | 100 concurrent requests → ~12 per worker |
| **Local Postgres pool (20-40 conns)** | All queries hit localhost — <1ms latency | 100 concurrent queries → 40 wait briefly (~10ms) |
| **Local Redis** | Rate limiter + SSE pub/sub + master data cache — all localhost | <0.5ms per Redis call — negligible overhead |
| **Email queue** | `GmailApp.sendEmail()` is synchronous (1-6s); approver waits | Approver sees result in <50ms; email sends in background |
| **R2 presigned PUT** | Server never touches file bytes; no bandwidth bottleneck | 100 users upload 10MB simultaneously — Mac Mini unaffected |
| **SSE (Server-Sent Events)** | Approver 2 sees Approver 1's action without refresh | Real-time bell badge + list updates, pushed via Redis pub/sub |
| **Worker threads (signature)** | `compareSignatures` is CPU-bound (50-200ms) | Doesn't block event loop; other requests continue |
| **lru-cache (master data)** | Employees/companies/goods change monthly, queried on every page load | First request hits DB, next 99 get instant response |
| **Postgres SEQUENCE** | PR number allocation is atomic, no scan-and-increment | 100 concurrent submits — no collisions |
| **SELECT FOR UPDATE** | Row-level locking on approval; prevents duplicate approvals | Eliminates the `Set`-based dedup workaround |

---

## Phase 0 — Mac Mini Setup + Infrastructure (2-3 days)

> **The Mac Mini ("theoneplus") runs in parallel with the current Ubuntu server
> during migration.** The Ubuntu server stays live until Phase 3 (Vouchers) is
> verified on the Mini. Then Cloudflare switches the tunnel to the Mini.

### 0.0 Mac Mini provisioning

```bash
# ── Prevent system sleep (always-on server) ──────────────────
sudo pmset -a sleep 0 disksleep 0
# Display sleep is OK; system must never sleep

# ── Install dependencies via Homebrew ─────────────────────────
brew install postgresql@16 redis node pm2
brew services start postgresql@16
brew services start redis

# ── Create database ───────────────────────────────────────────
createdb tlcg_workflow

# ── Cloudflare Tunnel (zero open ports) ───────────────────────
brew install cloudflared
cloudflared tunnel login                    # browser auth
cloudflared tunnel create theoneplus
# Route: workflow.tl-c.us → http://localhost:3001
cloudflared tunnel route dns theoneplus workflow.tl-c.us

# ── systemd-equivalent on macOS: launchd plist for cloudflared ─
# brew services start cloudflared  (or create a launchd plist)
# This runs cloudflared as a daemon, connecting outbound to Cloudflare.
# No ports opened on the router. Zero-trust.
```

### 0.1 Postgres schema (local, `tlcg_workflow` database)

```sql
-- ── Master data ──────────────────────────────────────────────

CREATE TABLE employees (
  id            SERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  position      TEXT DEFAULT '',
  department    TEXT DEFAULT '',
  company       TEXT DEFAULT '',
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT DEFAULT '',
  status        TEXT DEFAULT 'active',   -- 'active' | 'inactive'
  employee_id   TEXT DEFAULT '',
  role           TEXT DEFAULT '',          -- 'accountant' | 'legalRep' | 'treasurer' | 'admin' | ...
  is_admin      BOOLEAN DEFAULT FALSE,
  password_hash TEXT DEFAULT '',            -- bcrypt
  cached_signature TEXT,                    -- last uploaded signature (base64) for pre-fill
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE companies (
  id              SERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  company_code    TEXT DEFAULT '',
  company_key     TEXT DEFAULT '',           -- tax_id or unique key
  -- 3 approvers (sequential for vouchers, assigned for PRs)
  legal_rep_name     TEXT DEFAULT '',
  legal_rep_email    TEXT DEFAULT '',
  legal_rep_sig_url  TEXT DEFAULT '',
  accountant_name    TEXT DEFAULT '',
  accountant_email   TEXT DEFAULT '',
  accountant_sig_url TEXT DEFAULT '',
  treasurer_name     TEXT DEFAULT '',
  treasurer_email    TEXT DEFAULT '',
  treasurer_sig_url  TEXT DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE goods_catalog (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT DEFAULT '',
  moq         NUMERIC DEFAULT 1,
  unit        TEXT DEFAULT 'Cái',
  unit_price  NUMERIC DEFAULT 0,
  spec        TEXT DEFAULT '',              -- sheet typo 'Specificaton' → 'spec'
  qbo_code    TEXT DEFAULT '',               -- 'CUKCUK/QBO Code'
  status      TEXT DEFAULT 'active',         -- 'active' | 'inactive'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Vouchers (Phiếu Thu/Chi) ─────────────────────────────────

CREATE TABLE vouchers (
  id              SERIAL PRIMARY KEY,
  voucher_number  TEXT NOT NULL UNIQUE,
  voucher_type     TEXT NOT NULL,             -- 'Phiếu Thu' | 'Phiếu Chi'
  company_id       INT REFERENCES companies(id),
  company_name     TEXT DEFAULT '',
  company_key      TEXT DEFAULT '',
  employee_name    TEXT DEFAULT '',
  requestor_email  TEXT DEFAULT '',
  submitted_by     TEXT DEFAULT '',
  amount           NUMERIC DEFAULT 0,
  status           TEXT DEFAULT 'Chờ duyệt',  -- Vietnamese status values
  due_date         TEXT DEFAULT '',
  description      TEXT DEFAULT '',           -- purpose/reason
  attachments      TEXT DEFAULT '',           -- comma-separated R2 URLs
  metadata         JSONB DEFAULT '{}',       -- replaces col R MetaJSON
  -- Approval state (replaces companyApprovers in meta)
  current_approver   TEXT DEFAULT 'accountant',
  approval_progress  TEXT DEFAULT '0/3',       -- '0/3', '1/3', '2/3', '3/3'
  overall_status     TEXT DEFAULT 'pending',   -- 'pending' | 'partially' | 'approved' | 'rejected' | 'received'
  acknowledged_sig   TEXT,
  acknowledged_at    TIMESTAMPTZ,
  acknowledged_by    TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE voucher_history (
  id              SERIAL PRIMARY KEY,
  voucher_number  TEXT NOT NULL,
  voucher_type    TEXT DEFAULT '',
  company         TEXT DEFAULT '',
  company_key     TEXT DEFAULT '',
  employee        TEXT DEFAULT '',
  requestor_email TEXT DEFAULT '',
  submitted_by    TEXT DEFAULT '',
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  amount          NUMERIC DEFAULT 0,
  status          TEXT DEFAULT '',
  due_date        TEXT DEFAULT '',
  action          TEXT DEFAULT '',           -- 'Submit' | 'Duyệt bởi X' | 'Fully Approved' | etc.
  attachments     TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  approver_email  TEXT DEFAULT '',
  approved_at     TIMESTAMPTZ,
  metadata         JSONB DEFAULT '{}'
);

CREATE TABLE voucher_audit_log (
  id          SERIAL PRIMARY KEY,
  doc_no      TEXT NOT NULL,
  flow        TEXT NOT NULL DEFAULT 'VCH',   -- 'VCH' for voucher
  company     TEXT DEFAULT '',
  action      TEXT NOT NULL,                  -- 'Submit' | 'Approve' | 'Reject' | 'Acknowledge'
  role        TEXT DEFAULT '',                 -- 'accountant' | 'legalRep' | 'treasurer' | 'requester'
  actor_email TEXT DEFAULT '',
  actor_name  TEXT DEFAULT '',
  prev_status TEXT DEFAULT '',
  new_status  TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  extra       JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
-- Append-only: no UPDATE, no DELETE (enforce via RLS or triggers)

-- ── Purchase Requests ───────────────────────────────────────

CREATE TABLE purchase_requests (
  id                SERIAL PRIMARY KEY,
  pr_no             TEXT NOT NULL UNIQUE,
  company_id        INT REFERENCES companies(id),
  company_name      TEXT DEFAULT '',
  company_key       TEXT DEFAULT '',
  department        TEXT DEFAULT '',
  requester_name    TEXT DEFAULT '',
  requester_email   TEXT DEFAULT '',
  required_date     TEXT DEFAULT '',
  priority          TEXT DEFAULT 'Bình Thường',
  purpose           TEXT DEFAULT '',
  vendor_name       TEXT DEFAULT '',
  budget_code       TEXT DEFAULT '',
  budget_approver_email    TEXT DEFAULT '',
  supplier_approver_email  TEXT DEFAULT '',
  contract_approver_email TEXT DEFAULT '',     -- only on full branch
  purchasing_approver_email TEXT DEFAULT '',
  items             JSONB DEFAULT '[]',       -- [{section, loai, desc, qty, unit, price, total, note}]
  grand_total       NUMERIC DEFAULT 0,
  currency          TEXT DEFAULT 'VND',
  status            TEXT DEFAULT 'Đang duyệt ngân sách & NCC (2/5)',
  p2p_branch        TEXT DEFAULT 'full',       -- 'full' | 'simplified'
  purchase_type      TEXT DEFAULT 'goods',     -- 'goods' | 'services'
  attachments        JSONB DEFAULT '[]',       -- [{fileName, fileUrl}]
  metadata           JSONB DEFAULT '{}',       -- per-role statuses, signatures, vendor details
  submitted_at      TIMESTAMPTZ DEFAULT NOW(),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  archived_at       TIMESTAMPTZ               -- set when moved to archive (90 days idle)
);

CREATE TABLE pr_audit_log (
  id          SERIAL PRIMARY KEY,
  doc_no      TEXT NOT NULL,
  flow        TEXT NOT NULL DEFAULT 'PR',
  company     TEXT DEFAULT '',
  action      TEXT NOT NULL,
  role        TEXT DEFAULT '',
  actor_email TEXT DEFAULT '',
  actor_name  TEXT DEFAULT '',
  prev_status TEXT DEFAULT '',
  new_status  TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  extra       JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── PR number sequences (one per company per day) ───────────

CREATE TABLE pr_number_sequences (
  id            SERIAL PRIMARY KEY,
  company_code  TEXT NOT NULL,
  date_str      TEXT NOT NULL,               -- 'YYYYMMDD'
  next_counter  INT DEFAULT 1,
  UNIQUE(company_code, date_str)
);

-- ── Email queue (decoupled from approval response) ──────────

CREATE TABLE email_queue (
  id          SERIAL PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_html   TEXT DEFAULT '',
  body_text   TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',         -- 'pending' | 'sent' | 'failed'
  attempts    INT DEFAULT 0,
  error       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

-- ── Cash counts (Bảng kiểm kê quỹ) ──────────────────────────

CREATE TABLE cash_counts (
  id              SERIAL PRIMARY KEY,
  company_key     TEXT DEFAULT '',
  company_name    TEXT DEFAULT '',
  end_date        TEXT DEFAULT '',
  count_hour      INT,
  count_minute    INT,
  quantities      JSONB DEFAULT '{}',
  book_balance    NUMERIC DEFAULT 0,
  counted_total   NUMERIC DEFAULT 0,
  reason_thua     TEXT DEFAULT '',
  reason_thieu    TEXT DEFAULT '',
  conclusion      TEXT DEFAULT '',
  reps            JSONB DEFAULT '[]',         -- [{key, label, name, signature}]
  saved_by_email  TEXT DEFAULT '',
  saved_at        TIMESTAMPTZ DEFAULT NOW(),
  row_status      TEXT DEFAULT 'pending'      -- 'pending' | 'signed'
);
```

### 0.2 Required indexes

```sql
-- Vouchers
CREATE INDEX idx_vouchers_number     ON vouchers(voucher_number);
CREATE INDEX idx_vouchers_company    ON vouchers(company_id, status);
CREATE INDEX idx_vouchers_active     ON vouchers(status) WHERE status NOT IN ('Đã duyệt', 'Đã từ chối');
CREATE INDEX idx_vouchers_updated    ON vouchers(updated_at DESC);

-- Voucher history (for reconstruction)
CREATE INDEX idx_vhist_number       ON voucher_history(voucher_number);
CREATE INDEX idx_vhist_approver     ON voucher_history(approver_email);
CREATE INDEX idx_vhist_submitted    ON voucher_history(submitted_at DESC);

-- Purchase requests
CREATE INDEX idx_pr_no              ON purchase_requests(pr_no);
CREATE INDEX idx_pr_company_status ON purchase_requests(company_id, status);
CREATE INDEX idx_pr_active          ON purchase_requests(status) WHERE status NOT IN ('Hoàn thành', 'Đã từ chối');
CREATE INDEX idx_pr_submitted      ON purchase_requests(submitted_at DESC);
CREATE INDEX idx_pr_approver_email ON purchase_requests USING GIN (
  (metadata->'budgetApproverEmail', metadata->'supplierApproverEmail',
   metadata->'contractApproverEmail', metadata->'purchasingApproverEmail')
);

-- Audit logs
CREATE INDEX idx_audit_doc_no      ON voucher_audit_log(doc_no);
CREATE INDEX idx_audit_pr_doc      ON pr_audit_log(doc_no);
CREATE INDEX idx_audit_created     ON pr_audit_log(created_at DESC);

-- Email queue
CREATE INDEX idx_email_queue_pending ON email_queue(status) WHERE status = 'pending';

-- Employees
CREATE INDEX idx_employees_status ON employees(status) WHERE status = 'active';
CREATE INDEX idx_employees_email   ON employees(email);
```

### 0.3 PM2 cluster + Redis (Mac Mini)

```javascript
// ecosystem.config.js (PM2 — on the Mac Mini)
module.exports = {
  apps: [{
    name: 'tlcg-workflow',
    script: 'server.js',
    instances: 8,              // M1 Pro has 8 cores
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      // Local services — localhost, no network latency
      DATABASE_URL: 'postgres://localhost:5432/tlcg_workflow',
      REDIS_URL: 'redis://localhost:6379',
      // R2 + Resend (cloud, accessed from the Mini)
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME: 'tlcg-attachments',
      R2_PUBLIC_URL: 'https://attachments.tl-c.us',
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      // Keep GAS URLs during migration (parallel mode)
      TLCG_CASH_BACKEND_URL: process.env.TLCG_CASH_BACKEND_URL,
      TLCG_P2P_BACKEND_URL: process.env.TLCG_P2P_BACKEND_URL,
      TLCG_CORE_BACKEND_URL: process.env.TLCG_CORE_BACKEND_URL,
    }
  }]
};
```

### 0.4 Environment variables (`.env` on the Mac Mini)

```bash
# ── Local Postgres (homebrew, localhost) ──────────────────────
DATABASE_URL=postgres://localhost:5432/tlcg_workflow

# ── Local Redis (homebrew, localhost) ────────────────────────
REDIS_URL=redis://localhost:6379

# ── Cloudflare R2 (cloud, accessed from the Mini) ───────────
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=tlcg-attachments
R2_PUBLIC_URL=https://attachments.tl-c.us

# ── Resend (email, cloud) ────────────────────────────────────
RESEND_API_KEY=re_...
EMAIL_FROM=TLC Group Workflow <noreply@tl-c.us>

# ── JWT (auth) ───────────────────────────────────────────────
JWT_SECRET=<random 64-char hex>

# ── Cloudflare Tunnel ────────────────────────────────────────
# No env var needed — cloudflared runs as a daemon, routes
# workflow.tl-c.us → http://localhost:3001

# ── Keep during migration (parallel with Ubuntu) ────────────
# These are removed in Phase 5 after the Ubuntu server is retired.
TLCG_CASH_BACKEND_URL=<current GAS Cash URL>
TLCG_P2P_BACKEND_URL=<current GAS P2P URL>
TLCG_CORE_BACKEND_URL=<current GAS Core URL>

# ── Web Push (optional, Phase 5+) ────────────────────────────
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

### 0.5 Parallel migration strategy

```
During Phase 0-2: both servers live
  ┌─────────────────────────────────────────────────────┐
  │  Cloudflare DNS: workflow.tl-c.us                   │
  │  ┌────────────────────────────────────────┐         │
  │  │  Ubuntu server (current production)     │         │
  │  │  Express → GAS (all actions)           │         │
  │  └────────────────────────────────────────┘         │
  │                                                      │
  │  Mac Mini (theoneplus, staging)                      │
  │  ┌────────────────────────────────────────┐         │
  │  │  Express → Postgres (new actions only)  │         │
  │  │  + Redis + R2                           │         │
  │  └────────────────────────────────────────┘         │
  │  Accessed via: mini.tl-c.us (staging tunnel)        │
  └─────────────────────────────────────────────────────┘

Phase 3 cutover:
  Cloudflare DNS switches workflow.tl-c.us → Mac Mini tunnel
  Ubuntu server stays warm as backup for 1 week, then retired.
```

---

## Phase 1 — Auth + Master Data (2-3 days)

**Migrate:** `getMasterData`, `getEmployees`, `getCompanyApprovers`, `login`, `changePassword`
**From:** `TLCG_CORE_BACKEND.gs`
**Switch:** Proxy routes these actions to new Express handlers; everything else still goes to GAS.

### 1.1 Express handlers

```javascript
// api/handlers/master-data.js
import pg from 'pg';
import LRU from 'lru-cache';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                     // pool size per PM2 worker
  idleTimeoutMillis: 30000,
});

// Server-side cache: 5-min TTL (employees/companies/goods change rarely)
const cache = new LRU({ max: 100, ttl: 300_000 });

export async function handleGetMasterData(req, res) {
  const cacheKey = 'master_data';
  let data = cache.get(cacheKey);
  if (!data) {
    const [employees, companies, goods] = await Promise.all([
      pool.query("SELECT * FROM employees WHERE status = 'active'"),
      pool.query("SELECT * FROM companies"),
      pool.query("SELECT * FROM goods_catalog WHERE status = 'active'"),
    ]);
    data = {
      employees: employees.rows,
      companies: companies.rows,
      goods: goods.rows,
    };
    cache.set(cacheKey, data);
  }
  res.json({ success: true, data });
}

// api/handlers/auth.js
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export async function handleLogin(req, res) {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM employees WHERE email = $1 AND status = $2', [email, 'active']);
  const user = result.rows[0];
  if (!user || !user.password_hash) {
    return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không đúng' });
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ success: false, message: 'Email hoặc mật khẩu không đúng' });
  }
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ success: true, data: { token, user: { ...user, password_hash: undefined } } });
}
```

### 1.2 Data migration script (one-time)

```javascript
// scripts/migrate-master-data.js
// Reads from Google Sheets via googleapis (already in package.json)
// Writes to Postgres
// Run once: node scripts/migrate-master-data.js
```

### 1.3 Proxy routing update

```javascript
// api/voucher.js — add routing switch
const NEW_ACTIONS = ['getMasterData', 'getEmployees', 'login', 'changePassword'];

export default async function handler(req, res) {
  const action = req.body?.action || req.query?.action;
  
  if (NEW_ACTIONS.includes(action)) {
    // Route to new Express handlers
    return newHandlers[action](req, res);
  }
  
  // Everything else still goes to GAS
  return gasProxy(req, res);
}
```

### 1.4 Verification

- [ ] Frontend populates employees, companies, goods identically
- [ ] Login works with same credentials
- [ ] `tlc_master_data` localStorage cache still works (same response shape)
- [ ] 100 concurrent `getMasterData` → first hits DB, rest get cache (verify with `console.time`)

---

## Phase 2 — Cash Book (2-3 days)

**Migrate:** `getCashBook`, `getCashCount`, `getCashBookSummary`, `getRecentCashCounts`, `saveCashCount`, `signCashCount`
**From:** `TLCG_CASH_BOOK.gs`
**Switch:** Proxy routes cash book actions to new Express handlers.

### 2.1 Key logic to preserve (from §1 of business logic reference)

- 3 roles: `nguoiChiuTrachNhiem`, `keToanTruong`, `thuQuy`
- `cashBookBucket_`: maps status → 'book' | 'pending' | 'out'
- `cashBookAmount_`: parses Vietnamese number format (`1.234,56`)
- `cashBookYmd_`: date normalization (ISO + DMY)
- Company matching: by key first, then by name (case-insensitive)
- Save: insert row, return id
- Sign: update `row_status = 'signed'`, store signatures in `reps` JSONB

### 2.2 Verification

- [ ] Cash count form saves correctly
- [ ] 3-role signing works
- [ ] Summary counts match

---

## Phase 3 — Vouchers (5-7 days)

**Migrate:** `sendApprovalEmail` (submit), `approveVoucher`, `bulkApprove`, `rejectVoucher`, `acknowledgeReceipt`, `getVoucherSummary`, `getVoucherFromHistory`
**From:** `TLCG_CASH_BACKEND.gs`
**Switch:** Proxy routes voucher actions to new Express handlers. **File uploads move to R2.**

### 3.1 Approval handler — the core (with all fixes)

```javascript
// api/handlers/voucher-approve.js
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });

export async function handleApproveVoucher(req, res) {
  const { voucherNumber, approverEmail, signatureData } = req.body;
  const client = await pool.connect();
  
  try {
    // ── 1. Row-level lock (prevents concurrent approval race) ──
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT * FROM vouchers WHERE voucher_number = $1 FOR UPDATE',
      [voucherNumber]
    );
    const voucher = rows[0];
    if (!voucher) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Không tìm thấy phiếu: ' + voucherNumber });
    }

    const meta = voucher.metadata || {};
    const companyApprovers = meta.companyApprovers;
    if (!companyApprovers?.approvers) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Phiếu không có thông tin phê duyệt.' });
    }

    // ── 2. Resolve role per-voucher ──
    const approverRole = resolveApproverRoleForVoucher(companyApprovers, approverEmail);
    if (!approverRole) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Email ${approverEmail} không phải người phê duyệt.` });
    }

    // ── 3. Guards (same as GAS, now enforced by DB) ──
    if (companyApprovers.approvers[approverRole].status === 'approved') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Bạn đã phê duyệt phiếu này rồi.' });
    }
    if (companyApprovers.overallStatus === 'Rejected') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Phiếu đã bị từ chối.' });
    }
    const expectedRole = companyApprovers.currentApprover || 'accountant';
    if (approverRole !== expectedRole) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Chưa đến lượt phê duyệt. Đang chờ: ' + expectedRole });
    }

    // ── 4. Signature verification (worker thread — doesn't block event loop) ──
    if (signatureData?.approverSignature) {
      const verification = await verifySignatureWorker(signatureData.approverSignature, approverRole, companyApprovers);
      if (!verification.verified) {
        await client.query('ROLLBACK');
        return res.json({ success: false, message: `Chữ ký không hợp lệ. ${verification.reason}` });
      }
      meta.signatureVerification = meta.signatureVerification || {};
      meta.signatureVerification[approverRole] = { ...verification, verifiedAt: new Date().toISOString() };
    }

    // ── 5. Update approval state ──
    const now = new Date().toISOString();
    companyApprovers.approvers[approverRole].status = 'approved';
    companyApprovers.approvers[approverRole].signature = signatureData?.approverSignature || '';
    companyApprovers.approvers[approverRole].approvedAt = now;

    const approvalCount = Object.values(companyApprovers.approvers).filter(a => a.status === 'approved').length;
    companyApprovers.approvalProgress = `${approvalCount}/3`;

    const isFinal = approvalCount === 3;
    if (isFinal) {
      companyApprovers.overallStatus = 'Approved';
      companyApprovers.displayStatus = 'Đã duyệt';
      companyApprovers.currentApprover = null;
      companyApprovers.fullyApprovedAt = now;
    } else {
      const sequence = ['accountant', 'legalRep', 'treasurer'];
      companyApprovers.currentApprover = sequence[sequence.indexOf(approverRole) + 1];
      companyApprovers.overallStatus = 'Partially Approved';
      companyApprovers.displayStatus = `Đang duyệt (${approvalCount}/3)`;
    }

    meta.companyApprovers = companyApprovers;

    // ── 6. Update voucher row ──
    await client.query(
      `UPDATE vouchers SET metadata = $1, status = $2, approval_progress = $3,
       overall_status = $4, current_approver = $5, updated_at = NOW()
       WHERE voucher_number = $6`,
      [JSON.stringify(meta), companyApprovers.displayStatus, companyApprovers.approvalProgress,
       companyApprovers.overallStatus, companyApprovers.currentApprover, voucherNumber]
    );

    // ── 7. Append history row ──
    await client.query(
      `INSERT INTO voucher_history (voucher_number, status, action, approver_email, approved_at, metadata)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [voucherNumber, companyApprovers.displayStatus, `Duyệt bởi ${approverRole}`,
       approverEmail, JSON.stringify(meta)]
    );

    // ── 8. Append audit log (append-only, never breaks main flow) ──
    try {
      await client.query(
        `INSERT INTO voucher_audit_log (doc_no, flow, action, role, actor_email, prev_status, new_status, extra)
         VALUES ($1, 'VCH', 'Approve', $2, $3, $4, $5, $6)`,
        [voucherNumber, approverRole, approverEmail, voucher.status, companyApprovers.displayStatus,
         JSON.stringify({ signatureUploaded: !!signatureData?.approverSignature })]
      );
    } catch (auditErr) {
      console.error('[Audit] failed (non-fatal):', auditErr.message);
    }

    await client.query('COMMIT');

    // ── 9. Queue emails (DO NOT wait for email to send) ──
    await queueApprovalEmails(voucherNumber, approverRole, isFinal, approverEmail);

    // ── 10. Publish SSE event (real-time update for other approvers) ──
    await publishEvent('voucher:updated', { voucherNumber, status: companyApprovers.displayStatus, approverRole });

    // ── 11. Return immediately — approver sees result in <50ms ──
    return res.json({
      success: true,
      message: 'Đã duyệt thành công.',
      data: { voucherNumber, status: companyApprovers.displayStatus, isFinal }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Voucher] approve error:', err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}
```

### 3.2 Email queue (decoupled from approval)

```javascript
// api/handlers/email-queue.js
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

export async function queueApprovalEmails(voucherNumber, approverRole, isFinal, approverEmail) {
  // Insert into email_queue table — the background worker picks these up
  const emails = [];
  
  if (isFinal) {
    emails.push({
      to_email: approverEmail,  // or requester email for completion
      subject: `[PHIẾU THU/CHI] Phiếu đã hoàn thành - ${voucherNumber}`,
      body_html: buildCompletionEmailHtml(voucherNumber),
    });
  } else {
    // Notify next approver
    // ... build email for next in sequence
  }
  
  for (const email of emails) {
    await pool.query(
      'INSERT INTO email_queue (to_email, subject, body_html, status) VALUES ($1, $2, $3, $4)',
      [email.to_email, email.subject, email.body_html, 'pending']
    );
  }
}

// Background worker (separate PM2 process or setInterval in each worker)
// Processes email_queue every 5 seconds
setInterval(async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `UPDATE email_queue SET status = 'sending', attempts = attempts + 1
       WHERE id IN (SELECT id FROM email_queue WHERE status = 'pending' LIMIT 10 FOR UPDATE SKIP LOCKED)
       RETURNING *`
    );
    for (const email of rows) {
      try {
        await resend.sendEmail(email);
        await client.query('UPDATE email_queue SET status = $1, sent_at = NOW() WHERE id = $2', ['sent', email.id]);
      } catch (err) {
        await client.query('UPDATE email_queue SET status = $1, error = $2 WHERE id = $3', ['pending', err.message, email.id]);
      }
    }
  } finally {
    client.release();
  }
}, 5000);
```

### 3.3 SSE — real-time updates

```javascript
// api/handlers/sse.js
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

export async function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const subscriber = redis.duplicate();
  await subscriber.subscribe('tlcg:events');

  subscriber.on('message', (channel, message) => {
    res.write(`data: ${message}\n\n`);
  });

  // Send heartbeat every 30s
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.quit();
  });
}

// Called from approval handlers:
export async function publishEvent(type, data) {
  await redis.publish('tlcg:events', JSON.stringify({ type, data, timestamp: Date.now() }));
}
```

### 3.4 R2 presigned upload (replaces /api/voucher-file)

```javascript
// api/handlers/presign.js
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws/s3-request-presigner';

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

export async function handlePresign(req, res) {
  const { fileName, mimeType, voucherNumber } = req.body;
  const key = `vouchers/${voucherNumber}/${Date.now()}-${fileName}`;
  
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: mimeType,
  });
  
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
  
  res.json({ success: true, data: { uploadUrl, fileUrl, key } });
}
```

**Frontend change (minimal — just the upload function):**
```javascript
// In voucher.html / purchase_request.html
async function uploadToR2(file, voucherNumber) {
  // 1. Get presigned URL from server (1ms)
  const res = await fetch('/api/presign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, voucherNumber }),
  });
  const { data } = await res.json();
  
  // 2. Upload directly to R2 (server never touches the bytes)
  await fetch(data.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  
  // 3. Return the public URL for storage in the voucher
  return { fileName: file.name, fileUrl: data.fileUrl };
}
```

### 3.5 Voucher summary (indexed query, not 5000-row scan)

```javascript
export async function handleGetVoucherSummary(req, res) {
  // Active vouchers only (partial index — fast)
  const { rows } = await pool.query(`
    SELECT voucher_number, voucher_type, company_name, employee_name, amount,
           status, approval_progress, created_at, updated_at,
           metadata->'companyApprovers'->'approvalProgress' as meta_progress
    FROM vouchers
    WHERE status NOT IN ('Đã duyệt', 'Đã từ chối')
    ORDER BY updated_at DESC
    LIMIT 500
  `);
  
  // No Set-based dedup needed — unique constraint prevents duplicates
  const summary = rows.map(v => ({
    voucherNumber: v.voucher_number,
    voucherType: v.voucher_type,
    company: v.company_name,
    employee: v.employee_name,
    amount: v.amount,
    status: v.status,
    approvalProgress: v.approval_progress || v.meta_progress || '0/3',
    meta: { companyApprovers: { approvalProgress: v.approval_progress || '0/3' } },
  }));
  
  res.json({ success: true, data: { vouchers: summary } });
}
```

### 3.6 Signature verification in worker thread

```javascript
// api/workers/signature-compare.js
import { Worker } from 'worker_threads';
import path from 'path';

export function verifySignatureWorker(uploadedSig, approverRole, companyApprovers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(import.meta.dirname, 'signature-compare-worker.js'), {
      workerData: { uploadedSig, approverRole, companyApprovers },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error('Signature worker stopped'));
    });
  });
}

// signature-compare-worker.js — runs off the main event loop
// Returns { verified: boolean, similarity: number, reason: string }
// If no_sample (purchasing approver): { verified: true, similarity: 0, reason: 'no_sample' }
```

### 3.7 One-click approve with cached signature

**Frontend change (small — just the approve modal):**

```javascript
// In voucher.html — pre-fill signature from last approval
async function openApproveModal(voucherNumber) {
  // Check if user has a cached signature (from their last approval or profile)
  const cachedSig = localStorage.getItem('tlc_cached_signature');
  const sigCheckbox = document.getElementById('use-cached-signature');
  
  if (cachedSig) {
    sigCheckbox.checked = true;
    sigCheckbox.parentElement.style.display = 'block';
    // Show "Use my saved signature" — one click to approve
  }
  
  // If no cached signature, show upload field
  // On successful approve, save signature to localStorage + user profile (DB)
}

// One-click approve flow:
// 1. Bell dropdown → click voucher → modal opens
// 2. Signature pre-filled (or checkbox "Save my signature" on first use)
// 3. Click "Duyệt" → done (<50ms response)
```

### 3.8 Verification checklist

- [ ] Submit voucher → 3-tier approval → acknowledge (full flow)
- [ ] Concurrent approvals on same voucher → `SELECT FOR UPDATE` prevents duplicates
- [ ] Email sends after approval (not during) — approver sees result in <50ms
- [ ] SSE: approver 2 sees approver 1's action without refresh
- [ ] File upload: client → R2 directly (server never touches bytes)
- [ ] Voucher summary: indexed query (not 5000-row scan)
- [ ] Signature: worker thread doesn't block event loop
- [ ] One-click approve with cached signature
- [ ] All Vietnamese status strings preserved in DB

---

## Phase 4 — P2P (7-10 days)

**Migrate:** `handlePurchaseRequest`, `handleApprovePurchaseRequest`, `handleRejectPurchaseRequest`, `handleSendBackPurchaseRequest`, `handleGetPurchaseRequestHistory`, `handleGetPurchaseRequest`, `searchPurchaseRequests`
**From:** `TLCG_P2P_BACKEND.gs`
**Switch:** Proxy routes PR actions to new Express handlers.

### 4.1 `computePRApprovalState_` — pure function (same logic, JS not GAS)

```javascript
// api/lib/pr-approval-state.js
export function computePRApprovalState(pr, metadata) {
  const budgetEmail     = (pr.budget_approver_email || '').toLowerCase().trim();
  const supplierEmail   = (pr.supplier_approver_email || '').toLowerCase().trim();
  const contractEmail   = (pr.contract_approver_email || '').toLowerCase().trim();
  const purchasingEmail = (pr.purchasing_approver_email || '').toLowerCase().trim();

  const budgetDone    = !budgetEmail    || metadata.budgetStatus    === 'Approved';
  const supplierDone  = !supplierEmail  || metadata.supplierStatus  === 'Approved';
  const p2pBranch     = metadata.p2pBranch || pr.p2p_branch || 'full';
  const skipPRContract = p2pBranch === 'full' || p2pBranch === 'simplified';
  const contractDone  = skipPRContract || !contractEmail || metadata.contractStatus === 'Approved';
  const purchasingDone = !purchasingEmail || metadata.purchasingStatus === 'Approved';

  const parallelComplete = budgetDone && supplierDone;

  if (!parallelComplete)
    return { stage: 'parallel', statusLabel: 'Đang duyệt ngân sách & NCC (2/5)' };
  if (!skipPRContract && contractEmail && !contractDone)
    return { stage: 'contract', statusLabel: 'Thẩm định Hợp đồng (4/5)' };
  if (purchasingEmail && !purchasingDone)
    return { stage: 'purchasing', statusLabel: 'Mua hàng (5/5)' };
  return { stage: 'complete', statusLabel: 'Hoàn thành' };
}
```

### 4.2 PR number allocation — atomic SEQUENCE

```javascript
// api/handlers/pr-submit.js
export async function allocatePRNumber(client, companyCode, requestedNo) {
  // Check if requested number is free
  if (requestedNo) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM purchase_requests WHERE pr_no = $1', [requestedNo]
    );
    if (rowCount === 0) return requestedNo;
  }

  // Atomic sequence — no scan-and-increment, no race condition
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  
  await client.query(
    `INSERT INTO pr_number_sequences (company_code, date_str, next_counter)
     VALUES ($1, $2, 1)
     ON CONFLICT (company_code, date_str)
     DO UPDATE SET next_counter = pr_number_sequences.next_counter + 1`,
    [companyCode, dateStr]
  );
  
  const { rows } = await client.query(
    'SELECT next_counter FROM pr_number_sequences WHERE company_code = $1 AND date_str = $2',
    [companyCode, dateStr]
  );
  
  const counter = String(rows[0].next_counter - 1).padStart(6, '0');
  return `${companyCode.toUpperCase()}-PR${dateStr}${counter}`;
}
```

### 4.3 PR approval — same guards, same email routing

All gate checks from the business logic reference (§6):
- Role must be in active stage
- Email must match assigned column
- Already-approved rejected
- Out-of-order rejected
- Send-back with targetStep and role-based maxTarget
- Emails queued (not sent synchronously):
  - Submit → budget + supplier + requester
  - Stage transition → contract (when parallel done), purchasing (when contract/parallel done)
  - Completion → requester

### 4.4 PR history — slim cards (no items, no metadata)

```javascript
export async function handleGetPurchaseRequestHistory(req, res) {
  // Run archive first (once per day — use a Redis flag)
  await maybeArchiveOldPRs();
  
  const { rows } = await pool.query(`
    SELECT pr_no, company_name, requester_name, purpose, grand_total,
           status, currency, submitted_at
    FROM purchase_requests
    WHERE archived_at IS NULL
    ORDER BY submitted_at DESC
    LIMIT 5000
  `);
  
  // Slim card — no items, no metadata (loaded on drawer open)
  res.json({ success: true, data: { requests: rows.map(prListCardFromRow) } });
}
```

### 4.5 Archive (90-day, once per day)

```javascript
async function maybeArchiveOldPRs() {
  const today = new Date().toDateString();
  const lastRun = await redis.get('tlcg:pr:archive:last-run');
  if (lastRun === today) return;
  
  await pool.query(`
    UPDATE purchase_requests
    SET archived_at = NOW()
    WHERE status IN ('Hoàn thành', 'Đã từ chối')
      AND archived_at IS NULL
      AND updated_at < NOW() - INTERVAL '90 days'
  `);
  
  await redis.set('tlcg:pr:archive:last-run', today);
}
```

### 4.6 Verification checklist

- [ ] PR submit → branch (full/simplified) → parallel → purchasing → Hoàn thành
- [ ] Concurrent submits → no PR number collision (atomic SEQUENCE)
- [ ] All 4 roles approve in correct stage
- [ ] Reject at any stage → `Đã từ chối`, no further actions
- [ ] Send-back with targetStep 1/2/3 → correct status + role reset
- [ ] Emails: submit → budget + supplier only; transition → contract/purchasing; completion → requester
- [ ] Archive: 90-day idle → archived, once per day
- [ ] Vietnamese status strings preserved
- [ ] Items key field is `desc`

---

## Phase 5 — Decommission Ubuntu + Optimize (2-3 days)

### 5.1 Retire the Ubuntu server

- Switch Cloudflare DNS fully to the Mac Mini tunnel (remove Ubuntu tunnel)
- Shut down the Ubuntu Express process (`pm2 stop tlcg-workflow` on Ubuntu)
- Keep the Ubuntu server powered on for 1 week as warm backup (in case of Mac Mini issue)
- After 1 week with no rollback needed: retire the Ubuntu server

### 5.2 Remove GAS

- Delete `TLCG_*_BACKEND_URL` env vars from the Mac Mini `.env`
- Remove GAS proxy code from `api/voucher.js`
- Archive `.gs` files (move to `docs/archive/` — don't delete, they're the data migration source)
- Remove `GOOGLE_SERVICE_ACCOUNT_KEY_B64` (no longer needed)

### 5.3 Web Push (optional — for mobile "fast approve")

```javascript
// api/handlers/push.js
import webpush from 'web-push';

webpush.setVapidDetails(
  'mailto:noreply@tl-c.us',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// On stage transition (when it's someone's turn):
async function notifyApproverPush(email, prNo) {
  const { rows } = await pool.query('SELECT push_subscription FROM employees WHERE email = $1', [email]);
  if (rows[0]?.push_subscription) {
    await webpush.sendNotification(
      JSON.parse(rows[0].push_subscription),
      JSON.stringify({ title: 'Cần phê duyệt', body: `Phiếu ${prNo}`, url: `/purchase_request.html` })
    );
  }
}
```

### 5.4 Health check

```javascript
// api/handlers/health.js
export async function handleHealth(req, res) {
  const checks = {};
  try {
    await pool.query('SELECT 1');
    checks.db = 'ok';
  } catch { checks.db = 'fail'; }
  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch { checks.redis = 'fail'; }
  checks.r2 = 'ok'; // or actually check
  
  const allOk = Object.values(checks).every(v => v === 'ok');
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'healthy' : 'degraded', checks });
}
```

### 5.5 Monitoring

- Cloudflare analytics: response time, error rate
- PM2 logs: `pm2 logs tlcg-workflow`
- Alert: response time > 500ms, error rate > 1%
- Email queue depth: alert if > 100 pending (worker is down)

---

## Timeline

| Phase | Days | What ships | Server |
|---|---|---|---|
| 0 — Mac Mini Setup | 2-3 | Provision Mini, install Postgres/Redis/PM2, Cloudflare Tunnel, schema, indexes | Mac Mini (staging: `mini.tl-c.us`) |
| 1 — Auth + Master Data | 2-3 | Login, employees, companies, goods — server-side cache | Mac Mini (staging); Ubuntu still production |
| 2 — Cash Book | 2-3 | Cash count form, 3-role signing | Mac Mini (staging) |
| 3 — Vouchers | 5-7 | Submit, approve, reject, acknowledge, list, R2, SSE, email queue — **then cutover** | Mac Mini → **production** (`workflow.tl-c.us`); Ubuntu stays warm |
| 4 — P2P | 7-10 | PR submit/approve/reject/send-back, history, archive, email routing | Mac Mini (production) |
| 5 — Decommission | 2-3 | Retire Ubuntu, remove GAS, add Web Push, health check, monitoring | Mac Mini (production); Ubuntu retired |
| **Total** | **~20-29 days** | | |

---

## What Changes vs What Stays

### Changes

| From | To |
|---|---|
| Ubuntu server (cloud) | Mac Mini (theoneplus), local, always-on |
| Google Apps Script | Express handlers on the Mini (8 PM2 workers) |
| Google Sheets | Local Postgres (homebrew, localhost) |
| `GmailApp.sendEmail()` | Resend (cloud API, queued in Postgres) |
| Google Drive attachments | Cloudflare R2 (presigned PUT, server never touches bytes) |
| GAS cold starts (3-10s) | Express handlers (<50ms, localhost) |
| Sheet 5000-row scan | Indexed Postgres query (<1ms, localhost) |
| `Set`-based dedup workaround | `SELECT FOR UPDATE` + unique constraints |
| `metadata_json` string parsing | `JSONB` queryable columns |
| 700KB base64 ceiling (GAS truncation) | R2 presigned PUT (no limit) |
| Synchronous email (1-6s wait) | Email queue (background, <50ms response) |
| Manual refresh to see updates | SSE real-time updates (Redis pub/sub) |
| `LockService.getScriptLock()` | `SELECT FOR UPDATE` + Postgres SEQUENCE |
| In-memory rate limiter (Map) | Redis sliding window (localhost) |
| Single Node process | PM2 cluster (8 workers, one per core) |
| Port forwarding / public IP | Cloudflare Tunnel (zero open ports, zero-trust) |

### Stays

| What | Why |
|---|---|
| 12 HTML pages | Frontend never changes — same `action`-based API |
| `i18n.js` bilingual layer | VI/EN switching, Vietnamese status strings |
| iOS design system | CSS, fonts, colors unchanged |
| `tlcg_companies_embed.js` | Companies dropdown source unchanged |
| `tlc_master_data` localStorage cache | Still used for instant page load |
| Vietnamese status strings in DB | `Chờ duyệt`, `Đang duyệt (1/3)`, `Đã duyệt`, etc. |
| Vietnamese email templates | Go to approvers, not submitter |
| Notification bell badge count | Derived from loaded data (no separate call) |
| All approval business logic | Guards, stage progression, branch logic |
| Audit trail (append-only) | 12-column schema, never delete/overwrite |
| Signature mandatory on every action | All 8 page/action combinations |
| Cloudflare (DNS + tunnel + R2) | Same provider, just pointing to the Mini |

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Data migration breaks live data | One-time import script, run both backends in parallel during Phase 1-3, verify counts match |
| Postgres connection exhaustion | Pool size 20-40 per worker; local Postgres handles 100+ easily on 16 GB |
| Email queue worker down | Monitor queue depth, alert if > 100 pending, auto-retry with backoff |
| SSE connection limit | Cloudflare handles SSE; Redis pub/sub scales to thousands of subscribers |
| R2 upload fails | Presigned URL expires in 1 hour; client retries; R2 has 99.99% SLA |
| Concurrent approval race | `SELECT FOR UPDATE` inside transaction; unique constraint on (voucher_id, approver_role) |
| PR number collision | Postgres SEQUENCE (atomic, no scan); `ON CONFLICT DO UPDATE` |
| GAS still needed during migration | Proxy routes by `action` name — switch one action at a time, verify, move on |
| Mac Mini hardware failure | Time Machine backup + nightly `pg_dump` to R2; Ubuntu server stays warm as backup for 1 week post-cutover |
| Mac Mini power outage | `pmset -a sleep 0` + UPS if available; PM2 `--restart=always` auto-restarts Node on boot; `brew services` auto-starts Postgres + Redis + cloudflared on boot |
| Home internet outage | Cloudflare Tunnel reconnects automatically when internet returns; Ubuntu server can be switched back via DNS change |

---

## Mac Mini Postgres Tuning (local, 16 GB RAM)

```ini
# /opt/homebrew/var/postgresql@16/postgresql.conf
# Tuned for M1 Pro, 16 GB RAM, local-only (no network latency)

shared_buffers = 4GB              # 25% of RAM
effective_cache_size = 12GB       # 75% of RAM
work_mem = 64MB                   # per-sort/hash (100 users → keep modest)
maintenance_work_mem = 1GB        # for VACUUM, CREATE INDEX
max_connections = 100             # 8 workers × ~12 connections = ~96 max
# No pgBouncer needed — local, pool handles it
```

---

## Post-Migration Cleanup (one-time SQL)

```sql
-- Replace cleanupDuplicateApprovalRows (GAS utility) with SQL:
DELETE FROM voucher_history vh
USING (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY voucher_number, approver_email
    ORDER BY approved_at DESC
  ) as rn
  FROM voucher_history
  WHERE approver_email IS NOT NULL AND approver_email != ''
) dup
WHERE vh.id = dup.id AND dup.rn > 1;
-- Keeps latest row per (voucher, approver), deletes duplicates
```

---

## 100-User Load Test Checklist

| Test | Expected (Mac Mini, localhost) |
|---|---|
| 100 concurrent `getMasterData` | <10ms p99 (server cache hit, no network) |
| 100 concurrent voucher list | <20ms p99 (indexed query, localhost Postgres) |
| 50 concurrent approvals (different vouchers) | <50ms p99 (pool, no contention, localhost) |
| 2 concurrent approvals (same voucher) | Second waits on `SELECT FOR UPDATE`, then gets "already approved" |
| 100 concurrent PR submits | No number collision (atomic SEQUENCE); <50ms p99 |
| 100 concurrent file uploads (5MB each) | Mac Mini CPU unaffected (direct to R2, server never touches bytes) |
| Email queue depth after 100 approvals | < 300 emails, all sent within 30s (background worker) |
| SSE connections (100) | All receive update within 100ms of action (Redis pub/sub, localhost) |

> **Note on localhost latency:** With Postgres and Redis on localhost, the
> theoretical p99 for a single DB query is <1ms and Redis is <0.5ms. The 50ms
> budget accounts for: Express middleware, JWT verify, pool checkout (~2ms
> under contention), query execution (<5ms), audit log insert (<2ms), Redis
> publish (<1ms), JSON serialization. With 8 PM2 workers, each worker handles
> ~12 concurrent requests — well within Node's event loop capacity.

---

## Backup Strategy (Mac Mini)

```bash
# Nightly Postgres dump → Cloudflare R2 (3 copies, 30-day retention)
#!/bin/bash
# /opt/homebrew/bin/tlcg-backup.sh
pg_dump tlcg_workflow | gzip | \
  aws s3 cp - s3://tlcg-backups/$(date +%Y%m%d).sql.gz \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com

# Add to crontab:
# 0 2 * * * /opt/homebrew/bin/tlcg-backup.sh
```
