// api/lib/sheets/mirror-run.js — drain one batch of sheet_outbox (no pool/redis import, so it is testable).
// Delivery is AT-LEAST-ONCE: a write that succeeds but whose done_at update fails is retried.
// Order is strict FIFO per (spreadsheet, tab): a failing head item blocks later items of its tab.
import { rowForHeader, backoffSeconds, norm } from './rows.js';

// Claims run one at a time (advisory lock) so concurrent workers never claim out of order.
// Older items that are due are fine (claimed in the same statement); older items that are
// backing off or already claimed (next_try_at in the future) block the tab.
const CLAIM_SQL = `
  UPDATE sheet_outbox SET next_try_at = NOW() + interval '10 minutes'
  WHERE id IN (
    SELECT o.id FROM sheet_outbox o
    WHERE o.done_at IS NULL AND o.next_try_at <= NOW()
      AND NOT EXISTS (SELECT 1 FROM sheet_outbox p
        WHERE p.done_at IS NULL AND p.next_try_at > NOW()
          AND p.spreadsheet_id = o.spreadsheet_id AND p.tab = o.tab AND p.id < o.id)
    ORDER BY o.id LIMIT $1 FOR UPDATE SKIP LOCKED)
  RETURNING *`;

async function claim(db, limit) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(7340211)');
    const { rows } = await c.query(CLAIM_SQL, [limit]);
    await c.query('COMMIT');
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// deadlineMs keeps a run inside its 10-minute claim lease: no new group starts after it, the rest is released.
// onError(item, error) is called once per failed item (item.attempts already counts this failure).
export async function runSheetMirrorOnce(sheets, db, { limit = 20, deadlineMs = 120000, now = Date.now, onError = () => {} } = {}) {
  const t0 = now();
  const items = await claim(db, limit);
  const byTab = new Map();
  for (const it of items) {
    const k = it.spreadsheet_id + '\u0000' + it.tab;
    if (!byTab.has(k)) byTab.set(k, []);
    byTab.get(k).push(it);
  }
  let done = 0, failed = 0;
  const markDone = (ids) => db.query('UPDATE sheet_outbox SET done_at = NOW(), last_error = NULL WHERE id = ANY($1)', [ids]);
  const markFailed = async (group, e) => {
    for (const it of group) {
      const attempts = it.attempts + 1;
      await db.query(
        `UPDATE sheet_outbox SET attempts = $2, last_error = $3, next_try_at = NOW() + ($4 || ' seconds')::interval WHERE id = $1`,
        [it.id, attempts, String(e.message).slice(0, 500), String(backoffSeconds(attempts))]);
      try { onError({ ...it, attempts }, e); } catch { /* logging must not break the run */ }
    }
    failed += group.length;
  };
  for (const list of byTab.values()) {
    let header = null;
    let i = 0;
    for (; i < list.length; i++) {
      if (now() - t0 >= deadlineMs) break;
      const it = list[i];
      let group = [it];
      try {
        if (!header) {
          header = await sheets.getHeader(it.spreadsheet_id, it.tab);
          if (!header.length) { header = null; throw new Error(`Tab ${it.tab} has no header row`); }
        }
        if (it.mode === 'append') {
          while (i + 1 < list.length && list[i + 1].mode === 'append') group.push(list[++i]);
          await sheets.append(it.spreadsheet_id, it.tab, group.map((g) => rowForHeader(header, g.record)));
        } else {
          // key_column may list several columns ("pr_no,row_type"): the target row must match all of them
          const keys = String(it.key_column).split(',').map((k) => k.trim()).filter(Boolean);
          const cols = keys.map((k) => header.findIndex((h) => norm(h) === norm(k)));
          const missing = keys.filter((_, j) => cols[j] < 0);
          if (missing.length) throw new Error(`Key column ${missing.join(', ')} not in ${it.tab}`);
          const want = keys.map((k) => String(it.record[k] ?? it.record[norm(k)] ?? ''));
          const columns = [];
          for (const c of cols) columns.push(await sheets.getColumn(it.spreadsheet_id, it.tab, c));
          const row = rowForHeader(header, it.record);
          const height = Math.max(0, ...columns.map((c) => c.length));
          let target = -1;
          for (let n = 1; n < height && target < 0; n++) {
            if (columns.every((c, j) => String(c[n] ?? '') === want[j])) target = n;
          }
          if (target > 0) await sheets.update(it.spreadsheet_id, it.tab, target + 1, row);
          else await sheets.append(it.spreadsheet_id, it.tab, [row]);
        }
        await markDone(group.map((g) => g.id));
        done += group.length;
      } catch (e) {
        await markFailed(group, e);
        i++;
        break;
      }
    }
    // After a failure, release the rest of this tab so they run once the head succeeds.
    const rest = list.slice(i).map((x) => x.id);
    if (rest.length) await db.query('UPDATE sheet_outbox SET next_try_at = NOW() WHERE id = ANY($1)', [rest]);
  }
  return { done, failed };
}

/**
 * Retention: delete items copied more than 30 days ago. `claimDay()` resolves true at most once a
 * day across workers (the job uses a Redis SET NX EX key). Returns the number deleted, or null if
 * this call did not win the day.
 */
export async function pruneOutbox(db, claimDay) {
  if (!(await claimDay())) return null;
  const r = await db.query(`DELETE FROM sheet_outbox WHERE done_at < NOW() - interval '30 days'`);
  return r.rowCount;
}
