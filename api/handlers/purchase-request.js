// api/handlers/purchase-request.js — P2P purchase request submit + approve + reject + send-back
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { computePRApprovalState, computeP2PBranch } from '../lib/pr-approval-state.js';
import { publishEvent } from './sse.js';
import { queueEmail } from './email-queue.js';

/**
 * Submit a new purchase request.
 */
export async function handlePRSubmit(req, res) {
  const body = req.body || {};
  const {
    prNo: requestedNo, companyCode, companyName, companyKey,
    department, requesterName, requesterEmail,
    requiredDate, priority, currency = 'VND',
    items: itemsStr, grandTotal = 0, purpose,
    budgetApprover, budgetApproverNote,
    supplierApprover, supplierApproverNote,
    contractApprover, purchasingApprover,
    requesterSignature, attachments: attachmentsStr,
    purchaseType = 'goods', lang,
  } = body;
  const vi = lang !== 'en';

  // Validate required fields
  if (!companyName) return res.status(400).json({ success: false, message: vi ? 'Thiếu tên công ty' : 'Missing company name' });
  if (!requesterName) return res.status(400).json({ success: false, message: vi ? 'Thiếu người đề nghị' : 'Missing requester' });
  if (!budgetApprover) return res.status(400).json({ success: false, message: vi ? 'Thiếu người duyệt ngân sách' : 'Missing budget approver' });
  if (!supplierApprover) return res.status(400).json({ success: false, message: vi ? 'Thiếu người duyệt NCC' : 'Missing supplier approver' });

  let items = [];
  try { items = typeof itemsStr === 'string' ? JSON.parse(itemsStr) : (itemsStr || []); }
  catch { return res.status(400).json({ success: false, message: vi ? 'Dữ liệu hàng hóa không hợp lệ' : 'Invalid items' }); }
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ success: false, message: vi ? 'Cần ít nhất 1 hàng hóa' : 'At least 1 item required' });

  let attachments = [];
  try { attachments = typeof attachmentsStr === 'string' ? JSON.parse(attachmentsStr) : (attachmentsStr || []); }
  catch { /* ignore */ }

  const p2pBranch = computeP2PBranch(purchaseType, grandTotal);
  if (p2pBranch === 'full' && !contractApprover) {
    return res.status(400).json({
      success: false,
      message: vi ? 'Đề nghị này (Dịch vụ hoặc ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng'
                   : 'Full branch requires contract approver',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Allocate PR number (atomic)
    const prNo = await allocatePRNumber(client, companyCode || 'XX', requestedNo);

    const metadata = {
      companyCode, companyKey, requesterEmail,
      budgetApproverNote, supplierApproverNote,
      submittedAt: new Date().toISOString(),
      requesterSignature,
      attachments,
      purchaseType,
      p2pBranch,
      budgetStatus: budgetApprover ? 'Pending' : 'N/A',
      supplierStatus: supplierApprover ? 'Pending' : 'N/A',
      contractStatus: 'N/A', // skipPRContract is true for both branches
      purchasingStatus: purchasingApprover ? 'Pending' : 'N/A',
      vendorDetails: {
        vendorType: body.vendorType || '',
        vendorTaxId: body.vendorTaxId || '',
        vendorAddress: body.vendorAddress || '',
        vendorAccountName: body.vendorAccountName || '',
        vendorAccountNo: body.vendorAccountNo || '',
        vendorBankName: body.vendorBankName || '',
        vendorTransferNote: body.vendorTransferNote || '',
      },
    };

    // Find company
    const { rows: coRows } = await client.query(
      `SELECT id FROM companies WHERE company_name = $1 LIMIT 1`, [companyName]
    );
    const companyId = coRows[0]?.id || null;

    const { rows } = await client.query(
      `INSERT INTO purchase_requests
         (pr_no, company_id, company_name, company_key, department,
          requester_name, requester_email, required_date, priority, purpose,
          budget_approver_email, supplier_approver_email,
          contract_approver_email, purchasing_approver_email,
          items, grand_total, currency, status, p2p_branch, purchase_type,
          attachments, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       RETURNING id, pr_no`,
      [prNo, companyId, companyName, companyKey || '', department || '',
       requesterName, requesterEmail || '', requiredDate || '',
       priority || 'Bình Thường', purpose || '',
       budgetApprover || '', supplierApprover || '',
       p2pBranch === 'full' ? (contractApprover || '') : '', purchasingApprover || '',
       JSON.stringify(items), grandTotal, currency,
       'Đang duyệt ngân sách & NCC (2/5)', p2pBranch, purchaseType,
       JSON.stringify(attachments), JSON.stringify(metadata)]
    );

    const newId = rows[0].id;
    const newPrNo = rows[0].pr_no;

    // Audit log
    await appendPRAuditLog(client, {
      doc_no: newPrNo, company: companyName,
      action: 'Submit', role: 'requester', actor_email: requesterEmail || '',
      actor_name: requesterName, prev_status: '', new_status: 'Đang duyệt ngân sách & NCC (2/5)',
      note: purpose || '', extra: { purchaseType, p2pBranch },
    });

    await client.query('COMMIT');

    // Queue emails (non-blocking): budget + supplier + requester
    const approverSubject = `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - ${newPrNo}`;
    const approverHtml = buildPRApproverEmail(newPrNo, companyName, requesterName, purpose, grandTotal);
    await queueEmail(budgetApprover, approverSubject, approverHtml);
    await queueEmail(supplierApprover, approverSubject, approverHtml);
    if (requesterEmail) {
      await queueEmail(requesterEmail, `[ĐỀ NGHỊ MUA HÀNG] Xác nhận gửi phiếu - ${newPrNo}`,
        buildPRRequesterEmail(newPrNo, companyName, requesterName, purpose, grandTotal));
    }

    await publishEvent('pr:submitted', { prNo: newPrNo, status: 'Đang duyệt ngân sách & NCC (2/5)' });

    return res.json({
      success: true,
      message: vi ? 'Đề nghị mua hàng đã được gửi thành công' : 'Purchase request submitted',
      data: { prNo: newPrNo, id: newId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PR] Submit error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Approve a PR (4 roles: budget, supplier, contract, purchasing).
 */
export async function handlePRApprove(req, res) {
  const { prNo, approverEmail, approverRole, note, approverSignature, signatureVerification, submittedAt, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!prNo || !approverEmail) return res.status(400).json({ success: false, message: vi ? 'Thiếu số PR hoặc email' : 'Missing PR no or email' });

  const validRoles = ['budget', 'supplier', 'contract', 'purchasing'];
  if (!validRoles.includes(approverRole)) return res.status(400).json({ success: false, message: vi ? 'Vai trò không hợp lệ' : 'Invalid role' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE`, [prNo]
    );
    const pr = rows[0];
    if (!pr) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Không tìm thấy PR' : 'PR not found' }); }

    // Terminal status checks
    if (pr.status === 'Đã từ chối' || pr.status === 'Rejected')
      { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Đã bị từ chối' : 'Already rejected' }); }
    if (pr.status === 'Hoàn thành' || pr.status === 'Approved')
      { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Đã hoàn thành' : 'Already complete' }); }
    if (pr.status === 'Trả lại bổ sung')
      { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Đang trả lại bổ sung' : 'Returned' }); }

    // Email must match assigned column
    const approverColMap = { budget: 'budget_approver_email', supplier: 'supplier_approver_email', contract: 'contract_approver_email', purchasing: 'purchasing_approver_email' };
    const assignedEmail = (pr[approverColMap[approverRole]] || '').toLowerCase().trim();
    if (!assignedEmail) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? `Vai trò ${approverRole} chưa được phân công` : `Role ${approverRole} not assigned` }); }
    if (approverEmail.toLowerCase().trim() !== assignedEmail) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? `Bạn không được phân công vai trò ${approverRole}` : 'Not assigned' }); }

    const metadata = pr.metadata || {};
    const stateBefore = computePRApprovalState(pr, metadata);
    const roleStage = (approverRole === 'budget' || approverRole === 'supplier') ? 'parallel' : approverRole;
    if (roleStage !== stateBefore.stage) {
      await client.query('ROLLBACK');
      const stageNames = { parallel: 'duyệt ngân sách & NCC', contract: 'thẩm định hợp đồng', purchasing: 'mua hàng' };
      return res.json({ success: false, message: vi ? `Chưa đến lượt duyệt. Giai đoạn: ${stageNames[stateBefore.stage] || stateBefore.stage}` : 'Not your turn' });
    }

    if (metadata[approverRole + 'Status'] === 'Approved') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Bạn đã duyệt đề nghị này rồi' : 'Already approved' });
    }

    // Update
    const now = new Date().toISOString();
    metadata[approverRole + 'Status'] = 'Approved';
    metadata[approverRole + 'ApprovedAt'] = now;
    metadata[approverRole + 'Note'] = note || '';
    if (approverSignature) metadata[approverRole + 'Signature'] = approverSignature;
    if (signatureVerification) metadata[approverRole + 'SignatureVerification'] = signatureVerification;

    const stateAfter = computePRApprovalState(pr, metadata);
    const newStatus = stateAfter.statusLabel;

    await client.query(
      `UPDATE purchase_requests SET status = $1, metadata = $2, updated_at = NOW() WHERE pr_no = $3`,
      [newStatus, JSON.stringify(metadata), prNo]
    );

    await appendPRAuditLog(client, {
      doc_no: prNo, company: pr.company_name,
      action: 'Approve', role: approverRole, actor_email: approverEmail,
      prev_status: pr.status, new_status: newStatus, note: note || '',
      extra: { signatureUploaded: !!approverSignature },
    });

    await client.query('COMMIT');

    // Queue stage transition emails
    if (stateAfter.stage === 'purchasing' && stateBefore.stage === 'parallel') {
      if (stateAfter.purchasingEmail) {
        await queueEmail(stateAfter.purchasingEmail,
          `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu Mua hàng - ${prNo}`,
          `<p>Giai đoạn <b>Mua hàng</b> đã mở.</p><p>Phiếu: ${prNo}</p>`);
      }
    } else if (stateAfter.stage === 'complete') {
      if (metadata.requesterEmail) {
        await queueEmail(metadata.requesterEmail,
          `[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - ${prNo}`,
          `<p>Đề nghị mua hàng <b>${prNo}</b> đã được phê duyệt hoàn tất.</p>`);
      }
    }

    await publishEvent('pr:approved', { prNo, status: newStatus, role: approverRole, stage: stateAfter.stage });

    return res.json({
      success: true,
      message: vi ? 'Đã duyệt thành công' : 'Approved',
      data: { prNo, status: newStatus, stage: stateAfter.stage },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PR] Approve error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Reject a PR.
 */
export async function handlePRReject(req, res) {
  const { prNo, approverEmail, note, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!prNo || !approverEmail) return res.status(400).json({ success: false, message: vi ? 'Thiếu số PR hoặc email' : 'Missing fields' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`SELECT * FROM purchase_requests WHERE pr_no = $1 FOR UPDATE`, [prNo]);
    const pr = rows[0];
    if (!pr) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Không tìm thấy PR' : 'Not found' }); }

    const metadata = pr.metadata || {};
    const stateNow = computePRApprovalState(pr, metadata);

    // Map email → role
    const emailRoleMap = {};
    if (stateNow.budgetEmail) emailRoleMap[stateNow.budgetEmail] = 'budget';
    if (stateNow.supplierEmail) emailRoleMap[stateNow.supplierEmail] = 'supplier';
    if (stateNow.contractEmail) emailRoleMap[stateNow.contractEmail] = 'contract';
    if (stateNow.purchasingEmail) emailRoleMap[stateNow.purchasingEmail] = 'purchasing';

    const rejectRole = emailRoleMap[approverEmail.toLowerCase().trim()];
    if (!rejectRole) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Bạn không có quyền từ chối' : 'No permission' }); }

    const rejectRoleStage = (rejectRole === 'budget' || rejectRole === 'supplier') ? 'parallel' : rejectRole;
    if (rejectRoleStage !== stateNow.stage) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Chưa đến lượt' : 'Not your turn' }); }

    if (pr.status === 'Đã từ chối' || pr.status === 'Hoàn thành' || pr.status === 'Trả lại bổ sung') {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: vi ? 'Không thể từ chối' : 'Cannot reject' });
    }

    metadata.rejectedAt = new Date().toISOString();
    metadata.rejectedBy = approverEmail;
    metadata.rejectionNote = note || '';

    await client.query(`UPDATE purchase_requests SET status = 'Đã từ chối', metadata = $1, updated_at = NOW() WHERE pr_no = $2`,
      [JSON.stringify(metadata), prNo]);

    await appendPRAuditLog(client, {
      doc_no: prNo, company: pr.company_name,
      action: 'Reject', role: rejectRole, actor_email: approverEmail,
      prev_status: pr.status, new_status: 'Đã từ chối', note: note || '',
    });

    await client.query('COMMIT');

    if (metadata.requesterEmail) {
      await queueEmail(metadata.requesterEmail,
        `[ĐỀ NGHỊ MUA HÀNG] Phiếu bị từ chối - ${prNo}`,
        `<p>Đề nghị <b>${prNo}</b> bị từ chối. Lý do: ${note || ''}</p>`);
    }

    await publishEvent('pr:rejected', { prNo, status: 'Đã từ chối' });

    return res.json({ success: true, message: vi ? 'Đã từ chối' : 'Rejected' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PR] Reject error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    client.release();
  }
}

/**
 * Get PR history (slim cards — no items, no metadata).
 */
export async function handlePRHistory(req, res) {
  try {
    // Maybe archive old PRs (once per day)
    await maybeArchiveOldPRs();

    const { rows } = await pool.query(
      `SELECT pr_no, company_name, requester_name, purpose, grand_total,
              currency, status, submitted_at
       FROM purchase_requests
       WHERE archived_at IS NULL
       ORDER BY submitted_at DESC
       LIMIT 5000`
    );

    const requests = rows.map(r => ({
      prNo: r.pr_no,
      company: r.company_name,
      requester: r.requester_name,
      purpose: r.purpose,
      grandTotal: parseFloat(r.grand_total) || 0,
      currency: r.currency,
      status: r.status,
      submittedAt: r.submitted_at,
    }));

    return res.json({ success: true, data: { requests } });
  } catch (err) {
    console.error('[PR] History error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

/**
 * Get single PR detail (with items + metadata).
 */
export async function handlePRDetail(req, res) {
  const { prNo } = req.body || req.query || {};
  if (!prNo) return res.status(400).json({ success: false, message: 'prNo required' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM purchase_requests WHERE pr_no = $1`, [prNo]
    );
    const pr = rows[0];
    if (!pr) return res.json({ success: false, message: 'Không tìm thấy PR' });

    return res.json({
      success: true,
      data: {
        prNo: pr.pr_no,
        company: pr.company_name,
        companyKey: pr.company_key,
        department: pr.department,
        requesterName: pr.requester_name,
        requesterEmail: pr.requester_email,
        requiredDate: pr.required_date,
        priority: pr.priority,
        purpose: pr.purpose,
        vendorName: pr.vendor_name,
        budgetCode: pr.budget_code,
        budgetApproverEmail: pr.budget_approver_email,
        supplierApproverEmail: pr.supplier_approver_email,
        contractApproverEmail: pr.contract_approver_email,
        purchasingApproverEmail: pr.purchasing_approver_email,
        items: pr.items,
        grandTotal: parseFloat(pr.grand_total) || 0,
        currency: pr.currency,
        status: pr.status,
        p2pBranch: pr.p2p_branch,
        purchaseType: pr.purchase_type,
        attachments: pr.attachments,
        metadata: pr.metadata,
        submittedAt: pr.submitted_at,
      },
    });
  } catch (err) {
    console.error('[PR] Detail error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function allocatePRNumber(client, companyCode, requestedNo) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  if (requestedNo) {
    const { rowCount } = await client.query(`SELECT 1 FROM purchase_requests WHERE pr_no = $1`, [requestedNo]);
    if (rowCount === 0) return requestedNo;
  }

  // Atomic sequence using ON CONFLICT
  await client.query(
    `INSERT INTO pr_number_sequences (company_code, date_str, next_counter)
     VALUES ($1, $2, 1)
     ON CONFLICT (company_code, date_str)
     DO UPDATE SET next_counter = pr_number_sequences.next_counter + 1`,
    [companyCode.toUpperCase(), dateStr]
  );

  const { rows } = await client.query(
    `SELECT next_counter FROM pr_number_sequences WHERE company_code = $1 AND date_str = $2`,
    [companyCode.toUpperCase(), dateStr]
  );

  const counter = String(rows[0].next_counter - 1).padStart(6, '0');
  return `${companyCode.toUpperCase()}-PR${dateStr}${counter}`;
}

async function appendPRAuditLog(client, opts) {
  try {
    await client.query(
      `INSERT INTO pr_audit_log
         (doc_no, flow, company, action, role, actor_email, actor_name,
          prev_status, new_status, note, extra)
       VALUES ($1, 'PR', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [opts.doc_no, opts.company || '', opts.action, opts.role || '',
       opts.actor_email || '', opts.actor_name || '',
       opts.prev_status || '', opts.new_status || '', opts.note || '',
       JSON.stringify(opts.extra || {})]
    );
  } catch (err) {
    console.error('[PR Audit] Non-fatal error:', err.message);
  }
}

async function maybeArchiveOldPRs() {
  const today = new Date().toDateString();
  const lastRun = await redis.get('tlcg:pr:archive:last-run').catch(() => null);
  if (lastRun === today) return;

  try {
    await pool.query(
      `UPDATE purchase_requests SET archived_at = NOW()
       WHERE status IN ('Hoàn thành', 'Đã từ chối')
         AND archived_at IS NULL
         AND updated_at < NOW() - INTERVAL '90 days'`
    );
    await redis.set('tlcg:pr:archive:last-run', today);
  } catch (err) {
    console.error('[PR Archive] Error (non-fatal):', err.message);
  }
}

function buildPRApproverEmailHtml(prNo, company, requester, purpose, total) {
  return `<p>Kính gửi,</p>
    <p>Có một <b>Đề nghị mua hàng</b> mới đang chờ phê duyệt.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
      <tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>${prNo}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>${company}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Người đề nghị:</td><td>${requester || '—'}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>${purpose || '—'}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>${(total || 0).toLocaleString('vi-VN')} ₫</td></tr>
    </table>
    <p>Vui lòng đăng nhập để xem chi tiết và phê duyệt.</p>
    <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>`;
}

function buildPRRequesterEmailHtml(prNo, company, requester, purpose, total) {
  return `<p>Kính gửi ${requester || ''},</p>
    <p>Đề nghị mua hàng của bạn đã được gửi thành công.</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
      <tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>${prNo}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>${company}</td></tr>
      <tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>${(total || 0).toLocaleString('vi-VN')} ₫</td></tr>
    </table>
    <p>Người phê duyệt đã được thông báo.</p>
    <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>`;
}

function buildPRApproverEmail(prNo, company, requester, purpose, total) {
  return buildPRApproverEmailHtml(prNo, company, requester, purpose, total);
}
function buildPRRequesterEmail(prNo, company, requester, purpose, total) {
  return buildPRRequesterEmailHtml(prNo, company, requester, purpose, total);
}
