#!/usr/bin/env node
/**
 * scripts/import-purchase-requests.js — Purchase requests from the Google Sheet into Postgres.
 *
 *   node scripts/import-purchase-requests.js --dir ./sheets              # Purchase_Request_History.csv, Purchase_Request_Archive.csv,
 *                                                                        # PR_Audit_Log.csv, optional "Purchase Order.csv"
 *   node scripts/import-purchase-requests.js --live                      # read with SHEETS_MIRROR_KEY_FILE
 *   node scripts/import-purchase-requests.js --dir ./sheets --dry-run
 *   node scripts/import-purchase-requests.js --live --notify-purchasing  # switch day only: email the purchasing approver
 *                                                                        # of simplified PRs stuck at Mua hàng (GAS bug B2)
 * Needs migrations 001–007 and Master Data. Re-runnable (see api/lib/purchase-requests/importer.js).
 * Never queues a Sheet copy (the data came from the Sheet).
 */
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import 'dotenv/config';
import { parseCsv, recordsFromGrid } from '../api/lib/sheets/grid.js';
import { SPREADSHEET_ID } from '../api/lib/master-registry.js';
import { importPurchaseRequests } from '../api/lib/purchase-requests/importer.js';

const args = process.argv.slice(2);
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
const LIVE = args.includes('--live');
const DRY = args.includes('--dry-run');
if (!DIR && !LIVE) { console.error('Use --dir <folder> or --live'); process.exit(1); }

async function readTab(name, { optional = false } = {}) {
  try {
    if (DIR) return recordsFromGrid(parseCsv(fs.readFileSync(path.join(DIR, `${name}.csv`), 'utf-8').replace(/^﻿/, '')));
    const { google } = await import('googleapis');
    const auth = new google.auth.GoogleAuth({ keyFile: process.env.SHEETS_MIRROR_KEY_FILE || process.env.GOOGLE_SHEETS_MIRROR_KEY || 'secrets/sheets-mirror.json',
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${name}'` });
    return recordsFromGrid((r.data.values || []).map((row) => row.map((v) => (v == null ? '' : String(v)))));
  } catch (e) {
    if (optional) { console.warn(`[ImportPR] ${name} not read (${e.message}); skipped`); return null; }
    throw e;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow', max: 2 });
try {
  const working = await readTab('Purchase_Request_History');
  const archive = await readTab('Purchase_Request_Archive', { optional: true });
  const audit = await readTab('PR_Audit_Log');
  const poTypes = await readTab('Purchase Order', { optional: true });
  const stats = await importPurchaseRequests(pool, { working, archive: archive || [], audit, poTypes,
    dryRun: DRY, notifyPurchasing: args.includes('--notify-purchasing') });
  console.log(`[ImportPR] ${DIR ? 'CSV ' + DIR : 'live sheet'}${DRY ? ' (dry run, rolled back)' : ''}`);
  console.log(JSON.stringify(stats, null, 2));
  if (stats.noCompany) console.warn(`[ImportPR] ${stats.noCompany} PR(s) without a matching company (company_id NULL): fix Master Data, then re-run`);
  console.log('Export 2026-10-06 expectation: prs 34 (32 working + 2 archive), byStatus Mua hàng (5/5) 21 / Đang duyệt ngân sách & NCC (2/5) 11, audit 80');
} finally { await pool.end(); }
