// Vercel Serverless Function - Proxy for Google Apps Script
// Handles requests to /api/voucher (without action in path)
// Location: api/voucher.js

// Export config to handle large request bodies.
// 48mb matches server.js: a 10 MB file is ~13 MB once base64-encoded,
// and the 30 MB attachment total is ~40 MB encoded.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '48mb',
    },
  },
  // For Vercel serverless functions, we might need to handle raw body
  // But bodyParser is enabled by default for Next.js API routes
};

import busboy from 'busboy';

// ==================== RATE LIMITING ====================
// In-memory rate limit tracking (key -> { count, resetTime })
const requestCounts = new Map();

// Requests per minute per client.
//
// This was 30, which is unsafe for an office: staff behind one internet
// connection share a public IP, so the limit applied to the whole company
// rather than to a person. With 50-100 users, a handful of people opening
// the voucher list would exhaust 30/min collectively and lock everyone out.
//
// Raised, and the key is now per user where we can identify one (see
// rateLimitKey) so one busy person cannot block their colleagues.
// Override without redeploying via API_RATE_LIMIT.
const RATE_LIMIT = Number(process.env.API_RATE_LIMIT) || 300;
const RATE_WINDOW = 60000; // 1 minute in ms

// Entries are only touched when that client calls again, so an untouched key
// would live forever on a long-running server (Vercel recycled the instance;
// systemd does not). Sweep expired entries periodically.
const MAX_TRACKED_CLIENTS = 10000;

function sweepExpired(now) {
    for (const [key, rec] of requestCounts) {
        if (now > rec.resetTime) requestCounts.delete(key);
    }
    // Pathological growth (spoofed headers): drop everything rather than
    // grow without bound. Costs one window of accounting, never correctness.
    if (requestCounts.size > MAX_TRACKED_CLIENTS) requestCounts.clear();
}

/**
 * Identify the caller for rate-limiting.
 *
 * Prefer the signed-in user's email so the limit is per person. Fall back to
 * IP, which behind a shared office connection or Cloudflare is one bucket for
 * everyone — hence the generous RATE_LIMIT above.
 */
function rateLimitKey(req, ip) {
    const body = req.body;
    if (body && typeof body === 'object') {
        const email = body.userEmail || body.approverEmail || body.requestorEmail;
        if (email && typeof email === 'string') return 'user:' + email.toLowerCase().trim();
    }
    return 'ip:' + ip;
}

// Short-lived read cache. /api/voucher is POST (and some GET), so HTTP
// Cache-Control is not honored by Cloudflare. This Map lives for the life
// of the Node process (one Ubuntu process; recycled on Vercel).
const readCache = new Map();
const READ_CACHE_TTL_MS = {
    getVoucherSummary: 30 * 1000,
    getEmployees: 60 * 1000,
    getCompanyApprovers: 60 * 1000,
};
const READ_CACHE_MAX = 500;
const VOUCHER_MUTATIONS = new Set([
    'sendApprovalEmail',
    'approveVoucher',
    'rejectVoucher',
    'bulkApprove',
    'acknowledgeReceipt',
]);

function readCacheKey(action, source) {
    const ttl = READ_CACHE_TTL_MS[action];
    if (!ttl) return null;
    const src = source || {};
    const field = (name) => (src[name] == null ? '' : String(src[name]).trim().toLowerCase());
    if (action === 'getEmployees') return 'getEmployees';
    if (action === 'getCompanyApprovers') {
        return 'getCompanyApprovers:' + field('companyName') + '|' + field('companyKey') + '|' + field('company');
    }
    return 'getVoucherSummary:' + field('callerEmail') + '|' + field('userEmail') + '|' + field('email')
        + '|' + field('callerRole') + '|' + field('role') + '|' + field('isAdmin');
}

function readCacheGet(key) {
    const hit = readCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        readCache.delete(key);
        return null;
    }
    return hit.body;
}

function readCacheSet(key, action, body) {
    if (readCache.size > READ_CACHE_MAX) readCache.clear();
    readCache.set(key, { expires: Date.now() + READ_CACHE_TTL_MS[action], body });
}

