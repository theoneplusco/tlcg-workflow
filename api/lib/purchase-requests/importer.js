// api/lib/purchase-requests/importer.js — Purchase_Request_History / _Archive / PR_Audit_Log → Postgres.
// Re-runnable: rows created or changed in Postgres (imported_at null, or updated_at > imported_at) are never touched.
// Writes with insertPR/appendAudit directly, never recordChange: the data came from the Sheet, so nothing is
// queued for the Sheet copy (sheet_outbox). No pool here: the CLI (scripts/import-purchase-requests.js) passes one.
import { sheetTime } from '../sheets/voucher-records.js';
import { findCompany } from '../vouchers/repo.js';
import { STATUS, approverEmails, pendingEmails } from './state.js';
import { num } from './validate.js';
import { insertPR, replaceImportedPR, appendAudit } from './repo.js';
import { purchasingRequest } from './emails.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const parseJson = (s, fallback) => { try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; } };

/** Sheets sometimes turned the <input type=date> text into a Date cell: "5/28/2026" → "2026-05-28". */
export function normalizeRequiredDate(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : s;
}

/** GAS prLastActivity_: latest of submit, rejection, approvals, resubmit and every send back. */
export function lastActivity(submittedAt, meta = {}) {
  const sb = Array.isArray(meta.sentBackHistory) ? meta.sentBackHistory.map((h) => h && h.at) : [];
  const t = [submittedAt, meta.rejectedAt, meta.budgetApprovedAt, meta.supplierApprovedAt, meta.contractApprovedAt,
    meta.purchasingApprovedAt, meta.resubmittedAt, ...sb].map((s) => (s ? new Date(s).getTime() : NaN)).filter(Number.isFinite);
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
}

/** GAS prIsEventRow_: anything but row_type 'event' is a PR row (legacy rows have no row_type). */
export const isSubmitRow = (r) => (lower(r.row_type) || 'submit') === 'submit';

export function prFromSheetRow(r, { archived = false } = {}) {
  const meta = parseJson(r.metadata_json, {}) || {};
  const submittedAt = sheetTime(r.submitted_at) || sheetTime(meta.submittedAt);
  const attachments = Array.isArray(meta.attachments)
    ? meta.attachments.map((a) => ({ fileName: a.fileName || '', fileUrl: a.fileUrl || '', ...(a.error ? { error: a.error } : {}) }))
    : String(r.attachment_urls || '').split(',').map((u) => u.trim()).filter(Boolean)
      .map((u) => ({ fileName: u.split('/').pop(), fileUrl: u }));
  const row = {
    pr_no: r.pr_no, company_name: r.company_name || '', company_key: r.company_key || '', department: r.department || '',
    requester_name: r.requester_name || '', requester_email: lower(meta.requesterEmail), required_date: normalizeRequiredDate(r.required_date),
    priority: r.priority || 'Bình Thường', purpose: r.purpose || '', vendor_name: r.suggested_vendor || '', budget_code: r.budget_code || '',
    budget_approver_email: lower(r.budget_approver_email), supplier_approver_email: lower(r.supplier_approver_email),
    contract_approver_email: lower(r.contract_approver_email), purchasing_approver_email: lower(r.purchasing_approver_email),
    items: parseJson(r.items_json, []), grand_total: num(r.grand_total), currency: 'VND', status: r.status || '',
    p2p_branch: meta.p2pBranch || 'full', purchase_type: meta.purchaseType || 'goods', attachments, metadata: meta,
    submitted_at: submittedAt, sheet_row: r.sheetRow,
  };
  row.badTotal = !Number.isFinite(row.grand_total); // not a column: reported in stats.badTotals
  if (row.badTotal) row.grand_total = 0;
  row.approver_emails = approverEmails(row);
  row.pending_emails = pendingEmails(row, meta, row.status);
  const last = lastActivity(submittedAt, meta) || submittedAt;
  row.updated_at = last;
  row.archived_at = archived ? last : null;
  return row;
}

export function auditFromSheetRow(r) {
  return { docNo: r.document_no, company: r.company_name || '', action: r.action, role: r.role || '', actorEmail: lower(r.actor_email),
    actorName: r.actor_name || '', prevStatus: r.prev_status || '', newStatus: r.new_status || '', at: sheetTime(r.timestamp),
    note: r.note || '', extra: parseJson(r.extra_json, {}) || {}, source: 'sheet', sheetRow: r.sheetRow };
}

export function auditFromEventRow(r) {
  return { docNo: r.pr_no, company: '', action: r.event_action, role: r.event_role || '', actorEmail: lower(r.event_actor_email),
    actorName: r.event_actor_name || '', prevStatus: r.event_prev_status || '', newStatus: r.event_new_status || '',
    at: sheetTime(r.event_timestamp), note: r.event_note || '',
    extra: { ...(parseJson(r.event_metadata_json, {}) || {}), fromEventRow: true }, source: 'sheet-event', sheetRow: r.sheetRow };
}

const auditKey = (doc, action, email, at) => [doc, action, lower(email), new Date(at).toISOString()].join('\u0000');

