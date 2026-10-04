// db/cache.js — server-side LRU cache for master data
import { LRUCache } from 'lru-cache';

// Master data (employees, companies, goods) changes rarely — 5-min TTL
const cache = new LRUCache({
  max: 100,
  ttl: 5 * 60 * 1000, // 5 minutes
});

export default cache;
export { cache };
