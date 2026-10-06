-- 002_master_tables.sql — Master sheets with admin-managed columns (2026-10-06)
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/002_master_tables.sql
--
-- Every master sheet keeps its exact columns. Columns the app logic reads
-- (email, approvers, prices, …) stay typed columns; every other sheet
-- column lives in `extra` (JSONB keyed by the sheet header), so adding or
-- deleting a column is a metadata change, never an ALTER TABLE.

BEGIN;

-- Column registry: name = exact sheet header, position = display order
CREATE TABLE IF NOT EXISTS master_columns (
  table_key   TEXT NOT NULL,
  name        TEXT NOT NULL,
  position    INT  NOT NULL DEFAULT 0,
  created_by  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (table_key, name)
);

-- Typed master tables: sheet columns that are not typed go in `extra`
ALTER TABLE employees     ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';
ALTER TABLE employees     ADD COLUMN IF NOT EXISTS sheet_row INT;
ALTER TABLE companies     ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';
ALTER TABLE companies     ADD COLUMN IF NOT EXISTS sheet_row INT;
ALTER TABLE companies     ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE goods_catalog ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}';
ALTER TABLE goods_catalog ADD COLUMN IF NOT EXISTS sheet_row INT;
ALTER TABLE goods_catalog ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Sheet-only master tables: every column lives in `extra`
CREATE TABLE IF NOT EXISTS master_clients (
  id          SERIAL PRIMARY KEY,
  sheet_row   INT,
  extra       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS master_vendors (
  id          SERIAL PRIMARY KEY,
  sheet_row   INT,
  extra       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS master_vendor_banks (
  id          SERIAL PRIMARY KEY,
  sheet_row   INT,
  extra       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Lookups used by getSuppliers / getVendorBanks (payment request form)
CREATE INDEX IF NOT EXISTS master_vendors_name_idx
  ON master_vendors ((extra->>'Vendor_Full_Name'));
CREATE INDEX IF NOT EXISTS master_vendor_banks_vendor_idx
  ON master_vendor_banks ((extra->>'Vendor_name'));

COMMIT;
