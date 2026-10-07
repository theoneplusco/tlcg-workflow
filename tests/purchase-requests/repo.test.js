// tests/purchase-requests/repo.test.js — needs TEST_DATABASE_URL (schema + migrations 001-007 + master data)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  insertPR, getPR, lockPR, updatePR, recordChange, auditFor, visibility, canView, approverCandidates,
} from '../../api/lib/purchase-requests/repo.js';

const url = process.env.TEST_DATABASE_URL;
const restoreEnv = (v) => { if (v === undefined) delete process.env.P2P_SPREADSHEET_ID; else process.env.P2P_SPREADSHEET_ID = v; };
const skip = !url && 'set TEST_DATABASE_URL to run';
const db = url ? new pg.Pool({ connectionString: url }) : null;
before(async () => { if (db) await db.query('TRUNCATE purchase_requests, pr_audit_log, sheet_outbox'); });
after(async () => { if (db) await db.end(); });

const rec = (no, over = {}) => ({
  pr_no: no, company_name: 'CÔNG TY TEST', requester_email: 'req@x.vn', status: 'Đang duyệt ngân sách & NCC (2/5)',
  items: [{ desc: 'A', total: '1000' }], attachments: [], metadata: { budgetStatus: 'Pending' },
  approver_emails: ['linh@x.vn'], pending_emails: ['linh@x.vn'], submitted_at: '2026-10-07T01:00:00.000Z', ...over,
});

test('insertPR / getPR: JSON and array columns round-trip', { skip }, async () => {
  await insertPR(db, rec('ZZ-PR20261007000001'));
  const r = await getPR(db, 'ZZ-PR20261007000001');
  assert.deepEqual(r.items, [{ desc: 'A', total: '1000' }]);
  assert.deepEqual(r.metadata, { budgetStatus: 'Pending' });
  assert.deepEqual(r.pending_emails, ['linh@x.vn']);
  assert.equal(await getPR(db, 'nope'), null);
});

test('updatePR: changes the given fields and bumps updated_at', { skip }, async () => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const row = await lockPR(c, 'ZZ-PR20261007000001');
    const saved = await updatePR(c, row.id, { status: 'Mua hàng (5/5)', pending_emails: ['ap@x.vn'] });
    await c.query('COMMIT');
    assert.equal(saved.status, 'Mua hàng (5/5)');
    assert.deepEqual(saved.pending_emails, ['ap@x.vn']);
    assert.ok(saved.updated_at >= row.updated_at);
    assert.equal(saved.requester_email, 'req@x.vn', 'untouched columns kept');
  } finally { c.release(); }
});

