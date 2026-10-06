// api/handlers/admin-employees.js — Admin-only employee management
// (User Management on the home page + admin.html migration dashboard).
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../../db/pool.js';
import { cache } from '../../db/cache.js';
import { decodeToken, validatePasswordRules } from './auth.js';
import { sendEmailNow } from './email-queue.js';
import { MASTER_TABLES, checkRule } from '../lib/master-registry.js';

const EMPLOYEE_RULES = MASTER_TABLES.employees.rules;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (v == null ? '' : String(v)).trim();
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Resolve the caller from the login token and re-check the database, so a
 * revoked admin or deactivated account loses access before the 7-day
 * token expires. Sends the error response and returns null on failure.
 */
export async function requireAdmin(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : str(req.body?.token);
  const claims = decodeToken(token);
  if (!claims) {
    res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, email, full_name FROM employees WHERE id = $1 AND status = 'active' AND is_admin = TRUE`,
    [claims.id]
  );
  if (!rows[0]) {
    res.status(403).json({ success: false, message: 'Chỉ quản trị viên mới thực hiện được thao tác này.' });
    return null;
  }
  return rows[0];
}

/** Random password that passes validatePasswordRules (8+, upper, digit, special). */
function generateTempPassword() {
  const core = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
  return 'Tl' + core + crypto.randomInt(10, 100) + '#';
}

function loginUrl(req) {
  return `${req.protocol}://${req.get('host')}/`;
}

function credentialsEmailHtml(name, email, password, url) {
  return `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto;">
        <div style="background: #007AFF; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">Tài khoản TLCG Workflow</h2>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Xin chào <b>${esc(name)}</b>,</p>
          <p>Tài khoản của bạn trên TLCG Workflow đã sẵn sàng:</p>
          <table style="font-size: 15px; margin: 12px 0;">
            <tr><td style="padding: 4px 12px 4px 0; color: #666;">Đăng nhập</td><td><a href="${url}">${url}</a></td></tr>
            <tr><td style="padding: 4px 12px 4px 0; color: #666;">Email</td><td><b>${esc(email)}</b></td></tr>
            <tr><td style="padding: 4px 12px 4px 0; color: #666;">Mật khẩu tạm</td><td><b style="font-family: monospace; font-size: 17px;">${esc(password)}</b></td></tr>
          </table>
          <p style="color: #666; font-size: 13px;">Bạn sẽ được yêu cầu đổi mật khẩu ở lần đăng nhập đầu tiên. Không chia sẻ email này với ai.</p>
        </div>
      </div>`;
}

async function emailCredentials(req, name, email, password) {
  const url = loginUrl(req);
  return sendEmailNow(
    email,
    '[TLCGroup] Thông tin đăng nhập TLCG Workflow',
    credentialsEmailHtml(name, email, password, url),
    `Đăng nhập: ${url}\nEmail: ${email}\nMật khẩu tạm: ${password}\nBạn sẽ được yêu cầu đổi mật khẩu ở lần đăng nhập đầu tiên.`
  );
}

export function clearMasterDataCache() {
  cache.clear();
}

function employeeRow(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    position: r.position || '',
    department: r.department || '',
    company: r.company || '',
    phone: r.phone || '',
    employeeId: r.employee_id || '',
    status: r.status || 'active',
    isAdmin: !!r.is_admin,
    hasPassword: !!(r.has_bcrypt || r.has_legacy),
    legacyPassword: !!r.has_legacy && !r.has_bcrypt,
    mustChangePassword: !!r.must_change_password,
    placeholderEmail: /@local$/.test(r.email || ''),
    updatedAt: r.updated_at,
  };
}

const EMPLOYEE_COLUMNS = `id, full_name, email, position, department, company, phone, employee_id,
  status, is_admin, must_change_password, updated_at,
  (password_hash <> '') AS has_bcrypt,
  (COALESCE(legacy_password_sha256, '') <> '') AS has_legacy`;

/**
 * adminListEmployees — every employee (any status) plus migration gaps.
 */
