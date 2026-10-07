// tests/purchase-requests/importer.test.js — import is re-runnable and never overwrites Postgres changes
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, url, setup, teardown } from './helpers.js';

let imp, repo, pool, company, people;
before(async () => {
  if (!url) return;
  ({ pool, company, people } = await setup());
  imp = await import('../../api/lib/purchase-requests/importer.js');
  repo = await import('../../api/lib/purchase-requests/repo.js');
});
after(() => teardown(pool));

const meta = (o) => JSON.stringify({ requesterEmail: 'Thu@x.vn', p2pBranch: 'simplified', purchaseType: 'goods', budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Pending', ...o });
const sub = (no, o = {}) => ({ sheetRow: 2, pr_no: no, company_name: company.company_name, company_key: company.company_key, requester_name: 'Thư',
  required_date: '2026-10-20', status: 'Mua hàng (5/5)', submitted_at: '2026-10-01T01:00:00.000Z', items_json: '[{"desc":"K","total":"100"}]',
  grand_total: '100', budget_approver_email: people.treasurer, supplier_approver_email: people.treasurer, purchasing_approver_email: people.ap.toUpperCase(),
  row_type: 'submit', metadata_json: meta(), ...o });
const tabs = () => ({
  working: [sub('EV-PR20261001000001'), sub('EV-PR20261001000002', { metadata_json: meta({ p2pBranch: 'full' }) }),
    { sheetRow: 9, pr_no: 'EV-PR20261001000002', row_type: 'event', event_action: 'Submit', event_role: 'requester', event_timestamp: '2026-10-01T01:00:00.000Z' }],
  archive: [sub('EV-PR20260528000001', { status: 'Đã từ chối', metadata_json: '{}' }), sub('EV-PR20261001000001', { status: 'Đã từ chối' })],
  audit: [{ sheetRow: 2, document_no: 'EV-PR20261001000001', action: 'Submit', role: 'requester', timestamp: '2026-10-01T01:00:00.000Z', extra_json: '' }],
  poTypes: [{ sheetRow: 2, no: '1', type: 'Hàng hóa' }],
});
const count = async (sql, p = []) => (await pool.query(sql, p)).rows[0].n;

test('import: working wins, archive flagged, audit + event fallback, PO types; dry run writes nothing', { skip }, async () => {
  const dry = await imp.importPurchaseRequests(pool, { ...tabs(), dryRun: true });
  assert.equal(dry.prs, 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM purchase_requests'), 0);
  const s = await imp.importPurchaseRequests(pool, tabs());
  assert.deepEqual([s.prs, s.archived, s.audit, s.eventAudit, s.poTypes, s.skippedNative, s.noCompany], [3, 1, 1, 1, 1, 0, 0]);
  const w = (await pool.query(`SELECT * FROM purchase_requests WHERE pr_no = 'EV-PR20261001000001'`)).rows[0];
  assert.equal(w.status, 'Mua hàng (5/5)', 'working sheet wins');
  assert.equal(w.company_id, company.id);
  assert.ok(w.imported_at);
  assert.equal(w.requester_email, 'thu@x.vn');
  assert.deepEqual(w.pending_emails, [people.ap], 'lower-cased');
  assert.deepEqual(w.approver_emails, [people.treasurer, people.ap]);
  assert.equal(w.updated_at.toISOString(), '2026-10-01T01:00:00.000Z', 'updated_at = GAS last activity');
  const a = (await pool.query(`SELECT archived_at FROM purchase_requests WHERE pr_no = 'EV-PR20260528000001'`)).rows[0];
  assert.ok(a.archived_at);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pr_audit_log WHERE doc_no = 'EV-PR20261001000002' AND source = 'sheet-event'`), 1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM pr_audit_log WHERE doc_no = 'EV-PR20261001000001' AND source = 'sheet-event'`), 0,
    'event rows are only a fallback for numbers without PR_Audit_Log rows');
});

test('re-run: same rows, no duplicate audit rows', { skip }, async () => {
  const before = await count('SELECT count(*)::int AS n FROM pr_audit_log');
  const s = await imp.importPurchaseRequests(pool, tabs());
  assert.equal(s.prs, 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM pr_audit_log'), before);
  assert.equal(await count('SELECT count(*)::int AS n FROM purchase_requests'), 3);
});

test('import queues no Sheet copy, even with P2P_SPREADSHEET_ID set', { skip }, async () => {
  const old = process.env.P2P_SPREADSHEET_ID;
  process.env.P2P_SPREADSHEET_ID = 'sheet-copy-test';
  try {
    await pool.query('TRUNCATE sheet_outbox');
    await imp.importPurchaseRequests(pool, tabs());
    assert.equal(await count('SELECT count(*)::int AS n FROM sheet_outbox'), 0);
  } finally {
    if (old === undefined) delete process.env.P2P_SPREADSHEET_ID; else process.env.P2P_SPREADSHEET_ID = old;
  }
});

test('unknown company: imported without company_id and reported, never guessed', { skip }, async () => {
  const t = tabs();
  t.working.push(sub('EV-PR20261001000007', { company_name: 'CÔNG TY KHÔNG CÓ', company_key: 'NOPE.KEY' }));
  const s = await imp.importPurchaseRequests(pool, { ...t, dryRun: true });
  assert.equal(s.noCompany, 1);
  assert.deepEqual(s.unmatchedCompanies, [{ name: 'CÔNG TY KHÔNG CÓ', key: 'NOPE.KEY', prs: ['EV-PR20261001000007'] }]);
});

test('rows changed or created in Postgres are never overwritten', { skip }, async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const row = await repo.lockPR(c, 'EV-PR20261001000001');
    await repo.updatePR(c, row.id, { status: 'Hoàn thành' });
    await c.query('COMMIT');
  } finally { c.release(); }
  await repo.insertPR(pool, { pr_no: 'EV-PR20261001000009', status: 'Đang duyệt ngân sách & NCC (2/5)', company_name: 'native' });
  await repo.appendAudit(pool, { docNo: 'EV-PR20261001000001', action: 'Approve', role: 'purchasing' }); // source 'app'
  const t = tabs();
  t.working.push(sub('EV-PR20261001000009'));
  const s = await imp.importPurchaseRequests(pool, t);
  assert.equal(s.skippedNative, 2);
  assert.equal((await repo.getPR(pool, 'EV-PR20261001000001')).status, 'Hoàn thành');
  assert.equal((await repo.getPR(pool, 'EV-PR20261001000009')).company_name, 'native');
  assert.equal(await count(`SELECT count(*)::int AS n FROM pr_audit_log WHERE source = 'app'`), 1, 'app audit rows untouched');
});

test('--notify-purchasing: one email per stuck simplified PR, never twice', { skip }, async () => {
  await pool.query(`TRUNCATE purchase_requests, email_queue`);
  const s1 = await imp.importPurchaseRequests(pool, { ...tabs(), notifyPurchasing: true });
  assert.equal(s1.notified, 1, 'EV-…0001 is simplified at Mua hàng; …0002 is full (GAS emailed it)');
  const s2 = await imp.importPurchaseRequests(pool, { ...tabs(), notifyPurchasing: true });
  assert.equal(s2.notified, 0);
  const m = (await pool.query(`SELECT to_email, subject FROM email_queue`)).rows;
  assert.deepEqual(m.map((x) => x.to_email), [people.ap]);
  assert.equal(m[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261001000001');
  assert.ok((await repo.getPR(pool, 'EV-PR20261001000001')).metadata.importNotifiedAt);
});
