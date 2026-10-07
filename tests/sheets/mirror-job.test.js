// startSheetMirrorJob must never start without an explicit target spreadsheet.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSheetMirrorJob } from '../../api/jobs/sheet-mirror.js';
import redis from '../../db/redis.js';
import pool from '../../db/pool.js';

after(async () => { await redis.quit(); await pool.end(); });

const withEnv = async (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const capture = async (fn) => {
  const lines = [];
  const { error, log } = console;
  console.error = (...a) => lines.push(a.join(' '));
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: await fn(), lines }; } finally { console.error = error; console.log = log; }
};

test('SHEETS_MIRROR off: not started', async () => {
  await withEnv({ SHEETS_MIRROR: undefined, VOUCHER_SPREADSHEET_ID: 'x' }, async () => {
    assert.equal(startSheetMirrorJob(), false);
  });
});
test('SHEETS_MIRROR=on without VOUCHER_SPREADSHEET_ID: refuses to start and says why', async () => {
  await withEnv({ SHEETS_MIRROR: 'on', VOUCHER_SPREADSHEET_ID: undefined, P2P_SPREADSHEET_ID: undefined }, async () => {
    const { result, lines } = await capture(() => startSheetMirrorJob());
    assert.equal(result, false);
    assert.match(lines.join('\n'), /VOUCHER_SPREADSHEET_ID/);
  });
});
test('SHEETS_MIRROR=on with a target: starts and logs the target id', async () => {
  await withEnv({ SHEETS_MIRROR: 'on', VOUCHER_SPREADSHEET_ID: 'sheet-123' }, async () => {
    const fake = { authorize: async () => {} };
    const { result, lines } = await capture(() => startSheetMirrorJob({ sheets: fake, intervalMs: 3600000 }));
    assert.equal(typeof result, 'object', 'returns the timer');
    clearInterval(result);
    assert.match(lines.join('\n'), /sheet-123/);
  });
});
test('SHEETS_MIRROR=on with only P2P_SPREADSHEET_ID: starts', async () => {
  await withEnv({ SHEETS_MIRROR: 'on', VOUCHER_SPREADSHEET_ID: undefined, P2P_SPREADSHEET_ID: 'p2p-456' }, async () => {
    const { result, lines } = await capture(() => startSheetMirrorJob({ sheets: { authorize: async () => {} }, intervalMs: 3600000 }));
    assert.equal(typeof result, 'object');
    clearInterval(result);
    assert.match(lines.join('\n'), /p2p-456/);
  });
});