export async function handleAdminListEmployees(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const [emp, summary, gaps] = await Promise.all([
      pool.query(`SELECT ${EMPLOYEE_COLUMNS} FROM employees ORDER BY status, full_name`),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM employees WHERE status = 'active')::int   AS active_employees,
          (SELECT COUNT(*) FROM employees WHERE status <> 'active')::int  AS inactive_employees,
          (SELECT COUNT(*) FROM employees WHERE status = 'active'
             AND password_hash = '' AND COALESCE(legacy_password_sha256, '') = '')::int AS no_password,
          (SELECT COUNT(*) FROM employees WHERE email LIKE '%@local')::int AS placeholder_emails,
          (SELECT COUNT(*) FROM companies)::int                           AS companies,
          (SELECT COUNT(*) FROM goods_catalog WHERE status = 'active')::int AS goods`),
      pool.query(`
        SELECT company_name, company_key,
               legal_rep_email = ''  AS no_legal_rep,
               accountant_email = '' AS no_accountant,
               treasurer_email = ''  AS no_treasurer
        FROM companies
        WHERE legal_rep_email = '' OR accountant_email = '' OR treasurer_email = ''
        ORDER BY company_name, company_key`),
    ]);
    return res.json({
      success: true,
      data: {
        employees: emp.rows.map(employeeRow),
        summary: summary.rows[0],
        companyGaps: gaps.rows,
      },
    });
  } catch (err) {
    console.error('[Admin] listEmployees error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * adminCreateEmployee — create a login. Password is the admin's choice or
 * generated; the employee must change it on first login. Optionally emails
 * the credentials to the new employee.
 */
export async function handleAdminCreateEmployee(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const b = req.body || {};
  const fullName = str(b.fullName);
  const email = str(b.email).toLowerCase();
  if (!fullName || !EMAIL_RE.test(email)) {
    return res.json({ success: false, message: 'Cần họ tên và email hợp lệ.' });
  }
  // Same rules as the Master Data grid
  const idCheck = checkRule(EMPLOYEE_RULES.employee_id, b.employeeId);
  if (!idCheck.ok) return res.json({ success: false, message: 'Employee ID: ' + idCheck.message });
  const phoneCheck = checkRule(EMPLOYEE_RULES.employee_phone, b.phone);
  if (!phoneCheck.ok) return res.json({ success: false, message: 'Điện thoại: ' + phoneCheck.message });
  b.employeeId = idCheck.value;
  b.phone = phoneCheck.value;

  let password = str(b.password);
  const generated = !password;
  if (generated) {
    password = generateTempPassword();
  } else {
    const rule = validatePasswordRules(password);
    if (!rule.valid) return res.json({ success: false, message: rule.message });
  }

  // A company typed in the form that is not in Master Data yet
  const newCompany = b.newCompany && typeof b.newCompany === 'object'
    ? { name: str(b.newCompany.name), key: str(b.newCompany.key).toUpperCase() }
    : null;
  if (newCompany && (!newCompany.name || !/^[A-Z0-9._ -]{1,30}$/.test(newCompany.key))) {
    return res.json({ success: false, message: 'Công ty mới cần tên và mã (ví dụ TLC).' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let companyAdded = false;
    if (newCompany) {
      const ins = await client.query(
        `INSERT INTO companies (company_name, company_key, company_code, extra)
         VALUES ($1, $2, $2, jsonb_build_object('Company_Name', $1::text, 'Company_Key_Or_Taxid', $2::text, 'Company_Code', $2::text))
         ON CONFLICT (company_name, company_key) DO NOTHING RETURNING id`,
        [newCompany.name, newCompany.key]
      );
      companyAdded = !!ins.rows[0];
      b.company = newCompany.name;
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO employees
         (full_name, email, position, department, company, phone, employee_id,
          role, is_admin, status, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $3, $8, 'active', $9, TRUE)
       ON CONFLICT (email) DO NOTHING
       RETURNING ${EMPLOYEE_COLUMNS}`,
      [fullName, email, str(b.position), str(b.department), str(b.company),
       str(b.phone), str(b.employeeId), b.isAdmin === true || b.isAdmin === 'true', hash]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Email ${email} đã tồn tại.` });
    }
    await client.query('COMMIT');
    clearMasterDataCache();
    console.log(`[Admin] ${admin.email} created employee ${email}${companyAdded ? ` + company "${newCompany.name}"` : ''}`);

    const emailed = b.sendEmail === false || b.sendEmail === 'false'
      ? false
      : await emailCredentials(req, fullName, email, password);

    return res.json({
      success: true,
      message: emailed ? `Đã tạo tài khoản và gửi email cho ${email}.` : `Đã tạo tài khoản ${email}.`,
      data: { employee: employeeRow(rows[0]), tempPassword: password, generated, emailed, companyAdded },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Admin] createEmployee error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

/**
 * adminUpdateEmployee — edit profile fields, fix a placeholder email,
 * (de)activate, toggle admin, or issue a new temporary password.
 */
export async function handleAdminUpdateEmployee(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const b = req.body || {};
  const id = parseInt(b.id, 10);
  if (!id) return res.json({ success: false, message: 'Thiếu mã nhân viên.' });

  const sets = [];
  const params = [];
  const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.fullName !== undefined) {
    if (!str(b.fullName)) return res.json({ success: false, message: 'Họ tên không được để trống.' });
    set('full_name', str(b.fullName));
  }
  if (b.email !== undefined) {
    const email = str(b.email).toLowerCase();
    if (!EMAIL_RE.test(email)) return res.json({ success: false, message: 'Email không hợp lệ.' });
    set('email', email);
  }
  for (const [key, col] of [['position', 'position'], ['department', 'department'], ['company', 'company']]) {
    if (b[key] !== undefined) set(col, str(b[key]));
  }
  for (const [key, col, rule, label] of [
    ['phone', 'phone', EMPLOYEE_RULES.employee_phone, 'Điện thoại'],
    ['employeeId', 'employee_id', EMPLOYEE_RULES.employee_id, 'Employee ID'],
  ]) {
    if (b[key] === undefined) continue;
    const c = checkRule(rule, b[key]);
    if (!c.ok) return res.json({ success: false, message: `${label}: ${c.message}` });
    set(col, c.value);
  }
  if (b.status !== undefined) {
    const status = str(b.status).toLowerCase();
    if (!['active', 'inactive'].includes(status)) return res.json({ success: false, message: 'Trạng thái không hợp lệ.' });
    if (id === admin.id && status !== 'active') return res.json({ success: false, message: 'Không thể tự vô hiệu hoá tài khoản của mình.' });
    set('status', status);
  }
  if (b.isAdmin !== undefined) {
    const isAdmin = b.isAdmin === true || b.isAdmin === 'true';
    if (id === admin.id && !isAdmin) return res.json({ success: false, message: 'Không thể tự bỏ quyền quản trị của mình.' });
    set('is_admin', isAdmin);
  }

  let tempPassword = '';
  if (b.resetPassword === true || b.resetPassword === 'true') {
    tempPassword = generateTempPassword();
    set('password_hash', await bcrypt.hash(tempPassword, 10));
    set('legacy_password_sha256', '');
    set('must_change_password', true);
  }

  if (!sets.length) return res.json({ success: false, message: 'Không có thay đổi.' });

  try {
    params.push(id);
    const { rows } = await pool.query(
      `UPDATE employees SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length}
       RETURNING ${EMPLOYEE_COLUMNS}`,
      params
    );
    if (!rows[0]) return res.json({ success: false, message: 'Không tìm thấy nhân viên.' });
    clearMasterDataCache();
    console.log(`[Admin] ${admin.email} updated employee #${id}: ${sets.map((s) => s.split(' ')[0]).join(', ')}`);

    let emailed = false;
    if (tempPassword && !(b.sendEmail === false || b.sendEmail === 'false')) {
      emailed = await emailCredentials(req, rows[0].full_name, rows[0].email, tempPassword);
    }

    return res.json({
      success: true,
      message: 'Đã cập nhật.',
      data: { employee: employeeRow(rows[0]), tempPassword: tempPassword || undefined, emailed },
    });
  } catch (err) {
    if (err.code === '23505') return res.json({ success: false, message: 'Email này đã được dùng cho nhân viên khác.' });
    console.error('[Admin] updateEmployee error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * adminEmployeeOptions — dropdown choices for the Add Employee form, from
 * Master Data: titles and departments already used by employees, and the
 * companies in Master Company.
 */
export async function handleAdminEmployeeOptions(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const distinct = (col) => pool.query(
      `SELECT DISTINCT TRIM(${col}) AS v FROM employees
       WHERE COALESCE(TRIM(${col}), '') NOT IN ('', 'None') ORDER BY 1`
    ).then((r) => r.rows.map((x) => x.v));
    const [titles, departments, companies] = await Promise.all([
      distinct('position'),
      distinct('department'),
      pool.query(`SELECT DISTINCT company_name AS name FROM companies
                  WHERE COALESCE(TRIM(company_name), '') <> '' ORDER BY 1`).then((r) => r.rows.map((x) => x.name)),
    ]);
    return res.json({ success: true, data: { titles, departments, companies } });
  } catch (err) {
    console.error('[Admin] employeeOptions error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}
