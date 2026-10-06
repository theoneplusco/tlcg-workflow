// api/handlers/admin-approval.js — Admin API for approval flows (versioned, per company).
import pool from '../../db/pool.js';
import { requireAdmin } from './admin-employees.js';
import { ROLES, companyRoles, roleLabel } from '../lib/approval/roles.js';
import { buildPlan, validateSteps } from '../lib/approval/engine.js';
import { getActiveFlow, listVersions, saveVersion, loadCompanyContext } from '../lib/approval/flows-repo.js';

/** Workflows that can be configured. Only vouchers run on the engine so far. */
export const WORKFLOWS = {
  voucher: { vi: 'Phiếu thu / chi', en: 'Vouchers', enabled: true },
  purchase_request: { vi: 'Đề nghị mua hàng', en: 'Purchase requests', enabled: false },
  payment_request: { vi: 'Đề nghị thanh toán', en: 'Payment requests', enabled: false },
};

function parseTarget(req, res) {
  const workflow = String(req.body?.workflow || 'voucher');
  if (!WORKFLOWS[workflow] || !WORKFLOWS[workflow].enabled) {
    res.json({ success: false, message: 'Quy trình này chưa hỗ trợ ma trận duyệt.' });
    return null;
  }
  const raw = req.body?.companyId;
  const companyId = raw === null || raw === undefined || raw === '' ? null : parseInt(raw, 10);
  if (raw != null && raw !== '' && !Number.isInteger(companyId)) {
    res.json({ success: false, message: 'Công ty không hợp lệ.' });
    return null;
  }
  return { workflow, companyId };
}

/** Problems per company that would use this flow (its own, or the default when it has none). */
async function coverage(workflow, companyId, steps) {
  const companies = companyId != null
    ? [companyId]
    : (await pool.query(
      `SELECT c.id FROM companies c
        WHERE NOT EXISTS (SELECT 1 FROM approval_flows f WHERE f.workflow = $1 AND f.company_id = c.id)
        ORDER BY c.company_name, c.company_key`, [workflow])).rows.map((r) => r.id);
  const out = [];
  for (const id of companies) {
    const { company, employeesByEmail } = await loadCompanyContext(pool, id);
    if (!company) continue;
    const { plan, problems } = buildPlan({ flow: { steps }, company, employeesByEmail, workflow });
    out.push({
      companyId: id,
      company: company.company_name + (company.company_key ? ` (${company.company_key})` : ''),
      problems,
      people: plan.steps.map((s) => s.approvers.map((a) => (a.label ? `${a.label} (${a.name || '—'})` : a.name))),
    });
  }
  return out;
}

/**
 * adminApprovalFlowGet { workflow, companyId|null }
 * Everything the editor needs: companies, roles with today's people, employees,
 * the flow in force, saved versions, and who would approve for each company.
 */
export async function handleAdminApprovalFlowGet(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const t = parseTarget(req, res);
  if (!t) return;
  try {
    const [companies, employees, ctx, active, versions] = await Promise.all([
      pool.query(`SELECT c.id, c.company_name AS name, c.company_key AS key,
                         EXISTS (SELECT 1 FROM approval_flows f WHERE f.workflow = $1 AND f.company_id = c.id) AS has_own
                    FROM companies c ORDER BY c.company_name, c.company_key`, [t.workflow]),
      pool.query(`SELECT LOWER(email) AS email, full_name AS name, position FROM employees
                   WHERE status = 'active' AND email NOT LIKE '%@local' ORDER BY full_name`),
      loadCompanyContext(pool, t.companyId),
      getActiveFlow(pool, t.workflow, t.companyId),
      listVersions(pool, t.workflow, t.companyId),
    ]);
    const roles = t.companyId != null
      ? companyRoles(ctx.company, ctx.employeesByEmail)
      : Object.keys(ROLES).map((role) => ({ role, label: roleLabel(role), email: '', name: '' }));
    return res.json({
      success: true,
      data: {
        workflows: Object.entries(WORKFLOWS).map(([key, w]) => ({ key, label: w.vi, enabled: w.enabled })),
        workflow: t.workflow,
        companyId: t.companyId,
        companies: companies.rows.map((c) => ({ id: c.id, name: c.name, key: c.key, hasOwn: c.has_own })),
        roles,
        employees: employees.rows,
        active,
        versions,
        coverage: await coverage(t.workflow, t.companyId, active.steps),
      },
    });
  } catch (err) {
    console.error('[AdminApproval] get error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * adminApprovalFlowSave { workflow, companyId|null, steps, effectiveFrom?, note? }
 * Appends a new version. Named people must be active employees.
 */
export async function handleAdminApprovalFlowSave(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = parseTarget(req, res);
  if (!t) return;
  const steps = req.body?.steps;
  const errors = validateSteps(steps);
  if (errors.length) return res.json({ success: false, message: errors.join(' ') });

  let effectiveFrom = null;
  if (req.body?.effectiveFrom) {
    const d = new Date(req.body.effectiveFrom);
    if (Number.isNaN(d.getTime())) return res.json({ success: false, message: 'Ngày hiệu lực không hợp lệ.' });
    if (d.getTime() < Date.now() - 60000) return res.json({ success: false, message: 'Ngày hiệu lực không được ở quá khứ.' });
    effectiveFrom = d.toISOString();
  }

  try {
    const people = [...new Set(steps.flatMap((s) => s.approvers).filter((a) => a.type === 'person')
      .map((a) => String(a.email).trim().toLowerCase()))];
    if (people.length) {
      const { rows } = await pool.query(
        `SELECT LOWER(email) AS email FROM employees WHERE status = 'active' AND LOWER(email) = ANY($1)`, [people]);
      const known = new Set(rows.map((r) => r.email));
      const missing = people.filter((e) => !known.has(e));
      if (missing.length) return res.json({ success: false, message: `Không phải nhân viên đang hoạt động: ${missing.join(', ')}.` });
    }
    if (t.companyId != null) {
      const { rows } = await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [t.companyId]);
      if (!rows.length) return res.json({ success: false, message: 'Không tìm thấy công ty.' });
    }

    const saved = await saveVersion(pool, {
      workflow: t.workflow, companyId: t.companyId, steps, effectiveFrom,
      note: String(req.body?.note || '').slice(0, 500), createdBy: admin.email,
    });
    console.log(`[AdminApproval] ${admin.email} saved ${t.workflow} flow v${saved.version} for company ${t.companyId ?? 'default'}`);
    return res.json({
      success: true,
      message: `Đã lưu phiên bản ${saved.version}.`,
      data: { version: saved.version, effectiveFrom: saved.effectiveFrom, coverage: await coverage(t.workflow, t.companyId, saved.steps) },
    });
  } catch (err) {
    if (err.code === 'INVALID_FLOW') return res.json({ success: false, message: err.message });
    console.error('[AdminApproval] save error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/** adminApprovalFlowPreview { workflow, companyId|null, steps } — who would approve, before saving. */
export async function handleAdminApprovalFlowPreview(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const t = parseTarget(req, res);
  if (!t) return;
  const steps = req.body?.steps;
  const errors = validateSteps(steps).filter((e) => !/chưa có người duyệt/.test(e));
  if (errors.length) return res.json({ success: false, message: errors.join(' ') });
  try {
    const usable = steps.filter((s) => s.approvers && s.approvers.length);
    return res.json({ success: true, data: { coverage: await coverage(t.workflow, t.companyId, usable) } });
  } catch (err) {
    console.error('[AdminApproval] preview error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}
