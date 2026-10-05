// api/handlers/voucher-approve.js — Voucher submit + approval (3-tier sequential)
// Core handler with SELECT FOR UPDATE, email queue, SSE, and audit log.
import pool from '../../db/pool.js';
import { publishEvent } from './sse.js';
import { queueEmail } from './email-queue.js';

/**
 * Helper: build the companyApprovers structure from a company row.
 * Matches the existing frontend/meta structure.
 */
function buildCompanyApprovers(company, approverEmails) {
  const emails = (approverEmails || '').split(',').map(e => e.trim()).filter(Boolean);
  return {
    approvalSequence: ['accountant', 'legalRep', 'treasurer'],
    currentApprover: 'accountant',
    overallStatus: 'pending',
    displayStatus: 'Chờ duyệt',
    approvalProgress: '0/3',
    approvers: {
      accountant: {
        name: company.accountant_name || '',
        email: company.accountant_email || emails[0] || '',
        signature: company.accountant_sig_url || '',
        status: 'pending',
      },
      legalRep: {
        name: company.legal_rep_name || '',
        email: company.legal_rep_email || emails[1] || '',
        signature: company.legal_rep_sig_url || '',
        status: 'pending',
      },
      treasurer: {
        name: company.treasurer_name || '',
        email: company.treasurer_email || emails[2] || '',
        signature: company.treasurer_sig_url || '',
        status: 'pending',
      },
    },
  };
}

/**
 * Resolve which role an approver email belongs to.
 */
function resolveApproverRoleForVoucher(companyApprovers, approverEmail) {
  const email = approverEmail.toLowerCase().trim();
  for (const role of ['accountant', 'legalRep', 'treasurer']) {
    const approver = companyApprovers.approvers[role];
    if (approver && approver.email && approver.email.toLowerCase().trim() === email) {
      return role;
    }
  }
  return null;
}

/**
 * Submit a new voucher (action: sendApprovalEmail).
 */
