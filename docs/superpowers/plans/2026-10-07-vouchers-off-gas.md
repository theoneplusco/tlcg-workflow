# Vouchers Fully Off GAS Implementation Plan (Plan 4 of the GAS exit roadmap)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With `PG_WORKFLOWS` containing `vouchers` and `files`, no voucher action reaches Google Apps Script. Attachments go to R2, signature images are fetched by the Mini, and the Google Sheet is kept up to date by a one-way copy from Postgres.

**Architecture:**
- **Attachments.** Use R2 presigned PUT, the same browser flow the page already uses for Drive's resumable upload.
- **Signature fetch.** A small Node fetcher with a host allow-list.
- **Sheet copy.** A generic outbox (`sheet_outbox`), written in the same transaction as the voucher change. One worker, behind a Redis lock, writes rows to the Sheet by header name, so the Sheet's column order never matters.

**Tech Stack:**
- Node 24 ESM and Express.
- `pg`, `ioredis`.
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (already installed).
- `googleapis` ^144 (already installed).
- `node:test`.

## Global Constraints
- GAS mode stays unchanged. Every new route is registered only when its workflow key is in `PG_WORKFLOWS` (new key: `files`).
- Run tests with `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`. All tests must pass.
- Before you start, run `psql tlcg_v_test -c "truncate approval_flows, email_queue"`.
- No secrets in git.
  - The service-account key lives at `secrets/sheets-mirror.json`, which is gitignored.
  - Its path comes from `SHEETS_MIRROR_KEY_FILE`.
- The Sheet copy must never block or fail an approval. Errors are retried with backoff and shown in `/api/health`.
- Vietnamese user-facing messages match GAS wording where GAS had one.
- Do not switch production. Deploying to the Mini is fine; `PG_WORKFLOWS` on the Mini stays as is.

## File Structure
- Create `api/lib/files/r2.js`: the shared S3 client and an attachment key builder. `presign.js` is refactored to use it.
- Create `api/handlers/files.js`: createVoucherUploadSession, finalizeVoucherUpload, fetchSignatureImage, and a server-side upload for `/api/voucher-file`.
- Create `api/lib/files/signature-fetch.js`: the pure helpers driveDownloadUrl and isAllowedImageUrl.
- Create `db/migrations/006_sheet_outbox.sql`.
- Create `api/lib/sheets/rows.js`: pure; turns a record into a row for a given header row.
- Create `api/lib/sheets/voucher-records.js`: pure; voucher and history rows → sheet records. It is the inverse of `scripts/import-vouchers.js`.
- Create `api/lib/sheets/outbox.js`: `enqueue(client, item)`.
- Create `api/jobs/sheet-mirror.js`: the worker.
- Create `scripts/check-sheet-access.js`: prints whether the service account can read and write the spreadsheet.
- Modify:
  - `api/router.js`: the `files` workflow key and the syncToSheets no-op.
  - `api/handlers/vouchers.js`: enqueue the Sheet copy inside the existing transactions.
  - `server.js`: `/api/voucher-file` uses R2 when `files` is on, and the mirror job starts.
  - `api/handlers/health.js`: outbox depth.
  - `voucher.html`: `uploadLargeAttachment` understands the R2 session.
- Tests:
  - `tests/files/r2.test.js`
  - `tests/files/signature-fetch.test.js`
  - `tests/sheets/rows.test.js`
  - `tests/sheets/voucher-records.test.js`
  - `tests/sheets/outbox.test.js` (DB)

---

### Task 1: Voucher attachments on R2

**Files:**
- Create: `api/lib/files/r2.js`, `api/handlers/files.js`
- Modify:
  - `api/handlers/presign.js`: use `getS3`, `R2_BUCKET` and `R2_PUBLIC_URL` from r2.js.
  - `api/router.js`: `WORKFLOW_ACTIONS.files`.
  - `server.js:47`: `/api/voucher-file`.
  - `voucher.html:4720-4762`.
- Test: `tests/files/r2.test.js`

