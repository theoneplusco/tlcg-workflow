#!/usr/bin/env node
/**
 * scripts/load-test.js — Quick load test for 100 concurrent users.
 *
 * Tests:
 *   1. 100 concurrent health checks
 *   2. 100 concurrent getMasterData (cache hit)
 *   3. 50 concurrent voucher summary queries
 */

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3001';

async function test(name, fn, concurrency) {
  const start = Date.now();
  const promises = Array.from({ length: concurrency }, () => fn());
  const results = await Promise.allSettled(promises);
  const elapsed = Date.now() - start;

  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.filter(r => r.status === 'rejected').length;
  const latencies = results
    .filter(r => r.status === 'fulfilled' && r.value?._latency !== undefined)
    .map(r => r.value._latency);

  const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)] || 0;
  const p99 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)] || 0;

  console.log(`\n${name}`);
  console.log(`  Concurrency: ${concurrency} | OK: ${ok} | Fail: ${fail} | Total: ${elapsed}ms`);
  console.log(`  Latency p50: ${p50}ms | p99: ${p99}ms`);
  return { name, ok, fail, elapsed, p50, p99 };
}

async function fetchJSON(path, method = 'GET', body) {
  const start = Date.now();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  json._latency = Date.now() - start;
  return json;
}

async function main() {
  console.log(`Load test against ${BASE}`);
  console.log('==========================================');

  // 1. Health (100 concurrent)
  await test('1. Health check (100 concurrent)', () => fetchJSON('/api/health'), 100);

  // 2. getMasterData (100 concurrent — first hits DB, rest hit cache)
  await test('2. getMasterData (100 concurrent — cache)', () =>
    fetchJSON('/api/voucher', 'POST', { action: 'getMasterData' }), 100);

  // 3. getVoucherSummary (50 concurrent)
  await test('3. getVoucherSummary (50 concurrent)', () =>
    fetchJSON('/api/voucher', 'POST', { action: 'getVoucherSummary' }), 50);

  // 4. SSE connections (10 concurrent, 2s each)
  console.log('\n4. SSE connections (10 concurrent)');
  const sseStart = Date.now();
  const ssePromises = Array.from({ length: 10 }, () =>
    fetch(`${BASE}/api/events`).then(r => r.text()).then(text => {
      return text.includes('connected') ? 'ok' : 'fail';
    })
  );
  const sseResults = await Promise.allSettled(ssePromises);
  console.log(`  OK: ${sseResults.filter(r => r.status === 'fulfilled').length}/10 | ${Date.now() - sseStart}ms`);

  console.log('\n==========================================');
  console.log('Load test complete.');
}

main().catch(console.error);
