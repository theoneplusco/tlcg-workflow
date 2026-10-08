// api/lib/master-registry.js — The master sheets migrated from Google Sheets.
//
// Each sheet keeps its exact headers (stored in master_columns). A header
// listed in `core` maps to a typed column that app logic reads; every other
// header lives in the row's `extra` JSONB. Core and `locked` headers cannot be
// deleted from the admin page; `hidden` headers are never sent to the browser.
// `readOnly` headers are shown but never edited; `audit: true` writes every
// change to master_audit; `sheet: null` marks an app-only table (no Google
// Sheet tab) that scripts/import-master-sheets.js never imports.

export const SPREADSHEET_ID = '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g';

const text = { parse: (v) => str(v), format: (v) => (v == null ? '' : String(v)) };
const lower = { parse: (v) => str(v).toLowerCase(), format: text.format };
// Stored lowercase for app logic ('active'); shown the way the sheet writes it ('Active')
const status = {
  parse: lower.parse,
  format: (v) => { const s = v == null ? '' : String(v); return s.charAt(0).toUpperCase() + s.slice(1); },
};
const email = {
  parse: (v) => {
    const s = str(v).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new Error('Email không hợp lệ.');
    return s;
  },
  format: text.format,
};
const required = {
  parse: (v) => {
    const s = str(v);
    if (!s) throw new Error('Ô này không được để trống.');
    return s;
  },
  format: text.format,
};
const bool = {
  parse: (v) => v === true || /^(true|yes|1|x)$/i.test(str(v)),
  format: (v) => (v ? 'TRUE' : 'FALSE'),
};
const number = {
  parse: (v) => {
    const s = str(v);
    if (!s) return 0;
    const n = parseFloat(s.replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) throw new Error('Cần nhập số.');
    return n;
  },
  format: (v) => (v == null ? '' : String(Number(v))),
};

function str(v) {
  return v == null ? '' : String(v).trim();
}

// ── Value rules (checked on every admin edit; sent to the browser too) ──
// enum: fixed choices (case-insensitive match, saved in the canonical case)
// pattern: regex + example; email / date / digits / number: common formats
// rate: a whole number of VND ≥ 1 (exchange rates)
const oneOf = (...values) => ({ type: 'enum', values });
const YES_NO = oneOf('Yes', 'No');
const TRUE_FALSE_UPPER = oneOf('TRUE', 'FALSE');
const TRUE_FALSE = oneOf('True', 'False');
const EMAIL = { type: 'email' };
const DATE = { type: 'date' };
const DIGITS = { type: 'digits' };
const AMOUNT = { type: 'number', min: 0 };
// Exchange rate: a whole number of VND for 1 unit of the currency (decision 2026-10-07)
export const FX_RATE_MESSAGE = 'Tỷ giá phải là số nguyên dương (VND cho 1 đơn vị).';
const URL = { type: 'pattern', pattern: '^https?://\\S+$', example: 'https://drive.google.com/…' };

