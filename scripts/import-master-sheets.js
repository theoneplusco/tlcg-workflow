#!/usr/bin/env node
/**
 * scripts/import-master-sheets.js — Import the master sheets into Postgres,
 * keeping every sheet column exactly as it is in Google Sheets.
 *
 *   node scripts/import-master-sheets.js                      # fetch live (service account)
 *   node scripts/import-master-sheets.js --save-dir ./sheets  # fetch live and keep the CSVs
 *   node scripts/import-master-sheets.js --dir ./sheets       # import CSVs: "<Sheet name>.csv"
 *   node scripts/import-master-sheets.js --only vendors,vendor_banks
 *
 * Needs db/migrations/001 and 002. Live fetch reads the service-account key
 * from GOOGLE_SERVICE_ACCOUNT_FILE (default ./vast-torus-408523-1553d7d43f47.json);
 * the spreadsheet must be shared with that account.
 *
 * Employees / Companies / Goods are upserted (email; name + key; item + category)
 * and keep values in admin-added columns; a password already set in Postgres
 * is never overwritten. Clients / Vendors / Vendor banks are replaced wholesale.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { MASTER_TABLES, SPREADSHEET_ID } from '../api/lib/master-registry.js';

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i > -1 ? args[i + 1] : ''; };
const DIR = argValue('--dir');
const SAVE_DIR = argValue('--save-dir');
const ONLY = argValue('--only').split(',').map((s) => s.trim()).filter(Boolean);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow',
  max: 4,
});

const str = (v) => (v == null ? '' : String(v)).trim();

// ── CSV ─────────────────────────────────────────────────────────

/** RFC 4180 parser (quoted fields, "" escapes, newlines inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let accessToken = null;
async function fetchSheetCsv(def) {
  if (!accessToken) {
    const { google } = await import('googleapis');
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './vast-torus-408523-1553d7d43f47.json';
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    accessToken = (await (await auth.getClient()).getAccessToken()).token;
  }
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${def.gid}`;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
    const body = await r.text();
    if (r.ok && !body.startsWith('<')) return body;
    if (r.status !== 429 || attempt === 5) throw new Error(`Google returned HTTP ${r.status} for "${def.sheet}"`);
    await new Promise((ok) => setTimeout(ok, attempt * 5000)); // rate limited
  }
}

async function readSheet(def) {
  const csv = DIR
    ? fs.readFileSync(path.join(DIR, `${def.sheet}.csv`), 'utf-8')
    : await fetchSheetCsv(def);
  if (SAVE_DIR) {
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    fs.writeFileSync(path.join(SAVE_DIR, `${def.sheet}.csv`), csv);
  }

  const rows = parseCsv(csv.replace(/^﻿/, ''));
  const header = rows[0] || [];
  const cols = header.map((h, i) => ({ name: str(h), i })).filter((c) => c.name);
  const seen = new Set();
  for (const c of cols) {
    if (seen.has(c.name)) throw new Error(`"${def.sheet}" has the header "${c.name}" twice`);
    seen.add(c.name);
  }
  const data = [];
  rows.slice(1).forEach((r, idx) => {
    if (!r.some((v) => str(v))) return; // blank sheet row
    const rec = {};
    for (const c of cols) rec[c.name] = str(r[c.i]);
    data.push({ sheetRow: idx + 2, rec });
  });
  const unnamed = header.map((h, i) => (!str(h) && rows.slice(1).some((r) => str(r[i])) ? i : -1)).filter((i) => i > -1);
  if (unnamed.length) console.warn(`  ! "${def.sheet}": values under blank headers (columns ${unnamed.map((i) => i + 1)}) were skipped`);
  return { columns: cols.map((c) => c.name), data };
}

// ── Column registry ─────────────────────────────────────────────

/** Sheet order first; admin-added columns not in the sheet stay, after them. */
async function syncColumns(client, key, sheetColumns) {
  const { rows } = await client.query(
    `SELECT name FROM master_columns WHERE table_key = $1 ORDER BY position`, [key]);
  const extraCols = rows.map((r) => r.name).filter((n) => !sheetColumns.includes(n));
  const ordered = [...sheetColumns, ...extraCols];
  await client.query(
    `INSERT INTO master_columns (table_key, name, position)
     SELECT $1, n, ord FROM unnest($2::text[]) WITH ORDINALITY AS t(n, ord)
     ON CONFLICT (table_key, name) DO UPDATE SET position = EXCLUDED.position`,
    [key, ordered]
  );
  return extraCols.length;
}

// ── Row import ──────────────────────────────────────────────────

/** Sheet values → typed column values (lenient: bad values fall back, with a warning). */
function typedValues(def, rec, label) {
  const out = {};
  for (const [header, core] of Object.entries(def.core)) {
    try {
      out[core.col] = core.type.parse(rec[header] ?? '');
    } catch (e) {
      out[core.col] = null;
      if (str(rec[header])) console.warn(`  ! ${label}: "${header}" = "${rec[header]}" — ${e.message}`);
    }
  }
  return out;
}

/** Every visible sheet value as text — typed columns too, so the admin page shows the sheet's own text. */
function extraValues(def, rec) {
  const extra = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!def.hidden.includes(k)) extra[k] = v;
  }
  return extra;
}

