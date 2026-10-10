import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, applyApproval, applyRejection, DEFAULT_STEPS } from '../../api/lib/approval/engine.js';
import { approvalRequest, progressUpdate, finalApproved, rejected, acknowledged, batchRequest, money } from '../../api/lib/vouchers/emails.js';

process.env.APP_BASE_URL = 'https://wf.tl-c.us';
const AT = '2026-10-07T03:00:00.000Z';
const company = {
  id: 4, accountant_name: 'Nguyễn Thị Nhanh', accountant_email: 'nhanh@x.vn',
  legal_rep_name: 'Nguyễn Văn Chinh', legal_rep_email: 'chinh@x.vn',
  treasurer_name: 'Lê Thùy Linh', treasurer_email: 'linh@x.vn', extra: {},
};
const v = { voucherNumber: 'MI-PC20261007000001', voucherType: 'Phiếu Chi', company: 'CÔNG TY TNHH MEDIA INSIDER',
  employee: 'Trần <b>A</b>', requestorEmail: 'a@x.vn', submittedBy: 'Trần <b>A</b>', amount: 1500000, description: 'Mua văn phòng phẩm' };
const fresh = () => buildPlan({ flow: { steps: DEFAULT_STEPS.voucher }, company, workflow: 'voucher' }).plan;

test('approval request: GAS subject and the query parameters the approve/reject pages read', () => {
  const p = applyApproval(fresh(), 'nhanh@x.vn', { at: AT }).plan;
  const m = approvalRequest(v, p, p.steps[1].approvers[0]);
  assert.equal(m.to, 'chinh@x.vn');
  assert.equal(m.subject, '[PHÊ DUYỆT] Phiếu MI-PC20261007000001 - Đại diện pháp luật');
  const href = m.html.match(/href="([^"]*approve_voucher\.html[^"]*)"/)[1].replace(/&amp;/g, '&');
  const q = new URL(href).searchParams;
  for (const [k, val] of Object.entries({ voucherNumber: v.voucherNumber, voucherType: 'Phiếu Chi', company: v.company, requestorEmail: 'a@x.vn', approverEmail: 'chinh@x.vn', approverRole: 'legalRep', amount: '1500000' })) {
    assert.equal(q.get(k), val, k);
  }
  assert.match(m.html, /reject_voucher\.html\?/);
  assert.match(m.html, /Nguyễn Thị Nhanh/, 'shows who approved before');
  assert.match(m.html, /Trần &lt;b&gt;A&lt;\/b&gt;/, 'escapes names');
  assert.match(m.html, /1\.500\.000 ₫/);
});

test('first request (nobody approved yet) says it is new', () => {
  const p = fresh();
  assert.match(approvalRequest(v, p, p.steps[0].approvers[0]).html, /mới cần Anh\/Chị phê duyệt/);
});

test('progress update counts steps and lists who is waiting', () => {
  const p = applyApproval(fresh(), 'nhanh@x.vn', { at: AT }).plan;
  const m = progressUpdate(v, p);
  assert.equal(m.to, 'a@x.vn');
  assert.equal(m.subject, '[ĐANG DUYỆT (1/3)] Phiếu MI-PC20261007000001');
  assert.match(m.html, /Đang chờ:<\/strong> Đại diện pháp luật Nguyễn Văn Chinh/);
});

test('final approval sends the notice and the acknowledge prompt with the receipt link', () => {
  let p = fresh();
  for (const e of ['nhanh@x.vn', 'chinh@x.vn', 'linh@x.vn']) p = applyApproval(p, e, { at: AT }).plan;
  const [notice, prompt] = finalApproved(v, p);
  assert.equal(notice.subject, '[ĐÃ DUYỆT HOÀN TOÀN] Phiếu MI-PC20261007000001');
  assert.equal(prompt.subject, '[XÁC NHẬN NHẬN TIỀN] Phiếu MI-PC20261007000001');
  assert.match(prompt.html, /voucher\.html\?acknowledgeReceipt=MI-PC20261007000001&amp;voucherType=/);
});

test('rejection goes to requester and every approver once', () => {
  const p = applyRejection(fresh(), 'linh@x.vn', { at: AT, reason: 'Sai số tiền', anyApprover: true });
  const m = rejected(v, p);
  assert.deepEqual(m.to.split(','), ['a@x.vn', 'nhanh@x.vn', 'chinh@x.vn', 'linh@x.vn']);
  assert.equal(m.subject, '[TỪ CHỐI] Phiếu MI-PC20261007000001');
  assert.match(m.html, /Sai số tiền/);
  assert.match(m.html, /Lê Thùy Linh \(Thủ quỹ\)/);
});

test('acknowledged: to the first step, cc the rest; Thu vs Chi wording', () => {
  let p = fresh();
  for (const e of ['nhanh@x.vn', 'chinh@x.vn', 'linh@x.vn']) p = applyApproval(p, e, { at: AT }).plan;
  const m = acknowledged({ ...v, voucherType: 'Phiếu Thu' }, p, { requesterName: 'Trần A', requesterEmail: 'a@x.vn', at: AT });
  assert.equal(m.to, 'nhanh@x.vn');
  assert.equal(m.cc, 'chinh@x.vn,linh@x.vn');
  assert.equal(m.subject, '[ĐÃ THU TIỀN] Phiếu MI-PC20261007000001');
});

test('batch request links to the voucher page, never a one-click token', () => {
  const m = batchRequest({ email: 'chinh@x.vn', name: 'Nguyễn Văn Chinh', label: 'Đại diện pháp luật' }, [v, { ...v, voucherNumber: 'MI-PC20261007000002' }]);
  assert.equal(m.subject, '[PHÊ DUYỆT HÀNG LOẠT] 2 phiếu cần duyệt - Đại diện pháp luật');
  assert.doesNotMatch(m.html, /token=/);
  assert.match(m.html, /https:\/\/wf\.tl-c\.us\/voucher\.html/);
});

test('money formats like GAS (vi-VN)', () => {
  assert.equal(money(1500000), '1.500.000 ₫');
  assert.equal(money('2,000,000'), '2.000.000 ₫');
});
