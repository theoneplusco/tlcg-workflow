// api/handlers/my-tasks.js — getMyTaskCounts: how many documents wait for the signed-in person now, for the badges of
// the shared sidebar (app-sidebar.js). Only workflows that run on Postgres (PG_WORKFLOWS) are counted: a workflow
// still on GAS has no key in the answer, so the sidebar shows no badge for it rather than a wrong one.
// "Waits for me" is the pending_emails column each workflow keeps up to date (vouchers: summary.js myTurn;
// purchase requests: state.js pendingEmails, which is the requester when the PR was sent back).
import pool from '../../db/pool.js';
import { callerFromRequest } from '../lib/auth-caller.js';
import { STATUS as VOUCHER } from '../lib/vouchers/compat.js';
import { TERMINAL_STATUSES } from '../lib/purchase-requests/state.js';

const WAITING_FOR = `EXISTS (SELECT 1 FROM unnest(pending_emails) e WHERE LOWER(e) = $1)`;

/** Sidebar item key → its workflow (PG_WORKFLOWS name) and count query ($1 = my email, $2 = closed statuses). */
export const COUNTS = {
  'cash-voucher': { workflow: 'vouchers', table: 'vouchers', closed: [VOUCHER.rejected, 'Rejected', VOUCHER.deleted] },
  'p2p-pr': { workflow: 'p2p', table: 'purchase_requests', closed: TERMINAL_STATUSES },
};

const pgWorkflows = () => new Set(String(process.env.PG_WORKFLOWS || '').split(',').map((s) => s.trim()).filter(Boolean));

/** getMyTaskCounts → { counts: { 'cash-voucher': 2, 'p2p-pr': 1 } } (only the keys of workflows on Postgres). */
export async function handleMyTaskCounts(req, res) {
  const caller = await callerFromRequest(req);
  if (!caller) return res.status(401).json({ success: false, message: 'Vui lòng đăng nhập' });
  const on = pgWorkflows();
  try {
    const entries = await Promise.all(Object.entries(COUNTS).filter(([, c]) => on.has(c.workflow)).map(async ([key, c]) => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${c.table} WHERE COALESCE(status, '') <> ALL($2) AND ${WAITING_FOR}`, [caller.email, c.closed]);
      return [key, rows[0].n];
    }));
    return res.json({ success: true, data: { counts: Object.fromEntries(entries) } });
  } catch (err) {
    console.error('[MyTasks] counts:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi hệ thống, vui lòng thử lại.' });
  }
}
