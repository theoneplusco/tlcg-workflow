// api/lib/sheets/mirror-run.js — drain one batch of sheet_outbox (no pool/redis import, so it is testable).
import { rowForHeader, backoffSeconds } from './rows.js';

const norm = (h) => String(h || '').trim().toLowerCase();

export async function runSheetMirrorOnce(sheets, db, limit = 200) {
  const { rows: items } = await db.query(
    'SELECT * FROM sheet_outbox WHERE done_at IS NULL AND next_try_at <= NOW() ORDER BY id LIMIT $1', [limit]);
  const cache = new Map(); // tab → values (header + rows), refreshed per run
  let done = 0, failed = 0;
  for (const it of items) {
    const ck = it.spreadsheet_id + '\u0000' + it.tab;
    try {
      if (!cache.has(ck)) cache.set(ck, await sheets.getValues(it.spreadsheet_id, it.tab));
      const values = cache.get(ck);
      const header = values[0] || [];
      if (!header.length) throw new Error(`Tab ${it.tab} has no header row`);
      const row = rowForHeader(header, it.record);
      let target = -1;
      if (it.mode === 'upsert') {
        const col = header.findIndex((h) => norm(h) === norm(it.key_column));
        if (col < 0) throw new Error(`Key column ${it.key_column} not in ${it.tab}`);
        const key = String(it.record[it.key_column] ?? it.record[norm(it.key_column)] ?? '');
        target = values.findIndex((r, i) => i > 0 && String(r[col] ?? '') === key);
      }
      if (target > 0) { await sheets.update(it.spreadsheet_id, it.tab, target + 1, row); values[target] = row; }
      else { await sheets.append(it.spreadsheet_id, it.tab, row); values.push(row); }
      await db.query('UPDATE sheet_outbox SET done_at = NOW(), last_error = NULL WHERE id = $1', [it.id]);
      done += 1;
    } catch (e) {
      const attempts = it.attempts + 1;
      await db.query(
        `UPDATE sheet_outbox SET attempts = $2, last_error = $3, next_try_at = NOW() + ($4 || ' seconds')::interval WHERE id = $1`,
        [it.id, attempts, String(e.message).slice(0, 500), String(backoffSeconds(attempts))]);
      cache.delete(ck);
      failed += 1;
    }
  }
  return { done, failed };
}
