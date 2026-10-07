// ecosystem.config.cjs — PM2 cluster config for Mac Mini (M1 Pro, 8 cores)
//
// Only variables that are actually set in PM2's environment are passed on. An unset variable is
// left out (not written as '' or a default), so server.js's dotenv can fill it from .env —
// dotenv never overrides a variable that already exists, even an empty one.
// Defaults live in the code (db/pool.js, db/redis.js, api/lib/files/r2.js, email-queue.js).
// JWT_SECRET has no default here or in production code: set it in .env.
const PASS_THROUGH = [
  // Local services
  'DATABASE_URL', 'REDIS_URL',
  // Cloud services (R2 + Resend)
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL',
  'RESEND_API_KEY', 'EMAIL_FROM',
  'JWT_SECRET',
  // Migration switches (see .env.example)
  'PG_WORKFLOWS', 'VOUCHER_REQUIRE_LOGIN', 'SHEETS_MIRROR', 'SHEETS_MIRROR_KEY_FILE', 'VOUCHER_SPREADSHEET_ID',
  // Keep GAS URLs during migration (parallel mode)
  'TLCG_CASH_BACKEND_URL', 'TLCG_P2P_BACKEND_URL', 'TLCG_CORE_BACKEND_URL',
];

const passed = Object.fromEntries(
  PASS_THROUGH.filter((k) => process.env[k] !== undefined && process.env[k] !== '').map((k) => [k, process.env[k]])
);

module.exports = {
  apps: [{
    name: 'tlcg-workflow',
    script: 'server.js',
    instances: 8,               // one per M1 Pro core
    exec_mode: 'cluster',
    max_memory_restart: '1G',   // restart a worker if it leaks
    env: {
      NODE_ENV: process.env.NODE_ENV || 'production',
      PORT: 3001,
      HOST: '127.0.0.1',
      ...passed,
    },
  }],
};
