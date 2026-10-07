import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord, currentRecord, sheetTimeText, sheetTime } from '../../api/lib/sheets/voucher-records.js';
import { rowForHeader } from '../../api/lib/sheets/rows.js';

// Live sheet headers, exported 2026-10-06
const HISTORY_HEADER = ['voucher_number', 'voucher_type', 'company_name', 'company_key', 'employee_name', 'submitted_email',
  'submitted_by', 'submitted_at', 'amount', 'status', 'due_date', 'action', 'attachments', 'description', 'note',
  'approver_email', 'approved_at', 'metadata_json', 'acknowledged_at', 'acknowledged_by', 'signature_url', 'rejection_reason'];
const CURRENT_HEADER = ['voucherNumber', 'voucherType', 'company', 'companyKey', 'employee', 'requestorEmail', 'submittedBy',
  'amount', 'status', 'action', 'submittedAt', 'dueDate', 'approvalProgress', 'lastUpdated'];

const sample = () => ({
  voucherNumber: 'MI-PC1', voucherType: 'Phiếu Chi', company: 'CÔNG TY MI', companyKey: 'M.I', employee: 'An',
  requestorEmail: 'an@x.vn', submittedBy: 'An', amount: '2.500.000', description: 'E2E', dueDate: '2026-12-31',
  status: 'Đang duyệt (1/3)', action: 'Duyệt bởi Kế toán trưởng', attachments: 'a.pdf (0.18 MB)\nhttps://u',
  note: 'Đã duyệt bởi KTT (1/3)', approverEmail: 'kt@x.vn', approvedAt: '2026-10-07T02:00:00.000Z', meta: { a: 1 },
  acknowledgedAt: '2026-10-08T05:06:07.000Z', acknowledgedBy: 'an@x.vn', signatureUrl: 'https://sig', rejectionReason: 'r',
});
const sorted = (a) => [...a].sort();

test('sheetTimeText is the inverse of the importer', () => {
  const d = new Date('2026-10-07T03:21:09Z');
  assert.equal(sheetTimeText(d), '2026-10-07 03:21:09');
  assert.equal(sheetTimeText(d.toISOString()), '2026-10-07 03:21:09');
  assert.equal(sheetTime(sheetTimeText(d)), d.toISOString());
  assert.equal(sheetTime('8/28/2026 3:48:37'), '2026-08-28T03:48:37.000Z', 'sheet date cells are GMT');
  assert.equal(sheetTimeText(null), '');
});

test('historyRecord: exactly the 22 live Voucher_History columns', () => {
  const r = historyRecord(sample(), '2026-10-07T02:00:00.000Z');
  assert.deepEqual(sorted(Object.keys(r)), sorted(HISTORY_HEADER));
  assert.equal(r.voucher_number, 'MI-PC1');
  assert.equal(r.company_name, 'CÔNG TY MI');
  assert.equal(r.company_key, 'M.I');
  assert.equal(r.submitted_email, 'an@x.vn');
  assert.equal(r.submitted_at, '2026-10-07 02:00:00', 'event time');
  assert.equal(r.amount, 2500000);
  assert.equal(r.approved_at, '2026-10-07 02:00:00');
  assert.equal(r.acknowledged_at, '2026-10-08 05:06:07');
  assert.equal(r.attachments, 'a.pdf (0.18 MB)\nhttps://u');
  assert.equal(r.metadata_json, '{"a":1}');
  assert.equal(r.rejection_reason, 'r');
});

test('historyRecord: event time falls back to approvedAt, empty times stay empty', () => {
  const r = historyRecord({ ...sample(), acknowledgedAt: null });
  assert.equal(r.submitted_at, '2026-10-07 02:00:00');
  assert.equal(r.acknowledged_at, '');
});

