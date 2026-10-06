// api/handlers/master-data.js — Employees, companies, goods (with server-side cache)
import pool from '../../db/pool.js';
import { cache } from '../../db/cache.js';

/**
 * Shape rows to match what the HTML clients already expect from GAS sheets:
 * - employees: full_name, employee_email, employee_status, plus short aliases
 * - companies: full_name / company_name, accountant_*, legal_rep_*, treasurer_*
 * - goods: sheet-like headers used by purchase_request seedGoods
 *
 * node-pg lowercases unquoted aliases — always quote "isAdmin" etc.
 */
function mapEmployee(row) {
  const fullName = row.full_name || row.name || '';
  const email = row.email || '';
  const status = row.status || 'active';
  return {
    id: row.id,
    name: fullName,
    full_name: fullName,
    'Họ và tên': fullName,
    email,
    employee_email: email,
    Email: email,
    position: row.position || '',
    role: row.role || row.position || '',
    'Chức vụ': row.position || row.role || '',
    department: row.department || '',
    department_name: row.department || '',
    'Phòng ban': row.department || '',
    company: row.company || '',
    'Công ty': row.company || '',
    phone: row.phone || '',
    'Điện thoại': row.phone || '',
    status,
    employee_status: status,
    Status: status,
    employee_id: row.employee_id || (row.id != null ? String(row.id) : ''),
    EmployeeId: row.employee_id || (row.id != null ? String(row.id) : ''),
    employeeId: row.employee_id || (row.id != null ? String(row.id) : ''),
    isAdmin: !!row.is_admin,
    isadmin: !!row.is_admin,
  };
}

function mapCompany(row) {
  const name = row.company_name || row.name || '';
  return {
    id: row.id,
    name,
    full_name: name,
    company_name: name,
    'Tên công ty': name,
    code: row.company_code || '',
    company_code: row.company_code || '',
    'Mã công ty': row.company_code || '',
    key: row.company_key || '',
    company_key: row.company_key || '',
    'Mã định danh': row.company_key || '',
    legal_rep_name: row.legal_rep_name || '',
    legal_rep_email: row.legal_rep_email || '',
    legal_rep_sig_url: row.legal_rep_sig_url || '',
    accountant_name: row.accountant_name || '',
    accountant_email: row.accountant_email || '',
    accountant_sig_url: row.accountant_sig_url || '',
    treasurer_name: row.treasurer_name || '',
    treasurer_email: row.treasurer_email || '',
    treasurer_sig_url: row.treasurer_sig_url || '',
    address: row.address || '',
    'Địa chỉ': row.address || '',
    tax_code: row.tax_code || '',
    'Mã số thuế': row.tax_code || '',
  };
}

function mapGoods(row) {
  return {
    id: row.id,
    name: row.name || '',
    Items: row.name || '',
    category: row.category || '',
    Category: row.category || '',
    moq: row.moq,
    'Min. Order': row.moq,
    unit: row.unit || '',
    Unit: row.unit || '',
    price: row.unit_price != null ? row.unit_price : row.price,
    'Unit Price': row.unit_price != null ? row.unit_price : row.price,
    spec: row.spec || '',
    Specificaton: row.spec || '',
    Specification: row.spec || '',
    qbo_code: row.qbo_code || '',
    'CUKCUK/QBO Code': row.qbo_code || '',
    status: row.status || 'active',
    Status: row.status || 'active',
  };
}

/**
 * GET getMasterData — returns employees, companies, goods.
 * Server-side LRU cache (5-min TTL) so 100 concurrent page loads
 * don't all hit the DB simultaneously.
 */
export async function handleGetMasterData(req, res) {
  const cacheKey = 'master_data_v3';
  let data = cache.get(cacheKey);

  if (!data) {
    try {
      const [empResult, coResult, goodsResult] = await Promise.all([
        pool.query(
          `SELECT id, full_name, position, department, company, email, phone,
                  status, role, employee_id, is_admin
           FROM employees
           WHERE status = 'active'
           ORDER BY full_name`
        ),
        pool.query(
          `SELECT id, company_name, company_code, company_key,
                  legal_rep_name, legal_rep_email, legal_rep_sig_url,
                  accountant_name, accountant_email, accountant_sig_url,
                  treasurer_name, treasurer_email, treasurer_sig_url,
                  address, tax_code
           FROM companies
           ORDER BY company_name, company_key`
        ),
        pool.query(
          `SELECT id, name, category, moq, unit, unit_price, spec, qbo_code, status
           FROM goods_catalog
           WHERE status = 'active' AND COALESCE(TRIM(name), '') <> ''
           ORDER BY name`
        ),
      ]);

      data = {
        employees: empResult.rows.map(mapEmployee),
        companies: coResult.rows.map(mapCompany),
        customers: [],
        suppliers: [],
        goods: goodsResult.rows.map(mapGoods),
        timestamp: new Date().toISOString(),
      };

      cache.set(cacheKey, data);
      console.log('[MasterData] Cache miss — fetched from DB, cached for 5 min');
    } catch (err) {
      console.error('[MasterData] Error:', err.message);
      return res.status(500).json({ success: false, message: 'Lỗi server' });
    }
  }

  return res.json({ success: true, message: 'Master data fetched successfully', data });
}

/**
 * getCompanies — company picker for cash book + home page.
 * Same shape as GAS handleGetCompanies: data.companies_data[] keyed by
 * the sheet's Vietnamese headers.
 */
