// tests/approval/step-up-helpers.js — setup for tests that approve on Postgres (password + stamped sample). Not a test file.
import bcrypt from 'bcryptjs';
import { stampDeps, clearStampCache } from '../../api/lib/approval/step-up.js';

export const PW = 'Test#2026'; // the e2e login password of tlcg_v_test
export const FAKE_STAMP = (url) => 'data:image/png;base64,' + Buffer.from(String(url)).toString('base64');
const lower = (s) => String(s || '').trim().toLowerCase();

/**
 * Give each email (an existing employee, else a new active one) the password PW, stamp samples without
 * network (FAKE_STAMP of the sample URL), and clear the lockout counters and locks. Returns cleanup() that deletes
 * the employees it had to create.
 */
export async function useStepUp(pool, redis, emails) {
  const hash = await bcrypt.hash(PW, 4);
  const added = [];
  for (const e of [...new Set(emails.map(lower).filter(Boolean))]) {
    const upd = await pool.query(`UPDATE employees SET password_hash = $2, status = 'active' WHERE LOWER(email) = $1`, [e, hash]);
    if (!upd.rowCount) {
      await pool.query(`INSERT INTO employees (full_name, email, status, password_hash) VALUES ($1, $1, 'active', $2)`, [e, hash]);
      added.push(e);
    }
  }
  stampDeps.fetchImage = async (url) => FAKE_STAMP(url);
  clearStampCache();
  const keys = [...await redis.keys('stepup:fail:*'), ...await redis.keys('stepup:lock:*')];
  if (keys.length) await redis.del(...keys);
  return async () => { if (added.length) await pool.query(`DELETE FROM employees WHERE email = ANY($1)`, [added]); };
}