function bustVoucherSummaryCache() {
    for (const key of readCache.keys()) {
        if (key.startsWith('getVoucherSummary:')) readCache.delete(key);
    }
}

/**
 * Check if client has exceeded rate limit
 * @param {string} key - Caller identity (user email when known, else IP)
 * @returns {boolean} - True if within limit, false if exceeded
 */
function checkRateLimit(key) {
    const now = Date.now();

    if (Math.random() < 0.01) sweepExpired(now);

    const record = requestCounts.get(key);

    if (!record || now > record.resetTime) {
        // No record or window expired - reset counter
        requestCounts.set(key, { count: 1, resetTime: now + RATE_WINDOW });
        return true;
    }

    if (record.count >= RATE_LIMIT) {
        // Rate limit exceeded
        return false;
    }

    // Increment counter
    record.count++;
    return true;
}

// Helper to parse FormData from request
async function parseFormData(req) {
  return new Promise((resolve, reject) => {
    try {
      const bb = busboy({
        headers: req.headers,
        limits: { fieldSize: 2 * 1024 * 1024 }
      });
      const fields = {};
      
      bb.on('field', (name, value) => {
        fields[name] = value;
      });
      
      bb.on('file', (name, file, info) => {
        // For file uploads, we'll handle later if needed
        // For now, just consume the file stream
        file.resume();
      });
      
      bb.on('finish', () => {
        resolve(fields);
      });
      
      bb.on('error', (err) => {
        reject(err);
      });
      
      // Try to pipe the request if it's a stream
      if (req.readable || typeof req.pipe === 'function') {
        req.pipe(bb);
      } else {
        // If req is not a stream, try to write the body directly
        // This might not work in Vercel, but we'll try
        reject(new Error('Request is not a readable stream'));
      }
    } catch (error) {
      reject(error);
    }
  });
}

