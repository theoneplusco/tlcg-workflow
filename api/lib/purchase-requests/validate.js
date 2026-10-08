// api/lib/purchase-requests/validate.js — GAS handlePurchaseRequest checks and the stored metadata (pure).
import { computeBranch, normalizePurchaseType } from './state.js';
import { normalizeCurrency, toVnd, missingRateMessage, BAD_CURRENCY } from '../fx/rates.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const PRIORITY = { gap: 'Gấp', high: 'Gấp', binh_thuong: 'Bình Thường', medium: 'Bình Thường', khong_gap: 'Không Gấp', low: 'Không Gấp' };
export function normalizePriority(p) {
  const s = String(p || '').trim();
  return s ? PRIORITY[s.toLowerCase()] || s : 'Bình Thường';
}

export const NUMBER_ERROR = 'Số lượng, đơn giá và thành tiền phải là số không âm.';
export const TOO_LONG_ERROR = 'Danh sách hàng hóa quá dài.';
export const MAX_ITEMS = 200;
export const MAX_ITEM_FIELD = 1000;
export const BAD_SIGNATURE = 'Chữ ký không hợp lệ hoặc quá lớn.';
export const MAX_SIGNATURE = 500 * 1024; // characters of the data URL
/** A signature the server stores: an image data URL (never a link) of at most MAX_SIGNATURE characters. */
export const signatureFormatOk = (v) => typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_SIGNATURE;
/** The keys purchase_request.html submitForm() puts on each item; nothing else is stored. */
export const ITEM_KEYS = ['section', 'loai', 'desc', 'qty', 'unit', 'price', 'total', 'note'];

/** No currency (legacy rows) counts as VND, the page default. */
const isVND = (c) => ['', 'VND', 'VNĐ'].includes(String(c ?? '').trim().toUpperCase());
const blank = (v) => v == null || String(v).trim() === '';

/**
 * Text or number → number; '' → 0; anything unreadable → NaN (callers refuse it).
 * VND: "1.234.567" and "1,234,567" are thousands ("4.125" → 4125; ₫/đ and spaces dropped), "149500.5" a decimal.
 * Other currencies: plain decimals with a dot ("4.125" → 4.125), commas are thousands.
 */
