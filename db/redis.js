// db/redis.js — Redis client (local, localhost)
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on('error', (err) => {
  console.error('[Redis] Error:', err.message);
});

redis.on('connect', () => {
  console.log('[Redis] Connected to localhost');
});

export default redis;
export { redis };
