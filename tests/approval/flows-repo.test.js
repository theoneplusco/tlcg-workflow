// Integration test — runs only with TEST_DATABASE_URL pointing at a throwaway
// database that has db/schema.sql + migrations applied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getActiveFlow, listVersions, saveVersion, loadCompanyContext } from '../../api/lib/approval/flows-repo.js';
import { DEFAULT_STEPS } from '../../api/lib/approval/engine.js';

const url = process.env.TEST_DATABASE_URL;
const db = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const skip = !url && 'set TEST_DATABASE_URL to run';
let coA, coB;

before(async () => {
  if (!db) return;
  await db.query(`TRUNCATE approval_flows`);
  await db.query(`DELETE FROM companies WHERE company_key IN ('TA','TB')`);
  coA = (await db.query(`INSERT INTO companies (company_name, company_key, accountant_email, accountant_name, extra)
                         VALUES ('Test A','TA','ca@x.vn','CA Person', '{"Email_Director":"dir@x.vn"}') RETURNING id`)).rows[0].id;
  coB = (await db.query(`INSERT INTO companies (company_name, company_key) VALUES ('Test B','TB') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO employees (full_name, email, status) VALUES ('Dir Ector','dir@x.vn','active') ON CONFLICT (email) DO NOTHING`);
});
after(async () => { if (db) await db.end(); });

const step = (role) => ({ name: role, approvers: [{ type: 'role', role }] });

test('with no flows saved, the built-in default is used', { skip }, async () => {
  const f = await getActiveFlow(db, 'voucher', coA);
  assert.equal(f.source, 'builtin');
  assert.deepEqual(f.steps, DEFAULT_STEPS.voucher);
});

test('a default flow applies to every company; a company flow overrides it', { skip }, async () => {
  await saveVersion(db, { workflow: 'voucher', companyId: null, steps: [step('director')], createdBy: 't@x.vn' });
  assert.equal((await getActiveFlow(db, 'voucher', coB)).source, 'default');
  await saveVersion(db, { workflow: 'voucher', companyId: coA, steps: [step('chief_accountant')], createdBy: 't@x.vn' });
  const a = await getActiveFlow(db, 'voucher', coA);
  assert.equal(a.source, 'company');
  assert.equal(a.steps[0].approvers[0].role, 'chief_accountant');
  assert.equal((await getActiveFlow(db, 'voucher', coB)).steps[0].approvers[0].role, 'director');
});

test('versions increment per company; a future version waits for its date', { skip }, async () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const v = await saveVersion(db, { workflow: 'voucher', companyId: coA, steps: [step('treasurer')], effectiveFrom: future, createdBy: 't@x.vn' });
  assert.equal(v.version, 2);
  assert.equal((await getActiveFlow(db, 'voucher', coA)).version, 1);
  assert.equal((await getActiveFlow(db, 'voucher', coA, new Date(Date.now() + 2 * 86400000))).version, 2);
  const versions = await listVersions(db, 'voucher', coA);
  assert.deepEqual(versions.map((x) => x.version), [2, 1]);
});

test('invalid steps are refused', { skip }, async () => {
  await assert.rejects(saveVersion(db, { workflow: 'voucher', companyId: coA, steps: [], createdBy: 't@x.vn' }), /ít nhất một bước/);
});

test('loadCompanyContext returns the company and employees by email', { skip }, async () => {
  const { company, employeesByEmail } = await loadCompanyContext(db, coA);
  assert.equal(company.company_key, 'TA');
  assert.equal(employeesByEmail.get('dir@x.vn').full_name, 'Dir Ector');
});
