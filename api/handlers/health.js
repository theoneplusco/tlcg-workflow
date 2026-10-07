// api/handlers/health.js — Health check endpoint
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';

export async function handleHealth(req, res) {
  const checks = {};
  const started = Date.now();

  // Postgres ping
  try {
    await pool.query('SELECT 1');
    checks.db = 'ok';
    checks.dbLatency = Date.now() - started;
  } catch (err) {
    checks.db = 'fail';
    checks.dbError = err.message;
  }

  // Redis ping
  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : 'fail';
    checks.redisLatency = Date.now() - started;
  } catch (err) {
    checks.redis = 'fail';
    checks.redisError = err.message;
  }

  // R2 — just check env vars are set (don't call R2 every time)
  checks.r2 = (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID) ? 'ok' : 'unconfigured';

  // Email queue depth
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*) as depth FROM email_queue WHERE status = 'pending'`
    );
    checks.emailQueueDepth = parseInt(rows[0].depth, 10);
  } catch {
    checks.emailQueueDepth = 'unknown';
  }

  // Sheet mirror outbox depth (null if the table is missing)
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM sheet_outbox WHERE done_at IS NULL');
    checks.sheetOutboxDepth = rows[0].n;
  } catch {
    checks.sheetOutboxDepth = null;
  }

  const allOk = checks.db === 'ok' && checks.redis === 'ok';
  const httpStatus = allOk ? 200 : 503;

  res.status(httpStatus).json({
    status: allOk ? 'healthy' : 'degraded',
    uptime: process.uptime(),
    checks,
    timestamp: new Date().toISOString(),
  });
}
