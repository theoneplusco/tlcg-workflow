// needs TEST_DATABASE_URL
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { enqueue } from '../../api/lib/sheets/outbox.js';
import { runSheetMirrorOnce } from '../../api/lib/sheets/mirror-run.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
after(() => db.end());

function fakeSheets(tabs) {
  // tabs: { 'Voucher_Current': [[header…], [row…]] }
  return {
    async getValues(_id, tab) { return tabs[tab].map((r) => [...r]); },
    async append(_id, tab, row) { tabs[tab].push(row); },
    async update(_id, tab, rowNumber, row) { tabs[tab][rowNumber - 1] = row; },
  };
}

test('worker appends history and upserts current by key', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { H: [['voucher_number', 'status']], C: [['voucher_number', 'status'], ['V1', 'Đang treo']] };
  await enqueue(db, { spreadsheetId: 's', tab: 'H', mode: 'append', record: { voucher_number: 'V1', status: 'Đã duyệt' } });
  await enqueue(db, { spreadsheetId: 's', tab: 'C', mode: 'upsert', keyColumn: 'voucher_number', record: { voucher_number: 'V1', status: 'Đã duyệt' } });
  await enqueue(db, { spreadsheetId: 's', tab: 'C', mode: 'upsert', keyColumn: 'voucher_number', record: { voucher_number: 'V2', status: 'Đang treo' } });
  const r = await runSheetMirrorOnce(fakeSheets(tabs), db);
  assert.deepEqual(r, { done: 3, failed: 0 });
  assert.deepEqual(tabs.H[1], ['V1', 'Đã duyệt']);
  assert.deepEqual(tabs.C.slice(1), [['V1', 'Đã duyệt'], ['V2', 'Đang treo']]);
});

test('a failing item is retried later and does not stop the others', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { H: [['voucher_number']] };
  await enqueue(db, { spreadsheetId: 's', tab: 'Missing', mode: 'append', record: { voucher_number: 'X' } });
  await enqueue(db, { spreadsheetId: 's', tab: 'H', mode: 'append', record: { voucher_number: 'Y' } });
  const r = await runSheetMirrorOnce(fakeSheets(tabs), db);
  assert.deepEqual(r, { done: 1, failed: 1 });
  const { rows } = await db.query('SELECT attempts, next_try_at > NOW() AS later FROM sheet_outbox WHERE tab = $1', ['Missing']);
  assert.equal(rows[0].attempts, 1);
  assert.equal(rows[0].later, true);
});