test('historyRecord: data: signatures kept when they fit, replaced when metadata is too large', () => {
  const small = historyRecord({ ...sample(), meta: { sig: 'data:image/png;base64,AAAA' } });
  assert.equal(small.metadata_json, '{"sig":"data:image/png;base64,AAAA"}');
  const big = 'data:image/png;base64,' + 'A'.repeat(30000);
  const r = historyRecord({ ...sample(), meta: { sig: big, approvalPlan: { steps: [{ approvers: [{ signature: big }] }] }, reason: 'x' } });
  assert.ok(r.metadata_json.length < 45000);
  assert.deepEqual(JSON.parse(r.metadata_json),
    { sig: '[đã lưu trong hệ thống]', approvalPlan: { steps: [{ approvers: [{ signature: '[đã lưu trong hệ thống]' }] }] }, reason: 'x' });
});

test('currentRecord: exactly the 14 live Voucher_Current columns', () => {
  const r = currentRecord({ ...sample(), submittedBy: '' },
    { submittedAt: new Date('2026-10-01T01:00:00Z'), progressDone: 1, at: '2026-10-07T02:00:00.000Z' });
  assert.deepEqual(sorted(Object.keys(r)), sorted(CURRENT_HEADER));
  assert.equal(r.voucherNumber, 'MI-PC1');
  assert.equal(r.approvalProgress, 1);
  assert.equal(r.submittedAt, '2026-10-01 01:00:00', 'original submission time');
  assert.equal(r.lastUpdated, '2026-10-07 02:00:00', 'event time');
  assert.equal(r.submittedBy, 'An', 'falls back to employee');
  assert.equal(r.amount, 2500000);
  assert.equal(r.status, 'Đang duyệt (1/3)');
  assert.equal(r.dueDate, '2026-12-31');
});

test('rowForHeader lines up with the live headers (no provided field lost)', () => {
  const h = rowForHeader(HISTORY_HEADER, historyRecord(sample(), '2026-10-07T02:00:00.000Z'));
  assert.deepEqual(HISTORY_HEADER.filter((_, i) => h[i] === ''), []);
  const c = rowForHeader(CURRENT_HEADER, currentRecord(sample(), { submittedAt: '2026-10-01T01:00:00Z', progressDone: 0, at: '2026-10-07T02:00:00Z' }));
  assert.deepEqual(CURRENT_HEADER.filter((_, i) => c[i] === ''), []);
  assert.equal(c[CURRENT_HEADER.indexOf('approvalProgress')], 0);
});

test('historyRecord: huge data: signature_url is replaced, short one and URLs kept', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(45000);
  assert.equal(historyRecord({ ...sample(), signatureUrl: big }).signature_url, '[đã lưu trong hệ thống]');
  assert.equal(historyRecord({ ...sample(), signatureUrl: 'data:image/png;base64,AAAA' }).signature_url, 'data:image/png;base64,AAAA');
  assert.equal(historyRecord({ ...sample(), signatureUrl: 'https://' + 'x'.repeat(46000) }).signature_url.length, 46008, 'only data: values are replaced');
});

test('historyRecord: metadata still too large after stripping → valid JSON with top-level scalars only', () => {
  const items = Array.from({ length: 2000 }, (_, i) => ({ name: 'Văn phòng phẩm ' + i, amount: i * 1000 }));
  const r = historyRecord({ ...sample(), meta: { reason: 'Mua VPP', voucherDate: '2026-10-07', count: 3, ok: true, none: null,
    expenseItems: items, approvalPlan: { steps: [] }, sig: 'data:image/png;base64,' + 'A'.repeat(50000) } });
  assert.ok(r.metadata_json.length <= 45000);
  assert.deepEqual(JSON.parse(r.metadata_json),
    { truncated: true, reason: 'Mua VPP', voucherDate: '2026-10-07', count: 3, ok: true, none: null, sig: '[đã lưu trong hệ thống]' });
});

test('currentRecord: a rejected voucher shows approvalProgress 0 (GAS progNum_)', () => {
  const r = currentRecord({ ...sample(), status: 'Đã từ chối' }, { submittedAt: '2026-10-01T01:00:00Z', progressDone: 2, at: '2026-10-07T02:00:00Z' });
  assert.equal(r.approvalProgress, 0);
});
