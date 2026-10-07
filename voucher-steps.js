/**
 * voucher-steps.js — Step-aware helpers for the voucher pages.
 *
 * Answers from Postgres carry an approval plan (any number of steps, group
 * steps) and per-row `myTurn`; answers from Google Apps Script do not. Every
 * helper falls back to today's fixed 3-step behaviour when those fields are
 * missing, so the pages work the same in both modes.
 * Loaded by voucher.html (and approve/reject pages); also require()-able in Node for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoucherSteps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /** "d/N" (or GAS "d/3") → { done, total }. Accepts a string, a summary row or statusData. */
  function progress(src) {
    var text = typeof src === 'string' ? src
      : (src && ((src.meta && src.meta.companyApprovers && src.meta.companyApprovers.approvalProgress) || src.approvalProgress)) || '0/3';
    var parts = String(text).split('/');
    var done = parseInt(parts[0], 10) || 0;
    var total = parseInt(parts[1], 10) || (src && src.approvalTotal) || 3;
    return { done: done, total: total, percent: total ? Math.min(100, Math.round(done / total * 100)) : 0, text: done + '/' + total };
  }

  /** True when the row came from the Postgres engine (has myTurn / a plan). */
  function onPostgres(v) {
    return !!v && (typeof v.myTurn === 'boolean' || !!v.approvalPlan || !!(v.meta && v.meta.approvalPlan));
  }

  function planOf(v) {
    return (v && (v.approvalPlan || (v.meta && v.meta.approvalPlan))) || null;
  }

  /** Is `email` one of the approvers the plan waits for right now? */
  function isPendingFor(plan, email) {
    if (!plan || !email || plan.status === 'approved' || plan.status === 'rejected') return false;
    var e = String(email).trim().toLowerCase();
    for (var i = 0; i < plan.steps.length; i++) {
      var s = plan.steps[i];
      if (s.status === 'approved') continue;
      return s.approvers.some(function (a) { return a.email === e && a.status !== 'approved'; });
    }
    return false;
  }

  function fmtTime(at) {
    if (!at) return '';
    var d = new Date(at);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  }

  /**
   * The approval sequence as HTML: one card per step, every approver in a
   * group step, ✅ approved / ⏳ waiting now / • later / ✖ rejected.
   */
  function stepsHtml(plan) {
    if (!plan || !plan.steps) return '';
    var open = -1;
    if (plan.status !== 'approved' && plan.status !== 'rejected') {
      for (var i = 0; i < plan.steps.length; i++) { if (plan.steps[i].status !== 'approved') { open = i; break; } }
    }
    var rej = plan.rejectedBy || null;
    return plan.steps.map(function (s, i) {
      var group = s.approvers.length > 1;
      var rows = s.approvers.map(function (a) {
        var rejected = plan.status === 'rejected' && rej && rej.email === a.email && i === (open < 0 ? firstOpen(plan) : open);
        var icon = a.status === 'approved' ? '✅' : rejected ? '✖' : i === open ? '⏳' : '•';
        var state = a.status === 'approved' ? 'Đã duyệt ' + fmtTime(a.at)
          : rejected ? 'Đã từ chối' + (rej.reason ? ': ' + rej.reason : '')
          : i === open ? 'Đang chờ phê duyệt' : 'Chưa đến lượt';
        return '<div style="display:flex;gap:.5rem;align-items:flex-start;padding:.25rem 0;">' +
          '<span aria-hidden="true">' + icon + '</span><div><div style="font-weight:600;color:#0f172a;">' +
          esc(a.label ? a.label + ' · ' : '') + esc(a.name || a.email) + '</div>' +
          '<div style="font-size:.75rem;color:' + (rejected ? '#b91c1c' : '#64748b') + ';">' + esc(state) + '</div></div></div>';
      }).join('');
      var active = i === open;
      return '<div style="border:1px solid ' + (active ? '#93c5fd' : '#e2e8f0') + ';background:' + (active ? '#eff6ff' : '#fff') +
        ';border-radius:10px;padding:.75rem 1rem;">' +
        '<div style="display:flex;justify-content:space-between;gap:.5rem;font-size:.8125rem;color:#475569;margin-bottom:.25rem;">' +
        '<strong>Bước ' + (i + 1) + ': ' + esc(s.name || '') + '</strong>' +
        (group ? '<span style="font-size:.6875rem;font-weight:700;color:#4f46e5;">Tất cả phải duyệt</span>' : '') + '</div>' +
        rows + '</div>';
    }).join('<div style="text-align:center;color:#94a3b8;line-height:1;">↓</div>');
  }

  function firstOpen(plan) {
    for (var i = 0; i < plan.steps.length; i++) if (plan.steps[i].status !== 'approved') return i;
    return -1;
  }

  /** Who the voucher waits for now, as "Kế toán trưởng · Nguyễn Thị Nhanh, …". */
  function waitingText(plan) {
    var i = firstOpen(plan);
    if (i < 0 || plan.status === 'rejected') return '';
    return plan.steps[i].approvers.filter(function (a) { return a.status !== 'approved'; })
      .map(function (a) { return (a.label ? a.label + ' · ' : '') + (a.name || a.email); }).join(', ');
  }

  return { progress: progress, onPostgres: onPostgres, planOf: planOf, isPendingFor: isPendingFor, stepsHtml: stepsHtml, waitingText: waitingText, esc: esc };
});
