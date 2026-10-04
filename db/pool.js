// db/pool.js — Postgres connection pool (local, localhost)
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow',
  max: 20,                    // connections per PM2 worker (8 workers × 20 = 160 max)
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 3000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client:', err.message);
});

export default pool;
export { pool };