**Interfaces:**
- Produces:
  - `attachmentKey(voucherNumber: string, fileName: string, rand?: string) → string`, for example `vouchers/MI-PC2026…/3f9c…-hoa_don.pdf`.
  - `validateUpload({fileSize, fileName}) → string|null`: the Vietnamese error, or null.
  - `getS3() → S3Client|null`, plus `R2_BUCKET` and `R2_PUBLIC_URL`.
  - Actions:
    - `createVoucherUploadSession` returns `{ uploadUrl, key, fileUrl }`.
    - `finalizeVoucherUpload {key, fileName}` returns `{ fileName, fileUrl, fileSize }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/files/r2.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentKey, validateUpload } from '../../api/lib/files/r2.js';

test('attachmentKey: per-voucher folder, unguessable prefix, safe name', () => {
  const k = attachmentKey('MI-PC20261007000001', 'Hoá đơn tháng 9.pdf', 'abc123');
  assert.equal(k, 'vouchers/MI-PC20261007000001/abc123-Hoa_on_thang_9.pdf');
});
test('attachmentKey: missing voucher number goes to draft', () => {
  assert.match(attachmentKey('', 'a.png'), /^vouchers\/draft\/[0-9a-f]{32}-a\.png$/);
});
test('validateUpload: GAS limits and messages', () => {
  assert.equal(validateUpload({ fileSize: 0, fileName: 'a' }), 'File không hợp lệ');
  assert.equal(validateUpload({ fileSize: 10 * 1024 * 1024 + 1, fileName: 'a' }), 'File không hợp lệ');
  assert.equal(validateUpload({ fileSize: 1000, fileName: 'a.pdf' }), null);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `node --test tests/files/r2.test.js`. Expected: FAIL with "Cannot find module …/r2.js".

- [ ] **Step 3: Implement r2.js**

```js
// api/lib/files/r2.js — R2 (S3 API) client and key rules shared by presign + voucher files.
import crypto from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';

export const R2_BUCKET = process.env.R2_BUCKET_NAME || 'tlcg-attachments';
export const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://attachments.tl-c.us';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // same limit as GAS

let client = null;
export function getS3() {
  if (client) return client;
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });
  return client;
}

const safe = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

/** Links are public like Drive "anyone with the link"; the random part keeps them unguessable. */
export function attachmentKey(voucherNumber, fileName, rand = crypto.randomBytes(16).toString('hex')) {
  return `vouchers/${safe(voucherNumber) || 'draft'}/${rand}-${safe(fileName) || 'attachment'}`;
}

export function validateUpload({ fileSize, fileName }) {
  const size = Number(fileSize);
  if (!(size > 0 && size <= MAX_ATTACHMENT_BYTES) || !fileName) return 'File không hợp lệ';
  return null;
}
```

Note: "đ" has no Unicode decomposition, so the safe name of `Hoá đơn tháng 9.pdf` is `Hoa_on_thang_9.pdf`. This was checked with node.

- [ ] **Step 4: Implement the handlers and wire them up**

```js
// api/handlers/files.js — voucher attachments on R2 + signature images (replaces GAS/Drive).
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import busboy from 'busboy';
import { getS3, R2_BUCKET, R2_PUBLIC_URL, attachmentKey, validateUpload, MAX_ATTACHMENT_BYTES } from '../lib/files/r2.js';
import { driveDownloadUrl, isAllowedImageUrl, MAX_IMAGE_BYTES } from '../lib/files/signature-fetch.js';

const ok = (res, message, data) => res.json({ success: true, message, data });
const fail = (res, message, status = 200) => res.status(status).json({ success: false, message });

export async function handleCreateVoucherUploadSession(req, res) {
  const b = req.body || {};
  const bad = validateUpload(b);
  if (bad) return fail(res, bad);
  const s3 = getS3();
  if (!s3) return fail(res, 'Không tạo được phiên tải lên (R2 chưa cấu hình)');
  const key = attachmentKey(b.voucherNumber, b.fileName);
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, ContentType: b.mimeType || 'application/octet-stream',
  }), { expiresIn: 3600 });
  return ok(res, 'ok', { uploadUrl, key, fileUrl: `${R2_PUBLIC_URL}/${key}` });
}

export async function handleFinalizeVoucherUpload(req, res) {
  const b = req.body || {};
  const key = String(b.key || '');
  if (!/^vouchers\/[A-Za-z0-9._-]+\/[0-9a-f]{32}-[A-Za-z0-9._-]+$/.test(key)) return fail(res, 'fileId không hợp lệ');
  const s3 = getS3();
  if (!s3) return fail(res, 'Không lưu được file: R2 chưa cấu hình');
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return ok(res, 'Đã tải file', { fileName: b.fileName || key.split('/').pop().slice(33), fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: head.ContentLength });
  } catch (e) {
    return fail(res, 'Không lưu được file: ' + (e.name === 'NotFound' ? 'file chưa được tải lên' : e.message));
  }
}

