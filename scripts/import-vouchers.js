#!/usr/bin/env node
/**
 * scripts/import-vouchers.js — Import vouchers from the Google Sheet into Postgres.
 *
 *   node scripts/import-vouchers.js --dir ./sheets          # Voucher_Current.csv + Voucher_History.csv
 *   node scripts/import-vouchers.js --live                  # read the sheet with GOOGLE_SHEETS_MIRROR_KEY
 *   node scripts/import-vouchers.js --dir ./sheets --dry-run
 *
 * - voucher_history: every sheet row, exactly as written (sheet_row kept).
 * - vouchers: one row per voucher; status / last action / dates from Voucher_Current.
 * - The approval plan is rebuilt from the voucher's richest companyApprovers
 *   metadata, with approvals taken from the status (Voucher_Current's progress
 *   column is unreliable): "Đã duyệt"/"Received" → every step approved,
 *   "Đang treo" → none, "Đã từ chối" → rejected. Two vouchers without
 *   metadata take today's approvers from Master Data.
 * - Re-runnable: imported vouchers are replaced; a voucher created directly in
 *   Postgres (no metadata.import) is never touched.
 * Needs migrations 001–005 and Master Data (companies, employees).
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import 'dotenv/config';
import { buildPlan, DEFAULT_STEPS } from '../api/lib/approval/engine.js';
import { planFromCompanyApprovers, legacyCompanyApprovers, planIndex } from '../api/lib/vouchers/compat.js';
import { toAmount, findCompany, employeesByEmail } from '../api/lib/vouchers/repo.js';
import { sheetTime } from '../api/lib/sheets/voucher-records.js'; // GMT sheet times

const SPREADSHEET_ID = '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g';
const args = process.argv.slice(2);
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
const LIVE = args.includes('--live');
const DRY = args.includes('--dry-run');
if (!DIR && !LIVE) { console.error('Use --dir <folder> or --live'); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow', max: 4 });
const lower = (s) => String(s || '').trim().toLowerCase();

// ── Reading ─────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

async function readTab(name) {
  let grid;
  if (DIR) {
    grid = parseCsv(fs.readFileSync(path.join(DIR, `${name}.csv`), 'utf-8').replace(/^﻿/, ''));
  } else {
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SHEETS_MIRROR_KEY || 'secrets/sheets-mirror.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: name });
    grid = (r.data.values || []).map((row) => row.map((v) => (v == null ? '' : String(v))));
  }
  const header = (grid[0] || []).map((h) => h.trim());
  return grid.slice(1).map((r, i) => ({ sheetRow: i + 2, ...Object.fromEntries(header.map((h, k) => [h, (r[k] || '').trim()])) }))
    .filter((r) => Object.keys(r).some((k) => k !== 'sheetRow' && r[k]));
}

// ── Building one voucher ────────────────────────────────────────

const meta = (r) => { try { return r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch { return {}; } };
const isApprovalAction = (a) => /^Duyệt bởi|^Approved by|^Fully Approved|^Đã duyệt$/i.test(a);

function rebuildPlan({ cur, rows, company, employees }) {
  const metas = rows.map(meta);
  // Richest metadata: the latest row whose companyApprovers has approvers
  const withCA = metas.filter((m) => m.companyApprovers && m.companyApprovers.approvers).pop();
  let plan = withCA
    ? planFromCompanyApprovers(withCA.companyApprovers, { companyId: company ? company.id : null })
    : buildPlan({ flow: { steps: DEFAULT_STEPS.voucher }, company: company || {}, employeesByEmail: employees, workflow: 'voucher' }).plan;
  plan.source = withCA ? 'import' : 'import-masterdata';

  const status = cur.status;
  const approvalRows = rows.filter((r) => isApprovalAction(r.action));
  const lastUpdated = sheetTime(cur.lastUpdated) || sheetTime(cur.submittedAt);
  const allApproved = status === 'Đã duyệt' || status === 'Received' || status === 'Approved';
  plan.steps.forEach((s, i) => {
    const shouldBe = allApproved;
    s.status = shouldBe ? 'approved' : (s.status === 'approved' && !/Đang treo/.test(status) ? 'approved' : 'pending');
    s.approvers.forEach((a) => {
      a.status = s.status;
      if (s.status === 'approved' && !a.at) {
        const hit = approvalRows.find((r) => lower(r.approver_email) === a.email) || approvalRows[i];
        a.at = (hit && (sheetTime(hit.approved_at) || sheetTime(hit.submitted_at))) || lastUpdated;
      }
      if (s.status !== 'approved') { a.at = null; }
    });
  });
  if (/từ chối|rejected/i.test(status)) {
    const rej = rows.filter((r) => /^Từ chối|Đã từ chối|Rejected/i.test(r.action) || /từ chối/i.test(r.status)).pop() || {};
    plan.status = 'rejected';
    plan.rejectedBy = { email: lower(rej.approver_email), at: sheetTime(rej.submitted_at) || lastUpdated, reason: rej.rejection_reason || rej.note || '' };
  } else if (plan.steps.every((s) => s.status === 'approved')) {
    plan.status = 'approved';
  } else if (plan.steps.some((s) => s.status === 'approved')) {
    plan.status = 'in_progress';
  } else {
    plan.status = 'pending';
  }
  return { plan, latestMeta: withCA || metas.filter((m) => Object.keys(m).length).pop() || {} };
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const [current, history] = [await readTab('Voucher_Current'), await readTab('Voucher_History')];
  console.log(`[ImportVouchers] Source: ${DIR ? 'CSV ' + DIR : 'live sheet'} — ${current.length} vouchers, ${history.length} history rows${DRY ? ' (dry run)' : ''}`);
  const historyBy = new Map();
  for (const r of history) {
    if (!historyBy.has(r.voucher_number)) historyBy.set(r.voucher_number, []);
    historyBy.get(r.voucher_number).push(r);
  }
  const employees = await employeesByEmail(pool);
  const stats = { imported: 0, skippedNative: 0, noCompany: 0, fromMasterData: 0, historyRows: 0 };

  for (const cur of current) {
    const no = cur.voucherNumber;
    const rows = (historyBy.get(no) || []).sort((a, b) => a.sheetRow - b.sheetRow);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = (await client.query(`SELECT id, metadata FROM vouchers WHERE voucher_number = $1 FOR UPDATE`, [no])).rows[0];
      if (existing && !(existing.metadata && existing.metadata.import)) {
        stats.skippedNative++;
        await client.query('ROLLBACK');
        continue; // created in Postgres after cutover — never overwrite
      }
      const company = await findCompany(client, cur.company, cur.companyKey);
      if (!company) stats.noCompany++;
      const { plan, latestMeta } = rebuildPlan({ cur, rows, company, employees });
      if (plan.source === 'import-masterdata') stats.fromMasterData++;

      const ack = rows.filter((r) => /xác nhận/i.test(r.action) || r.status === 'Received').pop();
      const m = { ...latestMeta };
      if (ack) {
        const am = meta(ack);
        m.acknowledgedSignature = am.acknowledgedSignature || ack.signature_url || m.acknowledgedSignature || '';
        m.acknowledgedAt = sheetTime(ack.acknowledged_at) || sheetTime(ack.submitted_at);
        m.acknowledgedBy = lower(ack.acknowledged_by || ack.approver_email);
      }
      m.approvalPlan = plan;
      m.companyApprovers = legacyCompanyApprovers(plan);
      m.import = { at: new Date().toISOString(), sheet: 'Voucher_Current', sheetRow: cur.sheetRow };
      const idx = planIndex(plan);
      const first = rows[0] || {};
      const submittedAt = sheetTime(first.submitted_at) || sheetTime(cur.submittedAt);
      // Voucher_Current.lastUpdated is date-only once exported; the last history row has the time
      const lastRowTime = rows.map((r) => sheetTime(r.submitted_at)).filter(Boolean).sort().pop();
      const updatedAt = lastRowTime || sheetTime(cur.lastUpdated) || submittedAt;

      if (!DRY) {
        await client.query(`DELETE FROM voucher_history WHERE voucher_number = $1`, [no]);
        await client.query(`DELETE FROM vouchers WHERE voucher_number = $1`, [no]);
        await client.query(
          `INSERT INTO vouchers (voucher_number, voucher_type, company_id, company_name, company_key, employee_name,
             requestor_email, submitted_by, amount, status, due_date, description, attachments, metadata,
             current_approver, approval_progress, overall_status, acknowledged_sig, acknowledged_at, acknowledged_by,
             created_at, updated_at, submitted_at, last_action, progress_done, progress_total, pending_emails, approver_emails, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
          [no, cur.voucherType, company ? company.id : null, cur.company, cur.companyKey, cur.employee, lower(cur.requestorEmail),
            cur.submittedBy, toAmount(cur.amount), cur.status, cur.dueDate, first.description || '', first.attachments || '',
            JSON.stringify(m), m.companyApprovers.currentApprover || '', m.companyApprovers.approvalProgress,
            m.companyApprovers.overallStatus, ack ? m.acknowledgedSignature : null, ack ? m.acknowledgedAt : null, ack ? m.acknowledgedBy : null,
            submittedAt || updatedAt, updatedAt, submittedAt, cur.action, idx.done, idx.total, idx.pendingEmails, idx.approverEmails,
            first.note || '']
        );
        for (const r of rows) {
          await client.query(
            `INSERT INTO voucher_history (voucher_number, voucher_type, company, company_key, employee, requestor_email,
               submitted_by, submitted_at, amount, status, due_date, action, attachments, description, note, approver_email,
               approved_at, metadata, acknowledged_at, acknowledged_by, signature_url, rejection_reason, sheet_row)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [no, r.voucher_type, r.company_name, r.company_key, r.employee_name, lower(r.submitted_email), r.submitted_by,
              sheetTime(r.submitted_at) || updatedAt, toAmount(r.amount), r.status, r.due_date, r.action, r.attachments,
              r.description, r.note, r.approver_email, sheetTime(r.approved_at), JSON.stringify(meta(r)),
              sheetTime(r.acknowledged_at), r.acknowledged_by, r.signature_url, r.rejection_reason, r.sheetRow]
          );
        }
        stats.historyRows += rows.length;
      }
      await client.query(DRY ? 'ROLLBACK' : 'COMMIT');
      stats.imported++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[ImportVouchers] ${no}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  console.log('[ImportVouchers] Done:', stats);
}

if (process.argv[1] && process.argv[1].endsWith('import-vouchers.js')) {
  main().catch((e) => { console.error('[ImportVouchers] Error:', e.message); process.exitCode = 1; }).finally(() => pool.end());
}