export const MASTER_TABLES = {
  employees: {
    title: 'Employees',
    sheet: 'Master Employee',
    gid: '2018642708',
    table: 'employees',
    core: {
      full_name:          { col: 'full_name', type: required },
      position:           { col: 'position', type: text },
      department_name:    { col: 'department', type: text },
      company_name:       { col: 'company', type: text },
      employee_email:     { col: 'email', type: email },
      employee_phone:     { col: 'phone', type: text },
      employee_status:    { col: 'status', type: status },
      employee_id:        { col: 'employee_id', type: text },
      employee_role:      { col: 'role', type: text },
      isAdmin:            { col: 'is_admin', type: bool },
      mustChangePassword: { col: 'must_change_password', type: bool },
    },
    // Passwords are imported into password_hash / legacy_password_sha256 only
    hidden: ['login_password', 'password', 'mustChangePassword'],
    locked: [],
    rules: {
      full_name: { type: 'required' },
      employee_email: { type: 'email', required: true },
      employee_status: { ...oneOf('Active', 'Inactive'), required: true },
      employee_id: { type: 'pattern', pattern: '^[A-Z]{4}-[0-9]{3}$', example: 'TLCG-001', upper: true },
      employee_phone: { type: 'pattern', pattern: '^\\+?[0-9]{8,12}$', example: '0903954475' },
      employee_role: oneOf('System Administrator', 'User'),
      isAdmin: { ...TRUE_FALSE_UPPER, required: true },
      'Tổng phép năm': AMOUNT,
      'Ngày phép năm': AMOUNT,
      '+ Phép thâm niên': AMOUNT,
      'Phép mới mỗi tháng': AMOUNT,
      'Tồn phép hiện tại': AMOUNT,
    },
  },
  companies: {
    title: 'Companies',
    sheet: 'Master Company',
    gid: '0',
    table: 'companies',
    core: {
      Company_Name:                   { col: 'company_name', type: required },
      Company_Code:                   { col: 'company_code', type: text },
      Company_Key_Or_Taxid:           { col: 'company_key', type: text },
      Legal_Representative_Name:      { col: 'legal_rep_name', type: text },
      Legal_Representative_Email:     { col: 'legal_rep_email', type: lower },
      Legal_Representative_Signature: { col: 'legal_rep_sig_url', type: text },
      Chief_Accountant_Name:          { col: 'accountant_name', type: text },
      Chief_Accountant_Email:         { col: 'accountant_email', type: lower },
      Chief_Accountant_Signature:     { col: 'accountant_sig_url', type: text },
      Treasurer_Name:                 { col: 'treasurer_name', type: text },
      Treasurer_Email:                { col: 'treasurer_email', type: lower },
      Treasurer_Signature:            { col: 'treasurer_sig_url', type: text },
      Tax_ID:                         { col: 'tax_code', type: text },
      Address:                        { col: 'address', type: text },
    },
    hidden: [],
    locked: [],
    rules: {
      Company_Name: { type: 'required' },
      Legal_Representative_Signature: URL,
      Chief_Accountant_Signature: URL,
      Treasurer_Signature: URL,
      Effective_Date: DATE,
      Tax_ID: { type: 'pattern', pattern: '^[0-9]{10}(-[0-9]{3})?$', example: '0314097507' },
      AP_Bank_Account: DIGITS,
      So_tai_khoan_AR: DIGITS,
      Company: TRUE_FALSE,
      Active: TRUE_FALSE,
      Second_Authorization: YES_NO,
      Tu_dong_hach_toan: YES_NO,
      QB_Type: oneOf('VN', 'US'),
      Client: oneOf('TLC Group', 'Client'),
      QB_gg_sheet_url: URL,
    },
  },
  clients: {
    title: 'Clients',
    sheet: 'Master Client',
    gid: '1441019603',
    table: 'master_clients',
    core: {},
    hidden: [],
    locked: ['Client_Name'],
    rules: {
      Client_Name: { type: 'required' },
      No: AMOUNT,
      Created_Date: DATE,
    },
  },
  vendors: {
    title: 'Vendors',
    sheet: 'Master Vendor',
    gid: '1027351309',
    table: 'master_vendors',
    core: {},
    hidden: [],
    // Read by getSuppliers (payment request vendor picker)
    locked: ['Vendor_Full_Name', 'Vendor Full Name (void)', 'Vendor Type', 'Tax ID', 'Address'],
    rules: {
      'Payment Currency': oneOf('VND', 'USD'),
      'Vendor Type': oneOf('Vietnam company', 'Foreign company', 'Individual', 'Foreign Contractor (Individual)', 'Others'),
      'Company Tax ID': DIGITS,
      'QB ID': DIGITS,
      Loan: YES_NO,
      FCT: YES_NO,
      Active: YES_NO,
      Khong_cu_tru: oneOf('Cư trú', 'Không cư trú'),
      Loai_thue_GTGT: oneOf('10%', '8%', '5%', '0%', 'KCT'),
      Loai_giay_to: oneOf('Thẻ CCCD', 'Hộ chiếu'),
      Gioi_tinh: oneOf('Male', 'Female'),
      Ngay_hop_dong: DATE,
      Ngay_cap: DATE,
      Ngay_sinh: DATE,
    },
  },
  vendor_banks: {
    title: 'Vendor banks',
    sheet: 'Master Vendor_Bank',
    gid: '2122977556',
    table: 'master_vendor_banks',
    core: {},
    hidden: [],
    // Read by getVendorBanks (payment request bank picker)
    locked: ['Vendor_name', 'Vendor Bank Name', 'Note', 'Bank Name', 'Bank Number',
      'Bank Address', 'Beneficiary_Bank_SWIFT_code', 'Status'],
    rules: {
      Vendor_name: { type: 'required' },
      // Blank = not offered in the payment request bank picker (119 sheet rows are blank)
      Status: oneOf('Active', 'Inactive'),
      Beneficiary_Bank_SWIFT_code: { type: 'pattern', pattern: '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$', example: 'VTCBVNVX', upper: true },
    },
  },
  goods: {
    title: 'Goods (KTT)',
    sheet: 'Goods-KTT',
    gid: '1954041704',
    table: 'goods_catalog',
    core: {
      Category:          { col: 'category', type: text },
      Items:             { col: 'name', type: required },
      Unit:              { col: 'unit', type: text },
      'Min. Order':      { col: 'moq', type: number },
      Specificaton:      { col: 'spec', type: text },
      'Unit Price':      { col: 'unit_price', type: number },
      'CUKCUK/QBO Code': { col: 'qbo_code', type: text },
      Status:            { col: 'status', type: status },
    },
    hidden: [],
    locked: [],
    rules: {
      Items: { type: 'required' },
      'Min. Order': { type: 'number', min: 0, integer: true },
      'Unit Price': AMOUNT,
      Status: { ...oneOf('Active', 'Disable'), required: true },
    },
  },
  // App-only (no Google Sheet tab): the PR full-branch threshold is 2,000,000 VND (decision 2026-10-07);
  // other currencies are converted with these rates. A row without a rate refuses PR submits in that currency.
  // Rows are added / removed with adminExchangeRateAdd / adminExchangeRateDelete (admin-master.js).
  exchange_rates: {
    title: 'Exchange rates',
    sheet: null,
    gid: null,
    table: 'exchange_rates',
    core: {
      Currency:    { col: 'currency', type: required },
      Rate_To_VND: { col: 'rate_to_vnd', type: number },
    },
    hidden: [],
    locked: [],
    readOnly: ['Currency'],
    audit: true,
    rules: {
      Currency: { type: 'pattern', pattern: '^[A-Z]{3}$', example: 'USD', upper: true, required: true },
      Rate_To_VND: { type: 'rate', required: true },
    },
  },
};

