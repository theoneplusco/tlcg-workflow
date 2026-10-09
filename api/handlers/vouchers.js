// api/handlers/vouchers.js — Voucher actions on Postgres, same request/response
// contract as Google Apps Script (TLCG_CASH_BACKEND.gs), driven by the
// approval-flow engine. Active only when PG_WORKFLOWS includes "vouchers".
//
// Contract notes (see docs/superpowers/plans/2026-10-07-vouchers-on-postgres.md):
// - The page builds the voucher number and the first approver email; we keep
//   its wording when the first step has a single approver.
// - Approvals on Postgres: the approver re-enters their login password and the server stamps their
//   registered sample signature (decision 2026-10-07, option D; api/lib/approval/step-up.js).
// - Emails are queued only after the transaction commits.
// - Plan 5c: a requester who is also an approver confirms with their password once at submit; their steps are then
//   auto-approved in order, inside the transaction that reaches them (api/lib/approval/self-approval.js).
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
import { enqueue } from '../lib/sheets/outbox.js';
import redis from '../../db/redis.js';
import { confirmPassword, verificationRecord, makeStamper, stampStillCurrent } from '../lib/approval/step-up.js';
import { sampleSignatureFor, NO_SAMPLE } from '../lib/approval/signature-check.js';
import {
  requestConsent, askBody, planChangedBody, sameOwnSteps, planOwnSteps, planOwnOpen, planOwnLeft, consentFor, recordAuto,
  withoutStamps, autoAdvance, doneText, selfEmailHtml, publicAuto,
} from '../lib/approval/self-approval.js';
import {
  historyRecord, currentRecord, voucherSpreadsheetId, HISTORY_TAB, CURRENT_TAB, CURRENT_KEY,
} from '../lib/sheets/voucher-records.js';

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
    voucherDeleted: 'Phiếu này đã bị người đề nghị xóa.',
    deleteNotYours: 'Chỉ người đề nghị hoặc người đã gửi phiếu mới xóa được phiếu này.',
    deleteClosed: 'Phiếu đã kết thúc quy trình, không thể xóa.',
    deleteAlreadyApproved: 'Không thể xóa: phiếu đã được {0} phê duyệt.',
    deleted: 'Đã xóa phiếu {0}.',
  },
  en: {
    voucherAlreadySubmitted: 'This voucher was already submitted (voucher no: {0}). Please check the voucher history.',
    missingRecipient: 'Missing recipient',
    missingVoucherNo: 'Missing voucher number',
    voucherNotFound: 'Voucher not found: ',
    approverInfoNotFound: 'Approver information not found.',
    alreadyApprovedByYouCash: 'You have already approved this voucher.',
    voucherRejectedCannotApprove: 'This voucher was rejected and cannot be approved.',
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
    voucherDeleted: 'This voucher was deleted by its requester.',
    deleteNotYours: 'Only the requester or the person who submitted this voucher can delete it.',
    deleteClosed: 'This voucher has finished its approval flow and cannot be deleted.',
    deleteAlreadyApproved: 'Cannot delete: {0} already approved this voucher.',
    deleted: 'Voucher {0} deleted.',
  },
};
const msg = (lang, key, arg) => {
  const t = (MSG[lang === 'en' ? 'en' : 'vi'][key]) || MSG.vi[key] || key;
  return arg === undefined ? t : t.replace('{0}', arg);
};
const fail = (res, message) => res.json({ success: false, message });
const now = () => new Date().toISOString();
const lower = (s) => String(s || '').trim().toLowerCase();

/** When the voucher was submitted (older rows imported from the Sheet may only have created_at). */
const submittedAtOf = (row) => row.submitted_at || row.created_at;

let warnedNoSheet = false;
/**
 * Queue the Google Sheet copy of one voucher change (same transaction, after the row is locked):
 * the Sheet can lag but never miss or invent a row. `h` is the object given to appendHistory.
 * No VOUCHER_SPREADSHEET_ID → nothing is queued (logged once); there is no default target.
 */
