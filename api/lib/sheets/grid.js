// api/lib/sheets/grid.js — Sheet exports (CSV or API values) → records (pure).

/** RFC 4180-ish CSV: quoted fields may hold commas, doubled quotes and newlines. */
export function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/**
 * Header row → lower-case keys. A header that repeats keeps its FIRST column: Purchase_Request_History
 * repeats row_type/event_* five times and only the first group ever holds data (spec §1.2).
 * sheetRow is the 1-based Sheet row (header = 1). Rows with no value at all are dropped.
 */
export function recordsFromGrid(grid) {
  const first = new Map();
  (grid[0] || []).forEach((h, i) => {
    const k = String(h || '').trim().toLowerCase();
    if (k && !first.has(k)) first.set(k, i);
  });
  return grid.slice(1).map((r, i) => {
    const rec = { sheetRow: i + 2 };
    for (const [k, idx] of first) rec[k] = String(r[idx] ?? '').trim();
    return rec;
  }).filter((rec) => Object.keys(rec).some((k) => k !== 'sheetRow' && rec[k]));
}
