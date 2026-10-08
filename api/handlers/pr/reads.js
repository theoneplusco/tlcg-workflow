// api/handlers/pr/reads.js — PR reads and the small P2P actions on Postgres (spec §3.2–3.4, 3.9–3.13).
import { getPR, auditFor, visibility, canView } from '../../lib/purchase-requests/repo.js';
import { TERMINAL_STATUSES, directPaymentProblem } from '../../lib/purchase-requests/state.js';
import { cardFromRow, fullFromRow, historyEntry, goodsRecord, supplierExtra, likePattern } from '../../lib/purchase-requests/views.js';
import { ok, fail, signedInCaller, NO_ACCESS_MSG, SYSTEM_ERROR } from '../../lib/purchase-requests/respond.js';
import { MASTER_TABLES } from '../../lib/master-registry.js';
import { sampleSignatureFor } from '../../lib/approval/signature-check.js';
import { prDeps } from './tx.js';

const src = (req) => ({ ...(req.query || {}), ...(req.body || {}) });
const str = (v) => String(v ?? '').trim();
const SUPPLIER_FIELDS = ['name', 'address', 'phone', 'email', 'taxCode', 'companyType'];
const MAX_SUPPLIER_FIELD = 200;
/** Log the real error on the server; the page only gets a generic message. */
const systemError = (res, where, e) => { console.error(`[PR] ${where}:`, e.message); return fail(res, SYSTEM_ERROR); };
const MAX_QUERY = 100; // search box text; longer input is cut, never refused

export async function handlePRHistory(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const v = visibility(caller, 1);
  const { rows } = await db.query(
    `SELECT * FROM purchase_requests
     WHERE ${v.sql} AND archived_at IS NULL
       AND NOT (status = ANY($3) AND updated_at < NOW() - interval '90 days')
       AND ($4 = '' OR LOWER(requester_name) = LOWER($4))
     ORDER BY submitted_at DESC NULLS LAST, id DESC`, [...v.params, TERMINAL_STATUSES, str(src(req).requesterName)]);
  return ok(res, 'Thành công', { requests: rows.map(cardFromRow) });
}

export async function handlePRDetail(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const prNo = str(src(req).prNo);
  if (!prNo) return fail(res, 'Thiếu số phiếu mua hàng.');
  const row = await getPR(db, prNo); // archived rows included
  if (!row) return fail(res, `Không tìm thấy đề nghị: ${prNo}`);
  if (!canView(caller, row)) return fail(res, NO_ACCESS_MSG, 403);
  // The sample the server will stamp when this caller approves ('' = none registered → approval refused, null = not their turn)
  const pending = (row.pending_emails || []).map((e) => String(e).toLowerCase()).includes(caller.email.toLowerCase());
  const mySampleSignatureUrl = pending ? (await sampleSignatureFor(db, row.company_id, null, caller.email)).url : null;
  return ok(res, 'Thành công', { request: { ...fullFromRow(row), mySampleSignatureUrl, approvalAuth: 'password' } });
}

export async function handlePRSearch(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const q = str(src(req).q || src(req).query).slice(0, MAX_QUERY);
  if (q.length < 2) return ok(res, 'Thành công', { requests: [] });
  const v = visibility(caller, 2);
  const { rows } = await db.query(
    `SELECT * FROM purchase_requests
     WHERE (pr_no ILIKE $1 OR company_name ILIKE $1 OR requester_name ILIKE $1 OR purpose ILIKE $1) AND ${v.sql}
     ORDER BY submitted_at DESC NULLS LAST, id DESC LIMIT 30`, [likePattern(q), ...v.params]);
  return ok(res, 'Thành công', { requests: rows.map(cardFromRow) });
}

export async function handleP2PHistory(req, res, d) {
  const { db, who, gasProxy } = prDeps(d);
  const b = src(req);
  if (str(b.flow) !== 'PR') {
    // Payment / AM / contract history stays on GAS until Plans 6–7
    req.body = { action: 'getP2PHistory', data: JSON.stringify({ ...(req.body || {}), action: 'getP2PHistory' }) };
    return gasProxy(req, res);
  }
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const docNo = str(b.docNo);
  if (!docNo) return fail(res, 'Invalid docNo or flow.');
  const row = await getPR(db, docNo);
  if (row && !canView(caller, row)) return fail(res, NO_ACCESS_MSG, 403);
  if (!row && !caller.isAdmin) return ok(res, 'OK', { history: [] }); // audit-only numbers (deleted PRs): admins only
  return ok(res, 'OK', { history: (await auditFor(db, docNo)).map(historyEntry) });
}