export function num(v, currency = 'VND') {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  let s = String(v ?? '').replace(/\s/g, '');
  if (!s) return 0;
  if (isVND(currency)) {
    s = s.replace(/[₫đ]/gi, '');
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));
  } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) {
    return Number(s.replace(/,/g, ''));
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

export function parseItems(items) {
  let list;
  try { list = typeof items === 'string' || items == null ? JSON.parse(items ?? '') : items; }
  catch (e) { return { error: 'Dữ liệu hàng hóa không hợp lệ: ' + e.message }; }
  if (!Array.isArray(list) || !list.length) return { error: 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.' };
  return { items: list };
}

const round = (n) => Number(n.toFixed(6)); // float noise only; 1.5 × 2.75 stays 4.125

/**
 * The stored items: page keys only (legacy quantity/unitPrice read as qty/price), size caps, and each
 * total computed by the server — qty × price when both are given, else the client total (decision #6).
 */
export function normalizeItems(list, currency = 'VND') {
  if (list.length > MAX_ITEMS) return { error: TOO_LONG_ERROR };
  const out = [];
  for (const src of list) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return { error: 'Dữ liệu hàng hóa không hợp lệ: mỗi dòng phải là một đối tượng.' };
    const it = {};
    for (const k of ITEM_KEYS) {
      const v = k === 'qty' ? (src.qty ?? src.quantity) : k === 'price' ? (src.price ?? src.unitPrice) : src[k];
      if (v === undefined) continue;
      if (v !== null && typeof v === 'object') return { error: `Dữ liệu hàng hóa không hợp lệ: ${k}` };
      if (String(v ?? '').length > MAX_ITEM_FIELD) return { error: TOO_LONG_ERROR };
      it[k] = v;
    }
    // Quantities are never money: plain decimals in every currency, as the page's parseFloat reads them.
    const [q, p, t] = [num(it.qty, 'plain'), num(it.price, currency), num(it.total, currency)];
    if ([q, p, t].some((n) => !Number.isFinite(n) || n < 0)) return { error: NUMBER_ERROR };
    const total = !blank(it.qty) && !blank(it.price) ? q * p : t;
    if (!Number.isFinite(total)) return { error: NUMBER_ERROR };
    it.total = round(total);
    out.push(it);
  }
  return { items: out };
}

const sumTotals = (items) => round(items.reduce((s, it) => s + it.total, 0));

/** Grand total the server computes from raw items (NaN when normalizeItems refuses them). */
export function itemsTotal(items, currency = 'VND') {
  const n = normalizeItems(items, currency);
  return n.error ? NaN : sumTotals(n.items);
}

/** Without a looked-up rate only VND is known (rate 1); anything else is refused, never guessed. */
const defaultFx = (currency) => {
  const cur = normalizeCurrency(currency);
  return { currency: cur, rateToVnd: cur === 'VND' ? 1 : null };
};

/**
 * Checks 1–8 of GAS handlePurchaseRequest, in order (item caps and numbers between 7 and 8). Total from the
 * items (S4); the branch on the VND total (decision 2026-10-07). `fx` = { currency, rateToVnd } as looked up
 * by the caller (rates.js getRateToVnd); a missing rate or bad currency is refused where the branch is computed.
 */
export function checkSubmission(b, fx = defaultFx(b.currency)) {
  const empty = (k) => !String(b[k] ?? '').trim();
  if (empty('companyName')) return { error: 'Thiếu tên công ty.' };
  if (empty('requesterName')) return { error: 'Thiếu tên người đề nghị.' };
  if (empty('requiredDate')) return { error: 'Thiếu ngày cần hàng.' };
  if (empty('budgetApprover')) return { error: 'Vui lòng chọn người phê duyệt ngân sách.' };
  if (empty('supplierApprover')) return { error: 'Vui lòng chọn người phê duyệt NCC.' };
  const parsed = parseItems(b.items);
  if (parsed.error) return parsed;
  const norm = normalizeItems(parsed.items, b.currency);
  if (norm.error) return norm;
  const purchaseType = normalizePurchaseType(b.purchaseType);
  const grandTotal = sumTotals(norm.items);
  if (!fx.currency) return { error: BAD_CURRENCY };
  if (fx.rateToVnd == null) return { error: missingRateMessage(fx.currency) };
  const grandTotalVnd = toVnd(grandTotal, fx.rateToVnd);
  const branch = computeBranch(purchaseType, grandTotalVnd);
  if (branch === 'full' && empty('contractApprover')) {
    return { error: 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.' };
  }
  // Optional (the page sends '' without a saved signature); when sent, an image data URL within the cap.
  if (b.requesterSignature != null && b.requesterSignature !== '' && !signatureFormatOk(b.requesterSignature)) return { error: BAD_SIGNATURE };
  return {
    items: norm.items, purchaseType, grandTotal, branch, currency: fx.currency, rateToVnd: fx.rateToVnd, grandTotalVnd,
    picks: { budget: lower(b.budgetApprover), supplier: lower(b.supplierApprover),
      contract: branch === 'full' ? lower(b.contractApprover) : '', purchasing: lower(b.purchasingApprover) },
  };
}

/** metadata_json as GAS wrote it at submit (spec §1.4). */
export function buildMetadata(b, { companyKey, requesterEmail, submittedAt, attachments, purchaseType, branch, picks }) {
  const s = (k) => String(b[k] ?? '').trim();
  return {
    companyCode: s('companyCode'), companyKey: companyKey || '', requesterEmail,
    budgetApproverNote: s('budgetApproverNote'), supplierApproverNote: s('supplierApproverNote'),
    submittedAt, requesterSignature: String(b.requesterSignature || ''), attachments, purchaseType, p2pBranch: branch,
    budgetStatus: picks.budget ? 'Pending' : 'N/A', supplierStatus: picks.supplier ? 'Pending' : 'N/A',
    contractStatus: 'N/A', purchasingStatus: picks.purchasing ? 'Pending' : 'N/A',
    vendorDetails: {
      vendorType: s('vendorType'), vendorTaxId: s('vendorTaxId'), vendorAddress: s('vendorAddress'),
      vendorAccountName: s('vendorAccountName'), vendorAccountNo: s('vendorAccountNo'), vendorBankName: s('vendorBankName'),
      vendorTransferNote: s('vendorTransferNote'),
    },
  };
}
