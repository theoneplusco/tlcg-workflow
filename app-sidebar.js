// app-sidebar.js — the one sidebar of every page (design: "TLCG sidebar redesign", 2026-10-09). Plain <script>, no
// dependencies; styles in app-sidebar.css. A page includes both and names where it is:
//   <link rel="stylesheet" href="app-sidebar.css?v=…">
//   <script src="app-sidebar.js?v=…" data-active="cash-voucher" defer></script>
// index.html adds data-spa="index": its own pages open with showPage() and the active item follows showPage.
// Phone headers carry <button class="asb-burger" data-asb-open> to open the drawer.
//   AppSidebar.refresh()        re-read the signed-in user (after login/logout on index.html)
//   AppSidebar.setActive(key)   mark another item as the current page
// Keys: Cmd/Ctrl+K find, Cmd/Ctrl+B fold, Esc closes the drawer or pop-out.
// Labels follow the EN/VI switch (i18n.js); official document names stay Vietnamese in both languages.
// Badges: documents waiting for me (getMyTaskCounts), only for workflows that run on Postgres.
(function (root) {
  'use strict';

  var doc = root.document;
  var script = doc.currentScript;
  var ACTIVE_ATTR = (script && script.getAttribute('data-active')) || '';
  var SPA = !!(script && script.getAttribute('data-spa') === 'index');
  var COLLAPSE_KEY = 'tlc_sidebar_collapsed';
  var GROUPS_KEY = 'tlc_sidebar_groups';
  var COUNTS_KEY = 'tlc_task_counts';
  var COUNTS_TTL = 60 * 1000;
  var WIDE = 1100;
  var PHONE = 768;

  var TEXT = {
    en: { nav: 'Main navigation', quick: 'Quick navigation', fold: 'Fold the sidebar', unfold: 'Unfold the sidebar', openMenu: 'Open menu',
      close: 'Close menu', home: 'Dashboard', tasks: 'My tasks', tasksWaiting: 'My tasks — {n} waiting for you', noTasks: 'Nothing is waiting for you.',
      comm: 'Communications', profile: 'My Profile', admin: 'Admin', workflows: 'Workflows', o2c: 'Order to Cash', p2p: 'Purchase to Pay',
      cash: 'Cash & Vouchers', overview: 'Overview', language: 'Language', signout: 'Sign out', find: 'Find a page or doc no.',
      findLabel: 'Find a page or a document number', open: 'Open', noMatch: 'No page or document number matches.', masterData: 'Master Data',
      flows: 'Approval Flows', org: 'Business Process Management', admin_role: 'Administrator' },
    vi: { nav: 'Điều hướng chính', quick: 'Điều hướng nhanh', fold: 'Thu gọn thanh bên', unfold: 'Mở rộng thanh bên', openMenu: 'Mở menu',
      close: 'Đóng menu', home: 'Trang chủ', tasks: 'Việc của tôi', tasksWaiting: 'Việc của tôi — {n} việc đang chờ bạn', noTasks: 'Không có việc nào đang chờ bạn.',
      comm: 'Trao đổi', profile: 'Hồ sơ của tôi', admin: 'Quản trị', workflows: 'Quy trình', o2c: 'Bán hàng – Thu tiền', p2p: 'Mua hàng – Thanh toán',
      cash: 'Thu chi – Sổ quỹ', overview: 'Tổng quan', language: 'Ngôn ngữ', signout: 'Đăng xuất', find: 'Tìm trang, số phiếu',
      findLabel: 'Tìm trang hoặc số phiếu', open: 'Mở', noMatch: 'Không tìm thấy trang hay số phiếu phù hợp.', masterData: 'Dữ liệu gốc',
      flows: 'Luồng phê duyệt', org: 'Business Process Management', admin_role: 'Quản trị viên' },
  };

  // index.html pages: opened with showPage(page) there, with index.html?page=… from every other page
  var INDEX = { home: 'home', comm: 'comm', profile: 'profile', admin: 'admin', o2c: 'process-o2c', 'p2p-overview': 'process-p2p', 'cash-overview': 'process-cash' };
  var PAGE_KEY = {}; Object.keys(INDEX).forEach(function (k) { PAGE_KEY[INDEX[k]] = k; });

  // Workflow groups. Document names are the official Vietnamese ones in both languages; `also` = more words find matches.
  var GROUPS = [
    { key: 'o2c', tile: 'o2c', link: 'o2c' },
    { key: 'p2p', tile: 'p2p', items: [
      { key: 'p2p-overview', overview: true },
      { key: 'p2p-pr', name: 'Đề Nghị Mua Hàng', href: 'purchase_request.html', also: 'purchase request PR' },
      { key: 'p2p-contract', name: 'Hợp Đồng', href: 'contract.html', also: 'contract' },
      { key: 'p2p-am', name: 'Biên Bản Nghiệm Thu', href: 'acceptance_minutes.html', also: 'acceptance minutes' },
      { key: 'p2p-payment', name: 'Đề Nghị Thanh Toán', href: 'payment_request.html', also: 'payment request' }] },
    { key: 'cash', tile: 'cash', items: [
      { key: 'cash-overview', overview: true },
      { key: 'cash-voucher', name: 'Phiếu Thu Chi', href: 'voucher.html', also: 'voucher receipt payment phiếu thu phiếu chi' },
      { key: 'cash-book', name: 'Sổ Quỹ', href: 'cash_book.html', also: 'cash book kiểm kê quỹ' }] },
  ];
  // Admin pages outside index.html count as "Admin" in the menu
  var ALIAS = { 'admin-master': 'admin', 'admin-flows': 'admin' };
  // Where a document number opens (formats: numbering.js, voucher.html submit)
  var DOC_ROUTES = [
    { re: /^[A-Z0-9]+-PR\d{8}\d{6,9}$/, href: function (no) { return 'purchase_request.html?prNo=' + encodeURIComponent(no); }, name: 'Đề Nghị Mua Hàng' },
    { re: /^[A-Z0-9]+-P[CT]\d{8,}$/, href: function (no) { return 'voucher.html?viewStatus=' + encodeURIComponent(no); }, name: 'Phiếu Thu Chi' },
  ];

  var ICON = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
    comm: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
    admin: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    o2c: '<path d="M3 4h2l2.4 11h11l2-8H6.2"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>',
    p2p: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    cash: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/>',
    find: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    signout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  };
  function svg(name, size, width) {
    return '<svg width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' +
      (width || 1.8) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON[name] + '</svg>';
  }
  function toggleIcon(folded) {
    return '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M4 6h10"/><path d="M4 12h16"/><path d="M4 18h10"/><path d="' + (folded ? 'M17 9l3 3-3 3' : 'M20 9l-3 3 3 3') + '"/></svg>';
  }

  // ── small helpers ────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function read(key, fallback) { try { var v = root.localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; } }
  function write(key, v) { try { root.localStorage.setItem(key, v); } catch (e) { /* private mode */ } }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
  function lang() { return root.TLCI18n && root.TLCI18n.getLang() === 'en' ? 'en' : 'vi'; }
  function t() { return TEXT[lang()]; }
  function user() {
    try { var u = JSON.parse(read('tlc_current_user', 'null')); return u && (u.email || u.name) ? u : null; } catch (e) { return null; }
  }
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    // First word + last word, like the rest of the app: "Nguyễn Văn Chinh" → NC
    return (parts.length > 1 ? parts[0].charAt(0) + parts[parts.length - 1].charAt(0) : parts[0].slice(0, 2)).toUpperCase();
  }
  function groupOf(key) {
    for (var i = 0; i < GROUPS.length; i += 1) {
      var g = GROUPS[i];
      if (g.link === key) return g.key;
      if ((g.items || []).some(function (it) { return it.key === key; })) return g.key;
    }
    return '';
  }

  // ── state ────────────────────────────────────────────────
  var state = {
    active: ALIAS[ACTIVE_ATTR] || ACTIVE_ATTR,
    mode: 'wide',          // wide | rail | phone
    peek: false,           // panel opened over the page (tablet rail, phone drawer)
    fly: '',               // group whose pop-out is open next to the rail
    tasksOpen: false,
    open: {},
    counts: null,          // { 'cash-voucher': 2, ... } — keys only for workflows on Postgres
    query: '',
    pick: 0,
  };
  try { state.open = JSON.parse(read(GROUPS_KEY, '{}')) || {}; } catch (e) { state.open = {}; }
  if (groupOf(state.active)) state.open[groupOf(state.active)] = true;

  var host, opener;

  function hrefFor(key) {
    if (INDEX[key]) return INDEX[key] === 'home' ? 'index.html' : 'index.html?page=' + INDEX[key];
    for (var i = 0; i < GROUPS.length; i += 1) {
      var items = GROUPS[i].items || [];
      for (var j = 0; j < items.length; j += 1) if (items[j].key === key && items[j].href) return items[j].href;
    }
    return 'index.html';
  }
  function labelFor(item) { return item.overview ? t().overview : item.name; }
  function count(key) { return state.counts && typeof state.counts[key] === 'number' ? state.counts[key] : 0; }
  function total() {
    if (!state.counts) return 0;
    return Object.keys(state.counts).reduce(function (n, k) { return n + (Number(state.counts[k]) || 0); }, 0);
  }
  function groupCount(g) { return (g.items || []).reduce(function (n, it) { return n + count(it.key); }, 0); }

  // ── markup ───────────────────────────────────────────────
  // plain: no "current page" highlight (rail buttons, brand, avatars), aria-current only
  function link(key, cls, inner, extra, plain) {
    var here = state.active === key;
    return '<a href="' + esc(hrefFor(key)) + '" class="' + cls + (here && !plain ? ' is-current' : '') + '"' + (here ? ' aria-current="page"' : '') +
      ' data-asb-go="' + esc(key) + '"' + (extra || '') + '>' + inner + '</a>';
  }
  function countBadge(n, soft) { return n > 0 ? '<span class="asb-count' + (soft ? ' is-soft' : '') + '">' + (n > 99 ? '99+' : n) + '</span>' : ''; }

  function railHtml(u) {
    var tx = t();
    var folded = state.mode !== 'wide';
    var activeGroup = groupOf(state.active);
    var n = total();
    var h = '<nav class="asb-rail" aria-label="' + esc(tx.quick) + '">';
    h += '<button type="button" class="asb-rail-btn" data-asb-toggle aria-label="' + esc(folded ? tx.unfold : tx.fold) + '" data-asb-tip="' + esc(folded ? tx.unfold : tx.fold) + '">' + toggleIcon(folded) + '</button>';
    h += '<span class="asb-rail-sep" aria-hidden="true"></span>';
    h += link('home', 'asb-rail-btn' + (state.active === 'home' ? ' is-on' : ''), svg('home', 22), ' aria-label="' + esc(tx.home) + '" data-asb-tip="' + esc(tx.home) + '"', true);
    var tasksLabel = n > 0 ? tx.tasksWaiting.replace('{n}', n) : tx.tasks;
    h += '<button type="button" class="asb-rail-btn" data-asb-tasks aria-label="' + esc(tasksLabel) + '" data-asb-tip="' + esc(tasksLabel) + '">' + svg('tasks', 22) + (n > 0 ? '<span class="asb-dot"></span>' : '') + '</button>';
    h += link('comm', 'asb-rail-btn' + (state.active === 'comm' ? ' is-on' : ''), svg('comm', 22), ' aria-label="' + esc(tx.comm) + '" data-asb-tip="' + esc(tx.comm) + '"', true);
    h += '<span class="asb-rail-sep" aria-hidden="true"></span>';
    GROUPS.forEach(function (g) {
      var on = activeGroup === g.key ? ' is-on' : '';
      var tile = '<span class="asb-tile asb-tile-' + g.tile + '">' + svg(g.tile, 18, 2) + '</span>';
      if (g.link) {
        h += link(g.link, 'asb-rail-btn' + on, tile, ' aria-label="' + esc(tx[g.key]) + '" data-asb-tip="' + esc(tx[g.key]) + '"', true);
      } else {
        var gc = groupCount(g);
        h += '<button type="button" class="asb-rail-btn' + on + '" data-asb-rail-group="' + g.key + '" aria-haspopup="true" aria-expanded="' +
          (state.fly === g.key) + '" aria-label="' + esc(tx[g.key]) + '" data-asb-tip="' + esc(tx[g.key]) + '">' + tile + (gc > 0 ? '<span class="asb-dot"></span>' : '') + '</button>';
      }
    });
    if (u && u.isAdmin) {
      h += '<span class="asb-rail-sep" aria-hidden="true"></span>';
      h += link('admin', 'asb-rail-btn' + (state.active === 'admin' ? ' is-on' : ''), svg('admin', 22), ' aria-label="' + esc(tx.admin) + '" data-asb-tip="' + esc(tx.admin) + '"', true);
    }
    h += '<span class="asb-grow"></span>';
    h += link('profile', 'asb-avatar' + (u && u.isAdmin ? ' is-admin' : ''), esc(initials(u && (u.name || u.email))), ' aria-label="' + esc(tx.profile) + '" data-asb-tip="' + esc(tx.profile) + '"', true);
    return h + '</nav>';
  }

  function tasksHtml() {
    var tx = t();
    var rows = [];
    GROUPS.forEach(function (g) {
      (g.items || []).forEach(function (it) {
        if (count(it.key) > 0) rows.push(link(it.key, 'asb-sub', '<span>' + esc(it.name) + '</span>' + countBadge(count(it.key), true)));
      });
    });
    return '<div class="asb-tasks" id="asb-tasks-list">' + (rows.length ? rows.join('') : '<p>' + esc(tx.noTasks) + '</p>') + '</div>';
  }

  function groupsHtml() {
    var tx = t();
    var h = '<div class="asb-list"><span class="asb-heading">' + esc(tx.workflows) + '</span>';
    GROUPS.forEach(function (g) {
      var tile = '<span class="asb-tile asb-tile-' + g.tile + '">' + svg(g.tile, 18, 2) + '</span>';
      if (g.link) {
        h += link(g.link, 'asb-group', tile + '<span class="asb-label">' + esc(tx[g.key]) + '</span>');
        return;
      }
      var open = !!state.open[g.key];
      var gc = groupCount(g);
      h += '<button type="button" class="asb-group" data-asb-group="' + g.key + '" aria-expanded="' + open + '" aria-controls="asb-g-' + g.key + '">' +
        tile + '<span class="asb-label">' + esc(tx[g.key]) + '</span>' + (open ? '' : countBadge(gc)) +
        '<span class="asb-chev">' + svg('chev', 16, 2.2) + '</span></button>';
      h += '<div class="asb-children" id="asb-g-' + g.key + '"' + (open ? '' : ' hidden') + '>';
      g.items.forEach(function (it) { h += link(it.key, 'asb-sub', '<span>' + esc(labelFor(it)) + '</span>' + countBadge(count(it.key), true)); });
      h += '</div>';
    });
    return h + '</div>';
  }

  function panelHtml(u) {
    var tx = t();
    var n = total();
    var mac = /Mac|iPhone|iPad/.test(root.navigator.platform || root.navigator.userAgent || '');
    var h = '<aside class="asb-panel" aria-label="' + esc(tx.nav) + '">';
    h += '<div class="asb-brand">' + link('home', '', '<img src="brand_assets/tlc logo transparancy.png" alt="" width="160" height="40"><span>TLC Group</span>', ' aria-label="TLC Group — ' + esc(tx.home) + '"', true) +
      '<button type="button" class="asb-icon-btn asb-close" data-asb-close aria-label="' + esc(tx.close) + '" title="' + esc(tx.close) + '">' + svg('close', 22, 2) + '</button></div>';
    h += '<div class="asb-org"><b>TLC Group</b><span>' + esc(tx.org) + '</span></div>';
    h += '<div class="asb-find" role="search">' + svg('find', 18, 2) +
      '<input type="search" id="asb-find" autocomplete="off" spellcheck="false" placeholder="' + esc(tx.find + '…') + '" aria-label="' + esc(tx.findLabel) +
      '" aria-controls="asb-results" aria-autocomplete="list" value="' + esc(state.query) + '"><span class="asb-kbd" aria-hidden="true">' + (mac ? '⌘K' : 'Ctrl K') + '</span>' +
      '<div class="asb-results" id="asb-results" role="listbox" hidden></div></div>';
    h += '<div class="asb-list">';
    h += link('home', 'asb-item', svg('home') + '<span class="asb-label">' + esc(tx.home) + '</span>');
    h += '<button type="button" class="asb-item" data-asb-tasks aria-expanded="' + state.tasksOpen + '" aria-controls="asb-tasks-list">' + svg('tasks') +
      '<span class="asb-label">' + esc(tx.tasks) + '</span>' + countBadge(n) + '</button>';
    if (state.tasksOpen) h += tasksHtml();
    h += link('comm', 'asb-item', svg('comm') + '<span class="asb-label">' + esc(tx.comm) + '</span>');
    if (u && u.isAdmin) h += link('admin', 'asb-item', svg('admin') + '<span class="asb-label">' + esc(tx.admin) + '</span>');
    h += '</div>';
    h += groupsHtml();
    h += '<span class="asb-grow"></span>';
    var l = lang();
    h += '<div class="asb-lang" role="group" aria-label="' + esc(tx.language) + '">' +
      '<button type="button" data-lang="en" class="' + (l === 'en' ? 'active' : '') + '" aria-pressed="' + (l === 'en') + '" aria-label="English">EN</button>' +
      '<button type="button" data-lang="vi" class="' + (l === 'vi' ? 'active' : '') + '" aria-pressed="' + (l === 'vi') + '" aria-label="Tiếng Việt">VI</button></div>';
    var name = (u && (u.name || u.email)) || '';
    var role = (u && (u.role || u.position || u.department)) || (u && u.isAdmin ? tx.admin_role : '');
    h += '<div class="asb-me">' + link('profile', 'asb-me-link', '<span class="asb-avatar' + (u && u.isAdmin ? ' is-admin' : '') + '" aria-hidden="true">' + esc(initials(name)) + '</span>' +
      '<span class="asb-me-text"><b>' + esc(name) + '</b>' + (role ? '<span>' + esc(role) + '</span>' : '') + '</span>', ' aria-label="' + esc(tx.profile + ' — ' + name) + '"') +
      '<button type="button" class="asb-icon-btn asb-signout" data-asb-signout aria-label="' + esc(tx.signout) + '" title="' + esc(tx.signout) + '">' + svg('signout') + '</button></div>';
    return h + '</aside>';
  }

  function flyHtml() {
    var g = GROUPS.filter(function (x) { return x.key === state.fly; })[0];
    if (!g) return '<div class="asb-fly" hidden></div>';
    var h = '<div class="asb-fly" role="menu" aria-label="' + esc(t()[g.key]) + '"><span class="asb-heading">' + esc(t()[g.key]) + '</span>';
    g.items.forEach(function (it) { h += link(it.key, 'asb-sub', '<span>' + esc(labelFor(it)) + '</span>' + countBadge(count(it.key), true), ' role="menuitem"'); });
    return h + '</div>';
  }

  function render() {
    if (!host) return;
    var u = user();
    var html = doc.documentElement;
    html.classList.toggle('asb-on', !!u);
    if (!u) { host.innerHTML = ''; return; }
    var focusFind = doc.activeElement && doc.activeElement.id === 'asb-find';
    host.innerHTML = '<div class="asb">' + railHtml(u) + panelHtml(u) + '</div><div class="asb-scrim" data-asb-close></div>' + flyHtml() +
      '<div class="asb-tip" role="tooltip" id="asb-tip" hidden></div>';
    placeFly();
    if (focusFind) {
      var input = doc.getElementById('asb-find');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
    if (state.query) showResults();
  }

  function placeFly() {
    if (!state.fly) return;
    var btn = host.querySelector('[data-asb-rail-group="' + state.fly + '"]');
    var fly = host.querySelector('.asb-fly');
    if (!btn || !fly) return;
    var r = btn.getBoundingClientRect();
    fly.style.top = Math.max(8, Math.min(r.top, root.innerHeight - fly.offsetHeight - 8)) + 'px';
  }

  // Labels next to the rail icons on hover / keyboard focus (the native title tooltip is slow and plain)
  function showTip(btn) {
    var tip = doc.getElementById('asb-tip');
    if (!tip || !btn) return;
    if (btn.getAttribute('aria-expanded') === 'true') { tip.hidden = true; return; } // its pop-out is open
    tip.textContent = btn.getAttribute('data-asb-tip');
    tip.hidden = false;
    var r = btn.getBoundingClientRect();
    tip.style.left = Math.round(r.right + 10) + 'px';
    tip.style.top = Math.round(r.top + r.height / 2 - tip.offsetHeight / 2) + 'px';
    btn.setAttribute('aria-describedby', 'asb-tip');
  }
  function hideTip() {
    var tip = doc.getElementById('asb-tip');
    if (tip) tip.hidden = true;
  }

  // ── layout mode ──────────────────────────────────────────
  function applyMode() {
    var w = root.innerWidth;
    var mode = w < PHONE ? 'phone' : w < WIDE || read(COLLAPSE_KEY, 'false') === 'true' ? 'rail' : 'wide';
    var changed = mode !== state.mode;
    state.mode = mode;
    if (changed) { state.peek = false; state.fly = ''; }
    var html = doc.documentElement;
    html.classList.toggle('asb-wide', mode === 'wide');
    html.classList.toggle('asb-rail', mode === 'rail');
    html.classList.toggle('asb-phone', mode === 'phone');
    html.classList.toggle('asb-peek', state.peek);
    return changed;
  }

  function setPeek(on, from) {
    state.peek = !!on;
    state.fly = '';
    doc.documentElement.classList.toggle('asb-peek', state.peek);
    render();
    if (state.peek) {
      opener = from || doc.activeElement;
      var first = host.querySelector('.asb-panel .asb-close') || host.querySelector('.asb-panel a');
      if (first) first.focus();
    } else if (opener && opener.focus) {
      try { opener.focus(); } catch (e) { /* gone */ }
      opener = null;
    }
  }

  function toggleFold() {
    if (root.innerWidth >= WIDE) {
      write(COLLAPSE_KEY, state.mode === 'wide' ? 'true' : 'false');
      applyMode();
      render();
      var tg = host.querySelector('[data-asb-toggle]');
      if (tg) tg.focus();
    } else {
      setPeek(!state.peek);
    }
  }

  // ── find ─────────────────────────────────────────────────
  function results(q) {
    var tx = t();
    var out = [];
    var no = q.trim().toUpperCase().replace(/\s+/g, '');
    DOC_ROUTES.forEach(function (r) { if (r.re.test(no)) out.push({ href: r.href(no), label: tx.open + ' ' + no, hint: r.name, icon: 'doc' }); });
    var f = fold(q.trim());
    if (f) {
      var pages = [
        { key: 'home', label: tx.home, other: TEXT.en.home + ' ' + TEXT.vi.home },
        { key: 'comm', label: tx.comm, other: TEXT.en.comm + ' ' + TEXT.vi.comm },
        { key: 'profile', label: tx.profile, other: TEXT.en.profile + ' ' + TEXT.vi.profile },
        { key: 'o2c', label: tx.o2c, other: TEXT.en.o2c + ' ' + TEXT.vi.o2c + ' báo giá hợp đồng hóa đơn quotation invoice' },
      ];
      if ((user() || {}).isAdmin) {
        pages.push({ key: 'admin', label: tx.admin, other: TEXT.en.admin + ' ' + TEXT.vi.admin });
        pages.push({ href: 'admin.html', label: tx.masterData, other: 'master data dữ liệu gốc' });
        pages.push({ href: 'approval_flows.html', label: tx.flows, other: 'approval flows luồng phê duyệt' });
      }
      GROUPS.forEach(function (g) {
        (g.items || []).forEach(function (it) {
          pages.push({ key: it.key, label: it.overview ? tx[g.key] + ' · ' + tx.overview : it.name, other: (it.also || '') + ' ' + TEXT.en[g.key] + ' ' + TEXT.vi[g.key] });
        });
      });
      pages.forEach(function (p) {
        if (fold(p.label + ' ' + p.other).indexOf(f) !== -1) out.push({ href: p.href || hrefFor(p.key), key: p.key, label: p.label, icon: 'chev' });
      });
    }
    return out.slice(0, 7);
  }

  function showResults() {
    var box = doc.getElementById('asb-results');
    if (!box) return;
    if (!state.query.trim()) { box.hidden = true; box.innerHTML = ''; return; }
    var list = results(state.query);
    if (state.pick >= list.length) state.pick = 0;
    box.hidden = false;
    box.innerHTML = list.length
      ? list.map(function (r, i) {
        return '<a href="' + esc(r.href) + '" role="option" id="asb-r' + i + '" aria-selected="' + (i === state.pick) + '" class="asb-result' + (i === state.pick ? ' is-on' : '') + '"' +
          (r.key ? ' data-asb-go="' + esc(r.key) + '"' : '') + '>' + svg(r.icon, 16, 2) + '<span>' + esc(r.label) + '</span>' + (r.hint ? '<small>' + esc(r.hint) + '</small>' : '') + '</a>';
      }).join('')
      : '<div class="asb-empty">' + esc(t().noMatch) + '</div>';
    var input = doc.getElementById('asb-find');
    if (input) input.setAttribute('aria-activedescendant', list.length ? 'asb-r' + state.pick : '');
  }

  // ── navigation ───────────────────────────────────────────
  function go(key, ev) {
    if (!SPA || !INDEX[key] || typeof root.showPage !== 'function') return; // a normal link
    if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return; // new tab: keep the link
    if (ev) ev.preventDefault();
    state.peek = false;
    state.fly = '';
    doc.documentElement.classList.remove('asb-peek');
    root.showPage(INDEX[key]);
    try { root.history.replaceState(null, '', hrefFor(key)); } catch (e) { /* file:// */ }
    render();
  }

  function signOut() {
    if (typeof root.handleLogout === 'function') return root.handleLogout();
    if (typeof root.signOut === 'function') return root.signOut();
    try { root.localStorage.removeItem('tlc_current_user'); root.localStorage.removeItem('tlc_user_token'); } catch (e) { /* ignore */ }
    root.location.href = 'index.html';
  }

  function onClick(ev) {
    hideTip();
    var el = ev.target.closest('[data-asb-go],[data-asb-toggle],[data-asb-tasks],[data-asb-group],[data-asb-rail-group],[data-asb-close],[data-asb-signout],[data-lang]');
    if (!el || !host.contains(el)) return;
    if (el.hasAttribute('data-asb-go')) {
      state.query = '';
      return go(el.getAttribute('data-asb-go'), ev);
    }
    if (el.hasAttribute('data-asb-toggle')) return toggleFold();
    if (el.hasAttribute('data-asb-close')) return setPeek(false);
    if (el.hasAttribute('data-asb-signout')) return signOut();
    if (el.hasAttribute('data-lang')) {
      if (root.TLCI18n) root.TLCI18n.setLanguage(el.getAttribute('data-lang'));
      return;
    }
    if (el.hasAttribute('data-asb-tasks')) {
      state.tasksOpen = state.mode === 'wide' || state.peek ? !state.tasksOpen : true;
      if (state.mode !== 'wide' && !state.peek) return setPeek(true, el);
      render();
      var again = host.querySelector('.asb-panel [data-asb-tasks]');
      if (again) again.focus();
      return;
    }
    if (el.hasAttribute('data-asb-group')) {
      var gk = el.getAttribute('data-asb-group');
      state.open[gk] = !state.open[gk];
      write(GROUPS_KEY, JSON.stringify(state.open));
      render();
      var same = host.querySelector('[data-asb-group="' + gk + '"]');
      if (same) same.focus();
      return;
    }
    if (el.hasAttribute('data-asb-rail-group')) {
      var rk = el.getAttribute('data-asb-rail-group');
      if (state.mode === 'wide') { // the panel is there: open the group in it
        state.open[rk] = true;
        write(GROUPS_KEY, JSON.stringify(state.open));
        render();
        var gb = host.querySelector('[data-asb-group="' + rk + '"]');
        if (gb) { gb.scrollIntoView({ block: 'nearest' }); gb.focus(); }
        return;
      }
      state.fly = state.fly === rk ? '' : rk;
      render();
      var firstItem = host.querySelector('.asb-fly a');
      if (firstItem) firstItem.focus();
    }
  }

  function onKey(ev) {
    // Cmd/Ctrl+B folds the sidebar (index.html had it before the shared sidebar)
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey && (ev.key === 'b' || ev.key === 'B') && user() && state.mode !== 'phone') {
      var tgt = ev.target;
      if (tgt && (tgt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName))) return; // keep bold/selection keys in fields
      ev.preventDefault();
      toggleFold();
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === 'k' || ev.key === 'K')) {
      if (!user()) return;
      ev.preventDefault();
      if (state.mode !== 'wide' && !state.peek) setPeek(true);
      var input = doc.getElementById('asb-find');
      if (input) input.focus();
      return;
    }
    if (ev.key === 'Escape') {
      if (state.fly) {
        var flyKey = state.fly;
        state.fly = '';
        render();
        var back = host.querySelector('[data-asb-rail-group="' + flyKey + '"]');
        if (back) back.focus();
      } else if (state.query && doc.activeElement && doc.activeElement.id === 'asb-find') {
        state.query = '';
        doc.activeElement.value = '';
        showResults();
      } else if (state.peek) {
        setPeek(false);
      }
    }
  }

  function onFindKey(ev) {
    if (!ev.target || ev.target.id !== 'asb-find') return;
    var list = results(state.query);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!list.length) return;
      ev.preventDefault();
      state.pick = (state.pick + (ev.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      showResults();
    } else if (ev.key === 'Enter') {
      var r = list[state.pick];
      if (!r) return;
      ev.preventDefault();
      state.query = '';
      if (r.key && SPA && INDEX[r.key] && typeof root.showPage === 'function') { go(r.key); render(); }
      else root.location.href = r.href;
    }
  }

  function onInput(ev) {
    if (!ev.target || ev.target.id !== 'asb-find') return;
    state.query = ev.target.value;
    state.pick = 0;
    showResults();
  }

  function onOutside(ev) {
    if (!state.fly) return;
    if (ev.target.closest && (ev.target.closest('.asb-fly') || ev.target.closest('[data-asb-rail-group]'))) return;
    state.fly = '';
    render();
  }

  // ── badges ───────────────────────────────────────────────
  function token() { var u = user(); return (u && u.token) || ''; }
  function loadCounts(force) {
    var tk = token();
    if (!tk) return;
    if (!force) {
      try {
        var cached = JSON.parse(root.sessionStorage.getItem(COUNTS_KEY) || 'null');
        if (cached && cached.at > Date.now() - COUNTS_TTL && cached.email === (user() || {}).email) { state.counts = cached.counts; render(); return; }
      } catch (e) { /* no cache */ }
    }
    root.fetch('/api/voucher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
      body: JSON.stringify({ action: 'getMyTaskCounts' }),
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.success || !j.data) return;
        state.counts = j.data.counts || {};
        try { root.sessionStorage.setItem(COUNTS_KEY, JSON.stringify({ at: Date.now(), email: (user() || {}).email, counts: state.counts })); } catch (e) { /* ignore */ }
        render();
      })
      .catch(function () { /* badges are optional */ });
  }

  // ── wiring ───────────────────────────────────────────────
  function hookIndex() {
    if (!SPA || typeof root.showPage !== 'function' || root.showPage.__asb) return;
    var original = root.showPage;
    var wrapped = function (page) {
      var r = original.apply(this, arguments);
      var shown = doc.querySelector('[id^="page-"]:not(.hidden)');
      var id = shown ? shown.id.replace(/^page-/, '') : page;
      setActive(PAGE_KEY[id] || PAGE_KEY[page] || state.active);
      return r;
    };
    wrapped.__asb = true;
    root.showPage = wrapped;
  }

  function setActive(key) {
    key = ALIAS[key] || key;
    if (key === state.active) return;
    state.active = key;
    var g = groupOf(key);
    if (g) state.open[g] = true;
    render();
  }

  function refresh() {
    try { root.sessionStorage.removeItem(COUNTS_KEY); } catch (e) { /* ignore */ }
    state.counts = null;
    render();
    loadCounts(true);
  }

  function init() {
    host = doc.getElementById('app-sidebar');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'app-sidebar';
      doc.body.insertBefore(host, doc.body.firstChild);
    }
    applyMode();
    render();
    hookIndex();
    loadCounts(false);
    host.addEventListener('click', onClick);
    host.addEventListener('mouseover', function (ev) { var b = ev.target.closest && ev.target.closest('[data-asb-tip]'); if (b) showTip(b); });
    host.addEventListener('mouseout', function (ev) { var b = ev.target.closest && ev.target.closest('[data-asb-tip]'); if (b && !b.contains(ev.relatedTarget)) hideTip(); });
    host.addEventListener('focusin', function (ev) { var b = ev.target.closest && ev.target.closest('[data-asb-tip]'); if (b && b.matches(':focus-visible')) showTip(b); else hideTip(); });
    host.addEventListener('focusout', hideTip);
    root.addEventListener('scroll', hideTip, true);
    host.addEventListener('keydown', onFindKey);
    host.addEventListener('input', onInput);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('click', function (ev) {
      var openBtn = ev.target.closest && ev.target.closest('[data-asb-open]');
      if (openBtn) { ev.preventDefault(); setPeek(true, openBtn); return; }
      onOutside(ev);
    });
    var resizeTimer;
    root.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (applyMode()) render(); else placeFly(); }, 80);
    });
    root.addEventListener('storage', function (e) { if (e.key === 'tlc_current_user') refresh(); });
    if (root.TLCI18n && root.TLCI18n.onChange) root.TLCI18n.onChange(function () { render(); });
  }

  root.AppSidebar = { refresh: refresh, setActive: setActive, open: function () { setPeek(true); }, close: function () { setPeek(false); } };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
