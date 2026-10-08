// api/lib/approval/signature-check.js — which registered sample signature belongs to an approver.
// On Postgres the server stamps this sample on the approval after a password check (step-up.js);
// the old browser image comparison and its verified === true rule are gone. Old approvals keep their
// stored signatureVerification objects. Takes `db` as an argument (no pool import).
const lower = (s) => String(s || '').trim().toLowerCase();

// Role → Master Company signature column (the sample each role holder signs against)
export const ROLE_SAMPLE = { chief_accountant: 'accountant_sig_url', legal_rep: 'legal_rep_sig_url', treasurer: 'treasurer_sig_url' };
const ROLE_EMAIL = { chief_accountant: 'accountant_email', legal_rep: 'legal_rep_email', treasurer: 'treasurer_email' };
const EMPLOYEE_SAMPLE_HEADERS = ['Signature', 'Chữ ký', 'Chu_ky', 'employee_signature', 'Signature_URL'];

/**
 * The sample signature an approver must match: their role's sample on the
 * company (Master Company), else a Signature column on their Master
 * Employee row. { url, from } — url '' when none is registered.
 * `entries` = [{ role, label }] the approver holds; null = derive them from the company's role emails.
 */
export async function sampleSignatureFor(db, companyId, entries, email) {
  const me = lower(email);
  const company = companyId ? (await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId])).rows[0] : null;
  const held = entries || (company ? Object.keys(ROLE_SAMPLE).filter((r) => me && lower(company[ROLE_EMAIL[r]]) === me).map((role) => ({ role, label: role })) : []);
  for (const a of held) {
    const col = ROLE_SAMPLE[a.role];
    if (company && col && company[col]) return { url: company[col], from: a.label };
  }
  const emp = (await db.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [me])).rows[0];
  const extra = (emp && emp.extra) || {};
  const hit = EMPLOYEE_SAMPLE_HEADERS.find((h) => String(extra[h] || '').trim());
  return hit ? { url: String(extra[hit]).trim(), from: 'Master Employee' } : { url: '', from: '' };
}

export const NO_SAMPLE = {
  vi: 'Chưa có chữ ký mẫu của bạn. Vui lòng nhờ quản trị viên bổ sung trong Dữ liệu gốc (Nhân viên › Signature).',
  en: 'No sample signature is registered for you. Ask an administrator to add it in Master Data (Employees › Signature).',
};
