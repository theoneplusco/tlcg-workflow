-- 004_approval_flows.sql — Versioned approval flows per workflow and company (2026-10-06)
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/004_approval_flows.sql
--
-- One row per saved version. company_id NULL = the workflow's default flow,
-- used by every company without its own. The active version is the newest
-- one whose effective_from has passed. Rows are never updated or deleted, so
-- the history of who changed which flow, and when, is kept.
BEGIN;
CREATE TABLE IF NOT EXISTS approval_flows (
  id             SERIAL PRIMARY KEY,
  workflow       TEXT NOT NULL,
  company_id     INT REFERENCES companies(id),
  version        INT NOT NULL,
  steps          JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note           TEXT DEFAULT '',
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_flows_version_uidx
  ON approval_flows (workflow, COALESCE(company_id, 0), version);
CREATE INDEX IF NOT EXISTS approval_flows_lookup_idx
  ON approval_flows (workflow, company_id, effective_from DESC);
COMMIT;
