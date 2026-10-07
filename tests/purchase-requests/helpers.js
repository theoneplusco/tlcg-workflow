// tests/purchase-requests/helpers.js — shared setup for the PR handler tests (TEST_DATABASE_URL + Redis db 15).
import { vnDate } from '../../api/lib/purchase-requests/numbering.js';

export const url = process.env.TEST_DATABASE_URL;
export const skip = !url && 'set TEST_DATABASE_URL to run';
export const SIG_OK = JSON.stringify({ verified: true, similarity: 92, reason: 'ok' });
const lower = (s) => String(s || '').trim().toLowerCase();

export async function setup() {
  process.env.DATABASE_URL = url;
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/15';
  process.env.APP_BASE_URL = 'https://wf.test';
  const pool = (await import('../../db/pool.js')).default;
  await pool.query('TRUNCATE purchase_requests, pr_audit_log, email_queue, sheet_outbox');
  const company = (await pool.query(`SELECT * FROM companies WHERE company_key = 'E.V' ORDER BY id LIMIT 1`)).rows[0];
  const ap = (await pool.query(`SELECT LOWER(email) AS e FROM employees WHERE status = 'active'
    AND LOWER(TRIM(department)) = LOWER('Kế Toán Chi') ORDER BY id LIMIT 1`)).rows[0].e;
  const people = { treasurer: lower(company.treasurer_email), accountant: lower(company.accountant_email), legal: lower(company.legal_rep_email), ap };
  return { pool, company, people };
}

export async function teardown(pool) {
  if (!pool) return;
  await pool.end();
  (await import('../../db/redis.js')).default.quit?.();
}

export const as = (email, extra = {}) => ({ id: 0, email: lower(email), name: email.split('@')[0], isAdmin: false, ...extra });

/** Call a handler as `caller` (null = no token), without R2 unless extra.s3 is given. */
export function call(fn, body, caller = null, extra = {}) {
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ code: this.statusCode, ...b }); } };
    Promise.resolve(fn({ body, query: {}, headers: {} }, res, { who: async () => caller, s3: null, ...extra })).catch(reject);
  });
}

let seq = 0;
/** What purchase_request.html submitForm() sends (simplified branch: 149,500 ₫, same person on budget + supplier). */
export function submitBody(company, people, over = {}) {
  seq += 1;
  return {
    prNo: `EV-PR${vnDate()}${String(seq).padStart(6, '0')}`, companyCode: `${company.company_name} (${company.company_key})`,
    companyName: company.company_name, companyKey: company.company_key, department: 'Phòng Bán Hàng', requesterName: 'Người Đề Nghị',
    requiredDate: '2026-10-20', priority: 'binh_thuong', purpose: 'Mua khăn giấy',
    items: JSON.stringify([{ section: 'hang-hoa', loai: 'Hàng Hóa', desc: 'Khăn giấy', qty: '5', unit: 'Cái', price: '29900', total: '149500', note: '' }]),
    grandTotal: 149500, purchaseType: 'goods', p2pBranch: 'simplified', budgetApprover: people.treasurer, supplierApprover: people.treasurer,
    contractApprover: '', purchasingApprover: people.ap, requesterSignature: 'data:image/png;base64,AAAA',
    submittedAt: '2020-01-01T00:00:00.000Z', ...over,
  };
}
