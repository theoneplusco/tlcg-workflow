// api/lib/purchase-requests/validate.js — GAS handlePurchaseRequest checks and the stored metadata (pure).
import { toAmount } from '../vouchers/repo.js';
import { computeBranch, normalizePurchaseType } from './state.js';

const lower = (s) => String(s || '').trim().toLowerCase();
const PRIORITY = { gap: 'Gấp', high: 'Gấp', binh_thuong: 'Bình Thường', medium: 'Bình Thường', khong_gap: 'Không Gấp', low: 'Không Gấp' };
export function normalizePriority(p) {
  const s = String(p || '').trim();
  return s ? PRIORITY[s.toLowerCase()] || s : 'Bình Thường';
}

/** "149500", "029900", "1.500.000", 2000000 → number (plain decimals kept, dotted thousands read as VND). */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  return /^-?\d+(\.\d+)?$/.test(s) && !/^\d{1,3}\.\d{3}$/.test(s) ? Number(s) : toAmount(s);
}

export function parseItems(items) {
  let list;
  try { list = typeof items === 'string' || items == null ? JSON.parse(items ?? '') : items; }
  catch (e) { return { error: 'Dữ liệu hàng hóa không hợp lệ: ' + e.message }; }
  if (!Array.isArray(list) || !list.length) return { error: 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.' };
  return { items: list };
}

export const itemsTotal = (items) => Math.round(items.reduce((s, it) =>
  s + (num(it.total) || num(it.qty ?? it.quantity) * num(it.price ?? it.unitPrice)), 0) * 100) / 100;

/** Checks 1–8 of GAS handlePurchaseRequest, in order. Total and branch come from the items (S4). */
export function checkSubmission(b) {
  const empty = (k) => !String(b[k] ?? '').trim();
  if (empty('companyName')) return { error: 'Thiếu tên công ty.' };
  if (empty('requesterName')) return { error: 'Thiếu tên người đề nghị.' };
  if (empty('requiredDate')) return { error: 'Thiếu ngày cần hàng.' };
  if (empty('budgetApprover')) return { error: 'Vui lòng chọn người phê duyệt ngân sách.' };
  if (empty('supplierApprover')) return { error: 'Vui lòng chọn người phê duyệt NCC.' };
  const parsed = parseItems(b.items);
  if (parsed.error) return parsed;
  const purchaseType = normalizePurchaseType(b.purchaseType);
  const grandTotal = itemsTotal(parsed.items);
  const branch = computeBranch(purchaseType, grandTotal);
  if (branch === 'full' && empty('contractApprover')) {
    return { error: 'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.' };
  }
  return {
    items: parsed.items, purchaseType, grandTotal, branch,
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
