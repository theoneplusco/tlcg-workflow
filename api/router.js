// api/router.js — Central action router
// Routes action params to either new Express handlers (Postgres) or
// the old GAS proxy (for actions not yet migrated).
import { handleGetMasterData, handleGetCompanyApprovers, handleGetEmployees } from './handlers/master-data.js';
import { handleLogin, handleChangePassword, handleRequestPasswordReset, handleVerifyOTP, handleResetPassword } from './handlers/auth.js';
import { handleVoucherSubmit, handleVoucherApprove, handleVoucherReject, handleVoucherAcknowledge, handleVoucherSummary } from './handlers/voucher-approve.js';
import { handlePRSubmit, handlePRApprove, handlePRReject, handlePRHistory, handlePRDetail } from './handlers/purchase-request.js';
import { handleGetCashBook, handleSaveCashCount, handleSignCashCount } from './handlers/cash-book.js';
import { handleUpdateEmployee, handleResetEmployees } from './handlers/migration.js';

// ── New handlers (Postgres) ──────────────────────────────────
const NEW_HANDLERS = {
  // Auth + master data (Phase 1)
  getMasterData:        handleGetMasterData,
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

  // Migration admin
  updateEmployee:         handleUpdateEmployee,
  resetEmployees:         handleResetEmployees,
};

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
