#!/usr/bin/env node
/**
 * scripts/migrate-from-sheets.js — One-time data migration
 *
 * Reads employees, companies, and goods from the existing Google Sheets
 * via the existing GAS proxy (getMasterData) and imports them into Postgres.
 *
 * Usage:
 *   node scripts/migrate-from-sheets.js
 *
 * Requires TLCG_CORE_BACKEND_URL to be set in .env (or .env.mini).
 */

import pg from 'pg';
import 'dotenv/config';

const GAS_URL = process.env.TLCG_CORE_BACKEND_URL || process.env.TLCGROUP_BACKEND_URL;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow';

if (!GAS_URL) {
  console.error('Error: TLCG_CORE_BACKEND_URL not set. Cannot fetch from GAS.');
  console.error('Set it in .env or .env.mini, or pass the URL directly.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

async function fetchMasterData() {
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
  catch { throw new Error('GAS returned non-JSON: ' + text.slice(0, 200)); }

  if (!json.success) throw new Error('GAS error: ' + json.message);
  return json.data;
}

async function migrateEmployees(employees) {
  if (!employees || !employees.length) { console.log('[Migrate] No employees to import'); return 0; }
  let count = 0;
  for (const emp of employees) {
    try {
      const email = emp.email || '';
      // Use a unique placeholder if email is empty (UNIQUE constraint)
      const uniqueEmail = email || `noemail-${count + 1}@local`;
      await pool.query(
        `INSERT INTO employees (full_name, position, department, company, email, phone, status, role, is_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (email) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           position = EXCLUDED.position,
           department = EXCLUDED.department,
           company = EXCLUDED.company,
           phone = EXCLUDED.phone,
           status = EXCLUDED.status,
           role = EXCLUDED.role,
           is_admin = EXCLUDED.is_admin,
           updated_at = NOW()`,
        [emp.name || emp.full_name || '', emp.position || '', emp.department || '',
         emp.company || '', uniqueEmail, emp.phone || '',
         emp.status || 'active', emp.role || '', emp.isAdmin || false]
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Employee "${emp.email}":`, err.message);
    }
  }
  console.log(`[Migrate] Imported ${count}/${employees.length} employees`);
  return count;
}

async function migrateCompanies(companies) {
  if (!companies || !companies.length) { console.log('[Migrate] No companies to import'); return 0; }
  let count = 0;
  for (const co of companies) {
    try {
      await pool.query(
        `INSERT INTO companies
           (company_name, company_code, company_key,
            legal_rep_name, legal_rep_email, legal_rep_sig_url,
            accountant_name, accountant_email, accountant_sig_url,
            treasurer_name, treasurer_email, treasurer_sig_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (company_name) DO UPDATE SET
           company_code = EXCLUDED.company_code,
           company_key = EXCLUDED.company_key,
           legal_rep_name = EXCLUDED.legal_rep_name,
           legal_rep_email = EXCLUDED.legal_rep_email,
           accountant_name = EXCLUDED.accountant_name,
           accountant_email = EXCLUDED.accountant_email,
           treasurer_name = EXCLUDED.treasurer_name,
           treasurer_email = EXCLUDED.treasurer_email`,
        [co.name || co.company_name || '', co.code || co.company_code || '', co.key || co.company_key || '',
         co.legalRep?.name || '', co.legalRep?.email || '', co.legalRep?.signature || '',
         co.accountant?.name || '', co.accountant?.email || '', co.accountant?.signature || '',
         co.treasurer?.name || '', co.treasurer?.email || '', co.treasurer?.signature || '']
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Company "${co.name}":`, err.message);
    }
  }
  console.log(`[Migrate] Imported ${count}/${companies.length} companies`);
  return count;
}

async function migrateGoods(goods) {
  if (!goods || !goods.length) { console.log('[Migrate] No goods to import'); return 0; }
  let count = 0;
  for (const g of goods) {
    try {
      await pool.query(
        `INSERT INTO goods_catalog (name, category, moq, unit, unit_price, spec, qbo_code, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [g.name || '', g.category || '', parseFloat(g.moq) || 1, g.unit || 'Cái',
         parseFloat(g.price || g.unit_price) || 0, g.spec || g.specification || '',
         g.qbo_code || g.qboCode || '', g.status || 'active']
      );
      count++;
    } catch (err) {
      console.error(`[Migrate] Goods "${g.name}":`, err.message);
    }
  }
  console.log(`[Migrate] Imported ${count}/${goods.length} goods`);
  return count;
}

async function main() {
  console.log('[Migrate] Starting data migration');
  console.log('[Migrate] Database:', DATABASE_URL);
  console.log('[Migrate] GAS URL:', GAS_URL);

  try {
    const data = await fetchMasterData();
    console.log('[Migrate] Received:', {
      employees: data.employees?.length || 0,
      companies: data.companies?.length || 0,
      goods: data.goods?.length || 0,
    });

    await migrateEmployees(data.employees);
    await migrateCompanies(data.companies);
    await migrateGoods(data.goods);

    console.log('[Migrate] Done!');
  } catch (err) {
    console.error('[Migrate] Error:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
