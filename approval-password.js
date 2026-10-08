// approval-password.js — Postgres approvals: ask the approver for their login password (decision 2026-10-07, option D),
// and Plan 5c's self-approval prompt at submit (selfApproval). Plain <script>, no dependencies, its own overlay (no
// page HTML touched). GAS mode never opens it: GAS never answers needSelfApproval, and approvals ask only on Postgres.
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

  var open = false; // one dialog at a time
  var ABORT = { abort: true }; // ask() answer for the third button (opts.abortLabel): close, send nothing

  /**
   * Resolves the typed password, or null when cancelled. opts.count > 1 shows the number of documents (bulk).
   * opts.title / hint / error / confirmLabel / cancelLabel replace the default texts (Plan 5c prompt).
   * opts.abortLabel adds a third button that resolves ask.ABORT; Escape then also resolves ask.ABORT (not null).
   * A call while a dialog is already open is ignored: no second dialog, resolves null (the caller does nothing).
   */
  function ask(opts) {
    opts = opts || {};
    if (open) return Promise.resolve(opts.abortLabel ? ABORT : null); // never read as "skip" (that would submit)
    open = true;
    return new Promise(function (resolve) {
      var doc = document;
      var overlay = doc.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'apw-title');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px;';
      overlay.innerHTML =
        '<form style="background:#fff;color:#0f172a;border-radius:12px;max-width:' + (opts.abortLabel ? 480 : 380) + 'px;width:100%;padding:20px;box-shadow:0 10px 30px rgba(0,0,0,.2);font:14px system-ui,sans-serif;">' +
          '<h3 id="apw-title" style="margin:0 0 8px;font-size:16px;"></h3>' +
          '<p id="apw-hint" style="margin:0 0 12px;color:#475569;line-height:1.4;"></p>' +
          '<p id="apw-error" role="alert" style="margin:0 0 12px;color:#b91c1c;font-weight:600;line-height:1.4;"></p>' +
          '<label for="apw-input" id="apw-label" style="display:block;font-weight:600;margin-bottom:4px;"></label>' +
          '<input id="apw-input" type="password" autocomplete="current-password" maxlength="' + MAX + '" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:16px;">' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">' +
            (opts.abortLabel ? '<button type="button" id="apw-abort" style="padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;margin-right:auto;"></button>' : '') +
            '<button type="button" id="apw-cancel" style="padding:8px 16px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;"></button>' +
            '<button type="submit" id="apw-ok" style="padding:8px 16px;border-radius:8px;border:none;background:#0056CC;color:#fff;cursor:pointer;"></button>' +
          '</div>' +
        '</form>';
      var count = opts.count > 1 ? ' (' + opts.count + ')' : '';
      overlay.querySelector('#apw-title').textContent = (opts.title || t('apwTitle', 'Xác nhận phê duyệt')) + count;
      overlay.querySelector('#apw-hint').textContent = opts.hint || t('apwHint', 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.');
      var err = overlay.querySelector('#apw-error');
      err.textContent = opts.error || '';
      err.style.display = opts.error ? '' : 'none';
      overlay.querySelector('#apw-label').textContent = t('apwLabel', 'Mật khẩu đăng nhập');
      overlay.querySelector('#apw-cancel').textContent = opts.cancelLabel || t('apwCancel', 'Hủy');
      overlay.querySelector('#apw-ok').textContent = opts.confirmLabel || t('apwConfirm', 'Duyệt');
      var input = overlay.querySelector('#apw-input');
      var abortBtn = opts.abortLabel ? overlay.querySelector('#apw-abort') : null;
      if (abortBtn) abortBtn.textContent = opts.abortLabel;
      function onKey(e) { if (e.key === 'Escape') done(abortBtn ? ABORT : null); }
      function done(value) {
        open = false;
        input.value = ''; // the typed password never stays in the page
        doc.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      overlay.querySelector('form').addEventListener('submit', function (e) {
        e.preventDefault();
        if (valid(input.value)) done(input.value); else input.focus();
      });
      overlay.querySelector('#apw-cancel').addEventListener('click', function () { done(null); });
      if (abortBtn) abortBtn.addEventListener('click', function () { done(ABORT); });
      doc.addEventListener('keydown', onKey);
      doc.body.appendChild(overlay);
      input.focus();
    }).catch(function (e) { open = false; throw e; }); // a dialog that failed to open never blocks the next one
  }

  /**
   * Plan 5c. `result` = the submit answer. While the server answers needSelfApproval, show its prompt (with its
   * error once a password was sent). Three outcomes:
   *  - "Gửi và tự động duyệt" → resend({ selfApprovalPassword });
   *  - "Bỏ qua, tôi duyệt sau" → resend({ selfApprovalDeclined: true }): submitted, approved by hand later;
   *  - "Hủy" / Escape → nothing is sent; resolves { success: false, cancelled: true, message } (nothing saved).
   * Any other answer (every GAS answer) is returned untouched: no dialog, no resend.
   */
  function selfApproval(result, resend) {
    var sentPassword = false;
    function step(r) {
      if (!r || r.needSelfApproval !== true) return Promise.resolve(r);
      var sa = r.selfApproval || {};
      return ask({
        title: t('sapTitle', 'Tự động duyệt bước của bạn'),
        hint: sa.prompt || r.message || '',
        error: sentPassword ? (r.message || '') : '',
        confirmLabel: t('sapConfirm', 'Gửi và tự động duyệt'),
        cancelLabel: t('sapCancel', 'Bỏ qua, tôi duyệt sau'),
        abortLabel: t('apwCancel', 'Hủy'),
      }).then(function (pw) {
        if (pw === ABORT) return { success: false, cancelled: true, message: t('sapAborted', 'Đã hủy. Phiếu chưa được gửi.') };
        sentPassword = pw !== null;
        return resend(pw === null ? { selfApprovalDeclined: true } : { selfApprovalPassword: pw });
      }).then(step);
    }
    return step(result);
  }

  ask.ABORT = ABORT;
  return { ask: ask, valid: valid, selfApproval: selfApproval, MAX: MAX };
});
