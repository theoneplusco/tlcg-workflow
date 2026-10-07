// api/handlers/auth.js — Login + password management
import crypto from 'crypto';
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendEmailNow } from './email-queue.js';

const GENERIC_RESET_MSG = 'Nếu email tồn tại trong hệ thống, mã OTP đã được gửi.';
const OTP_TTL_SEC = 600;          // 10 minutes
const RESET_TOKEN_TTL_SEC = 300;  // 5 minutes
const RATE_WINDOW_SEC = 1800;     // 30 minutes
const MAX_OTP_REQUESTS = 3;
const MAX_OTP_GUESSES = 3;

const DEV_JWT_SECRET = 'dev-secret-change-in-production';
const JWT_EXPIRY = '7d';

/**
 * The login token secret. Outside production (local dev, tests) a fixed dev secret is used when
 * JWT_SECRET is unset; in production there is no default, so no token is signed or accepted.
 */
export function jwtSecret(env = process.env) {
  if (env.JWT_SECRET) return env.JWT_SECRET;
  return env.NODE_ENV === 'production' ? null : DEV_JWT_SECRET;
}

const BCRYPT_ROUNDS = 10;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text).trim(), 'utf8').digest('hex');
}

/**
 * Check a password against the stored bcrypt hash, or against the GAS
 * SHA-256 hash (column L) carried over by the migration. A legacy match
 * is upgraded to bcrypt on the spot so the SHA-256 copy is used once.
 */
async function verifyPassword(user, password) {
  if (user.password_hash) {
    return bcrypt.compare(password, user.password_hash);
  }
  const legacy = (user.legacy_password_sha256 || '').toLowerCase();
  if (!legacy) return false;
  const submitted = Buffer.from(sha256Hex(password));
  const stored = Buffer.from(legacy);
  if (submitted.length !== stored.length || !crypto.timingSafeEqual(submitted, stored)) {
    return false;
  }
  const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pool.query(
    `UPDATE employees SET password_hash = $1, legacy_password_sha256 = '', updated_at = NOW()
     WHERE id = $2`,
    [upgraded, user.id]
  );
  return true;
}

