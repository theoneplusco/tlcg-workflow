// api/jobs/sheet-mirror.js — one worker drains sheet_outbox into Google Sheets (one-way copy).
import fs from 'node:fs';
import { google } from 'googleapis';
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { runSheetMirrorOnce } from '../lib/sheets/mirror-run.js';

const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

/** Real Sheets API with the mirror service account (SHEETS_MIRROR_KEY_FILE). */
export function googleSheets() {
  const key = JSON.parse(fs.readFileSync(process.env.SHEETS_MIRROR_KEY_FILE, 'utf8'));
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api = google.sheets({ version: 'v4', auth });
  return {
    async getValues(id, tab) { return (await api.spreadsheets.values.get({ spreadsheetId: id, range: q(tab) })).data.values || []; },
    async append(id, tab, row) {
      await api.spreadsheets.values.append({ spreadsheetId: id, range: q(tab), valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
    },
    async update(id, tab, rowNumber, row) {
      await api.spreadsheets.values.update({ spreadsheetId: id, range: `${q(tab)}!A${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] } });
    },
  };
}

/** Every 20 s, one PM2 worker at a time (Redis lock), when SHEETS_MIRROR=on. */
export function startSheetMirrorJob() {
  if (process.env.SHEETS_MIRROR !== 'on') return;
  let sheets;
  try { sheets = googleSheets(); } catch (e) { console.error('[sheet-mirror] disabled:', e.message); return; }
  setInterval(async () => {
    const got = await redis.set('lock:sheet-mirror', String(process.pid), 'EX', 120, 'NX');
    if (!got) return;
    try {
      const r = await runSheetMirrorOnce(sheets, pool);
      if (r.done || r.failed) console.log(`[sheet-mirror] done=${r.done} failed=${r.failed}`);
    } catch (e) { console.error('[sheet-mirror]', e.message); }
    finally { await redis.del('lock:sheet-mirror'); }
  }, 20000);
}
