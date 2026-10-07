// api/lib/sheets/voucher-records.js — Postgres voucher changes → Voucher_History / Voucher_Current rows.
// Inverse of scripts/import-vouchers.js. The spreadsheet's time zone is GMT; times are written as
// "yyyy-MM-dd HH:mm:ss" text (USER_ENTERED turns them into date cells, as GAS wrote them).
// Live headers (exported 2026-10-06):
//   Voucher_History: voucher_number,voucher_type,company_name,company_key,employee_name,submitted_email,submitted_by,
//     submitted_at,amount,status,due_date,action,attachments,description,note,approver_email,approved_at,metadata_json,
//     acknowledged_at,acknowledged_by,signature_url,rejection_reason
//   Voucher_Current: voucherNumber,voucherType,company,companyKey,employee,requestorEmail,submittedBy,amount,status,
//     action,submittedAt,dueDate,approvalProgress,lastUpdated
import { toAmount } from '../vouchers/repo.js';

export const VOUCHER_SPREADSHEET_ID = process.env.VOUCHER_SPREADSHEET_ID || '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g';
export const HISTORY_TAB = 'Voucher_History';
export const CURRENT_TAB = 'Voucher_Current';
export const CURRENT_KEY = 'voucherNumber';

/**
 * Sheet time → ISO UTC; null if empty/unknown. Accepts "3/27/2026 16:13:27", "3/27/2026",
 * "2026-03-27 16:13:27" (our own text) or ISO. Sheet "8/28/2026 3:48:37" is GMT (GAS shows 10:48 VN).
 */
const SHEET_UTC_OFFSET_HOURS = 0;
export function sheetTime(s) {
  const v = String(s || '').trim();
  if (!v) return null;
  const us = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const iso = !us && v.match(/^(\d{4})-(\d{2})-(\d{2})\s(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (us || iso) {
    const [y, mo, d, h = '0', mi = '0', se = '0'] = us ? [us[3], us[1], us[2], ...us.slice(4)] : iso.slice(1);
    return new Date(Date.UTC(+y, +mo - 1, +d, +h - SHEET_UTC_OFFSET_HOURS, +mi, +se)).toISOString();
  }
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

/** Date | ISO string → "yyyy-MM-dd HH:mm:ss" GMT ('' if empty). Inverse of sheetTime. */
export function sheetTimeText(d) {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(t.getTime())) return '';
  return new Date(t.getTime() + SHEET_UTC_OFFSET_HOURS * 3600000).toISOString().slice(0, 19).replace('T', ' ');
}

// Base64 signatures make metadata too big for one cell (50,000 chars); Postgres keeps them.
const META_LIMIT = 45000;
const STORED = '[đã lưu trong hệ thống]';
function metadataJson(meta) {
  const full = JSON.stringify(meta || {});
  if (full.length <= META_LIMIT) return full; // verbatim when it fits, as GAS wrote it
  return JSON.stringify(meta, (k, v) => (typeof v === 'string' && v.startsWith('data:') ? STORED : v));
}

/** One Voucher_History row. `at` = when this event happened (defaults to approvedAt / acknowledgedAt). */
export function historyRecord(h, at = h.approvedAt || h.acknowledgedAt || new Date()) {
  return {
    voucher_number: h.voucherNumber, voucher_type: h.voucherType || '', company_name: h.company || '',
    company_key: h.companyKey || '', employee_name: h.employee || '', submitted_email: h.requestorEmail || '',
    submitted_by: h.submittedBy || '', submitted_at: sheetTimeText(at), amount: toAmount(h.amount),
    status: h.status || '', due_date: h.dueDate || '', action: h.action || '', attachments: h.attachments || '',
    description: h.description || '', note: h.note || '', approver_email: h.approverEmail || '',
    approved_at: sheetTimeText(h.approvedAt), metadata_json: metadataJson(h.meta),
    acknowledged_at: sheetTimeText(h.acknowledgedAt), acknowledged_by: h.acknowledgedBy || '',
    signature_url: h.signatureUrl || '', rejection_reason: h.rejectionReason || '',
  };
}

/**
 * One Voucher_Current row (upserted by voucherNumber), as GAS upsertVoucherCurrent_ wrote it:
 * submittedAt = original submission, lastUpdated = this event, approvalProgress = done count (an
 * integer — "1/3" would become a date in Sheets).
 */
export function currentRecord(h, { submittedAt, progressDone, at }) {
  return {
    voucherNumber: h.voucherNumber, voucherType: h.voucherType || '', company: h.company || '',
    companyKey: h.companyKey || '', employee: h.employee || '', requestorEmail: h.requestorEmail || '',
    submittedBy: h.submittedBy || h.employee || '', amount: toAmount(h.amount), status: h.status || '',
    action: h.action || '', submittedAt: sheetTimeText(submittedAt), dueDate: h.dueDate || '',
    approvalProgress: Number(progressDone) || 0, lastUpdated: sheetTimeText(at),
  };
}
