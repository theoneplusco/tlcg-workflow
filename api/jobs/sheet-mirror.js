// api/jobs/sheet-mirror.js — one worker drains sheet_outbox into Google Sheets (one-way copy).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { runSheetMirrorOnce } from '../lib/sheets/mirror-run.js';

const q = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

const T = { timeout: 30000, retry: false }; // bounded per call: the run must stay inside its lease
const colLetter = (n) => { let s = ''; for (let x = n + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

/** Real Sheets API with the mirror service account (SHEETS_MIRROR_KEY_FILE). */
export function googleSheets() {
  const key = JSON.parse(fs.readFileSync(process.env.SHEETS_MIRROR_KEY_FILE, 'utf8'));
  const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const api = google.sheets({ version: 'v4', auth });
  return {
    authorize: () => auth.authorize(),
    async getHeader(id, tab) {
      return ((await api.spreadsheets.values.get({ spreadsheetId: id, range: `${q(tab)}!1:1` }, T)).data.values || [[]])[0] || [];
    },
    async getColumn(id, tab, col) {
      const L = colLetter(col);
      const r = await api.spreadsheets.values.get({ spreadsheetId: id, range: `${q(tab)}!${L}:${L}`, valueRenderOption: 'UNFORMATTED_VALUE' }, T);
      return (r.data.values || []).map((x) => x[0]);
    },
    async append(id, tab, rows) {
      await api.spreadsheets.values.append({ spreadsheetId: id, range: q(tab), valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } }, T);
    },
    async update(id, tab, rowNumber, row) {
      await api.spreadsheets.values.update({ spreadsheetId: id, range: `${q(tab)}!A${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [row] } }, T);
    },
  };
}

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Every 20 s, one PM2 worker at a time (Redis lock), when SHEETS_MIRROR=on. */
export function startSheetMirrorJob() {
  if (process.env.SHEETS_MIRROR !== 'on') return;
  let sheets;
  try { sheets = googleSheets(); } catch (e) { console.error('[sheet-mirror] disabled:', e.message); return; }
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    const token = randomUUID();
    let locked = false;
    try {
      // Bounded auth pre-warm: a hung token fetch must not hold a claim; skip the tick instead.
      await Promise.race([sheets.authorize(), new Promise((_, rej) => setTimeout(() => rej(new Error('Google auth timeout')), 20000).unref())]);
      locked = !!(await redis.set('lock:sheet-mirror', token, 'EX', 600, 'NX'));
      if (!locked) return;
      const r = await runSheetMirrorOnce(sheets, pool);
      if (r.done || r.failed) console.log(`[sheet-mirror] done=${r.done} failed=${r.failed}`);
    } catch (e) {
      console.error('[sheet-mirror]', e.message);
    } finally {
      if (locked) { try { await redis.eval(RELEASE, 1, 'lock:sheet-mirror', token); } catch (e) { console.error('[sheet-mirror] unlock:', e.message); } }
      running = false;
    }
  }, 20000);
}