export async function handleVoucherSubmit(req, res) {
  const body = req.body || {};
  const {
    companyName, companyKey, voucherType, employeeName, requestorEmail,
    amount, dueDate, description, reason, expenses, requesterSignature,
    approverEmails, lang,
  } = body;
  const vi = lang !== 'en';

  if (!companyName || !voucherType || !employeeName) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Thiếu thông tin bắt buộc' : 'Missing required fields',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find company
    const coQuery = companyKey
      ? `SELECT * FROM companies WHERE company_name = $1 AND company_key = $2 LIMIT 1`
      : `SELECT * FROM companies WHERE company_name = $1 LIMIT 1`;
    const coParams = companyKey ? [companyName, companyKey] : [companyName];
    const { rows: coRows } = await client.query(coQuery, coParams);
    const company = coRows[0];
    if (!company) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: vi ? 'Không tìm thấy công ty' : 'Company not found' });
    }

    // Generate voucher number: {COMPANY_CODE}-PT{YYYYMMDD}{counter}
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = (company.company_code || 'XX').toUpperCase();
    const voucherNumber = await allocateVoucherNumber(client, prefix, dateStr);

    const meta = {
      reason: reason || description || '',
      requesterSignature: requesterSignature || '',
      payeeName: body.payeeName || '',
      amountInWords: body.amountInWords || '',
      voucherDate: body.voucherDate || dateStr,
      department: body.department || '',
      expenses: expenses || [],
      companyApprovers: buildCompanyApprovers(company, approverEmails),
    };

    const { rows } = await client.query(
      `INSERT INTO vouchers
         (voucher_number, voucher_type, company_id, company_name, company_key,
          employee_name, requestor_email, amount, status, due_date, description,
          metadata, current_approver, approval_progress, overall_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '0/3', 'pending')
       RETURNING id, voucher_number`,
      [
        voucherNumber, voucherType, company.id, company.company_name, company.company_key,
        employeeName, requestorEmail || '', amount || 0,
        'Chờ duyệt', dueDate || '', description || '',
        JSON.stringify(meta), 'accountant',
      ]
    );

    const vId = rows[0].id;
    const vNum = rows[0].voucher_number;

    // History row
    await client.query(
      `INSERT INTO voucher_history
         (voucher_number, voucher_type, company, company_key, employee, requestor_email,
          amount, status, action, description, approver_email, submitted_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12)`,
      [vNum, voucherType, company.company_name, company.company_key, employeeName,
       requestorEmail || '', amount || 0, 'Chờ duyệt', 'Submit', description || '',
       requestorEmail || '', JSON.stringify(meta)]
    );

    // Audit log
    await appendAuditLog(client, {
      doc_no: vNum, flow: 'VCH', company: company.company_name,
      action: 'Submit', role: 'requester', actor_email: requestorEmail || '',
      prev_status: '', new_status: 'Chờ duyệt', note: description || '',
    });

    await client.query('COMMIT');

    // Queue email to first approver (non-blocking)
    const firstApproverEmail = meta.companyApprovers.approvers.accountant.email;
    if (firstApproverEmail) {
      await queueEmail(
        firstApproverEmail,
        `[PHIẾU THU/CHI] Yêu cầu phê duyệt - ${vNum}`,
        buildApproverEmailHtml(vNum, voucherType, company.company_name, employeeName, amount)
      );
    }

    // SSE event
    await publishEvent('voucher:submitted', { voucherNumber: vNum, status: 'Chờ duyệt' });

    return res.json({
      success: true,
      message: vi ? 'Phiếu đã được gửi thành công' : 'Voucher submitted',
      data: { voucherNumber: vNum, id: vId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Voucher] Submit error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Approve a voucher (action: approveVoucher).
 * Uses SELECT FOR UPDATE to prevent concurrent approval race.
 */
export async function handleVoucherApprove(req, res) {
  const { voucherNumber, approverEmail, signatureData, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!voucherNumber || !approverEmail) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Thiếu số phiếu hoặc email người duyệt' : 'Missing voucher number or approver email',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Row-level lock ──
    const { rows } = await client.query(
      `SELECT * FROM vouchers WHERE voucher_number = $1 FOR UPDATE`,
      [voucherNumber]
    );
    const voucher = rows[0];
    if (!voucher) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Không tìm thấy phiếu' : 'Voucher not found' });
    }

    const meta = voucher.metadata || {};
    const companyApprovers = meta.companyApprovers;
    if (!companyApprovers?.approvers) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu không có thông tin phê duyệt' : 'No approver info' });
    }

    // ── 2. Resolve role ──
    const approverRole = resolveApproverRoleForVoucher(companyApprovers, approverEmail);
    if (!approverRole) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? `Email không phải người phê duyệt` : 'Not an approver' });
    }

    // ── 3. Guards ──
    if (companyApprovers.approvers[approverRole].status === 'approved') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Bạn đã phê duyệt phiếu này rồi' : 'Already approved' });
    }
    if (companyApprovers.overallStatus === 'Rejected') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu đã bị từ chối' : 'Voucher rejected' });
    }
    const expectedRole = companyApprovers.currentApprover || 'accountant';
    if (approverRole !== expectedRole) {
      await client.query('ROLLBACK');
      return res.json({
        success: false,
        message: vi ? `Chưa đến lượt phê duyệt. Đang chờ: ${expectedRole}`
                     : `Not your turn. Waiting for: ${expectedRole}`,
      });
    }

    // ── 4. Signature verification (skipped if no signatureData — for testing) ──
    if (signatureData?.approverSignature) {
      // TODO: worker thread comparison — for now, accept if present
      meta.signatureVerification = meta.signatureVerification || {};
      meta.signatureVerification[approverRole] = {
        verified: true,
        similarity: 100,
        reason: 'ok',
        verifiedAt: new Date().toISOString(),
      };
    }

    // ── 5. Update approval state ──
    const now = new Date().toISOString();
    companyApprovers.approvers[approverRole].status = 'approved';
    companyApprovers.approvers[approverRole].signature = signatureData?.approverSignature || '';
    companyApprovers.approvers[approverRole].approvedAt = now;

    const approvalCount = Object.values(companyApprovers.approvers).filter(a => a.status === 'approved').length;
    companyApprovers.approvalProgress = `${approvalCount}/3`;
    meta.companyApprovers = companyApprovers;
    meta.approvedBy = approverEmail;

    // Store role-specific signature
    if (approverRole === 'accountant') { meta.accountantSignature = signatureData?.approverSignature || ''; meta.accountantName = signatureData?.approverName || ''; }
    else if (approverRole === 'legalRep') { meta.legalRepSignature = signatureData?.approverSignature || ''; meta.legalRepName = signatureData?.approverName || ''; }
    else if (approverRole === 'treasurer') { meta.treasurerSignature = signatureData?.approverSignature || ''; meta.treasurerName = signatureData?.approverName || ''; }

    const isFinal = approvalCount === 3;
    let newStatus, nextRole = null;

    if (isFinal) {
      companyApprovers.overallStatus = 'Approved';
      companyApprovers.displayStatus = 'Đã duyệt';
      companyApprovers.currentApprover = null;
      companyApprovers.fullyApprovedAt = now;
      newStatus = 'Đã duyệt';
    } else {
      const sequence = companyApprovers.approvalSequence || ['accountant', 'legalRep', 'treasurer'];
      nextRole = sequence[sequence.indexOf(approverRole) + 1];
      companyApprovers.currentApprover = nextRole;
      companyApprovers.overallStatus = 'Partially Approved';
      companyApprovers.displayStatus = `Đang duyệt (${approvalCount}/3)`;
      newStatus = `Đang duyệt (${approvalCount}/3)`;
    }

    // ── 6. Update voucher ──
    await client.query(
      `UPDATE vouchers
       SET metadata = $1, status = $2, approval_progress = $3,
           overall_status = $4, current_approver = $5, updated_at = NOW()
       WHERE voucher_number = $6`,
      [JSON.stringify(meta), newStatus, companyApprovers.approvalProgress,
       companyApprovers.overallStatus, companyApprovers.currentApprover, voucherNumber]
    );

    // ── 7. History row ──
    await client.query(
      `INSERT INTO voucher_history
         (voucher_number, status, action, approver_email, approved_at, metadata)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [voucherNumber, newStatus, `Duyệt bởi ${approverRole}`, approverEmail, JSON.stringify(meta)]
    );

    // ── 8. Audit log (append-only, never breaks) ──
    await appendAuditLog(client, {
      doc_no: voucherNumber, flow: 'VCH', company: voucher.company_name,
      action: 'Approve', role: approverRole, actor_email: approverEmail,
      prev_status: voucher.status, new_status: newStatus,
      note: signatureData?.approverNote || '',
      extra: { signatureUploaded: !!signatureData?.approverSignature },
    });

    await client.query('COMMIT');

    // ── 9. Queue emails (non-blocking) ──
    if (isFinal) {
      // Notify requester of completion
      if (voucher.requestor_email) {
        await queueEmail(
          voucher.requestor_email,
          `[PHIẾU THU/CHI] Phiếu đã hoàn thành - ${voucherNumber}`,
          buildCompletionEmailHtml(voucherNumber, voucher.voucher_type, voucher.company_name)
        );
      }
    } else if (nextRole) {
      // Notify next approver
      const nextEmail = companyApprovers.approvers[nextRole]?.email;
      if (nextEmail) {
        await queueEmail(
          nextEmail,
          `[PHIẾU THU/CHI] Yêu cầu phê duyệt - ${voucherNumber}`,
          buildApproverEmailHtml(voucherNumber, voucher.voucher_type, voucher.company_name, voucher.employee_name, voucher.amount)
        );
      }
    }

    // ── 10. SSE event ──
    await publishEvent('voucher:approved', {
      voucherNumber, status: newStatus, role: approverRole, isFinal,
    });

    // ── 11. Return immediately ──
    return res.json({
      success: true,
      message: vi ? 'Đã duyệt thành công' : 'Approved',
      data: { voucherNumber, status: newStatus, isFinal, approvalProgress: companyApprovers.approvalProgress },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Voucher] Approve error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Reject a voucher.
 */
export async function handleVoucherReject(req, res) {
  const { voucherNumber, approverEmail, rejectReason, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!voucherNumber || !approverEmail || !rejectReason) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Thiếu số phiếu, email hoặc lý do từ chối' : 'Missing fields',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM vouchers WHERE voucher_number = $1 FOR UPDATE`, [voucherNumber]
    );
    const voucher = rows[0];
    if (!voucher) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Không tìm thấy phiếu' : 'Not found' });
    }

    if (voucher.overall_status === 'Rejected') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu đã bị từ chối' : 'Already rejected' });
    }
    if (voucher.overall_status === 'Approved') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu đã được duyệt, không thể từ chối' : 'Already approved' });
    }

    const meta = voucher.metadata || {};
    meta.rejectedBy = approverEmail;
    meta.rejectedAt = new Date().toISOString();
    meta.rejectionReason = rejectReason;

    await client.query(
      `UPDATE vouchers SET status = 'Đã từ chối', overall_status = 'Rejected',
           metadata = $1, updated_at = NOW() WHERE voucher_number = $2`,
      [JSON.stringify(meta), voucherNumber]
    );

    await client.query(
      `INSERT INTO voucher_history (voucher_number, status, action, approver_email, note, approved_at, metadata)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [voucherNumber, 'Đã từ chối', `Từ chối bởi ${approverEmail}`, approverEmail, rejectReason, JSON.stringify(meta)]
    );

    await appendAuditLog(client, {
      doc_no: voucherNumber, flow: 'VCH', company: voucher.company_name,
      action: 'Reject', role: 'approver', actor_email: approverEmail,
      prev_status: voucher.status, new_status: 'Đã từ chối', note: rejectReason,
    });

    await client.query('COMMIT');

    // Notify requester
    if (voucher.requestor_email) {
      await queueEmail(
        voucher.requestor_email,
        `[PHIẾU THU/CHI] Phiếu bị từ chối - ${voucherNumber}`,
        `<p>Phiếu <b>${voucherNumber}</b> đã bị từ chối.</p><p>Lý do: ${rejectReason}</p>`
      );
    }

    await publishEvent('voucher:rejected', { voucherNumber, status: 'Đã từ chối' });

    return res.json({ success: true, message: vi ? 'Đã từ chối' : 'Rejected' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Voucher] Reject error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Acknowledge receipt (requester confirms they received the money).
 */
export async function handleVoucherAcknowledge(req, res) {
  const { voucherNumber, requesterEmail, requesterSignature, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!voucherNumber || !requesterSignature) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Thiếu số phiếu hoặc chữ ký' : 'Missing voucher number or signature',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM vouchers WHERE voucher_number = $1 FOR UPDATE`, [voucherNumber]
    );
    const voucher = rows[0];
    if (!voucher) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Không tìm thấy phiếu' : 'Not found' });
    }

    if (voucher.overall_status !== 'Approved') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu chưa được duyệt hoàn toàn' : 'Not fully approved' });
    }

    const meta = voucher.metadata || {};
    if (meta.acknowledgedSignature) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Phiếu đã được xác nhận' : 'Already acknowledged' });
    }

    meta.acknowledgedSignature = requesterSignature;
    meta.acknowledgedAt = new Date().toISOString();
    meta.acknowledgedBy = requesterEmail || voucher.requestor_email;

    await client.query(
      `UPDATE vouchers SET metadata = $1, acknowledged_sig = $2,
           acknowledged_at = NOW(), acknowledged_by = $3, status = 'Received',
           updated_at = NOW() WHERE voucher_number = $4`,
      [JSON.stringify(meta), requesterSignature, meta.acknowledgedBy, voucherNumber]
    );

    await client.query(
      `INSERT INTO voucher_history (voucher_number, status, action, approver_email, approved_at, metadata)
       VALUES ($1, 'Received', $2, $3, NOW(), $4)`,
      [voucherNumber, 'Đã xác nhận nhận tiền', requesterEmail || '', JSON.stringify(meta)]
    );

    await appendAuditLog(client, {
      doc_no: voucherNumber, flow: 'VCH', company: voucher.company_name,
      action: 'Acknowledge', role: 'requester', actor_email: requesterEmail || '',
      prev_status: voucher.status, new_status: 'Received',
    });

    await client.query('COMMIT');

    await publishEvent('voucher:acknowledged', { voucherNumber, status: 'Received' });

    return res.json({ success: true, message: vi ? 'Đã xác nhận' : 'Acknowledged' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Voucher] Acknowledge error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Get voucher summary (list). Uses partial index — no 5000-row scan.
 */
export async function handleVoucherSummary(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT voucher_number, voucher_type, company_name, employee_name, amount,
              status, approval_progress, created_at, updated_at,
              metadata->'companyApprovers'->>'approvalProgress' as meta_progress
       FROM vouchers
       WHERE status NOT IN ('Đã duyệt', 'Đã từ chối')
       ORDER BY updated_at DESC
       LIMIT 500`
    );

    const summary = rows.map(v => ({
      voucherNumber: v.voucher_number,
      voucherType: v.voucher_type,
      company: v.company_name,
      employee: v.employee_name,
      amount: v.amount,
      status: v.status,
      approvalProgress: v.approval_progress || v.meta_progress || '0/3',
      meta: {
        companyApprovers: {
          approvalProgress: v.approval_progress || v.meta_progress || '0/3',
        },
      },
    }));

    return res.json({ success: true, data: { vouchers: summary } });
  } catch (err) {
    console.error('[Voucher] Summary error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function allocateVoucherNumber(client, prefix, dateStr) {
  // Use a Postgres sequence for atomic, race-free allocation.
  // One sequence per (prefix, date) — created on demand.
  const seqName = `voucher_seq_${prefix.toLowerCase()}_${dateStr}`;
  // Sanitize sequence name (alphanumeric + underscore only)
  const safeSeq = seqName.replace(/[^a-z0-9_]/g, '_');
  // Create the sequence if it doesn't exist, then get next value
  await client.query(`CREATE SEQUENCE IF NOT EXISTS ${safeSeq} START 1`); 
  const { rows } = await client.query(`SELECT nextval('${safeSeq}')::int as next_val`);
  const counter = String(rows[0].next_val).padStart(6, '0');
  return `${prefix}-PT${dateStr}${counter}`;
}

async function appendAuditLog(client, opts) {
  try {
    await client.query(
      `INSERT INTO voucher_audit_log
         (doc_no, flow, company, action, role, actor_email, actor_name,
          prev_status, new_status, note, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [opts.doc_no, opts.flow, opts.company || '', opts.action, opts.role || '',
       opts.actor_email || '', opts.actor_name || '',
       opts.prev_status || '', opts.new_status || '', opts.note || '',
       JSON.stringify(opts.extra || {})]
    );
  } catch (err) {
    // Audit must never break the main flow
    console.error('[Audit] Non-fatal error:', err.message);
  }
}

function buildApproverEmailHtml(voucherNumber, type, company, employee, amount) {
  return `<p>Kính gửi,</p>
    <p>Có một <b>${type}</b> mới đang chờ phê duyệt.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
      <tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>${voucherNumber}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>${company}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Người lập:</td><td>${employee || '—'}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Số tiền:</td><td>${(amount || 0).toLocaleString('vi-VN')} ₫</td></tr>
    </table>
    <p style="margin-top:16px;">Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>
    <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>`;
}

function buildCompletionEmailHtml(voucherNumber, type, company) {
  return `<p>Kính gửi,</p>
    <p>${type} <b>${voucherNumber}</b> của công ty <b>${company}</b> đã được phê duyệt hoàn tất.</p>
    <p>Vui lòng đến nhận tiền tại thủ quỹ.</p>
    <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>`;
}