export function getMasterTable(key) {
  return Object.prototype.hasOwnProperty.call(MASTER_TABLES, key) ? MASTER_TABLES[key] : null;
}

/** A column the admin page may not delete. */
export function isProtectedColumn(def, name) {
  return Object.prototype.hasOwnProperty.call(def.core, name) || def.locked.includes(name);
}

/** Typed columns of a core table, for SELECT lists. */
export function coreColumns(def) {
  return [...new Set(Object.values(def.core).map((c) => c.col))];
}

/**
 * A typed cell as shown on the admin page. The sheet's own text is kept in
 * `extra` beside the typed value (e.g. "Active" for status 'active',
 * "15,000" for 15000) and shown while it still means the same value;
 * after the typed value changes elsewhere, the formatted value is shown.
 */
export function coreCellValue(core, raw, dbValue) {
  if (raw != null) {
    try {
      const parsed = core.type.parse(raw);
      const same = core.type === number
        ? Number(parsed) === Number(dbValue)
        : String(parsed) === String(dbValue ?? '');
      if (same) return String(raw);
    } catch {
      // raw no longer valid — fall through to the typed value
    }
  }
  return core.type.format(dbValue);
}

/** The rule for a column: explicit, or email for any *email* column. */
export function columnRule(def, name) {
  if (def.rules && def.rules[name]) return def.rules[name];
  if (/e-?mail/i.test(name)) return EMAIL;
  return null;
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})$/;

