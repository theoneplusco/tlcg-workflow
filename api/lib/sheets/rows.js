// api/lib/sheets/rows.js — record → sheet row by header name (pure).
export const norm = (h) => String(h || '').trim().toLowerCase();

// Google rejects any cell over 50,000 chars, and a rejected row would block its tab's FIFO.
const MAX_CELL = 49000;

// Written with USER_ENTERED (so dates stay dates); stop strings becoming formulas.
function cell(v) {
  if (v == null) return '';
  if (typeof v === 'string' && v.length > MAX_CELL) v = v.slice(0, MAX_CELL) + '…[cắt bớt]';
  // formulas, leading zeros and >15-digit ids would be mangled by USER_ENTERED
  if (typeof v === 'string') return /^[=+\-@]|^0\d+$|^\d{16,}$/.test(v) ? `'${v}` : v;
  if (typeof v === 'object') return cell(JSON.stringify(v));
  return v;
}

/** A repeated header (Purchase_Request_History repeats row_type/event_* 5×) gets the value in its first column only. */
export function rowForHeader(header, record) {
  const byKey = {};
  for (const [k, v] of Object.entries(record || {})) byKey[norm(k)] = v;
  const seen = new Set();
  return header.map((h) => {
    const k = norm(h);
    if (seen.has(k)) return '';
    seen.add(k);
    return cell(byKey[k]);
  });
}

export const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));
