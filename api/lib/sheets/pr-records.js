// api/lib/sheets/pr-records.js — Postgres PR changes → Purchase_Request_History / PR_Audit_Log rows (pure).
// Header facts (live export 2026-10-06): 20 base columns + row_type/event_* repeated 5× (only the first
// group is ever read; rowForHeader fills first occurrences only). PR rows are upserted on pr_no + row_type,
// so legacy event rows of the same PR are never overwritten. Times are ISO text, as GAS wrote them.
import { metadataJson } from './voucher-records.js';

/** Target spreadsheet for the PR copy. No default; read at call time. */
export const p2pSpreadsheetId = () => String(process.env.P2P_SPREADSHEET_ID || '').trim();
export const PR_TAB = 'Purchase_Request_History';
export const AUDIT_TAB = 'PR_Audit_Log';
export const PR_KEY = 'pr_no,row_type';

// Never throws (a bad date must not fail the action); a Date or ISO string → ISO text.
const iso = (t) => { const d = t ? new Date(t) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''; };

export function prRecord(row) {
  return {
    pr_no: row.pr_no, company_name: row.company_name || '', company_key: row.company_key || '', department: row.department || '',
    requester_name: row.requester_name || '', required_date: row.required_date || '', priority: row.priority || '',
    purpose: row.purpose || '', suggested_vendor: row.vendor_name || '', budget_code: row.budget_code || '',
    budget_approver_email: row.budget_approver_email || '', supplier_approver_email: row.supplier_approver_email || '',
    items_json: JSON.stringify(row.items || []), grand_total: Number(row.grand_total) || 0, status: row.status || '',
    submitted_at: iso(row.submitted_at), metadata_json: metadataJson(row.metadata || {}),
    contract_approver_email: row.contract_approver_email || '', purchasing_approver_email: row.purchasing_approver_email || '',
    attachment_urls: (row.attachments || []).filter((a) => a && a.fileUrl).map((a) => a.fileUrl).join(', '),
    row_type: 'submit',
  };
}

export function auditRecord(e) {
  return {
    document_no: e.docNo, flow: 'PR', company_name: e.company || '', action: e.action, role: e.role || '',
    actor_email: String(e.actorEmail || '').trim().toLowerCase(), actor_name: e.actorName || '',
    prev_status: e.prevStatus || '', new_status: e.newStatus || '', timestamp: iso(e.at) || new Date().toISOString(),
    note: e.note || '', extra_json: e.extra && Object.keys(e.extra).length ? JSON.stringify(e.extra) : '',
  };
}
