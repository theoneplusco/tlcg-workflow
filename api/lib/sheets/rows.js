// api/lib/sheets/rows.js — record → sheet row by header name (pure).
const norm = (h) => String(h || '').trim().toLowerCase();

export function rowForHeader(header, record) {
  const byKey = {};
  for (const [k, v] of Object.entries(record || {})) byKey[norm(k)] = v;
  return header.map((h) => {
    const v = byKey[norm(h)];
    return v == null ? '' : v;
  });
}

export const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));
