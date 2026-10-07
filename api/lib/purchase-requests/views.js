// api/lib/purchase-requests/views.js — Postgres rows → the shapes the PR pages read (pure).
import { approvalState, isComplete, isRejected } from './state.js';
import { coreCellValue, MASTER_TABLES } from '../master-registry.js';

const iso = (t) => (t ? new Date(t).toISOString() : '');
const lower = (s) => String(s || '').trim().toLowerCase();

/** GAS prListCardFromRow_ keys + `items` (JSON string; acceptance_minutes.html parses it, B7). Metadata read for every row (B5). */
export function cardFromRow(row) {
  const meta = row.metadata || {};
  const status = row.status || '';
  const requesterEmail = lower(row.requester_email || meta.requesterEmail);
  const e = (k) => lower(row[k]);
  return {
    prNo: row.pr_no, company: row.company_name || '', department: row.department || '', requesterName: row.requester_name || '',
    requesterEmail, requestorEmail: requesterEmail, requiredDate: row.required_date || '', priority: row.priority || '',
    purpose: row.purpose || '', suggestedVendor: row.vendor_name || '', grandTotal: Number(row.grand_total) || 0, status,
    submittedAt: iso(row.submitted_at),
    budgetApprover: e('budget_approver_email'), supplierApprover: e('supplier_approver_email'),
    contractApprover: e('contract_approver_email'), purchasingApprover: e('purchasing_approver_email'),
    budgetApproverEmail: e('budget_approver_email'), supplierApproverEmail: e('supplier_approver_email'),
    contractApproverEmail: e('contract_approver_email'), purchasingApproverEmail: e('purchasing_approver_email'),
    budgetStatus: meta.budgetStatus || '', supplierStatus: meta.supplierStatus || '',
    contractStatus: meta.contractStatus || '', purchasingStatus: meta.purchasingStatus || '',
    activeStage: isComplete(status) ? 'complete' : isRejected(status) ? 'rejected' : approvalState(row, meta).stage,
    purchaseType: row.purchase_type || meta.purchaseType || 'goods', p2pBranch: row.p2p_branch || meta.p2pBranch || 'full',
    hasAttachments: (row.attachments || []).some((a) => a && a.fileUrl),
    items: JSON.stringify(row.items || []),
  };
}

/** GAS prFullFromRow_: items and metadata are strings (purchase_request.html JSON.parses them). */
export function fullFromRow(row) {
  return {
    ...cardFromRow(row),
    metadata: JSON.stringify(row.metadata || {}),
    attachmentUrls: (row.attachments || []).filter((a) => a && a.fileUrl).map((a) => a.fileUrl).join(', '),
    budgetCode: row.budget_code || '',
  };
}

export function historyEntry(a) {
  const extra = a.extra && Object.keys(a.extra).length ? JSON.stringify(a.extra) : '';
  return { action: a.action, role: a.role || '', actorEmail: a.actor_email || '', actorName: a.actor_name || '',
    prevStatus: a.prev_status || '', newStatus: a.new_status || '', timestamp: iso(a.created_at), note: a.note || '', metaJson: extra };
}

/** One Goods-KTT row keyed by its sheet headers, typed cells shown the way the sheet wrote them. */
export function goodsRecord(headers, row, core) {
  const extra = row.extra || {};
  return Object.fromEntries(headers.map((h) => [h, core[h] ? coreCellValue(core[h], extra[h], row[core[h].col]) : String(extra[h] ?? '')]));
}

/** GAS addSupplier values, keyed by the Master Vendor headers that exist (others are dropped). */
const VENDOR_TYPES = MASTER_TABLES.vendors.rules['Vendor Type'].values;
/** A value the Master Vendor 'Vendor Type' rule allows (case-insensitive match), else 'Others'. */
const vendorType = (t) => VENDOR_TYPES.find((v) => v.toLowerCase() === lower(t)) || 'Others';

export function supplierExtra(b, known) {
  const s = (k) => String(b[k] ?? '').trim();
  const all = { Vendor_Full_Name: s('name'), 'Vendor Type': vendorType(s('companyType')), 'Tax ID': s('taxCode'), Address: s('address'),
    'Payment Currency': 'VND', Contact_phone: s('phone'), Email_lien_he: s('email'), Dia_chi_lien_he: s('address'), Active: 'Yes' };
  return Object.fromEntries(Object.entries(all).filter(([k]) => known.has(k)));
}

export const likePattern = (q) => '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
