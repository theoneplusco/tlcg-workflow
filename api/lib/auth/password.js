// api/lib/auth/password.js — the stored-password check shared by login and approval step-up (takes `db`, no pool import).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = 10;

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

/**
 * Check a password against the stored bcrypt hash, or against the GAS SHA-256 hash (column L) carried over
 * by the migration. A legacy match is upgraded to bcrypt on the spot so the SHA-256 copy is used once.
 */
export async function verifyPassword(db, user, password) {
  if (user.password_hash) return bcrypt.compare(password, user.password_hash);
  const legacy = (user.legacy_password_sha256 || '').toLowerCase();
  if (!legacy) return false;
  const submitted = Buffer.from(sha256Hex(password));
  const stored = Buffer.from(legacy);
  if (submitted.length !== stored.length || !crypto.timingSafeEqual(submitted, stored)) return false;
  const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query(
    `UPDATE employees SET password_hash = $1, legacy_password_sha256 = '', updated_at = NOW() WHERE id = $2`,
    [upgraded, user.id]
  );
  return true;
}
