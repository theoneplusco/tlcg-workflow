// tests/purchase-requests/state.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS, computeBranch, approvalState, pendingEmails, approverEmails, applyApprove, applyReject,
  sendBackInputError, applySendBack, approverPickError, directPaymentProblem, branchOf, MISSING_REQUESTER_ERROR, prOwnSteps, prOwnOpen, prOwnLeft, picksAsRow, sentBackRound, ROLE_LABEL,
} from '../../api/lib/purchase-requests/state.js';

const AT = '2026-10-07T03:00:00.000Z';
const pr = (over = {}) => ({
  pr_no: 'EV-PR20261007000001', status: STATUS.PARALLEL, requester_email: 'req@x.vn',
  budget_approver_email: 'linh@x.vn', supplier_approver_email: 'Linh@x.vn', contract_approver_email: '',
  purchasing_approver_email: 'Tlc.ap@x.vn', p2p_branch: 'simplified', ...over,
});
const meta = (over = {}) => ({ budgetStatus: 'Pending', supplierStatus: 'Pending', contractStatus: 'N/A', purchasingStatus: 'Pending', p2pBranch: 'simplified', ...over });

test('computeBranch: services or ≥ 2,000,000 → full', () => {
  assert.equal(computeBranch('services', 10), 'full');
  assert.equal(computeBranch('goods', 2000000), 'full');
  assert.equal(computeBranch('goods', 1999999), 'simplified');
  assert.equal(computeBranch('', 0), 'simplified');
});

