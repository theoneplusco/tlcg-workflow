// api/handlers/sse.js — Server-Sent Events for real-time updates
import redis from '../../db/redis.js';

export async function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Cloudflare/Nginx: disable buffering
  });

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Subscribe to Redis pub/sub channel
  const subscriber = redis.duplicate();
  await subscriber.subscribe('tlcg:events');

  subscriber.on('message', (_channel, message) => {
    res.write(`data: ${message}\n\n`);
  });

  // Heartbeat every 30s — keeps connection alive through proxies
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  // Clean up on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    subscriber.quit();
  });
}

/**
 * Publish an event to all connected SSE clients (via Redis pub/sub).
 * Called from approval handlers after a state change.
 */
export async function publishEvent(type, data) {
  try {
    await redis.publish('tlcg:events', JSON.stringify({
      type,
      data,
      timestamp: Date.now(),
    }));
  } catch (err) {
    console.error('[SSE] Publish error (non-fatal):', err.message);
  }
}