async function mirrorVoucher(client, h, { at, submittedAt, progressDone }) {
  const spreadsheetId = voucherSpreadsheetId();
  if (!spreadsheetId) {
    if (!warnedNoSheet) { warnedNoSheet = true; console.warn('[Vouchers] VOUCHER_SPREADSHEET_ID is not set: voucher changes are not queued for the Google Sheet copy'); }
    return;
  }
  await enqueue(client, { spreadsheetId, tab: HISTORY_TAB, mode: 'append', record: historyRecord(h, at) });
  await enqueue(client, { spreadsheetId, tab: CURRENT_TAB, mode: 'upsert', keyColumn: CURRENT_KEY,
    record: currentRecord(h, { submittedAt, progressDone, at }) });
}


/** "file.pdf (1.20 MB)\nhttps://…" lines, as GAS wrote them into the attachments column. */
function attachmentLines(files) {
  const seen = new Set();
  return (files || []).filter((f) => f && f.fileUrl && !seen.has(f.fileName) && seen.add(f.fileName)).map((f) => {
    const size = f.fileSize ? ' (' + (f.fileSize / (1024 * 1024)).toFixed(2) + ' MB)' : '';
    return `${f.fileName}${size}\n${f.fileUrl}`;
  }).join('\n\n');
}


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

/**
 * The approver for the password step-up: always the signed-in caller (controller decision 2), whatever
 * VOUCHER_REQUIRE_LOGIN says — the lockout counter is keyed on the token's email, never a body field.
 * Returns the actor or sends the error (no token → 401).
 */
async function resolveApprover(req, res, claimed, lang) {
  const actor = await resolveActor(req, res, claimed, lang);
  if (!actor) return null;
  if (!actor.caller) {
    res.status(401).json({ success: false, message: lang === 'en' ? 'Please sign in.' : 'Vui lòng đăng nhập' });
    return null;
  }
  return actor;
}

const stepWaiting = (plan) => {
  const i = pendingStep(plan);
  return i < 0 ? [] : plan.steps[i].approvers.filter((a) => a.status !== 'approved');
};
const nameList = (approvers) => approvers.map((a) => a.name || a.email).join(', ');

// ── sendApprovalEmail (submit) ───────────────────────────────

