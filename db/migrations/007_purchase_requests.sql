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
