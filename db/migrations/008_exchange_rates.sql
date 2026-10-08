-- db/migrations/008_exchange_rates.sql — admin exchange rates for the PR VND threshold, master-data audit,
-- and the rate/VND total stored on each PR (Plan 5b, 2026-10-07). Safe to re-run:
--   psql tlcg_workflow -f db/migrations/008_exchange_rates.sql
-- exchange_rates is app-only (not a Google Sheet tab): it is edited in admin.html › Master Data and
-- never imported by scripts/import-master-sheets.js. VND is the base and is never stored.
-- A rate is a whole number of VND for 1 unit of the currency (decision 2026-10-07), e.g. 26000 for USD.
BEGIN;
CREATE TABLE IF NOT EXISTS exchange_rates (
  id          SERIAL PRIMARY KEY,
  currency    TEXT NOT NULL UNIQUE CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'VND'),
  -- NULL = no rate yet: PR submit refused
  rate_to_vnd NUMERIC(18,6) CHECK (rate_to_vnd IS NULL OR (rate_to_vnd > 0 AND rate_to_vnd = trunc(rate_to_vnd))),
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
