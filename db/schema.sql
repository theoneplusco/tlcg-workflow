-- TLCG Workflow — Postgres schema
-- Run: psql tlcg_workflow -f schema.sql

-- ── Master data ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS employees (
  id              SERIAL PRIMARY KEY,
  full_name       TEXT NOT NULL,
  position        TEXT DEFAULT '',
  department      TEXT DEFAULT '',
  company         TEXT DEFAULT '',
  email           TEXT NOT NULL UNIQUE,
  phone           TEXT DEFAULT '',
  status          TEXT DEFAULT 'active',
  employee_id     TEXT DEFAULT '',
  role            TEXT DEFAULT '',
  is_admin        BOOLEAN DEFAULT FALSE,
  password_hash   TEXT DEFAULT '',
  cached_signature TEXT,
  push_subscription TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS companies (
  id                SERIAL PRIMARY KEY,
  company_name      TEXT NOT NULL,
  company_code      TEXT DEFAULT '',
  company_key       TEXT DEFAULT '',
  legal_rep_name    TEXT DEFAULT '',
  legal_rep_email   TEXT DEFAULT '',
  legal_rep_sig_url TEXT DEFAULT '',
  accountant_name    TEXT DEFAULT '',
  accountant_email   TEXT DEFAULT '',
  accountant_sig_url TEXT DEFAULT '',
  treasurer_name     TEXT DEFAULT '',
  treasurer_email    TEXT DEFAULT '',
  treasurer_sig_url  TEXT DEFAULT '',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goods_catalog (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT DEFAULT '',
  moq         NUMERIC DEFAULT 1,
  unit        TEXT DEFAULT 'Cái',
  unit_price  NUMERIC DEFAULT 0,
  spec        TEXT DEFAULT '',
  qbo_code    TEXT DEFAULT '',
  status      TEXT DEFAULT 'active',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Vouchers (Phiếu Thu/Chi) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS vouchers (
  id                SERIAL PRIMARY KEY,
  voucher_number    TEXT NOT NULL UNIQUE,
  voucher_type      TEXT NOT NULL,
  company_id        INT REFERENCES companies(id),
  company_name      TEXT DEFAULT '',
  company_key       TEXT DEFAULT '',
  employee_name     TEXT DEFAULT '',
  requestor_email   TEXT DEFAULT '',
  submitted_by      TEXT DEFAULT '',
  amount            NUMERIC DEFAULT 0,
  status            TEXT DEFAULT 'Chờ duyệt',
  due_date          TEXT DEFAULT '',
  description       TEXT DEFAULT '',
  attachments        TEXT DEFAULT '',
  metadata          JSONB DEFAULT '{}',
  current_approver  TEXT DEFAULT 'accountant',
  approval_progress TEXT DEFAULT '0/3',
  overall_status    TEXT DEFAULT 'pending',
  acknowledged_sig   TEXT,
  acknowledged_at    TIMESTAMPTZ,
  acknowledged_by    TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voucher_history (
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
  action          TEXT DEFAULT '',
  attachments     TEXT DEFAULT '',
  description     TEXT DEFAULT '',
  note            TEXT DEFAULT '',
  approver_email  TEXT DEFAULT '',
  approved_at     TIMESTAMPTZ,
  metadata        JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS voucher_audit_log (
  id          SERIAL PRIMARY KEY,
  doc_no      TEXT NOT NULL,
  flow        TEXT NOT NULL DEFAULT 'VCH',
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

-- ── Purchase Requests ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS purchase_requests (
  id                       SERIAL PRIMARY KEY,
  pr_no                    TEXT NOT NULL UNIQUE,
  company_id               INT REFERENCES companies(id),
  company_name             TEXT DEFAULT '',
  company_key              TEXT DEFAULT '',
  department               TEXT DEFAULT '',
  requester_name          TEXT DEFAULT '',
  requester_email         TEXT DEFAULT '',
  required_date           TEXT DEFAULT '',
  priority                TEXT DEFAULT 'Bình Thường',
  purpose                 TEXT DEFAULT '',
  vendor_name             TEXT DEFAULT '',
  budget_code             TEXT DEFAULT '',
  budget_approver_email    TEXT DEFAULT '',
  supplier_approver_email  TEXT DEFAULT '',
  contract_approver_email TEXT DEFAULT '',
  purchasing_approver_email TEXT DEFAULT '',
  items                    JSONB DEFAULT '[]',
  grand_total              NUMERIC DEFAULT 0,
  currency                 TEXT DEFAULT 'VND',
  status                   TEXT DEFAULT 'Đang duyệt ngân sách & NCC (2/5)',
  p2p_branch               TEXT DEFAULT 'full',
  purchase_type            TEXT DEFAULT 'goods',
  attachments              JSONB DEFAULT '[]',
  metadata                 JSONB DEFAULT '{}',
  submitted_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),
  archived_at             TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS pr_audit_log (
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

CREATE TABLE IF NOT EXISTS pr_number_sequences (
  id            SERIAL PRIMARY KEY,
  company_code  TEXT NOT NULL,
  date_str      TEXT NOT NULL,
  next_counter  INT DEFAULT 1,
  UNIQUE(company_code, date_str)
);

-- ── Email queue (decoupled from approval response) ──────────

CREATE TABLE IF NOT EXISTS email_queue (
  id          SERIAL PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_html   TEXT DEFAULT '',
  body_text   TEXT DEFAULT '',
  status      TEXT DEFAULT 'pending',
  attempts    INT DEFAULT 0,
  error       TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  sent_at     TIMESTAMPTZ
);

-- ── Cash counts (Bảng kiểm kê quỹ) ──────────────────────────

CREATE TABLE IF NOT EXISTS cash_counts (
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
  conclusion       TEXT DEFAULT '',
  reps            JSONB DEFAULT '[]',
  saved_by_email  TEXT DEFAULT '',
  saved_at        TIMESTAMPTZ DEFAULT NOW(),
  row_status      TEXT DEFAULT 'pending'
);

-- ── Indexes ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_vouchers_number     ON vouchers(voucher_number);
CREATE INDEX IF NOT EXISTS idx_vouchers_company    ON vouchers(company_id, status);
CREATE INDEX IF NOT EXISTS idx_vouchers_active     ON vouchers(status) WHERE status NOT IN ('Đã duyệt', 'Đã từ chối');
CREATE INDEX IF NOT EXISTS idx_vouchers_updated    ON vouchers(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_vhist_number       ON voucher_history(voucher_number);
CREATE INDEX IF NOT EXISTS idx_vhist_approver     ON voucher_history(approver_email);
CREATE INDEX IF NOT EXISTS idx_vhist_submitted    ON voucher_history(submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_pr_no              ON purchase_requests(pr_no);
CREATE INDEX IF NOT EXISTS idx_pr_company_status  ON purchase_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_pr_active          ON purchase_requests(status) WHERE status NOT IN ('Hoàn thành', 'Đã từ chối');
CREATE INDEX IF NOT EXISTS idx_pr_submitted       ON purchase_requests(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_pr_archived        ON purchase_requests(archived_at);

CREATE INDEX IF NOT EXISTS idx_audit_doc_no       ON voucher_audit_log(doc_no);
CREATE INDEX IF NOT EXISTS idx_audit_pr_doc       ON pr_audit_log(doc_no);
CREATE INDEX IF NOT EXISTS idx_audit_created      ON pr_audit_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_queue_pending ON email_queue(status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_employees_status   ON employees(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_employees_email    ON employees(email);
