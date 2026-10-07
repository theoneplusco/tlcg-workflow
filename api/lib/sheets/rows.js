// api/lib/sheets/rows.js — record → sheet row by header name (pure).
export const norm = (h) => String(h || '').trim().toLowerCase();

// Written with USER_ENTERED (so dates stay dates); stop strings becoming formulas.
function cell(v) {
  if (v == null) return '';
  // formulas, leading zeros and >15-digit ids would be mangled by USER_ENTERED
  if (typeof v === 'string') return /^[=+\-@]|^0\d|^\d{16,}$/.test(v) ? `'${v}` : v;
  if (typeof v === 'object') return cell(JSON.stringify(v));
  return v;
}

export function rowForHeader(header, record) {
  const byKey = {};
  for (const [k, v] of Object.entries(record || {})) byKey[norm(k)] = v;
  return header.map((h) => cell(byKey[norm(h)]));
}

export const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));
