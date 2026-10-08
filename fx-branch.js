// fx-branch.js — the PR full/simplified rule for the page, same as the server (state.js computeBranch on the
// VND total, rates.js toVnd). rates null (GAS mode) → the raw total, exactly as GAS. Plain <script>.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FxBranch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var FULL_MIN_VND = 2000000;
  function isVnd(c) { var s = String(c == null ? '' : c).trim().toUpperCase(); return s === '' || s === 'VND' || s === 'VNĐ'; }
  /** n × r rounded half-up on the printed decimals (as rates.js toVnd), or a float multiply without BigInt. */
  function times(n, r) {
    if (typeof BigInt !== 'function' || Math.abs(n) >= 1e15 || /e/i.test(String(n)) || /e/i.test(String(r))) return Math.round(n * r);
    function dec(x) { var p = String(Math.abs(x)).split('.'); var f = p[1] || ''; return [BigInt(p[0] + f), f.length]; }
    var a = dec(n), b = dec(r);
    var unit = BigInt(10) ** BigInt(a[1] + b[1]);
    var whole = Number((a[0] * b[0] * BigInt(2) + unit) / (BigInt(2) * unit));
    return n < 0 ? -whole : whole;
  }
  /** The total in VND, or null when no rate is known for the currency. rates: { USD: 26000, … }. */
  function toVnd(total, currency, rates) {
    var n = Number(total) || 0;
    if (isVnd(currency)) return n;
    var r = rates ? Number(rates[String(currency).trim().toUpperCase()]) : NaN;
    return r > 0 ? times(n, r) : null;
  }
  function branch(purchaseType, total, currency, rates) {
    if (String(purchaseType || '').toLowerCase() === 'services') return 'full';
    var v = rates ? toVnd(total, currency, rates) : null;
    if (v === null) v = Number(total) || 0; // GAS mode, or no rate yet (the server will refuse the submit and say why)
    return v >= FULL_MIN_VND ? 'full' : 'simplified';
  }
  return { toVnd: toVnd, branch: branch, FULL_MIN_VND: FULL_MIN_VND };
});
