// api/lib/approval/roles.js — Approver roles resolved per company from Master Company.
//
// A role is a position in a company ("Kế toán trưởng"); the person holding it
// comes from that company's Master Company row, so when Master Data changes
// the person, every approval flow using the role follows automatically.
//
// Sources: `col:` = typed column on `companies`, `extra:` = sheet header kept in
// companies.extra. The name is the employee's full_name when the email is an
// employee, else the name written in the company row.

export const ROLES = {
  chief_accountant:    { vi: 'Kế toán trưởng',          en: 'Chief Accountant',     email: 'col:accountant_email', name: 'col:accountant_name', signature: 'col:accountant_sig_url' },
  legal_rep:           { vi: 'Đại diện pháp luật',      en: 'Legal Representative', email: 'col:legal_rep_email', name: 'col:legal_rep_name', signature: 'col:legal_rep_sig_url' },
  treasurer:           { vi: 'Thủ quỹ',                 en: 'Treasurer',            email: 'col:treasurer_email', name: 'col:treasurer_name', signature: 'col:treasurer_sig_url' },
  director:            { vi: 'Giám đốc',                en: 'Director',             email: 'extra:Email_Director' },
  financial_manager:   { vi: 'Quản lý tài chính',       en: 'Financial Manager',    email: 'extra:Financial_Manager_Email', name: 'extra:Financial_Manager_Name' },
  chairperson:         { vi: 'Chủ tịch',                en: 'Chairperson',          email: 'extra:Chairperson_Email', name: 'extra:Chairperson_Name' },
  general_accountant:  { vi: 'Kế toán tổng hợp',        en: 'General Accountant',   email: 'extra:General_Accountant-Email', name: 'extra:General_Accountant-Name' },
  hr_representative:   { vi: 'Đại diện HCNS',           en: 'HR Representative',    email: 'extra:Dai_dien_HCNS-Email', name: 'extra:Dai_dien_HCNS-Name' },
  authorized_director: { vi: 'Ủy quyền Giám đốc',       en: 'Authorized Director',  email: 'extra:Uy_quyen_GD-Email', name: 'extra:Uy_quyen_GD-Name' },
  bank_approver:       { vi: 'Người duyệt ngân hàng',   en: 'Bank Approver',        email: 'extra:Bank_Appover_Email', name: 'extra:Bank_Appover_Name' },
  bod_1:               { vi: 'Thành viên HĐQT 1',       en: 'Board Member 1',       email: 'extra:BOD_1-Email', name: 'extra:BOD_1-Name' },
  bod_2:               { vi: 'Thành viên HĐQT 2',       en: 'Board Member 2',       email: 'extra:BOD_2-Email', name: 'extra:BOD_2-Name' },
  bod_3:               { vi: 'Thành viên HĐQT 3',       en: 'Board Member 3',       email: 'extra:BOD_3-Email', name: 'extra:BOD_3-Name' },
};

function read(company, source) {
  if (!source) return '';
  const [kind, key] = [source.slice(0, source.indexOf(':')), source.slice(source.indexOf(':') + 1)];
  const v = kind === 'col' ? company[key] : (company.extra || {})[key];
  return v == null ? '' : String(v).trim();
}

export function roleLabel(key, lang = 'vi') {
  const r = ROLES[key];
  if (!r) throw new Error(`Unknown role: ${key}`);
  return lang === 'en' ? r.en : r.vi;
}

/**
 * Today's holder of `key` in `company`, or null when the company has nobody
 * in that role. employeesByEmail: Map(lowercase email → { full_name }).
 */
export function resolveRole(key, company, employeesByEmail = new Map()) {
  const r = ROLES[key];
  if (!r) throw new Error(`Unknown role: ${key}`);
  const email = read(company, r.email).toLowerCase();
  if (!email) return null;
  const employee = employeesByEmail.get(email);
  // The employee list spells names consistently; the sheet's role columns do not
  const name = (employee && employee.full_name) || read(company, r.name) || '';
  return { email, name, signature: read(company, r.signature) };
}

/** Every role with today's holder for this company ('' when nobody). */
export function companyRoles(company, employeesByEmail = new Map(), lang = 'vi') {
  return Object.keys(ROLES).map((role) => {
    const who = company ? resolveRole(role, company, employeesByEmail) : null;
    return { role, label: roleLabel(role, lang), email: who ? who.email : '', name: who ? who.name : '' };
  });
}
