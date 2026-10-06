-- 003_master_column_labels.sql — Admin-editable column labels (2026-10-06)
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/003_master_column_labels.sql
--
-- `name` stays the exact sheet header (the key used by imports and app
-- logic); `label` is what the admin page shows. NULL = show the name.
ALTER TABLE master_columns ADD COLUMN IF NOT EXISTS label TEXT;
