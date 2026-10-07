// api/middleware/unwrap-payload.js — Find the action in every way pages send it.
//
// Pages call /api/voucher in four styles:
//   GET  ?action=x&…                         (query string)
//   POST action=x&…                          (urlencoded / JSON fields)
//   POST data={"action":"x",…}               (urlencoded, payload as JSON string)
//   POST multipart FormData with data=…      (voucher submit — FormData avoids CORS preflight)
// The router used to look only at the first two, so wrapped payloads always
// went to Google Apps Script. This step parses multipart fields into req.body
// (the GAS proxy reuses req.body when it is filled, so forwarding is unchanged)
// and exposes the unwrapped payload for the Postgres handlers.
import busboy from 'busboy';

const FIELD_LIMIT = 32 * 1024 * 1024; // voucher payloads are refused client-side above ~30 MB

/** Pure: { action, payload } from an already-parsed body and query. */
export function unwrap(body, query = {}) {
  const b = body && typeof body === 'object' ? body : {};
  let payload = b;
  if (typeof b.data === 'string' && b.data.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(b.data);
      if (parsed && typeof parsed === 'object') payload = { ...b, ...parsed };
      delete payload.data;
    } catch (e) {
      // Not JSON after all — leave the body as sent
    }
  }
  const action = String((query && query.action) || payload.action || '').trim();
  return { action, payload };
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let truncated = false;
    const bb = busboy({ headers: req.headers, limits: { fieldSize: FIELD_LIMIT } });
    bb.on('field', (name, value, info) => { fields[name] = value; if (info && info.valueTruncated) truncated = true; });
    bb.on('file', (name, file) => file.resume()); // pages send links, never file parts, to /api/voucher
    bb.on('finish', () => (truncated ? reject(new Error('Payload too large')) : resolve(fields)));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/** Express middleware: fills req.body for multipart and sets req.unwrapped = { action, payload }. */
export async function unwrapPayload(req, res, next) {
  try {
    const isMultipart = String(req.headers['content-type'] || '').includes('multipart/form-data');
    if (req.method === 'POST' && isMultipart && (!req.body || !Object.keys(req.body).length)) {
      req.body = await parseMultipart(req);
    }
    req.unwrapped = unwrap(req.body, req.query);
    next();
  } catch (err) {
    res.status(413).json({ success: false, message: 'Dữ liệu gửi lên quá lớn hoặc không đọc được: ' + err.message });
  }
}
