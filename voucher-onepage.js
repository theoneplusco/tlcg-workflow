// voucher-onepage.js — Phiếu Thu Chi on one page (design "Cash & Vouchers pages", 2026-10-09).
// voucher.html keeps its form, fields, ids, handlers, checks and submit flow; this script only re-arranges it:
//  - steps 1–4 become cards on one page (the stepper, back/next buttons and the review step are hidden);
//  - a summary panel on the right mirrors the total, amount in words and approvers, shows a checklist
//    (validateStep / getSignatureData of the page), and holds the page's own action buttons (moved, not copied);
//  - a Thu / Chi choice drives the existing "Loại phiếu" select.
// Styles: ui-kit.css (".vp1"). Labels follow the EN/VI switch.
(function (root) {
  'use strict';
  var doc = root.document;
  var TXT = {
    vi: { crumb: 'Thu chi – Sổ quỹ', crumbHere: 'Phiếu thu/chi', list: 'Danh sách phiếu ↓', draft: 'Chưa gửi',
      s1: 'Thông tin chung', s2Thu: 'Người nộp tiền', s2Chi: 'Người nhận tiền', s2: 'Người nộp/nhận tiền', s3: 'Chi tiết và chứng từ', s4: 'Phê duyệt',
      type: 'Loại phiếu', thu: 'Phiếu thu', thuSub: 'tiền vào quỹ', chi: 'Phiếu chi', chiSub: 'tiền ra khỏi quỹ',
      total: 'Tổng số tiền', approvers: 'Người phê duyệt', noApprovers: 'Chọn công ty để xem người phê duyệt.',
      flowNote: 'Theo luồng phê duyệt của công ty. Mỗi người nhận email khi tới lượt mình.',
      ready: 'Sẵn sàng gửi', missing: 'Còn thiếu', c1: 'Công ty, loại phiếu, người đề nghị', c2: 'Người nộp/nhận và lý do (≥ 10 ký tự)',
      c3: 'Loại tiền và các dòng chi tiết có số tiền', c4: 'Chữ ký người đề nghị', more: 'Thao tác khác', lines: '{n} dòng' },
    en: { crumb: 'Cash & Vouchers', crumbHere: 'Voucher', list: 'Voucher list ↓', draft: 'Not sent',
      s1: 'General', s2Thu: 'Paid in by', s2Chi: 'Paid to', s2: 'Paid in by / to', s3: 'Lines and documents', s4: 'Approval',
      type: 'Voucher type', thu: 'Receipt', thuSub: 'money in', chi: 'Payment', chiSub: 'money out',
      total: 'Total amount', approvers: 'Approvers', noApprovers: 'Choose a company to see the approvers.',
      flowNote: "The company's approval flow. Each person gets an email at their turn.",
      ready: 'Ready to send', missing: 'Still missing', c1: 'Company, type, requester', c2: 'Payee/payer and reason (≥ 10 characters)',
      c3: 'Currency and lines with amounts', c4: "Requester's signature", more: 'More actions', lines: '{n} lines' },
  };
  function lang() { return root.TLCI18n && root.TLCI18n.getLang() === 'en' ? 'en' : 'vi'; }
  function t(k, vars) {
    var s = (TXT[lang()] || TXT.vi)[k] || k;
    if (vars) Object.keys(vars).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); });
    return s;
  }
  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function txt(node) { return node ? String(node.textContent || '').trim() : ''; }
  var ARROW_IN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  var ARROW_OUT = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  var form, typeSel, ui = {};

  function typeKind() {
    var v = typeSel ? String(typeSel.value || '') : '';
    return /thu/i.test(v) ? 'thu' : /chi/i.test(v) ? 'chi' : '';
  }
  function pickType(kind) {
    if (!typeSel) return;
    var opt = [].slice.call(typeSel.options).filter(function (o) { return o.value && new RegExp(kind, 'i').test(o.value + ' ' + o.textContent); })[0];
    if (!opt || typeSel.value === opt.value) return;
    typeSel.value = opt.value;
    typeSel.dispatchEvent(new Event('change', { bubbles: true })); // runs the page's onchange (title, number)
    sync();
  }
  function ok(fn, arg) { try { return !!root[fn](arg); } catch (e) { return false; } }
  function checks() {
    var reason = $('reason');
    return [
      ['c1', ok('validateStep', 1)],
      ['c2', ok('validateStep', 2) && reason && String(reason.value || '').trim().length >= 10],
      ['c3', ok('validateStep', 3)],
      ['c4', ok('getSignatureData')],
    ];
  }

  function approverRows() {
    var items = doc.querySelectorAll('#approvers-display .approver-item');
    var rows = [];
    [].forEach.call(items, function (it) {
      var parts = [].map.call(it.children, txt).filter(Boolean);
      if (parts.length >= 2) rows.push({ step: parts[0], role: parts[1], name: parts[2] || '' });
    });
    return rows;
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return p.length ? (p.length > 1 ? p[0].charAt(0) + p[p.length - 1].charAt(0) : p[0].slice(0, 2)).toUpperCase() : '?';
  }
  function me() { try { return (JSON.parse(root.localStorage.getItem('tlc_current_user') || 'null') || {}).name || ''; } catch (e) { return ''; } }

  function sync() {
    if (!form) return;
    var kind = typeKind();
    // Thu / Chi choice
    ui.seg.querySelectorAll('button').forEach(function (b) {
      var on = b.getAttribute('data-kind') === kind;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    ui.s2.textContent = kind === 'thu' ? t('s2Thu') : kind === 'chi' ? t('s2Chi') : t('s2');
    var number = $('voucher-number');
    ui.no.textContent = number && number.value ? number.value : '';
    ui.no.hidden = !(number && number.value);
    // Summary
    ui.total.textContent = txt($('grand-total')) || '0';
    ui.total.className = 'vp1-total uk-num' + (kind ? ' is-' + kind : '');
    ui.words.textContent = txt($('amount-in-words-display'));
    ui.tag.textContent = kind === 'thu' ? t('thu') : kind === 'chi' ? t('chi') : '';
    ui.tag.className = 'vp1-tag' + (kind ? ' is-' + kind : '');
    ui.tag.hidden = !kind;
    var company = $('company'), currency = $('currency');
    var lineCount = (root.expenseItems && root.expenseItems.length) || 0;
    try { lineCount = expenseItems.length; } catch (e) { /* not defined yet */ }
    var bits = [];
    if (company && company.value) bits.push(company.value.replace(/^\s*CÔNG TY\s+(TNHH|CỔ PHẦN|CP)?\s*/i, ''));
    bits.push(t('lines', { n: lineCount }));
    if (currency && currency.value) bits.push(currency.value);
    ui.meta.textContent = bits.join(' · ');
    // Approvers
    var rows = approverRows(), mine = me();
    var named = rows.filter(function (r) { return r.name && r.name !== '-'; });
    ui.appr.innerHTML = named.length ? rows.map(function (r, i) {
      var isMe = mine && r.name === mine;
      return '<li><span class="uk-av' + (isMe ? ' is-me' : '') + '">' + esc(r.name && r.name !== '-' ? initials(r.name) : String(i + 1)) + '</span>' +
        '<span class="uk-two"><span>' + esc(r.name && r.name !== '-' ? r.name : '—') + '</span><span>' + esc(r.step + ' · ' + r.role) + '</span></span>' +
        (isMe ? '<span class="vp1-me">' + (lang() === 'en' ? 'You' : 'Bạn') + '</span>' : '') + '</li>';
    }).join('') : '<li class="vp1-empty uk-muted" style="font-size:13px">' + esc(t('noApprovers')) + '</li>';
    // Checklist + section marks
    var list = checks(), all = true;
    ui.check.innerHTML = list.map(function (c) {
      all = all && c[1];
      return '<li class="' + (c[1] ? 'is-ok' : 'is-todo') + '"><span aria-hidden="true">' + (c[1] ? '✓' : '○') + '</span>' + esc(t(c[0])) + '</li>';
    }).join('');
    ui.readyTitle.textContent = all ? t('ready') : t('missing');
    ui.marks.forEach(function (m, i) {
      var done = i < 3 ? list[i][1] : true;
      m.textContent = done ? '✓' : String(i + 1);
      m.classList.toggle('is-done', done);
    });
  }

  function heading(step, label) {
    var h = el('h2', 'vp1-h2');
    var n = el('span', 'vp1-n', String(step));
    var span = el('span', '', esc(label));
    h.appendChild(n); h.appendChild(span);
    return { h: h, n: n, label: span };
  }

  function build() {
    form = $('voucher-form');
    typeSel = $('voucher-type');
    if (!form || !typeSel || form.classList.contains('vp1')) return;
    var steps = [1, 2, 3, 4].map(function (n) { return $('step-' + n); });
    if (steps.some(function (s) { return !s; })) return;
    form.classList.add('vp1', 'uk');

    // Header: breadcrumb, title (the page's own #form-title), number, link to the list below
    var title = $('form-title');
    var head = el('header', 'vp1-head');
    head.innerHTML = '<nav class="uk-crumb" aria-label="Breadcrumb"><a href="index.html?page=process-cash" data-vp1="crumb"></a><span aria-hidden="true">/</span><span aria-current="page" data-vp1="here"></span></nav>' +
      '<div class="uk-head-row"><div class="vp1-title-row"></div><a href="#" data-vp1="list" class="vp1-list"></a></div>';
    form.insertBefore(head, form.firstChild);
    var titleRow = head.querySelector('.vp1-title-row');
    if (title) { title.classList.add('vp1-title'); titleRow.appendChild(title); }
    ui.no = el('span', 'vp1-no uk-num'); titleRow.appendChild(ui.no);
    ui.draft = el('span', 'vp1-draft'); titleRow.appendChild(ui.draft);
    head.querySelector('[data-vp1="list"]').addEventListener('click', function (e) {
      e.preventDefault();
      var list = doc.querySelector('.recent-vouchers-section');
      if (list) list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // Two columns: the four steps | the summary
    var grid = el('div', 'vp1-grid'), main = el('div', 'vp1-main'), aside = el('aside', 'vp1-aside');
    aside.setAttribute('aria-label', 'Tóm tắt phiếu');
    steps[0].parentNode.insertBefore(grid, steps[0]);
    grid.appendChild(main); grid.appendChild(aside);
    steps.forEach(function (s) { main.appendChild(s); });

    // Section headings (the old step titles are hidden by CSS)
    var h1 = heading(1, ''), h2 = heading(2, ''), h3 = heading(3, ''), h4 = heading(4, '');
    ui.labels = [h1.label, h2.label, h3.label, h4.label];
    ui.s2 = h2.label;
    ui.marks = [h1.n, h2.n, h3.n, h4.n];
    steps.forEach(function (s, i) { s.insertBefore([h1, h2, h3, h4][i].h, s.firstChild); });

    // Thu / Chi choice at the top of step 1; the select stays (hidden) as the source of truth
    // Fields the page still fills but that the header (number) and the summary (total) now show
    [typeSel, $('voucher-number'), $('amount')].forEach(function (f) {
      var g = f && f.closest('.form-group');
      if (g) g.classList.add('vp1-hide');
    });
    var segWrap = el('div', 'vp1-type');
    segWrap.innerHTML = '<span class="vp1-label" data-vp1="type"></span><div class="vp1-seg" role="radiogroup">' +
      '<button type="button" role="radio" data-kind="thu">' + ARROW_IN + '<span data-vp1="thu"></span></button>' +
      '<button type="button" role="radio" data-kind="chi">' + ARROW_OUT + '<span data-vp1="chi"></span></button></div>';
    steps[0].insertBefore(segWrap, h1.h.nextSibling);
    ui.seg = segWrap.querySelector('.vp1-seg');
    ui.seg.addEventListener('click', function (e) { var b = e.target.closest('[data-kind]'); if (b) pickType(b.getAttribute('data-kind')); });

    // Summary panel
    aside.innerHTML = '<section class="vp1-card"><div class="vp1-row"><span class="vp1-label" data-vp1="total"></span><span class="vp1-tag" hidden></span></div>' +
      '<span class="vp1-total uk-num"></span><span class="vp1-words"></span><span class="vp1-meta"></span>' +
      '<div class="vp1-sep"></div><span class="vp1-label" data-vp1="approvers"></span><ol class="vp1-appr"></ol><p class="vp1-note" data-vp1="flowNote"></p></section>' +
      '<section class="vp1-card"><span class="vp1-label" data-vp1="ready"></span><ul class="vp1-check"></ul><div class="vp1-actions"></div></section>';
    ui.total = aside.querySelector('.vp1-total');
    ui.words = aside.querySelector('.vp1-words');
    ui.meta = aside.querySelector('.vp1-meta');
    ui.tag = aside.querySelector('.vp1-tag');
    ui.appr = aside.querySelector('.vp1-appr');
    ui.check = aside.querySelector('.vp1-check');
    ui.readyTitle = aside.querySelector('[data-vp1="ready"]');
    // The page's own action buttons move here (their listeners stay attached)
    var row = $('step-5') && $('step-5').querySelector('.button-row');
    if (row) {
      var actions = aside.querySelector('.vp1-actions');
      var send = $('send-approval-btn');
      if (send) actions.appendChild(send);
      var loading = $('loading-indicator');
      if (loading) actions.appendChild(loading);
      var details = el('details', 'vp1-more');
      details.innerHTML = '<summary data-vp1="more"></summary>';
      details.appendChild(row);
      actions.appendChild(details);
    }

    labels();
    // Keep the summary in step with the form
    form.addEventListener('input', sync);
    form.addEventListener('change', sync);
    form.addEventListener('click', function () { setTimeout(sync, 0); });
    [$('grand-total'), $('approvers-display'), $('signature-preview-area'), $('expense-table-body')].forEach(function (n) {
      if (n && root.MutationObserver) new MutationObserver(sync).observe(n, { childList: true, subtree: true, characterData: true, attributes: true });
    });
    root.setInterval(sync, 1000); // values set by code (number, company details) raise no event
    if (root.TLCI18n && root.TLCI18n.onChange) root.TLCI18n.onChange(labels);
    sync();
  }

  function labels() {
    if (!form) return;
    form.querySelectorAll('[data-vp1]').forEach(function (n) {
      var k = n.getAttribute('data-vp1');
      var map = { crumb: 'crumb', here: 'crumbHere', list: 'list', type: 'type', thu: 'thu', chi: 'chi', total: 'total', approvers: 'approvers', flowNote: 'flowNote', more: 'more' };
      if (map[k]) n.textContent = t(map[k]);
    });
    form.querySelectorAll('.vp1-seg [data-kind]').forEach(function (b) {
      var k = b.getAttribute('data-kind');
      b.title = t(k) + ' · ' + t(k + 'Sub');
      b.querySelector('span').innerHTML = esc(t(k)) + '<span class="vp1-segsub"> · ' + esc(t(k + 'Sub')) + '</span>';
    });
    ui.draft.textContent = t('draft');
    ui.labels[0].textContent = t('s1'); ui.labels[2].textContent = t('s3'); ui.labels[3].textContent = t('s4');
    sync();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', build);
  else build();
  root.VoucherOnePage = { sync: sync };
})(window);