/** /api/voucher-file (multipart: voucherNumber, file) — fallback when the browser cannot PUT to R2. */
export function handleVoucherFileUpload(req, res) {
  const s3 = getS3();
  if (!s3) return fail(res, 'R2 chưa cấu hình', 503);
  const fields = {};
  let upload = null;
  const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_ATTACHMENT_BYTES + 1 } });
  bb.on('field', (n, v) => { fields[n] = v; });
  bb.on('file', (_n, stream, info) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => { size += c.length; chunks.push(c); });
    stream.on('end', () => { upload = { name: info.filename, mime: info.mimeType, size, body: Buffer.concat(chunks), truncated: stream.truncated }; });
  });
  bb.on('close', async () => {
    if (!upload || upload.truncated) return fail(res, upload ? 'File vượt quá 10 MB' : 'Thiếu dữ liệu file');
    const bad = validateUpload({ fileSize: upload.size, fileName: upload.name });
    if (bad) return fail(res, bad);
    const key = attachmentKey(fields.voucherNumber, upload.name);
    try {
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: upload.body, ContentType: upload.mime }));
      return ok(res, 'Đã tải file', { fileName: upload.name, fileUrl: `${R2_PUBLIC_URL}/${key}`, fileSize: upload.size });
    } catch (e) { return fail(res, 'Không lưu được file: ' + e.message, 502); }
  });
  req.pipe(bb);
}

