import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, resolveRole, companyRoles, roleLabel } from '../../api/lib/approval/roles.js';

const company = {
  id: 4,
  company_name: 'CÔNG TY TNHH MEDIA INSIDER',
  accountant_name: 'Nguyễn Thị Nhanh', accountant_email: 'nhanh.nguyen@tl-c.com.vn', accountant_sig_url: 'https://sig/a',
  legal_rep_name: 'Nguyễn Văn Chinh', legal_rep_email: 'chinh.nguyen@mediainsider.vn', legal_rep_sig_url: '',
  treasurer_name: '', treasurer_email: '', treasurer_sig_url: '',
  extra: { Email_Director: 'Anh.Le@mediainsider.vn', 'Financial_Manager_Name': 'Linh Lê Thùy (Linh Lê)', 'Financial_Manager_Email': 'linh.le@tl-c.com.vn' },
};
const employeesByEmail = new Map([['anh.le@mediainsider.vn', { full_name: 'Lê Ngân Anh' }]]);

test('chief accountant comes from the typed company columns', () => {
  assert.deepEqual(resolveRole('chief_accountant', company, employeesByEmail),
    { email: 'nhanh.nguyen@tl-c.com.vn', name: 'Nguyễn Thị Nhanh', signature: 'https://sig/a' });
});

test('director comes from extra.Email_Director, name from the employee list, email lowercased', () => {
  assert.deepEqual(resolveRole('director', company, employeesByEmail),
    { email: 'anh.le@mediainsider.vn', name: 'Lê Ngân Anh', signature: '' });
});

test('a role with no person for this company resolves to null', () => {
  assert.equal(resolveRole('treasurer', company, employeesByEmail), null);
});

test('unknown role key throws', () => {
  assert.throws(() => resolveRole('janitor', company, employeesByEmail), /Unknown role/);
});

test('companyRoles lists every role with today\'s person (or empty)', () => {
  const list = companyRoles(company, employeesByEmail);
  assert.equal(list.length, Object.keys(ROLES).length);
  const ca = list.find((r) => r.role === 'chief_accountant');
  assert.equal(ca.name, 'Nguyễn Thị Nhanh');
  assert.equal(list.find((r) => r.role === 'treasurer').email, '');
});

test('labels are bilingual', () => {
  assert.equal(roleLabel('chief_accountant', 'vi'), 'Kế toán trưởng');
  assert.equal(roleLabel('chief_accountant', 'en'), 'Chief Accountant');
});
