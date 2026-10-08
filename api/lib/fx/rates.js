// api/lib/fx/rates.js — exchange rates to VND for the PR threshold (decision 2026-10-07). Admins edit them in
// Master Data (table exchange_rates, migration 008). VND is the base (rate 1, never stored). Takes `db`.
export const BAD_CURRENCY = 'Loại tiền tệ không hợp lệ.';
export const missingRateMessage = (cur) => `Chưa có tỷ giá cho ${cur}. Vui lòng liên hệ quản trị viên.`;

/** '' / VND / VNĐ → 'VND'; three letters → upper case; anything else → '' (invalid). */
export function normalizeCurrency(c) {
  const s = String(c ?? '').trim().toUpperCase();
  if (s === '' || s === 'VND' || s === 'VNĐ') return 'VND';
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

/** n → [BigInt digits, decimals]: the exact decimal JS prints for n (shortest round trip, e.g. 9074078460.88). */
function decimal(n) {
  const str = /e/i.test(String(n)) ? n.toFixed(20) : String(n); // exponent form only below 1e-6 here
  const [i, f = ''] = str.replace('-', '').split('.');
  const v = BigInt(i + f);
  return [str.startsWith('-') ? -v : v, f.length];
}

/**
 * VND equivalent in whole đồng, rounded half-up. Integer arithmetic on minor units: the total and the rate are
 * read as the decimals they print as and multiplied as BigInt, never as floats — 5,733,726.543 × 2,500 is
 * 14,334,316,357.5 → …358 (a float multiply gives …357.4999 → …357), and 9,999,999,999.99 USD × 26,000 is
 * exactly 259,999,999,999,740. A VND total (the `currency`, not the rate, decides) is returned unchanged, never
 * rounded; any other currency is rounded half-up, even at rate 1. Accepts pg NUMERIC strings.
 */
export function toVnd(total, rate, currency) {
  const t = Number(total);
  const r = Number(rate);
  if (currency != null && normalizeCurrency(currency) === 'VND') return t;
  if (!Number.isFinite(t) || !Number.isFinite(r)) return NaN;
  if (Math.abs(t) >= 1e15 || Math.abs(r) >= 1e15) return Math.round(t * r); // beyond any real PR (and NUMERIC(20,2))
  const [tv, td] = decimal(t);
  const [rv, rd] = decimal(r);
  const prod = tv * rv;
  const unit = 10n ** BigInt(td + rd);
  const neg = prod < 0n;
  const whole = ((neg ? -prod : prod) * 2n + unit) / (2n * unit); // half-up
  return Number(neg ? -whole : whole);
}

const positive = (v) => (v != null && Number(v) > 0 ? Number(v) : null);

/**
 * 1 for VND; the admin rate for another currency; null when there is none (callers refuse, never guess).
 * `lock`: FOR SHARE, inside the caller's transaction — pairs with the admin delete (FOR UPDATE, refused while
 * a PR uses the currency), so a PR never commits in a currency removed at the same moment.
 */
export async function getRateToVnd(db, currency, { lock = false } = {}) {
  const cur = normalizeCurrency(currency);
  if (!cur) return null;
  if (cur === 'VND') return 1;
  const { rows } = await db.query(`SELECT rate_to_vnd FROM exchange_rates WHERE currency = $1${lock ? ' FOR SHARE' : ''}`, [cur]);
  return rows[0] ? positive(rows[0].rate_to_vnd) : null;
}

/** { USD: 26000, EUR: null, … } for the page. */
export async function listRates(db) {
  const { rows } = await db.query(`SELECT currency, rate_to_vnd FROM exchange_rates ORDER BY sheet_row NULLS LAST, id`);
  return Object.fromEntries(rows.map((r) => [r.currency, positive(r.rate_to_vnd)]));
}
