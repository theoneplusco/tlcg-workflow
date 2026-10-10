// Vercel Serverless Function - Proxy for Google Apps Script
// Handles all voucher-related API calls
// Location: api/voucher/[action].js

// ---- In-memory cache for read-only actions (survives warm-instance reuse) ----
// Vercel's Edge Network does not cache POST responses regardless of
// Cache-Control headers, so this lives inside the warm function instance.
// First call warms the entry; subsequent calls to the same warm worker in
// the next CACHE_TTL_MS window return instantly without hitting GAS.
// Not a replacement for proper edge caching — that requires the caller to
// switch to GET, in which case the Cache-Control headers set below take
// over. See .cursor/skills/audit-slow-flow/SKILL.md.
const READ_ONLY_ACTIONS = new Set([
  'getVoucherSummary',
  'getEmployees',
  'getCompanyApprovers',
  'getApprovalStatus',
  'getVoucherHistory'
]);
const CACHE_TTL_MS = 30 * 1000;
const proxyCache = new Map(); // key -> { ts, status, body }

function cacheKeyFrom(action, bodyString) {
  return `${action}::${bodyString || ''}`;
}

export default async function handler(req, res) {
  const { action } = req.query;
  
  // Get GAS URL from environment variable
  // ⚠️ IMPORTANT: This is a SERVER-SIDE variable (no prefix needed for Vercel Serverless Functions)
  // If undefined, log warning and use fallback
  // Voucher workflow backend (same URL as api/voucher.js default route)
  // Canonical name first, legacy alias second — matches api/voucher.js so both
  // routes resolve to the same backend when only TLCG_CASH_BACKEND_URL is set.
  const GAS_URL = process.env.TLCG_CASH_BACKEND_URL ||
    process.env.VOUCHER_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbxyzw_9y4GVkTWvDmcIWOigHI39zYphCMa0JLZUXuTKWTRedIIYETSeBluFUdJrDgbt/exec';

  if (!process.env.TLCG_CASH_BACKEND_URL && !process.env.VOUCHER_BACKEND_URL) {
    console.warn('[Proxy Warning] TLCG_CASH_BACKEND_URL not set. Using built-in fallback URL.');
  }
  
  // CORS — see api/voucher.js for the rationale. Served same-origin, so this
  // matters only for local dev and any future split-origin setup.
  const origin = req.headers.origin || '';
  const PRIMARY_ORIGIN = process.env.APP_BASE_URL || 'https://wf.tl-c.us';
  const allowedOrigins = [
    PRIMARY_ORIGIN,
    'http://localhost:3000',
    'http://localhost:8080'
  ].concat(
    (process.env.APP_ALLOWED_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  );

  // Never '*' — that would let any site call this API from a logged-in
  // user's browser.
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', PRIMARY_ORIGIN);
  }
  res.setHeader('Vary', 'Origin');
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // Handle GET requests
    if (req.method === 'GET') {
      const queryParams = new URLSearchParams(req.query);
      const gasUrl = `${GAS_URL}?${queryParams.toString()}`;
      const isReadOnly = READ_ONLY_ACTIONS.has(action);
      const cacheKey = isReadOnly ? cacheKeyFrom(action, queryParams.toString()) : null;

      // In-memory cache hit (survives warm-instance reuse)
      if (cacheKey) {
        const hit = proxyCache.get(cacheKey);
        if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
          console.log(`[Proxy GET CacheHit] action: ${action}`);
          res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
          res.setHeader('X-Proxy-Cache', 'HIT');
          return res.status(hit.status).json(hit.body);
        }
      }

      console.log(`[Proxy GET] ${gasUrl.substring(0, 100)}...`);

      const response = await fetch(gasUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'TLCG-Workflow-Proxy/1.0'
        }
      });

      if (!response.ok) {
        console.error(`[Proxy GET Error] ${response.status}: ${response.statusText}`);
        throw new Error(`GAS returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`[Proxy GET Success] action: ${action}`);

      // Cache + advertise cacheability for read-only actions. On GET,
      // Vercel's Edge Network honours s-maxage so subsequent requests
      // across any warm instance benefit.
      if (cacheKey) {
        proxyCache.set(cacheKey, { ts: Date.now(), status: 200, body: data });
        res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
        res.setHeader('X-Proxy-Cache', 'MISS');
      }

      return res.status(200).json(data);
    }
    
    // Handle POST requests
    if (req.method === 'POST') {
      // For Vercel, req.body is already parsed if Content-Type is application/json
      // But GAS expects FormData with 'data' field containing JSON string

      let bodyToSend;
      // String representation of the request body used as the cache key
      // (so two POSTs with the same action + params hit the same entry).
      let bodyKeyString = '';

      // Check if body is already FormData (from client)
      if (req.headers['content-type']?.includes('multipart/form-data')) {
        // If it's FormData, we need to forward it as-is
        // But Vercel doesn't parse FormData by default, so we'll need to handle it
        // For now, assume it's JSON that was sent as FormData by frontend
        bodyToSend = req.body;
        bodyKeyString = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      } else {
        // Create FormData for GAS
        // Use native FormData (available in Node 18+ on Vercel)
        const formData = new FormData();

        // Get JSON string from body
        let dataString;
        if (typeof req.body === 'string') {
          dataString = req.body;
        } else if (req.body) {
          dataString = JSON.stringify(req.body);
        } else {
          dataString = JSON.stringify({});
        }

        formData.append('data', dataString);
        bodyToSend = formData;
        bodyKeyString = dataString;
      }

      // Resolve the effective action name (query param wins, body is a
      // fallback used by some callers that omit the path segment).
      let effectiveAction = action;
      if (!effectiveAction && req.body && typeof req.body === 'object' && req.body.action) {
        effectiveAction = req.body.action;
      }
      const isReadOnly = effectiveAction && READ_ONLY_ACTIONS.has(effectiveAction);
      const cacheKey = isReadOnly ? cacheKeyFrom(effectiveAction, bodyKeyString) : null;

      // In-memory cache hit (warm-instance reuse)
      if (cacheKey) {
        const hit = proxyCache.get(cacheKey);
        if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
          console.log(`[Proxy POST CacheHit] action: ${effectiveAction}`);
          res.setHeader('Cache-Control', 'private, max-age=30');
          res.setHeader('X-Proxy-Cache', 'HIT');
          return res.status(hit.status).json(hit.body);
        }
      }

      console.log(`[Proxy POST] ${GAS_URL.substring(0, 60)}... action: ${effectiveAction || 'from body'}`);

      const response = await fetch(GAS_URL, {
        method: 'POST',
        body: bodyToSend,
        headers: {
          'User-Agent': 'TLCG-Workflow-Proxy/1.0'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Proxy POST Error] ${response.status}: ${errorText.substring(0, 200)}`);
        throw new Error(`GAS returned ${response.status}: ${errorText.substring(0, 200)}`);
      }

      const data = await response.json();
      console.log(`[Proxy POST Success] action: ${effectiveAction || 'from body'}`);

      if (cacheKey) {
        proxyCache.set(cacheKey, { ts: Date.now(), status: 200, body: data });
        res.setHeader('Cache-Control', 'private, max-age=30');
        res.setHeader('X-Proxy-Cache', 'MISS');
      }

      return res.status(200).json(data);
    }
    
    // Method not allowed
    return res.status(405).json({
      success: false,
      message: `Method ${req.method} not allowed. Use GET or POST.`
    });
    
  } catch (error) {
    console.error('[Proxy Error]', error.message);
    
    // Return error response
    return res.status(500).json({
      success: false,
      message: 'Proxy error: ' + error.message,
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