export default async function handler(req, res) {
  // ==================== RATE LIMITING CHECK ====================
  // Cloudflare sits in front, so CF-Connecting-IP is the real visitor.
  // x-forwarded-for can carry a list; take the first (original client) entry.
  const clientIp = req.headers['cf-connecting-ip'] ||
                   (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                   req.headers['x-real-ip'] ||
                   req.socket?.remoteAddress ||
                   'unknown';

  const limitKey = rateLimitKey(req, clientIp);

  if (!checkRateLimit(limitKey)) {
    console.warn(`[Proxy] Rate limit exceeded for: ${limitKey}`);
    return res.status(429).json({
      success: false,
      message: 'Rate limit exceeded. Please try again later.',
      error: 'TOO_MANY_REQUESTS'
    });
  }

  // ── Backend URLs ─────────────────────────────────────────────────────────
  // Canonical env var names: TLCG_CASH_BACKEND_URL, TLCG_P2P_BACKEND_URL,
  // TLCG_CORE_BACKEND_URL, TLCG_O2C_BACKEND_URL.
  // Old names kept as fallbacks so existing Vercel env vars continue working.

  // TLCG_CASH_BACKEND — Cash & Admin: vouchers, cash book (TLCG_CASH_BACKEND.gs)
  const VOUCHER_BACKEND = process.env.TLCG_CASH_BACKEND_URL ||
    process.env.VOUCHER_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbxyzw_9y4GVkTWvDmcIWOigHI39zYphCMa0JLZUXuTKWTRedIIYETSeBluFUdJrDgbt/exec';

  // TLCG_CORE_BACKEND — Shared/Auth: login, getMasterData, changePassword (TLCG_CORE_BACKEND.gs)
  const TLCGROUP_BACKEND = process.env.TLCG_CORE_BACKEND_URL ||
    process.env.TLCGROUP_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbwoHjoTtE4rPATdp1LO1Of25mSRPm8HVWwbOEgrDpZ07VEz7o38_8Icb1rl235N9VEXnQ/exec';

  // TLCG_P2P_BACKEND — P2P: purchaseRequest, paymentRequest (TLCG_P2P_BACKEND.gs)
  const PAYMENT_REQUEST_BACKEND = process.env.TLCG_P2P_BACKEND_URL ||
    process.env.PAYMENT_REQUEST_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbypmldIGhl4c7XW4I0-MaAHPOkuEnNygoCZozsnetmHk0DEgE6WVkcRAc4IGZ4vqYnw/exec';

  // TLCG_O2C_BACKEND — O2C: quotation, contract, VAT invoice, acceptance (future)
  // const O2C_BACKEND = process.env.TLCG_O2C_BACKEND_URL || null;
  
  // Determine which backend to use based on action
  let GAS_URL = VOUCHER_BACKEND; // Default to voucher Apps Script backend
  
  // Get action from request
  let action = null;
  if (req.method === 'GET') {
    action = req.query.action;
  } else if (req.method === 'POST') {
    // Try to get action from body (if parsed)
    // Vercel may parse URL-encoded bodies automatically
    if (req.body) {
      if (typeof req.body === 'object' && req.body.action) {
        action = req.body.action;
        console.log('[Proxy] Extracted action from req.body:', action);
      } else if (typeof req.body === 'string') {
        // If body is still a string, try to parse action from it
        try {
          const params = new URLSearchParams(req.body);
          action = params.get('action');
          if (action) {
            console.log('[Proxy] Extracted action from URL-encoded string:', action);
          }
        } catch (e) {
          console.log('[Proxy] Could not parse action from string body:', e.message);
        }
      }
    }
    // Fallback to query parameter
    if (!action && req.query && req.query.action) {
      action = req.query.action;
      console.log('[Proxy] Using action from query:', action);
    }
  }
  
  console.log('[Proxy] Final extracted action:', action);
  
  // Route intranet actions to TLCGroup Backend (TLCG_INTRANET_BACKEND_COMPLETE.gs)
  const intranetActions = ['login', 'getMasterData', 'changePassword', 'requestPasswordReset', 'verifyOTP', 'resetPassword'];
  if (intranetActions.includes(action)) {
    GAS_URL = TLCGROUP_BACKEND;
    console.log('[Proxy] Routing ' + action + ' to TLCGroup Backend');
  }
  
  // Route P2P actions to TLCG_P2P_BACKEND (TLCG_P2P_BACKEND.gs)
  const paymentRequestActions = [
    // ── Purchase Request (Đề nghị mua hàng) ──
    'purchaseRequest',             // Submit purchase request form
    'getPurchaseRequestHistory',   // List purchase requests
    // ── Payment Request (Đề nghị thanh toán) ──
    'sendPaymentRequest',
    'submitPaymentRequest',        // Alias for sendPaymentRequest
    'approvePaymentRequest',
    'rejectPaymentRequest',
    'getPaymentRequestHistory',
    'getRecentPaymentRequests',    // Alias for getPaymentRequestHistory
    'getPaymentRequestDetails',
    'getSuppliers',                // Load suppliers from "Master Vendor" sheet
    'getVendorBanks',              // Load vendor banks from "Master Vendor_Bank" sheet
    'addSupplier',                 // Add supplier to "Nhà cung cấp" sheet
    'getPurchaseOrderTypes',       // Load purchase order types from "Purchase Order" sheet
    'getGoodsCatalog',             // Load Goods-KTT catalog (items, categories, MOQ)
    'approvePurchaseRequest',      // Approve a purchase request
    'rejectPurchaseRequest',       // Reject a purchase request
    'sendBackPurchaseRequest',     // Send back a purchase request to an earlier step
    'resubmitPurchaseRequest',     // Requester re-submits after send-back
    // ── Acceptance Minutes (Biên Bản Nghiệm Thu) ──
    'createAcceptanceMinutes',     // Create new acceptance minutes record
    'getAcceptanceMinutesHistory', // List acceptance minutes for current user
    'getAcceptanceMinutesDetail',  // Single AM record by amNo
    'getAcceptanceMinutesByPR',    // Lookup AMs by prNo (used by Payment Request validation)
    'approveAcceptanceMinutes',    // Dept head approves AM → Đã nghiệm thu
    'rejectAcceptanceMinutes',     // Dept head rejects AM → Từ chối
    // ── Contract ──
    'createContract',
    'approveContract',
    'rejectContract',
    'getContractDetails',
    'getContractsByPR',
    'createContractAmendment',
    'approveContractAmendment',
    'rejectContractAmendment',
    'getContractAmendments',
    'validatePRForDirectPayment',
    'getPaymentProgressByPR',
    // NOTE: 'getEmployees' intentionally NOT here — it must go to VOUCHER_BACKEND
    // which returns companies_data[]. Payment Request backend returns employees[] (different shape).
    // getCashBook, getCashCount, getCashBookSummary, getRecentCashCounts, saveCashCount, signCashCount, and getCompanies stay on the Cash backend.
  ];
  
  if (paymentRequestActions.includes(action)) {
    GAS_URL = PAYMENT_REQUEST_BACKEND;
    console.log('[Proxy] Routing ' + action + ' to Payment Request Backend');
  }
  
  // Log warnings if environment variables not set (only in development or first request)
  // These are warnings, not errors - fallback URLs are hardcoded and will work
  if (!process.env.VOUCHER_BACKEND_URL) {
    // Only log once per instance to avoid spam
    if (!global.__voucherBackendEnvWarningLogged) {
      console.warn('[Proxy Info] VOUCHER_BACKEND_URL not set. Using built-in fallback URL.');
      console.warn('[Proxy Info] Set VOUCHER_BACKEND_URL in Vercel Dashboard → Settings → Environment Variables.');
      global.__voucherBackendEnvWarningLogged = true;
    }
  }
  if (!process.env.TLCGROUP_BACKEND_URL) {
    // Only log once per instance to avoid spam
    if (!global.__tlcgroupWarningLogged) {
      console.warn('[Proxy Info] TLCGROUP_BACKEND_URL environment variable not set. Using fallback URL.');
      console.warn('[Proxy Info] Optional: Set TLCGROUP_BACKEND_URL in Vercel Dashboard → Settings → Environment Variables for easier management.');
      global.__tlcgroupWarningLogged = true;
    }
  }
  
  // CORS. The app is served same-origin (workflow.tl-c.us/api/*), so browsers
  // normally send no Origin header at all and CORS never engages. This list
  // exists for local development and any future split-origin setup.
  //
  // Extra origins can be added via APP_ALLOWED_ORIGINS (comma-separated)
  // without editing code.
  const origin = req.headers.origin || '';
  const PRIMARY_ORIGIN = process.env.APP_BASE_URL || 'https://workflow.tl-c.us';
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

  // Echo the origin only when it is explicitly allowed. Unknown origins get
  // the primary origin, which the browser rejects — deliberately NOT '*',
  // which would let any site call this API from a logged-in user's browser.
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
      const getAction = req.query.action || 'unknown';
      const getCacheKey = readCacheKey(getAction, req.query || {});
      if (getCacheKey) {
        const cached = readCacheGet(getCacheKey);
        if (cached) {
          console.log('[Proxy GET Cache] hit ' + getCacheKey);
          return res.status(200).json(cached);
        }
      }

      // Forward GET request to GAS with query parameters
      const queryParams = new URLSearchParams(req.query);
      const gasUrl = `${GAS_URL}?${queryParams.toString()}`;
      
      console.log(`[Proxy GET] ${gasUrl.substring(0, 100)}...`);
      
      const response = await fetch(gasUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'TLCG-Workflow-Proxy/1.0'
        }
      });
      
      const responseText = await response.text();

      if (!response.ok) {
        console.error(`[Proxy GET Error] ${response.status}: ${response.statusText}`);
        console.error(`[Proxy GET Error] Body: ${responseText.substring(0, 500)}`);
        return res.status(500).json({
          success: false,
          message: `Backend error (HTTP ${response.status}) for action "${getAction}". Check Google Apps Script deployment.`
        });
      }

      if (responseText.trim().toLowerCase().startsWith('<!doctype') || responseText.trim().toLowerCase().startsWith('<html')) {
        console.error(`[Proxy GET Error] GAS returned HTML instead of JSON for action "${getAction}"`);
        console.error(`[Proxy GET Error] HTML preview: ${responseText.substring(0, 500)}`);
        return res.status(500).json({
          success: false,
          message: `Backend returned HTML instead of JSON for action "${getAction}". The Google Apps Script deployment may need re-authorization or re-deployment.`
        });
      }

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error(`[Proxy GET Error] Failed to parse JSON for action "${getAction}":`, parseError.message);
        console.error(`[Proxy GET Error] Response: ${responseText.substring(0, 300)}`);
        return res.status(500).json({
          success: false,
          message: `Backend returned invalid JSON for action "${getAction}".`
        });
      }

      console.log(`[Proxy GET Success] action: ${getAction}`);
      if (getCacheKey && data && data.success !== false) {
        readCacheSet(getCacheKey, getAction, data);
      }
      return res.status(200).json(data);
    }
    
    // Handle POST requests
    if (req.method === 'POST') {
      // Frontend sends FormData with fields: action, email, password, etc.
      // Vercel doesn't parse FormData automatically, so we need to parse it manually
      
      let parsedBody = req.body;
      const isFormData = req.headers['content-type']?.includes('multipart/form-data');
      
      // Try to extract action and other fields from body
      // Vercel might parse FormData into req.body, or it might not
      // We'll try multiple approaches
      
      // First, try req.body if it's already an object with fields
      if (!parsedBody || typeof parsedBody !== 'object' || Object.keys(parsedBody || {}).length === 0) {
        // Try parsing FormData if content-type suggests it
        if (isFormData) {
          try {
            console.log('[Proxy POST] Attempting to parse FormData...');
            // Note: In Vercel, req might not be a stream, so this might fail
            // But we'll try anyway and fall back to req.body
            parsedBody = await parseFormData(req);
            console.log('[Proxy POST] FormData parsed successfully');
          } catch (parseError) {
            console.log('[Proxy POST] FormData parsing failed, using req.body:', parseError.message);
            parsedBody = req.body || {};
          }
        } else {
          parsedBody = req.body || {};
        }
      }
      
      // Log what we have
      console.log('[Proxy POST] Parsed body type:', typeof parsedBody);
      console.log('[Proxy POST] Parsed body keys:', parsedBody && typeof parsedBody === 'object' ? Object.keys(parsedBody) : 'N/A');
      
      // Update action from parsedBody if we found it there and action is still null
      // This is critical for URL-encoded requests where Vercel auto-parses the body
      if (parsedBody && typeof parsedBody === 'object') {
        // Check for action in parsedBody
        if (parsedBody.action) {
          // Always update action from parsedBody if it exists (even if action was already set from earlier extraction)
          action = String(parsedBody.action).trim();
          console.log('[Proxy POST] Extracted/Updated action from parsedBody:', action);
          console.log('[Proxy POST] Action type:', typeof action);
          console.log('[Proxy POST] Action length:', action.length);
        }
        
        // Log all keys in parsedBody for debugging
        console.log('[Proxy POST] parsedBody keys:', Object.keys(parsedBody).join(', '));
        if (parsedBody.companyName) {
          console.log('[Proxy POST] parsedBody.companyName:', parsedBody.companyName);
        }
        
        // Re-route based on action if needed
        if (action === 'getMasterData' && GAS_URL !== TLCGROUP_BACKEND) {
          GAS_URL = TLCGROUP_BACKEND;
          console.log('[Proxy POST] Re-routing to TLCGroup Backend based on parsedBody action');
        }
        // Ensure P2P actions always route to PAYMENT_REQUEST_BACKEND (re-affirm after body parse)
        if (paymentRequestActions.includes(action) && GAS_URL !== PAYMENT_REQUEST_BACKEND) {
          GAS_URL = PAYMENT_REQUEST_BACKEND;
          console.log('[Proxy POST] Re-routing ' + action + ' to Payment Request Backend');
        }
        // getCompanyApprovers defaults to VOUCHER_BACKEND (already set)
        if (action === 'getCompanyApprovers') {
          console.log('[Proxy POST] ✅ getCompanyApprovers detected - will use VOUCHER_BACKEND (default)');
          console.log('[Proxy POST] Target URL:', GAS_URL.substring(0, 60) + '...');
        }
      }
      
      // Check if we have a 'data' field with a JSON string (from voucher.html)
      // This is used for large payloads with file attachments
      let hasDataField = false;
      let dataFieldValue = null;
      let actualPayload = parsedBody;
      
      if (parsedBody && typeof parsedBody === 'object' && parsedBody.data && typeof parsedBody.data === 'string') {
        hasDataField = true;
        dataFieldValue = parsedBody.data;
        const dataLength = dataFieldValue.length;
        console.log('[Proxy POST] Found data field with JSON string, length:', dataLength, 'chars (~' + Math.round(dataLength / 1024) + 'KB)');
        
        // Try to extract action from the JSON string for routing (without full parse for large payloads)
        try {
          // For small payloads, parse fully to get action
          if (dataLength < 100000) {
            actualPayload = JSON.parse(dataFieldValue);
            console.log('[Proxy POST] Parsed data field, found action:', actualPayload.action);
          } else {
            // For large payloads, extract action using regex to avoid parsing the entire string
            const actionMatch = dataFieldValue.match(/"action"\s*:\s*"([^"]+)"/);
            if (actionMatch) {
              actualPayload = { action: actionMatch[1] };
              console.log('[Proxy POST] Extracted action from large payload:', actualPayload.action);
            } else {
              console.warn('[Proxy POST] Could not extract action from large payload, using default routing');
            }
          }
        } catch (parseError) {
          console.warn('[Proxy POST] Could not parse data field (may be too large):', parseError.message);
          // Try regex extraction as fallback
          const actionMatch = dataFieldValue.match(/"action"\s*:\s*"([^"]+)"/);
          if (actionMatch) {
            actualPayload = { action: actionMatch[1] };
            console.log('[Proxy POST] Extracted action using regex:', actualPayload.action);
          }
        }
      }
      
      // Update action if we found it (for routing decision)
      if (actualPayload && typeof actualPayload === 'object' && actualPayload.action) {
        action = actualPayload.action;
        // Re-route if we now know it's getMasterData
        if (action === 'getMasterData' && GAS_URL !== TLCGROUP_BACKEND) {
          GAS_URL = TLCGROUP_BACKEND;
          console.log('[Proxy POST] Re-routing getMasterData to TLCGroup Backend (action found: ' + action + ')');
        }
        // Re-route P2P actions (e.g. purchaseRequest inside data JSON field)
        if (paymentRequestActions.includes(action) && GAS_URL !== PAYMENT_REQUEST_BACKEND) {
          GAS_URL = PAYMENT_REQUEST_BACKEND;
          console.log('[Proxy POST] Re-routing ' + action + ' to Payment Request Backend (from data JSON)');
        }
      }
      
      // Forward the request appropriately
      let bodyToSend;
      let contentType;
      
      if (hasDataField && dataFieldValue) {
        // For requests with 'data' field, forward as URL-encoded to preserve large JSON strings
        // URLSearchParams is more reliable in Node.js/Vercel than FormData
        contentType = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        params.append('data', dataFieldValue); // Forward the raw JSON string as-is
        bodyToSend = params.toString();
        console.log('[Proxy POST] Forwarding large payload as URL-encoded (data field preserved)');
      } else if (req.headers['content-type']?.includes('application/x-www-form-urlencoded') && typeof req.body === 'string') {
        // If original request was URL-encoded string, forward it as-is
        // This preserves the exact format that Google Apps Script expects
        contentType = 'application/x-www-form-urlencoded';
        bodyToSend = req.body; // Forward the raw URL-encoded string directly
        console.log('[Proxy POST] Forwarding URL-encoded string directly to preserve format');
      } else if (parsedBody && typeof parsedBody === 'object' && Object.keys(parsedBody).length > 0) {
        // For parsed objects, convert to URL-encoded form data
        // This ensures Google Apps Script receives data in e.parameter format
        contentType = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        Object.keys(parsedBody).forEach(key => {
          const value = parsedBody[key];
          if (value !== undefined && value !== null) {
            // Convert to string and trim to ensure clean values
            const stringValue = String(value).trim();
            params.append(key, stringValue);
            console.log(`[Proxy POST] Adding to URL-encoded: ${key}=${stringValue.substring(0, 50)}${stringValue.length > 50 ? '...' : ''}`);
          }
        });
        bodyToSend = params.toString();
        console.log('[Proxy POST] ✅ Converted parsed body to URL-encoded format');
        console.log('[Proxy POST] URL-encoded body:', bodyToSend.substring(0, 200)); // Log first 200 chars
        console.log('[Proxy POST] URL-encoded body length:', bodyToSend.length);
      } else {
        // Fallback: send as JSON in 'data' field
        contentType = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        params.append('data', JSON.stringify(parsedBody || {}));
        bodyToSend = params.toString();
      }
      
      // Use the action we extracted (for logging)
      const finalAction = action || (parsedBody && parsedBody.action) || 'unknown';
      console.log(`[Proxy POST] ${GAS_URL.substring(0, 60)}... action: ${finalAction}`);
      console.log(`[Proxy POST] Sending as: ${contentType}`);
      
      // Build headers - don't set Content-Type for FormData (browser/Node will set boundary)
      const headers = {
        'User-Agent': 'TLCG-Workflow-Proxy/1.0'
      };
      
      // Only set Content-Type for URL-encoded data, not FormData
      if (contentType && contentType !== 'multipart/form-data') {
        headers['Content-Type'] = contentType;
      }

      const cacheSource = Object.assign(
        {},
        req.query || {},
        parsedBody && typeof parsedBody === 'object' ? parsedBody : {},
        actualPayload && typeof actualPayload === 'object' ? actualPayload : {}
      );
      const postCacheKey = readCacheKey(finalAction, cacheSource);
      if (postCacheKey) {
        const cached = readCacheGet(postCacheKey);
        if (cached) {
          console.log('[Proxy POST Cache] hit ' + postCacheKey);
          return res.status(200).json(cached);
        }
      }
      
      console.log('[Proxy POST] Sending request to backend...');
      const fetchStartTime = Date.now();
      
      const response = await fetch(GAS_URL, {
        method: 'POST',
        body: bodyToSend,
        headers: headers
      });
      
      const fetchDuration = Date.now() - fetchStartTime;
      console.log(`[Proxy POST] Backend responded in ${fetchDuration}ms`);
      
      // Read response text first (can only be read once)
      const responseText = await response.text();
      
      if (!response.ok) {
        console.error(`[Proxy POST Error] ${response.status}: ${responseText.substring(0, 200)}`);
        // Check if error response is HTML
        if (responseText.trim().toLowerCase().startsWith('<!doctype') || responseText.trim().toLowerCase().startsWith('<html')) {
          console.error('[Proxy POST Error] GAS returned HTML error page instead of JSON');
          console.error('[Proxy POST Error] Full HTML response:', responseText.substring(0, 1000));
          return res.status(500).json({
            success: false,
            message: `Backend returned HTML error page (status ${response.status}). Check Google Apps Script deployment and logs.`
          });
        }
        // Try to parse as JSON error response
        try {
          const errorData = JSON.parse(responseText);
          return res.status(response.status).json(errorData);
        } catch (parseError) {
          return res.status(500).json({
            success: false,
            message: `Backend error (status ${response.status}): ${responseText.substring(0, 200)}`
          });
        }
      }
      
      // Check if response is HTML (error page) - responseText already read above
      if (responseText.trim().toLowerCase().startsWith('<!doctype') || responseText.trim().toLowerCase().startsWith('<html')) {
        console.error('[Proxy POST Error] GAS returned HTML instead of JSON');
        console.error('[Proxy POST Error] HTML response:', responseText.substring(0, 1000));
        return res.status(500).json({
          success: false,
          message: 'Backend returned HTML error page instead of JSON. Check Google Apps Script deployment and logs. HTML: ' + responseText.substring(0, 200)
        });
      }
      
      let data;
      try {
        data = JSON.parse(responseText); // JSON.parse is not async, no await needed
        console.log(`[Proxy POST Success] action: ${finalAction}`);
        if (data && data.success !== false) {
          if (postCacheKey) readCacheSet(postCacheKey, finalAction, data);
          if (VOUCHER_MUTATIONS.has(finalAction)) bustVoucherSummaryCache();
        }
      } catch (parseError) {
        console.error('[Proxy POST Error] Failed to parse GAS response as JSON:', parseError);
        console.error('[Proxy POST Error] Response text:', responseText.substring(0, 500));
        return res.status(500).json({
          success: false,
          message: 'Backend returned invalid JSON. Response: ' + responseText.substring(0, 200)
        });
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