export async function handleGoodsCatalog(req, res, d) {
  const { db } = prDeps(d);
  try {
    const [{ rows: cols }, { rows }] = await Promise.all([
      db.query(`SELECT name FROM master_columns WHERE table_key = 'goods' ORDER BY position, name`),
      db.query('SELECT * FROM goods_catalog ORDER BY sheet_row NULLS LAST, id'),
    ]);
    const headers = cols.map((c) => c.name);
    const goods = rows.map((r) => goodsRecord(headers, r, MASTER_TABLES.goods.core)).filter((g) => headers.length && str(g[headers[0]]));
    return ok(res, 'Goods catalog fetched successfully', { goods });
  } catch (e) { return systemError(res, 'getGoodsCatalog', e); }
}

export async function handlePurchaseOrderTypes(req, res, d) {
  const { db } = prDeps(d);
  try {
    const { rows } = await db.query(`SELECT no, type FROM purchase_order_types WHERE TRIM(type) <> '' ORDER BY sheet_row NULLS LAST, id`);
    return ok(res, 'Thành công', { types: rows.map((r) => ({ no: r.no || '', type: r.type })) });
  } catch (e) { return systemError(res, 'getPurchaseOrderTypes', e); }
}

export async function handleAddSupplier(req, res, d) {
  const { db, who } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const b = src(req);
  const name = str(b.name);
  if (!name) return fail(res, 'Supplier name is required');
  if (SUPPLIER_FIELDS.some((k) => str(b[k]).length > MAX_SUPPLIER_FIELD)) return fail(res, 'Thông tin nhà cung cấp quá dài.');
  // Check-then-insert under one lock so two clicks cannot add the same vendor twice
  let client;
  let id;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('master_vendors:addSupplier'))`);
    const dup = await client.query(`SELECT 1 FROM master_vendors WHERE LOWER(TRIM(extra->>'Vendor_Full_Name')) = LOWER($1) LIMIT 1`, [name]);
    if (dup.rows.length) { await client.query('ROLLBACK'); return fail(res, `Supplier "${name}" already exists`); }
    const { rows: cols } = await client.query(`SELECT name FROM master_columns WHERE table_key = 'vendors'`);
    const known = new Set(cols.map((c) => c.name));
    // The picker lists rows by Vendor_Full_Name: without that column the vendor would be invisible
    if (!known.has('Vendor_Full_Name')) throw new Error('Master Vendor has no Vendor_Full_Name column');
    const extra = supplierExtra(b, known);
    ({ rows: [{ id }] } = await client.query('INSERT INTO master_vendors (extra) VALUES ($1) RETURNING id', [JSON.stringify(extra)]));
    await client.query('COMMIT');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return systemError(res, 'addSupplier', e);
  } finally { client?.release(); }
  // getSuppliers reads master_vendors live (no cache), so the picker sees the new row at once
  return ok(res, 'Supplier added successfully', { supplierId: 'VD' + String(id).padStart(3, '0'), name });
}

export async function handleValidatePRForDirectPayment(req, res, d) {
  const { db, who, paymentsForPR } = prDeps(d);
  const caller = await signedInCaller(req, res, who);
  if (!caller) return;
  const prNo = str(src(req).prNo);
  if (!prNo) return fail(res, 'Thiếu số PR.');
  const row = await getPR(db, prNo);
  // Same 403 for "not yours" and "no such PR", so non-admins learn nothing about other PRs (Plan 6 may widen this)
  if (!row && !caller.isAdmin) return fail(res, NO_ACCESS_MSG, 403);
  if (!row) return fail(res, `Không tìm thấy PR: ${prNo}`);
  if (!canView(caller, row)) return fail(res, NO_ACCESS_MSG, 403);
  const problem = directPaymentProblem(row);
  if (problem) return fail(res, problem);
  let open;
  try {
    open = (await paymentsForPR(db, prNo)).filter((p) => !['Rejected', 'Từ chối'].includes(p.status));
  } catch (e) { return systemError(res, 'validatePRForDirectPayment', e); }
  if (open.length) return fail(res, 'Đã tồn tại đề nghị thanh toán cho PR này.');
  return ok(res, 'OK', { prNo: row.pr_no, vendorName: row.vendor_name || '', department: row.department || '',
    grandTotal: Number(row.grand_total) || 0, requesterName: row.requester_name || '', purchaseType: row.purchase_type || 'goods',
    p2pBranch: row.p2p_branch || 'full' });
}
