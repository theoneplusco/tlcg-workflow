-- 005_vouchers_engine.sql — Vouchers driven by approval-flow plans (2026-10-07)
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/005_vouchers_engine.sql
--
-- vouchers = one row per voucher (current state, like the Voucher_Current
-- sheet); the engine plan lives in metadata.approvalPlan. The array columns
-- index who must act now and everyone in the flow, so lists and "my tasks"
-- are index lookups instead of JSON scans.
-- voucher_history = append-only rows with the Voucher_History sheet columns.
BEGIN;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS submitted_at    TIMESTAMPTZ;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS last_action     TEXT DEFAULT '';
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS progress_done   INT  DEFAULT 0;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS progress_total  INT  DEFAULT 3;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS pending_emails  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS approver_emails TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS note            TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS vouchers_pending_emails_idx  ON vouchers USING GIN (pending_emails);
CREATE INDEX IF NOT EXISTS vouchers_approver_emails_idx ON vouchers USING GIN (approver_emails);
CREATE INDEX IF NOT EXISTS vouchers_requestor_idx       ON vouchers (LOWER(requestor_email));
CREATE INDEX IF NOT EXISTS vouchers_submitted_idx       ON vouchers (submitted_at DESC);

ALTER TABLE voucher_history ADD COLUMN IF NOT EXISTS acknowledged_at  TIMESTAMPTZ;
ALTER TABLE voucher_history ADD COLUMN IF NOT EXISTS acknowledged_by  TEXT DEFAULT '';
ALTER TABLE voucher_history ADD COLUMN IF NOT EXISTS signature_url    TEXT DEFAULT '';
ALTER TABLE voucher_history ADD COLUMN IF NOT EXISTS rejection_reason TEXT DEFAULT '';
ALTER TABLE voucher_history ADD COLUMN IF NOT EXISTS sheet_row        INT;
CREATE INDEX IF NOT EXISTS voucher_history_number_time_idx ON voucher_history (voucher_number, submitted_at);
COMMIT;
