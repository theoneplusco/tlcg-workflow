// scripts/check-sheet-access.js — can the mirror account read and write the spreadsheet?
// Usage: SHEETS_MIRROR_KEY_FILE=secrets/sheets-mirror.json node scripts/check-sheet-access.js <spreadsheetId>
import { google } from 'googleapis';
import fs from 'node:fs';
const id = process.argv[2];
const key = JSON.parse(fs.readFileSync(process.env.SHEETS_MIRROR_KEY_FILE, 'utf8'));
const auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
const api = google.sheets({ version: 'v4', auth });
try {
  const meta = await api.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title,sheets.properties.title' });
  console.log('READ ok:', meta.data.properties.title, '—', meta.data.sheets.map((s) => s.properties.title).join(', '));
  // A no-op write: rewrite A1 of the first tab with its current value
  const tab = meta.data.sheets[0].properties.title;
  const q = `'${tab.replace(/'/g, "''")}'!A1`;
  const a1 = (await api.spreadsheets.values.get({ spreadsheetId: id, range: q, valueRenderOption: 'FORMULA' })).data.values || [['']];
  await api.spreadsheets.values.update({ spreadsheetId: id, range: q, valueInputOption: 'USER_ENTERED', requestBody: { values: a1 } });
  console.log('WRITE ok (Editor access confirmed for', key.client_email + ')');
} catch (e) {
  console.log('FAILED:', e.code || '', e.message, '\n→ Share the spreadsheet with', key.client_email, 'as Editor');
  process.exitCode = 1;
}
