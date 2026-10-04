// ecosystem.config.js — PM2 cluster config for Mac Mini (M1 Pro, 8 cores)
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
      // Local services
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/tlcg_workflow',
      REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
      // Cloud services (R2 + Resend)
      R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID || '',
      R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
      R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
      R2_BUCKET_NAME: process.env.R2_BUCKET_NAME || 'tlcg-attachments',
      R2_PUBLIC_URL: process.env.R2_PUBLIC_URL || '',
      RESEND_API_KEY: process.env.RESEND_API_KEY || '',
      EMAIL_FROM: process.env.EMAIL_FROM || 'TLC Group Workflow <noreply@tl-c.us>',
      JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-in-production',
      // Keep GAS URLs during migration (parallel mode)
      TLCG_CASH_BACKEND_URL: process.env.TLCG_CASH_BACKEND_URL || '',
      TLCG_P2P_BACKEND_URL: process.env.TLCG_P2P_BACKEND_URL || '',
      TLCG_CORE_BACKEND_URL: process.env.TLCG_CORE_BACKEND_URL || '',
    },
  }],
};
