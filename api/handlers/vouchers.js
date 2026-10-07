// api/handlers/vouchers.js — Voucher actions on Postgres, same request/response
// contract as Google Apps Script (TLCG_CASH_BACKEND.gs), driven by the
// approval-flow engine. Active only when PG_WORKFLOWS includes "vouchers".
//
// Contract notes (see docs/superpowers/plans/2026-10-07-vouchers-on-postgres.md):
// - The page builds the voucher number and the first approver email; we keep
//   its wording when the first step has a single approver.
// - Signatures are checked in the browser (perceptual hash); approve requires
//   signatureVerification.verified === true, as in GAS.
// - Emails are queued only after the transaction commits.
import pool from '../../db/pool.js';
import { publishEvent } from './sse.js';
import { queueMail } from './email-queue.js';
import { buildPlan, applyApproval, applyRejection, pendingStep } from '../lib/approval/engine.js';
import { getActiveFlow } from '../lib/approval/flows-repo.js';
import { legacyCompanyApprovers, statusText, STATUS } from '../lib/vouchers/compat.js';
import { approvalRequest, progressUpdate, finalApproved, rejected, acknowledged, batchRequest, baseUrl } from '../lib/vouchers/emails.js';
import { summarize } from '../lib/vouchers/summary.js';
import { callerFromRequest, requireLogin } from '../lib/auth-caller.js';
import {
  toAmount, findCompany, employeesByEmail, lockVoucher, planOf, voucherView, saveState, appendHistory, audit,
} from '../lib/vouchers/repo.js';

// ── Messages (GAS MSG_ table, vi / en) ───────────────────────
const MSG = {
  vi: {
    voucherAlreadySubmitted: 'Phiếu này đã được gửi trước đó (số phiếu: {0}). Vui lòng kiểm tra lại lịch sử phiếu.',
    missingRecipient: 'Thiếu người nhận',
    missingVoucherNo: 'Thiếu số phiếu',
    voucherNotFound: 'Không tìm thấy phiếu: ',
    approverInfoNotFound: 'Không tìm thấy thông tin người phê duyệt.',
    alreadyApprovedByYouCash: 'Bạn đã phê duyệt phiếu này rồi.',
    voucherRejectedCannotApprove: 'Phiếu này đã bị từ chối. Không thể phê duyệt.',
    needApproveSignature: 'Vui lòng tải lên chữ ký trước khi phê duyệt',
    missingSigAuthAdmin: 'Thiếu dữ liệu xác thực chữ ký. Vui lòng thử lại hoặc liên hệ quản trị viên.',
    missingSigAuthRetry: 'Thiếu dữ liệu xác thực chữ ký. Vui lòng thử lại.',
    needRejectReason: 'Vui lòng nhập lý do từ chối',
    rejecterInfoNotFound: 'Không tìm thấy thông tin người từ chối.',
    alreadyRejected: 'Phiếu này đã được từ chối trước đó.',
    needAckSignature: 'Vui lòng tải lên chữ ký xác nhận',
    voucherNotFullyApproved: 'Phiếu chưa được duyệt hoàn toàn.',
    voucherAlreadyAcknowledged: 'Phiếu này đã được xác nhận nhận tiền rồi.',
    noVoucherSelected: 'Không có phiếu nào được chọn.',
    missingApproverInfo: 'Thiếu thông tin người duyệt.',
    alreadyFullyApproved: 'Phiếu đã được duyệt hoàn toàn.',
    companyNotFound: 'Không tìm thấy công ty trong Dữ liệu gốc: ',
    flowProblems: 'Chưa thể gửi phiếu: {0} Vui lòng liên hệ quản trị viên để cập nhật Dữ liệu gốc.',
  },
  en: {
    voucherAlreadySubmitted: 'This voucher was already submitted (voucher no: {0}). Please check the voucher history.',
    missingRecipient: 'Missing recipient',
    missingVoucherNo: 'Missing voucher number',
    voucherNotFound: 'Voucher not found: ',
    approverInfoNotFound: 'Approver information not found.',
    alreadyApprovedByYouCash: 'You have already approved this voucher.',
    voucherRejectedCannotApprove: 'This voucher was rejected and cannot be approved.',
    needApproveSignature: 'Please upload your signature before approving',
    missingSigAuthAdmin: 'Missing signature verification data. Please try again or contact an administrator.',
    missingSigAuthRetry: 'Missing signature verification data. Please try again.',
    needRejectReason: 'Please enter a rejection reason',
    rejecterInfoNotFound: 'Rejecter information not found.',
    alreadyRejected: 'This voucher has already been rejected.',
    needAckSignature: 'Please upload a confirmation signature',
    voucherNotFullyApproved: 'This voucher is not fully approved yet.',
    voucherAlreadyAcknowledged: 'This voucher has already been acknowledged as received.',
    noVoucherSelected: 'No vouchers selected.',
    missingApproverInfo: 'Missing approver information.',
    alreadyFullyApproved: 'This voucher is already fully approved.',
    companyNotFound: 'Company not found in Master Data: ',
    flowProblems: 'Cannot submit yet: {0} Please ask an administrator to update Master Data.',
  },
};
const msg = (lang, key, arg) => {
  const t = (MSG[lang === 'en' ? 'en' : 'vi'][key]) || MSG.vi[key] || key;
  return arg === undefined ? t : t.replace('{0}', arg);
};
const fail = (res, message) => res.json({ success: false, message });
const now = () => new Date().toISOString();
const lower = (s) => String(s || '').trim().toLowerCase();

