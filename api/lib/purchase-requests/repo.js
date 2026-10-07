// api/lib/purchase-requests/repo.js — purchase_requests / pr_audit_log storage.
// RULE: handlers change PR state only via updatePR + recordChange (same transaction). appendAudit is for
// recordChange and the importer only.
// Takes the db or transaction client as an argument (no pool import): handlers, tests and the importer share it.
import { enqueue } from '../sheets/outbox.js';
import { p2pSpreadsheetId, PR_TAB, AUDIT_TAB, PR_KEY, prRecord, auditRecord } from '../sheets/pr-records.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const JSON_COLS = new Set(['items', 'attachments', 'metadata']);
export const WRITABLE = ['pr_no', 'company_id', 'company_name', 'company_key', 'department', 'requester_name',
  'requester_email', 'required_date', 'priority', 'purpose', 'vendor_name', 'budget_code',
  'budget_approver_email', 'supplier_approver_email', 'contract_approver_email', 'purchasing_approver_email',
  'items', 'grand_total', 'currency', 'status', 'p2p_branch', 'purchase_type', 'attachments', 'metadata',
  'submitted_at', 'archived_at', 'approver_emails', 'pending_emails', 'imported_at', 'sheet_row', 'updated_at'];

const EMAIL_LISTS = new Set(['approver_emails', 'pending_emails']);
const val = (k, v) => (EMAIL_LISTS.has(k) ? (v || []).map(lower).filter(Boolean)
  : k === 'requester_email' ? lower(v)
  : JSON_COLS.has(k) ? JSON.stringify(v ?? (k === 'metadata' ? {} : [])) : v);

export async function getPR(db, prNo) {
  const { rows } = await db.query('SELECT * FROM purchase_requests WHERE pr_no = $1', [String(prNo || '').trim()]);
  return rows[0] || null;
}

/** Inside a transaction: the row, locked until COMMIT (fixes GAS B11, two approvals racing). */
export async function lockPR(client, prNo) {
  const { rows } = await client.query('SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [String(prNo || '').trim()]);
  return rows[0] || null;
}

export async function insertPR(client, rec) {
  const keys = WRITABLE.filter((k) => rec[k] !== undefined);
  const { rows } = await client.query(
    `INSERT INTO purchase_requests (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => val(k, rec[k])));
  return rows[0];
}

/**
 * Importer only: overwrite an imported row in place (id and created_at kept), every given column verbatim,
 * updated_at included (GAS last activity), and stamp imported_at with the wall clock.
 */
export async function replaceImportedPR(client, id, rec) {
  const keys = WRITABLE.filter((k) => rec[k] !== undefined && k !== 'pr_no' && k !== 'imported_at');
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('imported_at = clock_timestamp()');
  const { rows } = await client.query(
    `UPDATE purchase_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => val(k, rec[k]))]);
  return rows[0] || null;
}

export async function updatePR(client, id, fields) {
  const keys = WRITABLE.filter((k) => fields[k] !== undefined && k !== 'updated_at' && k !== 'pr_no');
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = NOW()');
  const { rows } = await client.query(
    `UPDATE purchase_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => val(k, fields[k]))]);
  return rows[0] || null;
}

export async function appendAudit(client, e) {
  await client.query(
    `INSERT INTO pr_audit_log (doc_no, flow, company, action, role, actor_email, actor_name, prev_status, new_status,
                               note, extra, created_at, source, sheet_row)
     VALUES ($1, 'PR', $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, NOW()), $12, $13)`,
    [e.docNo, e.company || '', e.action, e.role || '', lower(e.actorEmail), e.actorName || '', e.prevStatus || '',
      e.newStatus || '', e.note || '', JSON.stringify(e.extra || {}), e.at || null, e.source || 'app', e.sheetRow ?? null]);
}

/**
 * Every PR state change goes through here, after the row is updated and in the same transaction:
 * audit row(s), then the Sheet copy (PR row upserted, audit rows appended) when P2P_SPREADSHEET_ID is set.
 * `row` is the row AFTER the change; entries are audit rows (docNo/company filled from the row).
 */
export async function recordChange(client, row, entries) {
  const list = [].concat(entries).map((e) => ({ docNo: row.pr_no, company: row.company_name, ...e }));
  for (const e of list) await appendAudit(client, e);
  const spreadsheetId = p2pSpreadsheetId();
  if (!spreadsheetId) return;
  await enqueue(client, { spreadsheetId, tab: PR_TAB, mode: 'upsert', keyColumn: PR_KEY, record: prRecord(row) });
  for (const e of list) await enqueue(client, { spreadsheetId, tab: AUDIT_TAB, mode: 'append', record: auditRecord(e) });
}

export async function auditFor(db, prNo, limit = 200) {
  const { rows } = await db.query(
    'SELECT * FROM pr_audit_log WHERE doc_no = $1 ORDER BY created_at, id LIMIT $2', [String(prNo || '').trim(), limit]);
  return rows;
}

/** Requester, anyone named on the PR, or an admin (decision 2026-10-07). */
export function visibility(caller, start = 1) {
  if (!lower(caller && caller.email)) return { sql: `(FALSE AND $${start}::boolean AND $${start + 1}::text IS NOT NULL)`, params: [false, ''] };
  return {
    sql: `($${start}::boolean OR LOWER(requester_email) = $${start + 1} OR $${start + 1} = ANY(approver_emails))`,
    params: [!!caller.isAdmin, lower(caller.email)],
  };
}

export function canView(caller, row) {
  if (!caller || !row) return false;
  const me = lower(caller.email);
  if (!me) return false;
  return !!caller.isAdmin || lower(row.requester_email) === me || (row.approver_emails || []).includes(me);
}

/**
 * Who the requester may pick (purchase_request.html seedApproversFromCompany): the company's
 * Đại diện pháp luật / Kế toán trưởng / Thủ quỹ for budget, supplier and contract; active
 * Kế Toán Chi staff for purchasing.
 */
export async function approverCandidates(db, company) {
  const companyEmails = new Set(['legal_rep_email', 'accountant_email', 'treasurer_email']
    .map((c) => lower(company && company[c])).filter(Boolean));
  const { rows } = await db.query(
    `SELECT LOWER(TRIM(email)) AS email FROM employees
     WHERE status = 'active' AND LOWER(TRIM(department)) = LOWER('Kế Toán Chi')`);
  return { companyEmails, purchasingEmails: new Set(rows.map((r) => r.email)) };
}
