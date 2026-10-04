// api/handlers/auth.js — Login + password management
import pool from '../../db/pool.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRY = '7d';

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
      `SELECT id, full_name, email, position, department, company, role, is_admin,
              password_hash, status
       FROM employees WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Email hoặc mật khẩu không đúng' : 'Invalid email or password',
      });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Email hoặc mật khẩu không đúng' : 'Invalid email or password',
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, isAdmin: user.is_admin },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    return res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.full_name,
          email: user.email,
          position: user.position,
          department: user.department,
          company: user.company,
          role: user.role,
          isAdmin: user.is_admin,
        },
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
    const { rows } = await pool.query(
      `SELECT id, password_hash FROM employees WHERE email = $1 AND status = 'active'`,
      [email.toLowerCase().trim()]
    );

    const user = rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Mật khẩu hiện tại không đúng' : 'Current password is incorrect',
      });
    }

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        success: false,
        message: vi ? 'Mật khẩu hiện tại không đúng' : 'Current password is incorrect',
      });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE employees SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, user.id]
    );

    return res.json({ success: true, message: vi ? 'Đổi mật khẩu thành công' : 'Password changed' });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    return res.status(500).json({ success: false, message: vi ? 'Lỗi server' : 'Server error' });
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
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}