export async function handleGetCompanies(req, res) {
  const cacheKey = 'companies_v1';
  let data = cache.get(cacheKey);

  if (!data) {
    try {
      const { rows } = await pool.query(
        `SELECT company_name, company_code, company_key
         FROM companies
         WHERE COALESCE(TRIM(company_name), '') <> ''
         ORDER BY company_name, company_key`
      );
      data = {
        companies_data: rows.map((r) => ({
          'Tên công ty': r.company_name,
          'Mã công ty': r.company_code || '',
          'Mã định danh': r.company_key || '',
        })),
      };
      cache.set(cacheKey, data);
    } catch (err) {
      console.error('[MasterData] getCompanies error:', err.message);
      return res.status(500).json({ success: false, message: 'Lỗi server' });
    }
  }

  return res.json({ success: true, message: 'Thành công', data });
}

/**
 * getCompanyApprovers — the three voucher approvers (with signature sample
 * links) for a company. Same shape as GAS handleGetCompanyApprovers:
 * data.approvers.{legalRep, accountant, treasurer}.{name, email, signature, role}.
 * voucher.html, approve_voucher.html and index.html all read data.approvers.
 * Accepts companyName or company (body or query string), companyKey optional.
 */
export async function handleGetCompanyApprovers(req, res) {
  const src = Object.assign({}, req.query || {}, req.body || {});
  const companyName = String(src.companyName || src.company || '').trim();
  const companyKey = String(src.companyKey || '').trim();
  const vi = src.lang !== 'en';

  if (!companyName) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Tên công ty là bắt buộc' : 'Company name is required',
    });
  }

  try {
    const { rows } = companyKey
      ? await pool.query(`SELECT * FROM companies WHERE company_name = $1 AND company_key = $2 LIMIT 1`, [companyName, companyKey])
      : await pool.query(`SELECT * FROM companies WHERE company_name = $1 ORDER BY id LIMIT 1`, [companyName]);
    const company = rows[0];
    if (!company) {
      return res.status(404).json({
        success: false,
        message: (vi ? 'Không tìm thấy công ty: ' : 'Company not found: ') + companyName,
      });
    }

    const approvers = {
      legalRep: { name: company.legal_rep_name || '', email: company.legal_rep_email || '', signature: company.legal_rep_sig_url || '', role: 'Đại diện pháp luật' },
      accountant: { name: company.accountant_name || '', email: company.accountant_email || '', signature: company.accountant_sig_url || '', role: 'Kế toán trưởng' },
      treasurer: { name: company.treasurer_name || '', email: company.treasurer_email || '', signature: company.treasurer_sig_url || '', role: 'Thủ quỹ' },
    };
    return res.json({
      success: true,
      message: 'Thành công',
      // approvers: the GAS shape every page reads; the flat keys are kept for older callers
      data: { companyName: company.company_name, approvers, ...approvers },
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
      `SELECT id, full_name, position, department, company, email, phone,
              status, role, employee_id, is_admin
       FROM employees WHERE status = 'active' ORDER BY full_name`
    );
    const employees = rows.map(mapEmployee);
    return res.json({ success: true, data: { employees } });
  } catch (err) {
    console.error('[MasterData] getEmployees error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * getSuppliers — payment request vendor picker, from Master Vendor.
 * Same rules as GAS handleGetSuppliers: skip rows without Vendor_Full_Name;
 * with companyGroupKey, keep rows whose "Vendor Full Name (void)" is blank
 * or equal to the key (case-insensitive).
 */
export async function handleGetSuppliers(req, res) {
  const groupKey = String(req.body?.companyGroupKey || req.query?.companyGroupKey || '').trim().toLowerCase();
  try {
    const { rows } = await pool.query(
      `SELECT extra->>'Vendor_Full_Name' AS vendor_name,
              COALESCE(extra->>'Vendor Type', '') AS vendor_type,
              COALESCE(extra->>'Tax ID', '')      AS tax_id,
              COALESCE(extra->>'Address', '')     AS address
       FROM master_vendors
       WHERE COALESCE(TRIM(extra->>'Vendor_Full_Name'), '') <> ''
         AND ($1 = '' OR COALESCE(TRIM(extra->>'Vendor Full Name (void)'), '') = ''
              OR LOWER(TRIM(extra->>'Vendor Full Name (void)')) = $1)`,
      [groupKey]
    );
    const suppliers = rows
      .map((r) => ({ vendor_name: r.vendor_name.trim(), vendor_type: r.vendor_type.trim(), tax_id: r.tax_id.trim(), address: r.address.trim() }))
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'vi'));
    return res.json({ success: true, message: 'Suppliers retrieved successfully', data: { suppliers, count: suppliers.length } });
  } catch (err) {
    console.error('[MasterData] getSuppliers error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * getVendorBanks — active bank accounts for one vendor, from Master Vendor_Bank.
 * Vendor_name must match Vendor_Full_Name exactly (as in GAS).
 */
export async function handleGetVendorBanks(req, res) {
  const vendorName = String(req.body?.vendorName || req.query?.vendorName || '').trim();
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(extra->>'Vendor Bank Name', '')            AS account_name,
              COALESCE(extra->>'Bank Number', '')                 AS account_no,
              COALESCE(extra->>'Bank Name', '')                   AS bank_name,
              COALESCE(extra->>'Note', '')                        AS note,
              COALESCE(extra->>'Bank Address', '')                AS bank_address,
              COALESCE(extra->>'Beneficiary_Bank_SWIFT_code', '') AS swift_code
       FROM master_vendor_banks
       WHERE ($1 = '' OR TRIM(extra->>'Vendor_name') = $1)
         AND LOWER(TRIM(COALESCE(extra->>'Status', ''))) = 'active'
       ORDER BY sheet_row NULLS LAST, id`,
      [vendorName]
    );
    const banks = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.trim()])));
    return res.json({ success: true, message: 'Banks retrieved successfully', data: { banks } });
  } catch (err) {
    console.error('[MasterData] getVendorBanks error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}
