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

/** p2p on Postgres needs migrations 007 and 008 (and 006 for its Sheet copy). Message when missing, else null. */
export async function missingP2PSchema(workflows, db) {
  if (!workflows.includes('p2p')) return null;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.purchase_order_types') AS t, to_regclass('public.sheet_outbox') AS o,
      to_regclass('public.exchange_rates') AS x`);
    const r = rows[0] || {};
    if (!r.t) return 'PG_WORKFLOWS includes p2p but migration 007 is missing: run db/migrations/007_purchase_requests.sql';
    if (!r.o) return 'PG_WORKFLOWS includes p2p but table sheet_outbox does not exist: run db/migrations/006_sheet_outbox.sql';
    if (!r.x) return 'PG_WORKFLOWS includes p2p but migration 008 is missing: run db/migrations/008_exchange_rates.sql';
    return null;
  } catch (e) {
    console.error('[server] could not check the p2p schema (database unreachable?):', e.message);
    return null;
  }
}

/** Approvals on Postgres (vouchers or p2p) read stored signatures (migration 009). Message when missing, else null. */
export async function missingSignatureSchema(workflows, db) {
  if (!workflows.includes('vouchers') && !workflows.includes('p2p')) return null;
  try {
    const { rows } = await db.query(`SELECT to_regclass('public.employee_signatures') AS t`);
    return rows[0] && rows[0].t ? null : 'approvals on Postgres need table employee_signatures: run db/migrations/009_employee_signatures.sql';
  } catch (e) {
    console.error('[server] could not check for employee_signatures (database unreachable?):', e.message);
    return null;
  }
}

/**
 * Settings that must stop the boot (exit 1), as full log lines. Pure: `env` is process.env in server.js.
 * payments is refused until Plan 6 moves the payment side (validatePRForDirectPayment fails closed meanwhile);
 * p2p needs P2P_SPREADSHEET_ID because GAS contracts/acceptance/payments still read PRs from the Sheet copy.
 */
export function configProblems(workflows, env) {
  const out = [];
  if (workflows.includes('payments')) {
    out.push('[server] FATAL: payments workflow is not available yet (Plan 6); remove "payments" from PG_WORKFLOWS');
  }
  if (workflows.includes('p2p') && !env.P2P_SPREADSHEET_ID) {
    out.push('[server] FATAL: P2P_SPREADSHEET_ID must be set when p2p is on (GAS contracts/acceptance/payments read PRs from the Sheet)');
  }
  return out;
}

/** Settings worth a warning at boot (the server still starts), as full log lines. */
export function configWarnings(workflows, env) {
  const out = [];
  if ((workflows.includes('p2p') || workflows.includes('vouchers')) && env.SHEETS_MIRROR !== 'on') {
    out.push('[server] Sheet copy worker is off (SHEETS_MIRROR != on); sheet_outbox will grow');
  }
  if (workflows.includes('p2p') && !workflows.includes('files')) {
    out.push('[server] p2p without files: signature images and attachments still go through GAS');
  }
  return out;
}
