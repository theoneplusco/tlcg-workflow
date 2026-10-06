-- 001_master_data_fixes.sql — Phase 1 audit fixes (2026-10-06)
-- Safe to re-run. Apply on the Mac Mini:
--   psql tlcg_workflow -f db/migrations/001_master_data_fixes.sql

BEGIN;

-- ── Employees: carry GAS passwords across ────────────────────
-- GAS column L ("password") holds an unsalted SHA-256 hex hash. Login
-- verifies against it once, then replaces it with bcrypt and clears it.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS legacy_password_sha256 TEXT DEFAULT '';
-- GAS column M ("mustChangePassword"), also set when only the column K
-- default password was imported.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE;

-- ── Companies: fields the embed/sheet has but Postgres dropped ─
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address  TEXT DEFAULT '';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_code TEXT DEFAULT '';

-- One company name has several keys (E.V, E.V_205 NTP, E.V_KTT_Trạm),
-- so the natural key is the pair.
CREATE UNIQUE INDEX IF NOT EXISTS companies_name_key_uidx
  ON companies (company_name, company_key);

-- ── Goods: drop the empty-name rows the old import produced, then
-- give re-runs a natural key so they update instead of duplicating.
DELETE FROM goods_catalog WHERE COALESCE(TRIM(name), '') = '';
CREATE UNIQUE INDEX IF NOT EXISTS goods_catalog_name_category_uidx
  ON goods_catalog (name, category);

COMMIT;
