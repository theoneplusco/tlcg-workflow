import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, recordsFromGrid } from '../../api/lib/sheets/grid.js';
import { normalizeRequiredDate, lastActivity, isSubmitRow, prFromSheetRow, auditFromSheetRow, auditFromEventRow } from '../../api/lib/purchase-requests/importer.js';

test('parseCsv: quoted commas, quotes and newlines', () => {
  assert.deepEqual(parseCsv('a,b\n"x, ""y""","line1\nline2"\n'), [['a', 'b'], ['x, "y"', 'line1\nline2']]);
});
test('recordsFromGrid: lower-case keys; a repeated header keeps its first column; empty rows dropped', () => {
  const grid = [['pr_no', 'row_type', 'event_action', 'row_type', 'Row_Type'], ['EV-1', 'event', 'Submit', '', ''], ['', '', '', '', '']];
  assert.deepEqual(recordsFromGrid(grid), [{ sheetRow: 2, pr_no: 'EV-1', row_type: 'event', event_action: 'Submit' }]);
});
test('normalizeRequiredDate / isSubmitRow', () => {
  assert.equal(normalizeRequiredDate('5/28/2026'), '2026-05-28');
  assert.equal(normalizeRequiredDate('2026-10-20'), '2026-10-20');
  assert.equal(isSubmitRow({ row_type: 'submit' }), true);
  assert.equal(isSubmitRow({ row_type: '' }), true);
  assert.equal(isSubmitRow({ row_type: 'event' }), false);
});
test('lastActivity: latest of submit, approvals, rejection, resubmit, send backs (GAS prLastActivity_)', () => {
  assert.equal(lastActivity('2026-08-05T08:34:20.857Z', { budgetApprovedAt: '2026-08-06T01:00:00.000Z', sentBackHistory: [{ at: '2026-08-07T01:00:00.000Z' }] }), '2026-08-07T01:00:00.000Z');
  assert.equal(lastActivity('', {}), null);
});
test('prFromSheetRow: live row and legacy archive row', () => {
  const live = prFromSheetRow({ sheetRow: 5, pr_no: 'EV-PR20260805000003', company_name: 'CT', company_key: 'E.V', department: 'BH',
    requester_name: 'Thư', required_date: '2026-08-10', priority: 'Bình Thường', purpose: 'Kem', suggested_vendor: '', budget_code: '',
    budget_approver_email: 'Linh@x.vn', supplier_approver_email: 'linh@x.vn', items_json: '[{"desc":"Kem","total":"2000000"}]',
    grand_total: '2000000', status: 'Mua hàng (5/5)', submitted_at: '2026-08-05T08:34:20.857Z', contract_approver_email: 'kt@x.vn',
    purchasing_approver_email: 'Tlc.ap@x.vn', attachment_urls: 'https://drive.google.com/file/d/1/view', row_type: 'submit',
    metadata_json: JSON.stringify({ requesterEmail: 'Thu@x.vn', p2pBranch: 'full', purchaseType: 'goods', budgetStatus: 'Approved',
      supplierStatus: 'Approved', purchasingStatus: 'Pending', budgetApprovedAt: '2026-08-06T00:00:00.000Z' }) });
  assert.equal(live.requester_email, 'thu@x.vn');
  assert.equal(live.submitted_at, '2026-08-05T08:34:20.857Z');
  assert.equal(live.updated_at, '2026-08-06T00:00:00.000Z');
  assert.equal(live.archived_at, null);
  assert.deepEqual(live.pending_emails, ['tlc.ap@x.vn']);
  assert.deepEqual(live.approver_emails, ['linh@x.vn', 'kt@x.vn', 'tlc.ap@x.vn'], 'everyone named, lower-cased, once');
  assert.equal(live.purchasing_approver_email, 'tlc.ap@x.vn');
  assert.deepEqual(live.attachments, [{ fileName: 'view', fileUrl: 'https://drive.google.com/file/d/1/view' }]);
  assert.equal(live.grand_total, 2000000);
  const old = prFromSheetRow({ sheetRow: 2, pr_no: 'EV-PR20260528000001', company_name: 'CT', required_date: '5/28/2026', status: 'Đã từ chối',
    submitted_at: '2026-05-28T02:00:00.000Z', items_json: '[]', grand_total: '100', metadata_json: '{"rejectedAt":"2026-05-29T00:00:00.000Z"}', row_type: 'submit' }, { archived: true });
  assert.equal(old.p2p_branch, 'full', 'GAS readers default legacy rows to full');
  assert.equal(old.required_date, '2026-05-28');
  assert.equal(old.archived_at, '2026-05-29T00:00:00.000Z');
  assert.deepEqual(old.pending_emails, []);
});
test('prFromSheetRow: metadata.attachments win over attachment_urls; previousPrNo kept', () => {
  const pr = prFromSheetRow({ sheetRow: 3, pr_no: 'EV-PR20260924000005', status: 'Đang duyệt ngân sách & NCC (2/5)', submitted_at: '2026-09-24T01:00:00.000Z',
    budget_approver_email: 'Linh@x.vn', supplier_approver_email: 'Linh@x.vn', attachment_urls: 'https://a/1',
    metadata_json: JSON.stringify({ previousPrNo: 'EV-PR20260924000004', budgetStatus: 'Pending', supplierStatus: 'Pending',
      attachments: [{ fileName: 'a.pdf', fileUrl: 'https://a/1' }, { fileName: 'b.pdf', fileUrl: '', error: 'x' }] }) });
  assert.equal(pr.metadata.previousPrNo, 'EV-PR20260924000004');
  assert.deepEqual(pr.attachments, [{ fileName: 'a.pdf', fileUrl: 'https://a/1' }, { fileName: 'b.pdf', fileUrl: '', error: 'x' }]);
  assert.deepEqual(pr.pending_emails, ['linh@x.vn'], 'same person on budget + supplier: once');
});
test('audit rows: PR_Audit_Log and legacy event rows', () => {
  const a = auditFromSheetRow({ sheetRow: 3, document_no: 'EV-1', flow: 'PR', company_name: 'CT', action: 'Approve', role: 'supplier',
    actor_email: 'Anh@x.vn', actor_name: '', prev_status: 'p', new_status: 'n', timestamp: '2026-06-30T09:15:55.135Z', note: '',
    extra_json: '{"signatureUploaded":true}' });
  assert.deepEqual([a.docNo, a.actorEmail, a.at, a.extra.signatureUploaded, a.source, a.sheetRow], ['EV-1', 'anh@x.vn', '2026-06-30T09:15:55.135Z', true, 'sheet', 3]);
  const e = auditFromEventRow({ sheetRow: 9, pr_no: 'EV-2', row_type: 'event', event_action: 'Submit', event_role: 'requester',
    event_actor_email: 'a@x.vn', event_actor_name: 'A', event_prev_status: '', event_new_status: 'n', event_timestamp: '2026-10-05T10:50:11.901Z',
    event_note: 'Kem', event_metadata_json: '' });
  assert.deepEqual([e.docNo, e.action, e.at, e.source, e.extra.fromEventRow], ['EV-2', 'Submit', '2026-10-05T10:50:11.901Z', 'sheet-event', true]);
});

test('prFromSheetRow: an unreadable grand_total is stored as 0 and flagged', () => {
  const pr = prFromSheetRow({ sheetRow: 4, pr_no: 'EV-X', status: 'Hoàn thành', grand_total: 'abc', metadata_json: '{}' });
  assert.equal(pr.grand_total, 0);
  assert.equal(pr.badTotal, true);
  assert.equal(prFromSheetRow({ sheetRow: 4, pr_no: 'EV-Y', grand_total: '1.500.000' }).badTotal, false);
});

for (const script of ['import-purchase-requests.js', 'import-vouchers.js']) {
  test(`${script}: refuses to run without DATABASE_URL (no default database)`, async () => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const path = await import('node:path');
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const r = spawnSync(process.execPath, [path.resolve('scripts', script), '--dir', os.tmpdir(), '--dry-run'],
      { cwd: os.tmpdir(), env, encoding: 'utf-8', timeout: 20000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DATABASE_URL/);
  });
}