/**
 * Check one value against a rule. Returns { ok: true, value } with the value
 * to save (trimmed, canonical case) or { ok: false, message }.
 * The browser runs the same logic (admin.html: checkRule).
 */
export function checkRule(rule, raw) {
  let v = raw == null ? '' : String(raw).trim();
  if (!rule) return { ok: true, value: v };
  if (!v) {
    return rule.required || rule.type === 'required'
      ? { ok: false, message: 'Ô này không được để trống.' }
      : { ok: true, value: '' };
  }
  if (rule.upper) v = v.toUpperCase();
  switch (rule.type) {
    case 'required':
      return { ok: true, value: v };
    case 'enum': {
      const hit = rule.values.find((x) => x.toLowerCase() === v.toLowerCase());
      return hit ? { ok: true, value: hit } : { ok: false, message: `Chỉ nhận: ${rule.values.join(' / ')}.` };
    }
    case 'pattern':
      return new RegExp(rule.pattern).test(v) ? { ok: true, value: v } : { ok: false, message: `Sai định dạng — ví dụ: ${rule.example}.` };
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false, message: 'Email không hợp lệ.' };
    case 'date':
      return DATE_RE.test(v) ? { ok: true, value: v } : { ok: false, message: 'Ngày dạng YYYY-MM-DD (ví dụ 2026-10-06).' };
    case 'digits':
      return /^[0-9]+$/.test(v) ? { ok: true, value: v } : { ok: false, message: 'Chỉ nhận chữ số.' };
    case 'number': {
      const n = Number(v.replace(/,/g, ''));
      if (!Number.isFinite(n) || (rule.integer && !Number.isInteger(n))) return { ok: false, message: rule.integer ? 'Cần số nguyên.' : 'Cần nhập số.' };
      if (rule.min != null && n < rule.min) return { ok: false, message: `Không được nhỏ hơn ${rule.min}.` };
      return { ok: true, value: v };
    }
    case 'rate':
      // Whole VND, digits with optional thousands commas ("26000", "26,000"); no decimals, no "26.000"
      // and below 10^12 (the NUMERIC(18,6) column)
      return /^(\d+|\d{1,3}(,\d{3})+)$/.test(v) && Number(v.replace(/,/g, '')) >= 1 && Number(v.replace(/,/g, '')) < 1e12
        ? { ok: true, value: v } : { ok: false, message: FX_RATE_MESSAGE };
    default:
      return { ok: true, value: v };
  }
}

// ── Labels: one style across the admin page — Words_Joined_Like_This ──
const ACRONYMS = { id: 'ID', url: 'URL', qb: 'QB', vat: 'VAT', ar: 'AR', ap: 'AP', mst: 'MST' };

/**
 * "employee_email" → "Employee_Email", "Min. Order" → "Min_Order",
 * "isAdmin" → "Is_Admin", "Tax ID" → "Tax_ID", "+ Phép thâm niên" → "Phép_Thâm_Niên".
 * Words already in capitals (QB, BHXH, CUKCUK) are kept.
 */
export function formatLabel(name) {
  const words = String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}%]+/u)
    .filter(Boolean);
  if (!words.length) return String(name);
  return words.map((w) => {
    const lower = w.toLowerCase();
    if (ACRONYMS[lower]) return ACRONYMS[lower];
    if (w.length > 1 && w === w.toUpperCase() && /\p{L}/u.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join('_');
}