export async function handleFetchSignatureImage(req, res) {
  const url = String((req.body || {}).imageUrl || '');
  if (!url) return fail(res, 'Thiếu URL hình ảnh');
  if (!isAllowedImageUrl(url)) return fail(res, 'URL hình ảnh không được phép');
  try {
    const r = await fetch(driveDownloadUrl(url), { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) return fail(res, `Không tải được hình ảnh (HTTP ${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return fail(res, 'Hình ảnh quá lớn');
    const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
    if (!/^image\//.test(mime)) return fail(res, 'Tệp không phải hình ảnh');
    return ok(res, 'Success', { imageBase64: `data:${mime};base64,${buf.toString('base64')}` });
  } catch (e) { return fail(res, 'Lỗi: ' + e.message); }
}
```

Changes to `api/router.js`:
- Import the four handlers.
- Add them to `NEW_HANDLERS`: `createVoucherUploadSession`, `finalizeVoucherUpload` and `fetchSignatureImage`.
- Add the key `files: ['createVoucherUploadSession', 'finalizeVoucherUpload', 'fetchSignatureImage']` to `WORKFLOW_ACTIONS`.

`server.js:47`. Keep the GAS handler unless `files` is on:

```js
import { handleVoucherFileUpload } from './api/handlers/files.js';
import { postgresWorkflows } from './api/router.js';
app.post('/api/voucher-file', postgresWorkflows.includes('files') ? handleVoucherFileUpload : voucherFileHandler);
```

`voucher.html` `uploadLargeAttachment`: R2 sessions return `key`, and R2's PUT response has no JSON body. Replace the block from `const put = await fetch(` through the `finalizeVoucherUpload` call with:

```js
                const put = await fetch(session.uploadUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': file.type || 'application/octet-stream' },
                    body: file,
                    signal: httpTimeoutSignal(VOUCHER_SUBMIT_FETCH_TIMEOUT_MS)
                });
                if (session.key) {
                    // R2 (Mini): empty 200 body; the server checks the object exists
                    if (!put.ok) throw new Error('R2 từ chối file');
                    uploaded = await voucherApi({ action: 'finalizeVoucherUpload', key: session.key, fileName: file.name });
                } else {
                    // Drive (GAS): JSON body with the file id
                    const putText = await put.text();
                    let created = {};
                    try { created = JSON.parse(putText); } catch (e) { created = {}; }
                    if (!put.ok || !created.id) throw new Error('Drive từ chối file');
                    uploaded = await voucherApi({ action: 'finalizeVoucherUpload', fileId: created.id });
                }
```

- [ ] **Step 5: Run the tests**

Run `node --test tests/files/r2.test.js`. Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add api/lib/files/r2.js api/handlers/files.js api/handlers/presign.js api/router.js server.js voucher.html tests/files/r2.test.js
git commit -m "feat(files): voucher attachments on R2 behind PG_WORKFLOWS=files"
```

---

### Task 2: Signature images fetched by the Mini

**Files:**
- Create: `api/lib/files/signature-fetch.js`
- Test: `tests/files/signature-fetch.test.js`

**Interfaces:**
- Produces:
  - `driveDownloadUrl(url) → string`: GAS's conversion rules.
  - `isAllowedImageUrl(url) → boolean`.
  - `MAX_IMAGE_BYTES = 5 MB`.
- Consumed by `handleFetchSignatureImage` (Task 1).

- [ ] **Step 1: Write the failing test**

```js
// tests/files/signature-fetch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveDownloadUrl, isAllowedImageUrl } from '../../api/lib/files/signature-fetch.js';

test('driveDownloadUrl: the three Drive formats GAS handled', () => {
  const d = 'https://drive.google.com/uc?export=download&id=1AbC_d-9xyz';
  assert.equal(driveDownloadUrl('https://drive.google.com/file/d/1AbC_d-9xyz/view?usp=sharing'), d);
  assert.equal(driveDownloadUrl('https://drive.google.com/open?id=1AbC_d-9xyz'), d);
  assert.equal(driveDownloadUrl('https://drive.google.com/uc?id=1AbC_d-9xyz'), d);
  assert.equal(driveDownloadUrl('https://attachments.tl-c.us/sig/a.png'), 'https://attachments.tl-c.us/sig/a.png');
});
test('isAllowedImageUrl: Drive, Google image hosts and our R2 only (no SSRF)', () => {
  assert.equal(isAllowedImageUrl('https://drive.google.com/file/d/x/view'), true);
  assert.equal(isAllowedImageUrl('https://lh3.googleusercontent.com/d/x'), true);
  assert.equal(isAllowedImageUrl('https://attachments.tl-c.us/a.png'), true);
  assert.equal(isAllowedImageUrl('http://drive.google.com/x'), false);
  assert.equal(isAllowedImageUrl('https://127.0.0.1/x'), false);
  assert.equal(isAllowedImageUrl('https://drive.google.com.evil.io/x'), false);
  assert.equal(isAllowedImageUrl('not a url'), false);
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run `node --test tests/files/signature-fetch.test.js`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// api/lib/files/signature-fetch.js — rules for fetching sample signature images (pure).
import { R2_PUBLIC_URL } from './r2.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** GAS handleFetchSignatureImage: Drive share links → direct download. */
export function driveDownloadUrl(url) {
  if (!String(url).includes('drive.google.com')) return url;
  const id = (url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || [])[1];
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'lh3.googleusercontent.com', 'drive.usercontent.google.com']);

export function isAllowedImageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  let r2Host = '';
  try { r2Host = new URL(R2_PUBLIC_URL).host; } catch { /* unset */ }
  return ALLOWED_HOSTS.has(u.host) || (!!r2Host && u.host === r2Host);
}
```

- [ ] **Step 4: Run the tests**

Run `node --test tests/files/`. Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/lib/files/signature-fetch.js tests/files/signature-fetch.test.js
git commit -m "feat(files): fetch sample signature images on the Mini (Drive links, host allow-list)"
```

---

### Task 3: Sheet copy engine (outbox + header-driven rows)

**Files:**
- Create:
  - `db/migrations/006_sheet_outbox.sql`
  - `api/lib/sheets/rows.js`
  - `api/lib/sheets/outbox.js`
  - `api/jobs/sheet-mirror.js`
  - `scripts/check-sheet-access.js`
- Modify:
  - `server.js`: start the job when `SHEETS_MIRROR=on`.
  - `api/handlers/health.js`: `sheetOutboxDepth`.
- Test: `tests/sheets/rows.test.js`, `tests/sheets/outbox.test.js`

**Interfaces:**
- Produces:
  - `rowForHeader(header: string[], record: object) → string[]`. It matches header to key after trimming and case-folding. Unknown headers give `''`.
  - `enqueue(client, { spreadsheetId, tab, mode: 'append'|'upsert', keyColumn?, record })`.
  - `startSheetMirrorJob()` and `runSheetMirrorOnce(sheetsApi)`, which returns `{ done, failed }`.
- `mode: 'upsert'` replaces the row whose `keyColumn` value equals `record[keyColumn]`, or appends one if there is none.

- [ ] **Step 1: Migration**

```sql
-- db/migrations/006_sheet_outbox.sql — one-way Postgres → Google Sheet copy queue
CREATE TABLE IF NOT EXISTS sheet_outbox (
  id BIGSERIAL PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  tab TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('append', 'upsert')),
  key_column TEXT,
  record JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_try_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sheet_outbox_pending ON sheet_outbox (next_try_at) WHERE done_at IS NULL;
```

Apply it: `psql tlcg_v_test -f db/migrations/006_sheet_outbox.sql`. Expected: `CREATE TABLE`, `CREATE INDEX`.

- [ ] **Step 2: Write the failing tests**

```js
// tests/sheets/rows.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowForHeader, backoffSeconds } from '../../api/lib/sheets/rows.js';

test('rowForHeader: fills by header name, any column order, unknown → empty', () => {
  const header = ['voucher_number', ' Status ', 'MetaJSON', 'Extra column'];
  assert.deepEqual(rowForHeader(header, { status: 'Đã duyệt', voucher_number: 'A1', metajson: '{"a":1}' }),
    ['A1', 'Đã duyệt', '{"a":1}', '']);
});
test('rowForHeader: numbers stay numbers, null → empty', () => {
  assert.deepEqual(rowForHeader(['amount', 'note'], { amount: 2500000, note: null }), [2500000, '']);
});
test('backoffSeconds: 30s doubling, capped at 1h', () => {
  assert.deepEqual([1, 2, 3, 10].map(backoffSeconds), [30, 60, 120, 3600]);
});
```

```js
// tests/sheets/outbox.test.js — needs TEST_DATABASE_URL
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { enqueue } from '../../api/lib/sheets/outbox.js';
import { runSheetMirrorOnce } from '../../api/jobs/sheet-mirror.js';

const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

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
  await db.end();
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test node --test tests/sheets/`. Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

```js
// api/lib/sheets/rows.js — record → sheet row by header name (pure).
const norm = (h) => String(h || '').trim().toLowerCase();

export function rowForHeader(header, record) {
  const byKey = {};
  for (const [k, v] of Object.entries(record || {})) byKey[norm(k)] = v;
  return header.map((h) => {
    const v = byKey[norm(h)];
    return v == null ? '' : v;
  });
}

export const backoffSeconds = (attempt) => Math.min(3600, 30 * 2 ** (attempt - 1));
```

```js
// api/lib/sheets/outbox.js — queue a Sheet write inside the caller's transaction.
export async function enqueue(client, { spreadsheetId, tab, mode, keyColumn = null, record }) {
  await client.query(
    'INSERT INTO sheet_outbox (spreadsheet_id, tab, mode, key_column, record) VALUES ($1, $2, $3, $4, $5)',
    [spreadsheetId, tab, mode, keyColumn, JSON.stringify(record)]
  );
}
```

```js
// api/jobs/sheet-mirror.js — one worker drains sheet_outbox into Google Sheets (one-way copy).
import fs from 'node:fs';
import { google } from 'googleapis';
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { rowForHeader, backoffSeconds } from '../lib/sheets/rows.js';

const norm = (h) => String(h || '').trim().toLowerCase();
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

export async function runSheetMirrorOnce(sheets, db = pool, limit = 200) {
  const { rows: items } = await db.query(
    'SELECT * FROM sheet_outbox WHERE done_at IS NULL AND next_try_at <= NOW() ORDER BY id LIMIT $1', [limit]);
  const cache = new Map(); // tab → values (header + rows), refreshed per run
  let done = 0, failed = 0;
  for (const it of items) {
    const ck = it.spreadsheet_id + '\u0000' + it.tab;
    try {
      if (!cache.has(ck)) cache.set(ck, await sheets.getValues(it.spreadsheet_id, it.tab));
      const values = cache.get(ck);
      const header = values[0] || [];
      if (!header.length) throw new Error(`Tab ${it.tab} has no header row`);
      const row = rowForHeader(header, it.record);
      let target = -1;
      if (it.mode === 'upsert') {
        const col = header.findIndex((h) => norm(h) === norm(it.key_column));
        if (col < 0) throw new Error(`Key column ${it.key_column} not in ${it.tab}`);
        const key = String(it.record[it.key_column] ?? it.record[norm(it.key_column)] ?? '');
        target = values.findIndex((r, i) => i > 0 && String(r[col] ?? '') === key);
      }
      if (target > 0) { await sheets.update(it.spreadsheet_id, it.tab, target + 1, row); values[target] = row; }
      else { await sheets.append(it.spreadsheet_id, it.tab, row); values.push(row); }
      await db.query('UPDATE sheet_outbox SET done_at = NOW(), last_error = NULL WHERE id = $1', [it.id]);
      done += 1;
    } catch (e) {
      const attempts = it.attempts + 1;
      await db.query(
        `UPDATE sheet_outbox SET attempts = $2, last_error = $3, next_try_at = NOW() + ($4 || ' seconds')::interval WHERE id = $1`,
        [it.id, attempts, String(e.message).slice(0, 500), String(backoffSeconds(attempts))]);
      cache.delete(ck);
      failed += 1;
    }
  }
  return { done, failed };
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
      const r = await runSheetMirrorOnce(sheets);
      if (r.done || r.failed) console.log(`[sheet-mirror] done=${r.done} failed=${r.failed}`);
    } catch (e) { console.error('[sheet-mirror]', e.message); }
    finally { await redis.del('lock:sheet-mirror'); }
  }, 20000);
}
```

`db/pool.js` and `db/redis.js` are the same imports `api/jobs/voucher-reminders.js` uses.

`server.js`: next to `startVoucherReminderJob()`, add `import { startSheetMirrorJob } from './api/jobs/sheet-mirror.js';` and `startSheetMirrorJob();`.

`api/handlers/health.js`: add `sheetOutboxDepth` to `checks`. Use `SELECT count(*)::int AS n FROM sheet_outbox WHERE done_at IS NULL`, wrapped in try/catch so a missing table reports `null`.

```js
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
  const a1 = (await api.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'!A1` })).data.values || [['']];
  await api.spreadsheets.values.update({ spreadsheetId: id, range: `'${tab}'!A1`, valueInputOption: 'RAW', requestBody: { values: a1 } });
  console.log('WRITE ok (Editor access confirmed for', key.client_email + ')');
} catch (e) {
  console.log('FAILED:', e.code || '', e.message, '\n→ Share the spreadsheet with', key.client_email, 'as Editor');
  process.exitCode = 1;
}
```

- [ ] **Step 5: Run the tests**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 node --test --test-concurrency=1 tests/sheets/`. Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/006_sheet_outbox.sql api/lib/sheets api/jobs/sheet-mirror.js scripts/check-sheet-access.js server.js api/handlers/health.js tests/sheets
git commit -m "feat(sheets): one-way Postgres → Google Sheet copy (outbox, header-driven rows, retry)"
```

---

### Task 4: Vouchers write to the Sheet copy; syncToSheets replaced

**Files:**
- Create: `api/lib/sheets/voucher-records.js`
- Modify:
  - `api/handlers/vouchers.js`: next to every `appendHistory(client, …)` call, inside the same transaction.
  - `api/router.js`: the `syncToSheets` no-op under `vouchers`.
- Test: `tests/sheets/voucher-records.test.js`

**Interfaces:**
- Consumes:
  - `enqueue` (Task 3).
  - The voucher view and history objects already passed to `appendHistory` in `api/lib/vouchers/repo.js`.
- Produces:
  - `historyRecord(h) → object`, keyed by the Voucher_History headers from VOUCHER_WORKFLOW_RULES.md §12.
  - `currentRecord(view, h) → object`, keyed by the Voucher_Current headers.
  - `sheetTimeText(date) → 'yyyy-MM-dd HH:mm:ss'` in GMT. This is the inverse of `sheetTime` in scripts/import-vouchers.js, which uses `SHEET_UTC_OFFSET_HOURS = 0`.
  - `VOUCHER_SPREADSHEET_ID`.

- [ ] **Step 1: Read the real Voucher_Current header**

Run (local, with the CSV export the importer uses):

```bash
node scripts/import-vouchers.js --save-dir /tmp/vc --dry-run 2>/dev/null | head -3; head -1 /tmp/vc/Voucher_Current.csv; head -1 /tmp/vc/Voucher_History.csv
```

Expected: two header lines. Voucher_History must match §12 (voucher_number … acknowledged_at). Copy the exact Voucher_Current header into the `CURRENT_HEADERS` comment at the top of voucher-records.js. If `--save-dir` isn't supported by import-vouchers.js, use the CSV directory you imported from earlier (`--dir`).

- [ ] **Step 2: Write the failing test**

```js
// tests/sheets/voucher-records.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord, sheetTimeText } from '../../api/lib/sheets/voucher-records.js';
import { sheetTime } from '../../scripts/import-vouchers.js';

