// api/lib/approval/flows-repo.js — Approval flow storage (versions per workflow + company).
import { DEFAULT_STEPS, validateSteps } from './engine.js';

/**
 * The flow in force for a company at `at`: the company's own newest due
 * version, else the workflow default's, else the built-in steps.
 * No `at` → compared in SQL against clock_timestamp(): effective_from has microseconds, a JS Date only
 * milliseconds, so "now" from JS could fall just before a version saved a moment ago.
 */
export async function getActiveFlow(db, workflow, companyId, at = null) {
  const { rows } = await db.query(
    `SELECT id, version, steps, company_id, effective_from, created_by, created_at, note
       FROM approval_flows
      WHERE workflow = $1 AND (company_id = $2 OR company_id IS NULL) AND effective_from <= COALESCE($3::timestamptz, clock_timestamp())
      ORDER BY (company_id IS NULL), version DESC
      LIMIT 1`,
    [workflow, companyId, at == null ? null : at]
  );
  const r = rows[0];
  if (r) {
    return { id: r.id, version: r.version, steps: r.steps, companyId: r.company_id,
      source: r.company_id == null ? 'default' : 'company', effectiveFrom: r.effective_from,
      createdBy: r.created_by, createdAt: r.created_at, note: r.note };
  }
  if (!DEFAULT_STEPS[workflow]) throw new Error(`No flow for workflow "${workflow}"`);
  return { id: null, version: 0, steps: DEFAULT_STEPS[workflow], companyId: null, source: 'builtin' };
}

/** Saved versions for one workflow + company (null = default), newest first. */
export async function listVersions(db, workflow, companyId) {
  const { rows } = await db.query(
    `SELECT id, version, steps, effective_from, note, created_by, created_at
       FROM approval_flows
      WHERE workflow = $1 AND company_id IS NOT DISTINCT FROM $2
      ORDER BY version DESC`,
    [workflow, companyId]
  );
  return rows.map((r) => ({ id: r.id, version: r.version, steps: r.steps, effectiveFrom: r.effective_from,
    note: r.note, createdBy: r.created_by, createdAt: r.created_at }));
}

/** Append a new version (never overwrites). Throws with the validation messages. */
export async function saveVersion(db, { workflow, companyId = null, steps, effectiveFrom = null, note = '', createdBy }) {
  const errors = validateSteps(steps);
  if (errors.length) throw Object.assign(new Error(errors.join(' ')), { code: 'INVALID_FLOW', errors });
  const clean = steps.map((s, i) => ({
    name: String(s.name || '').trim() || `Bước ${i + 1}`,
    approvers: s.approvers.map((a) => (a.type === 'role'
      ? { type: 'role', role: a.role }
      : { type: 'person', email: String(a.email).trim().toLowerCase() })),
  }));
  const { rows } = await db.query(
    `INSERT INTO approval_flows (workflow, company_id, version, steps, effective_from, note, created_by)
     SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3::jsonb, COALESCE($4::timestamptz, NOW()), $5, $6
       FROM approval_flows WHERE workflow = $1 AND company_id IS NOT DISTINCT FROM $2
     RETURNING id, version, effective_from`,
    [workflow, companyId, JSON.stringify(clean), effectiveFrom, note, createdBy]
  );
  return { id: rows[0].id, version: rows[0].version, effectiveFrom: rows[0].effective_from, steps: clean };
}

/** The company row (with extra) and active employees keyed by lowercase email. */
export async function loadCompanyContext(db, companyId) {
  const [co, emp] = await Promise.all([
    companyId == null ? { rows: [null] } : db.query(`SELECT * FROM companies WHERE id = $1`, [companyId]),
    db.query(`SELECT LOWER(email) AS email, full_name, position FROM employees WHERE status = 'active'`),
  ]);
  return { company: co.rows[0] || null, employeesByEmail: new Map(emp.rows.map((e) => [e.email, e])) };
}
