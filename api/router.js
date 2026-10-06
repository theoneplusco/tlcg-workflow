// api/router.js — Central action router
// Routes action params to either new Express handlers (Postgres) or
// the old GAS proxy (for actions not yet migrated).
import { handleGetMasterData, handleGetCompanies, handleGetCompanyApprovers, handleGetEmployees, handleGetSuppliers, handleGetVendorBanks } from './handlers/master-data.js';
import { handleLogin, handleChangePassword, handleRequestPasswordReset, handleVerifyOTP, handleResetPassword } from './handlers/auth.js';
import { handleVoucherSubmit, handleVoucherApprove, handleVoucherReject, handleVoucherAcknowledge, handleVoucherSummary } from './handlers/voucher-approve.js';
import { handlePRSubmit, handlePRApprove, handlePRReject, handlePRHistory, handlePRDetail } from './handlers/purchase-request.js';
import { handleAdminApprovalFlowGet, handleAdminApprovalFlowSave, handleAdminApprovalFlowPreview } from './handlers/admin-approval.js';
import { handleAdminMasterTables, handleAdminMasterGet, handleAdminMasterUpdateCell, handleAdminMasterAddColumn, handleAdminMasterDeleteColumn, handleAdminMasterRenameColumn } from './handlers/admin-master.js';
import { handleAdminListEmployees, handleAdminCreateEmployee, handleAdminUpdateEmployee, handleAdminEmployeeOptions } from './handlers/admin-employees.js';
import { handleGetCashBook, handleSaveCashCount, handleSignCashCount } from './handlers/cash-book.js';

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
  getVoucherSummary:      handleVoucherSummary,

  // P2P (Phase 4)
  purchaseRequest:             handlePRSubmit,
  approvePurchaseRequest:      handlePRApprove,
  rejectPurchaseRequest:       handlePRReject,
  getPurchaseRequestHistory:   handlePRHistory,
  getPurchaseRequest:          handlePRDetail,

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
};

// ── Which workflows run on Postgres ──────────────────────────
// A workflow moves to Postgres only once its history is imported and its
// pages are verified; until then every one of its actions (reads AND writes)
// stays on Google Apps Script, so a workflow never has data in two places.
//   PG_WORKFLOWS=cash,vouchers,p2p   (comma list; auth/master/admin always Postgres)
const WORKFLOW_ACTIONS = {
  cash: ['getCashBook', 'getCashCount', 'getCashBookSummary', 'getRecentCashCounts', 'saveCashCount', 'signCashCount'],
  vouchers: ['sendApprovalEmail', 'approveVoucher', 'rejectVoucher', 'acknowledgeReceipt', 'getVoucherSummary'],
  p2p: ['purchaseRequest', 'approvePurchaseRequest', 'rejectPurchaseRequest', 'getPurchaseRequestHistory', 'getPurchaseRequest'],
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