test('approvalState: GAS chain (contract stage skipped on both branches)', () => {
  assert.equal(approvalState(pr(), meta()).statusLabel, STATUS.PARALLEL);
  assert.equal(approvalState(pr(), meta({ budgetStatus: 'Approved' })).stage, 'parallel');
  assert.equal(approvalState(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' })).statusLabel, STATUS.PURCHASING);
  assert.equal(approvalState(pr({ purchasing_approver_email: '' }), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' })).statusLabel, STATUS.DONE);
  const full = pr({ p2p_branch: 'full', contract_approver_email: 'kt@x.vn' });
  assert.equal(approvalState(full, meta({ p2pBranch: 'full', budgetStatus: 'Approved', supplierStatus: 'Approved' })).stage, 'purchasing');
});

test('approve: same person on budget + supplier → one approval covers both (decision 2026-10-07)', () => {
  const r = applyApprove(pr(), meta(), { email: 'LINH@x.vn', role: 'budget', note: '', signature: 'data:sig', verification: '{"verified":true,"similarity":99.6}', at: AT });
  assert.deepEqual(r.roles, ['budget', 'supplier']);
  assert.equal(r.status, STATUS.PURCHASING);
  assert.equal(r.before.stage, 'parallel');
  assert.equal(r.after.stage, 'purchasing');
  assert.equal(r.meta.supplierApprovedAt, AT);
  assert.equal(r.meta.supplierSignature, 'data:sig');
  assert.deepEqual(r.meta.budgetSignatureVerification, { verified: true, similarity: 99.6 });
});

test('approve: distinct people approve separately; legacy half-approved PR finishes with the open slot', () => {
  const two = pr({ supplier_approver_email: 'ncc@x.vn' });
  const r = applyApprove(two, meta(), { email: 'linh@x.vn', role: 'budget', at: AT });
  assert.deepEqual(r.roles, ['budget']);
  assert.equal(r.status, STATUS.PARALLEL);
  const half = applyApprove(pr(), meta({ budgetStatus: 'Approved' }), { email: 'linh@x.vn', role: 'supplier', at: AT });
  assert.deepEqual(half.roles, ['supplier']);
  assert.equal(half.status, STATUS.PURCHASING);
  assert.deepEqual(applyApprove(pr(), meta(), { email: 'linh@x.vn', role: 'budget', verification: 'not json', at: AT }).meta.budgetSignatureVerification, { raw: 'not json' });
});

test('approve: GAS checks in GAS order with GAS wording', () => {
  const a = (p, m, email, role) => applyApprove(p, m, { email, role, at: AT }).error;
  assert.equal(a(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn', 'budget'), 'Đề nghị này đã bị từ chối, không thể duyệt.');
  assert.equal(a(pr({ status: 'Approved' }), meta(), 'linh@x.vn', 'budget'), 'Đề nghị này đã được duyệt rồi.');
  assert.equal(a(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn', 'budget'), 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.');
  assert.equal(a(pr(), meta(), 'linh@x.vn', 'contract'), 'Vai trò "contract" chưa được phân công cho đề nghị này.');
  assert.equal(a(pr(), meta(), 'x@x.vn', 'budget'), 'Bạn không được phân công là người duyệt "budget" cho đề nghị này.');
  assert.equal(a(pr(), meta(), 'tlc.ap@x.vn', 'purchasing'), 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: duyệt ngân sách & NCC.');
  const twoPeople = pr({ supplier_approver_email: 'ncc@x.vn' });
  assert.equal(a(twoPeople, meta({ budgetStatus: 'Approved' }), 'linh@x.vn', 'budget'), 'Bạn đã duyệt đề nghị này rồi.');
});

test('reject: permission, then turn, then status; picks the slot of the active stage', () => {
  const j = (p, m, email) => applyReject(p, m, { email, note: 'Sai giá', at: AT });
  assert.equal(j(pr(), meta(), 'x@x.vn').error, 'Bạn không có quyền từ chối đề nghị này.');
  assert.equal(j(pr(), meta(), 'tlc.ap@x.vn').error, 'Chưa đến lượt của bạn trong quy trình phê duyệt.');
  // GAS let the later role win (purchasing) and refused; we use the caller's slot in the open stage
  const ok = j(pr({ purchasing_approver_email: 'linh@x.vn' }), meta(), 'linh@x.vn');
  assert.equal(ok.role, 'budget');
  assert.equal(ok.status, STATUS.REJECTED);
  assert.equal(ok.meta.rejectedBy, 'linh@x.vn');
  assert.equal(ok.meta.rejectionNote, 'Sai giá');
  assert.equal(j(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn').error, 'Đề nghị này đã bị từ chối rồi.');
  assert.equal(j(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn').error, 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.');
});

test('send back: input checks before lookup', () => {
  assert.equal(sendBackInputError({ sentBackNote: ' ', targetStep: 1, approverRole: 'budget' }), 'Vui lòng nhập lý do trả lại.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: 4, approverRole: 'budget' }), 'Bước trả lại không hợp lệ.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: '2', approverRole: 'boss' }), 'Vai trò không hợp lệ.');
  assert.equal(sendBackInputError({ sentBackNote: 'x', targetStep: '2', approverRole: 'purchasing' }), null);
});

test('send back step 1 → Trả lại bổ sung, history pushed, approvals kept (GAS)', () => {
  const r = applySendBack(pr(), meta({ budgetStatus: 'Approved' }), { email: 'linh@x.vn', role: 'supplier', targetStep: 1, note: ' Thiếu báo giá ', at: AT });
  assert.equal(r.status, STATUS.RETURNED);
  assert.equal(r.meta.budgetStatus, 'Approved');
  assert.deepEqual(r.meta.sentBackHistory, [{ targetStep: 1, by: 'linh@x.vn', byRole: 'supplier', at: AT, note: 'Thiếu báo giá' }]);
});

test('send back step 2 by purchasing resets the chain; step 3 is refused (B3); GAS check order', () => {
  const m = meta({ budgetStatus: 'Approved', budgetApprovedAt: AT, budgetNote: 'ok', budgetSignature: 'data:s', supplierStatus: 'Approved' });
  const p = pr({ status: STATUS.PURCHASING });
  const r = applySendBack(p, m, { email: 'tlc.ap@x.vn', role: 'purchasing', targetStep: 2, note: 'Sai NCC', at: AT });
  assert.equal(r.status, STATUS.PARALLEL);
  assert.equal(r.meta.budgetStatus, 'Pending');
  assert.equal(r.meta.purchasingStatus, 'Pending');
  assert.equal(r.meta.contractStatus, 'N/A');
  assert.equal(r.meta.budgetApprovedAt, undefined);
  assert.equal(r.meta.budgetSignature, 'data:s', 'signatures stay (GAS)');
  assert.equal(applySendBack(p, m, { email: 'tlc.ap@x.vn', role: 'purchasing', targetStep: 3, note: 'x', at: AT }).error, 'Bước trả lại không hợp lệ với vai trò của bạn.');
  assert.equal(applySendBack(p, m, { email: 'x@x.vn', role: 'budget', targetStep: 1, note: 'x', at: AT }).error, 'Chưa đến lượt của bạn trong quy trình phê duyệt.', 'turn before assignment');
  assert.equal(applySendBack(p, m, { email: 'x@x.vn', role: 'purchasing', targetStep: 1, note: 'x', at: AT }).error, 'Bạn không được phân công vai trò "purchasing" cho đề nghị này.');
  assert.equal(applySendBack(pr({ status: STATUS.RETURNED }), meta(), { email: 'linh@x.vn', role: 'budget', targetStep: 1, note: 'x', at: AT }).error, 'Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.');
});

test('pendingEmails / approverEmails', () => {
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.PARALLEL), ['linh@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), STATUS.PURCHASING), ['tlc.ap@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.RETURNED), ['req@x.vn']);
  assert.deepEqual(pendingEmails(pr(), meta(), STATUS.DONE), []);
  assert.deepEqual(approverEmails(pr({ contract_approver_email: 'KT@x.vn' })), ['linh@x.vn', 'kt@x.vn', 'tlc.ap@x.vn']);
});

test('approverPickError: server check of the requester picks (S3)', () => {
  const cands = { companyEmails: new Set(['linh@x.vn', 'kt@x.vn']), purchasingEmails: new Set(['tlc.ap@x.vn']) };
  const ok = { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' };
  assert.equal(approverPickError(ok, cands, 'full', 'req@x.vn'), null);
  assert.match(approverPickError({ ...ok, budget: 'me@x.vn' }, cands, 'full', 'req@x.vn'), /^Người phê duyệt ngân sách \(me@x\.vn\) không thuộc danh sách/);
  assert.equal(approverPickError({ ...ok, contract: 'me@x.vn' }, cands, 'simplified', 'req@x.vn'), null, 'contract not used on simplified');
  assert.match(approverPickError({ ...ok, purchasing: 'linh@x.vn' }, cands, 'full', 'req@x.vn'), /không thuộc phòng Kế Toán Chi/);
  assert.equal(approverPickError({ ...ok, purchasing: '' }, cands, 'full', 'req@x.vn'), null, 'purchasing optional');
});

test('approverPickError: self-picks allowed again (Plan 5c) but must be on the lists; requester still required', () => {
  const cands = { companyEmails: new Set(['linh@x.vn', 'kt@x.vn']), purchasingEmails: new Set(['tlc.ap@x.vn']) };
  const ok = { budget: 'linh@x.vn', supplier: 'linh@x.vn', contract: 'kt@x.vn', purchasing: 'tlc.ap@x.vn' };
  assert.equal(approverPickError(ok, cands, 'full', 'linh@x.vn'), null, 'requester on budget + supplier');
  assert.equal(approverPickError(ok, cands, 'full', 'TLC.AP@x.vn'), null, 'requester as purchasing');
  assert.equal(approverPickError(ok, cands, 'full', 'kt@x.vn'), null, 'requester as contract reviewer');
  assert.match(approverPickError({ ...ok, budget: 'me@x.vn' }, cands, 'full', 'me@x.vn'), /không thuộc danh sách/);
  assert.equal(approverPickError(ok, cands, 'full'), 'Thiếu thông tin người đề nghị.', 'requester omitted → fail closed');
  assert.equal(approverPickError(ok, cands, 'full', '  '), MISSING_REQUESTER_ERROR);
});

test('applyApprove: the requester approves their own slot by hand (declined consent, old PRs)', () => {
  const r = applyApprove(pr({ requester_email: 'Linh@x.vn' }), meta(), { email: 'linh@x.vn', role: 'budget', at: AT });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.roles, ['budget', 'supplier']);
});

test('own PR slots: steps 2 / 5 in order, open stage only, contract never, rounds', () => {
  assert.deepEqual(ROLE_LABEL, { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' });
  assert.deepEqual(prOwnSteps(pr(), 'LINH@x.vn'), [
    { step: 2, key: '*', entries: null, roles: ['budget', 'supplier'], labels: ['Người duyệt Ngân sách', 'Người duyệt NCC'] }]);
  assert.deepEqual(prOwnSteps(pr(), 'tlc.ap@x.vn').map((o) => [o.step, o.roles]), [[5, ['purchasing']]]);
  assert.deepEqual(prOwnSteps(pr({ p2p_branch: 'full', contract_approver_email: 'kt@x.vn' }), 'kt@x.vn'), [], 'the contract stage never opens');
  assert.deepEqual(prOwnSteps(pr(), ''), []);
  assert.deepEqual(prOwnSteps(picksAsRow({ budget: 'a@x.vn', supplier: 'b@x.vn', contract: '', purchasing: 'a@x.vn' }), 'a@x.vn').map((o) => [o.step, o.roles]),
    [[2, ['budget']], [5, ['purchasing']]]);
  assert.equal(prOwnOpen(pr(), meta(), 'tlc.ap@x.vn'), null, 'purchasing not open yet');
  assert.deepEqual(prOwnOpen(pr(), meta(), 'linh@x.vn'), prOwnSteps(pr(), 'linh@x.vn')[0], 'same step + key as the consent');
  assert.deepEqual(prOwnOpen(pr(), meta({ budgetStatus: 'Approved' }), 'linh@x.vn').roles, ['supplier']);
  assert.equal(prOwnOpen(pr(), meta({ budgetStatus: 'Approved' }), 'linh@x.vn').key, '*', 'key from the stage, not the pending slots');
  assert.deepEqual(prOwnOpen(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'tlc.ap@x.vn').roles, ['purchasing']);
  assert.equal(prOwnOpen(pr({ status: STATUS.RETURNED }), meta(), 'linh@x.vn'), null);
  assert.equal(prOwnOpen(pr({ status: STATUS.REJECTED }), meta(), 'linh@x.vn'), null);
  assert.equal(prOwnLeft(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'linh@x.vn'), false);
  assert.equal(prOwnLeft(pr(), meta({ budgetStatus: 'Approved', supplierStatus: 'Approved' }), 'tlc.ap@x.vn'), true);
  // Every send-back starts a new consent round (decision 2 reversed)
  assert.equal(sentBackRound({}), 0);
  assert.equal(sentBackRound({ sentBackHistory: [{ targetStep: 2 }, { targetStep: 1 }] }), 2);
});

test('approve: budget+purchasing person in the parallel stage fills only parallel slots', () => {
  const p = pr({ purchasing_approver_email: 'linh@x.vn' });
  const r = applyApprove(p, meta(), { email: 'linh@x.vn', role: 'budget', at: AT });
  assert.deepEqual(r.roles, ['budget', 'supplier']);
  assert.equal(r.meta.purchasingStatus, 'Pending');
  assert.equal(r.status, STATUS.PURCHASING);
  const only = pr({ supplier_approver_email: 'ncc@x.vn', purchasing_approver_email: 'linh@x.vn' });
  assert.deepEqual(applyApprove(only, meta(), { email: 'linh@x.vn', role: 'budget', at: AT }).roles, ['budget']);
});

test('pendingEmails: distinct budget/supplier after one approved lists only the other', () => {
  const two = pr({ supplier_approver_email: 'ncc@x.vn' });
  assert.deepEqual(pendingEmails(two, meta({ budgetStatus: 'Approved' }), STATUS.PARALLEL), ['ncc@x.vn']);
});

test('applySendBack tolerates a missing note on step 2 (history keeps empty string)', () => {
  const r = applySendBack(pr(), meta(), { email: 'linh@x.vn', role: 'budget', targetStep: 1, at: AT });
  assert.equal(r.meta.sentBackHistory[0].note, '');
});

test('directPaymentProblem: GAS validatePRForDirectPayment rules', () => {
  assert.equal(directPaymentProblem({ status: STATUS.PURCHASING, p2p_branch: 'simplified' }), 'PR chưa được phê duyệt hoàn tất.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, p2p_branch: 'full' }), 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, p2p_branch: 'simplified' }), null);
});

test('branchOf: from the stored VND total; rows imported from GAS keep their stored branch', () => {
  assert.equal(branchOf({ purchase_type: 'goods', grand_total_vnd: '2600000', p2p_branch: 'simplified' }), 'full');
  assert.equal(branchOf({ purchase_type: 'goods', grand_total_vnd: '149500.00', p2p_branch: 'full' }), 'simplified');
  assert.equal(branchOf({ purchase_type: 'services', grand_total_vnd: '10' }), 'full');
  assert.equal(branchOf({ p2p_branch: 'simplified', grand_total_vnd: null }), 'simplified');
  assert.equal(branchOf({ metadata: { p2pBranch: 'simplified' } }), 'simplified');
  assert.equal(branchOf({}), 'full');
});
test('directPaymentProblem: the VND branch decides', () => {
  assert.equal(directPaymentProblem({ status: STATUS.DONE, purchase_type: 'goods', grand_total_vnd: '2600000', p2p_branch: 'simplified' }),
    'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.');
  assert.equal(directPaymentProblem({ status: STATUS.DONE, purchase_type: 'goods', grand_total_vnd: '1300000', p2p_branch: 'simplified' }), null);
});
