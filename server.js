/**
 * TLCG Workflow — self-hosted server.
 *
 * Runs the same code Vercel served, as a single long-lived Node process:
 *   - static files from the repo root (11 HTML pages, i18n.js, assets)
 *   - the existing api/ handlers, unmodified
 *
 * The api/ handlers are plain (req, res) functions with no Vercel-specific
 * imports, so they mount directly on Express.
 *
 * Start:  node server.js         (or via the systemd unit / PM2)
 * Env:    see .env.example
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import voucherHandler from './api/voucher.js';
import actionHandler from './api/voucher/[action].js';
import driveUploadHandler from './api/drive-upload.js';
import voucherFileHandler from './api/voucher-file.js';
import configHandler from './api/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // behind a reverse proxy by default

const app = express();

// Behind nginx/Caddy/Traefik: trust X-Forwarded-* so req.ip is the real client
// IP. api/voucher.js rate-limits per IP, so without this every request would
// look like it came from the proxy and share one bucket.
app.set('trust proxy', true);
app.disable('x-powered-by');

/* ─────────────────────────────────────────────────────────────
   1. Multipart upload — MUST be mounted before any body parser.
      api/drive-upload.js sets `bodyParser: false` on Vercel and
      parses the stream itself with busboy. A JSON/urlencoded
      parser running first would consume the stream and uploads
      would hang or fail.
   ───────────────────────────────────────────────────────────── */
app.post('/api/drive-upload', driveUploadHandler);
app.post('/api/voucher-file', voucherFileHandler);

/* ─────────────────────────────────────────────────────────────
   2. Body parsing for everything else.
      10mb matches the sizeLimit declared in api/voucher.js.
   ───────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ─────────────────────────────────────────────────────────────
   3. API routes.
   ───────────────────────────────────────────────────────────── */

// api/voucher/[action].js reads req.query.action (Vercel puts dynamic segments
// there). Express exposes it as req.params, so bridge it before delegating.
app.all('/api/voucher/:action', (req, res) => {
  req.query = Object.assign({}, req.query, { action: req.params.action });
  return actionHandler(req, res);
});

app.all('/api/voucher', voucherHandler);
app.all('/api/config', configHandler);

/* ─────────────────────────────────────────────────────────────
   4. Static site.
      vercel.json used cleanUrls:true, so /contract must resolve to
      contract.html. `extensions` reproduces that.
   ───────────────────────────────────────────────────────────── */
app.use(
  express.static(__dirname, {
    extensions: ['html'],
    index: 'index.html',
    dotfiles: 'ignore',
    setHeaders(res, filePath) {
      // HTML must revalidate so a deploy is picked up immediately;
      // fingerprint-free assets get a short cache.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    }
  })
);

// vercel.json rewrote / to index.html; anything unmatched falls back there.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ─────────────────────────────────────────────────────────────
   5. Error handling — never leak a stack trace to the client.
   ───────────────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  if (res.headersSent) return;
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] TLCG Workflow listening on http://${HOST}:${PORT}`);
  const missing = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'MASTER_SPREADSHEET_ID']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn('[server] Missing env vars (uploads/master data may fail): ' + missing.join(', '));
  }
});

// Let systemd restart us cleanly instead of dropping in-flight requests.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received, closing...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
