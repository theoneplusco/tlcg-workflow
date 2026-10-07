-- db/migrations/006_sheet_outbox.sql — one-way Postgres → Google Sheet copy queue
CREATE TABLE IF NOT EXISTS sheet_outbox (
  id BIGSERIAL PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  tab TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('append', 'upsert')),
  key_column TEXT,
  record JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sheet_outbox_pending ON sheet_outbox (next_try_at) WHERE done_at IS NULL;
