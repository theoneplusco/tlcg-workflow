// cash-overview.js — index.html › Thu chi – Sổ quỹ › Tổng quan (design "Cash & Vouchers pages", 2026-10-09).
// Draws #cash-overview from what the page already loads: getVoucherSummary (vouchers), getCompanies, and for one
// company getCashBook + getRecentCashCounts. Styles: ui-kit.css. Labels follow the EN/VI switch.
// index.html calls loadCashSummary() each time the page opens (showPage('process-cash')).
(function (root) {
  'use strict';

  var TXT = {
    vi: {
      crumbHome: 'Trang chủ', crumbFlows: 'Quy trình', title: 'Thu chi – Sổ quỹ', sub: 'Phiếu thu, phiếu chi và sổ quỹ tiền mặt của các công ty',
      company: 'Công ty', allCompanies: 'Tất cả công ty', openBook: 'Mở sổ quỹ', newVoucher: 'Phiếu thu/chi mới',
      mine: 'Cần bạn xử lý', oldestFirst: 'cũ nhất trước', allMine: 'Xem tất cả việc của tôi →', view: 'Xem', approve: 'Duyệt', step: 'Bước',
      waitedDays: 'Đã chờ {n} ngày', sentAgo: 'Gửi {t} trước', hours: '{n} giờ', minutes: '{n} phút', receipt: 'Phiếu thu', payment: 'Phiếu chi',
      kPending: 'Đang chờ duyệt', kApproved: 'Đã duyệt', ofTotal: 'trên tổng {n} phiếu', rejectedN: '{n} bị từ chối',
      kUnbooked: 'Chưa vào sổ quỹ (đang duyệt)', toBook: 'Xem ở Sổ Quỹ →', kBalance: 'Tồn quỹ tiền mặt', pickCompany: 'Chọn một công ty',
      perCompany: 'Mỗi công ty có sổ quỹ riêng', toToday: 'đến hôm nay', recent: 'Phiếu gần đây', updated: 'cập nhật {t}',
      search: 'Số phiếu, người, công ty…', tAll: 'Tất cả', tMine: 'Việc của tôi', tPending: 'Chờ duyệt', tApproved: 'Đã duyệt', tRejected: 'Từ chối',
      cNo: 'Số phiếu', cReason: 'Lý do · công ty', cBy: 'Người đề nghị', cAmount: 'Số tiền', cStatus: 'Trạng thái', cWhen: 'Cập nhật',
      showing: '{a} / {b} phiếu · mới nhất trước', more: 'Hiện thêm', allVouchers: 'Xem tất cả phiếu →', none: 'Không có phiếu nào ở đây.',
      loading: 'Đang tải…', loadErr: 'Không tải được danh sách phiếu.', retry: 'Thử lại', refresh: 'Làm mới',
      count: 'Kiểm kê quỹ', countScope: 'Chọn công ty ở trên để xem biên bản', openCount: 'Mở Kiểm kê quỹ →',
      c1: 'Duyệt 1/3', c2: 'Duyệt 2/3', c3: 'Đã duyệt', r1: 'Người kiểm kê', r2: 'Kế toán trưởng', r3: 'Thủ quỹ',
      noCount: 'Chưa có biên bản', noCountSub: 'Đối chiếu tiền mặt với sổ quỹ', newCount: 'Lập biên bản', waitingFor: 'Đang chờ {n} ký',
      sPending: 'Chờ duyệt', sApproved: 'Đã duyệt', sReceived: 'Đã nhận tiền', sRejected: 'Từ chối', today: 'Hôm nay', yesterday: 'Hôm qua',
      bookErr: 'Không tải được sổ quỹ.',
    },
    en: {
      crumbHome: 'Dashboard', crumbFlows: 'Workflows', title: 'Cash & Vouchers', sub: 'Receipts, payments and the cash book of each company',
      company: 'Company', allCompanies: 'All companies', openBook: 'Open cash book', newVoucher: 'New voucher',
      mine: 'Waiting for you', oldestFirst: 'oldest first', allMine: 'All my tasks →', view: 'View', approve: 'Approve', step: 'Step',
      waitedDays: 'Waiting {n} days', sentAgo: 'Sent {t} ago', hours: '{n} h', minutes: '{n} min', receipt: 'Receipt', payment: 'Payment',
      kPending: 'Waiting for approval', kApproved: 'Approved', ofTotal: 'of {n} vouchers', rejectedN: '{n} rejected',
      kUnbooked: 'Not booked yet (in approval)', toBook: 'See them in the cash book →', kBalance: 'Cash balance', pickCompany: 'Choose a company',
      perCompany: 'Each company has its own cash book', toToday: 'through today', recent: 'Recent vouchers', updated: 'updated {t}',
      search: 'Number, person, company…', tAll: 'All', tMine: 'My tasks', tPending: 'Pending', tApproved: 'Approved', tRejected: 'Rejected',
      cNo: 'Number', cReason: 'Reason · company', cBy: 'Requested by', cAmount: 'Amount', cStatus: 'Status', cWhen: 'Updated',
      showing: '{a} of {b} · newest first', more: 'Show more', allVouchers: 'All vouchers →', none: 'No vouchers here.',
      loading: 'Loading…', loadErr: 'Could not load vouchers.', retry: 'Retry', refresh: 'Refresh',
      count: 'Cash count', countScope: 'Choose a company above to see its counts', openCount: 'Open cash count →',
      c1: 'Step 1/3', c2: 'Step 2/3', c3: 'Approved', r1: 'Counter', r2: 'Chief accountant', r3: 'Treasurer',
      noCount: 'No count yet', noCountSub: 'Check the cash against the book', newCount: 'New count', waitingFor: 'Waiting for {n}',
      sPending: 'Pending', sApproved: 'Approved', sReceived: 'Received', sRejected: 'Rejected', today: 'Today', yesterday: 'Yesterday',
      bookErr: 'Could not load the cash book.',
    },
  };
  var COMPANY_KEY = 'tlc_cash_company';
  var PAGE = 8;
  var RECEIVED = ['Received', 'Đã nhận'];
  var APPROVED = ['Approved', 'Đã duyệt', 'Fully Approved'];
  var REJECTED = ['Rejected', 'Đã từ chối'];

  var st = { loading: true, error: '', summary: null, companies: null, company: read(COMPANY_KEY), book: null, bookErr: '',
    counts: [], tab: 'all', q: '', limit: PAGE, at: null };
  var bound = false;

  // ── helpers ──────────────────────────────────────────────
  function read(k) { try { return root.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function lang() { return root.TLCI18n && root.TLCI18n.getLang() === 'en' ? 'en' : 'vi'; }
  function t(key, vars) {
    var s = (TXT[lang()] || TXT.vi)[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
    return s;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function money(n) { var v = Number(n); return isFinite(v) ? new Intl.NumberFormat('vi-VN').format(v) + ' đ' : '—'; }
  function me() {
    try { if (typeof currentUser !== 'undefined' && currentUser) return currentUser; } catch (e) { /* not defined */ }
    try { return JSON.parse(read('tlc_current_user') || 'null'); } catch (e) { return null; }
  }
  function apiUrl() {
    try { if (typeof GOOGLE_APPS_SCRIPT_WEB_APP_URL !== 'undefined') return GOOGLE_APPS_SCRIPT_WEB_APP_URL; } catch (e) { /* not defined */ }
    return '/api/voucher';
  }
  function post(payload) {
    return root.fetch(apiUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: JSON.stringify(payload) }),
    }).then(function (r) { return r.json(); });
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p.length > 1 ? p[0].charAt(0) + p[p.length - 1].charAt(0) : p[0].slice(0, 2)).toUpperCase();
  }
  // "CÔNG TY TNHH DỊCH VỤ RIOT GAMES" → "Dịch Vụ Riot Games" (the official name stays on the voucher itself)
  function shortCompany(name) {
    var s = String(name || '').replace(/^\s*(CÔNG TY|CTY)\s+(TNHH|CỔ PHẦN|CP)?\s*(MỘT THÀNH VIÊN|MTV)?\s*/i, '').trim() || String(name || '');
    return s.toLowerCase().replace(/(^|\s)(\S)/g, function (m, sp, ch) { return sp + ch.toUpperCase(); });
  }
  function companyCode(name) {
    var list = st.companies || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].name === name) return list[i].key;
    var m = /\(([^)]+)\)\s*$/.exec(name || '');
    return m ? m[1] : '';
  }
  function progress(v) {
    var raw = String((v.meta && v.meta.companyApprovers && v.meta.companyApprovers.approvalProgress) || '0/3').split('/');
    var done = parseInt(raw[0], 10) || 0;
    var total = parseInt(raw[1], 10) || Number(v.approvalTotal) || 3;
    return { done: done, total: total };
  }
  function stateOf(v) {
    var s = String(v.status || '');
    if (REJECTED.indexOf(s) !== -1 || v.action === 'Reject') return 'rejected';
    if (RECEIVED.indexOf(s) !== -1) return 'received';
    var p = progress(v);
    if (APPROVED.indexOf(s) !== -1 || p.done >= p.total) return 'approved';
    return 'pending';
  }
  function isThu(v) { return /thu/i.test(String(v.voucherType || '')) || /-PT\d/.test(String(v.voucherNumber || '')); }
  function vnParts(d) {
    var f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    var o = {}; f.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }
  function when(ts) {
    var d = new Date(ts || '');
    if (!isFinite(d.getTime())) return '';
    var p = vnParts(d), now = vnParts(new Date()), y = vnParts(new Date(Date.now() - 86400000));
    var hm = p.hour + ':' + p.minute;
    if (p.year === now.year && p.month === now.month && p.day === now.day) return t('today') + ' ' + hm;
    if (p.year === y.year && p.month === y.month && p.day === y.day) return t('yesterday') + ' ' + hm;
    return p.day + '/' + p.month + (p.year === now.year ? '' : '/' + p.year) + ' ' + hm;
  }
  function age(ts) {
    var ms = Date.now() - new Date(ts || '').getTime();
    if (!isFinite(ms) || ms < 0) return { text: '', late: false };
    var days = Math.floor(ms / 86400000);
    if (days >= 1) return { text: t('waitedDays', { n: days }), late: days >= 2 };
    var h = Math.floor(ms / 3600000);
    return { text: t('sentAgo', { t: h >= 1 ? t('hours', { n: h }) : t('minutes', { n: Math.max(1, Math.floor(ms / 60000)) }) }), late: false };
  }
  function selected() {
    var list = st.companies || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].name === st.company) return list[i];
    return null;
  }
  function bookHref(hash) {
    var c = selected();
    return 'cash_book.html' + (c ? '?company=' + encodeURIComponent(c.key || c.name) : '') + (hash || '');
  }
  var ICON = {
    cash: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/></svg>',
    book: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M8 9h8M8 13h6"/></svg>',
    plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    find: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    refresh: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6L20 8"/><path d="M20 3v5h-5"/></svg>',
    chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>',
  };

  // ── derived data ─────────────────────────────────────────
  function vouchers() {
    var list = (st.summary && st.summary.recent) || [];
    return st.company ? list.filter(function (v) { return v.company === st.company; }) : list;
  }
  function stats() {
    var list = vouchers(), out = { all: list.length, mine: 0, pending: 0, approved: 0, rejected: 0, steps: [] };
    list.forEach(function (v) {
      var s = stateOf(v);
      if (v.myTurn === true) out.mine += 1;
      if (s === 'pending') {
        out.pending += 1;
        var d = progress(v).done;
        out.steps[d] = (out.steps[d] || 0) + 1;
      } else if (s === 'rejected') out.rejected += 1;
      else out.approved += 1;
    });
    // Without a company filter the server's totals are the reference (GAS rows may be a subset)
    if (!st.company && st.summary && st.summary.total > out.all) out.all = st.summary.total;
    return out;
  }
  function filtered() {
    var q = st.q.trim().toLowerCase();
    return vouchers().filter(function (v) {
      var s = stateOf(v);
      if (st.tab === 'mine' && v.myTurn !== true) return false;
      if (st.tab === 'pending' && s !== 'pending') return false;
      if (st.tab === 'approved' && s !== 'approved' && s !== 'received') return false;
      if (st.tab === 'rejected' && s !== 'rejected') return false;
      if (!q) return true;
      return [v.voucherNumber, v.company, v.employee, v.reason].join(' ').toLowerCase().indexOf(q) !== -1;
    });
  }

  // ── markup ───────────────────────────────────────────────
  function typeMark(v) {
    var thu = isThu(v);
    return '<span class="uk-type ' + (thu ? 'uk-thu' : 'uk-chi') + '" title="' + esc(thu ? t('receipt') : t('payment')) + '" aria-label="' + esc(thu ? t('receipt') : t('payment')) + '">' + (thu ? '↓' : '↑') + '</span>';
  }
  function chip(v) {
    var s = stateOf(v), p = progress(v);
    if (s === 'pending') return '<span class="uk-chip uk-chip-pending">' + esc(t('sPending')) + ' · ' + p.done + '/' + p.total + '</span>';
    if (s === 'rejected') return '<span class="uk-chip uk-chip-rejected">' + esc(t('sRejected')) + '</span>';
    return '<span class="uk-chip uk-chip-approved">' + esc(s === 'received' ? t('sReceived') : t('sApproved')) + '</span>';
  }

  function headHtml() {
    var opts = '<option value="">' + esc(t('allCompanies')) + '</option>' + (st.companies || []).map(function (c) {
      return '<option value="' + esc(c.name) + '"' + (c.name === st.company ? ' selected' : '') + '>' + esc(shortCompany(c.name) + (c.key ? ' (' + c.key + ')' : '')) + '</option>';
    }).join('');
    return '<header class="uk-head">' +
      '<nav class="uk-crumb" aria-label="Breadcrumb"><a href="index.html" data-cx="home">' + esc(t('crumbHome')) + '</a><span aria-hidden="true">/</span><span>' + esc(t('crumbFlows')) + '</span><span aria-hidden="true">/</span><span aria-current="page">' + esc(t('title')) + '</span></nav>' +
      '<div class="uk-head-row"><div class="uk-title-wrap"><span class="uk-tile uk-tile-cash">' + ICON.cash + '</span><div><h1 class="uk-title">' + esc(t('title')) + '</h1><p class="uk-sub">' + esc(t('sub')) + '</p></div></div>' +
      '<div class="uk-actions"><label class="uk-field">' + esc(t('company')) + '<select class="uk-select" id="cx-company" style="min-width:190px">' + opts + '</select></label>' +
      '<a class="uk-btn uk-btn-ghost" href="' + esc(bookHref('')) + '">' + ICON.book + esc(t('openBook')) + '</a>' +
      '<a class="uk-btn uk-btn-primary" href="voucher.html">' + ICON.plus + esc(t('newVoucher')) + '</a></div></div></header>';
  }

  function mineHtml() {
    var list = vouchers().filter(function (v) { return v.myTurn === true; })
      .sort(function (a, b) { return new Date(a.timestamp) - new Date(b.timestamp); });
    if (!list.length) return '';
    var rows = list.slice(0, 5).map(function (v) {
      var p = progress(v), a = age(v.timestamp), thu = isThu(v), no = v.voucherNumber || '';
      var bars = '';
      for (var i = 0; i < p.total; i += 1) bars += '<span class="' + (i < p.done ? 'is-done' : i === p.done ? 'is-now' : '') + '"></span>';
      return '<div class="cx-mine-row">' +
        '<div class="cx-no">' + typeMark(v) + '<span class="uk-two"><span class="uk-num" style="font-weight:800">' + esc(no) + '</span><span style="font-weight:700;color:' + (thu ? '#166534' : '#9A4A07') + '">' + esc(thu ? t('receipt') : t('payment')) + '</span></span></div>' +
        '<div class="uk-two"><span class="uk-ellipsis" style="font-weight:700">' + esc(v.reason || shortCompany(v.company)) + '</span><span class="uk-ellipsis">' + esc(shortCompany(v.company) + ' · ' + (v.employee || '')) + '</span></div>' +
        '<span class="uk-num uk-right" style="font-size:15px;font-weight:800">' + esc(money(v.amount)) + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:6px;min-width:0"><span class="uk-ellipsis" style="font-size:13px;font-weight:700;color:#3A3833">' + esc(t('step') + ' ' + (p.done + 1) + '/' + p.total + (v.stepName ? ' · ' + v.stepName : '')) + '</span><span class="uk-bars">' + bars + '</span>' +
        '<span style="font-size:12px;font-weight:700;color:' + (a.late ? '#B45309' : '#6B6862') + '">' + esc(a.text) + '</span></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><a class="uk-btn uk-btn-ghost uk-btn-sm" href="voucher.html?viewStatus=' + encodeURIComponent(no) + '">' + esc(t('view')) + '</a>' +
        '<a class="uk-btn uk-btn-primary uk-btn-sm" href="voucher.html?approveVoucher=' + encodeURIComponent(no) + '">' + esc(t('approve')) + '</a></div></div>';
    }).join('');
    return '<section class="uk-card uk-card-blue" aria-labelledby="cx-mine"><div class="uk-card-head"><div style="display:flex;align-items:center;gap:10px">' +
      '<h2 class="uk-card-title" id="cx-mine" style="font-size:16px">' + esc(t('mine')) + '</h2><span class="uk-count">' + list.length + '</span><span class="uk-card-note" style="font-size:13px">· ' + esc(t('oldestFirst')) + '</span></div>' +
      (list.length > 5 ? '<button type="button" class="uk-link-btn" data-cx-tab="mine">' + esc(t('allMine')) + '</button>' : '') + '</div>' + rows + '</section>';
  }

  function kpisHtml() {
    var s = stats(), c = selected(), b = st.book;
    var stepTotal = s.steps.reduce(function (n, x) { return n + (x || 0); }, 0);
    var shades = ['#FCD34D', '#F59E0B', '#B45309', '#92400E', '#78350F'];
    var bar = '', legend = '';
    s.steps.forEach(function (n, i) {
      if (!n) return;
      bar += '<span style="flex:' + n + ';background:' + shades[Math.min(i, shades.length - 1)] + '"></span>';
      legend += '<span><b style="color:' + shades[Math.min(i, shades.length - 1)] + '">●</b> B' + (i + 1) + ' · ' + n + '</span>';
    });
    var pending = '<button type="button" class="uk-kpi' + (st.tab === 'pending' ? ' is-on' : '') + '" data-cx-tab="pending" aria-pressed="' + (st.tab === 'pending') + '">' +
      '<span class="uk-kpi-label">' + esc(t('kPending')) + '</span><span class="uk-kpi-value" style="color:#92400E">' + s.pending + '</span>' +
      (stepTotal ? '<span style="display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;width:100%">' + bar + '</span><span style="display:flex;gap:10px;font-size:12px;color:#5E5A53;white-space:nowrap;flex-wrap:wrap">' + legend + '</span>' : '') + '</button>';
    var approved = '<button type="button" class="uk-kpi' + (st.tab === 'approved' ? ' is-on' : '') + '" data-cx-tab="approved" aria-pressed="' + (st.tab === 'approved') + '">' +
      '<span class="uk-kpi-label">' + esc(t('kApproved')) + '</span><span class="uk-kpi-value" style="color:#166534">' + s.approved + '</span>' +
      '<span class="uk-kpi-note">' + esc(t('ofTotal', { n: s.all })) + (s.rejected ? ' · <span style="color:#991B1B;font-weight:700">' + esc(t('rejectedN', { n: s.rejected })) + '</span>' : '') + '</span></button>';
    var unbooked = '<div class="uk-kpi"><span class="uk-kpi-label">' + esc(t('kUnbooked')) + '</span>' +
      (c ? '<span class="uk-kpi-value">' + (b ? (b.pendingLines || []).length : '<span class="uk-skel" style="width:40px;height:26px"></span>') + '</span><a href="' + esc(bookHref('#pending')) + '" style="font-size:12px;font-weight:700">' + esc(t('toBook')) + '</a>'
        : '<span style="font-size:15px;font-weight:700;color:#5E5A53">' + esc(t('pickCompany')) + '</span><span class="uk-kpi-note">' + esc(t('perCompany')) + '</span>') + '</div>';
    var balance = c
      ? '<div class="uk-kpi uk-kpi-blue"><span class="uk-kpi-label">' + esc(t('kBalance')) + '</span><span class="uk-kpi-value">' + (b ? esc(money(b.bookBalance)) : '<span class="uk-skel" style="width:120px;height:26px"></span>') + '</span><span class="uk-kpi-note">' + esc(t('toToday') + (c.key ? ' · ' + c.key : '')) + '</span></div>'
      : '<div class="uk-kpi"><span class="uk-kpi-label">' + esc(t('kBalance')) + '</span><span style="font-size:15px;font-weight:700;color:#5E5A53">' + esc(t('pickCompany')) + '</span><span class="uk-kpi-note">' + esc(t('perCompany')) + '</span></div>';
    return '<div class="uk-kpis">' + pending + approved + unbooked + balance + '</div>';
  }

  function tabsHtml() {
    var s = stats();
    return [['all', 'tAll', s.all], ['mine', 'tMine', s.mine], ['pending', 'tPending', s.pending], ['approved', 'tApproved', s.approved], ['rejected', 'tRejected', s.rejected]]
      .map(function (x) {
        return '<button type="button" role="tab" aria-selected="' + (st.tab === x[0]) + '" class="' + (st.tab === x[0] ? 'is-on' : '') + '" data-cx-tab="' + x[0] + '">' + esc(t(x[1])) + '<span class="uk-seg-n">' + x[2] + '</span></button>';
      }).join('');
  }

  function rowsHtml() {
    if (st.loading && !st.summary) return '<div class="uk-empty">' + esc(t('loading')) + '</div>';
    if (st.error) return '<div class="uk-empty">' + esc(st.error) + ' <button type="button" class="uk-link-btn" data-cx="reload">' + esc(t('retry')) + '</button></div>';
    var list = filtered(), shown = list.slice(0, st.limit);
    if (!shown.length) return '<div class="uk-empty">' + esc(t('none')) + '</div>';
    var body = shown.map(function (v) {
      var no = v.voucherNumber || '';
      var co = shortCompany(v.company), code = companyCode(v.company);
      return '<a class="uk-row cx-grid" href="voucher.html?viewStatus=' + encodeURIComponent(no) + '">' +
        '<span class="cx-no">' + typeMark(v) + '<span class="uk-num" style="font-weight:700;white-space:nowrap">' + esc(no) + '</span></span>' +
        '<span class="uk-two"><span class="uk-ellipsis">' + esc(v.reason || co) + '</span><span class="uk-ellipsis">' + (v.reason ? esc(co) : (code ? '<span class="uk-code">' + esc(code) + '</span>' : '')) + '</span></span>' +
        '<span style="display:flex;align-items:center;gap:8px;min-width:0"><span class="uk-av">' + esc(initials(v.employee)) + '</span><span class="uk-ellipsis" style="color:#3A3833">' + esc(v.employee || '') + '</span></span>' +
        '<span class="uk-num uk-right" style="font-weight:800">' + esc(money(v.amount)) + '</span>' +
        '<span>' + chip(v) + '</span>' +
        '<span class="uk-right" style="font-size:13px;color:#5E5A53;white-space:nowrap">' + esc(when(v.timestamp)) + '</span>' +
        '<span class="uk-chev">' + ICON.chev + '</span></a>';
    }).join('');
    var foot = '<div class="uk-card-foot"><span style="font-size:13px;color:#6B6862">' + esc(t('showing', { a: shown.length, b: list.length })) + '</span>' +
      '<span style="display:flex;gap:16px;align-items:center">' + (list.length > shown.length ? '<button type="button" class="uk-btn uk-btn-ghost uk-btn-sm" data-cx="more">' + esc(t('more')) + '</button>' : '') +
      '<a href="voucher.html" style="font-size:14px;font-weight:700">' + esc(t('allVouchers')) + '</a></span></div>';
    return body + foot;
  }

  function recentHtml() {
    return '<section class="uk-card" aria-labelledby="cx-recent"><div class="uk-card-head"><div style="display:flex;align-items:baseline;gap:10px"><h2 class="uk-card-title" id="cx-recent">' + esc(t('recent')) + '</h2>' +
      '<span class="uk-card-note" id="cx-updated">' + (st.at ? esc(t('updated', { t: st.at })) : '') + '</span></div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="uk-search">' + ICON.find + '<input type="search" id="cx-q" placeholder="' + esc(t('search')) + '" aria-label="' + esc(t('search')) + '" value="' + esc(st.q) + '"></span>' +
      '<div class="uk-seg" role="tablist" id="cx-tabs">' + tabsHtml() + '</div>' +
      '<button type="button" class="uk-icon-btn" data-cx="reload" aria-label="' + esc(t('refresh')) + '" title="' + esc(t('refresh')) + '">' + ICON.refresh + '</button></div></div>' +
      '<div class="uk-row uk-row-head cx-grid"><span>' + esc(t('cNo')) + '</span><span>' + esc(t('cReason')) + '</span><span>' + esc(t('cBy')) + '</span><span class="uk-right">' + esc(t('cAmount')) + '</span><span>' + esc(t('cStatus')) + '</span><span class="uk-right">' + esc(t('cWhen')) + '</span><span></span></div>' +
      '<div id="cx-rows">' + rowsHtml() + '</div></section>';
  }

  function countHtml() {
    var c = selected();
    var steps = [[1, 'c1', 'r1'], [2, 'c2', 'r2'], [3, 'c3', 'r3']].map(function (x, i) {
      var n = c ? st.counts.filter(function (k) { return Number(k.signProgress) === x[0] || (x[0] === 3 && Number(k.signProgress) > 3); }).length : 0;
      var done = x[0] === 3;
      return '<li style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-left:' + (i ? '1px solid #ECE9E4' : '0') + ';min-width:0">' +
        '<span style="width:30px;height:30px;border-radius:50%;background:' + (done ? '#DCFCE7' : '#DCE6FB') + ';color:' + (done ? '#166534' : '#1F4FB5') + ';font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:none">' + x[0] + '</span>' +
        '<span class="uk-two" style="flex:1"><span class="uk-ellipsis" style="font-size:13px;font-weight:700">' + esc(t(x[1])) + '</span><span class="uk-ellipsis">' + esc(t(x[2])) + '</span></span>' +
        '<span class="uk-num" style="font-size:20px;font-weight:800;color:' + (n ? '#1E1E1E' : '#B5B0A7') + '">' + n + '</span></li>';
    }).join('');
    var latest = c ? st.counts.slice(0, 3) : [];
    var side = latest.length
      ? latest.map(function (k) {
        var doneK = Number(k.signProgress) >= 3;
        var sub = !doneK && k.nextName ? t('waitingFor', { n: k.nextName }) : (k.signStatus || '');
        return '<a href="cash_book.html?company=' + encodeURIComponent(k.companyKey || k.companyName || '') + '&date=' + encodeURIComponent(k.endDate || '') + '#count" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;color:inherit">' +
          '<span class="uk-two"><span class="uk-num">' + esc(k.endDate || '') + '</span><span class="uk-ellipsis">' + esc(sub) + '</span></span>' +
          '<span class="uk-chip ' + (doneK ? 'uk-chip-approved' : 'uk-chip-pending') + '">' + esc(k.signStatus || '') + '</span></a>';
      }).join('')
      : '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px"><span class="uk-two"><span>' + esc(t('noCount')) + '</span><span>' + esc(t('noCountSub')) + '</span></span>' +
        '<a class="uk-btn uk-btn-ghost uk-btn-sm" href="' + esc(bookHref('#count')) + '">' + esc(t('newCount')) + '</a></div>';
    return '<section class="uk-card" aria-labelledby="cx-count"><div class="uk-card-head" style="border-bottom:1px solid #F0EEEA"><div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><h2 class="uk-card-title" id="cx-count">' + esc(t('count')) + '</h2>' +
      '<span class="uk-card-note">' + esc(c ? shortCompany(c.name) : t('countScope')) + '</span></div><a href="' + esc(bookHref('#count')) + '" style="font-size:13px;font-weight:700">' + esc(t('openCount')) + '</a></div>' +
      '<div class="cx-count-body"><ol style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid #ECE9E4;border-radius:12px;overflow:hidden">' + steps + '</ol>' +
      '<div class="uk-dashed" style="padding:10px 14px">' + side + '</div></div></section>';
  }

  function render() {
    var host = document.getElementById('cash-overview');
    if (!host) return;
    var focus = document.activeElement && document.activeElement.id;
    host.innerHTML = headHtml() + '<div class="uk-body">' + mineHtml() + kpisHtml() + recentHtml() + countHtml() + '</div>';
    if (focus === 'cx-q') { var q = document.getElementById('cx-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }
  function renderRows() {
    var rows = document.getElementById('cx-rows'), tabs = document.getElementById('cx-tabs');
    if (rows) rows.innerHTML = rowsHtml();
    if (tabs) tabs.innerHTML = tabsHtml();
  }

  // ── data ─────────────────────────────────────────────────
  function loadCompanies() {
    if (st.companies) return Promise.resolve();
    return post({ action: 'getCompanies' }).then(function (r) {
      var rows = (r && r.success && r.data && r.data.companies_data) || [];
      st.companies = rows.map(function (row) { return { name: row['Tên công ty'] || '', key: row['Mã định danh'] || '' }; }).filter(function (c) { return c.name; });
      if (st.company && !selected()) st.company = '';
    }).catch(function () { st.companies = []; });
  }
  function loadVouchers() {
    var u = me() || {};
    var form = new FormData();
    form.append('action', 'getVoucherSummary');
    if (u.email) form.append('userEmail', u.email);
    if (u.name) form.append('employee', u.name);
    return root.fetch(apiUrl(), { method: 'POST', body: form })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (r) {
        if (!r.success || !r.data) throw new Error(r.message || t('loadErr'));
        st.summary = r.data; st.error = '';
        st.at = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      })
      .catch(function (e) { st.error = t('loadErr'); if (root.console) root.console.error('[cash-overview]', e); });
  }
  function loadBook() {
    var c = selected();
    st.book = null; st.counts = [];
    if (!c) return Promise.resolve();
    var today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    var u = me() || {};
    return Promise.all([
      post({ action: 'getCashBook', companyName: c.name, companyKey: c.key, endDate: today, callerEmail: u.email || '' }),
      post({ action: 'getRecentCashCounts', companyName: c.name, companyKey: c.key }).catch(function () { return null; }),
    ]).then(function (res) {
      if (st.company !== c.name) return; // the user switched company meanwhile
      st.book = res[0] && res[0].success && res[0].data ? res[0].data : { pendingLines: [], bookBalance: NaN };
      st.counts = (res[1] && res[1].success && res[1].data && res[1].data.counts) || [];
    }).catch(function () { st.book = { pendingLines: [], bookBalance: NaN }; });
  }

  function load() {
    st.loading = true;
    render();
    return Promise.all([loadCompanies(), loadVouchers()]).then(function () {
      st.loading = false;
      render();
      return loadBook();
    }).then(render);
  }

  function bind() {
    if (bound) return;
    var host = document.getElementById('cash-overview');
    if (!host) return;
    bound = true;
    host.addEventListener('click', function (ev) {
      var tab = ev.target.closest('[data-cx-tab]');
      if (tab) {
        var k = tab.getAttribute('data-cx-tab');
        st.tab = (tab.classList.contains('uk-kpi') && st.tab === k) ? 'all' : k;
        st.limit = PAGE;
        render();
        return;
      }
      var act = ev.target.closest('[data-cx]');
      if (!act) return;
      var what = act.getAttribute('data-cx');
      if (what === 'reload') { load(); return; }
      if (what === 'more') { st.limit += 10; renderRows(); return; }
      if (what === 'home' && typeof root.showPage === 'function') { ev.preventDefault(); root.showPage('home'); }
    });
    host.addEventListener('input', function (ev) {
      if (ev.target.id !== 'cx-q') return;
      st.q = ev.target.value; st.limit = PAGE;
      renderRows();
    });
    host.addEventListener('change', function (ev) {
      if (ev.target.id !== 'cx-company') return;
      st.company = ev.target.value; st.limit = PAGE;
      write(COMPANY_KEY, st.company);
      render();
      loadBook().then(render);
    });
    if (root.TLCI18n && root.TLCI18n.onChange) root.TLCI18n.onChange(function () { if (document.getElementById('cash-overview')) render(); });
  }

  root.loadCashSummary = function () { bind(); return load(); };
  root.CashOverview = { _state: st, shortCompany: shortCompany, stateOf: stateOf };
})(window);