test('recordChange writes audit rows; auditFor returns them oldest first', { skip }, async () => {
  const row = await getPR(db, 'ZZ-PR20261007000001');
  await recordChange(db, row, [
    { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z', extra: { signatureUploaded: true } },
    { action: 'Approve', role: 'supplier', actorEmail: 'linh@x.vn', prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z' },
  ]);
  await recordChange(db, row, { action: 'Submit', role: 'requester', actorEmail: 'req@x.vn', at: '2026-10-07T01:00:00.000Z' });
  const a = await auditFor(db, 'ZZ-PR20261007000001');
  assert.deepEqual(a.map((x) => `${x.action}/${x.role}`), ['Submit/requester', 'Approve/budget', 'Approve/supplier']);
  assert.equal(a[0].company, 'CÔNG TY TEST');
  assert.deepEqual(a[1].extra, { signatureUploaded: true });
  assert.equal(a[1].source, 'app');
});

test('visibility: admin all, requester own, approver named, stranger nothing', { skip }, async () => {
  await insertPR(db, rec('ZZ-PR20261007000002', { requester_email: 'other@x.vn', approver_emails: ['boss@x.vn'] }));
  const seen = async (caller) => {
    const v = visibility(caller, 1);
    const { rows } = await db.query(`SELECT pr_no FROM purchase_requests WHERE pr_no LIKE 'ZZ-%' AND ${v.sql} ORDER BY pr_no`, v.params);
    return rows.map((r) => r.pr_no.slice(-1));
  };
  assert.deepEqual(await seen({ email: 'admin@x.vn', isAdmin: true }), ['1', '2']);
  assert.deepEqual(await seen({ email: 'req@x.vn', isAdmin: false }), ['1']);
  assert.deepEqual(await seen({ email: 'boss@x.vn', isAdmin: false }), ['2']);
  assert.deepEqual(await seen({ email: 'nobody@x.vn', isAdmin: false }), []);
  assert.equal(canView({ email: 'boss@x.vn' }, { requester_email: 'Other@x.vn', approver_emails: ['boss@x.vn'] }), true);
  assert.equal(canView({ email: 'x@x.vn' }, { requester_email: 'Other@x.vn', approver_emails: [] }), false);
});

test('approverCandidates: Master Company roles + Kế Toán Chi staff', { skip }, async () => {
  const company = (await db.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  const c = await approverCandidates(db, company);
  assert.ok(c.companyEmails.has(company.treasurer_email.toLowerCase()));
  assert.ok(c.companyEmails.has(company.accountant_email.toLowerCase()));
  assert.ok(c.purchasingEmails.has('tlc.ap@tl-c.com.vn'));
  assert.equal(c.purchasingEmails.has(company.treasurer_email.toLowerCase()), false);
});

test('emails are normalised on write; visibility and canView find mixed-case data', { skip }, async () => {
  await insertPR(db, rec('ZZ-PR20261007000003', { requester_email: ' Mixed@X.vn ', approver_emails: [' Boss3@X.vn '], pending_emails: ['Boss3@X.vn'] }));
  const r = await getPR(db, 'ZZ-PR20261007000003');
  assert.equal(r.requester_email, 'mixed@x.vn');
  assert.deepEqual(r.approver_emails, ['boss3@x.vn']);
  const saved = await updatePR(db, r.id, { pending_emails: ['AP3@x.vn '] });
  assert.deepEqual(saved.pending_emails, ['ap3@x.vn']);
  for (const email of ['BOSS3@x.vn', 'Mixed@x.vn']) {
    const v = visibility({ email }, 1);
    const { rows } = await db.query(`SELECT pr_no FROM purchase_requests WHERE pr_no = 'ZZ-PR20261007000003' AND ${v.sql}`, v.params);
    assert.equal(rows.length, 1);
    assert.equal(canView({ email }, r), true);
  }
});

test('empty caller email sees nothing; updatePR on unknown id returns null', { skip }, async () => {
  const v = visibility({ email: '', isAdmin: true }, 1);
  const { rows } = await db.query(`SELECT 1 FROM purchase_requests WHERE ${v.sql}`, v.params);
  assert.equal(rows.length, 0);
  assert.equal(canView({ email: '', isAdmin: true }, { requester_email: '', approver_emails: [] }), false);
  assert.equal(await updatePR(db, 999999999, { status: 'x' }), null);
});

test('migration backfill: legacy row with only the four approver columns becomes visible', { skip }, async () => {
  await db.query(`INSERT INTO purchase_requests (pr_no, requester_email, budget_approver_email, purchasing_approver_email)
                  VALUES ('ZZ-PR20261007000004', 'r@x.vn', ' Legacy@X.vn', 'AP@x.vn')`);
  const sql = (await import('node:fs')).readFileSync(new URL('../../db/migrations/007_purchase_requests.sql', import.meta.url), 'utf8');
  await db.query(sql);
  const r = await getPR(db, 'ZZ-PR20261007000004');
  assert.deepEqual([...r.approver_emails].sort(), ['ap@x.vn', 'legacy@x.vn']);
  assert.equal(canView({ email: 'LEGACY@x.vn' }, r), true);
});

test('recordChange in one transaction: PR update and audit row commit or roll back together', { skip }, async () => {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const row = await lockPR(c, 'ZZ-PR20261007000001');
    const after = await updatePR(c, row.id, { status: 'Hoàn thành' });
    await recordChange(c, after, { action: 'Complete', role: 'purchasing', actorEmail: 'AP@x.vn', newStatus: 'Hoàn thành' });
    await c.query('ROLLBACK');
  } finally { c.release(); }
  assert.notEqual((await getPR(db, 'ZZ-PR20261007000001')).status, 'Hoàn thành');
  assert.equal((await auditFor(db, 'ZZ-PR20261007000001')).some((a) => a.action === 'Complete'), false);
  const c2 = await db.connect();
  try {
    await c2.query('BEGIN');
    const row = await lockPR(c2, 'ZZ-PR20261007000001');
    const after = await updatePR(c2, row.id, { status: 'Hoàn thành' });
    await recordChange(c2, after, { action: 'Complete', role: 'purchasing', actorEmail: 'AP@x.vn', newStatus: after.status });
    await c2.query('COMMIT');
  } finally { c2.release(); }
  assert.equal((await getPR(db, 'ZZ-PR20261007000001')).status, 'Hoàn thành');
  const a = (await auditFor(db, 'ZZ-PR20261007000001')).find((x) => x.action === 'Complete');
  assert.equal(a.new_status, 'Hoàn thành');
  assert.equal(a.actor_email, 'ap@x.vn');
});
test('recordChange queues the Sheet copy (PR upsert + audit append) when P2P_SPREADSHEET_ID is set', { skip }, async () => {
  await db.query('TRUNCATE sheet_outbox');
  const row = await getPR(db, 'ZZ-PR20261007000001');
  const saved = process.env.P2P_SPREADSHEET_ID;
  try {
    delete process.env.P2P_SPREADSHEET_ID;
    await recordChange(db, row, { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', at: '2026-10-07T04:00:00.000Z' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM sheet_outbox')).rows[0].n, 0, 'no target → nothing queued');
    process.env.P2P_SPREADSHEET_ID = 'p2p-test';
    await recordChange(db, row, { action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', at: '2026-10-07T04:00:00.000Z' });
  } finally { restoreEnv(saved); }
  const ob = (await db.query('SELECT tab, mode, key_column, record FROM sheet_outbox ORDER BY id')).rows;
  assert.deepEqual(ob.map((o) => [o.tab, o.mode, o.key_column]), [['Purchase_Request_History', 'upsert', 'pr_no,row_type'], ['PR_Audit_Log', 'append', null]]);
  assert.equal(ob[0].record.row_type, 'submit');
  assert.equal(ob[1].record.document_no, 'ZZ-PR20261007000001');
});
test('recordChange: the queued Sheet copy rolls back with the PR transaction', { skip }, async () => {
  await db.query('TRUNCATE sheet_outbox');
  const saved = process.env.P2P_SPREADSHEET_ID;
  process.env.P2P_SPREADSHEET_ID = 'p2p-test';
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const row = await lockPR(c, 'ZZ-PR20261007000001');
    const after = await updatePR(c, row.id, { status: 'Đã từ chối' });
    await recordChange(c, after, { action: 'Reject', role: 'budget', actorEmail: 'linh@x.vn' });
    assert.equal((await c.query('SELECT count(*)::int AS n FROM sheet_outbox')).rows[0].n, 2, 'queued inside the transaction');
    await c.query('ROLLBACK');
  } finally { c.release(); restoreEnv(saved); }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sheet_outbox')).rows[0].n, 0);
  assert.notEqual((await getPR(db, 'ZZ-PR20261007000001')).status, 'Đã từ chối');
});
