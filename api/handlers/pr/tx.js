// api/handlers/pr/tx.js — default dependencies and the lock → rule → commit → email pattern of PR writes.
import pool from '../../../db/pool.js';
import { getS3 } from '../../lib/files/r2.js';
import { callerFromRequest } from '../../lib/auth-caller.js';
import gasProxy from '../../voucher.js';
import { queueMail } from '../email-queue.js';
import { publishEvent } from '../sse.js';
import { lockPR } from '../../lib/purchase-requests/repo.js';
import { ok, fail } from '../../lib/purchase-requests/respond.js';

/**
 * Handlers take `d` (tests) over these defaults. paymentsForPR(db, prNo) → [{status}] is the payment
 * side of validatePRForDirectPayment; Plan 6 replaces it when payments move to Postgres.
 */
export const prDeps = (d = {}) => ({
  db: pool, s3: getS3(), who: callerFromRequest, now: () => new Date(), gasProxy, paymentsForPR: async () => [], ...d,
});

/**
 * Lock the PR, run `work(client, row)` → { error } | { saved, mails, message, fields }, commit,
 * then queue the emails (never before commit) and answer in the GAS shape.
 */
export async function withLockedPR(db, prNo, res, work) {
  const client = await db.connect();
  let out;
  try {
    await client.query('BEGIN');
    const row = await lockPR(client, prNo);
    out = row ? await work(client, row) : { error: `Không tìm thấy đề nghị: ${prNo}` };
    await client.query(out.error ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PR] write failed:', e.message);
    return fail(res, 'Lỗi: ' + e.message);
  } finally { client.release(); }
  if (out.error) return fail(res, out.error);
  for (const m of (out.mails || []).filter(Boolean)) await queueMail(m, db);
  publishEvent('pr:updated', { prNo: out.saved.pr_no, status: out.saved.status });
  return ok(res, out.message, out.fields);
}
