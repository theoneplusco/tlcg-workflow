/**
 * TLCG Workflow — self-hosted server (Mac Mini edition).
 *
 * PM2 cluster mode (8 workers, one per M1 Pro core).
 * Routes new actions to Postgres handlers; unmigrated actions
 * still proxy to the old GAS backends.
 *
 * Start:  pm2 start ecosystem.config.cjs
 * Env:    see .env (DATABASE_URL, REDIS_URL, R2_*, RESEND_API_KEY, etc.)
 */

import 'dotenv/config'; // .env on the Mini (PM2 also loads it via ecosystem.config.cjs)
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import voucherHandler from './api/voucher.js';
import actionHandler from './api/voucher/[action].js';
import driveUploadHandler from './api/drive-upload.js';
import voucherFileHandler from './api/voucher-file.js';
import configHandler from './api/config.js';

// New handlers (Postgres)
import { routeNewAction, migratedActions, postgresWorkflows } from './api/router.js';
import { handleVoucherFileUpload } from './api/handlers/files.js';
import { handleSSE } from './api/handlers/sse.js';
import { handlePresign } from './api/handlers/presign.js';
import { handleHealth } from './api/handlers/health.js';
import { startEmailWorker } from './api/handlers/email-queue.js';
import { startVoucherReminderJob } from './api/jobs/voucher-reminders.js';
import { startSheetMirrorJob } from './api/jobs/sheet-mirror.js';
import { rateLimit } from './api/middleware/rate-limiter.js';
import { unwrapPayload } from './api/middleware/unwrap-payload.js';
import { missingVoucherSchema } from './api/lib/startup-checks.js';
import { jwtSecret } from './api/handlers/auth.js';
import pool from './db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();

app.set('trust proxy', true);
app.disable('x-powered-by');

/* ─────────────────────────────────────────────────────────────
   1. Multipart upload — MUST be before body parser.
   ───────────────────────────────────────────────────────────── */
app.post('/api/drive-upload', driveUploadHandler);
// Postgres/R2 path is rate limited (keyed by IP: the multipart body is not parsed yet); GAS path unchanged
if (postgresWorkflows.includes('files')) app.post('/api/voucher-file', rateLimit, handleVoucherFileUpload);
else app.post('/api/voucher-file', voucherFileHandler);

/* ─────────────────────────────────────────────────────────────
   2. Body parsing.
   ───────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '48mb' }));
app.use(express.urlencoded({ extended: true, limit: '48mb' }));

/* ─────────────────────────────────────────────────────────────
   3. New API routes (Postgres + Redis + R2).
   ───────────────────────────────────────────────────────────── */

// SSE — real-time updates (Redis pub/sub)
app.get('/api/events', handleSSE);

// R2 presigned URL — direct file upload
app.post('/api/presign', handlePresign);

// Health check
app.get('/api/health', handleHealth);

/* ─────────────────────────────────────────────────────────────
   4. /api/voucher — the main action router.
      New actions go to Postgres handlers; old actions proxy to GAS.
      Rate limiter applies to all.
   ───────────────────────────────────────────────────────────── */
app.all('/api/voucher/:action', unwrapPayload, async (req, res) => {
  const action = req.params.action;

  // Check if this action is migrated to the new backend
  if (migratedActions.includes(action)) {
    // Apply rate limiting for new actions
    await new Promise((resolve) => {
      rateLimit(req, res, () => resolve());
    });
    if (res.headersSent) return; // rate limiter responded
    try {
      req.body = req.unwrapped.payload; // data={json} / multipart payloads, unwrapped
      await routeNewAction(action, req, res);
    } catch (err) {
      console.error(`[router] New handler error (${action}):`, err.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
    return;
  }

  // Fall through to old GAS proxy
  req.query = Object.assign({}, req.query, { action });
  return actionHandler(req, res);
});

app.all('/api/voucher', unwrapPayload, async (req, res) => {
  // Action from the query, the body, or inside data={json} / multipart (see unwrap-payload.js)
  const action = req.unwrapped.action;
  if (action && migratedActions.includes(action)) {
    await new Promise((resolve) => {
      rateLimit(req, res, () => resolve());
    });
    if (res.headersSent) return;
    try {
      req.body = req.unwrapped.payload;
      await routeNewAction(action, req, res);
    } catch (err) {
      console.error(`[router] New handler error (${action}):`, err.message);
      if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
    }
    return;
  }
  return voucherHandler(req, res);
});

app.all('/api/config', configHandler);

/* ─────────────────────────────────────────────────────────────
   5. Static site (same as before).
   ───────────────────────────────────────────────────────────── */
app.use(
  express.static(__dirname, {
    extensions: ['html'],
    index: 'index.html',
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  })
);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ─────────────────────────────────────────────────────────────
   6. Error handling.
   ───────────────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, message: 'Internal server error' });
});

/* ─────────────────────────────────────────────────────────────
   7. Start.
   ───────────────────────────────────────────────────────────── */
// Vouchers on Postgres need migration 006 (sheet_outbox): refuse to boot without it so PM2 shows the error.
const schemaProblem = await missingVoucherSchema(postgresWorkflows, pool);
if (schemaProblem) {
  console.error(`[server] FATAL: ${schemaProblem}`);
  process.exit(1);
}
if (postgresWorkflows.includes('vouchers') && !process.env.VOUCHER_SPREADSHEET_ID) {
  console.warn('[server] Sheet copy disabled: VOUCHER_SPREADSHEET_ID not set');
}
// No dev default in production: logins are refused until JWT_SECRET is set (GAS proxy keeps working).
if (!jwtSecret()) console.error('[server] JWT_SECRET is not set (NODE_ENV=production): login and token checks are refused');

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] TLCG Workflow on http://${HOST}:${PORT} (worker ${process.pid})`);
  console.log(`[server] Migrated actions (${migratedActions.length}): ${migratedActions.join(', ')}`);
  console.log(`[server] Workflows on Postgres: ${postgresWorkflows.join(', ') || 'none (all workflows → GAS)'}`);
  console.log(`[server] Unmigrated actions → GAS proxy`);

  // Start the background email worker
  startEmailWorker();
  // Reminders for vouchers on Postgres only — while vouchers run on GAS, its trigger sends them
  if (postgresWorkflows.includes('vouchers')) startVoucherReminderJob();
  // One-way Postgres → Google Sheet copy (self-gates on SHEETS_MIRROR=on)
  startSheetMirrorJob();

  // Warn about missing env vars
  const required = ['DATABASE_URL', 'REDIS_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn('[server] Missing env vars:', missing.join(', '));
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, closing... (worker ${process.pid})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