test('sheetTimeText is the inverse of the importer', () => {
  const d = new Date('2026-10-07T03:21:09Z');
  assert.equal(sheetTimeText(d), '2026-10-07 03:21:09');
  assert.equal(sheetTime(sheetTimeText(d)).toISOString(), d.toISOString());
});

test('historyRecord: Voucher_History columns (§12)', () => {
  const r = historyRecord({
    voucherNumber: 'MI-PC1', voucherType: 'Phiếu Chi', company: 'CÔNG TY MI', companyKey: 'M.I', employee: 'An',
    requestorEmail: 'an@x.vn', submittedBy: 'An', submittedAt: new Date('2026-10-07T01:00:00Z'), amount: 2500000,
    status: 'Đang treo', dueDate: '2026-12-31', action: 'Duyệt bởi Kế toán trưởng', attachments: [{ fileName: 'a.pdf', fileUrl: 'https://u' }],
    description: 'E2E', note: '', approverEmail: 'kt@x.vn', approvedAt: new Date('2026-10-07T02:00:00Z'), meta: { a: 1 }, acknowledgedAt: null,
  });
  assert.equal(r.voucher_number, 'MI-PC1');
  assert.equal(r.company_key_or_taxid, 'M.I');
  assert.equal(r.submited_email, 'an@x.vn'); // the sheet's own spelling
  assert.equal(r.submitted_at, '2026-10-07 01:00:00');
  assert.equal(r.approved_at, '2026-10-07 02:00:00');
  assert.equal(r.attachments, JSON.stringify([{ fileName: 'a.pdf', fileUrl: 'https://u' }]));
  assert.equal(r.MetaJSON, '{"a":1}');
  assert.equal(r.acknowledged_at, '');
});
```

If importing `scripts/import-vouchers.js` runs its main code or opens the DB on import, move `sheetTime` into `api/lib/sheets/voucher-records.js` instead. Have the importer import it from there, and import it from there in this test. The test hangs if the import opens a pool.

- [ ] **Step 3: Run the test and confirm it fails**

Run `node --test tests/sheets/voucher-records.test.js`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

```js
// api/lib/sheets/voucher-records.js — Postgres voucher state → Voucher_History / Voucher_Current rows.
// Inverse of scripts/import-vouchers.js. Sheet times are GMT text "yyyy-MM-dd HH:mm:ss".
// CURRENT_HEADERS (from the live sheet, Task 4 step 1): <paste the header line here when implementing>
export const VOUCHER_SPREADSHEET_ID = process.env.VOUCHER_SPREADSHEET_ID || '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g';
export const HISTORY_TAB = 'Voucher_History';
export const CURRENT_TAB = 'Voucher_Current';

