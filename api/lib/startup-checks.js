// api/lib/startup-checks.js — checks run once when the server boots.

/**
 * Vouchers on Postgres queue every change in sheet_outbox (migration 006). Without that table every
 * voucher write would fail, so the server must not serve vouchers. Returns a message when the table
 * is missing, else null. A database that cannot be reached is logged, not fatal (PM2 would only
 * restart-loop; the pool reconnects on its own).
 */
export async function missingVoucherSchema(workflows, db) {
  if (!workflows.includes('vouchers')) return null;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.sheet_outbox') AS t`);
    if (rows[0] && rows[0].t) return null;
    return 'PG_WORKFLOWS includes vouchers but table sheet_outbox does not exist: run db/migrations/006_sheet_outbox.sql';
  } catch (e) {
    console.error('[server] could not check for sheet_outbox (database unreachable?):', e.message);
    return null;
  }
}

/** p2p on Postgres needs migration 007 (and 006 for its Sheet copy). Message when missing, else null. */
export async function missingP2PSchema(workflows, db) {
  if (!workflows.includes('p2p')) return null;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.purchase_order_types') AS t, to_regclass('public.sheet_outbox') AS o`);
    const r = rows[0] || {};
    if (!r.t) return 'PG_WORKFLOWS includes p2p but migration 007 is missing: run db/migrations/007_purchase_requests.sql';
    if (!r.o) return 'PG_WORKFLOWS includes p2p but table sheet_outbox does not exist: run db/migrations/006_sheet_outbox.sql';
    return null;
  } catch (e) {
    console.error('[server] could not check the p2p schema (database unreachable?):', e.message);
    return null;
  }
}
