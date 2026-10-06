#!/usr/bin/env node
/**
 * scripts/migrate-from-sheets.js — Master data migration (safe to re-run)
 *
 * Employees + goods: from GAS getMasterData (Master Employee + Goods-KTT
 *   sheets), or from a saved copy of that response (--file).
 * Companies: from tlcg_companies_embed.json (GAS getMasterData has none).
 *
 * Usage:
 *   node scripts/migrate-from-sheets.js
 *   node scripts/migrate-from-sheets.js --file master-data.json
 *
 * Apply db/migrations/001_master_data_fixes.sql first.
 *
 * Re-runs update rows in place. Existing non-empty company fields are
 * kept (only blanks are filled), and a password already set in Postgres
 * is never overwritten.
 */

import crypto from 'crypto';
import fs from 'fs';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const GAS_URL = process.env.TLCG_CORE_BACKEND_URL || process.env.TLCGROUP_BACKEND_URL;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow';
const COMPANIES_FILE = './tlcg_companies_embed.json';

const fileArg = process.argv.indexOf('--file');
const MASTER_FILE = fileArg > -1 ? process.argv[fileArg + 1] : '';

if (!MASTER_FILE && !GAS_URL) {
  console.error('Error: set TLCG_CORE_BACKEND_URL in .env, or pass --file <saved getMasterData JSON>.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

const str = (v) => (v == null ? '' : String(v)).trim();
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(str(v));
const num = (v, fallback = 0) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(str(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

async function fetchMasterData() {
  if (MASTER_FILE) {
    console.log('[Migrate] Reading master data from', MASTER_FILE);
    const json = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf-8'));
    return json.data || json;
  }

  console.log('[Migrate] Fetching master data from GAS:', GAS_URL);
  const params = new URLSearchParams();
  params.set('data', JSON.stringify({ action: 'getMasterData' }));
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('GAS returned non-JSON (is the deployment URL still valid?): ' + text.slice(0, 200)); }
  if (!json.success) throw new Error('GAS error: ' + json.message);
  return json.data;
}

/**
 * Master Employee headers: full_name, position, department_name,
 * company_name, employee_email, employee_phone, employee_status,
 * employee_id, isAdmin, K login_password (plain default), L password
 * (SHA-256 hex), M mustChangePassword.
 */
async function migrateEmployees(employees) {
  if (!employees?.length) { console.log('[Migrate] No employees to import'); return; }
  let count = 0, noEmail = 0, noPassword = 0;

  for (const emp of employees) {
    const fullName = str(emp.full_name || emp['Họ và tên'] || emp.name);
    let email = str(emp.employee_email || emp.Email || emp.email).toLowerCase();
    if (!fullName && !email) continue; // blank sheet row

    if (!email) {
      // Stable per person, so re-runs update the same row
      noEmail++;
      email = `noemail-${crypto.createHash('sha1').update(fullName).digest('hex').slice(0, 10)}@local`;
    }

    const defaultPassword = str(emp.login_password);  // column K
    const legacyHash = str(emp.password).toLowerCase(); // column L
    let passwordHash = '';
    let mustChange = truthy(emp.mustChangePassword);
    if (!legacyHash && defaultPassword) {
      passwordHash = await bcrypt.hash(defaultPassword, 10);
      mustChange = true;
    } else if (!legacyHash) {
      noPassword++;
      mustChange = true;
    }

    try {
      await pool.query(
        `INSERT INTO employees
           (full_name, position, department, company, email, phone, status, employee_id,
            role, is_admin, password_hash, legacy_password_sha256, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (email) DO UPDATE SET
           full_name   = EXCLUDED.full_name,
           position    = EXCLUDED.position,
           department  = EXCLUDED.department,
           company     = EXCLUDED.company,
           phone       = EXCLUDED.phone,
           status      = EXCLUDED.status,
           employee_id = EXCLUDED.employee_id,
           role        = EXCLUDED.role,
           is_admin    = EXCLUDED.is_admin,
           -- A password already set in Postgres wins over the sheet
           password_hash = CASE WHEN employees.password_hash <> '' THEN employees.password_hash
                                ELSE EXCLUDED.password_hash END,
           legacy_password_sha256 = CASE WHEN employees.password_hash <> '' THEN ''
                                         ELSE EXCLUDED.legacy_password_sha256 END,
           must_change_password = CASE WHEN employees.password_hash <> '' THEN employees.must_change_password
                                       ELSE EXCLUDED.must_change_password END,
           updated_at  = NOW()`,
        [
          fullName,
          str(emp.position || emp['Chức vụ']),
          str(emp.department_name || emp['Phòng ban'] || emp.department),
          str(emp.company_name || emp['Công ty'] || emp.company),
          email,
          str(emp.employee_phone || emp['Điện thoại'] || emp.phone),
          // GAS writes "Active"; queries filter on lowercase
          (str(emp.employee_status || emp.Status || emp.status) || 'active').toLowerCase(),
          str(emp.employee_id || emp.EmployeeId || emp['Mã nhân viên']),
          str(emp.employee_role || emp.role || emp.position),
          truthy(emp.isAdmin ?? emp.IsAdmin),
          passwordHash,
          legacyHash,
          mustChange,
        ]
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Employee "${email}":`, err.message);
    }
  }

  console.log(`[Migrate] Employees: ${count}/${employees.length} upserted` +
    ` (${noEmail} without email → noemail-*@local, ${noPassword} with no password → must use forgot-password)`);
}

/**
 * Goods-KTT headers: Items, Category, Min. Order, Unit, Unit Price,
 * Specificaton (sic), CUKCUK/QBO Code, Status.
 */
async function migrateGoods(goods) {
  if (!goods?.length) { console.log('[Migrate] No goods to import'); return; }
  let count = 0, skipped = 0;

  for (const g of goods) {
    const name = str(g['Items'] ?? g.name);
    if (!name) { skipped++; continue; }
    try {
      await pool.query(
        `INSERT INTO goods_catalog (name, category, moq, unit, unit_price, spec, qbo_code, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (name, category) DO UPDATE SET
           moq = EXCLUDED.moq,
           unit = EXCLUDED.unit,
           unit_price = EXCLUDED.unit_price,
           spec = EXCLUDED.spec,
           qbo_code = EXCLUDED.qbo_code,
           status = EXCLUDED.status`,
        [
          name,
          str(g['Category'] ?? g.category),
          num(g['Min. Order'] ?? g.moq, 1),
          str(g['Unit'] ?? g.unit) || 'Cái',
          num(g['Unit Price'] ?? g.unit_price ?? g.price, 0),
          str(g['Specificaton'] ?? g['Specification'] ?? g.spec),
          str(g['CUKCUK/QBO Code'] ?? g.qbo_code),
          (str(g['Status'] ?? g.status) || 'active').toLowerCase(),
        ]
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Goods "${name}":`, err.message);
    }
  }

  console.log(`[Migrate] Goods: ${count}/${goods.length} upserted (${skipped} blank rows skipped)`);
}

/**
 * Companies from the embed file (Vietnamese "Công ty" sheet headers).
 * Only blank fields are filled, so hand edits in Postgres survive.
 */
async function migrateCompanies() {
  let companies;
  try {
    companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf-8')).companies_data || [];
  } catch (err) {
    console.error(`[Migrate] Cannot read ${COMPANIES_FILE}:`, err.message);
    return;
  }

  const FIELDS = {
    legal_rep_name: 'Đại diện pháp luật',
    legal_rep_email: 'Email Đại diện pháp luật',
    legal_rep_sig_url: 'Chữ ký Đại diện pháp luật',
    accountant_name: 'Kế toán trưởng',
    accountant_email: 'Email Kế toán trưởng',
    accountant_sig_url: 'Chữ ký Kế toán trưởng',
    treasurer_name: 'Thủ quỹ',
    treasurer_email: 'Email Thủ quỹ',
    treasurer_sig_url: 'Chữ ký Thủ quỹ',
    address: 'Địa chỉ',
    tax_code: 'Mã số thuế',
  };
  const cols = ['company_code', ...Object.keys(FIELDS)];
  const fill = cols
    .map((c) => `${c} = COALESCE(NULLIF(companies.${c}, ''), EXCLUDED.${c})`)
    .join(',\n           ');

  let count = 0;
  for (const co of companies) {
    const name = str(co['Tên công ty']);
    if (!name) continue;
    const values = [
      name,
      str(co['Mã định danh']),
      str(co['Mã công ty']),
      ...Object.values(FIELDS).map((h) => str(co[h])),
    ];
    try {
      await pool.query(
        `INSERT INTO companies (company_name, company_key, ${cols.join(', ')})
         VALUES (${values.map((_, i) => '$' + (i + 1)).join(', ')})
         ON CONFLICT (company_name, company_key) DO UPDATE SET
           ${fill}`,
        values
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Company "${name}":`, err.message);
    }
  }
  console.log(`[Migrate] Companies: ${count}/${companies.length} upserted (blank fields filled only)`);
}

async function main() {
  console.log('[Migrate] Database:', DATABASE_URL);
  try {
    await migrateCompanies();

    const data = await fetchMasterData();
    console.log('[Migrate] Received:', {
      employees: data.employees?.length || 0,
      goods: data.goods?.length || 0,
    });
    await migrateEmployees(data.employees);
    await migrateGoods(data.goods);

    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM employees WHERE status = 'active')  AS active_employees,
        (SELECT COUNT(*) FROM employees
          WHERE status = 'active' AND password_hash = '' AND legacy_password_sha256 = '') AS no_password,
        (SELECT COUNT(*) FROM goods_catalog WHERE status = 'active') AS active_goods,
        (SELECT COUNT(*) FROM companies) AS companies,
        (SELECT COUNT(*) FROM companies WHERE treasurer_email = '') AS companies_no_treasurer`);
    console.log('[Migrate] Postgres now:', rows[0]);
    console.log('[Migrate] Done. Restart PM2 (or wait 5 min) to clear the master-data cache.');
  } catch (err) {
    console.error('[Migrate] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
