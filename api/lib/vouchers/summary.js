// api/lib/vouchers/summary.js — getVoucherSummary result from voucher rows (pure).
// Mirrors GAS handleGetVoucherSummaryFromCurrent_ (TLCG_CASH_BACKEND.gs) with
// visibility generalised to per-company flows (compat.shouldShow).
import { bucket, shouldShow } from './compat.js';

/** GAS formatTimestamp: "DD/MM/YYYY HH:mm" in Vietnam time. */
export function formatTimestamp(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/**
 * rows: vouchers rows (voucher_number, voucher_type, company_name, employee_name,
 *   requestor_email, amount, status, last_action, updated_at, progress_done,
 *   progress_total, approver_emails, current_approver)
 * caller: { email, isAdmin }  callerApproverRole: precomputed legacy role
 */
export function summarize(rows, caller, callerApproverRole = 'submitter') {
  const vouchers = rows.map((r) => ({
    voucherNumber: r.voucher_number,
    voucherType: r.voucher_type || '',
    company: r.company_name || '',
    employee: r.employee_name || '',
    requestorEmail: r.requestor_email || '',
    amount: Number(r.amount) || 0,
    status: r.status || '',
    action: r.last_action || '',
    timestamp: r.updated_at ? new Date(r.updated_at) : new Date(0),
    done: r.progress_done || 0,
    total: r.progress_total || 3,
    approverEmails: r.approver_emails || [],
    pendingEmails: r.pending_emails || [],
    currentApprover: r.current_approver || null,
  })).sort((a, b) => b.timestamp - a.timestamp);
  const me = String((caller && caller.email) || '').toLowerCase();

  const visible = vouchers.filter((v) => shouldShow(v, caller));
  const isRejected = (v) => v.status === 'Rejected' || v.status === 'Đã từ chối';

  const recent = visible.map((v) => ({
    voucherNumber: v.voucherNumber,
    voucherType: v.voucherType,
    company: v.company,
    employee: v.employee,
    requestorEmail: v.requestorEmail,
    amount: v.amount,
    status: v.status,
    action: v.action,
    timestamp: v.timestamp.toISOString(),
    timestampFormatted: formatTimestamp(v.timestamp),
    meta: {
      companyApprovers: {
        approvalProgress: `${v.done}/${v.total}`,
        currentApprover: v.done < v.total && !isRejected(v) ? v.currentApprover : null,
      },
    },
    // Step-aware pages: is the caller one of the approvers the voucher waits for now?
    myTurn: !!me && !isRejected(v) && v.pendingEmails.includes(me),
    approvalTotal: v.total,
  }));

  let globalStats = null;
  if (caller && caller.isAdmin) {
    const gs = { pending: 0, s1: 0, s2: 0, s3: 0, approved: 0, acknowledged: 0, rejected: 0, overdue: 0, total: vouchers.length };
    const nowMs = Date.now();
    for (const v of vouchers) {
      const b = bucket(v);
      if (b === 'rejected') { gs.rejected += 1; continue; }
      if (b === 'acknowledged') { gs.acknowledged += 1; continue; }
      if (b === 'approved') { gs.approved += 1; gs.s3 += 1; continue; } // GAS counts finished ones in s3 too
      if (v.done === 0) gs.pending += 1;
      else if (v.done === 1) gs.s1 += 1;
      else if (v.done === 2) gs.s2 += 1;
      else gs.s3 += 1;
      if (nowMs - v.timestamp.getTime() > 2 * 24 * 60 * 60 * 1000) gs.overdue += 1;
    }
    globalStats = gs;
  }

  return {
    total: visible.length,
    pending: visible.filter((v) => v.done === 0 && !isRejected(v)).length,
    approved: visible.filter((v) => (v.total && v.done >= v.total) || v.status === 'Received').length,
    rejected: visible.filter(isRejected).length,
    recent,
    callerApproverRole,
    globalStats,
  };
}