export function sheetTimeText(d) {
  if (!d) return '';
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 19).replace('T', ' ');
}

const json = (v) => (v == null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v));

export function historyRecord(h) {
  return {
    voucher_number: h.voucherNumber, voucher_type: h.voucherType, company_name: h.company,
    company_key_or_taxid: h.companyKey, employee_name: h.employee, submited_email: h.requestorEmail,
    submitted_by: h.submittedBy, submitted_at: sheetTimeText(h.submittedAt), amount: h.amount,
    status: h.status, due_date: h.dueDate || '', action: h.action, attachments: json(h.attachments),
    description: h.description || '', note: h.note || '', approver_email: h.approverEmail || '',
    approved_at: sheetTimeText(h.approvedAt), MetaJSON: json(h.meta), acknowledged_at: sheetTimeText(h.acknowledgedAt),
  };
}

/** Voucher_Current is one row per voucher: the latest history fields, keyed by voucher_number. */
export function currentRecord(h) {
  return { ...historyRecord(h), metadata_json: json(h.meta) };
}
```

When you implement this, compare `currentRecord`'s keys with the real `CURRENT_HEADERS` from Step 1. Rename or add keys so every Voucher_Current header the importer reads has a value. Add a test asserting `Object.keys(currentRecord(sample))` covers those headers.

In `api/handlers/vouchers.js`, after each `await appendHistory(client, X)` (submit, approve, bulk approve, reject, acknowledge), add the following. `X` is the same object passed to `appendHistory`:

```js
    await mirrorVoucher(client, X);