/** GAS approve/bulk signature checks. Returns an error message or ''. */
function signatureProblem(lang, signature, verification, bulk = false) {
  if (!signature || !String(signature).trim()) return msg(lang, 'needApproveSignature');
  if (!verification || typeof verification !== 'object') return msg(lang, bulk ? 'missingSigAuthRetry' : 'missingSigAuthAdmin');
  if (verification.verified !== true) {
    return 'Chữ ký không hợp lệ. Lý do: ' + (verification.reason || 'unknown') + '. ' +
      (verification.similarity ? 'Độ tương đồng: ' + verification.similarity + '% (yêu cầu: 75%)' : 'Vui lòng sử dụng chữ ký mẫu đã đăng ký.');
  }
  return '';
}

/** "file.pdf (1.20 MB)\nhttps://…" lines, as GAS wrote them into the attachments column. */
function attachmentLines(files) {
  const seen = new Set();
  return (files || []).filter((f) => f && f.fileUrl && !seen.has(f.fileName) && seen.add(f.fileName)).map((f) => {
    const size = f.fileSize ? ' (' + (f.fileSize / (1024 * 1024)).toFixed(2) + ' MB)' : '';
    return `${f.fileName}${size}\n${f.fileUrl}`;
  }).join('\n\n');
}

// Role → Master Company signature column (the sample each role holder signs against)
const ROLE_SAMPLE = { chief_accountant: 'accountant_sig_url', legal_rep: 'legal_rep_sig_url', treasurer: 'treasurer_sig_url' };
const EMPLOYEE_SAMPLE_HEADERS = ['Signature', 'Chữ ký', 'Chu_ky', 'employee_signature', 'Signature_URL'];

/**
 * The sample signature an approver must match: their role's sample on the
 * voucher's company (Master Company), else a Signature column on their Master
 * Employee row. { url, from } — url '' when none is registered.
 */
async function sampleSignatureFor(db, companyId, entries, email) {
  const company = companyId ? (await db.query(`SELECT * FROM companies WHERE id = $1`, [companyId])).rows[0] : null;
  for (const a of entries) {
    const col = ROLE_SAMPLE[a.role];
    if (company && col && company[col]) return { url: company[col], from: a.label };
  }
  const emp = (await db.query(`SELECT extra FROM employees WHERE LOWER(email) = $1`, [email])).rows[0];
  const extra = (emp && emp.extra) || {};
  const hit = EMPLOYEE_SAMPLE_HEADERS.find((h) => String(extra[h] || '').trim());
  return hit ? { url: String(extra[hit]).trim(), from: 'Master Employee' } : { url: '', from: '' };
}
const NO_SAMPLE = {
  vi: 'Chưa có chữ ký mẫu của bạn. Vui lòng nhờ quản trị viên bổ sung trong Dữ liệu gốc (Nhân viên › Signature).',
  en: 'No sample signature is registered for you. Ask an administrator to add it in Master Data (Employees › Signature).',
};

/**
 * The acting user: the login token's user when present (the email in the body
 * must then match it); without a token, the body's email unless
 * VOUCHER_REQUIRE_LOGIN is on. Returns { email, caller } or sends the error.
 */