export async function handleLogin(req, res) {
  const { email, password, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Email và mật khẩu là bắt buộc' : 'Email and password are required',
    });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, email, position, department, company, phone, role, is_admin,
              employee_id, password_hash, legacy_password_sha256, must_change_password, status
       FROM employees WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    const valid = user ? await verifyPassword(user, password) : false;
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Email hoặc mật khẩu không đúng' : 'Invalid email or password',
      });
    }

    const secret = jwtSecret();
    if (!secret) {
      console.error('[Auth] JWT_SECRET is not set (NODE_ENV=production): login refused');
      return res.status(500).json({ success: false, message: 'Máy chủ chưa cấu hình JWT_SECRET' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.is_admin },
      secret,
      { expiresIn: JWT_EXPIRY }
    );

    // Flat GAS-compatible shape at data.* — index.html reads result.data.name / department / …
    // (not result.data.user.*). Keep token + nested user for newer clients.
    const profile = {
      id: user.id,
      employeeId: user.employee_id || (user.id != null ? String(user.id) : ''),
      name: user.full_name || '',
      email: user.email,
      position: user.position || '',
      role: user.position || user.role || 'User',
      department: user.department || '',
      company: user.company || '',
      phone: user.phone || '',
      isAdmin: !!user.is_admin,
      mustChangePassword: !!user.must_change_password,
    };

    return res.json({
      success: true,
      message: 'Login successful',
      data: {
        ...profile,
        token,
        user: profile,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return res.status(500).json({
      success: false,
      message: vi ? 'Lỗi server' : 'Server error',
    });
  }
}

export async function handleChangePassword(req, res) {
  const { email, currentPassword, newPassword, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!email || !currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Email, mật khẩu hiện tại và mật khẩu mới là bắt buộc'
                  : 'Email, current password, and new password are required',
    });
  }

  try {
    const pwValidation = validatePasswordRules(newPassword);
    if (!pwValidation.valid) {
      return res.json({ success: false, message: pwValidation.message });
    }

    const { rows } = await pool.query(
      `SELECT id, password_hash, legacy_password_sha256 FROM employees
       WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    const valid = user ? await verifyPassword(user, currentPassword) : false;
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Mật khẩu hiện tại không đúng' : 'Current password is incorrect',
      });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(
      `UPDATE employees SET password_hash = $1, legacy_password_sha256 = '',
              must_change_password = FALSE, updated_at = NOW()
       WHERE id = $2`,
      [newHash, user.id]
    );

    return res.json({ success: true, message: vi ? 'Đổi mật khẩu thành công' : 'Password changed' });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    return res.status(500).json({ success: false, message: vi ? 'Lỗi server' : 'Server error' });
  }
}

export function validatePasswordRules(password) {
  if (!password || password.length < 8)
    return { valid: false, message: 'Mật khẩu phải có ít nhất 8 ký tự' };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 chữ hoa' };
  if (!/[0-9]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 số' };
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$%^&*)' };
  return { valid: true };
}

function otpEmailHtml(userName, otp) {
  return `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: #007AFF; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">🔐 Đặt lại mật khẩu</h2>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Xin chào <b>${userName}</b>,</p>
          <p>Mã OTP của bạn là:</p>
          <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; text-align: center; color: #007AFF; background: #F2F2F7; padding: 16px; border-radius: 8px; margin: 16px 0;">
            ${otp}
          </div>
          <p style="color: #666; font-size: 13px;">Mã có hiệu lực trong <b>10 phút</b>. Không chia sẻ mã này với ai.</p>
          <p style="color: #666; font-size: 13px;">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>
        </div>
      </div>`;
}

export async function handleRequestPasswordReset(req, res) {
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email là bắt buộc' });
  }

  try {
    const rateKey = 'otp_rate:' + email;
    const attempts = parseInt(await redis.get(rateKey) || '0', 10);
    if (attempts >= MAX_OTP_REQUESTS) {
      return res.json({ success: false, message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau 30 phút.' });
    }

    const { rows } = await pool.query(
      `SELECT email, full_name FROM employees WHERE email = $1 AND status = 'active'`,
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.json({ success: true, message: GENERIC_RESET_MSG });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    await redis.set('otp:' + email, otp, 'EX', OTP_TTL_SEC);
    await redis.set('otp_attempts:' + email, '0', 'EX', OTP_TTL_SEC);
    const nextAttempts = await redis.incr(rateKey);
    if (nextAttempts === 1) await redis.expire(rateKey, RATE_WINDOW_SEC);

    await sendEmailNow(
      user.email,
      '[TLCGroup] Mã xác nhận đặt lại mật khẩu',
      otpEmailHtml(user.full_name || 'bạn', otp),
      `Mã OTP của bạn là ${otp}. Có hiệu lực 10 phút.`
    );

    return res.json({ success: true, message: GENERIC_RESET_MSG });
  } catch (err) {
    console.error('[Auth] Request password reset error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

export async function handleVerifyOTP(req, res) {
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  const otp = (req.body?.otp || '').toString().trim();
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: 'Email và mã OTP là bắt buộc' });
  }

  try {
    const attemptsKey = 'otp_attempts:' + email;
    const attempts = parseInt(await redis.get(attemptsKey) || '0', 10);
    if (attempts >= MAX_OTP_GUESSES) {
      return res.json({ success: false, message: 'Quá nhiều lần thử. Vui lòng yêu cầu mã mới.' });
    }

    const storedOTP = await redis.get('otp:' + email);
    if (!storedOTP) {
      return res.json({ success: false, message: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.' });
    }
    if (otp !== storedOTP) {
      await redis.incr(attemptsKey);
      await redis.expire(attemptsKey, OTP_TTL_SEC);
      return res.json({ success: false, message: 'Mã OTP không đúng.' });
    }

    const resetToken = crypto.randomBytes(24).toString('hex');
    await redis.set('reset_token:' + email, resetToken, 'EX', RESET_TOKEN_TTL_SEC);
    await redis.del('otp:' + email, attemptsKey);

    return res.json({ success: true, message: 'OTP hợp lệ', data: { resetToken } });
  } catch (err) {
    console.error('[Auth] Verify OTP error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

export async function handleResetPassword(req, res) {
  const email = (req.body?.email || '').toString().trim().toLowerCase();
  const resetToken = (req.body?.resetToken || '').toString().trim();
  const newPassword = (req.body?.newPassword || '').toString();
  if (!email || !resetToken || !newPassword) {
    return res.status(400).json({ success: false, message: 'Thiếu thông tin bắt buộc' });
  }

  const pwValidation = validatePasswordRules(newPassword);
  if (!pwValidation.valid) {
    return res.json({ success: false, message: pwValidation.message });
  }

  try {
    const storedToken = await redis.get('reset_token:' + email);
    if (!storedToken || storedToken !== resetToken) {
      return res.json({ success: false, message: 'Token không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.' });
    }

    const { rows } = await pool.query(
      `SELECT id FROM employees WHERE email = $1 AND status = 'active'`,
      [email]
    );
    if (!rows[0]) {
      return res.json({ success: false, message: 'Không tìm thấy người dùng' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query(
      `UPDATE employees SET password_hash = $1, legacy_password_sha256 = '',
              must_change_password = FALSE, updated_at = NOW()
       WHERE id = $2`,
      [newHash, rows[0].id]
    );
    await redis.del('reset_token:' + email);

    return res.json({ success: true, message: 'Đặt lại mật khẩu thành công' });
  } catch (err) {
    console.error('[Auth] Reset password error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * Decode a login token; null when missing, expired or forged.
 */
export function decodeToken(token) {
  const secret = jwtSecret();
  if (!token || !secret) return null;
  try {
    return jwt.verify(token, secret);
  } catch {
    return null;
  }
}

/**
 * JWT verify middleware for protected endpoints.
 */
export function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'No token' });
  }
  const token = auth.slice(7);
  const secret = jwtSecret();
  if (!secret) return res.status(500).json({ success: false, message: 'Máy chủ chưa cấu hình JWT_SECRET' });
  try {
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
