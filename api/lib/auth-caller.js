// api/lib/auth-caller.js — Who is calling, from the login token (not from the body).
import pool from '../../db/pool.js';
import { decodeToken } from '../handlers/auth.js';

/**
 * The signed-in user behind a request, or null when there is no valid token.
 * Re-checks the employee is still active; admin comes from Master Data, not
 * from the token or the page.
 */
export async function callerFromRequest(req, db = pool) {
  const header = String(req.headers?.authorization || '');
  const claims = decodeToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!claims || !claims.id) return null;
  const { rows } = await db.query(
    `SELECT id, LOWER(email) AS email, full_name, is_admin FROM employees WHERE id = $1 AND status = 'active'`, [claims.id]);
  const r = rows[0];
  return r ? { id: r.id, email: r.email, name: r.full_name || '', isAdmin: !!r.is_admin } : null;
}

/** VOUCHER_REQUIRE_LOGIN=true: voucher actions refuse requests without a valid token. */
export const requireLogin = () => String(process.env.VOUCHER_REQUIRE_LOGIN || '').toLowerCase() === 'true';
