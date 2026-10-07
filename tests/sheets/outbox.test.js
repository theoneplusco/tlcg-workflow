// needs TEST_DATABASE_URL
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { enqueue } from '../../api/lib/sheets/outbox.js';
import { runSheetMirrorOnce, pruneOutbox } from '../../api/lib/sheets/mirror-run.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
after(() => db.end());

function fakeSheets(tabs, opts = {}) {
  // tabs: { 'Voucher_Current': [[header…], [row…]] }
  const calls = { append: [] };
  return {
    calls,
    async getHeader(_id, tab) { return [...tabs[tab][0]]; },
    async getColumn(_id, tab, col) { return tabs[tab].map((r) => r[col]); },
    async append(_id, tab, rows) {
      calls.append.push(rows);
      await new Promise((r) => setTimeout(r, 20));
      for (const row of rows) tabs[tab].push(row);
    },
    async update(_id, tab, rowNumber, row) {
      if (opts.failUpdateOnce && row[1] === opts.failUpdateOnce.status && !opts.failUpdateOnce.done) {
        opts.failUpdateOnce.done = true;
        throw new Error('boom');
      }
      tabs[tab][rowNumber - 1] = row;
    },
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

test('FIFO per tab: failing head blocks later items until it succeeds', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { C: [['voucher_number', 'status'], ['V1', 'old']] };
  const fake = fakeSheets(tabs, { failUpdateOnce: { status: 'A' } });
  const rec = (status) => ({ spreadsheetId: 's', tab: 'C', mode: 'upsert', keyColumn: 'voucher_number', record: { voucher_number: 'V1', status } });
  await enqueue(db, rec('A'));
  await enqueue(db, rec('B'));
  assert.deepEqual(await runSheetMirrorOnce(fake, db), { done: 0, failed: 1 });
  assert.deepEqual(tabs.C[1], ['V1', 'old']);
  assert.deepEqual(await runSheetMirrorOnce(fake, db), { done: 0, failed: 0 }); // head backing off
  await db.query('UPDATE sheet_outbox SET next_try_at = NOW() WHERE done_at IS NULL');
  assert.deepEqual(await runSheetMirrorOnce(fake, db), { done: 2, failed: 0 });
  assert.deepEqual(tabs.C[1], ['V1', 'B']);
});

test('two concurrent runs append each row exactly once', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { H: [['voucher_number']] };
  const fake = fakeSheets(tabs);
  for (const n of ['1', '2', '3', '4']) await enqueue(db, { spreadsheetId: 's', tab: 'H', mode: 'append', record: { voucher_number: n } });
  const rs = await Promise.all([runSheetMirrorOnce(fake, db), runSheetMirrorOnce(fake, db)]);
  assert.equal(rs[0].done + rs[1].done, 4);
  assert.deepEqual(tabs.H.slice(1).map((r) => r[0]).sort(), ['1', '2', '3', '4']);
});

test('consecutive appends for one tab are sent as a single batch', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { H: [['voucher_number']] };
  const fake = fakeSheets(tabs);
  for (const n of ['a', 'b', 'c']) await enqueue(db, { spreadsheetId: 's', tab: 'H', mode: 'append', record: { voucher_number: n } });
  assert.deepEqual(await runSheetMirrorOnce(fake, db), { done: 3, failed: 0 });
  assert.equal(fake.calls.append.length, 1);
  assert.equal(fake.calls.append[0].length, 3);
});

test('deadline: stops starting groups and releases the rest untouched', async () => {
  await db.query('TRUNCATE sheet_outbox');
  const tabs = { C: [['voucher_number', 'status']] };
  const fake = fakeSheets(tabs);
  let late = false;
  const origAppend = fake.append;
  fake.append = async (...a) => { await origAppend(...a); late = true; };
  for (const n of ['1', '2', '3']) await enqueue(db, { spreadsheetId: 's', tab: 'C', mode: 'upsert', keyColumn: 'voucher_number', record: { voucher_number: n, status: 'x' } });
  const r = await runSheetMirrorOnce(fake, db, { now: () => (late ? 1e9 : 0), deadlineMs: 1000 });
  assert.deepEqual(r, { done: 1, failed: 0 });
  assert.equal(tabs.C.length, 2);
  const { rows } = await db.query('SELECT attempts, done_at IS NULL AS pending, next_try_at <= NOW() AS due FROM sheet_outbox WHERE done_at IS NULL');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.attempts === 0 && x.pending && x.due));
});

test('onError reports each failed item with its error (the worker logs it; /api/health does not)', async () => {
  await db.query('TRUNCATE sheet_outbox');
  await enqueue(db, { spreadsheetId: 's', tab: 'Missing', mode: 'append', record: { voucher_number: 'X' } });
  const seen = [];
  const r = await runSheetMirrorOnce(fakeSheets({}), db, { onError: (it, e) => seen.push([it.tab, it.attempts, e.message]) });
  assert.deepEqual(r, { done: 0, failed: 1 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'Missing');
  assert.equal(seen[0][1], 1, 'attempt number after this failure');
  assert.ok(seen[0][2]);
});

test('pruneOutbox: deletes items done over 30 days ago, at most once per claimed day', async () => {
  await db.query('TRUNCATE sheet_outbox');
  for (const n of ['old', 'recent', 'pending']) await enqueue(db, { spreadsheetId: 's', tab: 'H', mode: 'append', record: { n } });
  await db.query(`UPDATE sheet_outbox SET done_at = NOW() - interval '31 days' WHERE record->>'n' = 'old'`);
  await db.query(`UPDATE sheet_outbox SET done_at = NOW() - interval '29 days' WHERE record->>'n' = 'recent'`);
  await db.query(`UPDATE sheet_outbox SET created_at = NOW() - interval '60 days' WHERE record->>'n' = 'pending'`);
  let claims = 0;
  const once = async () => (claims += 1) === 1; // first call wins the day, later ones are refused
  assert.equal(await pruneOutbox(db, once), 1);
  await db.query(`UPDATE sheet_outbox SET done_at = NOW() - interval '31 days' WHERE record->>'n' = 'recent'`);
  assert.equal(await pruneOutbox(db, once), null, 'already ran today');
  const left = (await db.query(`SELECT record->>'n' AS n FROM sheet_outbox ORDER BY id`)).rows.map((x) => x.n);
  assert.deepEqual(left, ['recent', 'pending']);
});