/**
 * One transaction for the whole import (dry run = ROLLBACK). Returns counts for the report.
 * - The working sheet wins over the archive for the same number.
 * - A number already in Postgres is replaced only if this importer wrote it and it has not changed since
 *   (updated_at <= imported_at); otherwise it is counted in skippedNative and left alone.
 * - PR_Audit_Log rows (source 'sheet') and legacy event rows (source 'sheet-event', only for numbers with no
 *   audit row, GAS's fallback) are deleted and re-inserted; 'app' audit rows are never touched. A Sheet audit row
 *   that is the Sheet copy of an 'app' row (same doc_no, action, actor email, time) is skipped (auditSkippedApp).
 * - Companies are matched like vouchers (findCompany). No match → company_id NULL, listed in unmatchedCompanies.
 * - notifyPurchasing (switch day, once): queue the purchasing email for non-archived simplified PRs waiting at
 *   Mua hàng (GAS bug B2 never sent it) and stamp metadata.importNotifiedAt so a re-run never re-sends.
 */
export async function importPurchaseRequests(db, { working = [], archive = [], audit = [], poTypes = null, dryRun = false, notifyPurchasing = false }) {
  const stats = { prs: 0, archived: 0, skippedNative: 0, noCompany: 0, unmatchedCompanies: [], badTotals: [], audit: 0,
    auditSkippedApp: 0, eventAudit: 0, poTypes: 0, notified: 0, byStatus: {}, atPurchasing: { simplified: 0, full: 0 } };
  const prs = new Map();
  for (const r of archive) if (r.pr_no && isSubmitRow(r)) prs.set(r.pr_no, prFromSheetRow(r, { archived: true }));
  for (const r of working) if (r.pr_no && isSubmitRow(r)) prs.set(r.pr_no, prFromSheetRow(r)); // working sheet wins
  const auditEntries = audit.filter((r) => r.document_no).map(auditFromSheetRow);
  const withAudit = new Set(auditEntries.map((e) => e.docNo));
  const eventEntries = [...working, ...archive].filter((r) => r.pr_no && !isSubmitRow(r) && !withAudit.has(r.pr_no)).map(auditFromEventRow);
  const unmatched = new Map();

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const pr of prs.values()) {
      const old = (await client.query(
        'SELECT id, imported_at, updated_at, metadata FROM purchase_requests WHERE pr_no = $1 FOR UPDATE', [pr.pr_no])).rows[0];
      if (old && (!old.imported_at || old.updated_at > old.imported_at)) { stats.skippedNative += 1; continue; }
      const company = await findCompany(client, pr.company_name, pr.company_key);
      if (!company) {
        stats.noCompany += 1;
        const k = `${pr.company_name}\u0000${pr.company_key}`;
        if (!unmatched.has(k)) unmatched.set(k, { name: pr.company_name, key: pr.company_key, prs: [] });
        unmatched.get(k).prs.push(pr.pr_no);
      }
      const notifiedAt = old && old.metadata && old.metadata.importNotifiedAt;
      const metadata = notifiedAt ? { ...pr.metadata, importNotifiedAt: notifiedAt } : pr.metadata;
      const rec = { ...pr, metadata, company_id: company ? company.id : null };
      let row;
      if (old) row = await replaceImportedPR(client, old.id, rec); // keeps id and created_at
      else {
        row = await insertPR(client, rec);
        await client.query('UPDATE purchase_requests SET imported_at = clock_timestamp() WHERE id = $1', [row.id]);
      }
      if (pr.badTotal) stats.badTotals.push(pr.pr_no);
      stats.prs += 1;
      if (pr.archived_at) stats.archived += 1;
      stats.byStatus[pr.status] = (stats.byStatus[pr.status] || 0) + 1;
      const waiting = !pr.archived_at && pr.status === STATUS.PURCHASING;
      if (waiting) stats.atPurchasing[pr.p2p_branch === 'simplified' ? 'simplified' : 'full'] += 1;
      if (notifyPurchasing && !notifiedAt && waiting && pr.p2p_branch === 'simplified') {
        const m = purchasingRequest(row);
        if (m) {
          // Directly, not queueMail (which swallows errors and would leave the transaction aborted): a failure
          // here fails the whole import with its real cause.
          await client.query(`INSERT INTO email_queue (to_email, cc, reply_to, subject, body_html, body_text, status)
                              VALUES ($1, '', '', $2, $3, '', 'pending')`, [m.to, m.subject, m.html || '']);
          await client.query(`UPDATE purchase_requests SET metadata = metadata || jsonb_build_object('importNotifiedAt', NOW()::text) WHERE id = $1`, [row.id]);
          stats.notified += 1;
        }
      }
    }
    stats.unmatchedCompanies = [...unmatched.values()];
    await client.query(`DELETE FROM pr_audit_log WHERE source IN ('sheet', 'sheet-event')`);
    const appKeys = new Set((await client.query(
      `SELECT doc_no, action, LOWER(actor_email) AS email, created_at FROM pr_audit_log WHERE source = 'app'`)).rows
      .map((a) => auditKey(a.doc_no, a.action, a.email, a.created_at)));
    for (const e of auditEntries) {
      if (e.at && appKeys.has(auditKey(e.docNo, e.action, e.actorEmail, e.at))) { stats.auditSkippedApp += 1; continue; }
      await appendAudit(client, e);
      stats.audit += 1;
    }
    for (const e of eventEntries) { await appendAudit(client, e); stats.eventAudit += 1; }
    if (poTypes) {
      await client.query('DELETE FROM purchase_order_types');
      for (const t of poTypes.filter((x) => String(x.type || '').trim())) {
        await client.query('INSERT INTO purchase_order_types (no, type, sheet_row) VALUES ($1, $2, $3)', [t.no || '', t.type.trim(), t.sheetRow]);
        stats.poTypes += 1;
      }
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  return stats;
}
