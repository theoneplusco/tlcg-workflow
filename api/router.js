// api/router.js — Central action router
// Routes action params to either new Express handlers (Postgres) or
// the old GAS proxy (for actions not yet migrated).
import { handleGetMasterData, handleGetCompanies, handleGetCompanyApprovers, handleGetEmployees, handleGetSuppliers, handleGetVendorBanks } from './handlers/master-data.js';
import { handleLogin, handleChangePassword, handleRequestPasswordReset, handleVerifyOTP, handleResetPassword } from './handlers/auth.js';
import { handleVoucherSubmit, handleVoucherApprove, handleVoucherReject, handleVoucherAcknowledge, handleVoucherBulkApprove, handleVoucherSummary, handleVoucherHistory, handleVoucherApprovalStatus, handleVoucherApprovalContext } from './handlers/vouchers.js';
import { handlePRSubmit, handlePRResubmit } from './handlers/pr/submit.js';
import { handlePRApprove, handlePRReject, handlePRSendBack } from './handlers/pr/decide.js';
import { handlePRHistory, handlePRDetail, handlePRSearch, handleP2PHistory, handleGoodsCatalog, handlePurchaseOrderTypes, handleAddSupplier, handleValidatePRForDirectPayment } from './handlers/pr/reads.js';
import { handleAdminApprovalFlowGet, handleAdminApprovalFlowSave, handleAdminApprovalFlowPreview } from './handlers/admin-approval.js';
import { handleAdminMasterTables, handleAdminMasterGet, handleAdminMasterUpdateCell, handleAdminMasterAddColumn, handleAdminMasterDeleteColumn, handleAdminMasterRenameColumn } from './handlers/admin-master.js';
import { handleAdminListEmployees, handleAdminCreateEmployee, handleAdminUpdateEmployee, handleAdminEmployeeOptions } from './handlers/admin-employees.js';
import { handleGetCashBook, handleSaveCashCount, handleSignCashCount } from './handlers/cash-book.js';
import { handleCreateVoucherUploadSession, handleFinalizeVoucherUpload, handleFetchSignatureImage } from './handlers/files.js';

// ── New handlers (Postgres) ──────────────────────────────────
const NEW_HANDLERS = {
  // Auth + master data (Phase 1)
  getMasterData:        handleGetMasterData,
  getCompanies:         handleGetCompanies,
  getSuppliers:         handleGetSuppliers,
  getVendorBanks:       handleGetVendorBanks,
  getCompanyApprovers:  handleGetCompanyApprovers,
  getEmployees:          handleGetEmployees,
  login:                 handleLogin,
  changePassword:        handleChangePassword,
  requestPasswordReset:  handleRequestPasswordReset,
  verifyOTP:             handleVerifyOTP,
  resetPassword:         handleResetPassword,

  // Cash book (Phase 2)
  getCashBook:           handleGetCashBook,
  getCashCount:          handleGetCashBook,      // same handler, different action name
  getCashBookSummary:    handleGetCashBook,
  getRecentCashCounts:   handleGetCashBook,
  saveCashCount:         handleSaveCashCount,
  signCashCount:         handleSignCashCount,

  // Vouchers (Phase 3)
  sendApprovalEmail:     handleVoucherSubmit,
  approveVoucher:         handleVoucherApprove,
  rejectVoucher:          handleVoucherReject,
  acknowledgeReceipt:     handleVoucherAcknowledge,
  bulkApprove:            handleVoucherBulkApprove,
  getVoucherSummary:      handleVoucherSummary,
  getVoucherHistory:      handleVoucherHistory,
  getApprovalStatus:      handleVoucherApprovalStatus,
  getApprovalContext:     handleVoucherApprovalContext,
  // No-op kept for old clients. voucher.html's syncToSheets caller is dead code; the Voucher_History /
  // Voucher_Current copy comes from sheet_outbox (queued by every voucher change). GAS's old target,
  // the 'Phiếu Thu Chi' tab, is no longer written.
  syncToSheets:           (req, res) => res.json({ success: true, message: 'Đã đồng bộ (bản sao Google Sheet tự cập nhật)' }),

  // Purchase requests (Plan 5, workflow key p2p)
  purchaseRequest:             handlePRSubmit,
  resubmitPurchaseRequest:     handlePRResubmit,
  approvePurchaseRequest:      handlePRApprove,
  rejectPurchaseRequest:       handlePRReject,
  sendBackPurchaseRequest:     handlePRSendBack,
  getPurchaseRequestHistory:   handlePRHistory,
  getPurchaseRequest:          handlePRDetail,
  searchPurchaseRequests:      handlePRSearch,
  getP2PHistory:               handleP2PHistory,
  getGoodsCatalog:             handleGoodsCatalog,
  getPurchaseOrderTypes:       handlePurchaseOrderTypes,
  addSupplier:                 handleAddSupplier,
  // Payment side of a PR (workflow key payments, turned on by Plan 6)
  validatePRForDirectPayment:  handleValidatePRForDirectPayment,

  // Admin — require an admin login token (checked in the handler)
  adminListEmployees:          handleAdminListEmployees,
  adminCreateEmployee:         handleAdminCreateEmployee,
  adminUpdateEmployee:         handleAdminUpdateEmployee,
  adminEmployeeOptions:        handleAdminEmployeeOptions,
  adminMasterTables:           handleAdminMasterTables,
  adminMasterGet:              handleAdminMasterGet,
  adminMasterUpdateCell:       handleAdminMasterUpdateCell,
  adminMasterAddColumn:        handleAdminMasterAddColumn,
  adminMasterDeleteColumn:     handleAdminMasterDeleteColumn,
  adminMasterRenameColumn:     handleAdminMasterRenameColumn,
  adminApprovalFlowGet:        handleAdminApprovalFlowGet,
  adminApprovalFlowSave:       handleAdminApprovalFlowSave,
  adminApprovalFlowPreview:    handleAdminApprovalFlowPreview,
  // Voucher attachments on R2 (workflow key: files)
  createVoucherUploadSession:  handleCreateVoucherUploadSession,
  finalizeVoucherUpload:       handleFinalizeVoucherUpload,
  fetchSignatureImage:         handleFetchSignatureImage,
};

