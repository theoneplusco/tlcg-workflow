// tests/purchase-requests/views.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardFromRow, fullFromRow, historyEntry, goodsRecord, supplierExtra, likePattern } from '../../api/lib/purchase-requests/views.js';
import { MASTER_TABLES } from '../../api/lib/master-registry.js';

const row = {
  pr_no: 'EV-PR20261007000001', company_name: 'CT', department: 'Bán Hàng', requester_name: 'Thư', requester_email: 'req@x.vn',
  required_date: '2026-10-20', priority: 'Gấp', purpose: 'Mua', vendor_name: 'NCC A', grand_total: '149500', status: 'Hoàn thành',
  submitted_at: new Date('2026-10-07T01:00:00Z'), budget_approver_email: 'linh@x.vn', supplier_approver_email: 'linh@x.vn',
  contract_approver_email: '', purchasing_approver_email: 'ap@x.vn', p2p_branch: 'simplified', purchase_type: 'goods',
  items: [{ desc: 'Khăn', qty: '5' }], attachments: [{ fileName: 'a.pdf', fileUrl: 'https://r2/a.pdf' }, { fileName: 'b', fileUrl: '' }],
  metadata: { budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Approved', contractStatus: 'N/A' }, budget_code: '',
};
const KEYS = ['prNo', 'company', 'department', 'requesterName', 'requesterEmail', 'requestorEmail', 'requiredDate', 'priority', 'purpose',
  'suggestedVendor', 'grandTotal', 'status', 'submittedAt', 'budgetApprover', 'supplierApprover', 'contractApprover', 'purchasingApprover',
  'budgetApproverEmail', 'supplierApproverEmail', 'contractApproverEmail', 'purchasingApproverEmail', 'budgetStatus', 'supplierStatus',
  'contractStatus', 'purchasingStatus', 'activeStage', 'purchaseType', 'p2pBranch', 'hasAttachments', 'items', 'source'];

test('cardFromRow: GAS card keys + items string (B7); terminal rows keep statuses and branch (B5)', () => {
  const c = cardFromRow(row);
  assert.deepEqual(Object.keys(c), KEYS);
  assert.equal(c.submittedAt, '2026-10-07T01:00:00.000Z');
  assert.equal(c.grandTotal, 149500);
  assert.equal(c.activeStage, 'complete');
  assert.equal(c.p2pBranch, 'simplified');
  assert.equal(c.budgetStatus, 'Approved');
  assert.equal(c.requesterEmail, 'req@x.vn');
  assert.equal(c.items, '[{"desc":"Khăn","qty":"5"}]');
  assert.equal(c.hasAttachments, true);
  assert.equal(c.source, 'pg', 'the page tells Postgres cards from GAS ones without the detail fetch');
  assert.equal(cardFromRow({ ...row, status: 'Trả lại bổ sung', metadata: { budgetStatus: 'Pending', supplierStatus: 'Pending' } }).activeStage, 'parallel');
  assert.equal(cardFromRow({ ...row, status: 'Rejected' }).activeStage, 'rejected');
});
test('fullFromRow: metadata as a string, attachmentUrls, budgetCode', () => {
  const f = fullFromRow(row);
  assert.equal(typeof f.metadata, 'string');
  assert.equal(JSON.parse(f.metadata).budgetStatus, 'Approved');
  assert.equal(f.attachmentUrls, 'https://r2/a.pdf');
  assert.equal(f.budgetCode, '');
});
test('historyEntry: drawer shape', () => {
  const e = historyEntry({ action: 'Return', role: 'purchasing', actor_email: 'ap@x.vn', actor_name: 'AP', prev_status: 'a', new_status: 'b',
    created_at: new Date('2026-10-07T02:00:00Z'), note: 'x', extra: { targetStep: 2 } });
  assert.deepEqual(e, { action: 'Return', role: 'purchasing', actorEmail: 'ap@x.vn', actorName: 'AP', prevStatus: 'a', newStatus: 'b',
    timestamp: '2026-10-07T02:00:00.000Z', note: 'x', metaJson: '{"targetStep":2}' });
  assert.equal(historyEntry({ action: 'Submit', created_at: new Date(), extra: {} }).metaJson, '');
});
test('goodsRecord / supplierExtra / likePattern', () => {
  const core = MASTER_TABLES.goods.core;
  const g = goodsRecord(['Category', 'Items', 'Unit Price', 'Status', 'Extra'], { category: 'Giấy', name: 'Khăn', unit_price: 29900, status: 'active', extra: { Status: 'Active', Extra: 'x' } }, core);
  assert.deepEqual(g, { Category: 'Giấy', Items: 'Khăn', 'Unit Price': '29900', Status: 'Active', Extra: 'x' });
  const known = new Set(['Vendor_Full_Name', 'Vendor Type', 'Tax ID', 'Address', 'Active']);
  assert.deepEqual(supplierExtra({ name: ' NCC B ', taxCode: '0312', address: 'HCM', phone: '09' }, known),
    { Vendor_Full_Name: 'NCC B', 'Vendor Type': 'Others', 'Tax ID': '0312', Address: 'HCM', Active: 'Yes' });
  assert.equal(supplierExtra({ name: 'A', companyType: ' individual ' }, known)['Vendor Type'], 'Individual');
  assert.equal(supplierExtra({ name: 'A', companyType: 'Công ty lạ' }, known)['Vendor Type'], 'Others');
  assert.equal(likePattern('50%_a\\'), '%50\\%\\_a\\\\%');
});