/** The company, its active voucher flow and the plan it resolves to; { error } in the GAS wording otherwise. */
async function resolvePlan(db, v, lang) {
  const company = await findCompany(db, v.company, v.companyKey);
  if (!company) return { error: msg(lang, 'companyNotFound') + (v.company || '') };
  const flow = await getActiveFlow(db, 'voucher', company.id);
  const built = buildPlan({ flow, company, employeesByEmail: await employeesByEmail(db), workflow: 'voucher' });
  if (built.problems.length) return { error: msg(lang, 'flowProblems', built.problems.join(' ')) };
  return { company, flow, plan: built.plan };
}

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

  // Plan 5c: only the signed-in submitter (token email, never a body email) can consent, for the steps THEY hold —
  // also when filing for another employee (controller decision 1). No token (only while VOUCHER_REQUIRE_LOGIN is
  // off) → no prompt, submitted as today. Asked and checked BEFORE the transaction: the password check and the
  // sample load never run under a lock.
  const me = actor.caller ? actor.caller.email : '';
  let consent = null;
  if (me) {
    const seen = await pool.query(`SELECT 1 FROM vouchers WHERE voucher_number = $1`, [voucherNo]);
    if (seen.rows.length) return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo));
    const pre = await resolvePlan(pool, v, lang);
    if (pre.error) return fail(res, pre.error);
    const sa = await requestConsent({ db: pool, redis, email: me, password: b.selfApprovalPassword, declined: b.selfApprovalDeclined,
      own: planOwnSteps(pre.plan, me), companyId: pre.company.id, round: 0, ref: voucherNo, lang, at: now() });
    if (sa.ask) return res.json(askBody(sa));
    consent = sa.consent;
  }

  const client = await pool.connect();
  let plan, view;
  let auto = [];
  try {
    await client.query('BEGIN');
    const dup = await client.query(`SELECT 1 FROM vouchers WHERE voucher_number = $1`, [voucherNo]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo)); }
    const resolved = await resolvePlan(client, v, lang);
    if (resolved.error) { await client.query('ROLLBACK'); return fail(res, resolved.error); }
    const { company, flow } = resolved;
    plan = resolved.plan;
    if (consent) {
      // The flow or Master Data changed since the prompt: never approve steps the requester did not see
      const fresh = planOwnSteps(plan, me);
      if (!fresh.length) consent = null;
      else if (!sameOwnSteps(fresh, consent.steps)) { await client.query('ROLLBACK'); return res.json(planChangedBody(fresh, lang)); }
    }

    const submittedAt = now();
    const meta = {
      requesterSignature: v.requesterSignature || '', reason: v.reason || '', voucherDate: v.voucherDate || '',
      department: v.department || '', payeeName: v.payeeName || '', amountInWords: v.amountInWords || '',
      expenseItems: v.expenseItems || [], submittedAt, approvalFlow: { id: flow.id, version: flow.version, source: flow.source },
      // The token email whenever signed in; consentFor checks the consent against it (consent implies a token)
      submittedByEmail: actor.email || lower(v.requestorEmail),
      ...(consent ? { selfApproval: consent } : {}),
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
    const idx = await saveState(client, row, { plan, meta, status: STATUS.submitted, lastAction: 'Đã nộp phiếu' });
    view = voucherView(row);
    const hist = {
      ...view, status: STATUS.submitted, action: 'Đã nộp phiếu', attachments, note: 'Gửi phê duyệt',
      approverEmail: plan.steps[0].approvers.map((a) => a.email).join(','), meta: withoutStamps(meta),
    };
    await appendHistory(client, hist);
    await mirrorVoucher(client, hist, { at: submittedAt, submittedAt, progressDone: idx.done });
    await audit(client, { docNo: voucherNo, company: company.company_name, action: 'Submit', role: 'requester',
      actorEmail: lower(v.requestorEmail), actorName: v.employee, newStatus: STATUS.submitted, note: description,
      extra: actor.caller ? { submittedBy: actor.caller.email } : {} });
    if (consent) {
      // The requester's own step(s) from step 1 on, in order, in this same commit
      const adv = await autoAdvanceVoucher(client, { ...row, metadata: meta, status: STATUS.submitted });
      auto = adv.auto;
      plan = planOf(adv.row);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fail(res, msg(lang, 'voucherAlreadySubmitted', voucherNo));
    console.error('[Vouchers] submit error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }

  // Emails after commit, from the plan AFTER any self-approval: the requester is never asked to approve a step that
  // was just approved for them. Without self-approval this is exactly the old behaviour (waiting = step 1).
  const waiting = stepWaiting(plan);
  const pageTo = String(email.to).split(',').map(lower).filter(Boolean);
  if (plan.status === 'approved') for (const m of finalApproved(view, plan)) await queueMail(m);
  for (const a of waiting) {
    if (!auto.length && waiting.length === 1 && pageTo.includes(a.email) && email.subject && email.body) {
      await queueMail({ to: a.email, cc: email.cc, replyTo: email.replyTo, subject: email.subject, html: email.body });
    } else {
      await queueMail({ ...approvalRequest(view, plan, a), replyTo: email.replyTo });
    }
  }
  const link = `${baseUrl()}/voucher.html?viewStatus=${encodeURIComponent(voucherNo)}`;
  const button = `<p style="margin-top: 15px;"><a href="${link}" style="background: #4285f4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">🔍 Xem trạng thái phê duyệt</a></p>`;
  // Filed for someone else (decision 1): the auto-approved steps are the SUBMITTER's, so they are told, not the requester
  const onBehalf = auto.length > 0 && consent && consent.by !== lower(v.requestorEmail);
  if (reqMail && reqMail.to) {
    const sentTo = waiting.length ? ` Đã gửi email đến ${nameList(waiting)} để ${auto.length ? 'tiếp tục' : 'bắt đầu'} phê duyệt.` : '';
    const html = String(reqMail.body || '').replace(/đã được gửi phê duyệt/g, `đã được gửi phê duyệt.${sentTo}`) +
      (onBehalf ? '' : selfEmailHtml(auto)) + button;
    await queueMail({ to: reqMail.to, replyTo: email.replyTo, subject: reqMail.subject || '[THÔNG BÁO] Phiếu đã được gửi phê duyệt', html });
  }
  if (onBehalf) {
    const esc = (t) => String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    await queueMail({ to: consent.by, replyTo: email.replyTo, subject: `[THÔNG BÁO] Phiếu ${voucherNo}: đã tự động duyệt bước của bạn`,
      html: `<p>Bạn đã gửi phiếu ${esc(voucherNo)} thay cho ${esc(v.employee || v.requestorEmail)}.</p>` + selfEmailHtml(auto) + button });
  }
  await publishEvent('voucher:submitted', { voucherNumber: voucherNo, status: statusText(plan) });
  return res.json(auto.length
    ? { success: true, message: `Đã gửi yêu cầu phê duyệt thành công. ${doneText(auto)}`, autoApproved: publicAuto(auto) }
    : { success: true, message: 'Đã gửi yêu cầu phê duyệt thành công' });
}

// ── Approve (shared by approveVoucher and bulkApprove) ───────

/** My not-yet-approved entries on the open step. */
const pendingOf = (plan, email) => {
  const open = pendingStep(plan);
  return open >= 0 ? plan.steps[open].approvers.filter((a) => a.email === email && a.status !== 'approved') : [];
};

/**
 * Approve one voucher. The sample is resolved and loaded BEFORE the row lock (a slow or unreachable sample
 * never holds the lock); inside the lock the GAS rules are re-checked and the pre-loaded stamp is used only if
 * the approver's sample (company, URL, source) is still the same. If it changed in between, the whole attempt
 * is redone once outside the lock; a second change refuses with NO_SAMPLE.
 * Returns { ok, error?, view, plan, stepDone, finished } — emails are the caller's job.
 */
async function approveOne({ voucherNumber, approverEmail, approverName, lang, stamper = makeStamper(lang) }) {
  const email = lower(approverEmail);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const peek = (await pool.query(`SELECT * FROM vouchers WHERE voucher_number = $1`, [voucherNumber])).rows[0];
    const peekMine = peek ? pendingOf(planOf(peek), email) : [];
    const pre = peekMine.length ? await stamper(pool, peek.company_id, peekMine, email) : null;
    const r = await approveLocked({ voucherNumber, email, approverName, lang, pre });
    if (!r.retry) return r;
  }
  return { ok: false, error: NO_SAMPLE[lang === 'en' ? 'en' : 'vi'] };
}

/**
 * Approve the open step for `email` on the locked row and write everything an approval writes: print fields,
 * verification record, state, history, Sheet copy, audit. Shared by approveLocked and the Plan 5c auto-advance
 * (`auto` = { consent, mine, note }). Engine errors (NOT_YOUR_TURN, ALREADY_APPROVED, CLOSED) are thrown before
 * anything is written. Returns { row (as written), plan, stepDone, finished }.
 */
async function writeApproval(client, row, { email, name = '', signature, from, at, auto = null }) {
  const plan = planOf(row);
  const result = applyApproval(plan, email, { at, signature });
  const mine = plan.steps[pendingStep(plan)].approvers.filter((a) => a.email === email);
  const next = result.plan;
  const meta = { ...(row.metadata || {}) };
  const before = legacyCompanyApprovers(plan).approvers;
  const ca = legacyCompanyApprovers(next);
  // The legacy key of the entry approved just now (the same person may sit in two steps; two writes can share a time)
  const key = Object.keys(ca.approvers).find((k) => ca.approvers[k].email === email && ca.approvers[k].status === 'approved'
    && (!before[k] || before[k].status !== 'approved')) || '';
  const who = name || mine[0].name || email;
  // Role-specific fields read by the print templates (GAS names)
  if (key === 'accountant') { meta.accountantSignature = signature; meta.accountantName = who; }
  if (key === 'legalRep') { meta.legalRepSignature = signature; meta.legalRepName = who; }
  if (key === 'treasurer') { meta.treasurerSignature = signature; meta.treasurerName = who; meta.approverSignature = signature; }
  meta.signatureVerification = { ...(meta.signatureVerification || {}), [key || email]: verificationRecord(from, at) };
  meta.approvedBy = email;
  if (auto) meta.selfApproval = recordAuto(auto.consent, auto.mine, at, planOwnLeft(next, email));

  const status = statusText(next);
  const lastAction = 'Duyệt bởi ' + who;
  const idx = await saveState(client, row, { plan: next, meta, status, lastAction });
  const label = mine[0].label || 'Người duyệt';
  const note = auto ? auto.note
    : result.finished ? `Tất cả ${next.steps.length} bước phê duyệt đã duyệt` : `Đã duyệt bởi ${label} (${ca.approvalProgress})`;
  const hist = { ...voucherView(row), status, action: lastAction, approverEmail: email, approvedAt: at, meta: withoutStamps(meta), note };
  await appendHistory(client, hist);
  await mirrorVoucher(client, hist, { at, submittedAt: submittedAtOf(row), progressDone: idx.done });
  await audit(client, { docNo: row.voucher_number, company: row.company_name, action: 'Approve', role: key, actorEmail: email,
    actorName: who, prevStatus: row.status, newStatus: status, note: auto ? auto.note : '',
    extra: { auth: 'password', signatureStamped: !!signature, sampleFrom: from, ...(auto ? { auto: true, consentedAt: auto.consent.consentedAt } : {}) } });
  return { row: { ...row, metadata: meta, status, last_action: lastAction }, plan: next, stepDone: result.stepDone, finished: result.finished };
}

/**
 * Plan 5c: inside the open transaction, approve the submitter's own steps they consented to at submit. { row, auto }
 * The consent applies only to the signed-in submitter recorded at submit (metadata.submittedByEmail, the token
 * email), to this voucher number, and to round 0 (vouchers have no send-back). Only DB lookups here.
 */
async function autoAdvanceVoucher(client, row) {
  const { state, auto } = await autoAdvance(client, {
    state: row, companyId: row.company_id,
    consentOf: (r) => consentFor(r.metadata, { submitterEmail: r.metadata && r.metadata.submittedByEmail, round: 0, ref: r.voucher_number }),
    pendingOwn: (r, me) => planOwnOpen(planOf(r), me),
    approve: async (r, { consent, mine, stamp, at, note }) => (await writeApproval(client, r,
      { email: consent.by, signature: stamp.signature, from: stamp.from, at, auto: { consent, mine, note } })).row,
  });
  return { row: state, auto };
}

/** approveOne's transaction: row lock, GAS rules, the pre-loaded stamp, write, then the requester's own next steps. */
async function approveLocked({ voucherNumber, email, approverName, lang, pre }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherNotFound') + voucherNumber }; }
    if (row.status === STATUS.deleted) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherDeleted') }; }
    const plan = planOf(row);
    const mine = plan.steps.flatMap((s) => s.approvers).filter((a) => a.email === email);
    if (!mine.length) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'approverInfoNotFound') }; }
    if (plan.status === 'rejected') { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'voucherRejectedCannotApprove') }; }
    if (plan.status === 'approved') {
      await client.query('ROLLBACK');
      return { ok: false, error: msg(lang, mine.every((a) => a.status === 'approved') ? 'alreadyApprovedByYouCash' : 'alreadyFullyApproved') };
    }

    // Approved every entry they have and the plan moved on → GAS "already approved"
    if (mine.every((a) => a.status === 'approved')) { await client.query('ROLLBACK'); return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') }; }

    // The registered sample is stamped (no upload, no comparison); none registered → refused.
    // Uses the stamp loaded before the lock; only a DB lookup here, never a fetch.
    const pendingMine = pendingOf(plan, email);
    let stamp = { signature: '', from: '' };
    if (pendingMine.length) {
      if (!(await stampStillCurrent(client, pre, row.company_id, pendingMine, email))) {
        await client.query('ROLLBACK');
        return { retry: true };
      }
      if (!pre.ok) { await client.query('ROLLBACK'); return { ok: false, error: pre.message }; }
      stamp = pre;
    }

    let done;
    try {
      done = await writeApproval(client, row, { email, name: approverName, signature: stamp.signature, from: stamp.from, at: now() });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'ALREADY_APPROVED') return { ok: false, error: msg(lang, 'alreadyApprovedByYouCash') };
      if (e.code === 'NOT_YOUR_TURN') {
        const order = plan.steps.map((s) => s.approvers.map((a) => a.label || a.name).join(' + ')).join(' → ');
        return { ok: false, error: `Vui lòng đợi ${nameList(stepWaiting(plan))} phê duyệt trước. Thứ tự phê duyệt: ${order}.` };
      }
      throw e;
    }
    // Plan 5c: the requester's own next step(s), when they consented at submit — same commit, real time
    const adv = await autoAdvanceVoucher(client, done.row);
    const finalPlan = planOf(adv.row);
    await client.query('COMMIT');
    const finished = finalPlan.status === 'approved';
    await publishEvent('voucher:approved', { voucherNumber, status: adv.row.status, isFinal: finished });
    // A step closed when the open step moved (by this approval or the auto-advance after it): only then are the
    // next approvers asked, so approvers already asked for a still-open group step are not emailed again
    const stepDone = pendingStep(finalPlan) !== pendingStep(plan);
    return { ok: true, view: voucherView(row), plan: finalPlan, stepDone, finished, auto: adv.auto };
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
  const actor = await resolveApprover(req, res, v.approverEmail, lang);
  if (!actor) return;
  if (!actor.email) return fail(res, msg(lang, 'missingApproverInfo'));
  const pw = await confirmPassword({ db: pool, redis, email: actor.email, password: v.approverPassword, lang });
  if (!pw.ok) return fail(res, pw.message);
  try {
    const r = await approveOne({ voucherNumber: v.voucherNumber, approverEmail: actor.email, approverName: v.approverName, lang });
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
  const actor = await resolveApprover(req, res, b.approverEmail, lang); // identity from the token; a body email must match it
  if (!actor) return;
  const pw = await confirmPassword({ db: pool, redis, email: actor.email, password: b.approverPassword, lang }); // once for the batch
  if (!pw.ok) return fail(res, pw.message);

  const approved = [];
  const failed = [];
  const nextByApprover = new Map(); // email → { approver, items[] }
  const stamper = makeStamper(lang); // one load per sample for the whole batch
  for (const no of numbers) {
    try {
      const r = await approveOne({ voucherNumber: no, approverEmail: actor.email, approverName: b.approverName, lang, stamper });
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
    if (row.status === STATUS.deleted) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherDeleted')); }
    const plan = planOf(row);
    if (plan.status === 'rejected') { await client.query('ROLLBACK'); return fail(res, msg(lang, 'alreadyRejected')); }
    if (plan.status === 'approved') { await client.query('ROLLBACK'); return fail(res, msg(lang, 'alreadyFullyApproved')); }
    const at = now();
    try {
      next = applyRejection(plan, actor.email, { at, reason, anyApprover: true });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === 'NOT_IN_PLAN') return fail(res, msg(lang, 'rejecterInfoNotFound'));
      throw e;
    }
    const email = actor.email;
    const who = plan.steps.flatMap((s) => s.approvers).find((a) => a.email === email);
    const meta = row.metadata || {};
    // The voucher is final: the stored stamp copy of a self-approval consent is no longer needed
    if (meta.selfApproval) meta.selfApproval = { ...meta.selfApproval, stamps: [] };
    view = voucherView(row);
    const lastAction = 'Từ chối bởi ' + (who.name || email);
    const idx = await saveState(client, row, { plan: next, meta, status: STATUS.rejected, lastAction });
    const hist = {
      ...view, status: STATUS.rejected, action: lastAction, approverEmail: email, meta: withoutStamps(meta), rejectionReason: reason,
      note: `Từ chối bởi ${who.label || who.name || email}\nLý do: ${reason}`,
    };
    await appendHistory(client, hist);
    await mirrorVoucher(client, hist, { at, submittedAt: submittedAtOf(row), progressDone: idx.done });
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
    const hist = {
      ...view, status: STATUS.received, action: lastAction, approverEmail: requesterEmail, approvedAt: at, meta: withoutStamps(meta),
      note: (isThu ? 'Người thu tiền đã xác nhận: ' : 'Người nhận tiền đã xác nhận: ') + (b.requesterName || requesterEmail),
      acknowledgedAt: at, acknowledgedBy: requesterEmail, signatureUrl: b.requesterSignature,
    };
    await appendHistory(client, hist);
    // Acknowledging leaves the plan as it was: progress is the stored done count
    await mirrorVoucher(client, hist, { at, submittedAt: submittedAtOf(row), progressDone: row.progress_done });
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

// ── Delete (withdraw) ────────────────────────────────────────

/**
 * Why `email` may not delete this voucher, or '' when they may (decision 2026-10-08): only its requester or the
 * signed-in person who submitted it, only while the flow is open, and only while nobody else has approved — the
 * deleter's own approvals (e.g. a Plan 5c auto-approval) do not block it.
 */
function deleteBlocked(row, plan, email, lang) {
  if (row.status === STATUS.deleted) return msg(lang, 'voucherDeleted');
  const meta = row.metadata || {};
  if (!email || (email !== lower(row.requestor_email) && email !== lower(meta.submittedByEmail))) return msg(lang, 'deleteNotYours');
  if (plan.status === 'approved' || plan.status === 'rejected' || meta.acknowledgedSignature) return msg(lang, 'deleteClosed');
  const others = plan.steps.flatMap((s) => s.approvers).filter((a) => a.status === 'approved' && a.email !== email);
  return others.length ? msg(lang, 'deleteAlreadyApproved', nameList(others)) : '';
}

/**
 * deleteVoucher { voucherNumber } — the requester withdraws a voucher sent by mistake. The row is kept with status
 * "Đã xóa" (history, audit and the voucher number stay; it leaves every list and can no longer be approved); the
 * approvers who were waiting on it are told.
 */
export async function handleVoucherDelete(req, res) {
  const b = req.body || {};
  const lang = b.lang;
  const voucherNumber = String(b.voucherNumber || '').trim();
  if (!voucherNumber) return fail(res, msg(lang, 'missingVoucherNo'));
  const actor = await resolveApprover(req, res, '', lang); // signed in only: the token says who deletes
  if (!actor) return;
  const email = actor.email;

  const client = await pool.connect();
  let view, waiting;
  const at = now();
  try {
    await client.query('BEGIN');
    const row = await lockVoucher(client, voucherNumber);
    if (!row) { await client.query('ROLLBACK'); return fail(res, msg(lang, 'voucherNotFound') + voucherNumber); }
    const plan = planOf(row);
    const blocked = deleteBlocked(row, plan, email, lang);
    if (blocked) { await client.query('ROLLBACK'); return fail(res, blocked); }
    waiting = stepWaiting(plan).filter((a) => a.email !== email);
    const name = actor.caller.name || email;
    const meta = row.metadata || {};
    if (meta.selfApproval) meta.selfApproval = { ...meta.selfApproval, stamps: [] };
    meta.deletedAt = at;
    meta.deletedBy = email;
    const lastAction = 'Đã xóa bởi ' + name;
    await client.query(
      `UPDATE vouchers SET metadata = $1, status = $2, last_action = $3, current_approver = '', pending_emails = '{}',
              updated_at = NOW() WHERE id = $4`,
      [JSON.stringify(meta), STATUS.deleted, lastAction, row.id]
    );
    view = voucherView(row);
    const hist = { ...view, status: STATUS.deleted, action: lastAction, approverEmail: email, meta: withoutStamps(meta),
      note: `Người đề nghị đã xóa phiếu (${name})` };
    await appendHistory(client, hist);
    await mirrorVoucher(client, hist, { at, submittedAt: submittedAtOf(row), progressDone: row.progress_done });
    await audit(client, { docNo: voucherNumber, company: row.company_name, action: 'Delete', role: 'requester',
      actorEmail: email, actorName: name, prevStatus: row.status, newStatus: STATUS.deleted });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Vouchers] delete error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  } finally {
    client.release();
  }
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  for (const a of waiting) {
    await queueMail({ to: a.email, subject: `[ĐÃ XÓA] Phiếu ${voucherNumber}`,
      html: `<p>Phiếu ${esc(voucherNumber)} (${esc(view.company)}, ${esc(Number(view.amount).toLocaleString('vi-VN'))} đ) đã được người đề nghị xóa.</p>` +
        '<p>Bạn không cần phê duyệt phiếu này nữa.</p>' });
  }
  await publishEvent('voucher:deleted', { voucherNumber, status: STATUS.deleted });
  return res.json({ success: true, message: msg(lang, 'deleted', voucherNumber) });
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
                  updated_at, progress_done, progress_total, approver_emails, pending_emails, current_approver, description,
                  metadata->'approvalPlan'->'steps'->progress_done->>'name' AS step_name`;
    const { rows } = admin
      ? await pool.query(`SELECT ${cols} FROM vouchers WHERE status <> $1`, [STATUS.deleted])
      : await pool.query(`SELECT ${cols} FROM vouchers WHERE (LOWER(requestor_email) = $1 OR $1 = ANY(approver_emails)) AND status <> $2`, [email, STATUS.deleted]);
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
        submittedAt: submittedAtOf(row),
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
 * and the sample that will be stamped (role sample from Master
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
    if (row.status === STATUS.deleted) reason = msg(lang, 'voucherDeleted');
    else if (plan.status === 'rejected') reason = msg(lang, 'voucherRejectedCannotApprove');
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
        voucher: { ...voucherView(row), status: row.status, attachments: row.attachments, meta: { ...withoutStamps(row.metadata || {}), approvalPlan: undefined } },
        approvalPlan: plan,
        me: { email: caller.email, name: caller.name, isAdmin: caller.isAdmin },
        myEntries,
        canApprove: !reason,
        canReject: row.status !== STATUS.deleted && plan.status !== 'approved' && plan.status !== 'rejected' && inPlan,
        canDelete: !deleteBlocked(row, plan, caller.email, lang),
        reason,
        sampleSignatureUrl,
        sampleFrom,
        approvalAuth: 'password',
      },
    });
  } catch (err) {
    console.error('[Vouchers] context error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi: ' + err.message });
  }
}