// ── Which workflows run on Postgres ──────────────────────────
// A workflow moves to Postgres only once its history is imported and its
// pages are verified; until then every one of its actions (reads AND writes)
// stays on Google Apps Script, so a workflow never has data in two places.
//   PG_WORKFLOWS=cash,vouchers,p2p   (comma list; auth/master/admin always Postgres)
const WORKFLOW_ACTIONS = {
  cash: ['getCashBook', 'getCashCount', 'getCashBookSummary', 'getRecentCashCounts', 'saveCashCount', 'signCashCount'],
  vouchers: ['sendApprovalEmail', 'approveVoucher', 'rejectVoucher', 'acknowledgeReceipt', 'bulkApprove',
    'getVoucherSummary', 'getVoucherHistory', 'getApprovalStatus', 'getApprovalContext', 'syncToSheets'],
  files: ['createVoucherUploadSession', 'finalizeVoucherUpload', 'fetchSignatureImage'],
  p2p: ['purchaseRequest', 'resubmitPurchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'sendBackPurchaseRequest',
    'getPurchaseRequestHistory', 'getPurchaseRequest', 'searchPurchaseRequests', 'getP2PHistory', 'getGoodsCatalog',
    'getPurchaseOrderTypes', 'addSupplier'],
  payments: ['validatePRForDirectPayment'],
};
const PG_WORKFLOWS = new Set(String(process.env.PG_WORKFLOWS || '').split(',').map((s) => s.trim()).filter(Boolean));
for (const [workflow, actions] of Object.entries(WORKFLOW_ACTIONS)) {
  if (!PG_WORKFLOWS.has(workflow)) actions.forEach((a) => { delete NEW_HANDLERS[a]; });
}

/**
 * Check if an action is handled by the new Postgres backend.
 */
export function isNewAction(action) {
  return Object.prototype.hasOwnProperty.call(NEW_HANDLERS, action);
}

/**
 * Route to the new handler.
 */
export async function routeNewAction(action, req, res) {
  const handler = NEW_HANDLERS[action];
  if (!handler) return false;
  await handler(req, res);
  return true;
}

/**
 * List of migrated actions (for logging/debugging).
 */
export const migratedActions = Object.keys(NEW_HANDLERS);
export const postgresWorkflows = [...PG_WORKFLOWS];
