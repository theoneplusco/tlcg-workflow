// tests/purchase-requests/emails.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.APP_BASE_URL = 'https://wf.test';
const m = await import('../../api/lib/purchase-requests/emails.js');

const pr = {
  pr_no: 'EV-PR20261007000001', company_name: 'CÔNG TY <b>EV</b>', requester_name: 'Thư', requester_email: 'Req@x.vn',
  purpose: 'Mua <script>x</script>', grand_total: '149500', required_date: '2026-10-20',
  budget_approver_email: 'Linh@x.vn', supplier_approver_email: 'linh@x.vn', purchasing_approver_email: 'Tlc.ap@x.vn',
  attachments: [{ fileName: 'bao-gia.pdf', fileUrl: 'https://attachments.tl-c.us/purchase-requests/a-bao-gia.pdf' }, { fileName: 'x', fileUrl: '', error: 'e' }],
};

test('approvalRequests: one email when budget and supplier are the same person (B12)', () => {
  const list = m.approvalRequests(pr);
  assert.equal(list.length, 1);
  assert.equal(list[0].to, 'linh@x.vn');
  assert.equal(list[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - EV-PR20261007000001');
  assert.match(list[0].html, /Đề nghị mua hàng<\/strong> mới đang chờ phê duyệt của bạn/);
  assert.match(list[0].html, /149\.500 ₫/);
  assert.match(list[0].html, /Ngày cần hàng/);
  assert.match(list[0].html, /https:\/\/attachments\.tl-c\.us\/purchase-requests\/a-bao-gia\.pdf/);
  assert.equal(m.approvalRequests({ ...pr, supplier_approver_email: 'ncc@x.vn' }).length, 2);
});
test('every value is HTML-escaped (S7) and every email links to the PR, without action tokens (S10)', () => {
  const html = m.approvalRequests(pr)[0].html;
  assert.doesNotMatch(html, /<script>|<b>EV/);
  assert.match(html, /Mua &lt;script&gt;/);
  assert.match(html, /href="https:\/\/wf\.test\/purchase_request\.html\?prNo=EV-PR20261007000001"/);
  assert.equal(m.prLink('A B'), 'https://wf.test/purchase_request.html?prNo=A%20B');
});
test('submitConfirmation: to the requester, no "Người đề nghị" row', () => {
  const c = m.submitConfirmation(pr);
  assert.equal(c.to, 'req@x.vn');
  assert.equal(c.subject, '[ĐỀ NGHỊ MUA HÀNG] Xác nhận gửi phiếu - EV-PR20261007000001');
  assert.match(c.html, /Người phê duyệt đã được thông báo qua email/);
  assert.doesNotMatch(c.html, />Người đề nghị</);
  assert.equal(m.submitConfirmation({ ...pr, requester_email: '' }), null);
});
test('purchasingRequest (B2: sent on both branches) and completed', () => {
  const p = m.purchasingRequest(pr);
  assert.equal(p.to, 'tlc.ap@x.vn');
  assert.equal(p.subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261007000001');
  assert.equal(m.purchasingRequest({ ...pr, purchasing_approver_email: '' }), null);
  const d = m.completed(pr);
  assert.equal(d.to, 'req@x.vn');
  assert.equal(d.subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - EV-PR20261007000001');
  assert.match(d.html, /phê duyệt hoàn tất/);
});
test('rejectedNotice: new in Postgres (B13)', () => {
  const r = m.rejectedNotice(pr, { by: 'Lê Linh', note: 'Giá <cao>' });
  assert.equal(r.to, 'req@x.vn');
  assert.equal(r.subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu bị từ chối - EV-PR20261007000001');
  assert.match(r.html, /Lý do từ chối:<\/strong><br>Giá &lt;cao&gt;/);
});
test('sendBackNotices: step 1 → requester, step 2 → budget + supplier once', () => {
  const one = m.sendBackNotices(pr, { targetStep: 1, byRole: 'budget', note: 'Thiếu báo giá' });
  assert.deepEqual(one.map((x) => x.to), ['req@x.vn']);
  assert.equal(one[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu được trả lại để bổ sung - EV-PR20261007000001');
  assert.match(one[0].html, /Chỉnh sửa &amp; Gửi lại/);
  assert.match(one[0].html, /Người duyệt Ngân sách/);
  const two = m.sendBackNotices(pr, { targetStep: 2, byRole: 'purchasing', note: 'Sai NCC' });
  assert.deepEqual(two.map((x) => x.to), ['linh@x.vn']);
  assert.equal(two[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Ngân sách & NCC - EV-PR20261007000001');
});
test('resubmitNotices: budget + supplier once', () => {
  const r = m.resubmitNotices(pr);
  assert.deepEqual(r.map((x) => x.to), ['linh@x.vn']);
  assert.equal(r[0].subject, '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - EV-PR20261007000001');
});
test('openStageRequests: who is asked after a submit/resubmit (and any self-approval)', () => {
  const at = (meta, over = {}) => m.openStageRequests({ ...pr, supplier_approver_email: 'ncc@x.vn', metadata: meta, ...over });
  assert.deepEqual(at({ budgetStatus: 'Pending', supplierStatus: 'Pending', purchasingStatus: 'Pending' }).map((x) => x.to), ['linh@x.vn', 'ncc@x.vn']);
  const half = at({ budgetStatus: 'Approved', supplierStatus: 'Pending', purchasingStatus: 'Pending' });
  assert.deepEqual(half.map((x) => [x.to, x.subject]), [['ncc@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - EV-PR20261007000001']]);
  const re = m.openStageRequests({ ...pr, supplier_approver_email: 'ncc@x.vn', metadata: { budgetStatus: 'Approved', supplierStatus: 'Pending', purchasingStatus: 'Pending' } }, 'resubmit');
  assert.deepEqual(re.map((x) => [x.to, x.subject]), [['ncc@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - EV-PR20261007000001']]);
  const buy = at({ budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Pending' });
  assert.deepEqual(buy.map((x) => [x.to, x.subject]), [['tlc.ap@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - EV-PR20261007000001']]);
  const done = at({ budgetStatus: 'Approved', supplierStatus: 'Approved', purchasingStatus: 'Approved' });
  assert.deepEqual(done.map((x) => [x.to, x.subject]), [['req@x.vn', '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - EV-PR20261007000001']]);
});
test('submitConfirmation: names the auto-approved steps', () => {
  assert.doesNotMatch(m.submitConfirmation(pr).html, /tự động duyệt/);
  const c = m.submitConfirmation(pr, [{ step: 2, labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.match(c.html, /Các bước bạn là người duyệt đã được tự động duyệt khi gửi phiếu \(đã xác nhận bằng mật khẩu\): bước 2 \(Người duyệt Ngân sách, Người duyệt NCC\)\./);
});
