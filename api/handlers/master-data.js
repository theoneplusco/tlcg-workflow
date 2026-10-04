// api/handlers/master-data.js — Employees, companies, goods (with server-side cache)
import pool from '../../db/pool.js';
import { cache } from '../../db/cache.js';

/**
 * GET getMasterData — returns employees, companies, goods.
 * Server-side LRU cache (5-min TTL) so 100 concurrent page loads
  * don't all hit the DB simultaneously.
 */
export async function handleGetMasterData(req, res) {
  const cacheKey = 'master_data';
  let data = cache.get(cacheKey);

  if (!data) {
    try {
      const [empResult, coResult, goodsResult] = await Promise.all([
        pool.query(`SELECT id, full_name as name, position, department, company, email,
                           status, role, is_admin as isAdmin
                    FROM employees WHERE status = 'active' ORDER BY full_name`),
        pool.query(`SELECT id, company_name as name, company_code as code, company_key as key,
                           legal_rep_name, legal_rep_email, legal_rep_sig_url,
                           accountant_name, accountant_email, accountant_sig_url,
                           treasurer_name, treasurer_email, treasurer_sig_url
                    FROM companies ORDER BY company_name`),
        pool.query(`SELECT id, name, category, moq, unit, unit_price as price, spec,
                           qbo_code, status
                    FROM goods_catalog WHERE status = 'active' ORDER BY name`),
      ]);

      data = {
        employees: empResult.rows,
        companies: coResult.rows,
        goods: goodsResult.rows,
      };

      cache.set(cacheKey, data);
      console.log('[MasterData] Cache miss — fetched from DB, cached for 5 min');
    } catch (err) {
      console.error('[MasterData] Error:', err.message);
      return res.status(500).json({ success: false, message: 'Lỗi server' });
    }
  }

  return res.json({ success: true, data });
}

/**
 * GET getCompanyApprovers — returns approvers (with signature URLs) for a company.
 * Used by signature verification.
 */
export async function handleGetCompanyApprovers(req, res) {
  const { companyName, companyKey, lang } = req.body || req.query || {};
  const vi = lang !== 'en';

  if (!companyName) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Tên công ty là bắt buộc' : 'Company name is required',
    });
  }

  try {
    let query, params;
    if (companyKey) {
      query = `SELECT * FROM companies WHERE company_name = $1 AND company_key = $2 LIMIT 1`;
      params = [companyName, companyKey];
    } else {
      query = `SELECT * FROM companies WHERE company_name = $1 LIMIT 1`;
      params = [companyName];
    }

    const { rows } = await pool.query(query, params);
    const company = rows[0];
    if (!company) {
      return res.status(404).json({
        success: false,
        message: vi ? 'Không tìm thấy công ty' : 'Company not found',
      });
    }

    // Return approvers in the structure the frontend expects
    return res.json({
      success: true,
      data: {
        legalRep: {
          name: company.legal_rep_name,
          email: company.legal_rep_email,
          signature: company.legal_rep_sig_url,
        },
        accountant: {
          name: company.accountant_name,
          email: company.accountant_email,
          signature: company.accountant_sig_url,
        },
        treasurer: {
          name: company.treasurer_name,
          email: company.treasurer_email,
          signature: company.treasurer_sig_url,
        },
      },
    });
  } catch (err) {
    console.error('[MasterData] getApprovers error:', err.message);
    return res.status(500).json({ success: false, message: vi ? 'Lỗi server' : 'Server error' });
  }
}

/**
 * GET getEmployees — employee directory (active only).
 */
export async function handleGetEmployees(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name as name, position, department, company, email,
              status, role, is_admin as isAdmin
       FROM employees WHERE status = 'active' ORDER BY full_name`
    );
    return res.json({ success: true, data: { employees: rows } });
  } catch (err) {
    console.error('[MasterData] getEmployees error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}