async function resolveActor(req, res, claimed, lang) {
  const caller = await callerFromRequest(req);
  const want = lower(claimed);
  if (caller) {
    if (want && want !== caller.email) {
      fail(res, lang === 'en'
        ? `You are signed in as ${caller.email} and cannot act for ${want}.`
        : `Bạn đang đăng nhập bằng ${caller.email}, không thể thao tác thay ${want}.`);
      return null;
    }
    return { email: caller.email, caller };
  }
  if (requireLogin()) {
    res.status(401).json({ success: false, message: lang === 'en' ? 'Please sign in again.' : 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
    return null;
  }
  return { email: want, caller: null };
}

const stepWaiting = (plan) => {
  const i = pendingStep(plan);
  return i < 0 ? [] : plan.steps[i].approvers.filter((a) => a.status !== 'approved');
};
const nameList = (approvers) => approvers.map((a) => a.name || a.email).join(', ');

// ── sendApprovalEmail (submit) ───────────────────────────────

export async function handleVoucherSubmit(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const email = b.email || {};
  const reqMail = b.requesterEmail || null;
  const v = b.voucher || {};
  if (!email.to) return fail(res, msg(lang, 'missingRecipient'));
  const actor = await resolveActor(req, res, '', lang);
  if (!actor) return;
  const voucherNo = String(v.voucherNumber || 'AUTO-' + Date.now()).trim();

  const client = await pool.connect();
  let plan, company, view;
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT 1 FROM vouchers WHERE voucher_number = $1`, [voucherNo]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo)); }

    company = await findCompany(client, v.company, v.companyKey);
    if (!company) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'companyNotFound') + (v.company || '')); }
    const flow = await getActiveFlow(client, 'voucher', company.id);
    const built = buildPlan({ flow, company, employeesByEmail: await employeesByEmail(client), workflow: 'voucher' });
    if (built.problems.length) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'flowProblems', built.problems.join(' '))); }
    plan = built.plan;

    const submittedAt = now();
    const meta = {
      requesterSignature: v.requesterSignature || '', reason: v.reason || '', voucherDate: v.voucherDate || '',
      department: v.department || '', payeeName: v.payeeName || '', amountInWords: v.amountInWords || '',
      expenseItems: v.expenseItems || [], submittedAt, approvalFlow: { id: flow.id, version: flow.version, source: flow.source },
      submittedByEmail: actor.email || lower(v.requestorEmail),
    };
    const attachments = attachmentLines(v.files);
    const description = v.reason || v.description || '';
    const { rows } = await client.query(
      `INSERT INTO vouchers (voucher_number, voucher_type, company_id, company_name, company_key, employee_name,
         requestor_email, submitted_by, amount, status, due_date, description, attachments, metadata,
         submitted_at, last_action, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$14,$15,'Gửi phê duyệt') RETURNING *`,
      [voucherNo, v.voucherType || '', company.id, company.company_name, company.company_key || v.companyKey || '',
        v.employee || '', lower(v.requestorEmail), v.submittedBy || v.employee || '', toAmount(v.amount),
        STATUS.submitted, v.dueDate || '', description, attachments, submittedAt, 'Đã nộp phiếu']
    );
    const row = rows[0];
    await saveState(client, row, { plan, meta, status: STATUS.submitted, lastAction: 'Đã nộp phiếu' });
    view = voucherView(row);
    await appendHistory(client, {
      ...view, status: STATUS.submitted, action: 'Đã nộp phiếu', attachments, note: 'Gửi phê duyệt',
      approverEmail: plan.steps[0].approvers.map((a) => a.email).join(','), meta,
    });
    await audit(client, { docNo: voucherNo, company: company.company_name, action: 'Submit', role: 'requester',
      actorEmail: lower(v.requestorEmail), actorName: v.employee, newStatus: STATUS.submitted, note: description });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo));
    console.error('[Vouchers] submit error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }

  // Emails after commit: step 1 approvers (all of them), then the requester
  const first = plan.steps[0].approvers;
  const pageTo = String(email.to).split(',').map(lower).filter(Boolean);
  for (const a of first) {
    if (first.length === 1 && pageTo.includes(a.email) && email.subject && email.body) {
      await queueMail({ to: a.email, cc: email.cc, replyTo: email.replyTo, subject: email.subject, html: email.body });
    } else {
      await queueMail({ ...approvalRequest(view, plan, a), replyTo: email.replyTo });
    }
  }
  if (reqMail && reqMail.to) {
    const link = `${baseUrl()}/voucher.html?viewStatus=${encodeURIComponent(voucherNo)}`;
    const html = String(reqMail.body || '').replace(/đã được gửi phê duyệt/g,
      `đã được gửi phê duyệt. Đã gửi email đến ${nameList(first)} để bắt đầu phê duyệt.`) +
      `<p style="margin-top: 15px;"><a href="${link}" style="background: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">🔍 Xem trạng thái phê duyệt</a></p>`;
    await queueMail({ to: reqMail.to, replyTo: email.replyTo, subject: reqMail.subject || '[THÔNG BÁO] Phiếu đã được gửi phê duyệt', html });
  }
  await publishEvent('voucher:submitted', { voucherNumber: voucherNo, status: STATUS.submitted });
  return res.json({ success: true, message: 'Đã gửi yêu cầu phê duyệt thành công' });
}

// ── Approve (shared by approveVoucher and bulkApprove) ───────

/**
 * Approve one voucher inside its own transaction. Returns
 * { ok, error?, view, plan, stepDone, finished } — emails are the caller's job.
 */
async function approveOne({ voucherNumber, approverEmail, approverName, signature, verification, lang }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherNotFound') + voucherNumber }; }
    const plan = planOf(row);
    const email = lower(approverEmail);
    const mine = plan.steps.flatMap((s) => s.approvers).filter((a) => a.email === email);
    if (!mine.length) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'approverInfoNotFound') }; }
    if (plan.status === 'rejected') { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherRejectedCannotApprove') }; }
    if (plan.status === 'approved') {
      await client.query('ROLLBACK');
      return { ok: false, error: msg(lang, mine.every((a) => a.status === 'approved') ? 'alreadyApprovedByYouCash' : 'alreadyFullyApproved') };
    }

    // Approved every entry they have and the plan moved on → GAS "already approved"
    if (mine.every((a) => a.status === 'approved')) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') }; }

    // No registered sample = nothing to verify against: refuse (GAS let these through as "no_sample")
    const open = pendingStep(plan);
    const pendingMine = open >= 0 ? plan.steps[open].approvers.filter((a) => a.email === email && a.status !== 'approved') : [];
    if (pendingMine.length && !(await sampleSignatureFor(client, row.company_id, pendingMine, email)).url) {
      await client.query('ROLLBACK');
      return { ok: false, error: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
    }

    let result;
    const at = now();
    try {
      result = applyApproval(plan, email, { at, signature });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'ALREADY_APPROVED') return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') };
      if (e.code === 'NOT_YOUR_TURN') {
        const order = plan.steps.map((s) => s.approvers.map((a) => a.label || a.name).join(' + ')).join(' → ');
        return { ok: false, error: `Vui lòng đợi ${nameList(stepWaiting(plan))} phê duyệt trước. Thứ tự phê duyệt: ${order}.` };
      }
      throw e;
    }

    const next = result.plan;
    const meta = row.metadata || {};
    const ca = legacyCompanyApprovers(next);
    // The legacy key of the entry approved just now (same person may sit in two steps)
    const key = Object.keys(ca.approvers).find((k) => ca.approvers[k].email === email && ca.approvers[k].approvedAt === at) || '';
    const name = approverName || mine[0].name || email;
    // Role-specific fields read by the print templates (GAS names)
    if (key === 'accountant') { meta.accountantSignature = signature; meta.accountantName = name; }
    if (key === 'legalRep') { meta.legalRepSignature = signature; meta.legalRepName = name; }
    if (key === 'treasurer') { meta.treasurerSignature = signature; meta.treasurerName = name; meta.approverSignature = signature; }
    meta.signatureVerification = meta.signatureVerification || {};
    meta.signatureVerification[key || email] = { verified: verification.verified, similarity: verification.similarity, reason: verification.reason, verifiedAt: now() };
    meta.approvedBy = email;

    const status = statusText(next);
    const view = voucherView(row);
    const lastAction = 'Duyệt bởi ' + name;
    await saveState(client, row, { plan: next, meta, status, lastAction });
    const label = mine[0].label || 'Người duyệt';
    await appendHistory(client, {
      ...view, status, action: lastAction, approverEmail: email, approvedAt: at, meta,
      note: result.finished ? `Tất cả ${next.steps.length} bước phê duyệt đã duyệt` : `Đã duyệt bởi ${label} (${ca.approvalProgress})`,
    });
    await audit(client, { docNo: voucherNumber, company: row.company_name, action: 'Approve', role: key, actorEmail: email,
      actorName: name, prevStatus: row.status, newStatus: status, extra: { signatureUploaded: !!signature } });
    await client.query('COMMIT');
    await publishEvent('voucher:approved', { voucherNumber, status, isFinal: result.finished });
    return { ok: true, view, plan: next, stepDone: result.stepDone, finished: result.finished };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function handleVoucherApprove(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const v = b.voucher || {};
  if (!v.voucherNumber) return fail(res, msg(lang, 'missingVoucherNo'));
  const sigErr = signatureProblem(lang, v.approverSignature, v.signatureVerification);
  if (sigErr) return fail(res, sigErr);
  const actor = await resolveActor(req, res, v.approverEmail, lang);
  if (!actor) return;
  try {
    const r = await approveOne({ voucherNumber: v.voucherNumber, approverEmail: actor.email, approverName: v.approverName,
      signature: v.approverSignature, verification: v.signatureVerification, lang });
    if (!r.ok) return fail(res, r.error);
    if (r.finished) {
      for (const m of finalApproved(r.view, r.plan)) await queueMail(m);
      return res.json({ success: true, message: 'Đã phê duyệt thành công. Phiếu đã được duyệt hoàn toàn.' });
    }
    const waiting = stepWaiting(r.plan);
    if (r.stepDone) for (const a of waiting) await queueMail(approvalRequest(r.view, r.plan, a));
    await queueMail(progressUpdate(r.view, r.plan));
    return res.json({
      success: true,
      message: r.stepDone
        ? `Đã phê duyệt thành công. Đã gửi email đến ${nameList(waiting)} để tiếp tục phê duyệt.`
        : `Đã phê duyệt thành công. Đang chờ ${nameList(waiting)} cùng duyệt bước này.`,
    });
  } catch (err) {
    console.error('[Vouchers] approve error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}

export async function handleVoucherBulkApprove(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const numbers = Array.isArray(b.voucherNumbers) ? b.voucherNumbers : [];
  if (!numbers.length) return fail(res, msg(lang, 'noVoucherSelected'));
  if (!b.approverEmail) return fail(res, msg(lang, 'missingApproverInfo'));
  const sigErr = signatureProblem(lang, b.approverSignature, b.signatureVerification, true);
  if (sigErr) return fail(res, sigErr);
  const actor = await resolveActor(req, res, b.approverEmail, lang);
  if (!actor) return;

  const approved = [];
  const failed = [];
  const nextByApprover = new Map(); // email → { approver, items[] }
  for (const no of numbers) {
    try {
      const r = await approveOne({ voucherNumber: no, approverEmail: actor.email, approverName: b.approverName,
        signature: b.approverSignature, verification: b.signatureVerification, lang });
      if (!r.ok) { failed.push({ voucherNumber: no, error: r.error }); continue; }
      approved.push(no);
      if (r.finished) {
        for (const m of finalApproved(r.view, r.plan)) await queueMail(m);
      } else if (r.stepDone) {
        for (const a of stepWaiting(r.plan)) {
          if (!nextByApprover.has(a.email)) nextByApprover.set(a.email, { approver: a, items: [] });
          nextByApprover.get(a.email).items.push(r.view);
        }
      }
    } catch (err) {
      console.error('[Vouchers] bulk approve error', no, err.message);
      failed.push({ voucherNumber: no, error: 'Lỗi: ' + err.message });
    }
  }
  for (const { approver, items } of nextByApprover.values()) await queueMail(batchRequest(approver, items));
  return res.json({
    success: true,
    message: 'Đã duyệt ' + approved.length + ' phiếu.' + (failed.length ? ' Thất bại: ' + failed.length + '.' : '') +
      (nextByApprover.size ? ' Đã gửi email bước tiếp theo.' : ''),
    data: { approved, failed },
  });
}

// ── Reject ───────────────────────────────────────────────────

export async function handleVoucherReject(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const v = b.voucher || {};
  if (!v.voucherNumber) return fail(res, msg(lang, 'missingVoucherNo'));
  const reason = String(v.rejectReason || '').trim();
  if (!reason) return fail(res, msg(lang, 'needRejectReason'));
  const actor = await resolveActor(req, res, v.approverEmail, lang);
  if (!actor) return;

  const client = await pool.connect();
  let view, next;
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, v.voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherNotFound') + v.voucherNumber); }
    const plan = planOf(row);
    if (plan.status === 'rejected') { await client.query('ROLLBACK'); return fail(res, msg(lang, 'alreadyRejected')); }
    if (plan.status === 'approved') { await client.query('ROLLBACK'); return fail(res, msg(lang, 'alreadyFullyApproved')); }
    try {
      next = applyRejection(plan, actor.email, { at: now(), reason, anyApprover: true });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'NOT_IN_PLAN') return fail(res, msg(lang, 'rejecterInfoNotFound'));
      throw e;
    }
    const email = actor.email;
    const who = plan.steps.flatMap((s) => s.approvers).find((a) => a.email === email);
    const meta = row.metadata || {};
    view = voucherView(row);
    const lastAction = 'Từ chối bởi ' + (who.name || email);
    await saveState(client, row, { plan: next, meta, status: STATUS.rejected, lastAction });
    await appendHistory(client, {
      ...view, status: STATUS.rejected, action: lastAction, approverEmail: email, meta, rejectionReason: reason,
      note: `Từ chối bởi ${who.label || who.name || email}\nLý do: ${reason}`,
    });
    await audit(client, { docNo: v.voucherNumber, company: row.company_name, action: 'Reject', role: who.role || '',
      actorEmail: email, actorName: who.name, prevStatus: row.status, newStatus: STATUS.rejected, note: reason });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Vouchers] reject error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }
  await queueMail(rejected(view, next));
  await publishEvent('voucher:rejected', { voucherNumber: v.voucherNumber, status: STATUS.rejected });
  return res.json({ success: true, message: 'Đã từ chối phiếu' });
}

// ── Acknowledge receipt ──────────────────────────────────────

export async function handleVoucherAcknowledge(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const voucherNumber = String(b.voucherNumber || '');
  if (!voucherNumber) return fail(res, msg(lang, 'missingVoucherNo'));
  if (!b.requesterSignature) return fail(res, msg(lang, 'needAckSignature'));
  const actor = await resolveActor(req, res, '', lang);
  if (!actor) return;

  const client = await pool.connect();
  let view, plan;
  const at = now();
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherNotFound') + voucherNumber); }
    plan = planOf(row);
    if (plan.status !== 'approved') { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherNotFullyApproved')); }
    const meta = row.metadata || {};
    if (meta.acknowledgedSignature) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherAlreadyAcknowledged')); }
    // Signed in: only the voucher's requester (or an admin) confirms the money
    if (actor.caller && !actor.caller.isAdmin && lower(row.requestor_email) && actor.caller.email !== lower(row.requestor_email)) {
      await client.query('ROLLBACK');
      return fail(res, lang === 'en' ? 'Only the requester can confirm receipt.' : 'Chỉ người đề nghị mới xác nhận nhận tiền.');
    }
    const isThu = String(row.voucher_type || '').toUpperCase().includes('THU');
    const requesterEmail = actor.caller ? actor.caller.email : lower(b.requesterEmail);
    meta.acknowledgedSignature = b.requesterSignature;
    meta.requesterName = b.requesterName || row.employee_name || '';
    meta.acknowledgedAt = at;
    meta.acknowledgedBy = requesterEmail;
    const lastAction = isThu ? 'Đã xác nhận thu tiền' : 'Đã xác nhận nhận tiền';
    await client.query(
      `UPDATE vouchers SET metadata = $1, status = $2, last_action = $3, acknowledged_sig = $4,
              acknowledged_at = $5, acknowledged_by = $6, updated_at = NOW() WHERE id = $7`,
      [JSON.stringify(meta), STATUS.received, lastAction, b.requesterSignature, at, requesterEmail, row.id]
    );
    view = voucherView(row);
    await appendHistory(client, {
      ...view, status: STATUS.received, action: lastAction, approverEmail: requesterEmail, approvedAt: at, meta,
      note: (isThu ? 'Người thu tiền đã xác nhận: ' : 'Người nhận tiền đã xác nhận: ') + (b.requesterName || requesterEmail),
      acknowledgedAt: at, acknowledgedBy: requesterEmail, signatureUrl: b.requesterSignature,
    });
    await audit(client, { docNo: voucherNumber, company: row.company_name, action: 'Acknowledge', role: 'requester',
      actorEmail: requesterEmail, actorName: b.requesterName, prevStatus: row.status, newStatus: STATUS.received });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Vouchers] acknowledge error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }
  await queueMail(acknowledged(view, plan, { requesterName: b.requesterName, requesterEmail: b.requesterEmail, at }));
  await publishEvent('voucher:acknowledged', { voucherNumber, status: STATUS.received });
  return res.json({ success: true, message: 'Đã xác nhận nhận tiền thành công. Quy trình phiếu hoàn tất.' });
}

// ── Reads ────────────────────────────────────────────────────

/**
 * getVoucherSummary { callerEmail|userEmail|email, isAdmin } — GAS shape.
 * Hardening: isAdmin from the page is honoured only when that email is an
 * active admin in Master Data (GAS trusted the flag as sent).
 */
export async function handleVoucherSummary(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const caller = await callerFromRequest(req);
  if (!caller && requireLogin()) return res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
  // Signed in: the token's user, never the emails / admin flag sent by the page
  const email = caller ? caller.email : lower(src.callerEmail || src.userEmail || src.email);
  const wantsAdmin = caller ? caller.isAdmin : (src.isAdmin === true || src.isAdmin === 'true');
  try {
    const [admin, roles] = await Promise.all([
      email && wantsAdmin
        ? pool.query(`SELECT 1 FROM employees WHERE LOWER(email) = $1 AND status = 'active' AND is_admin`, [email]).then((r) => r.rows.length > 0)
        : false,
      email
        ? pool.query(`SELECT
            bool_or(LOWER(accountant_email) = $1) AS accountant,
            bool_or(LOWER(legal_rep_email) = $1)  AS legal,
            bool_or(LOWER(treasurer_email) = $1)  AS treasurer
           FROM companies`, [email]).then((r) => r.rows[0])
        : {},
    ]);
    const callerApproverRole = roles.accountant ? 'accountant' : roles.legal ? 'legalRep' : roles.treasurer ? 'treasurer' : 'submitter';
    const cols = `voucher_number, voucher_type, company_name, employee_name, requestor_email, amount, status, last_action,
                  updated_at, progress_done, progress_total, approver_emails, pending_emails, current_approver`;
    const { rows } = admin
      ? await pool.query(`SELECT ${cols} FROM vouchers`)
      : await pool.query(`SELECT ${cols} FROM vouchers WHERE LOWER(requestor_email) = $1 OR $1 = ANY(approver_emails)`, [email]);
    return res.json({ success: true, message: 'Thành công', data: summarize(rows, { email, isAdmin: admin }, callerApproverRole) });
  } catch (err) {
    console.error('[Vouchers] summary error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}

/**
 * May this caller open one voucher? Admin, the requester, or anyone in its
 * flow. Without a token: allowed unless VOUCHER_REQUIRE_LOGIN (GAS parity).
 * Sends the error and returns false when not allowed.
 */
async function mayView(req, res, row) {
  const caller = await callerFromRequest(req);
  if (!caller) {
    if (!requireLogin()) return true;
    res.status(401).json({ success: false, message: 'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.' });
    return false;
  }
  if (!row || caller.isAdmin || lower(row.requestor_email) === caller.email || (row.approver_emails || []).includes(caller.email)) return true;
  res.status(403).json({ success: false, message: 'Bạn không có quyền xem phiếu này.' });
  return false;
}

/** getVoucherHistory { voucherNumber } — every sheet-style row, newest first (GAS: data is the array). */
export async function handleVoucherHistory(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const no = String(src.voucherNumber || '').trim();
  if (!no) return fail(res, 'Thiếu voucher number');
  try {
    const owner = (await pool.query(`SELECT requestor_email, approver_emails FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
    if (!(await mayView(req, res, owner))) return;
    const { rows } = await pool.query(
      `SELECT * FROM voucher_history WHERE voucher_number = $1 ORDER BY submitted_at DESC, id DESC`, [no]);
    return res.json({
      success: true,
      message: 'Thành công',
      data: rows.map((h) => ({
        voucherNumber: h.voucher_number, voucherType: h.voucher_type, company: h.company, companyKey: h.company_key,
        employee: h.employee, requestorEmail: h.requestor_email, submittedBy: h.submitted_by, timestamp: h.submitted_at,
        amount: Number(h.amount), status: h.status, dueDate: h.due_date, action: h.action, attachments: h.attachments,
        description: h.description, note: h.note, meta: h.metadata || {}, approverEmail: h.approver_email,
        approvedAt: h.approved_at || '',
      })),
    });
  } catch (err) {
    console.error('[Vouchers] history error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}

/** getApprovalStatus { voucherNumber } — GAS shape, plus approvalPlan for step-aware pages. */
export async function handleVoucherApprovalStatus(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const no = String(src.voucherNumber || '').trim();
  if (!no) return fail(res, msg(src.lang, 'missingVoucherNo'));
  try {
    const { rows } = await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no]);
    const row = rows[0];
    if (!row) return fail(res, msg(src.lang, 'voucherNotFound') + no);
    if (!(await mayView(req, res, row))) return;
    const plan = planOf(row);
    const ca = legacyCompanyApprovers(plan);
    const current = ca.currentApprover ? ca.approvers[ca.currentApprover] : null;
    return res.json({
      success: true,
      message: 'Thành công',
      data: {
        voucherNumber: no,
        overallStatus: ca.overallStatus,
        displayStatus: ca.displayStatus,
        approvalProgress: ca.approvalProgress,
        currentApprover: ca.currentApprover,
        currentApproverName: current ? current.name : null,
        approvers: ca.approvers,
        requesterEmail: row.requestor_email || '',
        submittedAt: row.submitted_at || row.created_at,
        lastUpdatedAt: new Date().toISOString(),
        approvalPlan: plan,
        acknowledged: !!(row.metadata && row.metadata.acknowledgedSignature),
      },
    });
  } catch (err) {
    console.error('[Vouchers] status error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}


/**
 * getApprovalContext { voucherNumber } — for the signed-in user: the voucher,
 * its plan, my entries on the current step, whether I can approve / reject,
 * and the sample signature to verify against (role sample from Master
 * Company, else a "Signature" column on my Master Employee row).
 */
export async function handleVoucherApprovalContext(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const lang = src.lang;
  const no = String(src.voucherNumber || '').trim();
  if (!no) return fail(res, msg(lang, 'missingVoucherNo'));
  const caller = await callerFromRequest(req);
  if (!caller) return res.status(401).json({ success: false, message: lang === 'en' ? 'Please sign in to approve.' : 'Vui lòng đăng nhập để phê duyệt.' });
  try {
    const row = (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [no])).rows[0];
    if (!row) return fail(res, msg(lang, 'voucherNotFound') + no);
    if (!(await mayView(req, res, row))) return;
    const plan = planOf(row);
    const open = pendingStep(plan);
    const inPlan = plan.steps.some((st) => st.approvers.some((a) => a.email === caller.email));
    const myEntries = open >= 0 ? plan.steps[open].approvers.filter((a) => a.email === caller.email && a.status !== 'approved') : [];

    let reason = '';
    if (plan.status === 'rejected') reason = msg(lang, 'voucherRejectedCannotApprove');
    else if (plan.status === 'approved') reason = msg(lang, 'alreadyFullyApproved');
    else if (!inPlan) reason = msg(lang, 'approverInfoNotFound');
    else if (!myEntries.length) {
      const done = plan.steps.flatMap((st) => st.approvers).filter((a) => a.email === caller.email).every((a) => a.status === 'approved');
      reason = done ? msg(lang, 'alreadyApprovedByYouCash') : `Chưa đến lượt bạn. Đang chờ: ${nameList(stepWaiting(plan))}.`;
    }

    // Sample signature: first my role sample on this company, else my own registered one
    let sampleSignatureUrl = '';
    let sampleFrom = '';
    if (myEntries.length) {
      ({ url: sampleSignatureUrl, from: sampleFrom } = await sampleSignatureFor(pool, row.company_id, myEntries, caller.email));
      if (!sampleSignatureUrl) reason = NO_SAMPLE[lang === 'en' ? 'en' : 'vi'];
    }

    return res.json({
      success: true,
      message: 'Thành công',
      data: {
        voucher: { ...voucherView(row), status: row.status, attachments: row.attachments, meta: { ...(row.metadata || {}), approvalPlan: undefined } },
        approvalPlan: plan,
        me: { email: caller.email, name: caller.name, isAdmin: caller.isAdmin },
        myEntries,
        canApprove: !reason,
        canReject: plan.status !== 'approved' && plan.status !== 'rejected' && inPlan,
        reason,
        sampleSignatureUrl,
        sampleFrom,
      },
    });
  } catch (err) {
    console.error('[Vouchers] context error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}
