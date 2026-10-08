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
test('checkSubmission: requesterSignature, when sent, must be a data:image/ URL of at most 500 KB', () => {
  const e = (sig) => checkSubmission(body({ requesterSignature: sig })).error;
  const BAD = 'Chữ ký không hợp lệ hoặc quá lớn.';
  assert.equal(e(''), undefined, 'optional: the page sends "" without a saved signature');
  assert.equal(e(undefined), undefined);
  assert.equal(e('data:image/png;base64,AAAA'), undefined);
  const head = 'data:image/png;base64,';
  assert.equal(e(head + 'A'.repeat(500 * 1024 - head.length)), undefined, 'exactly 500 KB accepted');
  assert.equal(e(head + 'A'.repeat(500 * 1024 - head.length + 1)), BAD, 'one character over refused');
  assert.equal(e('https://evil.example/x.png'), BAD);
  assert.equal(e('data:text/html;base64,PHNjcmlwdD4='), BAD);
  assert.equal(e({ src: 'data:image/png;base64,AAAA' }), BAD, 'not a string');
  assert.equal(e(12345), BAD);
});
test('checkSubmission: total and branch from the items, never the client (S4); picks lower-cased', () => {
  // Line total '1' and grandTotal 1 from the client are ignored: 5 × 500,000 (decision #6).
  const big = JSON.stringify([{ section: 'hang-hoa', desc: 'Khăn', qty: '5', price: '500000', total: '1' }]);
  const s = checkSubmission(body({ grandTotal: 1, items: big, contractApprover: 'KT@x.vn' }));
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

// ── Fix round 1: the server computes every line (decision #6), currency-aware numbers, caps ──
import { num, normalizeItems, NUMBER_ERROR, TOO_LONG_ERROR, MAX_ITEMS } from '../../api/lib/purchase-requests/validate.js';
const list = (arr) => JSON.stringify(arr);

test('line totals: qty × price wins over the client total; total only when qty or price is missing', () => {
  const s = checkSubmission(body({ contractApprover: 'kt@x.vn',
    items: list([{ desc: 'A', qty: '100', price: '1000000', total: '1' }]) }));
  assert.equal(s.grandTotal, 100000000);
  assert.equal(s.branch, 'full');
  assert.equal(s.items[0].total, 100000000, 'stored item agrees with grand_total');
  const mixed = checkSubmission(body({ items: list([
    { desc: 'A', qty: '2', price: '10000', total: '999' }, // 20,000
    { desc: 'B', total: '50000' }, // no qty/price → 50,000
    { desc: 'C', qty: '3', price: '', total: '7000' }, // price missing → 7,000
    { desc: 'D' }, // nothing → 0
  ]) }));
  assert.equal(mixed.grandTotal, 77000);
  assert.deepEqual(mixed.items.map((i) => i.total), [20000, 50000, 7000, 0]);
});

test('negative or non-numeric qty / price / total refused', () => {
  const e = (it) => checkSubmission(body({ items: list([{ desc: 'A', qty: '1', price: '1000' }, it]) })).error;
  assert.equal(NUMBER_ERROR, 'Số lượng, đơn giá và thành tiền phải là số không âm.');
  assert.equal(e({ desc: 'B', qty: '-1', price: '1000' }), NUMBER_ERROR);
  assert.equal(e({ desc: 'B', qty: '1', price: '-1000' }), NUMBER_ERROR);
  assert.equal(e({ desc: 'B', total: '-5' }), NUMBER_ERROR);
  assert.equal(e({ desc: 'B', qty: '1', price: '1000', total: '-5' }), NUMBER_ERROR, 'even an ignored total');
  assert.equal(e({ desc: 'B', qty: 'abc', price: '1000' }), NUMBER_ERROR);
  assert.equal(e({ desc: 'B', qty: 'Infinity', price: '1000' }), NUMBER_ERROR);
  const inf = checkSubmission(body({ items: '[{"desc":"B","qty":1e400,"price":"1000"}]' })).error; // JSON.parse → Infinity
  assert.equal(inf, NUMBER_ERROR);
});

test('num: dotted / comma thousands only for VND; other currencies are plain decimals', () => {
  assert.equal(num('1.234.567'), 1234567);
  assert.equal(num('1.234.567', 'VND'), 1234567);
  assert.equal(num('4.125', 'VND'), 4125);
  assert.equal(num('1,234,567', 'VND'), 1234567);
  assert.equal(num('4.125', 'USD'), 4.125);
  assert.equal(num('1,234.5', 'USD'), 1234.5);
  assert.equal(num('2.75', 'EUR'), 2.75);
  assert.equal(num('', 'USD'), 0);
  assert.ok(Number.isNaN(num('1.234.567', 'USD')));
  const usd = checkSubmission(body({ currency: 'USD', items: list([{ desc: 'A', qty: '1.5', price: '2.75', total: '0' }]) }), { currency: 'USD', rateToVnd: 26000 });
  assert.equal(usd.grandTotal, 4.125);
  assert.equal(usd.items[0].total, 4.125);
  const vnd = checkSubmission(body({ currency: 'VND', items: list([{ desc: 'A', qty: '1', price: '1.234.567' }]) }));
  assert.equal(vnd.grandTotal, 1234567);
  const kg = checkSubmission(body({ currency: 'VND', items: list([{ desc: 'Gạo', qty: '1.500', price: '20000' }]) }));
  assert.equal(kg.grandTotal, 30000, 'quantity 1.500 is 1.5 (the page parseFloat), not 1,500');
});

test('caps: at most 200 items and 1000 characters per field; stored keys are the page keys', () => {
  assert.equal(TOO_LONG_ERROR, 'Danh sách hàng hóa quá dài.');
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ desc: 'x' + i, qty: '1', price: '1' }));
  assert.equal(checkSubmission(body({ items: list(many) })).error, TOO_LONG_ERROR);
  assert.equal(checkSubmission(body({ items: list(many.slice(0, MAX_ITEMS)) })).error, undefined);
  assert.equal(checkSubmission(body({ items: list([{ desc: 'x'.repeat(1001) }]) })).error, TOO_LONG_ERROR);
  const { items: kept } = normalizeItems([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Khăn', qty: '5', unit: 'Cái',
    price: '29900', total: '1', note: 'n', evil: '<script>', fileUrl: 'https://x' }]);
  assert.deepEqual(kept, [{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Khăn', qty: '5', unit: 'Cái', price: '29900', total: 149500, note: 'n' }]);
  assert.equal(normalizeItems([{ desc: 'Old', quantity: '2', unitPrice: '10' }]).items[0].total, 20, 'legacy keys read as qty/price');
});

const fxBody = (over = {}) => ({ companyName: 'C', requesterName: 'R', requiredDate: '2026-10-20', budgetApprover: 'b@x.vn',
  supplierApprover: 's@x.vn', purchaseType: 'goods', items: JSON.stringify([{ desc: 'A', qty: '1', price: '100' }]), ...over });

test('checkSubmission: the 2,000,000 limit is in VND; other currencies use the given rate, never a guess', () => {
  const vnd = checkSubmission(fxBody({ items: JSON.stringify([{ desc: 'A', qty: '1', price: '1999999' }]) }));
  assert.deepEqual([vnd.currency, vnd.rateToVnd, vnd.grandTotalVnd, vnd.branch], ['VND', 1, 1999999, 'simplified']);
  assert.equal(checkSubmission(fxBody({ currency: 'USD' }), { currency: 'USD', rateToVnd: 26000 }).error,
    'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
  const full = checkSubmission(fxBody({ currency: 'USD', contractApprover: 'c@x.vn' }), { currency: 'USD', rateToVnd: 26000 });
  assert.deepEqual([full.grandTotal, full.grandTotalVnd, full.branch, full.picks.contract], [100, 2600000, 'full', 'c@x.vn']);
  const small = checkSubmission(fxBody({ currency: 'USD', items: JSON.stringify([{ desc: 'A', qty: '1', price: '76.9' }]) }), { currency: 'USD', rateToVnd: 26000 });
  assert.deepEqual([small.grandTotalVnd, small.branch], [1999400, 'simplified']);
  assert.equal(checkSubmission(fxBody({ currency: 'EUR' }), { currency: 'EUR', rateToVnd: null }).error, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.');
  assert.equal(checkSubmission(fxBody({ currency: 'eur' })).error, 'Chưa có tỷ giá cho EUR. Vui lòng liên hệ quản trị viên.', 'no rate given → refused');
  assert.equal(checkSubmission(fxBody({ currency: 'US$' })).error, 'Loại tiền tệ không hợp lệ.');
  assert.equal(checkSubmission(fxBody({ companyName: '', currency: 'EUR' })).error, 'Thiếu tên công ty.', 'GAS checks keep their order');
  assert.equal(checkSubmission(fxBody({ currency: 'VNĐ' })).currency, 'VND');
});
