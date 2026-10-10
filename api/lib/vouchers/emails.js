// api/lib/vouchers/emails.js — Voucher email content (pure). Ported from the
// GAS templates in TLCG_CASH_BACKEND.gs (sendApprovalEmailToNextApprover,
// sendProgressEmail, sendFinalApprovalEmail, handleRejectVoucher,
// handleAcknowledgeReceipt, sendBatchApprovalEmail_), generalised from the
// fixed accountant → legalRep → treasurer chain to any approval plan.
// Each function returns { to, cc?, subject, html } (or an array of them).
//
// Differences from GAS, on purpose:
// - Dynamic values are HTML-escaped.
// - The batch email links to the voucher page (sign in + signature) instead
//   of GAS's unsigned one-click "approve all" token.
import { progress, pendingStep } from '../approval/engine.js';
import { legacyCompanyApprovers } from './compat.js';

export const baseUrl = () => (process.env.APP_BASE_URL || 'https://wf.tl-c.us').replace(/\/$/, '');

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : 'N/A');
export const money = (amount) => {
  const n = typeof amount === 'number' ? amount : Number(String(amount || '0').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n.toLocaleString('vi-VN') + ' ₫' : String(amount || '0 ₫');
};
const SIGN_OFF = '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
const btn = (href, label, color) =>
  `<a href="${esc(href)}" style="background: ${color}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; margin-right: 10px;">${label}</a>`;
const statusLink = (no) => `${baseUrl()}/voucher.html?viewStatus=${encodeURIComponent(no)}`;
const statusButton = (no) => `<p style="margin-top: 15px;">${btn(statusLink(no), '🔍 Xem trạng thái chi tiết', '#4285f4')}</p>`;

/** "Kế toán trưởng Nguyễn Thị Nhanh" / "Nguyễn Văn A" */
const who = (a) => (a.label ? `${a.label} ${a.name || a.email}` : a.name || a.email);

/** The legacy key (accountant / legalRep / treasurer / stepN) the pages pass as approverRole. */
function legacyKeyFor(plan, email) {
  const ca = legacyCompanyApprovers(plan);
  return Object.keys(ca.approvers).find((k) => ca.approvers[k].email === email && ca.approvers[k].status !== 'approved')
    || Object.keys(ca.approvers).find((k) => ca.approvers[k].email === email) || '';
}

function lastApproved(plan) {
  return plan.steps.flatMap((s) => s.approvers).filter((a) => a.status === 'approved' && a.at)
    .sort((x, y) => String(x.at).localeCompare(String(y.at))).pop() || null;
}

function voucherListItems(v) {
  return `
        <li><strong>Số phiếu:</strong> ${esc(v.voucherNumber)}</li>
        <li><strong>Loại phiếu:</strong> ${esc(v.voucherType || 'N/A')}</li>
        <li><strong>Công ty:</strong> ${esc(v.company || 'N/A')}</li>
        <li><strong>Người đề nghị:</strong> ${esc(v.employee)}</li>
        ${v.submittedBy && v.submittedBy !== v.employee ? `<li><strong>Người nộp phiếu:</strong> ${esc(v.submittedBy)}</li>` : ''}
        <li><strong>Số tiền:</strong> ${money(v.amount)}</li>`;
}

/**
 * Ask one approver to act (submit, and each time a step completes).
 * GAS subject: "[PHÊ DUYỆT] Phiếu <no> - <role>"; links carry the same query
 * parameters approve_voucher.html / reject_voucher.html read.
 */
export function approvalRequest(v, plan, approver) {
  const q = new URLSearchParams({
    voucherNumber: v.voucherNumber, voucherType: v.voucherType || '', company: v.company || '',
    employee: v.employee || '', amount: String(v.amount ?? ''), requestorEmail: v.requestorEmail || '',
    approverEmail: approver.email, approverRole: legacyKeyFor(plan, approver.email),
  }).toString();
  const prev = lastApproved(plan);
  const { text } = progress(plan);
  const ca = legacyCompanyApprovers(plan);
  return {
    to: approver.email,
    subject: `[PHÊ DUYỆT] Phiếu ${v.voucherNumber} - ${approver.label || 'Người duyệt'}`,
    html: `
      <p>Kính gửi ${esc(approver.name || approver.email)},</p>
      ${prev ? `<p>Phiếu <strong>${esc(v.voucherNumber)}</strong> đã được phê duyệt bởi ${esc(who(prev))}.</p>
        <div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 15px 0; border-radius: 4px;">
          <h4 style="margin-top: 0; color: #1e40af;">Thông tin người đã duyệt:</h4>
          <ul style="margin: 10px 0; padding-left: 20px;">
            <li><strong>Tên:</strong> ${esc(prev.name)}</li>
            <li><strong>Email:</strong> ${esc(prev.email)}</li>
            <li><strong>Vai trò:</strong> ${esc(prev.label || 'Người duyệt')}</li>
            <li><strong>Ngày giờ duyệt:</strong> ${when(prev.at)}</li>
          </ul>
        </div>` : `<p>Có phiếu <strong>${esc(v.voucherNumber)}</strong> mới cần Anh/Chị phê duyệt.</p>`}
      <p>Vui lòng xem xét và phê duyệt phiếu này.</p>
      <h3>Thông tin phiếu:</h3>
      <ul>${voucherListItems(v)}
      </ul>
      <h3>Tiến độ phê duyệt:</h3>
      <p>${esc(ca.displayStatus)} (${text})</p>
      <p>${btn(`${baseUrl()}/approve_voucher.html?${q}`, '✅ Phê duyệt', '#34A853')}${btn(`${baseUrl()}/reject_voucher.html?${q}`, '❌ Từ chối', '#EA4335')}</p>
      ${statusButton(v.voucherNumber)}
      ${SIGN_OFF}`,
  };
}

/** Progress update to the requester after each approval that does not finish the plan. */
export function progressUpdate(v, plan) {
  const { done, total } = progress(plan);
  const open = pendingStep(plan);
  const prev = lastApproved(plan);
  const lines = plan.steps.map((s, i) => s.approvers.map((a) => {
    const mark = a.status === 'approved' ? '✅' : '⏳';
    const state = a.status === 'approved' ? `Đã duyệt lúc: ${when(a.at)}` : i === open ? 'Đang chờ phê duyệt...' : 'Chưa đến lượt';
    return `<li>${mark} <strong>Bước ${i + 1}${a.label ? ': ' + esc(a.label) : ''}:</strong> ${esc(a.name || a.email)}<br>${state}</li>`;
  }).join('')).join('');
  const waiting = open >= 0 ? plan.steps[open].approvers.filter((a) => a.status !== 'approved') : [];
  return {
    to: v.requestorEmail,
    subject: `[ĐANG DUYỆT (${done}/${total})] Phiếu ${v.voucherNumber}`,
    html: `
      <p>Kính gửi Anh/Chị,</p>
      <p>Phiếu <strong>${esc(v.voucherNumber)}</strong> của Anh/Chị đang được xử lý:</p>
      <h3>📊 Tiến độ phê duyệt: ${done}/${total} bước đã duyệt</h3>
      ${prev ? `<div style="background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 4px;">
          <h3 style="margin-top: 0; color: #1e40af;">✅ Người đã duyệt gần nhất:</h3>
          <ul style="margin: 10px 0; padding-left: 20px;">
            <li><strong>Tên:</strong> ${esc(prev.name)}</li>
            <li><strong>Email:</strong> ${esc(prev.email)}</li>
            <li><strong>Vai trò:</strong> ${esc(prev.label || 'Người duyệt')}</li>
            <li><strong>Ngày giờ duyệt:</strong> ${when(prev.at)}</li>
            <li><strong>Số phiếu:</strong> ${esc(v.voucherNumber)}</li>
          </ul>
        </div>` : ''}
      <h4>Danh sách người phê duyệt:</h4>
      <ul>${lines}</ul>
      ${waiting.length ? `<p>⏳ <strong>Đang chờ:</strong> ${waiting.map((a) => esc(who(a))).join(', ')} phê duyệt</p>` : ''}
      ${statusButton(v.voucherNumber)}
      ${SIGN_OFF}`,
  };
}

/** Two emails to the requester when the plan finishes: the notice + the acknowledge-receipt prompt. */
export function finalApproved(v, plan) {
  const isThu = String(v.voucherType || '').toUpperCase().includes('THU');
  const list = plan.steps.map((s, i) => s.approvers.map((a) =>
    `<li>✅ <strong>Bước ${i + 1}${a.label ? ': ' + esc(a.label) : ''}</strong> - ${esc(a.name || a.email)}<br>Đã duyệt lúc: ${when(a.at)}${i === plan.steps.length - 1 ? ' (Duyệt cuối cùng)' : ''}</li>`).join('')).join('');
  const receiptUrl = `${baseUrl()}/voucher.html?acknowledgeReceipt=${encodeURIComponent(v.voucherNumber)}`
    + `&voucherType=${encodeURIComponent(v.voucherType || '')}&requestorEmail=${encodeURIComponent(v.requestorEmail || '')}`;
  const amount = money(v.amount);
  const desc = v.description || v.reason || '';
  return [
    {
      to: v.requestorEmail,
      subject: `[ĐÃ DUYỆT HOÀN TOÀN] Phiếu ${v.voucherNumber}`,
      html: `
      <p>Kính gửi Anh/Chị,</p>
      <p>Phiếu <strong>${esc(v.voucherNumber)}</strong> của Anh/Chị đã được phê duyệt đủ ${plan.steps.length} bước theo thứ tự:</p>
      <ul>${list}</ul>
      <p><strong>Phiếu đã được duyệt hoàn toàn và sẵn sàng để xử lý.</strong></p>
      <ul>
        <li><strong>Số tiền:</strong> ${amount}</li>
        ${desc ? `<li><strong>Nội dung:</strong> ${esc(desc)}</li>` : ''}
      </ul>
      ${SIGN_OFF}`,
    },
    {
      to: v.requestorEmail,
      subject: `[XÁC NHẬN ${isThu ? 'THU' : 'NHẬN'} TIỀN] Phiếu ${v.voucherNumber}`,
      html: `
      <p>Kính gửi Anh/Chị,</p>
      <p>Vui lòng xác nhận đã ${isThu ? 'thu' : 'nhận'} tiền cho phiếu <strong>${esc(v.voucherNumber)}</strong> (${amount}) bằng cách nhấn nút bên dưới:</p>
      <p style="margin-top:20px;">${btn(receiptUrl, isThu ? '✅ Xác nhận đã thu tiền' : '✅ Xác nhận đã nhận tiền', '#10b981')}</p>
      ${SIGN_OFF}`,
    },
  ];
}

/** Rejection notice to the requester and every approver in the plan (deduplicated). */
export function rejected(v, plan) {
  const r = plan.rejectedBy || {};
  const rejecter = plan.steps.flatMap((s) => s.approvers).find((a) => a.email === r.email) || { email: r.email, name: r.email };
  const to = [...new Set([v.requestorEmail, ...plan.steps.flatMap((s) => s.approvers.map((a) => a.email))].filter(Boolean))];
  return {
    to: to.join(','),
    subject: `[TỪ CHỐI] Phiếu ${v.voucherNumber}`,
    html: `
      <p>Kính gửi Anh/Chị,</p>
      <p>Phiếu <strong>${esc(v.voucherNumber)}</strong> đã bị từ chối.</p>
      <p><strong>Người từ chối:</strong> ${esc(rejecter.name || rejecter.email)}${rejecter.label ? ` (${esc(rejecter.label)})` : ''}</p>
      <p><strong>Lý do:</strong> ${esc(r.reason)}</p>
      <p><strong>Thời gian:</strong> ${when(r.at)}</p>
      ${statusButton(v.voucherNumber)}
      ${SIGN_OFF}`,
  };
}

/** Requester confirmed the money: to the first step's approvers, cc everyone else in the plan. */
export function acknowledged(v, plan, { requesterName, requesterEmail, at }) {
  const isThu = String(v.voucherType || '').toUpperCase().includes('THU');
  const first = plan.steps[0] ? plan.steps[0].approvers : [];
  const firstEmails = first.map((a) => a.email).filter(Boolean);
  const others = [...new Set(plan.steps.slice(1).flatMap((s) => s.approvers.map((a) => a.email)).filter((e) => e && !firstEmails.includes(e)))];
  const action = isThu ? 'thu tiền' : 'nhận tiền';
  return {
    to: firstEmails.join(','),
    cc: others.join(','),
    subject: `[${isThu ? 'ĐÃ THU TIỀN' : 'ĐÃ NHẬN TIỀN'}] Phiếu ${v.voucherNumber}`,
    html: `
      <p>Kính gửi ${esc(first.map((a) => a.name).filter(Boolean).join(', ') || 'Anh/Chị')},</p>
      <p>${isThu ? 'Người thu tiền' : 'Người nhận tiền'} <strong>${esc(requesterName || requesterEmail)}</strong> đã xác nhận ${action} cho phiếu <strong>${esc(v.voucherNumber)}</strong>.</p>
      <ul>
        <li><strong>Số phiếu:</strong> ${esc(v.voucherNumber)}</li>
        <li><strong>Người ${action}:</strong> ${esc(requesterName || v.employee || '')}</li>
        <li><strong>Thời gian xác nhận:</strong> ${when(at)}</li>
        <li><strong>Số tiền:</strong> ${money(v.amount)}</li>
      </ul>
      <p>Quy trình phiếu đã hoàn tất.</p>
      ${SIGN_OFF}`,
  };
}

/** One email per approver listing the vouchers that reached them after a bulk approval. */
export function batchRequest(approver, items) {
  const rows = items.map((v) => `<tr style="border-bottom:1px solid #e2e8f0;">
      <td style="padding:8px 12px;font-weight:600;color:#1e40af;">${esc(v.voucherNumber)}</td>
      <td style="padding:8px 12px;">${esc(v.company)}</td>
      <td style="padding:8px 12px;">${esc(v.employee)}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;">${money(v.amount)}</td>
      <td style="padding:8px 12px;color:#64748b;">${esc(v.description)}</td></tr>`).join('');
  return {
    to: approver.email,
    subject: `[PHÊ DUYỆT HÀNG LOẠT] ${items.length} phiếu cần duyệt - ${approver.label || 'Người duyệt'}`,
    html: `
    <div style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:24px;">
      <div style="background:#1e40af;color:white;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:1.25rem;">📋 Yêu cầu phê duyệt hàng loạt</h2>
        <p style="margin:8px 0 0;opacity:0.85;">Kính gửi ${esc(approver.name || approver.email)}${approver.label ? ` (${esc(approver.label)})` : ''}</p>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;padding:20px 24px;">
        <p>Có <strong>${items.length} phiếu</strong> đang chờ Anh/Chị phê duyệt:</p>
        <table style="width:100%;border-collapse:collapse;background:white;border:1px solid #e2e8f0;margin:16px 0;">
          <thead><tr style="background:#f1f5f9;font-size:0.8rem;text-transform:uppercase;color:#64748b;">
            <th style="padding:10px 12px;text-align:left;">Số phiếu</th><th style="padding:10px 12px;text-align:left;">Công ty</th>
            <th style="padding:10px 12px;text-align:left;">Nhân viên</th><th style="padding:10px 12px;text-align:right;">Số tiền</th>
            <th style="padding:10px 12px;text-align:left;">Mô tả</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="text-align:center;margin:24px 0;">${btn(`${baseUrl()}/voucher.html`, `🔐 Đăng nhập để duyệt (${items.length} phiếu)`, '#16a34a')}</div>
        <p style="font-size:0.85rem;color:#64748b;text-align:center;">Duyệt từng phiếu hoặc chọn duyệt hàng loạt sau khi đăng nhập (cần chữ ký).</p>
      </div>
    </div>`,
  };
}

/** Daily reminder (GAS sendReminderEmails): the voucher is due tomorrow and still waits for this approver. */
export function reminder(v, approver, dueLabel, status) {
  const url = `${baseUrl()}/voucher.html?approveVoucher=${encodeURIComponent(v.voucherNumber)}`;
  return {
    to: approver.email,
    subject: `[NHẮC NHỞ] Phiếu ${v.voucherNumber} sắp đến hạn`,
    html: `
          <p>Kính gửi ${esc(approver.name || 'Anh/Chị')},</p>
          <p>Nhắc nhở: Phiếu <strong>${esc(v.voucherNumber)}</strong> đang chờ phê duyệt của Anh/Chị và sẽ đến hạn vào <strong>ngày mai (${esc(dueLabel)})</strong>.</p>
          <ul>
            <li><strong>Loại phiếu:</strong> ${esc(v.voucherType)}</li>
            <li><strong>Nhân viên:</strong> ${esc(v.employee)}</li>
            <li><strong>Số tiền:</strong> ${money(v.amount)}</li>
            <li><strong>Trạng thái:</strong> ${esc(status)}</li>
          </ul>
          <p>Vui lòng xem xét và phê duyệt trước hạn:</p>
          <p><a href="${esc(url)}" style="background:#f59e0b;color:white;padding:10px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:500;">🔔 Xem và phê duyệt phiếu</a></p>
          ${SIGN_OFF}`,
  };
}