```

At the top of the file:

```js
import { enqueue } from '../lib/sheets/outbox.js';
import { historyRecord, currentRecord, VOUCHER_SPREADSHEET_ID, HISTORY_TAB, CURRENT_TAB } from '../lib/sheets/voucher-records.js';

/** Same transaction as the change: the Sheet copy can lag but never miss or invent a row. */
async function mirrorVoucher(client, h) {
  await enqueue(client, { spreadsheetId: VOUCHER_SPREADSHEET_ID, tab: HISTORY_TAB, mode: 'append', record: historyRecord(h) });
  await enqueue(client, { spreadsheetId: VOUCHER_SPREADSHEET_ID, tab: CURRENT_TAB, mode: 'upsert', keyColumn: 'voucher_number', record: currentRecord(h) });
}
```

Check the field names `appendHistory` receives in `api/lib/vouchers/repo.js` (for example `approvedAt`, `meta`, `note`, `acknowledgedAt`). Where they differ from `historyRecord` above, map them in `historyRecord`, not at each call site.

`api/router.js`: add a `syncToSheets` handler that answers like GAS without touching Google (the outbox already queued the row). Add it to `WORKFLOW_ACTIONS.vouchers`:

```js
  syncToSheets: (req, res) => res.json({ success: true, message: 'Đã đồng bộ (bản sao Google Sheet tự cập nhật)' }),
