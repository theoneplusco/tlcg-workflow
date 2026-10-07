// api/lib/purchase-requests/emails.js — Purchase request emails (pure). Ported from GAS
// sendPurchaseRequestEmails_, sendPurchaseRequestStageEmail_, sendPurchaseRequestSendBackEmail_,
// sendPurchaseRequestResubmitEmails_ (TLCG_P2P_BACKEND.gs), with on purpose:
// - values HTML-escaped (S7) and a plain deep link to the PR (login required; no action tokens, S10);
// - one email per distinct address (B12); the purchasing email on both branches (B2);
// - a rejection email to the requester (B13).
import { baseUrl, money } from '../vouchers/emails.js';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = (s) => String(s || '').trim().toLowerCase();
const distinct = (...emails) => [...new Set(emails.map(lower).filter(Boolean))];
const P = '[ĐỀ NGHỊ MUA HÀNG]';
const SIGN_OFF = '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
export const ROLE_LABEL = { budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC', contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng' };

export const prLink = (no) => `${baseUrl()}/purchase_request.html?prNo=${encodeURIComponent(no)}`;
const button = (no) => `<p style="margin:16px 0;"><a href="${esc(prLink(no))}" style="background:#4285f4;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;">Mở đề nghị ${esc(no)}</a></p>`;

function table(pr, { requester = true, requiredDate = true } = {}) {
  const rows = [['Số phiếu', pr.pr_no], ['Công ty', pr.company_name]];
  if (requester) rows.push(['Người đề nghị', pr.requester_name]);
  rows.push(['Mục đích', pr.purpose], ['Tổng cộng', money(Number(pr.grand_total) || 0)]);
  if (requiredDate) rows.push(['Ngày cần hàng', pr.required_date]);
  return `<table style="border-collapse:collapse;margin:12px 0;">${rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px;border:1px solid #e2e8f0;font-weight:600;">${k}</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${esc(v)}</td></tr>`).join('')}</table>`;
}
function attachmentList(pr) {
  const files = (pr.attachments || []).filter((a) => a && a.fileUrl);
  if (!files.length) return '';
  return `<p><strong>Tệp đính kèm:</strong></p><ul>${files.map((a) => `<li><a href="${esc(a.fileUrl)}">${esc(a.fileName || a.fileUrl)}</a></li>`).join('')}</ul>`;
}
const box = (title, text) => `<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;margin:12px 0;"><strong>${title}</strong><br>${esc(text)}</div>`;
const mail = (to, subject, body) => ({ to, subject, html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;">${body}${SIGN_OFF}</div>` });

export function approvalRequests(pr) {
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to, `${P} Yêu cầu phê duyệt - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Có một <strong>Đề nghị mua hàng</strong> mới đang chờ phê duyệt của bạn.</p>${table(pr)}
     <p>Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>${button(pr.pr_no)}${attachmentList(pr)}`));
}

export function submitConfirmation(pr) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Xác nhận gửi phiếu - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng của bạn đã được gửi thành công.</p>${table(pr, { requester: false })}
     <p>Người phê duyệt đã được thông báo qua email và sẽ xử lý đề nghị của bạn.</p>${button(pr.pr_no)}${attachmentList(pr)}`);
}

export function purchasingRequest(pr) {
  const to = lower(pr.purchasing_approver_email);
  if (!to) return null;
  return mail(to, `${P} Yêu cầu Mua hàng - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Giai đoạn <strong>Mua hàng</strong> của Đề nghị mua hàng đã mở và đang chờ xử lý của bạn.</p>${table(pr)}${button(pr.pr_no)}`);
}

export function completed(pr) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Phiếu đã hoàn thành - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng <strong>${esc(pr.pr_no)}</strong> của bạn đã được <strong>phê duyệt hoàn tất</strong>.</p>
     <p>Công ty: ${esc(pr.company_name)}</p>${button(pr.pr_no)}`);
}

export function rejectedNotice(pr, { by, note } = {}) {
  const to = lower(pr.requester_email);
  if (!to) return null;
  return mail(to, `${P} Phiếu bị từ chối - ${pr.pr_no}`,
    `<p>Kính gửi ${esc(pr.requester_name)},</p><p>Đề nghị mua hàng <strong>${esc(pr.pr_no)}</strong> của bạn đã bị <strong>từ chối</strong> bởi ${esc(by)}.</p>
     ${table(pr, { requester: false })}${note ? box('Lý do từ chối:', note) : ''}${button(pr.pr_no)}`);
}

export function sendBackNotices(pr, { targetStep, byRole, note } = {}) {
  const who = ROLE_LABEL[byRole] || byRole;
  const reason = box('Lý do trả lại:', note);
  if (Number(targetStep) === 1) {
    const to = lower(pr.requester_email);
    return to ? [mail(to, `${P} Phiếu được trả lại để bổ sung - ${pr.pr_no}`,
      `<p>Kính gửi ${esc(pr.requester_name)},</p><p>${esc(who)} đã trả lại đề nghị mua hàng của bạn để bổ sung thông tin.</p>
       ${table(pr, { requiredDate: false })}${reason}<p>Vui lòng mở đề nghị và chọn <strong>"Chỉnh sửa &amp; Gửi lại"</strong>.</p>${button(pr.pr_no)}`)] : [];
  }
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to,
    `${P} Yêu cầu xem lại - Bước Ngân sách & NCC - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>${esc(who)} đã trả lại đề nghị mua hàng về bước <strong>Duyệt ngân sách &amp; NCC</strong>. Vui lòng xem lại và phê duyệt lại.</p>
     ${table(pr, { requiredDate: false })}${reason}${button(pr.pr_no)}`));
}

export function resubmitNotices(pr) {
  return distinct(pr.budget_approver_email, pr.supplier_approver_email).map((to) => mail(to,
    `${P} Phiếu đã được cập nhật và gửi lại - ${pr.pr_no}`,
    `<p>Kính gửi,</p><p>Người đề nghị đã cập nhật và gửi lại <strong>Đề nghị mua hàng</strong>. Vui lòng xem lại và phê duyệt.</p>
     ${table(pr)}${button(pr.pr_no)}${attachmentList(pr)}`));
}