/** overrides: { column: 'SQL expression' } replaces `column = EXCLUDED.column` on conflict. */
async function upsertTyped(client, def, cols, conflict, row, overrides = {}) {
  const names = Object.keys(cols);
  const params = names.map((n) => cols[n]);
  params.push(JSON.stringify(row.extra), row.sheetRow);
  const sets = names.filter((n) => !conflict.includes(n))
    .map((n) => `${n} = ${overrides[n] || `EXCLUDED.${n}`}`);
  await client.query(
    `INSERT INTO ${def.table} (${names.join(', ')}, extra, sheet_row)
     VALUES (${names.map((_, i) => '$' + (i + 1)).join(', ')}, $${names.length + 1}::jsonb, $${names.length + 2})
     ON CONFLICT (${conflict.join(', ')}) DO UPDATE SET
       ${[...sets, `extra = ${def.table}.extra || EXCLUDED.extra`, 'sheet_row = EXCLUDED.sheet_row', 'updated_at = NOW()'].join(',\n       ')}`,
    params
  );
}

async function importEmployees(client, def, data) {
  let noEmail = 0, noPassword = 0;
  for (const { sheetRow, rec } of data) {
    const label = `${def.sheet} row ${sheetRow}`;
    const v = typedValues(def, rec, label);
    if (!v.full_name) { console.warn(`  ! ${label}: no full_name — skipped`); continue; }
    if (!v.email) {
      noEmail++;
      v.email = `noemail-${crypto.createHash('sha1').update(v.full_name).digest('hex').slice(0, 10)}@local`;
    }
    v.status = v.status || 'active';

    // Column K = plain default password, column L = SHA-256 of the chosen one
    const defaultPassword = str(rec.login_password);
    const legacy = str(rec.password).toLowerCase();
    let hash = '';
    let mustChange = !!v.must_change_password;
    if (!legacy && defaultPassword) { hash = await bcrypt.hash(defaultPassword, 10); mustChange = true; }
    else if (!legacy) { noPassword++; mustChange = true; }

    const cols = { ...v, password_hash: hash, legacy_password_sha256: legacy, must_change_password: mustChange };
    // A password already set in Postgres wins over the sheet
    const kept = `employees.password_hash <> ''`;
    await upsertTyped(client, def, cols, ['email'], { sheetRow, extra: extraValues(def, rec) }, {
      password_hash: `CASE WHEN ${kept} THEN employees.password_hash ELSE EXCLUDED.password_hash END`,
      legacy_password_sha256: `CASE WHEN ${kept} THEN '' ELSE EXCLUDED.legacy_password_sha256 END`,
      must_change_password: `CASE WHEN ${kept} THEN employees.must_change_password ELSE EXCLUDED.must_change_password END`,
    });
  }
  return `${noEmail} without email → noemail-*@local, ${noPassword} with no password (forgot-password needed)`;
}

async function importTyped(client, key, def, data) {
  if (key === 'employees') return importEmployees(client, def, data);
  const conflict = key === 'companies' ? ['company_name', 'company_key'] : ['name', 'category'];
  for (const { sheetRow, rec } of data) {
    const label = `${def.sheet} row ${sheetRow}`;
    const v = typedValues(def, rec, label);
    const first = conflict[0];
    if (!v[first]) { console.warn(`  ! ${label}: no ${first} — skipped`); continue; }
    for (const c of conflict) v[c] = v[c] ?? '';
    if (key === 'goods') {
      // Keep the sheet's values (MOQ 0 stays 0); only fill NOT NULL gaps
      v.status = v.status || 'active';
      v.moq = v.moq ?? 0;
      v.unit_price = v.unit_price ?? 0;
    }
    await upsertTyped(client, def, v, conflict, { sheetRow, extra: extraValues(def, rec) });
  }
  return '';
}

async function importSheetOnly(client, def, data) {
  await client.query(`DELETE FROM ${def.table}`);
  const payload = data.map(({ sheetRow, rec }) => ({ r: sheetRow, e: extraValues(def, rec) }));
  await client.query(
    `INSERT INTO ${def.table} (sheet_row, extra)
     SELECT (x->>'r')::int, x->'e' FROM jsonb_array_elements($1::jsonb) AS x`,
    [JSON.stringify(payload)]
  );
  return 'replaced';
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const sheetKeys = Object.keys(MASTER_TABLES).filter((k) => MASTER_TABLES[k].sheet); // app-only tables (exchange_rates) are never imported
  const keys = ONLY.length ? ONLY : sheetKeys;
  for (const k of keys) if (!MASTER_TABLES[k] || !MASTER_TABLES[k].sheet) throw new Error(`Unknown table "${k}". Use: ${sheetKeys.join(', ')}`);
  console.log(`[Import] Source: ${DIR ? 'CSV folder ' + DIR : 'Google Sheets (live)'}`);

  for (const key of keys) {
    const def = MASTER_TABLES[key];
    const started = Date.now();
    const { columns, data } = await readSheet(def);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const kept = await syncColumns(client, key, columns);
      const note = Object.keys(def.core).length
        ? await importTyped(client, key, def, data)
        : await importSheetOnly(client, def, data);
      await client.query('COMMIT');
      const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM ${def.table}`);
      console.log(`[Import] ${def.sheet.padEnd(20)} ${String(data.length).padStart(5)} rows, ${columns.length} columns` +
        `${kept ? ` (+${kept} admin-added kept)` : ''} → ${def.table}: ${rows[0].n} rows` +
        `${note ? ` · ${note}` : ''} · ${Date.now() - started} ms`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`${def.sheet}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  console.log('[Import] Done. Reload PM2 to drop the 5-minute master-data cache.');
}

main()
  .catch((err) => { console.error('[Import] Error:', err.message); process.exitCode = 1; })
  .finally(() => pool.end());
