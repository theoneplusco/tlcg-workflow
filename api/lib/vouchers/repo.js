// api/lib/vouchers/repo.js — Voucher storage helpers shared by the handlers and the import.
import { planFromCompanyApprovers, legacyCompanyApprovers, planIndex } from './compat.js';

/** "1.500.000", "1,500,000", 1500000 → 1500000 (the sheet stored whatever the page sent). */
export function toAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v || '').trim();
  if (!s) return 0;
  // Vietnamese thousands use "." ; plain digits with "," thousands also occur
  const n = Number(s.replace(/[.\s₫đ]/gi, '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export async function findCompany(db, name, key) {
  const n = String(name || '').trim();
  const k = String(key || '').trim();
  if (!n) return null;
  const { rows } = k
    ? await db.query(`SELECT * FROM companies WHERE company_name = $1 AND company_key = $2 LIMIT 1`, [n, k])
    : await db.query(`SELECT * FROM companies WHERE company_name = $1 ORDER BY id LIMIT 1`, [n]);
  if (rows[0]) return rows[0];
  if (k) {
    // Key typed differently on old vouchers: try the name alone
    const byName = await db.query(`SELECT * FROM companies WHERE company_name = $1 ORDER BY id LIMIT 1`, [n]);
    if (byName.rows[0]) return byName.rows[0];
  }
  // Company renamed in Master Data since (e.g. RIOT's full legal name): the key, if it is unique
  if (!k) return null;
  const byKey = await db.query(`SELECT * FROM companies WHERE company_key = $1 LIMIT 2`, [k]);
  return byKey.rows.length === 1 ? byKey.rows[0] : null;
}

export async function employeesByEmail(db) {
  const { rows } = await db.query(`SELECT LOWER(email) AS email, full_name FROM employees WHERE status = 'active'`);
  return new Map(rows.map((r) => [r.email, r]));
}

/** Lock and load a voucher row inside a transaction. */
export async function lockVoucher(client, voucherNumber) {
  const { rows } = await client.query(`SELECT * FROM vouchers WHERE voucher_number = $1 FOR UPDATE`, [voucherNumber]);
  return rows[0] || null;
}

/** The voucher's plan: stored snapshot, else lifted from GAS-era companyApprovers. */
export function planOf(row) {
  const meta = row.metadata || {};
  if (meta.approvalPlan) return meta.approvalPlan;
  return planFromCompanyApprovers(meta.companyApprovers || {}, { companyId: row.company_id });
}

/** Plain voucher fields for emails / history rows. */
export function voucherView(row) {
  return {
    voucherNumber: row.voucher_number, voucherType: row.voucher_type, company: row.company_name,
    companyKey: row.company_key, employee: row.employee_name, requestorEmail: row.requestor_email,
    submittedBy: row.submitted_by, amount: Number(row.amount), description: row.description, dueDate: row.due_date,
  };
}

/** Persist a new plan/state on the vouchers row (keeps the legacy projection in sync). */
export async function saveState(client, row, { plan, meta, status, lastAction }) {
  const idx = planIndex(plan);
  const ca = legacyCompanyApprovers(plan);
  meta.approvalPlan = plan;
  meta.companyApprovers = ca;
  await client.query(
    `UPDATE vouchers SET metadata = $1, status = $2, last_action = $3, approval_progress = $4,
            overall_status = $5, current_approver = $6, progress_done = $7, progress_total = $8,
            pending_emails = $9, approver_emails = $10, updated_at = NOW()
      WHERE id = $11`,
    [JSON.stringify(meta), status, lastAction, ca.approvalProgress, ca.overallStatus, ca.currentApprover || '',
      idx.done, idx.total, idx.pendingEmails, idx.approverEmails, row.id]
  );
}

/** Append one history row (the Voucher_History sheet columns). */
export async function appendHistory(client, h) {
  await client.query(
    `INSERT INTO voucher_history
       (voucher_number, voucher_type, company, company_key, employee, requestor_email, submitted_by,
        amount, status, due_date, action, attachments, description, note, approver_email, approved_at,
        metadata, acknowledged_at, acknowledged_by, signature_url, rejection_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [h.voucherNumber, h.voucherType || '', h.company || '', h.companyKey || '', h.employee || '', h.requestorEmail || '',
      h.submittedBy || '', toAmount(h.amount), h.status || '', h.dueDate || '', h.action || '', h.attachments || '',
      h.description || '', h.note || '', h.approverEmail || '', h.approvedAt || null, JSON.stringify(h.meta || {}),
      h.acknowledgedAt || null, h.acknowledgedBy || '', h.signatureUrl || '', h.rejectionReason || '']
  );
}

export async function audit(client, e) {
  try {
    await client.query(
      `INSERT INTO voucher_audit_log (doc_no, flow, company, action, role, actor_email, actor_name, prev_status, new_status, note, extra)
       VALUES ($1, 'VCH', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [e.docNo, e.company || '', e.action, e.role || '', e.actorEmail || '', e.actorName || '',
        e.prevStatus || '', e.newStatus || '', e.note || '', JSON.stringify(e.extra || {})]
    );
  } catch (err) {
    console.error('[VoucherAudit] non-fatal:', err.message); // audit must never break the flow
  }
}
