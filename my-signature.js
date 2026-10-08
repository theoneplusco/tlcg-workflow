// my-signature.js — the signed-in person's sample signature from My Profile (getMySignature, migration 009), used by
// every page that still asks for a signature image:
//   MySignature.get()             → Promise<data URL or ''> (one request per page; '' when not signed in or none uploaded)
//   MySignature.fillInput(input)  → puts the profile signature into an <input type="file"> as if the person had picked
//                                    it, so the page's own change handler (preview, compression, state) runs unchanged
//   MySignature.watch(selector)   → fills every matching file input now and whenever one appears (modals, drawers)
// The pages' signature checks also take the profile signature as the person's sample (see compareSignatures callers).
// Plain <script>, no dependencies.
(function (root) {
  'use strict';
  var pending = null;

  function token() {
    try { return (JSON.parse(localStorage.getItem('tlc_current_user') || '{}') || {}).token || ''; } catch (e) { return ''; }
  }

  function get() {
    if (pending) return pending;
    var t = token();
    if (!t) return (pending = Promise.resolve(''));
    pending = fetch('/api/voucher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ action: 'getMySignature' }),
    }).then(function (r) { return r.json(); })
      .then(function (j) { return j && j.success && j.data && j.data.hasSignature ? j.data.signature : ''; })
      .catch(function () { return ''; });
    return pending;
  }

  function toFile(dataUrl) {
    var comma = dataUrl.indexOf(',');
    var mime = (/^data:([^;,]+)/.exec(dataUrl) || [])[1] || 'image/png';
    var bin = atob(dataUrl.slice(comma + 1));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], 'chu-ky-ho-so.' + (mime.indexOf('png') >= 0 ? 'png' : 'jpg'), { type: mime });
  }

  function note(input) {
    var n = document.createElement('div');
    n.className = 'my-sig-note no-print';
    n.textContent = '✓ Đã dùng chữ ký mẫu trong Hồ sơ của bạn (có thể tải ảnh khác để đổi).';
    n.style.cssText = 'font-size:12px;color:#047857;margin-top:4px;';
    input.insertAdjacentElement('afterend', n);
  }

  /** opts.isEmpty(): fill only while it returns true (e.g. no signature chosen yet). Resolves true when filled. */
  function fillInput(input, opts) {
    opts = opts || {};
    if (!input || input.dataset.mySigFilled) return Promise.resolve(false);
    input.dataset.mySigFilled = '1';
    return get().then(function (sig) {
      if (!sig || !input.isConnected || (opts.isEmpty && !opts.isEmpty())) return false;
      try {
        var dt = new DataTransfer();
        dt.items.add(toFile(sig));
        input.files = dt.files;
      } catch (e) { return false; }
      input.dispatchEvent(new Event('change', { bubbles: true }));
      note(input);
      return true;
    });
  }

  function watch(selector, opts) {
    function scan() { document.querySelectorAll(selector).forEach(function (el) { fillInput(el, opts); }); }
    function start() { scan(); new MutationObserver(scan).observe(document.body, { childList: true, subtree: true }); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }

  root.MySignature = { get: get, fillInput: fillInput, watch: watch };
})(typeof self !== 'undefined' ? self : this);
