// tests/purchase-requests/repo.test.js — needs TEST_DATABASE_URL (schema + migrations 001-007 + master data)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  insertPR, getPR, lockPR, updatePR, recordChange, auditFor, visibility, canView, approverCandidates,
} from '../../api/lib/purchase-requests/repo.js';

const url = process.env.TEST_DATABASE_URL;
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
