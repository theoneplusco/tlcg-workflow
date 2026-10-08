// approval-password.js — Postgres approvals: ask the approver for their login password (decision 2026-10-07, option D).
// Plain <script>, no dependencies, its own overlay (no page HTML touched). GAS pages never call it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApprovalPassword = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 200;

  function t(key, fallback) {
    var i18n = typeof TLCI18n !== 'undefined' ? TLCI18n : null;
    return i18n && i18n.t ? i18n.t(key, fallback) : fallback;
  }

  function valid(pw) { return typeof pw === 'string' && pw.length > 0 && pw.length <= MAX; }

  /** Resolves the typed password, or null when cancelled. opts.count > 1 shows the number of documents (bulk). */
  function ask(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var doc = document;
      var overlay = doc.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'apw-title');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;';
      overlay.innerHTML =
        '<form style="background:#fff;color:#0f172a;border-radius:12px;max-width:380px;width:100%;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:14px system-ui,sans-serif;">' +
          '<h3 id="apw-title" style="margin:0 0 8px;font-size:16px;"></h3>' +
          '<p id="apw-hint" style="margin:0 0 12px;color:#475569;line-height:1.4;"></p>' +
          '<label for="apw-input" id="apw-label" style="display:block;font-weight:600;margin-bottom:4px;"></label>' +
          '<input id="apw-input" type="password" autocomplete="current-password" maxlength="' + MAX + '" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
            '<button type="button" id="apw-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;"></button>' +
            '<button type="submit" id="apw-ok" style="padding:8px 16px;border-radius:8px;border:none;background:#0056CC;color:#fff;cursor:pointer;"></button>' +
          '</div>' +
        '</form>';
      var count = opts.count > 1 ? ' (' + opts.count + ')' : '';
      overlay.querySelector('#apw-title').textContent = t('apwTitle', 'Xác nhận phê duyệt') + count;
      overlay.querySelector('#apw-hint').textContent = t('apwHint', 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.');
      overlay.querySelector('#apw-label').textContent = t('apwLabel', 'Mật khẩu đăng nhập');
      overlay.querySelector('#apw-cancel').textContent = t('apwCancel', 'Hủy');
      overlay.querySelector('#apw-ok').textContent = t('apwConfirm', 'Duyệt');
      var input = overlay.querySelector('#apw-input');
      function onKey(e) { if (e.key === 'Escape') done(null); }
      function done(value) {
        doc.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      overlay.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        if (valid(input.value)) done(input.value); else input.focus();
      });
      overlay.querySelector('#apw-cancel').addEventListener('click', function () { done(null); });
      doc.addEventListener('keydown', onKey);
      doc.body.appendChild(overlay);
      input.focus();
    });
  }

  return { ask: ask, valid: valid, MAX: MAX };
});