```

- [ ] **Step 5: Extend the voucher handler test**

In `tests/vouchers/handlers.test.js`, after the existing full-approval scenario, assert that the outbox holds one `Voucher_History` append per history row and that the last `Voucher_Current` record has the final status:

```js
  const { rows: ob } = await db.query(
    `SELECT tab, mode, record FROM sheet_outbox WHERE record->>'voucher_number' = $1 ORDER BY id`, [voucherNumber]);
  assert.equal(ob.filter((r) => r.tab === 'Voucher_History').length, historyCount);
  assert.equal(ob.filter((r) => r.tab === 'Voucher_Current').at(-1).record.status, 'Đã duyệt');
```

Use the scenario's own variable names for `voucherNumber`, `historyCount` and the DB handle. Add `TRUNCATE sheet_outbox` to that file's setup.

- [ ] **Step 6: Run the full suite**

Run `TEST_DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 npm test`. Expected: all tests pass (73 + the new ones).

- [ ] **Step 7: Commit**

```bash
git add api/lib/sheets/voucher-records.js api/handlers/vouchers.js api/router.js tests/sheets/voucher-records.test.js tests/vouchers/handlers.test.js
git commit -m "feat(vouchers): every voucher change queues its Sheet copy; syncToSheets handled on the Mini"
```

---

### Task 5: End-to-end without GAS

**Files:** scratch Playwright script only (not committed); `docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md` (tick Plan 4).

- [ ] **Step 1: Block GAS in the local run**

Start the server with every GAS URL pointed at a dead address, so any accidental GAS call fails loudly:

```bash
PORT=3999 HOST=127.0.0.1 PG_WORKFLOWS=vouchers,files VOUCHER_REQUIRE_LOGIN=true APP_BASE_URL=http://tlcg.test:3999 \
TLCG_CASH_BACKEND_URL=http://127.0.0.1:9/gas TLCG_CORE_BACKEND_URL=http://127.0.0.1:9/gas TLCG_P2P_BACKEND_URL=http://127.0.0.1:9/gas \
DATABASE_URL=postgres://localhost:5432/tlcg_v_test REDIS_URL=redis://localhost:6379/15 RESEND_API_KEY= node server.js
```

Also check `api/voucher.js` and `api/voucher-file.js` for hardcoded `script.google.com` fallbacks, and point those at the dead address for this run too.

- [ ] **Step 2: Rerun the Phase 3 browser scenario, plus attachments**

Rerun the scratch `e2e.cjs` (custom M.I flow, group step, real signatures). Then add these checks:
- Submit a voucher with a 2 MB PDF through the page's Review & Submit. The stored `attachments` URL starts with `R2_PUBLIC_URL`, and fetching it returns 200.
- The approve page's sample signature loads through `fetchSignatureImage` on the Mini.
- The server log has no request to `127.0.0.1:9`.
- `sheet_outbox` has the expected rows. With `SHEETS_MIRROR=on` and a scratch copy of the spreadsheet, the rows appear in the right columns.

R2 needs the CORS rule from the roadmap's open items. If it's missing, the page falls back to `/api/voucher-file` (server upload). Test both paths.

- [ ] **Step 3: Confirm GAS mode is unchanged**

Rerun the scratch `gas-regress.cjs` with the server started without `PG_WORKFLOWS`. Expected: same 7 PASS.

- [ ] **Step 4: Clean up and commit the roadmap tick**

Run `psql tlcg_v_test -c "truncate approval_flows, email_queue, sheet_outbox"`. Then mark Plan 4 done in the roadmap and commit:

```bash
git add docs/superpowers/plans/2026-10-07-gas-exit-roadmap.md
git commit -m "docs: GAS exit roadmap - plan 4 done"
```
