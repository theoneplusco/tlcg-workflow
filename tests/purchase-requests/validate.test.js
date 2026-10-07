// tests/purchase-requests/validate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePriority, itemsTotal, checkSubmission, buildMetadata } from '../../api/lib/purchase-requests/validate.js';
import { decodeFile, storeAttachments, parseAttachmentList } from '../../api/lib/purchase-requests/attachments.js';

const items = (total = '149500') => JSON.stringify([{ section: 'hang-hoa', desc: 'Khăn', qty: '5', price: '029900', total }]);
const body = (over = {}) => ({ companyName: 'CT', requesterName: 'Thư', requiredDate: '2026-10-20', budgetApprover: 'Linh@x.vn',
  supplierApprover: 'linh@x.vn', items: items(), purchaseType: 'goods', purchasingApprover: 'Tlc.ap@x.vn', ...over });

test('checkSubmission: GAS checks 1–8 in order, same wording', () => {
  const e = (over) => checkSubmission(body(over)).error;
  assert.equal(e({ companyName: '' }), 'Thiếu tên công ty.');
  assert.equal(e({ requesterName: ' ' }), 'Thiếu tên người đề nghị.');
  assert.equal(e({ requiredDate: '' }), 'Thiếu ngày cần hàng.');
  assert.equal(e({ budgetApprover: '' }), 'Vui lòng chọn người phê duyệt ngân sách.');
  assert.equal(e({ supplierApprover: '' }), 'Vui lòng chọn người phê duyệt NCC.');
  assert.match(e({ items: '[{' }), /^Dữ liệu hàng hóa không hợp lệ: /);
  assert.equal(e({ items: '[]' }), 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.');
  assert.equal(e({ purchaseType: 'services' }), 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
});
test('checkSubmission: total and branch from the items, never the client (S4); picks lower-cased', () => {
  const s = checkSubmission(body({ grandTotal: 1, items: items('2500000'), contractApprover: 'KT@x.vn' }));
  assert.equal(s.grandTotal, 2500000);
  assert.equal(s.branch, 'full');
  assert.deepEqual(s.picks, { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' });
  assert.equal(checkSubmission(body({ contractApprover: 'kt@x.vn' })).picks.contract, '', 'simplified stores no contract reviewer');
});
test('itemsTotal: totals, else qty × price; leading zeros and dotted thousands', () => {
  assert.equal(itemsTotal([{ total: '149500' }, { qty: '2', price: '02000000' }, { total: '1.500.000' }]), 149500 + 4000000 + 1500000);
});
test('normalizePriority: GAS mapping, unknown kept, empty → Bình Thường', () => {
  assert.deepEqual(['gap', 'binh_thuong', 'khong_gap', 'high', '', 'Khác'].map(normalizePriority),
    ['Gấp', 'Bình Thường', 'Không Gấp', 'Gấp', 'Bình Thường', 'Khác']);
});
test('buildMetadata: GAS keys and statuses', () => {
  const s = checkSubmission(body());
  const m = buildMetadata(body({ companyCode: 'CT (E.V)', vendorTaxId: '0312' }), { companyKey: 'E.V', requesterEmail: 'req@x.vn', submittedAt: 'T', attachments: [], purchaseType: s.purchaseType, branch: s.branch, picks: s.picks });
  assert.equal(m.budgetStatus, 'Pending');
  assert.equal(m.contractStatus, 'N/A');
  assert.equal(m.purchasingStatus, 'Pending');
  assert.equal(m.p2pBranch, 'simplified');
  assert.equal(m.companyCode, 'CT (E.V)');
  assert.equal(m.vendorDetails.vendorTaxId, '0312');
  assert.equal(m.submittedAt, 'T');
});
test('decodeFile: data URL or bare base64', () => {
  const a = decodeFile({ fileName: 'a.pdf', fileData: 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64') });
  assert.equal(a.mimeType, 'application/pdf');
  assert.equal(a.body.toString(), '%PDF');
  assert.equal(decodeFile({ fileName: 'b.txt', fileData: Buffer.from('hi').toString('base64'), mimeType: 'text/plain' }).body.toString(), 'hi');
  assert.deepEqual(parseAttachmentList('[{"fileName":"a"}]'), [{ fileName: 'a' }]);
  assert.deepEqual(parseAttachmentList('nope'), []);
});
test('storeAttachments: R2 keys without the PR number; bad files recorded, never thrown (GAS)', async () => {
  const sent = [];
  const s3 = { send: async (c) => { sent.push(c.input); } };
  const pdf = 'data:application/pdf;base64,' + Buffer.from('%PDF').toString('base64');
  const out = await storeAttachments(s3, [
    { fileName: 'Báo giá.pdf', fileData: pdf },
    { fileName: 'x.html', fileData: Buffer.from('<p>').toString('base64'), mimeType: 'text/html' },
    { fileName: 'old.pdf', fileUrl: 'https://evil.example/x' },
  ]);
  assert.equal(out.length, 2, 'entries without fileData are ignored');
  assert.match(out[0].fileUrl, /^https:\/\/attachments\.tl-c\.us\/purchase-requests\/[0-9a-f]{32}-Bao_gia\.pdf$/);
  assert.equal(out[0].fileSize, 4);
  assert.deepEqual(out[1], { fileName: 'x.html', fileUrl: '', error: 'Loại file không được hỗ trợ' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ContentType, 'application/pdf');
  const none = await storeAttachments(null, [{ fileName: 'a.pdf', fileData: pdf }]);
  assert.deepEqual(none, [{ fileName: 'a.pdf', fileUrl: '', error: 'R2 chưa cấu hình' }]);
});
