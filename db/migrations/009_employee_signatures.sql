-- db/migrations/009_employee_signatures.sql — each employee's sample signature stored in Postgres (decision 2026-10-08).
-- Replaces the Drive links as the first source of the stamped approval signature: a Drive file that is private or
-- deleted (HTTP 404) blocked approvals. Uploaded by the employee (My Profile, with their password) or by an admin.
-- Safe to re-run:  psql tlcg_workflow -f db/migrations/009_employee_signatures.sql
BEGIN;
CREATE TABLE IF NOT EXISTS employee_signatures (
  employee_id INT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  data_url    TEXT NOT NULL,            -- data:image/png|jpeg;base64,… at most 750 KB decoded (MAX_STAMP_BYTES)
  bytes       INT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT NOT NULL             -- email of the employee or the admin who uploaded it
);
COMMIT;
