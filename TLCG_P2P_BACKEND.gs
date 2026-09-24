/**
 * TLCG P2P BACKEND (Purchase-to-Pay)
 * Canonical file: TLCG_P2P_BACKEND.gs
 * Domain: P2P — Mua hàng
 *
 * Workflows:
 *   - Purchase Request  (Đề nghị mua hàng)    — purchaseRequest, getPurchaseRequestHistory
 *   - Payment Request   (Đề nghị thanh toán)  — sendPaymentRequest, approvePaymentRequest, …
 *
 * Proxy routing: /api/voucher.js → TLCG_P2P_BACKEND_URL (or PAYMENT_REQUEST_BACKEND_URL fallback)
 *
 * Version: 2.0  (renamed from PAYMENT_REQUEST_BACKEND.gs, May 2026)
 */

// ==================== I18N (server-side messages) ====================

/**
 * Server-side message localisation.
 *
 * Scope, deliberately narrow:
 *   - API response messages returned to the browser use the caller's language,
 *     passed as `lang` on the request payload (the frontend sends its current
 *     TLCI18n language). Falls back to Vietnamese.
 *   - Outbound EMAIL is NOT localised by the caller's `lang`. Emails go to
 *     approvers, not to the submitter, and the backend has no per-recipient
 *     language preference — using the submitter's language would send a
 *     Vietnamese approver an English email. Email templates stay Vietnamese;
 *     see msgBilingual_() for the few places we show both languages.
 *
 * Status values, sheet names and column headers are never translated: they are
 * compared against and written into Sheets.
 */
var MSG_ = {
  vi: {
    errParse: 'Lỗi parse dữ liệu: ',
    errServer: 'Lỗi server: ',
    errSave: 'Lỗi khi lưu đề nghị: ',
    errApprove: 'Lỗi khi phê duyệt: ',
    errReject: 'Lỗi khi từ chối: ',
    errHistory: 'Lỗi khi lấy lịch sử: ',
    errDetail: 'Lỗi khi lấy chi tiết: ',
    errGeneric: 'Lỗi: ',
    amNotFound: 'Biên bản nghiệm thu {0} không tồn tại trong hệ thống.',
    amNotConfirmed: 'Biên bản nghiệm thu {0} chưa được xác nhận (trạng thái hiện tại: {1}). Vui lòng chờ phê duyệt trước khi tạo đề nghị thanh toán.',
    amAlreadyUsed: 'Biên bản nghiệm thu này đã được sử dụng trong đề nghị thanh toán khác.',
    exceedsCeiling: 'Tổng thanh toán vượt quá giá trị hợp đồng/PR ({0} ₫).',
    prInvalidDirect: 'PR không hợp lệ cho thanh toán trực tiếp.',
    needAmOrPr: 'Vui lòng nhập số Biên Bản Nghiệm Thu (AM No), hoặc chọn thanh toán dưới 2.000.000₫ không cần đề nghị mua hàng.',
    smallPaymentOverLimit: 'Hàng hóa hoặc dịch vụ từ 2.000.000₫ cần đề nghị mua hàng.',
    supplierExists: 'Supplier "{0}" already exists',
    sheetMissing: 'Sheet "{0}" không tồn tại',
    roleNotAssignedForRequest: 'Vai trò "{0}" chưa được phân công cho đề nghị này.',
    notAssignedApprover: 'Bạn không được phân công là người duyệt "{0}" cho đề nghị này.',
    notAssignedRole: 'Bạn không được phân công vai trò "{0}" cho đề nghị này.',
    prNotApprovedYet: 'Phiếu đề nghị {0} chưa hoàn thành phê duyệt (trạng thái: {1}).',
    contractNotApproved: 'Hợp đồng {0} chưa được phê duyệt (trạng thái: {1}).',
    contractNotForPr: 'Hợp đồng {0} không thuộc PR {1}.',
    amNoExists: 'Số biên bản {0} đã tồn tại.',
    amNotFoundPrefix: 'Không tìm thấy biên bản: ',
    contractExistsPrefix: 'Đã tồn tại hợp đồng cho PR này: ',
    contractNotFoundPrefix: 'Không tìm thấy hợp đồng: ',
    errPrefix: 'Lỗi: ',
    errorPrefixEn: 'Error: ',
    invalidActionPrefix: 'Invalid action: ',
    invalidStagePrefix: 'Invalid approval stage: ',
    prDocNotFoundPrefix: 'Không tìm thấy phiếu đề nghị mua hàng: ',
    prIdNotFoundPrefix: 'Không tìm thấy PR: ',
    prNotFoundPrefix: 'Không tìm thấy đề nghị: ',
    requestIdExistsPrefix: 'Request ID already exists: ',
    requestNotFoundPrefix: 'Request not found: ',
    validationErrorPrefix: 'Validation error: ',
    alreadyApprovedByYou: 'Bạn đã duyệt đề nghị này rồi.',
    amAlreadyConfirmed: 'Biên bản này đã được xác nhận rồi.',
    amRejectedCannotApprove: 'Biên bản đã bị từ chối. Không thể phê duyệt.',
    amendmentNotFound: 'Không tìm thấy phụ lục.',
    amendmentNotPendingReview: 'Phụ lục không ở trạng thái chờ thẩm định.',
    amendmentOnlySignedContract: 'Chỉ có thể tạo phụ lục cho hợp đồng đã ký.',
    amendmentPendingReview: 'Đang có phụ lục chờ thẩm định.',
    approverSignatureRequired: 'Chữ ký người phê duyệt là bắt buộc.',
    atLeastOneItem: 'Vui lòng nhập ít nhất 1 hàng hóa / dịch vụ.',
    chooseAmConfirmer: 'Vui lòng chọn người phụ trách xác nhận nghiệm thu.',
    chooseBudgetApprover: 'Vui lòng chọn người phê duyệt ngân sách.',
    chooseVendorApprover: 'Vui lòng chọn người phê duyệt NCC.',
    contractNoExists: 'Số hợp đồng đã tồn tại.',
    contractNotFound: 'Không tìm thấy hợp đồng.',
    contractNotPendingReview: 'Hợp đồng không ở trạng thái chờ thẩm định.',
    contractValuePositive: 'Giá trị hợp đồng phải lớn hơn 0.',
    docPendingInfoCannotApprove: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể duyệt.',
    docPendingInfoCannotReject: 'Phiếu đang chờ người đề nghị bổ sung thông tin, không thể từ chối.',
    enterRejectReason: 'Vui lòng nhập lý do từ chối.',
    enterSendBackReason: 'Vui lòng nhập lý do trả lại.',
    errCreateAm: 'Lỗi khi tạo biên bản nghiệm thu: ',
    errSaveContract: 'Lỗi khi lưu đề nghị mua hàng: ',
    fullFlowNeedsContractNo: 'Quy trình đầy đủ yêu cầu số Hợp đồng (Contract No).',
    invalidDocNoFlow: 'Invalid docNo or flow.',
    invalidGetRequest: 'Invalid GET request',
    invalidGoodsData: 'Dữ liệu hàng hóa không hợp lệ: ',
    invalidRole: 'Vai trò không hợp lệ.',
    invalidRoleList: 'Vai trò không hợp lệ. Phải là "budget", "supplier", "contract" hoặc "purchasing".',
    missingActorEmail: 'Thiếu email người thực hiện.',
    missingAmNo: 'Thiếu amNo.',
    missingAmendmentNo: 'Thiếu số phụ lục.',
    missingApproverEmail: 'Thiếu email người phê duyệt.',
    missingApproverEmail2: 'Thiếu email người duyệt.',
    missingCompanyName: 'Thiếu tên công ty.',
    missingContractNo: 'Thiếu số hợp đồng.',
    missingPrNo: 'Thiếu số PR.',
    missingPrNoFull: 'Thiếu số đề nghị mua hàng (PR No).',
    missingPrNoShort: 'Thiếu prNo.',
    missingPurchaseDocNo: 'Thiếu số phiếu mua hàng.',
    missingReceiverEmail: 'Thiếu email người nhận hàng.',
    missingReceiverName: 'Thiếu tên người nhận hàng.',
    missingRejecterEmail: 'Thiếu email người từ chối.',
    missingRequesterEmail: 'Thiếu email người đề nghị.',
    missingRequesterName: 'Thiếu tên người đề nghị.',
    missingRequiredDate: 'Thiếu ngày cần hàng.',
    missingSupplierName: 'Thiếu tên nhà cung cấp.',
    noRejectPermission: 'Bạn không có quyền từ chối đề nghị này.',
    notAmConfirmer: 'Bạn không phải là người phụ trách xác nhận biên bản này.',
    notAssignedContractReview: 'Bạn không được phân công thẩm định hợp đồng này.',
    notOriginalRequester: 'Bạn không phải người đề nghị ban đầu của phiếu này.',
    notYourTurn: 'Chưa đến lượt của bạn trong quy trình phê duyệt.',
    prNotFullyApproved: 'PR chưa hoàn thành phê duyệt.',
    prSimplifiedNoContract: 'PR này thuộc quy trình rút gọn — không cần hợp đồng.',
    receiverSignatureRequired: 'Chữ ký người nhận hàng là bắt buộc.',
    requestAlreadyApproved: 'Đề nghị này đã được duyệt rồi.',
    requestAlreadyRejected: 'Đề nghị này đã bị từ chối.',
    requestAlreadyRejected2: 'Đề nghị này đã bị từ chối rồi.',
    requestAlreadyReturned: 'Đề nghị này đã được trả lại rồi, đang chờ người đề nghị cập nhật.',
    requestApprovedCannotReject: 'Đề nghị đã được duyệt, không thể từ chối.',
    requestCompleted: 'Đề nghị này đã hoàn thành.',
    requestRejectedCannotApprove: 'Đề nghị này đã bị từ chối, không thể duyệt.',
    resubmitOnlyWhenReturned: 'Chỉ có thể gửi lại khi phiếu ở trạng thái "Trả lại bổ sung".',
    sendBackStepInvalid: 'Bước trả lại không hợp lệ.',
    sendBackStepInvalidRole: 'Bước trả lại không hợp lệ với vai trò của bạn.',
    sheetMasterVendorBankMissing: 'Sheet "Master Vendor_Bank" không tồn tại',
    sheetMasterVendorMissing: 'Sheet "Master Vendor" không tồn tại',
    sheetPrHistoryNotFound: 'Không tìm thấy sheet Purchase_Request_History.',
    sheetSuppliersNotFound: 'Sheet "Nhà cung cấp" not found',
    signatureRequiredApproval: 'Signature is required for approval',
    supplierNameRequired: 'Supplier name is required',
  },
  en: {
    errParse: 'Failed to parse data: ',
    errServer: 'Server error: ',
    errSave: 'Failed to save the request: ',
    errApprove: 'Approval failed: ',
    errReject: 'Rejection failed: ',
    errHistory: 'Failed to load history: ',
    errDetail: 'Failed to load details: ',
    errGeneric: 'Error: ',
    amNotFound: 'Acceptance Minutes {0} does not exist in the system.',
    amNotConfirmed: 'Acceptance Minutes {0} has not been confirmed (current status: {1}). Please wait for approval before creating a payment request.',
    amAlreadyUsed: 'These Acceptance Minutes have already been used in another payment request.',
    exceedsCeiling: 'Total payment exceeds the contract/PR value ({0} ₫).',
    prInvalidDirect: 'This PR is not eligible for direct payment.',
    needAmOrPr: 'Enter an Acceptance Minutes number, or choose a payment under 2,000,000₫ with no purchase request.',
    smallPaymentOverLimit: 'Goods or services of 2,000,000₫ or more require a purchase request.',
    supplierExists: 'Supplier "{0}" already exists',
    sheetMissing: 'The "{0}" sheet does not exist',
    roleNotAssignedForRequest: 'The "{0}" role has not been assigned for this request.',
    notAssignedApprover: 'You are not assigned as the "{0}" approver for this request.',
    notAssignedRole: 'You are not assigned the "{0}" role for this request.',
    prNotApprovedYet: 'Purchase request {0} has not completed approval (status: {1}).',
    contractNotApproved: 'Contract {0} has not been approved (status: {1}).',
    contractNotForPr: 'Contract {0} does not belong to PR {1}.',
    amNoExists: 'Acceptance minutes number {0} already exists.',
    amNotFoundPrefix: 'Acceptance minutes not found: ',
    contractExistsPrefix: 'A contract already exists for this PR: ',
    contractNotFoundPrefix: 'Contract not found: ',
    errPrefix: 'Error: ',
    errorPrefixEn: 'Error: ',
    invalidActionPrefix: 'Invalid action: ',
    invalidStagePrefix: 'Invalid approval stage: ',
    prDocNotFoundPrefix: 'Purchase request document not found: ',
    prIdNotFoundPrefix: 'PR not found: ',
    prNotFoundPrefix: 'Request not found: ',
    requestIdExistsPrefix: 'Request ID already exists: ',
    requestNotFoundPrefix: 'Request not found: ',
    validationErrorPrefix: 'Validation error: ',
    alreadyApprovedByYou: 'You have already approved this request.',
    amAlreadyConfirmed: 'These acceptance minutes have already been confirmed.',
    amRejectedCannotApprove: 'These acceptance minutes were rejected and cannot be approved.',
    amendmentNotFound: 'Amendment not found.',
    amendmentNotPendingReview: 'This amendment is not awaiting review.',
    amendmentOnlySignedContract: 'Amendments can only be created for signed contracts.',
    amendmentPendingReview: 'An amendment is already awaiting review.',
    approverSignatureRequired: 'The approver\'s signature is required.',
    atLeastOneItem: 'Please enter at least one item or service.',
    chooseAmConfirmer: 'Please select the acceptance confirming officer.',
    chooseBudgetApprover: 'Please select a budget approver.',
    chooseVendorApprover: 'Please select a vendor approver.',
    contractNoExists: 'That contract number already exists.',
    contractNotFound: 'Contract not found.',
    contractNotPendingReview: 'This contract is not awaiting review.',
    contractValuePositive: 'Contract value must be greater than 0.',
    docPendingInfoCannotApprove: 'This document is awaiting more information from the requester and cannot be approved.',
    docPendingInfoCannotReject: 'This document is awaiting more information from the requester and cannot be rejected.',
    enterRejectReason: 'Please enter a rejection reason.',
    enterSendBackReason: 'Please enter a reason for sending it back.',
    errCreateAm: 'Failed to create the acceptance minutes: ',
    errSaveContract: 'Failed to save the purchase request: ',
    fullFlowNeedsContractNo: 'The full workflow requires a Contract No.',
    invalidDocNoFlow: 'Invalid docNo or flow.',
    invalidGetRequest: 'Invalid GET request',
    invalidGoodsData: 'Invalid goods data: ',
    invalidRole: 'Invalid role.',
    invalidRoleList: 'Invalid role. Must be "budget", "supplier", "contract" or "purchasing".',
    missingActorEmail: 'Missing actor email.',
    missingAmNo: 'Missing AM number.',
    missingAmendmentNo: 'Missing amendment number.',
    missingApproverEmail: 'Missing approver email.',
    missingApproverEmail2: 'Missing approver email.',
    missingCompanyName: 'Missing company name.',
    missingContractNo: 'Missing contract number.',
    missingPrNo: 'Missing PR number.',
    missingPrNoFull: 'Missing purchase request number (PR No).',
    missingPrNoShort: 'Missing PR number.',
    missingPurchaseDocNo: 'Missing purchase document number.',
    missingReceiverEmail: 'Missing receiver email.',
    missingReceiverName: 'Missing receiver name.',
    missingRejecterEmail: 'Missing rejecter email.',
    missingRequesterEmail: 'Missing requester email.',
    missingRequesterName: 'Missing requester name.',
    missingRequiredDate: 'Missing required-by date.',
    missingSupplierName: 'Missing supplier name.',
    noRejectPermission: 'You do not have permission to reject this request.',
    notAmConfirmer: 'You are not the confirming officer for these acceptance minutes.',
    notAssignedContractReview: 'You are not assigned to review this contract.',
    notOriginalRequester: 'You are not the original requester of this document.',
    notYourTurn: 'It is not your turn in the approval workflow.',
    prNotFullyApproved: 'This PR has not completed approval.',
    prSimplifiedNoContract: 'This PR uses the simplified flow — no contract is required.',
    receiverSignatureRequired: 'The receiver\'s signature is required.',
    requestAlreadyApproved: 'This request has already been approved.',
    requestAlreadyRejected: 'This request has been rejected.',
    requestAlreadyRejected2: 'This request has already been rejected.',
    requestAlreadyReturned: 'This request has already been returned and is awaiting the requester\'s update.',
    requestApprovedCannotReject: 'This request is already approved and cannot be rejected.',
    requestCompleted: 'This request is already completed.',
    requestRejectedCannotApprove: 'This request was rejected and cannot be approved.',
    resubmitOnlyWhenReturned: 'You can only resubmit when the document status is "Returned for revision".',
    sendBackStepInvalid: 'Invalid send-back step.',
    sendBackStepInvalidRole: 'That send-back step is not valid for your role.',
    sheetMasterVendorBankMissing: 'The "Master Vendor_Bank" sheet does not exist',
    sheetMasterVendorMissing: 'The "Master Vendor" sheet does not exist',
    sheetPrHistoryNotFound: 'Purchase_Request_History sheet not found.',
    sheetSuppliersNotFound: 'The "Nhà cung cấp" sheet was not found',
    signatureRequiredApproval: 'Signature is required for approval',
    supplierNameRequired: 'Supplier name is required',
  }
};

/** Language for the current request; set by doPost from the payload. */
var REQ_LANG_ = 'vi';

function setReqLang_(lang) {
  REQ_LANG_ = (lang === 'en') ? 'en' : 'vi';
  return REQ_LANG_;
}

/**
 * Localised message with {0}, {1}… substitution.
 * Unknown keys return the key itself so nothing is ever blank.
 */
function msg_(key, a, b) {
  var table = MSG_[REQ_LANG_] || MSG_.vi;
  var text = table[key];
  if (text == null) text = (MSG_.vi[key] != null) ? MSG_.vi[key] : key;
  if (a !== undefined) text = text.replace('{0}', a);
  if (b !== undefined) text = text.replace('{1}', b);
  return text;
}

/** Vietnamese + English on one line, for email content sent to mixed audiences. */
function msgBilingual_(key, a, b) {
  var prev = REQ_LANG_;
  REQ_LANG_ = 'vi'; var vi = msg_(key, a, b);
  REQ_LANG_ = 'en'; var en = msg_(key, a, b);
  REQ_LANG_ = prev;
  return vi === en ? vi : (vi + ' / ' + en);
}

// ==================== CONFIGURATION ====================

/**
 * Read a Script Property and fall back to a hardcoded default when the property
 * is missing or the PropertiesService call fails. Keeps this backend running
 * unchanged in legacy deployments that haven't populated properties yet.
 */
function getCfg_(key, fallback) {
  try {
    var v = PropertiesService.getScriptProperties().getProperty(key);
    return (v && String(v).trim()) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

const USERS_SHEET_ID = getCfg_('MASTER_SPREADSHEET_ID', '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g');

// Single source of truth for the frontend URL used in all email links.
// Override via Script Properties: APP_BASE_URL (same key as TLCG_CASH_BACKEND).
// Approval emails embed this, so a wrong value sends approvers to a dead link.
const BASE_URL = getCfg_('APP_BASE_URL', 'https://workflow.tl-c.us');

const CONFIG = {
  SPREADSHEET_ID: getCfg_('MASTER_SPREADSHEET_ID', '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g'),
  SHEET_NAME: 'Payment_Request_History', // Main sheet for storing all payment requests
  SUPPLIERS_SHEET_NAME: 'Nhà cung cấp', // Existing suppliers sheet
  EMPLOYEES_SHEET_NAME: 'Master Employee',
  PURCHASE_ORDER_SHEET_NAME: 'Purchase Order', // Purchase Order types sheet
  DRIVE_FOLDER_NAME: '02.De_Nghi_Mua_Hang',
  
  // Column indices for Payment_Request_History sheet
  COLUMNS: {
    REQUEST_ID: 0,
    REQUEST_DATE: 1,
    COMPANY: 2,
    REQUESTOR: 3,
    REQUESTOR_EMAIL: 4,
    DEPARTMENT: 5,
    PURCHASE_TYPE: 6,
    PR_REQUEST_NO: 7,
    PURPOSE: 8,
    SUPPLIER: 9,
    RECIPIENT: 10,
    PRODUCT_ITEMS: 11, // JSON
    TOTAL_AMOUNT: 12,
    PAYMENT_TYPE: 13,
    PAYMENT_PHASES: 14, // JSON
    BUDGET_APPROVER: 15,
    BUDGET_STATUS: 16,
    BUDGET_SIGNATURE: 17,
    SUPPLIER_APPROVER: 18,
    SUPPLIER_STATUS: 19,
    SUPPLIER_SIGNATURE: 20,
    LEGAL_APPROVER: 21,
    LEGAL_STATUS: 22,
    LEGAL_SIGNATURE: 23,
    ACCOUNTING_APPROVER: 24,
    ACCOUNTING_STATUS: 25,
    ACCOUNTING_SIGNATURE: 26,
    DIRECTOR_APPROVER: 27,
    DIRECTOR_STATUS: 28,
    DIRECTOR_SIGNATURE: 29,
    FINAL_APPROVER: 30,
    FINAL_STATUS: 31,
    FINAL_SIGNATURE: 32,
    OVERALL_STATUS: 33,
    SUBMITTED_AT: 34,
    METADATA: 35 // JSON for additional data
  }
};

// ==================== MAIN HANDLERS ====================

function doPost(e) {
  try {
    Logger.log('[Payment Request] Received POST request');
    
    // Parse request data
    let data;
    try {
      const contentType = e.postData.type;
      
      if (contentType === 'application/x-www-form-urlencoded') {
        const params = parseUrlEncodedData(e.postData.contents);
        data = params.data ? JSON.parse(params.data) : params;
      } else {
        data = JSON.parse(e.postData.contents);
      }
    } catch (parseError) {
      Logger.log('[Payment Request] Parse error: ' + parseError.message);
      return createResponse(false, msg_('errParse') + parseError.message);
    }

    // Response messages follow the caller's UI language (emails do not).
    setReqLang_(data.lang);

    const action = data.action;
    Logger.log('[Payment Request] Action: ' + action);
    
    // Route to appropriate handler
    switch (action) {
      // ── Purchase Request ─────────────────────────────────────
      case 'purchaseRequest':
        return handlePurchaseRequest(data);
      case 'getPurchaseRequestHistory':
        return handleGetPurchaseRequestHistory(data);
      case 'approvePurchaseRequest':
        return handleApprovePurchaseRequest(data);
      case 'rejectPurchaseRequest':
        return handleRejectPurchaseRequest(data);
      case 'sendBackPurchaseRequest':
        return handleSendBackPurchaseRequest(data);
      case 'resubmitPurchaseRequest':
        return handleResubmitPurchaseRequest(data);
      // ── Payment Request ──────────────────────────────────────
      case 'submitPaymentRequest':
      case 'sendPaymentRequest':
        return handleSendPaymentRequest(data);
      case 'approvePaymentRequest':
        return handleApprovePaymentRequest(data);
      case 'rejectPaymentRequest':
        return handleRejectPaymentRequest(data);
      case 'getPaymentRequestHistory':
        return handleGetPaymentRequestHistory(data);
      case 'getRecentPaymentRequests':
        return handleGetRecentPaymentRequests(data);
      case 'getPaymentRequestDetails':
        return handleGetPaymentRequestDetails(data);
      case 'getSuppliers':
        return handleGetSuppliers(data);
      case 'getVendorBanks':
        return handleGetVendorBanks(data);
      case 'addSupplier':
        return handleAddSupplier(data);
      case 'getEmployees':
        return handleGetEmployees(data);
      case 'getPurchaseOrderTypes':
        return handleGetPurchaseOrderTypes(data);
      case 'getGoodsCatalog':
        return handleGetGoodsCatalog(data);
      // ── Acceptance Minutes ────────────────────────────────────
      case 'createAcceptanceMinutes':
        return handleCreateAcceptanceMinutes(data);
      case 'getAcceptanceMinutesHistory':
        return handleGetAcceptanceMinutesHistory(data);
      case 'getAcceptanceMinutesDetail':
        return handleGetAcceptanceMinutesDetail(data);
      case 'getAcceptanceMinutesByPR':
        return handleGetAcceptanceMinutesByPR(data);
      case 'approveAcceptanceMinutes':
        return handleApproveAcceptanceMinutes(data);
      case 'rejectAcceptanceMinutes':
        return handleRejectAcceptanceMinutes(data);
      // ── Contract ───────────────────────────────────────────────
      case 'createContract':
        return handleCreateContract(data);
      case 'approveContract':
        return handleApproveContract(data);
      case 'rejectContract':
        return handleRejectContract(data);
      case 'getContractDetails':
        return handleGetContractDetails(data);
      case 'getContractsByPR':
        return handleGetContractsByPR(data);
      case 'createContractAmendment':
        return handleCreateContractAmendment(data);
      case 'approveContractAmendment':
        return handleApproveContractAmendment(data);
      case 'rejectContractAmendment':
        return handleRejectContractAmendment(data);
      case 'getContractAmendments':
        return handleGetContractAmendments(data);
      case 'validatePRForDirectPayment':
        return handleValidatePRForDirectPayment(data);
      case 'getPaymentProgressByPR':
        return handleGetPaymentProgressByPR(data);
      case 'getP2PHistory':
        return handleGetP2PHistory(data);
      default:
        return createResponse(false, msg_('invalidActionPrefix') + action);
    }
    
  } catch (error) {
    Logger.log('[Payment Request] Error in doPost: ' + error.message);
    Logger.log('[Payment Request] Stack trace: ' + error.stack);
    return createResponse(false, msg_('errServer') + error.message);
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    const requestId = e.parameter.requestId;
    
    Logger.log('[Payment Request] GET request - Action: ' + action + ', RequestId: ' + requestId);
    
    if (action === 'getPaymentRequestDetails' && requestId) {
      return handleGetPaymentRequestDetails({ requestId: requestId });
    } else if (action === 'getEmployees') {
      return handleGetEmployees(e.parameter);
    } else if (action === 'getPurchaseOrderTypes') {
      return handleGetPurchaseOrderTypes(e.parameter);
    } else if (action === 'getSuppliers') {
      return handleGetSuppliers(e.parameter);
    } else if (action === 'getVendorBanks') {
      return handleGetVendorBanks(e.parameter);
    }
    
    return createResponse(false, msg_('invalidGetRequest'));
    
  } catch (error) {
    Logger.log('[Payment Request] Error in doGet: ' + error.message);
    return createResponse(false, msg_('errServer') + error.message);
  }
}

// ==================== SUBMIT PAYMENT REQUEST ====================

function handleSendPaymentRequest(data) {
  try {
    Logger.log('[Payment Request] Processing submission...');

    data = normalizePaymentRequestData_(data);
    
    // Validate required fields
    const validation = validatePaymentRequest(data);
    if (!validation.valid) {
      return createResponse(false, msg_('validationErrorPrefix') + validation.errors.join(', '));
    }
    
    // Get or create sheet
    const sheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    
    // Check for duplicate
    if (findRequestByIdInSheet(sheet, data.requestId)) {
      return createResponse(false, msg_('requestIdExistsPrefix') + data.requestId);
    }
    
    // Store file attachments in Google Drive
    const productItemsWithFiles = storeProductAttachments(data.productItems, data.requestId);
    const paymentPhasesWithFiles = storePaymentPhaseAttachments(data.paymentPhases, data.requestId);
    const contractFiles = storeContractAttachments(data.contractAttachments, data.requestId);
    
    // Store signatures in Google Drive
    const requesterSignature = data.requesterSignature ? 
      storeSignature(data.requesterSignature, data.requestId, 'requester') : '';
    
    // Prepare row data
    const rowData = new Array(36).fill('');
    rowData[CONFIG.COLUMNS.REQUEST_ID] = data.requestId;
    rowData[CONFIG.COLUMNS.REQUEST_DATE] = data.requestDate;
    rowData[CONFIG.COLUMNS.COMPANY] = data.company;
    rowData[CONFIG.COLUMNS.REQUESTOR] = data.requestor;
    rowData[CONFIG.COLUMNS.REQUESTOR_EMAIL] = data.requestorEmail;
    rowData[CONFIG.COLUMNS.DEPARTMENT] = data.department;
    rowData[CONFIG.COLUMNS.PURCHASE_TYPE] = data.purchaseType;
    rowData[CONFIG.COLUMNS.PR_REQUEST_NO] = data.prRequestNo;
    rowData[CONFIG.COLUMNS.PURPOSE] = data.purpose;
    rowData[CONFIG.COLUMNS.SUPPLIER] = data.supplier;
    rowData[CONFIG.COLUMNS.RECIPIENT] = data.recipient;
    rowData[CONFIG.COLUMNS.PRODUCT_ITEMS] = JSON.stringify(productItemsWithFiles);
    rowData[CONFIG.COLUMNS.TOTAL_AMOUNT] = data.totalAmount;
    rowData[CONFIG.COLUMNS.PAYMENT_TYPE] = data.paymentType;
    rowData[CONFIG.COLUMNS.PAYMENT_PHASES] = JSON.stringify(paymentPhasesWithFiles);
    rowData[CONFIG.COLUMNS.BUDGET_APPROVER] = data.budgetApprover;
    rowData[CONFIG.COLUMNS.BUDGET_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.SUPPLIER_APPROVER] = data.supplierApprover;
    rowData[CONFIG.COLUMNS.SUPPLIER_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.LEGAL_APPROVER] = data.legalApprover || '';
    rowData[CONFIG.COLUMNS.LEGAL_STATUS] = data.legalApprover ? 'Pending' : 'N/A';
    rowData[CONFIG.COLUMNS.ACCOUNTING_APPROVER] = data.accountingApprover;
    rowData[CONFIG.COLUMNS.ACCOUNTING_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.DIRECTOR_APPROVER] = data.directorApprover;
    rowData[CONFIG.COLUMNS.DIRECTOR_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.FINAL_APPROVER] = data.finalApprover;
    rowData[CONFIG.COLUMNS.FINAL_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.OVERALL_STATUS] = 'Pending';
    rowData[CONFIG.COLUMNS.SUBMITTED_AT] = new Date().toISOString();
    
    // Validate AM / PR reference (dual-mode gate)
    const amNo = (data.amNo || '').toString().trim();
    const prRequestNo = (data.prRequestNo || data.prNo || '').toString().trim();
    let amRecord = null;
    let p2pBranch = 'full';
    let contractCeiling = null;

    if (amNo) {
      amRecord = getAMByNo_(amNo);
      if (!amRecord) {
        return createResponse(false, msg_('amNotFound', amNo));
      }
      if (amRecord.status !== 'Đã nghiệm thu') {
        return createResponse(false, msg_('amNotConfirmed', amNo, amRecord.status));
      }
      // AM already used by another PMT?
      const existingForAm = getPMTsByPR_(amRecord.prNo || '').filter(function(p) {
        return (p.amNo || '') === amNo && p.status !== 'Rejected' && p.status !== 'Từ chối';
      });
      if (existingForAm.length > 0) {
        return createResponse(false, msg_('amAlreadyUsed'));
      }
      const prInfo = findPRByNo_(amRecord.prNo || '');
      if (prInfo) {
        p2pBranch = prInfo.metadata.p2pBranch || 'full';
      }
      const amMeta = amRecord.metadata || {};
      if (amMeta.contractNo) {
        const ct = getContractByNo_(amMeta.contractNo);
        if (ct) contractCeiling = parseFloat(ct.contractValue) || 0;
      }
      if (contractCeiling === null && prInfo) {
        contractCeiling = parseFloat(prInfo.row[13]) || 0;
      }
      const thisAmount = parseFloat(data.totalAmount) || 0;
      const paidTotal = sumPaidPMTsForPR_(amRecord.prNo || '');
      if (contractCeiling > 0 && paidTotal + thisAmount > contractCeiling + 0.01) {
        return createResponse(false, msg_('exceedsCeiling', contractCeiling.toLocaleString('vi-VN')));
      }
    } else if (prRequestNo) {
      const directResult = _validatePRForDirectPayment_(prRequestNo);
      if (!directResult.ok) {
        return createResponse(false, directResult.message || msg_('prInvalidDirect'));
      }
      p2pBranch = 'simplified';
      contractCeiling = parseFloat(directResult.data.grandTotal) || 0;
    } else if (data.noPurchaseRequest === true || data.noPurchaseRequest === 'true') {
      var smallAmount = parseFloat(data.totalAmount) || 0;
      var payCurrency = (data.currency || 'VND').toString().trim().toUpperCase();
      if (payCurrency !== 'VND' || !(smallAmount > 0 && smallAmount < 2000000)) {
        return createResponse(false, msg_('smallPaymentOverLimit'));
      }
      p2pBranch = 'simplified';
    } else {
      return createResponse(false, msg_('needAmOrPr'));
    }

    // Store metadata
    const metadata = {
      requesterSignature: requesterSignature,
      contractFiles: contractFiles,
      currency: data.currency,
      paymentInfo: data.paymentInfo,
      poRequestNo: data.poRequestNo,
      dueDate: data.dueDate,
      amountInWords: data.amountInWords,
      implementationTime: data.implementationTime,
      legalComment: data.legalComment || '',
      accountingComment: data.accountingComment || '',
      directorComment: data.directorComment || '',
      isNewVendor: data.isNewVendor === true || data.isNewVendor === 'true',
      amNo: amNo,
      amPrNo: amRecord ? (amRecord.prNo || '') : prRequestNo,
      noPurchaseRequest: !amNo && !prRequestNo,
      p2pBranch: p2pBranch,
      installmentNo: amNo ? (getPMTsByPR_(amRecord.prNo || '').filter(function(p) {
        return p.status !== 'Rejected' && p.status !== 'Từ chối';
      }).length + 1) : 1,
      installmentNote: (data.installmentNote || '').toString(),
      invoiceItems: data.productItems || [],
      vendorAccountName: (data.vendorAccountName || '').toString(),
      vendorAccountNo: (data.vendorAccountNo || '').toString(),
      vendorBankName: (data.vendorBankName || '').toString(),
      vendorBankTransferNote: (data.vendorBankTransferNote || '').toString(),
      driveLink: (data.driveLink || '').toString(),
      attachments: (data.attachments || '').toString()
    };
    rowData[CONFIG.COLUMNS.METADATA] = JSON.stringify(metadata);
    
    // Append to sheet
    sheet.appendRow(rowData);
    SpreadsheetApp.flush();
    
    Logger.log('[Payment Request] Saved to sheet successfully');
    
    // Add to history
    appendHistory(data.requestId, 'Submitted', data.requestor, 'Request submitted for approval');

    _appendAuditLog_({
      sheetName:  'PMT_Audit_Log',
      docNo:      data.requestId,
      flow:       'PMT',
      company:    data.company || '',
      action:     'Submit',
      role:       'requester',
      actorEmail: data.requestorEmail || '',
      actorName:  data.requestor || '',
      prevStatus: '',
      newStatus:  'Pending',
      note:       (data.installmentNote || '').toString(),
      extra:      { amNo: amNo, prNo: metadata.amPrNo, p2pBranch: p2pBranch, installmentNo: metadata.installmentNo }
    });
    try {
      var pmtHistSheet_ = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      if (pmtHistSheet_) {
        ensureP2PHistoryColumns_(pmtHistSheet_);
        appendP2PHistoryRow_(pmtHistSheet_, 36, data.requestId, {
          action:     'Submit',
          role:       'requester',
          actorEmail: data.requestorEmail || '',
          actorName:  data.requestor || '',
          prevStatus: '',
          newStatus:  'Pending',
          note:       (data.installmentNote || '').toString()
        });
      }
    } catch (histErr_) { Logger.log('[PMT] history row error: ' + histErr_.message); }

    // Send email notifications to all approvers
    sendApprovalEmails(data, requesterSignature);
    
    return createResponse(true, 'Payment request submitted successfully', {
      requestId: data.requestId
    });
    
  } catch (error) {
    Logger.log('[Payment Request] Error in handleSendPaymentRequest: ' + error.message);
    Logger.log('[Payment Request] Stack: ' + error.stack);
    return createResponse(false, msg_('errSave') + error.message);
  }
}

// ==================== APPROVE PAYMENT REQUEST ====================

function activePmtStage_(row) {
  var stages = [
    { key: 'budget', status: row[CONFIG.COLUMNS.BUDGET_STATUS], approver: row[CONFIG.COLUMNS.BUDGET_APPROVER] },
    { key: 'supplier', status: row[CONFIG.COLUMNS.SUPPLIER_STATUS], approver: row[CONFIG.COLUMNS.SUPPLIER_APPROVER] },
    { key: 'legal', status: row[CONFIG.COLUMNS.LEGAL_STATUS], approver: row[CONFIG.COLUMNS.LEGAL_APPROVER] },
    { key: 'accounting', status: row[CONFIG.COLUMNS.ACCOUNTING_STATUS], approver: row[CONFIG.COLUMNS.ACCOUNTING_APPROVER] },
    { key: 'director', status: row[CONFIG.COLUMNS.DIRECTOR_STATUS], approver: row[CONFIG.COLUMNS.DIRECTOR_APPROVER] },
    { key: 'final', status: row[CONFIG.COLUMNS.FINAL_STATUS], approver: row[CONFIG.COLUMNS.FINAL_APPROVER] }
  ];
  for (var i = 0; i < stages.length; i++) {
    var status = (stages[i].status || '').toString().trim();
    var approver = (stages[i].approver || '').toString().trim();
    var statusKey = status.toLowerCase();
    if (statusKey === 'n/a') continue;
    if (!approver && !status) continue;
    if (statusKey === 'approved') continue;
    return stages[i].key;
  }
  return '';
}

function handleApprovePaymentRequest(data) {
  try {
    Logger.log('[Payment Request] Processing approval...');
    Logger.log('[Payment Request] Request ID: ' + data.requestId);
    Logger.log('[Payment Request] Approver: ' + data.approver);
    Logger.log('[Payment Request] Stage: ' + data.stage);
    
    const sheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    const rowIndex = findRequestByIdInSheet(sheet, data.requestId);
    
    if (rowIndex === -1) {
      return createResponse(false, msg_('requestNotFoundPrefix') + data.requestId);
    }
    
    const row = sheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
    
    // Determine which approval stage
    let statusCol, signatureCol, approverCol, stageName;
    
    switch (data.stage) {
      case 'budget':
        statusCol = CONFIG.COLUMNS.BUDGET_STATUS;
        signatureCol = CONFIG.COLUMNS.BUDGET_SIGNATURE;
        approverCol = CONFIG.COLUMNS.BUDGET_APPROVER;
        stageName = 'Budget Approval';
        break;
      case 'supplier':
        statusCol = CONFIG.COLUMNS.SUPPLIER_STATUS;
        signatureCol = CONFIG.COLUMNS.SUPPLIER_SIGNATURE;
        approverCol = CONFIG.COLUMNS.SUPPLIER_APPROVER;
        stageName = 'Supplier Approval';
        break;
      case 'legal':
        statusCol = CONFIG.COLUMNS.LEGAL_STATUS;
        signatureCol = CONFIG.COLUMNS.LEGAL_SIGNATURE;
        approverCol = CONFIG.COLUMNS.LEGAL_APPROVER;
        stageName = 'Legal Approval';
        break;
      case 'accounting':
        statusCol = CONFIG.COLUMNS.ACCOUNTING_STATUS;
        signatureCol = CONFIG.COLUMNS.ACCOUNTING_SIGNATURE;
        approverCol = CONFIG.COLUMNS.ACCOUNTING_APPROVER;
        stageName = 'Accounting Approval';
        break;
      case 'director':
        statusCol = CONFIG.COLUMNS.DIRECTOR_STATUS;
        signatureCol = CONFIG.COLUMNS.DIRECTOR_SIGNATURE;
        approverCol = CONFIG.COLUMNS.DIRECTOR_APPROVER;
        stageName = 'Director Approval';
        break;
      case 'final':
        statusCol = CONFIG.COLUMNS.FINAL_STATUS;
        signatureCol = CONFIG.COLUMNS.FINAL_SIGNATURE;
        approverCol = CONFIG.COLUMNS.FINAL_APPROVER;
        stageName = 'Final Approval';
        break;
      default:
        return createResponse(false, msg_('invalidStagePrefix') + data.stage);
    }
    
    // Check current status
    const currentStatus = row[statusCol];
    if (currentStatus === 'Approved') {
      return createResponse(false, stageName + ' already approved. Cannot approve again.');
    }
    if (currentStatus === 'Rejected') {
      return createResponse(false, stageName + ' already rejected. Cannot approve.');
    }

    var activeStage = activePmtStage_(row);
    if (data.stage !== activeStage) {
      return createResponse(false, 'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: ' + (activeStage || 'không có'));
    }
    
    // Validate signature
    if (!data.signature) {
      return createResponse(false, msg_('signatureRequiredApproval'));
    }
    
    // Store signature
    const signatureUrl = storeSignature(data.signature, data.requestId, data.stage + '_approver');
    
    const prevOverall = (row[CONFIG.COLUMNS.OVERALL_STATUS] || 'Pending').toString();

    // Update status and signature
    sheet.getRange(rowIndex, statusCol + 1).setValue('Approved');
    sheet.getRange(rowIndex, signatureCol + 1).setValue(signatureUrl);
    
    // Check if all required approvals are complete
    const allApproved = checkAllApprovalsComplete(sheet, rowIndex);
    const newOverall = allApproved ? 'Approved' : prevOverall;
    if (allApproved) {
      sheet.getRange(rowIndex, CONFIG.COLUMNS.OVERALL_STATUS + 1).setValue('Approved');
    }
    SpreadsheetApp.flush();

    _appendAuditLog_({
      sheetName:  'PMT_Audit_Log',
      docNo:      data.requestId,
      flow:       'PMT',
      company:    (row[CONFIG.COLUMNS.COMPANY] || '').toString(),
      action:     'Approve',
      role:       data.stage || 'approver',
      actorEmail: (data.approverEmail || data.approver || '').toString(),
      actorName:  (data.approver || '').toString(),
      prevStatus: prevOverall,
      newStatus:  newOverall,
      note:       (data.comment || '').toString(),
      extra:      { stage: data.stage, stageName: stageName }
    });
    try {
      var pmtHistSheet_ = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      if (pmtHistSheet_) appendP2PHistoryRow_(pmtHistSheet_, 36, data.requestId, {
        action:     'Approve',
        role:       data.stage || 'approver',
        actorEmail: (data.approverEmail || data.approver || '').toString(),
        actorName:  (data.approver || '').toString(),
        prevStatus: prevOverall,
        newStatus:  newOverall,
        note:       (data.comment || '').toString()
      });
    } catch (histErr_) { Logger.log('[PMT] history row error: ' + histErr_.message); }

    // Add to history
    appendHistory(data.requestId, 'Approved', data.approver, stageName + ' approved');
    
    // Send notification to requester
    sendApprovalNotification(row, data.approver, stageName, 'approved', data.comment);
    
    Logger.log('[Payment Request] Approval processed successfully');
    
    return createResponse(true, stageName + ' approved successfully');
    
  } catch (error) {
    Logger.log('[Payment Request] Error in handleApprovePaymentRequest: ' + error.message);
    return createResponse(false, msg_('errApprove') + error.message);
  }
}

// ==================== REJECT PAYMENT REQUEST ====================

function handleRejectPaymentRequest(data) {
  try {
    Logger.log('[Payment Request] Processing rejection...');
    
    const sheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    const rowIndex = findRequestByIdInSheet(sheet, data.requestId);
    
    if (rowIndex === -1) {
      return createResponse(false, msg_('requestNotFoundPrefix') + data.requestId);
    }
    
    const row = sheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
    
    // Determine which approval stage
    let statusCol, stageName;
    
    switch (data.stage) {
      case 'budget':
        statusCol = CONFIG.COLUMNS.BUDGET_STATUS;
        stageName = 'Budget Approval';
        break;
      case 'supplier':
        statusCol = CONFIG.COLUMNS.SUPPLIER_STATUS;
        stageName = 'Supplier Approval';
        break;
      case 'legal':
        statusCol = CONFIG.COLUMNS.LEGAL_STATUS;
        stageName = 'Legal Approval';
        break;
      case 'accounting':
        statusCol = CONFIG.COLUMNS.ACCOUNTING_STATUS;
        stageName = 'Accounting Approval';
        break;
      case 'director':
        statusCol = CONFIG.COLUMNS.DIRECTOR_STATUS;
        stageName = 'Director Approval';
        break;
      case 'final':
        statusCol = CONFIG.COLUMNS.FINAL_STATUS;
        stageName = 'Final Approval';
        break;
      default:
        return createResponse(false, msg_('invalidStagePrefix') + data.stage);
    }
    
    // Check current status
    const currentStatus = row[statusCol];
    if (currentStatus === 'Rejected') {
      return createResponse(false, stageName + ' already rejected. Cannot reject again.');
    }
    if (currentStatus === 'Approved') {
      return createResponse(false, stageName + ' already approved. Cannot reject.');
    }
    
    const prevOverall = (row[CONFIG.COLUMNS.OVERALL_STATUS] || 'Pending').toString();

    // Update status
    sheet.getRange(rowIndex, statusCol + 1).setValue('Rejected');
    sheet.getRange(rowIndex, CONFIG.COLUMNS.OVERALL_STATUS + 1).setValue('Rejected');
    SpreadsheetApp.flush();

    const reason = data.rejectReason || 'No reason provided';
    _appendAuditLog_({
      sheetName:  'PMT_Audit_Log',
      docNo:      data.requestId,
      flow:       'PMT',
      company:    (row[CONFIG.COLUMNS.COMPANY] || '').toString(),
      action:     'Reject',
      role:       data.stage || 'approver',
      actorEmail: (data.approverEmail || data.approver || '').toString(),
      actorName:  (data.approver || '').toString(),
      prevStatus: prevOverall,
      newStatus:  'Rejected',
      note:       reason,
      extra:      { stage: data.stage, stageName: stageName }
    });
    try {
      var pmtHistSheet_ = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEET_NAME);
      if (pmtHistSheet_) appendP2PHistoryRow_(pmtHistSheet_, 36, data.requestId, {
        action:     'Reject',
        role:       data.stage || 'approver',
        actorEmail: (data.approverEmail || data.approver || '').toString(),
        actorName:  (data.approver || '').toString(),
        prevStatus: prevOverall,
        newStatus:  'Rejected',
        note:       reason
      });
    } catch (histErr_) { Logger.log('[PMT] history row error: ' + histErr_.message); }

    // Add to history
    appendHistory(data.requestId, 'Rejected', data.approver, stageName + ' rejected: ' + reason);
    
    // Send notification to requester
    sendApprovalNotification(row, data.approver, stageName, 'rejected', reason);
    
    Logger.log('[Payment Request] Rejection processed successfully');
    
    return createResponse(true, stageName + ' rejected successfully');
    
  } catch (error) {
    Logger.log('[Payment Request] Error in handleRejectPaymentRequest: ' + error.message);
    return createResponse(false, msg_('errReject') + error.message);
  }
}

// ==================== GET HISTORY ====================

function handleGetPaymentRequestHistory(data) {
  try {
    const historySheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    const dataRange = historySheet.getDataRange();
    
    if (dataRange.getNumRows() <= 1) {
      return createResponse(true, 'No history found', { history: [] });
    }
    
    const values = dataRange.getValues();
    const history = [];
    
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (row[0] === data.requestId) {
        history.push({
          requestId: row[0],
          timestamp: row[1],
          action: row[2],
          actor: row[3],
          note: row[4]
        });
      }
    }
    
    return createResponse(true, 'History retrieved successfully', { history: history });
    
  } catch (error) {
    Logger.log('[Payment Request] Error in handleGetPaymentRequestHistory: ' + error.message);
    return createResponse(false, msg_('errHistory') + error.message);
  }
}

// ==================== GET RECENT PAYMENT REQUESTS (list view) ====================

function handleGetRecentPaymentRequests(data) {
  try {
    const sheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return createResponse(true, 'No requests found', { requests: [] });

    // getRange 3rd arg is a row count. Last 5000 data rows, columns A through
    // SUBMITTED_AT. Skip METADATA (large JSON) and do not scan the whole sheet.
    var PMT_LIST_WINDOW = 5000;
    var startRow = Math.max(2, lastRow - PMT_LIST_WINDOW + 1);
    var numRows = lastRow - startRow + 1;
    var numCols = CONFIG.COLUMNS.SUBMITTED_AT + 1;
    const values = sheet.getRange(startRow, 1, numRows, numCols).getValues();
    if (!values.length) return createResponse(true, 'No requests found', { requests: [] });

    const C = CONFIG.COLUMNS;
    const emailFilter = (data.requestorEmail || '').toString().trim().toLowerCase();
    const requests = [];

    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (!row[C.REQUEST_ID]) continue;
      if (emailFilter && (row[C.REQUESTOR_EMAIL] || '').toString().trim().toLowerCase() !== emailFilter) continue;

      const overallStatus = (row[C.OVERALL_STATUS] || 'Pending').toString().trim();
      const approvalSteps = [
        { role: 'Budget',     status: row[C.BUDGET_STATUS],     approver: row[C.BUDGET_APPROVER] },
        { role: 'Supplier',   status: row[C.SUPPLIER_STATUS],   approver: row[C.SUPPLIER_APPROVER] },
        { role: 'Legal',      status: row[C.LEGAL_STATUS],      approver: row[C.LEGAL_APPROVER] },
        { role: 'Accounting', status: row[C.ACCOUNTING_STATUS], approver: row[C.ACCOUNTING_APPROVER] },
        { role: 'Director',   status: row[C.DIRECTOR_STATUS],   approver: row[C.DIRECTOR_APPROVER] }
      ];
      const approvedCount = approvalSteps.filter(s => (s.status || '').toString().toLowerCase() === 'approved').length;
      const totalSteps    = approvalSteps.filter(s => s.approver).length || 1;

      requests.push({
        requestId:      row[C.REQUEST_ID],
        requestDate:    row[C.REQUEST_DATE],
        company:        row[C.COMPANY],
        requestor:      row[C.REQUESTOR],
        requestorEmail: row[C.REQUESTOR_EMAIL],
        supplier:       row[C.SUPPLIER],
        totalAmount:    row[C.TOTAL_AMOUNT],
        paymentType:    row[C.PAYMENT_TYPE],
        purpose:        row[C.PURPOSE],
        overallStatus:  overallStatus,
        approvedCount:  approvedCount,
        totalSteps:     totalSteps,
        submittedAt:    row[C.SUBMITTED_AT] || row[C.REQUEST_DATE]
      });
    }

    // Most recent first
    requests.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    return createResponse(true, 'Requests retrieved', { requests: requests });

  } catch (error) {
    Logger.log('[Payment Request] Error in handleGetRecentPaymentRequests: ' + error.message);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== GET REQUEST DETAILS ====================

function handleGetPaymentRequestDetails(data) {
  try {
    const sheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    const rowIndex = findRequestByIdInSheet(sheet, data.requestId);
    
    if (rowIndex === -1) {
      return createResponse(false, msg_('requestNotFoundPrefix') + data.requestId);
    }
    
    const row = sheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
    
    const details = {
      requestId: row[CONFIG.COLUMNS.REQUEST_ID],
      requestDate: row[CONFIG.COLUMNS.REQUEST_DATE],
      company: row[CONFIG.COLUMNS.COMPANY],
      requestor: row[CONFIG.COLUMNS.REQUESTOR],
      requestorEmail: row[CONFIG.COLUMNS.REQUESTOR_EMAIL],
      department: row[CONFIG.COLUMNS.DEPARTMENT],
      purchaseType: row[CONFIG.COLUMNS.PURCHASE_TYPE],
      prRequestNo: row[CONFIG.COLUMNS.PR_REQUEST_NO],
      purpose: row[CONFIG.COLUMNS.PURPOSE],
      supplier: row[CONFIG.COLUMNS.SUPPLIER],
      recipient: row[CONFIG.COLUMNS.RECIPIENT],
      productItems: JSON.parse(row[CONFIG.COLUMNS.PRODUCT_ITEMS] || '[]'),
      totalAmount: row[CONFIG.COLUMNS.TOTAL_AMOUNT],
      paymentType: row[CONFIG.COLUMNS.PAYMENT_TYPE],
      paymentPhases: JSON.parse(row[CONFIG.COLUMNS.PAYMENT_PHASES] || '[]'),
      budgetApprover: row[CONFIG.COLUMNS.BUDGET_APPROVER],
      budgetStatus: row[CONFIG.COLUMNS.BUDGET_STATUS],
      budgetSignature: row[CONFIG.COLUMNS.BUDGET_SIGNATURE],
      supplierApprover: row[CONFIG.COLUMNS.SUPPLIER_APPROVER],
      supplierStatus: row[CONFIG.COLUMNS.SUPPLIER_STATUS],
      supplierSignature: row[CONFIG.COLUMNS.SUPPLIER_SIGNATURE],
      legalApprover: row[CONFIG.COLUMNS.LEGAL_APPROVER],
      legalStatus: row[CONFIG.COLUMNS.LEGAL_STATUS],
      legalSignature: row[CONFIG.COLUMNS.LEGAL_SIGNATURE],
      accountingApprover: row[CONFIG.COLUMNS.ACCOUNTING_APPROVER],
      accountingStatus: row[CONFIG.COLUMNS.ACCOUNTING_STATUS],
      accountingSignature: row[CONFIG.COLUMNS.ACCOUNTING_SIGNATURE],
      directorApprover: row[CONFIG.COLUMNS.DIRECTOR_APPROVER],
      directorStatus: row[CONFIG.COLUMNS.DIRECTOR_STATUS],
      directorSignature: row[CONFIG.COLUMNS.DIRECTOR_SIGNATURE],
      finalApprover: row[CONFIG.COLUMNS.FINAL_APPROVER],
      finalStatus: row[CONFIG.COLUMNS.FINAL_STATUS],
      finalSignature: row[CONFIG.COLUMNS.FINAL_SIGNATURE],
      overallStatus: row[CONFIG.COLUMNS.OVERALL_STATUS],
      submittedAt: row[CONFIG.COLUMNS.SUBMITTED_AT],
      metadata: JSON.parse(row[CONFIG.COLUMNS.METADATA] || '{}')
    };
    
    return createResponse(true, 'Request details retrieved successfully', { details: details });
    
  } catch (error) {
    Logger.log('[Payment Request] Error in handleGetPaymentRequestDetails: ' + error.message);
    return createResponse(false, msg_('errDetail') + error.message);
  }
}

// ==================== HELPER FUNCTIONS ====================

/** Map payment_request.html (v2) payload fields to legacy sheet/email shape. */
function normalizePaymentRequestData_(data) {
  if (!data) return data;
  data.company = (data.company || data.companyName || '').toString().trim();
  data.requestor = (data.requestor || data.requestorName || '').toString().trim();
  data.supplier = (data.supplier || data.vendorName || '').toString().trim();
  data.totalAmount = data.totalAmount || data.finalAmount || '';
  if (!data.requestDate) {
    data.requestDate = new Date().toISOString().split('T')[0];
  }
  if (!data.purchaseType) data.purchaseType = 'services';
  if (!data.department) data.department = data.department || '';
  if (!data.paymentType) {
    data.paymentType = [data.paymentType1, data.paymentType2].filter(Boolean).join(' / ');
  }

  if (!data.productItems || !data.productItems.length) {
    var invoiceRaw = data.invoiceItems;
    if (typeof invoiceRaw === 'string') {
      try { invoiceRaw = JSON.parse(invoiceRaw); } catch (_) { invoiceRaw = []; }
    }
    if (Array.isArray(invoiceRaw) && invoiceRaw.length) {
      data.productItems = invoiceRaw;
    }
  }

  if (!data.paymentPhases || !data.paymentPhases.length) {
    var phaseAmt = parseFloat(data.totalAmount) || 0;
    data.paymentPhases = [{
      phase: (data.installmentNo || '1').toString(),
      amount: phaseAmt,
      description: (data.paymentDescription || '').toString(),
      paymentType: data.paymentType || ''
    }];
  }

  return data;
}

function validatePaymentRequest(data) {
  const errors = [];
  const isV2 = !!(data.companyName || data.finalAmount || data.invoiceItems || data.vendorName);

  if (!data.requestId) errors.push('Request ID is required');

  if (isV2) {
    if (!data.company) errors.push('Company is required');
    if (!data.requestor) errors.push('Requestor is required');
    if (!data.supplier) errors.push('Supplier is required');
    var amt = parseFloat(data.totalAmount || data.finalAmount);
    if (!amt || amt <= 0) errors.push('Amount is required');
    return { valid: errors.length === 0, errors: errors };
  }

  if (!data.company) errors.push('Company is required');
  if (!data.requestor) errors.push('Requestor is required');
  if (!data.purchaseType) errors.push('Purchase type is required');
  if (!data.supplier) errors.push('Supplier is required');
  if (!data.budgetApprover) errors.push('Budget approver is required');
  if (!data.supplierApprover) errors.push('Supplier approver is required');
  if (!data.finalApprover) errors.push('Final approver is required');

  if (!data.productItems || data.productItems.length === 0) {
    errors.push('At least one product item is required');
  }

  if (!data.paymentPhases || data.paymentPhases.length === 0) {
    errors.push('At least one payment phase is required');
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}

function checkAllApprovalsComplete(sheet, rowIndex) {
  const row = sheet.getRange(rowIndex, 1, 1, 36).getValues()[0];
  
  const budgetStatus = row[CONFIG.COLUMNS.BUDGET_STATUS];
  const supplierStatus = row[CONFIG.COLUMNS.SUPPLIER_STATUS];
  const legalStatus = row[CONFIG.COLUMNS.LEGAL_STATUS];
  const accountingStatus = row[CONFIG.COLUMNS.ACCOUNTING_STATUS];
  const directorStatus = row[CONFIG.COLUMNS.DIRECTOR_STATUS];
  const finalStatus = row[CONFIG.COLUMNS.FINAL_STATUS];
  
  // Check required approvals
  if (budgetStatus !== 'Approved') return false;
  if (supplierStatus !== 'Approved') return false;
  if (accountingStatus !== 'Approved') return false;
  if (directorStatus !== 'Approved') return false;
  if (finalStatus !== 'Approved') return false;
  
  // Legal approval is optional (check if approver is assigned)
  if (row[CONFIG.COLUMNS.LEGAL_APPROVER] && legalStatus !== 'Approved') return false;
  
  return true;
}

function storeProductAttachments(productItems, requestId) {
  if (!productItems) return [];
  
  return productItems.map((item, index) => {
    const itemCopy = { ...item };
    if (item.attachments && item.attachments.length > 0) {
      itemCopy.attachmentUrls = item.attachments.map((file, fileIndex) => {
        return storeFileInDrive(file, requestId, `product_${index}_${fileIndex}`);
      });
    }
    delete itemCopy.attachments; // Remove base64 data
    return itemCopy;
  });
}

function storePaymentPhaseAttachments(paymentPhases, requestId) {
  if (!paymentPhases) return [];
  
  return paymentPhases.map((phase, index) => {
    const phaseCopy = { ...phase };
    
    if (phase.acceptanceMinutes && phase.acceptanceMinutes.length > 0) {
      phaseCopy.acceptanceMinutesUrls = phase.acceptanceMinutes.map((file, fileIndex) => {
        return storeFileInDrive(file, requestId, `phase_${index}_acceptance_${fileIndex}`);
      });
      delete phaseCopy.acceptanceMinutes;
    }
    
    if (phase.supplierPaymentRequest && phase.supplierPaymentRequest.length > 0) {
      phaseCopy.supplierPaymentRequestUrls = phase.supplierPaymentRequest.map((file, fileIndex) => {
        return storeFileInDrive(file, requestId, `phase_${index}_supplier_${fileIndex}`);
      });
      delete phaseCopy.supplierPaymentRequest;
    }
    
    if (phase.invoice && phase.invoice.length > 0) {
      phaseCopy.invoiceUrls = phase.invoice.map((file, fileIndex) => {
        return storeFileInDrive(file, requestId, `phase_${index}_invoice_${fileIndex}`);
      });
      delete phaseCopy.invoice;
    }
    
    return phaseCopy;
  });
}

function storeContractAttachments(contractAttachments, requestId) {
  if (!contractAttachments || contractAttachments.length === 0) return [];
  
  return contractAttachments.map((file, index) => {
    return storeFileInDrive(file, requestId, `contract_${index}`);
  });
}

function storeFileInDrive(fileData, requestId, fileName) {
  try {
    const folder = getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);
    const requestFolder = getOrCreateFolder(requestId, folder);
    
    // If fileData is base64
    if (typeof fileData === 'string' && fileData.startsWith('data:')) {
      const base64Data = fileData.split(',')[1];
      const mimeType = fileData.split(';')[0].split(':')[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
      const file = requestFolder.createFile(blob);
      return file.getUrl();
    }
    
    // If fileData is object with name and data
    if (fileData.data) {
      const base64Data = fileData.data.split(',')[1];
      const mimeType = fileData.data.split(';')[0].split(':')[1];
      const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileData.name || fileName);
      const file = requestFolder.createFile(blob);
      return file.getUrl();
    }
    
    return '';
  } catch (error) {
    Logger.log('[Payment Request] Error storing file: ' + error.message);
    return '';
  }
}

function storeSignature(signatureData, requestId, signatureType) {
  try {
    if (!signatureData) return '';
    
    const folder = getOrCreateFolder(CONFIG.DRIVE_FOLDER_NAME);
    const requestFolder = getOrCreateFolder(requestId, folder);
    
    const base64Data = signatureData.split(',')[1];
    const mimeType = signatureData.split(';')[0].split(':')[1];
    const fileName = `signature_${signatureType}_${new Date().getTime()}.png`;
    const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
    const file = requestFolder.createFile(blob);
    
    return file.getUrl();
  } catch (error) {
    Logger.log('[Payment Request] Error storing signature: ' + error.message);
    return '';
  }
}

function sendApprovalEmails(data, requesterSignatureUrl) {
  try {
    const approvers = [
      { name: data.budgetApprover, email: data.budgetApproverEmail, stage: 'budget' },
      { name: data.supplierApprover, email: data.supplierApproverEmail, stage: 'supplier' },
      { name: data.legalApprover, email: data.legalApproverEmail, stage: 'legal' },
      { name: data.accountingApprover, email: data.accountingApproverEmail, stage: 'accounting' },
      { name: data.directorApprover, email: data.directorApproverEmail, stage: 'director' },
      { name: data.finalApprover, email: data.finalApproverEmail, stage: 'final' }
    ].filter(a => a.email);
    
    const baseUrl = BASE_URL;
    const approveUrl = `${baseUrl}/approve_payment_request.html?requestId=${data.requestId}`;
    const rejectUrl = `${baseUrl}/reject_payment_request.html?requestId=${data.requestId}`;
    
    const subject = `[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - ${data.requestId}`;
    
    const emailBody = `
      <p>Kính gửi các cấp quản lý,</p>
      <p>Đề nghị mua hàng số <b>${data.requestId}</b> đã được tạo và đang chờ phê duyệt.</p>
      
      <h3>Thông tin chung:</h3>
      <ul>
        <li><b>Số đề nghị:</b> ${data.requestId}</li>
        <li><b>Ngày lập:</b> ${data.requestDate}</li>
        <li><b>ty:</b> ${data.company}</li>
        <li><b>Người đề nghị:</b> ${data.requestor} (${data.requestorEmail})</li>
        <li><b>Bộ phận:</b> ${data.department}</li>
      </ul>
      
      <h3>Đề nghị mua hàng:</h3>
      <ul>
        <li><b>Loại:</b> ${data.purchaseType}</li>
        <li><b>Số PR:</b> ${data.prRequestNo}</li>
        <li><b>Mục đích:</b> ${data.purpose}</li>
        <li><b>Nhà cung cấp:</b> ${data.supplier}</li>
        <li><b>Người nhận:</b> ${data.recipient}</li>
        <li><b>Tổng số tiền:</b> ${data.totalAmount}</li>
      </ul>
      
      <h3>Hành động:</h3>
      <p>
        <a href="${approveUrl}" style="background-color: #34A853; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-right: 10px;">Phê duyệt</a>
        <a href="${rejectUrl}" style="background-color: #EA4335; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Từ chối</a>
      </p>
      
      <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>
    `;
    
    approvers.forEach(approver => {
      try {
        GmailApp.sendEmail(approver.email, subject, '', {
          htmlBody: emailBody,
          replyTo: data.requestorEmail,
          name: 'TLC Group Workflow'
        });
        Logger.log('[Payment Request] Email sent to: ' + approver.email);
      } catch (emailError) {
        Logger.log('[Payment Request] Error sending email to ' + approver.email + ': ' + emailError.message);
      }
    });
    
  } catch (error) {
    Logger.log('[Payment Request] Error in sendApprovalEmails: ' + error.message);
  }
}

function sendApprovalNotification(row, approver, stage, action, comment) {
  try {
    const requestorEmail = row[CONFIG.COLUMNS.REQUESTOR_EMAIL];
    const requestId = row[CONFIG.COLUMNS.REQUEST_ID];
    const requestor = row[CONFIG.COLUMNS.REQUESTOR];
    
    if (!requestorEmail) return;
    
    const subject = `[ĐỀ NGHỊ MUA HÀNG] ${stage} ${action === 'approved' ? 'đã phê duyệt' : 'đã từ chối'} - ${requestId}`;
    
    const emailBody = `
      <p>Kính gửi ${requestor},</p>
      <p>Đề nghị mua hàng số <b>${requestId}</b> của bạn đã được ${action === 'approved' ? 'phê duyệt' : 'từ chối'} bởi ${approver} tại giai đoạn <b>${stage}</b>.</p>
      
      ${comment ? `<p><b>Nhận xét:</b> ${comment}</p>` : ''}
      
      <p>Vui lòng truy cập hệ thống để xem chi tiết.</p>
      
      <p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>
    `;
    
    GmailApp.sendEmail(requestorEmail, subject, '', {
      htmlBody: emailBody,
      name: 'TLC Group Workflow'
    });
    
    Logger.log('[Payment Request] Notification sent to requester: ' + requestorEmail);
    
  } catch (error) {
    Logger.log('[Payment Request] Error sending notification: ' + error.message);
  }
}

function appendHistory(requestId, action, actor, note) {
  try {
    const historySheet = getOrCreateSheet(CONFIG.SHEET_NAME);
    
    // Create header if sheet is empty
    if (historySheet.getLastRow() === 0) {
      historySheet.appendRow(['Request ID', 'Timestamp', 'Action', 'Actor', 'Note']);
    }
    
    historySheet.appendRow([
      requestId,
      new Date().toISOString(),
      action,
      actor,
      note
    ]);
    
  } catch (error) {
    Logger.log('[Payment Request] Error appending history: ' + error.message);
  }
}

function getOrCreateSheet(sheetName) {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    
    // Create headers based on sheet type
    if (sheetName === CONFIG.SHEET_NAME) {
      sheet.appendRow(PMT_HEADERS_.concat(P2P_HISTORY_HEADERS_));
    } else if (sheetName === CONFIG.SHEET_NAME) {
      // Payment_Request_History sheet - will be created manually by user
      // Header row should already exist
    }
  } else if (sheetName === CONFIG.SHEET_NAME) {
    standardizeWorkflowSheet_(sheet, PMT_HEADERS_);
  }
  
  return sheet;
}

function getOrCreateFolder(folderName, parentFolder) {
  const parent = parentFolder || DriveApp.getRootFolder();
  const folders = parent.getFoldersByName(folderName);
  
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parent.createFolder(folderName);
  }
}

function findRequestByIdInSheet(sheet, requestId) {
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();
  
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === requestId) {
      return i + 1; // Return 1-based row index
    }
  }
  
  return -1;
}

function parseUrlEncodedData(contents) {
  const params = {};
  const pairs = contents.split('&');

  for (let i = 0; i < pairs.length; i++) {
    const eqIdx = pairs[i].indexOf('=');
    if (eqIdx === -1) continue;
    const rawKey = pairs[i].substring(0, eqIdx);
    const rawVal = pairs[i].substring(eqIdx + 1);
    // URLSearchParams encodes spaces as '+'; decodeURIComponent only handles %20
    const key   = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const value = decodeURIComponent(rawVal.replace(/\+/g, ' '));
    params[key] = value;
  }

  return params;
}

function createResponse(success, message, data = {}) {
  const response = {
    success: success,
    message: message,
    ...data
  };
  
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== SUPPLIER MANAGEMENT ====================

/**
 * Get suppliers from "Master Vendor" sheet, optionally filtered by companyGroupKey
 */
function handleGetSuppliers(data) {
  try {
    Logger.log('[Payment Request] Getting suppliers from "Master Vendor" sheet');
    const companyGroupKey = (data.companyGroupKey || '').toString().trim().toLowerCase();

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName('Master Vendor');

    if (!sheet) {
      Logger.log('[Payment Request] Sheet "Master Vendor" not found');
      return createResponse(false, msg_('sheetMasterVendorMissing'));
    }

    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) {
      return createResponse(true, 'No suppliers found', { suppliers: [], count: 0 });
    }

    // Col H=7: Vendor_Full_Name, I=8: Vendor_Type, J=9: Tax_ID, K=10: Address
    // Col G=6: company group key for filtering
    const suppliers = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const vendorName = (row[7] || '').toString().trim();
      if (!vendorName) continue;
      if (companyGroupKey) {
        const rowKey = (row[6] || '').toString().trim().toLowerCase();
        if (rowKey && rowKey !== companyGroupKey) continue;
      }
      suppliers.push({
        vendor_name: vendorName,
        vendor_type: (row[8] || '').toString().trim(),
        tax_id:      (row[9] || '').toString().trim(),
        address:     (row[10] || '').toString().trim()
      });
    }

    suppliers.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name, 'vi'));
    Logger.log('[Payment Request] Found ' + suppliers.length + ' suppliers');
    return createResponse(true, 'Suppliers retrieved successfully', { suppliers: suppliers, count: suppliers.length });

  } catch (error) {
    Logger.log('[Payment Request] Error getting suppliers: ' + error.message);
    return createResponse(false, msg_('errorPrefixEn') + error.message);
  }
}

function handleGetVendorBanks(data) {
  try {
    // Exact match: col B (Master Vendor_Bank) must equal col H (Master Vendor).
    // Only rows where col J Status === 'Active' (case-insensitive) are returned.
    const vendorName = (data.vendorName || '').toString().trim();
    Logger.log('[Payment Request] Getting vendor banks for: ' + vendorName);

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName('Master Vendor_Bank');

    if (!sheet) {
      Logger.log('[Payment Request] Sheet "Master Vendor_Bank" not found');
      return createResponse(false, msg_('sheetMasterVendorBankMissing'));
    }

    const rows = sheet.getDataRange().getValues();
    if (rows.length < 2) {
      return createResponse(true, 'No banks found', { banks: [] });
    }

    // A=0: Name, B=1: Vendor_name, C=2: Vendor Bank Name, D=3: Note,
    // E=4: Bank Name, F=5: Bank Number, G=6: Bank Address,
    // H=7: SWIFT code, I=8: Beneficiary Bank Address, J=9: Status
    const banks = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowVendor = (row[1] || '').toString().trim(); // col B: Vendor_name — exact match to col H
      const status    = (row[9] || '').toString().trim(); // col J: Status — must be "Active"
      if (vendorName && rowVendor !== vendorName) continue;
      if (status.toLowerCase() !== 'active') continue;
      banks.push({
        account_name: (row[2] || '').toString().trim(), // Vendor Bank Name
        account_no:   (row[5] || '').toString().trim(), // Bank Number
        bank_name:    (row[4] || '').toString().trim(), // Bank Name
        note:         (row[3] || '').toString().trim(), // Note
        bank_address: (row[6] || '').toString().trim(), // Bank Address
        swift_code:   (row[7] || '').toString().trim()  // SWIFT code
      });
    }

    Logger.log('[Payment Request] Found ' + banks.length + ' banks for: ' + vendorName);
    return createResponse(true, 'Banks retrieved successfully', { banks: banks });

  } catch (error) {
    Logger.log('[Payment Request] Error getting vendor banks: ' + error.message);
    return createResponse(false, msg_('errorPrefixEn') + error.message);
  }
}

/**
 * Add new supplier to "Nhà cung cấp" sheet
 */
function handleAddSupplier(data) {
  try {
    const { name, address, phone, email, taxCode, companyType } = data;
    
    Logger.log('[Payment Request] Adding new supplier: ' + name);
    
    // Validate required field
    if (!name || name.trim() === '') {
      return createResponse(false, msg_('supplierNameRequired'));
    }
    
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const suppliersSheet = ss.getSheetByName(CONFIG.SUPPLIERS_SHEET_NAME);
    
    if (!suppliersSheet) {
      Logger.log('[Payment Request] Sheet "Nhà cung cấp" not found');
      return createResponse(false, msg_('sheetSuppliersNotFound'));
    }
    
    // Check for duplicates in Column C
    const lastRow = suppliersSheet.getLastRow();
    if (lastRow > 1) {
      const existingNames = suppliersSheet.getRange(2, 3, lastRow - 1, 1).getValues();
      const isDuplicate = existingNames.some(row => 
        row[0] && row[0].toString().trim().toLowerCase() === name.trim().toLowerCase()
      );
      
      if (isDuplicate) {
        Logger.log('[Payment Request] Supplier already exists: ' + name);
        return createResponse(false, msg_('supplierExists', name));
      }
    }
    
    // Generate unique ID for Column A
    const newId = 'VD' + String(lastRow).padStart(3, '0');
    
    // Prepare row data matching the sheet structure
    const newRow = [
      newId,                           // A: Name (ID)
      name.substring(0, 50),           // B: Vendor (short name)
      name,                            // C: Vendor_Full_Name
      '',                              // D: Công ty mua hàng (empty for now)
      '',                              // E: QBO_Code (empty for now)
      companyType || 'Others',         // F: Vendor_Type
      taxCode || '',                   // G: Tax_ID
      address || '',                   // H: Address
      '',                              // I: QB_ID
      '',                              // J: FCT
      'VND',                           // K: Payment_Currency
      '',                              // L: Quoc_tich
      '',                              // M: Khong_cu_tru
      '',                              // N: Loai_giay_to
      '',                              // O: CMND/CCCD/Ho_Chieu
      '',                              // P: Ngay_cap
      '',                              // Q: Noi_cap
      phone || '',                     // R: So_dien_thoai_lien_he
      address || '',                   // S: Dia_chi_lien_he
      email || '',                     // T: Email_lien_he
      '',                              // U: Gioi_tinh
      '',                              // V: Ngay_sinh
      '',                              // W: Loan
      '',                              // X: Freelancer_Job_Name
      'Yes'                            // Y: Active
    ];
    
    // Append the new row
    suppliersSheet.appendRow(newRow);
    
    Logger.log('[Payment Request] Successfully added supplier: ' + name + ' with ID: ' + newId);
    
    return createResponse(true, 'Supplier added successfully', {
      supplierId: newId,
      name: name
    });
    
  } catch (error) {
    Logger.log('[Payment Request] Error adding supplier: ' + error.message);
    return createResponse(false, msg_('errorPrefixEn') + error.message);
  }
}

// ==================== EMPLOYEE MANAGEMENT ====================

/**
 * Get all employees from "Nhân viên" sheet
 */
function handleGetEmployees(requestBody) {
  try {
    Logger.log('[Payment Request] === handleGetEmployees called ===');
    
    const ss = SpreadsheetApp.openById(USERS_SHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.EMPLOYEES_SHEET_NAME);
    
    if (!sheet) {
      Logger.log('[Payment Request] ❌ Sheet "' + CONFIG.EMPLOYEES_SHEET_NAME + '" not found');
      return createResponse(false, msg_('sheetMissing', CONFIG.EMPLOYEES_SHEET_NAME));
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      Logger.log('[Payment Request] ⚠️ No employee data found (only header row)');
      return createResponse(true, 'Thành công', { employees: [] });
    }
    
    // Column mapping based on sheet structure:
    // A: Họ và tên (Name) - index 0
    // B: Chức vụ (Position) - index 1
    // C: Phòng ban (Department) - index 2
    // D: Công ty (Company) - index 3
    // E: Email - index 4
    // F: Điện thoại (Phone) - index 5
    // G: Status - index 6
    // H: EmployeeId - index 7
    // I: Role - index 8
    // J: isAdmin - index 9
    
    const employees = [];
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      // Only include active employees
      if (row[6] === 'Active' || !row[6] || row[6] === '') {
        employees.push({
          name: row[0] || '',           // Họ và tên
          position: row[1] || '',       // Chức vụ
          department: row[2] || '',     // Phòng ban (Column C)
          company: row[3] || '',        // Công ty
          email: row[4] || '',          // Email
          phone: row[5] || '',          // Điện thoại
          status: row[6] || 'Active',   // Status
          employeeId: row[7] || '',     // EmployeeId
          role: row[8] || '',           // Role
          isAdmin: row[9] === 'TRUE' || row[9] === true  // isAdmin
        });
      }
    }
    
    Logger.log('[Payment Request] ✅ Found ' + employees.length + ' active employees');
    return createResponse(true, 'Thành công', { employees: employees });
  } catch (error) {
    Logger.log('[Payment Request] ❌ ERROR in handleGetEmployees: ' + error.toString());
    Logger.log('[Payment Request] ❌ Error stack: ' + error.stack);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== GET PURCHASE ORDER TYPES ====================

function handleGetPurchaseOrderTypes(data) {
  try {
    Logger.log('[Payment Request] === handleGetPurchaseOrderTypes called ===');
    
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.PURCHASE_ORDER_SHEET_NAME);
    
    if (!sheet) {
      Logger.log('[Payment Request] ❌ Sheet "' + CONFIG.PURCHASE_ORDER_SHEET_NAME + '" not found');
      return createResponse(false, msg_('sheetMissing', CONFIG.PURCHASE_ORDER_SHEET_NAME));
    }
    
    const dataRange = sheet.getDataRange();
    const values = dataRange.getValues();
    
    if (values.length < 2) {
      Logger.log('[Payment Request] ⚠️ No purchase order types found (only header row)');
      return createResponse(true, 'Thành công', { types: [] });
    }
    
    // Column mapping:
    // A: No (index 0)
    // B: Type (index 1)
    
    const types = [];
    // Start from row 2 (index 1) to skip header
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const typeValue = row[1]; // Column B (Type)
      
      // Skip empty rows
      if (typeValue && typeValue.toString().trim() !== '') {
        types.push({
          no: row[0] || '',           // Column A (No)
          type: typeValue.toString().trim()  // Column B (Type)
        });
      }
    }
    
    Logger.log('[Payment Request] ✅ Found ' + types.length + ' purchase order types');
    return createResponse(true, 'Thành công', { types: types });
  } catch (error) {
    Logger.log('[Payment Request] ❌ ERROR in handleGetPurchaseOrderTypes: ' + error.toString());
    Logger.log('[Payment Request] ❌ Error stack: ' + error.stack);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== GOODS CATALOG ====================

/**
 * Returns goods rows from Goods-KTT sheet (raw headers as keys).
 * Lightweight — does not read employees or suppliers.
 */
function handleGetGoodsCatalog(data) {
  try {
    Logger.log('[P2P] === handleGetGoodsCatalog called ===');
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var goodsSheet = ss.getSheetByName('Goods-KTT');
    if (!goodsSheet) {
      Logger.log('[P2P] ⚠️ Sheet "Goods-KTT" not found');
      return createResponse(true, 'Goods-KTT sheet not found', { goods: [] });
    }
    var vals    = goodsSheet.getDataRange().getValues();
    var headers = vals[0];
    var goods   = vals.slice(1).map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) { obj[h] = row[i]; });
      return obj;
    }).filter(function(r) { return r[headers[0]]; });
    Logger.log('[P2P] ✅ Goods-KTT records: ' + goods.length);
    return createResponse(true, 'Goods catalog fetched successfully', { goods: goods });
  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleGetGoodsCatalog: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== P2P MASTER DATA ====================

/**
 * Returns the reference data needed exclusively by the Purchase Request flow:
 *   - employees  (Master Employee sheet)
 *   - goods      (Goods-KTT sheet — MOQ catalog)
 *   - suppliers  (Nhà cung cấp sheet — suggested vendor list)
 *
 * Response shape mirrors handleGetMasterData in TLCG_CORE_BACKEND so the
 * purchase_request.html frontend works without any data-mapping changes.
 */
function handleGetP2PMasterData(data) {
  try {
    Logger.log('[P2P] handleGetP2PMasterData called');
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

    // ── Employees (Master Employee) ──────────────────────────
    // Column layout: A=Họ và tên, B=Chức vụ, C=Phòng ban, D=Công ty,
    //                E=Email, F=Điện thoại, G=Status, H=EmployeeId, I=Role, J=isAdmin
    var empSheet = ss.getSheetByName('Master Employee');
    var employees = [];
    if (empSheet) {
      var empVals = empSheet.getDataRange().getValues();
      for (var i = 1; i < empVals.length; i++) {
        var row = empVals[i];
        if (!row[0]) continue; // skip blank rows
        employees.push({
          // Normalized keys — matches what seedRequesters / seedApprovers expect
          full_name:        (row[0] || '').toString().trim(),   // e.full_name || e['Họ và tên']
          'Họ và tên':      (row[0] || '').toString().trim(),
          employee_status:  (row[6] || 'Active').toString().trim(), // e.employee_status || e['Status']
          'Status':         (row[6] || 'Active').toString().trim(),
          department_name:  (row[2] || '').toString().trim(),   // e.department_name || e['Bộ phận']
          'Bộ phận':        (row[2] || '').toString().trim(),
          employee_email:   (row[4] || '').toString().trim(),   // e.employee_email || e['Email']
          'Email':          (row[4] || '').toString().trim(),
          company:          (row[3] || '').toString().trim(),
          position:         (row[1] || '').toString().trim(),
          phone:            (row[5] || '').toString().trim(),
          employeeId:       (row[7] || '').toString().trim(),
          role:             (row[8] || '').toString().trim(),
        });
      }
      Logger.log('[P2P] Master Employee records: ' + employees.length);
    } else {
      Logger.log('[P2P] ⚠️ Sheet "Master Employee" not found');
    }

    // ── Goods catalog (Goods-KTT) ────────────────────────────
    var goodsSheet = ss.getSheetByName('Goods-KTT');
    var goods = [];
    if (goodsSheet) {
      var gVals    = goodsSheet.getDataRange().getValues();
      var gHeaders = gVals[0];
      goods = gVals.slice(1).map(function(row) {
        var obj = {};
        gHeaders.forEach(function(h, i) { obj[h] = row[i]; });
        return obj;
      }).filter(function(r) { return r[gHeaders[0]]; });
      Logger.log('[P2P] Goods-KTT records: ' + goods.length);
    } else {
      Logger.log('[P2P] ⚠️ Sheet "Goods-KTT" not found');
    }

    // ── Suppliers (Nhà cung cấp) ─────────────────────────────
    var supSheet = ss.getSheetByName(CONFIG.SUPPLIERS_SHEET_NAME);
    var suppliers = [];
    if (supSheet) {
      var sVals    = supSheet.getDataRange().getValues();
      var sHeaders = sVals[0];
      suppliers = sVals.slice(1).map(function(row) {
        var obj = {};
        sHeaders.forEach(function(h, i) { obj[h] = row[i]; });
        return obj;
      });
      Logger.log('[P2P] Suppliers records: ' + suppliers.length);
    } else {
      Logger.log('[P2P] ⚠️ Sheet "' + CONFIG.SUPPLIERS_SHEET_NAME + '" not found');
    }

    Logger.log('[P2P] ✅ getP2PMasterData success');
    return createResponse(true, 'P2P master data fetched successfully', {
      employees: employees,
      goods:     goods,
      suppliers: suppliers,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleGetP2PMasterData: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== SHARED AUDIT LOG ====================
/**
 * Append one event row to a "<flow>_Audit_Log" sheet.
 * Auto-creates the sheet (with headers) if it does not exist yet.
 *
 * Schema (A–K):
 *   A  Document No   – PR No / AM No / PMT No / etc.
 *   B  Flow          – "PR" | "AM" | "PMT" | ...
 *   C  Company       – company name
 *   D  Action        – "Submit" | "Approve" | "Reject" | "Return" | "Resubmit"
 *   E  Role          – who did this: "requester" | "budget" | "supplier" | "deptHead" | …
 *   F  Actor Email   – email of the person who triggered the action
 *   G  Actor Name    – display name (optional, '' if unknown)
 *   H  Prev Status   – status string before the action
 *   I  New Status    – status string after the action
 *   J  Timestamp     – ISO 8601 UTC string
 *   K  Note          – approval note / rejection reason (may be empty)
 *   L  Extra JSON    – serialised extra data (sig URL, verification, etc.)
 *
 * Every future P2P flow MUST call this function for every state-changing action.
 *
 * @param {object} opts
 * @param {string} opts.sheetName   – e.g. 'PR_Audit_Log' or 'AM_Audit_Log'
 * @param {string} opts.docNo       – document number (PR No, AM No, …)
 * @param {string} opts.flow        – short flow code: 'PR', 'AM', 'PMT', …
 * @param {string} opts.company     – company name
 * @param {string} opts.action      – 'Submit' | 'Approve' | 'Reject' | 'Return' | 'Resubmit'
 * @param {string} opts.role        – actor role label
 * @param {string} opts.actorEmail  – email of the actor
 * @param {string} [opts.actorName] – display name of actor (optional)
 * @param {string} opts.prevStatus  – status before this action
 * @param {string} opts.newStatus   – status after this action
 * @param {string} [opts.note]      – free-text note / rejection reason
 * @param {object} [opts.extra]     – any extra data to serialise into column L
 */
function _appendAuditLog_(opts) {
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(opts.sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(opts.sheetName);
      sheet.appendRow(AUDIT_HEADERS_);
      sheet.setFrozenRows(1);
      Logger.log('[Audit] Created sheet: ' + opts.sheetName);
    } else {
      applyStandardHeaders_(sheet, AUDIT_HEADERS_);
    }
    sheet.appendRow([
      opts.docNo      || '',
      opts.flow       || '',
      opts.company    || '',
      opts.action     || '',
      opts.role       || '',
      opts.actorEmail || '',
      opts.actorName  || '',
      opts.prevStatus || '',
      opts.newStatus  || '',
      new Date().toISOString(),
      opts.note       || '',
      opts.extra ? JSON.stringify(opts.extra) : ''
    ]);
  } catch (e) {
    // Audit failures must never break the main flow — log but swallow
    Logger.log('[Audit] ⚠️ _appendAuditLog_ failed for ' + opts.docNo + ': ' + e.message);
  }
}

// ==================== PURCHASE REQUEST (ĐỀ NGHỊ MUA HÀNG) ====================

/**
 * Sheet: Purchase_Request_History
 * Columns: A=PR No, B=Company, C=company_key, D=Department, E=Requester Name,
 *          F=Required Date, G=Priority, H=Purpose, I=Suggested Vendor,
 *          J=Budget Code, K=Budget Approver Email, L=Supplier Approver Email,
 *          M=Items (JSON), N=Grand Total, O=Status, P=Submitted At, Q=Metadata (JSON)
 */
var PR_SHEET_NAME = 'Purchase_Request_History';

function handlePurchaseRequest(data) {
  try {
    Logger.log('[P2P] handlePurchaseRequest called');

    // Validate required fields
    var prNo         = (data.prNo          || '').toString().trim();
    var companyName  = (data.companyName   || '').toString().trim();
    var requesterName = (data.requesterName || '').toString().trim();
    var requiredDate = (data.requiredDate  || '').toString().trim();
    var items        = (data.items         || '[]').toString();
    var grandTotal   = parseFloat(data.grandTotal) || 0;

    if (!companyName)   return createResponse(false, msg_('missingCompanyName'));
    if (!requesterName) return createResponse(false, msg_('missingRequesterName'));
    if (!requiredDate)  return createResponse(false, msg_('missingRequiredDate'));
    if (!(data.budgetApprover || '').toString().trim())
      return createResponse(false, msg_('chooseBudgetApprover'));
    if (!(data.supplierApprover || '').toString().trim())
      return createResponse(false, msg_('chooseVendorApprover'));

    // Parse items to validate JSON
    var parsedItems;
    try {
      parsedItems = JSON.parse(items);
    } catch (e) {
      return createResponse(false, msg_('invalidGoodsData') + e.message);
    }
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return createResponse(false, msg_('atLeastOneItem'));
    }

    var purchaseType = (data.purchaseType || 'goods').toString().trim().toLowerCase();
    if (purchaseType !== 'goods' && purchaseType !== 'services') purchaseType = 'goods';
    var p2pBranch = computeP2PBranch_(purchaseType, grandTotal);
    if (p2pBranch === 'full' && !(data.contractApprover || '').toString().trim()) {
      return createResponse(false,
        'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
    }

    // Generate PR No if not provided (safety fallback — frontend usually provides it)
    if (!prNo) {
      var now = new Date();
      var dateStr = Utilities.formatDate(now, 'Asia/Ho_Chi_Minh', 'yyyyMMdd');
      prNo = 'PR-' + dateStr + '-' + Math.floor(Math.random() * 100000).toString().padStart(6, '0');
    }

    var submittedAt = data.submittedAt || new Date().toISOString();

    // Upload base64 attachments to Drive via DriveApp (never /api/drive-upload — no SA quota)
    // Folder ID sourced from Script Property 'PURCHASE_REQUEST_FOLDER_ID' — same pattern as
    // uploadFilesToDrive_ in TLCG_CASH_BACKEND.gs uses 'DRIVE_VOUCHER_FOLDER_ID'.
    var attachmentRecords = [];
    try {
      // data.attachments may be an array (when sent inside the data JSON wrapper) or a
      // JSON string (legacy flat-param path). Handle both.
      var rawAttachments = Array.isArray(data.attachments)
        ? data.attachments
        : (typeof data.attachments === 'string' ? JSON.parse(data.attachments || '[]') : []);
      rawAttachments = rawAttachments || [];
      if (rawAttachments.length > 0) {
        var PR_DRIVE_FOLDER_ID = getCfg_('PURCHASE_REQUEST_FOLDER_ID', '1SJ-pUa6jg2rmJTzle-TvvSNrKMUduvx3');
        var parentFolder;
        try {
          parentFolder = DriveApp.getFolderById(PR_DRIVE_FOLDER_ID);
        } catch (folderErr) {
          Logger.log('[P2P] ❌ Cannot access PR Drive folder ' + PR_DRIVE_FOLDER_ID + ': ' + folderErr.message);
          attachmentRecords = rawAttachments.map(function(f) {
            return { fileName: f.fileName, fileUrl: '', error: folderErr.message };
          });
          throw folderErr; // skip per-file loop; caught by outer try/catch
        }
        var subFolder = parentFolder.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME).hasNext()
          ? parentFolder.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME).next()
          : parentFolder.createFolder(CONFIG.DRIVE_FOLDER_NAME);
        var prFolder = subFolder.getFoldersByName(prNo).hasNext()
          ? subFolder.getFoldersByName(prNo).next()
          : subFolder.createFolder(prNo);
        Logger.log('[P2P] 📁 PR Drive folder ready: ' + prFolder.getId());
        rawAttachments.forEach(function(f) {
          try {
            if (!f.fileData) return;
            var b64 = f.fileData.includes(',') ? f.fileData.split(',')[1] : f.fileData;
            var mime = f.mimeType || 'application/octet-stream';
            var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, f.fileName || 'attachment');
            var driveFile = prFolder.createFile(blob);
            try { driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(shareErr) {
              Logger.log('[P2P] ⚠️ setSharing failed for ' + (f.fileName || '?') + ': ' + shareErr.message);
            }
            attachmentRecords.push({ fileName: f.fileName, fileUrl: driveFile.getUrl() });
            Logger.log('[P2P] ✅ Uploaded attachment: ' + f.fileName);
          } catch (fe) {
            Logger.log('[P2P] ⚠️ Could not upload ' + (f.fileName || '?') + ': ' + fe.message);
            attachmentRecords.push({ fileName: f.fileName, fileUrl: '', error: fe.message });
          }
        });
      }
    } catch (ae) {
      Logger.log('[P2P] ⚠️ Attachment parse/upload error: ' + ae.message);
    }

    var metadata = {
      companyCode:           data.companyCode          || '',
      companyKey:            data.companyKey            || '',
      requesterEmail:        data.requesterEmail        || '',
      budgetApproverNote:    data.budgetApproverNote    || '',
      supplierApproverNote:  data.supplierApproverNote  || '',
      submittedAt:           submittedAt,
      requesterSignature:    data.requesterSignature    || '',
      attachments:           attachmentRecords,
      // Per-role approval statuses — only set for assigned roles
      purchaseType:    purchaseType,
      p2pBranch:     p2pBranch,
      budgetStatus:    (data.budgetApprover    || '').trim() ? 'Pending' : 'N/A',
      supplierStatus:  (data.supplierApprover  || '').trim() ? 'Pending' : 'N/A',
      // Full branch: contract review happens in Contract module, not PR chain.
      // Simplified branch (goods, < 2.000.000₫): never requires contract review.
      contractStatus:  'N/A',
      purchasingStatus: (data.purchasingApprover || '').trim() ? 'Pending' : 'N/A',
      vendorDetails: {
        vendorType:         data.vendorType          || '',
        vendorTaxId:        data.vendorTaxId         || '',
        vendorAddress:      data.vendorAddress       || '',
        vendorAccountName:  data.vendorAccountName   || '',
        vendorAccountNo:    data.vendorAccountNo     || '',
        vendorBankName:     data.vendorBankName      || '',
        vendorTransferNote: data.vendorTransferNote  || ''
      }
    };

    // Build comma-separated Drive URLs from successfully uploaded attachments
    var attachmentUrlsStr = attachmentRecords
      .filter(function(r) { return r.fileUrl; })
      .map(function(r) { return r.fileUrl; })
      .join(', ');

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(PR_SHEET_NAME);
      sheet.appendRow(PR_HEADERS_.concat(P2P_HISTORY_HEADERS_));
      Logger.log('[P2P] Created sheet: ' + PR_SHEET_NAME);
    } else {
      standardizeWorkflowSheet_(sheet, PR_HEADERS_);
    }

    sheet.appendRow([
      prNo,
      companyName,
      data.companyKey        || '',
      data.department        || '',
      requesterName,
      requiredDate,
      (function(p) {
        var m = { gap: 'Gấp', binh_thuong: 'Bình Thường', khong_gap: 'Không Gấp',
                  high: 'Gấp', medium: 'Bình Thường', low: 'Không Gấp' };
        return m[p] || p || 'Bình Thường';
      })(data.priority),
      data.purpose           || '',
      data.vendorName        || data.suggestedVendor || '',
      data.budgetCode        || '',
      data.budgetApprover    || '',
      data.supplierApprover  || '',
      items,
      grandTotal,
      'Đang duyệt ngân sách & NCC (2/5)',
      submittedAt,
      JSON.stringify(metadata),
      p2pBranch === 'full' ? (data.contractApprover || '') : '',  // index 17 / col R — simplified branch never has a contract step
      data.purchasingApprover || '',  // index 18 / col S
      attachmentUrlsStr,             // index 19 / col T
      'submit'                       // index 20 / col U — Row_Type: marks this as the canonical data row
    ]);

    Logger.log('[P2P] ✅ Purchase request saved: ' + prNo);
    SpreadsheetApp.flush();

    _appendAuditLog_({
      sheetName:  'PR_Audit_Log',
      docNo:      prNo,
      flow:       'PR',
      company:    companyName,
      action:     'Submit',
      role:       'requester',
      actorEmail: data.requesterEmail || '',
      actorName:  requesterName,
      prevStatus: '',
      newStatus:  'Đang duyệt ngân sách & NCC (2/5)',
      note:       data.purpose || '',
      extra:      { purchaseType: purchaseType, p2pBranch: p2pBranch }
    });
    appendP2PHistoryRow_(sheet, 20, prNo, {
      action:     'Submit',
      role:       'requester',
      actorEmail: data.requesterEmail || '',
      actorName:  requesterName,
      prevStatus: '',
      newStatus:  'Đang duyệt ngân sách & NCC (2/5)',
      note:       data.purpose || ''
    });

    // Send email notifications (non-blocking — failures must not break submission)
    try {
      sendPurchaseRequestEmails_(data, prNo, attachmentRecords);
    } catch (emailErr) {
      Logger.log('[P2P] ⚠️ Email notification error (non-fatal): ' + emailErr.message);
    }

    return createResponse(true, 'Đề nghị mua hàng đã được gửi thành công.', { prNo: prNo });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handlePurchaseRequest: ' + error.toString());
    Logger.log('[P2P] Stack: ' + error.stack);
    return createResponse(false, msg_('errSaveContract') + error.message);
  }
}

function sendPurchaseRequestEmails_(data, prNo, attachmentRecords) {
  attachmentRecords = attachmentRecords || [];
  var subject = '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu phê duyệt - ' + prNo;
  var grandTotalFmt = (parseFloat(data.grandTotal) || 0).toLocaleString('vi-VN') + ' ₫';
  var requiredDate  = data.requiredDate || '—';
  var companyName   = data.companyName  || '—';
  var requesterName = data.requesterName || '—';
  var purpose       = data.purpose      || '—';

  // Build attachment links HTML
  var attachHtml = '';
  if (attachmentRecords && attachmentRecords.length > 0) {
    var links = attachmentRecords.filter(function(r){ return r.fileUrl; }).map(function(r){
      return '<li><a href="' + r.fileUrl + '">' + r.fileName + '</a></li>';
    }).join('');
    if (links) attachHtml = '<br><b>Tệp đính kèm:</b><ul>' + links + '</ul>';
  }

  // --- Approver email: Budget + Supplier only on submit (Contract/Purchasing notified when their stage opens) ---
  var approverBody = '<p>Kính gửi,</p>'
    + '<p>Có một <b>Đề nghị mua hàng</b> mới đang chờ phê duyệt của bạn.</p>'
    + '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>' + prNo + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Người đề nghị:</td><td>' + requesterName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>' + purpose + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>' + grandTotalFmt + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Ngày cần hàng:</td><td>' + requiredDate + '</td></tr>'
    + '</table>'
    + '<p style="margin-top:16px;">Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>'
    + attachHtml
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';

  [data.budgetApprover, data.supplierApprover].forEach(function(email) {
    if (!email) return;
    try {
      GmailApp.sendEmail(email, subject, '', { htmlBody: approverBody, name: 'TLC Group Workflow' });
      Logger.log('[P2P] ✅ Approver email sent to: ' + email);
    } catch (e) {
      Logger.log('[P2P] ⚠️ Failed to send approver email to ' + email + ': ' + e.message);
    }
  });

  // --- Requester confirmation email ---
  var requesterEmail = data.requesterEmail || '';
  if (requesterEmail) {
    var requesterBody = '<p>Kính gửi ' + requesterName + ',</p>'
      + '<p>Đề nghị mua hàng của bạn đã được gửi thành công và đang chờ phê duyệt.</p>'
      + '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
      + '<tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>' + prNo + '</td></tr>'
      + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
      + '<tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>' + purpose + '</td></tr>'
      + '<tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>' + grandTotalFmt + '</td></tr>'
      + '<tr><td style="font-weight:700;padding-right:16px;">Ngày cần hàng:</td><td>' + requiredDate + '</td></tr>'
      + '</table>'
      + '<p style="margin-top:16px;">Người phê duyệt đã được thông báo qua email. Bạn sẽ nhận được thông báo khi phiếu được xử lý.</p>'
      + attachHtml
      + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
    try {
      GmailApp.sendEmail(requesterEmail, '[ĐỀ NGHỊ MUA HÀNG] Xác nhận gửi phiếu - ' + prNo, '', {
        htmlBody: requesterBody, name: 'TLC Group Workflow'
      });
      Logger.log('[P2P] ✅ Requester confirmation email sent to: ' + requesterEmail);
    } catch (e) {
      Logger.log('[P2P] ⚠️ Failed to send requester email to ' + requesterEmail + ': ' + e.message);
    }
  }
}

/**
 * Sends a stage-activation email to a single approver when their stage becomes active.
 * row: the sheet row array (0-based indices)
 * stage: 'contract' | 'purchasing'
 */
function sendPurchaseRequestStageEmail_(row, prNo, stage) {
  var stageEmailMap = { contract: 17, purchasing: 18 };
  var stageLabelMap = { contract: 'Thẩm định Hợp đồng', purchasing: 'Mua hàng' };
  var recipientEmail = (row[stageEmailMap[stage]] || '').toString().trim();
  if (!recipientEmail) return;

  var companyName   = (row[1]  || '').toString();
  var requesterName = (row[4]  || '').toString();
  var purpose       = (row[7]  || '').toString();
  var grandTotal    = parseFloat(row[13]) || 0;
  var requiredDate  = (row[5]  || '').toString();
  var grandTotalFmt = grandTotal.toLocaleString('vi-VN') + ' ₫';

  var subject = '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu ' + stageLabelMap[stage] + ' - ' + prNo;
  var body = '<p>Kính gửi,</p>'
    + '<p>Giai đoạn <b>' + stageLabelMap[stage] + '</b> của Đề nghị mua hàng đã mở và đang chờ xử lý của bạn.</p>'
    + '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>' + prNo + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Người đề nghị:</td><td>' + requesterName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>' + purpose + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>' + grandTotalFmt + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Ngày cần hàng:</td><td>' + requiredDate + '</td></tr>'
    + '</table>'
    + '<p style="margin-top:16px;">Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>'
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';

  GmailApp.sendEmail(recipientEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
  Logger.log('[P2P] ✅ Stage email (' + stage + ') sent to: ' + recipientEmail);
}

/**
 * Notifies the requester when a PR reaches Hoàn thành.
 * row: sheet row, prNo: PR number, metadata: parsed metadata object.
 */
function sendPurchaseRequestCompletionEmail_(row, prNo, metadata) {
  var requesterEmail = (metadata.requesterEmail || '').toString().trim();
  // Fall back to metadata if present; requesterEmail was not saved in the row directly
  if (!requesterEmail) return;

  var requesterName = (row[4]  || '').toString();
  var companyName   = (row[1]  || '').toString();
  var subject = '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã hoàn thành - ' + prNo;
  var body = '<p>Kính gửi ' + requesterName + ',</p>'
    + '<p>Đề nghị mua hàng <b>' + prNo + '</b> của bạn đã được <b>phê duyệt hoàn tất</b>.</p>'
    + '<p>Công ty: ' + companyName + '</p>'
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';

  GmailApp.sendEmail(requesterEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
  Logger.log('[P2P] ✅ Completion email sent to: ' + requesterEmail);
}

function handleGetPurchaseRequestHistory(data) {
  try {
    Logger.log('[P2P] handleGetPurchaseRequestHistory called');

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (sheet) standardizeWorkflowSheet_(sheet, PR_HEADERS_);
    if (!sheet || sheet.getLastRow() <= 1) {
      return createResponse(true, 'Thành công', { requests: [] });
    }

    var values  = sheet.getDataRange().getValues();
    var headers = values[0];
    var rows    = values.slice(1);

    // Optional filter: requester name
    var filterRequester = (data.requesterName || '').toString().trim().toLowerCase();

    var requests = rows
      .filter(function(row) {
        if (!row[0]) return false; // skip empty PR No
        // Skip event/history rows — only show submit rows in the list view
        var rowType = (row[20] || '').toString();
        if (rowType === 'event') return false;
        if (filterRequester && (row[4] || '').toString().toLowerCase() !== filterRequester) return false;
        return true;
      })
      .map(function(row) {
        var meta = {};
        try { meta = JSON.parse(row[16] || '{}'); } catch (_) {}
        var p2pBranch = meta.p2pBranch || 'full';
        return {
          prNo:               row[0]  || '',
          company:            row[1]  || '',
          department:         row[3]  || '',
          requesterName:      row[4]  || '',
          requiredDate:       row[5]  || '',
          priority:           row[6]  || '',
          purpose:            row[7]  || '',
          suggestedVendor:    row[8]  || '',
          budgetCode:         row[9]  || '',
          budgetApprover:     row[10] || '',
          supplierApprover:   row[11] || '',
          items:              row[12] || '[]',
          grandTotal:         row[13] || 0,
          status:             row[14] || '',
          submittedAt:        row[15] || '',
          metadata:           row[16] || '{}',
          contractApprover:   row[17] || '',
          purchasingApprover: row[18] || '',
          attachmentUrls:     row[19] || '',
          purchaseType:       meta.purchaseType || 'goods',
          p2pBranch:          p2pBranch
        };
      })
      .reverse(); // newest first

    Logger.log('[P2P] ✅ Returning ' + requests.length + ' purchase requests');
    return createResponse(true, 'Thành công', { requests: requests });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleGetPurchaseRequestHistory: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== APPROVAL STATE HELPER ====================

/**
 * Derives the active stage and computed sheet status string from the row data.
 *
 * Stages (in order):
 *   1. parallel  — Budget and/or Supplier acting simultaneously.
 *                  Exits when ALL assigned parallel roles are Approved.
 *   2. contract  — Only when a contract approver is assigned and parallel is done.
 *   3. purchasing — Only when a purchasing approver is assigned and contract is done/skipped.
 *   4. complete  — All required steps done.
 *
 * Returns: { stage, statusLabel, budgetEmail, supplierEmail, contractEmail, purchasingEmail }
 */
function computePRApprovalState_(row, metadata) {
  var budgetEmail    = (row[10] || '').toString().toLowerCase().trim();
  var supplierEmail  = (row[11] || '').toString().toLowerCase().trim();
  var contractEmail  = (row[17] || '').toString().toLowerCase().trim();
  var purchasingEmail = (row[18] || '').toString().toLowerCase().trim();

  var budgetDone    = !budgetEmail    || metadata.budgetStatus    === 'Approved';
  var supplierDone  = !supplierEmail  || metadata.supplierStatus  === 'Approved';
  var p2pBranch     = metadata.p2pBranch || 'full';
  // Full branch: contract approval is handled in the separate Contract module,
  // so the PR's own contract stage is skipped there too. Simplified branch
  // (goods, < 2.000.000₫) never requires contract review — ignore any stray
  // contractApprover value (e.g. left over from a branch change) so it can't
  // wrongly activate a contract stage for a PR that doesn't need one.
  var skipPRContract = p2pBranch === 'full' || p2pBranch === 'simplified';
  var contractDone  = skipPRContract || !contractEmail || metadata.contractStatus === 'Approved';
  var purchasingDone = !purchasingEmail || metadata.purchasingStatus === 'Approved';

  // Parallel stage: either budget or supplier is assigned but not yet approved
  var parallelComplete = budgetDone && supplierDone;

  var stage;
  var statusLabel;

  if (!parallelComplete) {
    stage = 'parallel';
    statusLabel = 'Đang duyệt ngân sách & NCC (2/5)';
  } else if (!skipPRContract && contractEmail && !contractDone) {
    stage = 'contract';
    statusLabel = 'Thẩm định Hợp đồng (4/5)';
  } else if (purchasingEmail && !purchasingDone) {
    stage = 'purchasing';
    statusLabel = 'Mua hàng (5/5)';
  } else {
    stage = 'complete';
    statusLabel = 'Hoàn thành';
  }

  return {
    stage:          stage,
    statusLabel:    statusLabel,
    budgetEmail:    budgetEmail,
    supplierEmail:  supplierEmail,
    contractEmail:  contractEmail,
    purchasingEmail: purchasingEmail,
    parallelComplete: parallelComplete,
    contractDone:   contractDone
  };
}

/**
 * One-off sweep: recomputes column O (status) for every non-terminal row in
 * Purchase_Request_History via computePRApprovalState_, fixing rows still
 * showing a stale/legacy status label (e.g. "Đang duyệt nhà cung cấp (3/5)")
 * left over from before the budget+supplier parallel-stage refactor.
 * Skips terminal statuses (Đã từ chối / Rejected / Trả lại bổ sung) since
 * those are not derived from computePRApprovalState_ and must not be touched.
 * Run manually from the Apps Script editor.
 */
function patchRecomputeAllPRStatuses_() {
  var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PR_SHEET_NAME);
  if (!sheet) { Logger.log('❌ Sheet not found: ' + PR_SHEET_NAME); return; }

  var values = sheet.getDataRange().getValues();
  var terminalStatuses = ['Đã từ chối', 'Rejected', 'Trả lại bổ sung'];
  var fixedCount = 0;
  var skippedCount = 0;

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var prNo = (row[0] || '').toString().trim();
    if (!prNo) continue;

    var currentStatus = (row[14] || '').toString().trim();
    if (terminalStatuses.indexOf(currentStatus) !== -1) { skippedCount++; continue; }

    var metadata;
    try { metadata = JSON.parse(row[16] || '{}'); } catch (e) { metadata = {}; }

    // Simplified branch never has a contract stage — clear any stray contract
    // approver email (col R) left over from before computePRApprovalState_
    // correctly ignored it for this branch, so the drawer stops showing a
    // bogus "Thẩm định HĐ" step.
    var p2pBranch = metadata.p2pBranch || 'full';
    if (p2pBranch === 'simplified' && (row[17] || '').toString().trim()) {
      sheet.getRange(i + 1, 18).setValue('');
      row[17] = '';
      Logger.log('✅ ' + prNo + ': cleared stray contract approver (simplified branch)');
    }
    if (p2pBranch === 'simplified' && metadata.contractStatus !== 'N/A') {
      metadata.contractStatus = 'N/A';
      sheet.getRange(i + 1, 17).setValue(JSON.stringify(metadata));
    }

    var state = computePRApprovalState_(row, metadata);
    if (state.statusLabel !== currentStatus) {
      sheet.getRange(i + 1, 15).setValue(state.statusLabel);
      Logger.log('✅ ' + prNo + ': "' + currentStatus + '" → "' + state.statusLabel + '"');
      fixedCount++;
    }
  }

  SpreadsheetApp.flush();
  Logger.log('Done. Fixed ' + fixedCount + ' row(s), skipped ' + skippedCount + ' terminal row(s).');
}

/** Temporary public wrapper so the Apps Script Run dropdown can find the patch — same effect as calling patchRecomputeAllPRStatuses_() directly. */
function runPRStatusPatch() {
  patchRecomputeAllPRStatuses_();
}

// ==================== APPROVE PURCHASE REQUEST ====================

function handleApprovePurchaseRequest(data) {
  try {
    var prNo          = (data.prNo          || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    var approverRole  = (data.approverRole  || '').toString().trim(); // 'budget' | 'supplier' | 'contract' | 'purchasing'
    var note          = (data.note          || '').toString().trim();

    if (!prNo)          return createResponse(false, msg_('missingPurchaseDocNo'));
    if (!approverEmail) return createResponse(false, msg_('missingApproverEmail2'));

    var validRoles = ['budget', 'supplier', 'contract', 'purchasing'];
    if (validRoles.indexOf(approverRole) === -1) {
      return createResponse(false, msg_('invalidRoleList'));
    }

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (!sheet) return createResponse(false, msg_('sheetPrHistoryNotFound'));

    var values   = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if ((values[i][0] || '').toString().trim() === prNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('prNotFoundPrefix') + prNo);

    var row           = values[rowIndex];
    var currentStatus = (row[14] || '').toString();

    if (currentStatus === 'Đã từ chối' || currentStatus === 'Rejected') {
      return createResponse(false, msg_('requestRejectedCannotApprove'));
    }
    if (currentStatus === 'Hoàn thành' || currentStatus === 'Approved') {
      return createResponse(false, msg_('requestAlreadyApproved'));
    }
    if (currentStatus === 'Trả lại bổ sung') {
      return createResponse(false, msg_('docPendingInfoCannotApprove'));
    }

    // Verify email matches the assigned column for this role
    var approverColMap = { budget: 10, supplier: 11, contract: 17, purchasing: 18 };
    var assignedEmail = (row[approverColMap[approverRole]] || '').toString().toLowerCase().trim();
    if (!assignedEmail) {
      return createResponse(false, msg_('roleNotAssignedForRequest', approverRole));
    }
    if (approverEmail !== assignedEmail) {
      return createResponse(false, msg_('notAssignedApprover', approverRole));
    }

    var metadata;
    try { metadata = JSON.parse(row[16] || '{}'); } catch (e) { metadata = {}; }

    // Gate check: verify role is in the currently active stage
    var stateBeforeApprove = computePRApprovalState_(row, metadata);
    var activeStage = stateBeforeApprove.stage;

    var roleStage = (approverRole === 'budget' || approverRole === 'supplier')
      ? 'parallel'
      : approverRole; // 'contract' | 'purchasing'

    if (roleStage !== activeStage) {
      var stageNames = { parallel: 'duyệt ngân sách & NCC', contract: 'thẩm định hợp đồng', purchasing: 'mua hàng' };
      return createResponse(false,
        'Chưa đến lượt duyệt của bạn. Giai đoạn hiện tại: ' + (stageNames[activeStage] || activeStage) + '.'
      );
    }

    // Check role is not already approved
    if (metadata[approverRole + 'Status'] === 'Approved') {
      return createResponse(false, msg_('alreadyApprovedByYou'));
    }

    var now = new Date().toISOString();
    metadata[approverRole + 'Status']     = 'Approved';
    metadata[approverRole + 'ApprovedAt'] = now;
    metadata[approverRole + 'Note']       = note;

    // Store approver signature and verification result if provided
    if (data.approverSignature) {
      metadata[approverRole + 'Signature'] = data.approverSignature;
    }
    if (data.signatureVerification) {
      try {
        metadata[approverRole + 'SignatureVerification'] = JSON.parse(data.signatureVerification);
      } catch(e) {
        metadata[approverRole + 'SignatureVerification'] = { raw: data.signatureVerification };
      }
    }

    // Compute new state after this approval
    var stateAfter = computePRApprovalState_(row, metadata);
    var newStatus  = stateAfter.statusLabel;

    sheet.getRange(rowIndex + 1, 15).setValue(newStatus);
    sheet.getRange(rowIndex + 1, 17).setValue(JSON.stringify(metadata));
    SpreadsheetApp.flush();

    Logger.log('[P2P] ✅ PR approved: ' + prNo + ' role=' + approverRole + ' newStatus=' + newStatus);

    _appendAuditLog_({
      sheetName:  'PR_Audit_Log',
      docNo:      prNo,
      flow:       'PR',
      company:    (row[1] || '').toString(),
      action:     'Approve',
      role:       approverRole,
      actorEmail: approverEmail,
      actorName:  '',
      prevStatus: currentStatus,
      newStatus:  newStatus,
      note:       note,
      extra:      data.approverSignature
        ? { signatureUploaded: true, verification: data.signatureVerification || null }
        : null
    });
    appendP2PHistoryRow_(sheet, 20, prNo, {
      action:     'Approve',
      role:       approverRole,
      actorEmail: approverEmail,
      actorName:  (metadata[approverRole + 'Name'] || ''),
      prevStatus: currentStatus,
      newStatus:  newStatus,
      note:       note
    });

    // Stage transition emails: notify the next stage approver when their stage opens
    if (stateAfter.stage === 'contract' && stateBeforeApprove.stage === 'parallel') {
      // Legacy PR contract stage (simplified branch only)
      try {
        sendPurchaseRequestStageEmail_(row, prNo, 'contract');
      } catch (e) {
        Logger.log('[P2P] ⚠️ Stage email (contract) failed: ' + e.message);
      }
    } else if (stateAfter.stage === 'purchasing' &&
      (stateBeforeApprove.stage === 'contract' ||
       (stateBeforeApprove.stage === 'parallel' && (metadata.p2pBranch || 'full') === 'full'))) {
      // Purchasing opens after contract stage OR directly after parallel for full branch
      try {
        sendPurchaseRequestStageEmail_(row, prNo, 'purchasing');
      } catch (e) {
        Logger.log('[P2P] ⚠️ Stage email (purchasing) failed: ' + e.message);
      }
    } else if (stateAfter.stage === 'complete') {
      // All done → notify requester
      try {
        sendPurchaseRequestCompletionEmail_(row, prNo, metadata);
      } catch (e) {
        Logger.log('[P2P] ⚠️ Completion email failed: ' + e.message);
      }
    }

    return createResponse(true, 'Đã duyệt thành công.', { prNo: prNo, status: newStatus });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleApprovePurchaseRequest: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== REJECT PURCHASE REQUEST ====================

function handleRejectPurchaseRequest(data) {
  try {
    var prNo          = (data.prNo          || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    var note          = (data.note          || '').toString().trim();

    if (!prNo)          return createResponse(false, msg_('missingPurchaseDocNo'));
    if (!approverEmail) return createResponse(false, msg_('missingRejecterEmail'));

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (!sheet) return createResponse(false, msg_('sheetPrHistoryNotFound'));

    var values   = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if ((values[i][0] || '').toString().trim() === prNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('prNotFoundPrefix') + prNo);

    var row           = values[rowIndex];
    var currentStatus = (row[14] || '').toString();

    var metadata0;
    try { metadata0 = JSON.parse(row[16] || '{}'); } catch (e) { metadata0 = {}; }

    // Only approvers whose role is currently active may reject
    var stateNow = computePRApprovalState_(row, metadata0);
    var activeStage = stateNow.stage;

    // Map email → role for the four possible approvers
    var emailRoleMap = {};
    if (stateNow.budgetEmail)    emailRoleMap[stateNow.budgetEmail]    = 'budget';
    if (stateNow.supplierEmail)  emailRoleMap[stateNow.supplierEmail]  = 'supplier';
    if (stateNow.contractEmail)  emailRoleMap[stateNow.contractEmail]  = 'contract';
    if (stateNow.purchasingEmail) emailRoleMap[stateNow.purchasingEmail] = 'purchasing';

    if (!emailRoleMap[approverEmail]) {
      return createResponse(false, msg_('noRejectPermission'));
    }

    var rejectRole = emailRoleMap[approverEmail];
    var rejectRoleStage = (rejectRole === 'budget' || rejectRole === 'supplier') ? 'parallel' : rejectRole;
    if (rejectRoleStage !== activeStage) {
      return createResponse(false, msg_('notYourTurn'));
    }
    if (currentStatus === 'Đã từ chối' || currentStatus === 'Rejected') {
      return createResponse(false, msg_('requestAlreadyRejected2'));
    }
    if (currentStatus === 'Hoàn thành' || currentStatus === 'Approved') {
      return createResponse(false, msg_('requestApprovedCannotReject'));
    }
    if (currentStatus === 'Trả lại bổ sung') {
      return createResponse(false, msg_('docPendingInfoCannotReject'));
    }

    metadata0.rejectedAt    = new Date().toISOString();
    metadata0.rejectedBy    = approverEmail;
    metadata0.rejectionNote = note;

    sheet.getRange(rowIndex + 1, 15).setValue('Đã từ chối');
    sheet.getRange(rowIndex + 1, 17).setValue(JSON.stringify(metadata0));
    SpreadsheetApp.flush();

    Logger.log('[P2P] ✅ PR rejected: ' + prNo + ' by=' + approverEmail);

    _appendAuditLog_({
      sheetName:  'PR_Audit_Log',
      docNo:      prNo,
      flow:       'PR',
      company:    (row[1] || '').toString(),
      action:     'Reject',
      role:       rejectRole,
      actorEmail: approverEmail,
      prevStatus: currentStatus,
      newStatus:  'Đã từ chối',
      note:       note
    });
    appendP2PHistoryRow_(sheet, 20, prNo, {
      action:     'Reject',
      role:       rejectRole,
      actorEmail: approverEmail,
      prevStatus: currentStatus,
      newStatus:  'Đã từ chối',
      note:       note
    });

    return createResponse(true, 'Đã từ chối thành công.', { prNo: prNo, status: 'Đã từ chối' });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleRejectPurchaseRequest: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== SEND BACK PURCHASE REQUEST ====================

/**
 * Sends a PR back to an earlier step.
 * targetStep=1 → back to submitter (status: Trả lại bổ sung)
 * targetStep=2 → back to Budget+Supplier stage (cascade reset)
 * targetStep=3 → back to Contract stage (cascade reset)
 */
function handleSendBackPurchaseRequest(data) {
  try {
    var prNo          = (data.prNo          || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    var approverRole  = (data.approverRole  || '').toString().trim();
    var targetStep    = parseInt(data.targetStep, 10);
    var note          = (data.sentBackNote  || '').toString().trim();

    if (!prNo)          return createResponse(false, msg_('missingPurchaseDocNo'));
    if (!approverEmail) return createResponse(false, msg_('missingActorEmail'));
    if (!note)          return createResponse(false, msg_('enterSendBackReason'));
    if (isNaN(targetStep) || targetStep < 1 || targetStep > 3) {
      return createResponse(false, msg_('sendBackStepInvalid'));
    }

    var validRoles = ['budget', 'supplier', 'contract', 'purchasing'];
    if (validRoles.indexOf(approverRole) === -1) {
      return createResponse(false, msg_('invalidRole'));
    }

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (!sheet) return createResponse(false, msg_('sheetPrHistoryNotFound'));

    var values   = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if ((values[i][0] || '').toString().trim() === prNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('prNotFoundPrefix') + prNo);

    var row           = values[rowIndex];
    var currentStatus = (row[14] || '').toString();

    // Block on terminal/already-returned statuses
    if (currentStatus === 'Đã từ chối' || currentStatus === 'Rejected') {
      return createResponse(false, msg_('requestAlreadyRejected'));
    }
    if (currentStatus === 'Hoàn thành' || currentStatus === 'Approved') {
      return createResponse(false, msg_('requestCompleted'));
    }
    if (currentStatus === 'Trả lại bổ sung') {
      return createResponse(false, msg_('requestAlreadyReturned'));
    }

    var metadata;
    try { metadata = JSON.parse(row[16] || '{}'); } catch (e) { metadata = {}; }

    // Active-stage gate: same check as approve/reject
    var stateNow    = computePRApprovalState_(row, metadata);
    var activeStage = stateNow.stage;
    var roleStage   = (approverRole === 'budget' || approverRole === 'supplier') ? 'parallel' : approverRole;
    if (roleStage !== activeStage) {
      return createResponse(false, msg_('notYourTurn'));
    }

    // Validate sender email matches the assigned column for their role
    var approverColMap = { budget: 10, supplier: 11, contract: 17, purchasing: 18 };
    var assignedEmail  = (row[approverColMap[approverRole]] || '').toString().toLowerCase().trim();
    if (!assignedEmail || approverEmail !== assignedEmail) {
      return createResponse(false, msg_('notAssignedRole', approverRole));
    }

    // Validate targetStep is reachable from this role
    // budget/supplier → only step 1; contract → 1 or 2; purchasing → 1, 2, or 3
    var maxTarget = { budget: 1, supplier: 1, contract: 2, purchasing: 3 };
    if (targetStep > maxTarget[approverRole]) {
      return createResponse(false, msg_('sendBackStepInvalidRole'));
    }

    var newStatus;
    var rolesToReset = [];

    if (targetStep === 1) {
      newStatus = 'Trả lại bổ sung';
      // Role statuses NOT reset here — preserved for display; reset happens on resubmit
    } else if (targetStep === 2) {
      newStatus    = 'Đang duyệt ngân sách & NCC (2/5)';
      rolesToReset = ['budget', 'supplier', 'contract', 'purchasing'];
    } else if (targetStep === 3) {
      newStatus    = 'Thẩm định Hợp đồng (4/5)';
      rolesToReset = ['contract', 'purchasing'];
    }

    rolesToReset.forEach(function(role) {
      if (metadata[role + 'Status'] && metadata[role + 'Status'] !== 'N/A') {
        metadata[role + 'Status'] = 'Pending';
        delete metadata[role + 'ApprovedAt'];
        delete metadata[role + 'Note'];
      }
    });

    // Append to sentBackHistory (audit log)
    if (!Array.isArray(metadata.sentBackHistory)) metadata.sentBackHistory = [];
    metadata.sentBackHistory.push({
      targetStep: targetStep,
      by:         approverEmail,
      byRole:     approverRole,
      at:         new Date().toISOString(),
      note:       note
    });

    sheet.getRange(rowIndex + 1, 15).setValue(newStatus);
    sheet.getRange(rowIndex + 1, 17).setValue(JSON.stringify(metadata));
    SpreadsheetApp.flush();

    Logger.log('[P2P] ✅ PR sent back: ' + prNo + ' targetStep=' + targetStep + ' by=' + approverEmail);

    _appendAuditLog_({
      sheetName:  'PR_Audit_Log',
      docNo:      prNo,
      flow:       'PR',
      company:    (row[1] || '').toString(),
      action:     'Return',
      role:       approverRole,
      actorEmail: approverEmail,
      prevStatus: currentStatus,
      newStatus:  newStatus,
      note:       note,
      extra:      { targetStep: targetStep }
    });
    appendP2PHistoryRow_(sheet, 20, prNo, {
      action:     'Return',
      role:       approverRole,
      actorEmail: approverEmail,
      prevStatus: currentStatus,
      newStatus:  newStatus,
      note:       'Bước ' + targetStep + ' — ' + note
    });

    try {
      sendPurchaseRequestSendBackEmail_(row, prNo, targetStep, note, approverRole, metadata);
    } catch (emailErr) {
      Logger.log('[P2P] ⚠️ Send-back email failed (non-fatal): ' + emailErr.message);
    }

    return createResponse(true, 'Đã trả lại thành công.', { prNo: prNo, status: newStatus });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleSendBackPurchaseRequest: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== RESUBMIT PURCHASE REQUEST ====================

/**
 * Called when the submitter re-edits and resubmits a PR that was sent back (targetStep=1).
 * Overwrites the existing row in place and resets the full approval chain.
 */
function handleResubmitPurchaseRequest(data) {
  try {
    var prNo          = (data.prNo          || '').toString().trim();
    var requesterEmail = (data.requesterEmail || '').toString().trim().toLowerCase();

    if (!prNo)           return createResponse(false, msg_('missingPurchaseDocNo'));
    if (!requesterEmail) return createResponse(false, msg_('missingRequesterEmail'));

    var companyName   = (data.companyName   || '').toString().trim();
    var requesterName = (data.requesterName || '').toString().trim();
    var requiredDate  = (data.requiredDate  || '').toString().trim();
    var items         = (data.items         || '[]').toString();
    var grandTotal    = parseFloat(data.grandTotal) || 0;

    if (!companyName)   return createResponse(false, msg_('missingCompanyName'));
    if (!requesterName) return createResponse(false, msg_('missingRequesterName'));
    if (!requiredDate)  return createResponse(false, msg_('missingRequiredDate'));
    if (!(data.budgetApprover || '').toString().trim())
      return createResponse(false, msg_('chooseBudgetApprover'));
    if (!(data.supplierApprover || '').toString().trim())
      return createResponse(false, msg_('chooseVendorApprover'));

    var parsedItems;
    try { parsedItems = JSON.parse(items); } catch (e) {
      return createResponse(false, msg_('invalidGoodsData') + e.message);
    }
    if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
      return createResponse(false, msg_('atLeastOneItem'));
    }

    var purchaseType = (data.purchaseType || 'goods').toString().trim().toLowerCase();
    if (purchaseType !== 'goods' && purchaseType !== 'services') purchaseType = 'goods';
    var p2pBranch = computeP2PBranch_(purchaseType, grandTotal);
    if (p2pBranch === 'full' && !(data.contractApprover || '').toString().trim()) {
      return createResponse(false,
        'Đề nghị này (Dịch vụ hoặc giá trị ≥ 2.000.000₫) yêu cầu người thẩm định hợp đồng.');
    }

    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(PR_SHEET_NAME);
    if (!sheet) return createResponse(false, msg_('sheetPrHistoryNotFound'));

    var values   = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < values.length; i++) {
      if ((values[i][0] || '').toString().trim() === prNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('prNotFoundPrefix') + prNo);

    var row           = values[rowIndex];
    var currentStatus = (row[14] || '').toString();

    if (currentStatus !== 'Trả lại bổ sung') {
      return createResponse(false, msg_('resubmitOnlyWhenReturned'));
    }

    var existingMetadata;
    try { existingMetadata = JSON.parse(row[16] || '{}'); } catch (e) { existingMetadata = {}; }

    // Caller must be the original requester
    var storedRequesterEmail = (existingMetadata.requesterEmail || '').toString().toLowerCase().trim();
    if (storedRequesterEmail && requesterEmail !== storedRequesterEmail) {
      return createResponse(false, msg_('notOriginalRequester'));
    }

    // Upload any new attachments to Drive
    var newAttachmentRecords = [];
    try {
      var rawAttachments = Array.isArray(data.attachments)
        ? data.attachments
        : (typeof data.attachments === 'string' ? JSON.parse(data.attachments || '[]') : []);
      rawAttachments = rawAttachments || [];
      var newFiles = rawAttachments.filter(function(f) { return f.fileData; });
      if (newFiles.length > 0) {
        var PR_DRIVE_FOLDER_ID = getCfg_('PURCHASE_REQUEST_FOLDER_ID', '1SJ-pUa6jg2rmJTzle-TvvSNrKMUduvx3');
        var parentFolder = DriveApp.getFolderById(PR_DRIVE_FOLDER_ID);
        var subFolder = parentFolder.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME).hasNext()
          ? parentFolder.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME).next()
          : parentFolder.createFolder(CONFIG.DRIVE_FOLDER_NAME);
        var prFolder = subFolder.getFoldersByName(prNo).hasNext()
          ? subFolder.getFoldersByName(prNo).next()
          : subFolder.createFolder(prNo);
        newFiles.forEach(function(f) {
          try {
            var b64 = f.fileData.includes(',') ? f.fileData.split(',')[1] : f.fileData;
            var mime = f.mimeType || 'application/octet-stream';
            var blob = Utilities.newBlob(Utilities.base64Decode(b64), mime, f.fileName || 'attachment');
            var driveFile = prFolder.createFile(blob);
            try { driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(e) {}
            newAttachmentRecords.push({ fileName: f.fileName, fileUrl: driveFile.getUrl() });
          } catch (fe) {
            Logger.log('[P2P] ⚠️ Resubmit attachment upload failed: ' + fe.message);
            newAttachmentRecords.push({ fileName: f.fileName, fileUrl: '', error: fe.message });
          }
        });
      }
      // Preserve existing attachments passed back from frontend (no fileData = already uploaded)
      rawAttachments.filter(function(f) { return !f.fileData && f.fileUrl; }).forEach(function(f) {
        newAttachmentRecords.push({ fileName: f.fileName, fileUrl: f.fileUrl });
      });
    } catch (ae) {
      Logger.log('[P2P] ⚠️ Resubmit attachment error: ' + ae.message);
    }

    var priorityMap = { gap: 'Gấp', binh_thuong: 'Bình Thường', khong_gap: 'Không Gấp',
                        high: 'Gấp', medium: 'Bình Thường', low: 'Không Gấp' };

    var attachmentUrlsStr = newAttachmentRecords
      .filter(function(r) { return r.fileUrl; })
      .map(function(r) { return r.fileUrl; })
      .join(', ');

    // Build new metadata — reset all approval state but preserve history + identity fields
    var newMetadata = {
      companyCode:          data.companyCode          || existingMetadata.companyCode          || '',
      companyKey:           data.companyKey           || existingMetadata.companyKey           || '',
      requesterEmail:       requesterEmail,
      budgetApproverNote:   data.budgetApproverNote   || '',
      supplierApproverNote: data.supplierApproverNote || '',
      submittedAt:          existingMetadata.submittedAt || new Date().toISOString(),
      resubmittedAt:        new Date().toISOString(),
      resubmitCount:        (parseInt(existingMetadata.resubmitCount, 10) || 0) + 1,
      requesterSignature:   data.requesterSignature   || '',
      attachments:          newAttachmentRecords,
      purchaseType:         purchaseType,
      p2pBranch:            p2pBranch,
      budgetStatus:    (data.budgetApprover    || '').trim() ? 'Pending' : 'N/A',
      supplierStatus:  (data.supplierApprover  || '').trim() ? 'Pending' : 'N/A',
      // Neither branch uses the PR's own contract stage (full → Contract module;
      // simplified → never required) — see computePRApprovalState_.
      contractStatus:  'N/A',
      purchasingStatus:(data.purchasingApprover|| '').trim() ? 'Pending' : 'N/A',
      vendorDetails: {
        vendorType:         data.vendorType         || '',
        vendorTaxId:        data.vendorTaxId        || '',
        vendorAddress:      data.vendorAddress      || '',
        vendorAccountName:  data.vendorAccountName  || '',
        vendorAccountNo:    data.vendorAccountNo    || '',
        vendorBankName:     data.vendorBankName     || '',
        vendorTransferNote: data.vendorTransferNote || ''
      },
      sentBackHistory: existingMetadata.sentBackHistory || []
    };

    // Overwrite the full row in place (all 20 columns)
    sheet.getRange(rowIndex + 1, 1, 1, 20).setValues([[
      prNo,
      companyName,
      data.companyKey         || '',
      data.department         || '',
      requesterName,
      requiredDate,
      priorityMap[data.priority] || data.priority || 'Bình Thường',
      data.purpose            || '',
      data.vendorName         || data.suggestedVendor || '',
      data.budgetCode         || '',
      data.budgetApprover     || '',
      data.supplierApprover   || '',
      items,
      grandTotal,
      'Đang duyệt ngân sách & NCC (2/5)',
      existingMetadata.submittedAt || new Date().toISOString(),
      JSON.stringify(newMetadata),
      p2pBranch === 'full' ? (data.contractApprover || '') : '',  // simplified branch never has a contract step
      data.purchasingApprover || '',
      attachmentUrlsStr
    ]]);
    SpreadsheetApp.flush();

    Logger.log('[P2P] ✅ PR resubmitted: ' + prNo + ' resubmitCount=' + newMetadata.resubmitCount);

    _appendAuditLog_({
      sheetName:  'PR_Audit_Log',
      docNo:      prNo,
      flow:       'PR',
      company:    companyName,
      action:     'Resubmit',
      role:       'requester',
      actorEmail: requesterEmail,
      actorName:  requesterName,
      prevStatus: currentStatus,
      newStatus:  'Đang duyệt ngân sách & NCC (2/5)',
      note:       'Gửi lại lần ' + newMetadata.resubmitCount
    });
    appendP2PHistoryRow_(sheet, 20, prNo, {
      action:     'Resubmit',
      role:       'requester',
      actorEmail: requesterEmail,
      actorName:  requesterName,
      prevStatus: currentStatus,
      newStatus:  'Đang duyệt ngân sách & NCC (2/5)',
      note:       'Gửi lại lần ' + newMetadata.resubmitCount
    });

    try {
      sendPurchaseRequestResubmitEmails_(prNo, data, newAttachmentRecords);
    } catch (emailErr) {
      Logger.log('[P2P] ⚠️ Resubmit email failed (non-fatal): ' + emailErr.message);
    }

    return createResponse(true, 'Đã gửi lại đề nghị thành công.', { prNo: prNo });

  } catch (error) {
    Logger.log('[P2P] ❌ ERROR in handleResubmitPurchaseRequest: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

// ==================== SEND-BACK EMAIL HELPERS ====================

/**
 * Sends notification emails when a PR is sent back to an earlier step.
 * targetStep=1 → email to requester
 * targetStep=2 → email to budget + supplier approvers
 * targetStep=3 → email to contract approver
 */
function sendPurchaseRequestSendBackEmail_(row, prNo, targetStep, note, senderRole, metadata) {
  var companyName   = (row[1]  || '').toString();
  var requesterName = (row[4]  || '').toString();
  var purpose       = (row[7]  || '').toString();
  var grandTotal    = (parseFloat(row[13]) || 0).toLocaleString('vi-VN') + ' ₫';

  var senderRoleLabel = {
    budget: 'Người duyệt Ngân sách', supplier: 'Người duyệt NCC',
    contract: 'Người thẩm định Hợp đồng', purchasing: 'Người mua hàng'
  }[senderRole] || senderRole;

  var infoTable = '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>' + prNo + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Người đề nghị:</td><td>' + requesterName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>' + purpose + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>' + grandTotal + '</td></tr>'
    + '</table>';

  var noteBox = '<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;margin:14px 0;border-radius:4px;">'
    + '<b>Lý do trả lại:</b><br>' + note
    + '</div>';

  if (targetStep === 1) {
    // Notify requester
    var recipientEmail = (metadata.requesterEmail || '').toString().trim();
    if (!recipientEmail) return;
    var subject = '[ĐỀ NGHỊ MUA HÀNG] Phiếu được trả lại để bổ sung - ' + prNo;
    var body = '<p>Kính gửi ' + requesterName + ',</p>'
      + '<p>Phiếu đề nghị mua hàng <b>' + prNo + '</b> đã được <b>' + senderRoleLabel + '</b> trả lại để bổ sung thông tin / tài liệu.</p>'
      + infoTable + noteBox
      + '<p>Vui lòng đăng nhập vào hệ thống, mở phiếu và chọn <b>"Chỉnh sửa & Gửi lại"</b> để cập nhật và gửi lại.</p>'
      + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
    GmailApp.sendEmail(recipientEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
    Logger.log('[P2P] ✅ Send-back email (step 1) sent to: ' + recipientEmail);

  } else if (targetStep === 2) {
    // Notify budget + supplier approvers
    var recipients = [(row[10] || '').toString().trim(), (row[11] || '').toString().trim()].filter(Boolean);
    var subject2 = '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Ngân sách & NCC - ' + prNo;
    var body2 = '<p>Kính gửi,</p>'
      + '<p><b>' + senderRoleLabel + '</b> đã yêu cầu xem lại bước <b>Ngân sách & NCC</b> của phiếu đề nghị mua hàng <b>' + prNo + '</b>.</p>'
      + infoTable + noteBox
      + '<p>Vui lòng đăng nhập vào hệ thống để xem lại và phê duyệt.</p>'
      + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
    recipients.forEach(function(email) {
      try {
        GmailApp.sendEmail(email, subject2, '', { htmlBody: body2, name: 'TLC Group Workflow' });
        Logger.log('[P2P] ✅ Send-back email (step 2) sent to: ' + email);
      } catch (e) {
        Logger.log('[P2P] ⚠️ Send-back email to ' + email + ' failed: ' + e.message);
      }
    });

  } else if (targetStep === 3) {
    // Notify contract approver
    var contractEmail = (row[17] || '').toString().trim();
    if (!contractEmail) return;
    var subject3 = '[ĐỀ NGHỊ MUA HÀNG] Yêu cầu xem lại - Bước Thẩm định Hợp đồng - ' + prNo;
    var body3 = '<p>Kính gửi,</p>'
      + '<p><b>' + senderRoleLabel + '</b> đã yêu cầu xem lại bước <b>Thẩm định Hợp đồng</b> của phiếu đề nghị mua hàng <b>' + prNo + '</b>.</p>'
      + infoTable + noteBox
      + '<p>Vui lòng đăng nhập vào hệ thống để xem lại và phê duyệt.</p>'
      + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
    GmailApp.sendEmail(contractEmail, subject3, '', { htmlBody: body3, name: 'TLC Group Workflow' });
    Logger.log('[P2P] ✅ Send-back email (step 3) sent to: ' + contractEmail);
  }
}

// ==================== ACCEPTANCE MINUTES ====================
/**
 * Acceptance Minutes (Biên Bản Nghiệm Thu)
 * Sheet: Acceptance_Minutes_History
 * Columns: A=AM No, B=Company, C=PR No, D=Department, E=Receiver Name,
 *          F=Receiver Email, G=AM Date, H=Items Received (JSON), I=Status,
 *          J=Submitted At, K=Dept Head Approver Email, L=Metadata (JSON)
 */
var AM_SHEET_NAME = 'Acceptance_Minutes_History';
var AM_COL = {
  AM_NO:          0,
  COMPANY:        1,
  PR_NO:          2,
  DEPARTMENT:     3,
  RECEIVER_NAME:  4,
  RECEIVER_EMAIL: 5,
  AM_DATE:        6,
  ITEMS:          7,
  STATUS:         8,
  SUBMITTED_AT:   9,
  DEPT_HEAD_EMAIL: 10,
  METADATA:       11
};

/** Get or auto-create the AM sheet with headers. */
function getOrCreateAMSheet_() {
  var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(AM_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(AM_SHEET_NAME);
    sheet.appendRow(AM_HEADERS_);
    Logger.log('[AM] Created sheet: ' + AM_SHEET_NAME);
  } else {
    standardizeWorkflowSheet_(sheet, AM_HEADERS_);
  }
  return sheet;
}

/** Find an AM row by amNo. Returns {rowIndex, row[], status, prNo} or null. */
function getAMByNo_(amNo) {
  if (!amNo) return null;
  try {
    var sheet = getOrCreateAMSheet_();
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if ((data[i][AM_COL.AM_NO] || '').toString().trim() === amNo.trim()) {
        return {
          rowIndex: i + 1, // 1-based sheet row
          row: data[i],
          status:  (data[i][AM_COL.STATUS]  || '').toString().trim(),
          prNo:    (data[i][AM_COL.PR_NO]   || '').toString().trim(),
          company: (data[i][AM_COL.COMPANY] || '').toString().trim(),
          metadata: (function() {
            try { return JSON.parse(data[i][AM_COL.METADATA] || '{}'); } catch(_) { return {}; }
          })()
        };
      }
    }
  } catch (e) {
    Logger.log('[AM] getAMByNo_ error: ' + e.message);
  }
  return null;
}

/** Upload base64 file to the AM Drive folder. Returns Drive URL or ''. */
function uploadAMFile_(base64DataUrl, fileName, mimeType, amNo) {
  try {
    var folderId = getCfg_('ACCEPTANCE_MINUTES_FOLDER_ID', getCfg_('PURCHASE_REQUEST_FOLDER_ID', '1SJ-pUa6jg2rmJTzle-TvvSNrKMUduvx3'));
    var parent   = DriveApp.getFolderById(folderId);
    var sub      = parent.getFoldersByName('AM_Docs').hasNext()
      ? parent.getFoldersByName('AM_Docs').next()
      : parent.createFolder('AM_Docs');
    var amFolder = sub.getFoldersByName(amNo).hasNext()
      ? sub.getFoldersByName(amNo).next()
      : sub.createFolder(amNo);
    var b64  = base64DataUrl.includes(',') ? base64DataUrl.split(',')[1] : base64DataUrl;
    var blob = Utilities.newBlob(Utilities.base64Decode(b64), mimeType || 'application/octet-stream', fileName || 'file');
    var f    = amFolder.createFile(blob);
    try { f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
    return f.getUrl();
  } catch (e) {
    Logger.log('[AM] uploadAMFile_ error: ' + e.message);
    return '';
  }
}

/** Create a new Acceptance Minutes record. */
function handleCreateAcceptanceMinutes(data) {
  try {
    var amNo         = (data.amNo          || '').toString().trim();
    var companyName  = (data.companyName   || '').toString().trim();
    var prNo         = (data.prNo          || '').toString().trim();
    var department   = (data.department    || '').toString().trim();
    var receiverName = (data.receiverName  || '').toString().trim();
    var receiverEmail= (data.receiverEmail || '').toString().trim().toLowerCase();
    var amDate       = (data.amDate        || '').toString().trim();
    var deptHeadEmail= (data.deptHeadEmail || '').toString().trim().toLowerCase();
    var itemsRaw     = (data.items         || '[]').toString();

    if (!companyName)   return createResponse(false, msg_('missingCompanyName'));
    if (!prNo)          return createResponse(false, msg_('missingPrNoFull'));
    if (!receiverName)  return createResponse(false, msg_('missingReceiverName'));
    if (!receiverEmail) return createResponse(false, msg_('missingReceiverEmail'));
    if (!deptHeadEmail) return createResponse(false, msg_('chooseAmConfirmer'));
    if (!(data.receiverSignature || '').toString().trim())
      return createResponse(false, msg_('receiverSignatureRequired'));

    var contractNo = (data.contractNo || '').toString().trim();
    var prInfoEarly = null;

    // Validate items
    var parsedItems;
    try { parsedItems = JSON.parse(itemsRaw); } catch (e) {
      return createResponse(false, msg_('invalidGoodsData') + e.message);
    }
    if (!Array.isArray(parsedItems) || parsedItems.length === 0)
      return createResponse(false, msg_('atLeastOneItem'));

    // Validate PR exists and is Hoàn thành
    var ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var prSheet = ss.getSheetByName(PR_SHEET_NAME);
    if (prSheet) {
      var prData = prSheet.getDataRange().getValues();
      var prFound = false;
      for (var pi = 1; pi < prData.length; pi++) {
        if ((prData[pi][0] || '').toString().trim() === prNo) {
          prFound = true;
          var prStatus = (prData[pi][14] || '').toString().trim();
          if (prStatus !== 'Hoàn thành') {
            return createResponse(false, msg_('prNotApprovedYet', prNo, prStatus));
          }
          break;
        }
      }
      if (!prFound) return createResponse(false, msg_('prDocNotFoundPrefix') + prNo);
    }

    prInfoEarly = findPRByNo_(prNo);
    var p2pBranchAM = prInfoEarly ? (prInfoEarly.metadata.p2pBranch || 'full') : 'full';
    if (p2pBranchAM === 'full') {
      if (!contractNo) {
        return createResponse(false, msg_('fullFlowNeedsContractNo'));
      }
      var ctCheck = getContractByNo_(contractNo);
      if (!ctCheck) return createResponse(false, msg_('contractNotFoundPrefix') + contractNo);
      if (ctCheck.status !== 'Đã ký' && ctCheck.status !== 'Có phụ lục') {
        return createResponse(false, msg_('contractNotApproved', contractNo, ctCheck.status));
      }
      if ((ctCheck.prNo || '') !== prNo) {
        return createResponse(false, msg_('contractNotForPr', contractNo, prNo));
      }
    }

    // Fallback AM number
    if (!amNo) {
      var now2    = new Date();
      var ds2     = Utilities.formatDate(now2, 'Asia/Ho_Chi_Minh', 'yyyyMMdd');
      amNo = 'AM-' + ds2 + '-' + Math.floor(Math.random() * 100000).toString().padStart(6, '0');
    }

    // Check duplicate
    if (getAMByNo_(amNo)) return createResponse(false, msg_('amNoExists', amNo));

    var submittedAt = new Date().toISOString();

    // Upload receiver signature
    var receiverSigUrl = uploadAMFile_(data.receiverSignature, 'receiver_sig.jpg', 'image/jpeg', amNo);

    // Upload attachments
    var attachmentRecords = [];
    try {
      var rawAtt = Array.isArray(data.attachments) ? data.attachments
        : (typeof data.attachments === 'string' ? JSON.parse(data.attachments || '[]') : []);
      (rawAtt || []).forEach(function(f) {
        if (!f.fileData) return;
        var url = uploadAMFile_(f.fileData, f.fileName || 'attachment', f.mimeType || 'application/octet-stream', amNo);
        attachmentRecords.push({ fileName: f.fileName, fileUrl: url });
      });
    } catch (ae) {
      Logger.log('[AM] Attachment upload error: ' + ae.message);
    }

    var metadata = {
      receiverSignature: receiverSigUrl,
      attachments:       attachmentRecords,
      deptHeadStatus:    'Pending',
      deptHeadApprovedAt: '',
      deptHeadSignature: '',
      deptHeadNote:      '',
      rejectionNote:     '',
      companyCode:       data.companyCode || '',
      requesterEmail:    receiverEmail,
      contractNo:        contractNo || '',
      purchaseType:      prInfoEarly ? (prInfoEarly.metadata.purchaseType || 'goods') : 'goods'
    };

    var sheet = getOrCreateAMSheet_();
    sheet.appendRow([
      amNo, companyName, prNo, department, receiverName,
      receiverEmail, amDate || submittedAt.substring(0,10),
      JSON.stringify(parsedItems),
      'Chờ xác nhận', submittedAt, deptHeadEmail,
      JSON.stringify(metadata)
    ]);
    Logger.log('[AM] Created: ' + amNo);

    _appendAuditLog_({
      sheetName:  'AM_Audit_Log',
      docNo:      amNo,
      flow:       'AM',
      company:    companyName,
      action:     'Submit',
      role:       'receiver',
      actorEmail: receiverEmail,
      actorName:  receiverName,
      prevStatus: '',
      newStatus:  'Chờ xác nhận',
      note:       'Biên bản cho PR: ' + prNo,
      extra:      { prNo: prNo, contractNo: contractNo || '' }
    });
    try { ensureP2PHistoryColumns_(sheet); appendP2PHistoryRow_(sheet, 12, amNo, {
      action: 'Submit', role: 'receiver', actorEmail: receiverEmail, actorName: receiverName,
      prevStatus: '', newStatus: 'Chờ xác nhận', note: 'PR: ' + prNo
    }); } catch (histErr_) { Logger.log('[AM] history row error: ' + histErr_.message); }

    // Email dept head
    sendAMApprovalRequestEmail_(amNo, companyName, prNo, receiverName, deptHeadEmail, parsedItems);

    return createResponse(true, 'Biên bản nghiệm thu đã được tạo thành công.', { amNo: amNo });
  } catch (e) {
    Logger.log('[AM] handleCreateAcceptanceMinutes error: ' + e.message);
    return createResponse(false, msg_('errCreateAm') + e.message);
  }
}

/** Return AM history for the requesting user (receiver or dept head). */
function handleGetAcceptanceMinutesHistory(data) {
  try {
    var email = (data.email || data.requesterEmail || '').toString().trim().toLowerCase();
    var sheet = getOrCreateAMSheet_();
    var rows  = sheet.getDataRange().getValues();
    var results = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      var rEmail = (r[AM_COL.RECEIVER_EMAIL] || '').toString().toLowerCase();
      var dhEmail= (r[AM_COL.DEPT_HEAD_EMAIL]|| '').toString().toLowerCase();
      if (!email || rEmail === email || dhEmail === email) {
        var meta = {};
        try { meta = JSON.parse(r[AM_COL.METADATA] || '{}'); } catch (_) {}
        results.push({
          amNo:          r[AM_COL.AM_NO],
          company:       r[AM_COL.COMPANY],
          prNo:          r[AM_COL.PR_NO],
          department:    r[AM_COL.DEPARTMENT],
          receiverName:  r[AM_COL.RECEIVER_NAME],
          receiverEmail: r[AM_COL.RECEIVER_EMAIL],
          amDate:        r[AM_COL.AM_DATE] ? r[AM_COL.AM_DATE].toString() : '',
          status:        r[AM_COL.STATUS],
          submittedAt:   r[AM_COL.SUBMITTED_AT] ? r[AM_COL.SUBMITTED_AT].toString() : '',
          deptHeadEmail: r[AM_COL.DEPT_HEAD_EMAIL],
          deptHeadStatus: meta.deptHeadStatus || 'Pending',
          items:         (function() { try { return JSON.parse(r[AM_COL.ITEMS] || '[]'); } catch(_) { return []; } })(),
          metadata:      meta
        });
      }
    }
    results.reverse(); // newest first
    return createResponse(true, 'OK', { acceptanceMinutes: results });
  } catch (e) {
    Logger.log('[AM] handleGetAcceptanceMinutesHistory error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

/** Return a single AM record by amNo. */
function handleGetAcceptanceMinutesDetail(data) {
  try {
    var amNo = (data.amNo || '').toString().trim();
    if (!amNo) return createResponse(false, msg_('missingAmNo'));
    var rec = getAMByNo_(amNo);
    if (!rec) return createResponse(false, msg_('amNotFoundPrefix') + amNo);
    var r = rec.row;
    var meta = rec.metadata;
    return createResponse(true, 'OK', {
      am: {
        amNo:          r[AM_COL.AM_NO],
        company:       r[AM_COL.COMPANY],
        prNo:          r[AM_COL.PR_NO],
        department:    r[AM_COL.DEPARTMENT],
        receiverName:  r[AM_COL.RECEIVER_NAME],
        receiverEmail: r[AM_COL.RECEIVER_EMAIL],
        amDate:        r[AM_COL.AM_DATE] ? r[AM_COL.AM_DATE].toString() : '',
        status:        r[AM_COL.STATUS],
        submittedAt:   r[AM_COL.SUBMITTED_AT] ? r[AM_COL.SUBMITTED_AT].toString() : '',
        deptHeadEmail: r[AM_COL.DEPT_HEAD_EMAIL],
        items:         (function() { try { return JSON.parse(r[AM_COL.ITEMS] || '[]'); } catch(_) { return []; } })(),
        metadata:      meta
      }
    });
  } catch (e) {
    Logger.log('[AM] handleGetAcceptanceMinutesDetail error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

/** Return all AMs linked to a given PR number — used by Payment Request validation. */
function handleGetAcceptanceMinutesByPR(data) {
  try {
    var prNo  = (data.prNo || '').toString().trim();
    if (!prNo) return createResponse(false, msg_('missingPrNoShort'));
    var sheet = getOrCreateAMSheet_();
    var rows  = sheet.getDataRange().getValues();
    var results = [];
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][AM_COL.PR_NO] || '').toString().trim() === prNo) {
        var meta = {};
        try { meta = JSON.parse(rows[i][AM_COL.METADATA] || '{}'); } catch (_) {}
        results.push({
          amNo:          rows[i][AM_COL.AM_NO],
          company:       rows[i][AM_COL.COMPANY],
          prNo:          rows[i][AM_COL.PR_NO],
          receiverName:  rows[i][AM_COL.RECEIVER_NAME],
          amDate:        rows[i][AM_COL.AM_DATE] ? rows[i][AM_COL.AM_DATE].toString() : '',
          status:        rows[i][AM_COL.STATUS],
          deptHeadEmail: rows[i][AM_COL.DEPT_HEAD_EMAIL],
          deptHeadStatus: meta.deptHeadStatus || 'Pending'
        });
      }
    }
    return createResponse(true, 'OK', { acceptanceMinutes: results });
  } catch (e) {
    Logger.log('[AM] handleGetAcceptanceMinutesByPR error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

/** Dept head approves an AM → sets status to Đã nghiệm thu. */
function handleApproveAcceptanceMinutes(data) {
  try {
    var amNo          = (data.amNo          || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    var approverSig   = (data.approverSignature || '').toString().trim();
    var note          = (data.note          || '').toString().trim();

    if (!amNo)          return createResponse(false, msg_('missingAmNo'));
    if (!approverEmail) return createResponse(false, msg_('missingApproverEmail'));
    if (!approverSig)   return createResponse(false, msg_('approverSignatureRequired'));

    var rec = getAMByNo_(amNo);
    if (!rec) return createResponse(false, msg_('amNotFoundPrefix') + amNo);

    var deptHead = (rec.row[AM_COL.DEPT_HEAD_EMAIL] || '').toString().trim().toLowerCase();
    if (approverEmail !== deptHead)
      return createResponse(false, msg_('notAmConfirmer'));
    if (rec.status === 'Đã nghiệm thu')
      return createResponse(false, msg_('amAlreadyConfirmed'));
    if (rec.status === 'Từ chối')
      return createResponse(false, msg_('amRejectedCannotApprove'));

    // Upload signature
    var sigUrl = uploadAMFile_(approverSig, 'depthead_sig.jpg', 'image/jpeg', amNo);
    var approvedAt = new Date().toISOString();

    var meta = rec.metadata;
    meta.deptHeadStatus    = 'Approved';
    meta.deptHeadApprovedAt = approvedAt;
    meta.deptHeadSignature = sigUrl;
    meta.deptHeadNote      = note;

    var sheet = getOrCreateAMSheet_();
    sheet.getRange(rec.rowIndex, AM_COL.STATUS   + 1).setValue('Đã nghiệm thu');
    sheet.getRange(rec.rowIndex, AM_COL.METADATA + 1).setValue(JSON.stringify(meta));
    Logger.log('[AM] Approved: ' + amNo + ' by ' + approverEmail);

    _appendAuditLog_({
      sheetName:  'AM_Audit_Log',
      docNo:      amNo,
      flow:       'AM',
      company:    rec.company,
      action:     'Approve',
      role:       'deptHead',
      actorEmail: approverEmail,
      prevStatus: rec.status,
      newStatus:  'Đã nghiệm thu',
      note:       note,
      extra:      { prNo: rec.prNo, signatureUploaded: !!sigUrl }
    });
    try { appendP2PHistoryRow_(sheet, 12, amNo, {
      action: 'Approve', role: 'deptHead', actorEmail: approverEmail,
      prevStatus: rec.status, newStatus: 'Đã nghiệm thu', note: note
    }); } catch (histErr_) { Logger.log('[AM] history row error: ' + histErr_.message); }

    // Email receiver
    var receiverEmail = (rec.row[AM_COL.RECEIVER_EMAIL] || '').toString().trim();
    var receiverName  = (rec.row[AM_COL.RECEIVER_NAME]  || '').toString().trim();
    sendAMOutcomeEmail_(amNo, rec.company, rec.prNo, receiverEmail, receiverName, true, note);

    return createResponse(true, 'Biên bản ' + amNo + ' đã được xác nhận.', { amNo: amNo, status: 'Đã nghiệm thu' });
  } catch (e) {
    Logger.log('[AM] handleApproveAcceptanceMinutes error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

/** Dept head rejects an AM → sets status to Từ chối. */
function handleRejectAcceptanceMinutes(data) {
  try {
    var amNo          = (data.amNo          || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    var note          = (data.note          || '').toString().trim();

    if (!amNo)          return createResponse(false, msg_('missingAmNo'));
    if (!approverEmail) return createResponse(false, msg_('missingApproverEmail'));
    if (!note)          return createResponse(false, msg_('enterRejectReason'));

    var rec = getAMByNo_(amNo);
    if (!rec) return createResponse(false, msg_('amNotFoundPrefix') + amNo);

    var deptHead = (rec.row[AM_COL.DEPT_HEAD_EMAIL] || '').toString().trim().toLowerCase();
    if (approverEmail !== deptHead)
      return createResponse(false, msg_('notAmConfirmer'));
    if (rec.status === 'Đã nghiệm thu')
      return createResponse(false, msg_('amAlreadyConfirmed'));

    var meta = rec.metadata;
    meta.deptHeadStatus = 'Rejected';
    meta.rejectionNote  = note;
    meta.deptHeadNote   = note;

    var sheet = getOrCreateAMSheet_();
    sheet.getRange(rec.rowIndex, AM_COL.STATUS   + 1).setValue('Từ chối');
    sheet.getRange(rec.rowIndex, AM_COL.METADATA + 1).setValue(JSON.stringify(meta));
    Logger.log('[AM] Rejected: ' + amNo + ' by ' + approverEmail);

    _appendAuditLog_({
      sheetName:  'AM_Audit_Log',
      docNo:      amNo,
      flow:       'AM',
      company:    rec.company,
      action:     'Reject',
      role:       'deptHead',
      actorEmail: approverEmail,
      prevStatus: rec.status,
      newStatus:  'Từ chối',
      note:       note,
      extra:      { prNo: rec.prNo }
    });
    try { appendP2PHistoryRow_(sheet, 12, amNo, {
      action: 'Reject', role: 'deptHead', actorEmail: approverEmail,
      prevStatus: rec.status, newStatus: 'Từ chối', note: note
    }); } catch (histErr_) { Logger.log('[AM] history row error: ' + histErr_.message); }

    var receiverEmail = (rec.row[AM_COL.RECEIVER_EMAIL] || '').toString().trim();
    var receiverName  = (rec.row[AM_COL.RECEIVER_NAME]  || '').toString().trim();
    sendAMOutcomeEmail_(amNo, rec.company, rec.prNo, receiverEmail, receiverName, false, note);

    return createResponse(true, 'Biên bản ' + amNo + ' đã bị từ chối.', { amNo: amNo, status: 'Từ chối' });
  } catch (e) {
    Logger.log('[AM] handleRejectAcceptanceMinutes error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

/** Email dept head requesting approval. */
function sendAMApprovalRequestEmail_(amNo, companyName, prNo, receiverName, deptHeadEmail, items) {
  if (!deptHeadEmail) return;
  var itemList = items.slice(0, 5).map(function(it) {
    return '<li>' + (it.desc || it.name || '—') + ' — Đặt: ' + (it.orderedQty || 0) + ' / Nhận: ' + (it.receivedQty || 0) + ' ' + (it.unit || '') + '</li>';
  }).join('') + (items.length > 5 ? '<li>... và ' + (items.length - 5) + ' dòng khác</li>' : '');
  var subject = '[BIÊN BẢN NGHIỆM THU] Yêu cầu xác nhận - ' + amNo;
  var body = '<p>Kính gửi,</p>'
    + '<p>Biên bản nghiệm thu <b>' + amNo + '</b> đã được tạo bởi <b>' + receiverName + '</b> và đang chờ xác nhận của bạn.</p>'
    + '<table cellpadding="6" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số biên bản:</td><td>' + amNo + '</td></tr>'
    + '<tr><td style="font-weight:700;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;">Phiếu mua hàng:</td><td>' + prNo + '</td></tr>'
    + '<tr><td style="font-weight:700;">Người nhận hàng:</td><td>' + receiverName + '</td></tr>'
    + '</table>'
    + '<br><b>Danh sách hàng hóa:</b><ul>' + itemList + '</ul>'
    + '<p>Vui lòng đăng nhập vào hệ thống để xem chi tiết và xác nhận.</p>'
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
  try {
    GmailApp.sendEmail(deptHeadEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
    Logger.log('[AM] ✅ Approval request email sent to: ' + deptHeadEmail);
  } catch (e) {
    Logger.log('[AM] ⚠️ Email to dept head failed: ' + e.message);
  }
}

/** Email receiver with approve/reject outcome. */
function sendAMOutcomeEmail_(amNo, companyName, prNo, receiverEmail, receiverName, approved, note) {
  if (!receiverEmail) return;
  var statusLabel = approved ? 'ĐÃ ĐƯỢC XÁC NHẬN ✅' : 'BỊ TỪ CHỐI ❌';
  var subject = '[BIÊN BẢN NGHIỆM THU] ' + statusLabel + ' - ' + amNo;
  var noteHtml = note ? '<div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;margin:14px 0;border-radius:4px;"><b>Ghi chú:</b><br>' + note + '</div>' : '';
  var body = '<p>Kính gửi ' + receiverName + ',</p>'
    + '<p>Biên bản nghiệm thu <b>' + amNo + '</b> (phiếu mua hàng: <b>' + prNo + '</b>) '
    + (approved ? 'đã được <b>xác nhận</b>. Bạn có thể tiến hành tạo Đề nghị Thanh toán.' : 'đã <b>bị từ chối</b>. Vui lòng xem xét lại và tạo biên bản mới nếu cần.')
    + '</p>'
    + '<table cellpadding="6" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;">Số biên bản:</td><td>' + amNo + '</td></tr>'
    + '</table>'
    + noteHtml
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
  try {
    GmailApp.sendEmail(receiverEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
    Logger.log('[AM] ✅ Outcome email sent to: ' + receiverEmail);
  } catch (e) {
    Logger.log('[AM] ⚠️ Outcome email failed: ' + e.message);
  }
}

/**
 * Notifies budget + supplier approvers when a PR is resubmitted after being sent back.
 */
function sendPurchaseRequestResubmitEmails_(prNo, data, attachmentRecords) {
  var companyName   = (data.companyName   || '').toString();
  var requesterName = (data.requesterName || '').toString();
  var purpose       = (data.purpose       || '').toString();
  var grandTotal    = (parseFloat(data.grandTotal) || 0).toLocaleString('vi-VN') + ' ₫';
  var requiredDate  = (data.requiredDate  || '').toString();

  var attachHtml = '';
  if (attachmentRecords && attachmentRecords.length > 0) {
    var links = attachmentRecords.filter(function(r){ return r.fileUrl; }).map(function(r){
      return '<li><a href="' + r.fileUrl + '">' + r.fileName + '</a></li>';
    }).join('');
    if (links) attachHtml = '<br><b>Tệp đính kèm:</b><ul>' + links + '</ul>';
  }

  var subject = '[ĐỀ NGHỊ MUA HÀNG] Phiếu đã được cập nhật và gửi lại - ' + prNo;
  var body = '<p>Kính gửi,</p>'
    + '<p>Phiếu đề nghị mua hàng <b>' + prNo + '</b> đã được người đề nghị cập nhật và gửi lại, đang chờ phê duyệt của bạn.</p>'
    + '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số phiếu:</td><td>' + prNo + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Công ty:</td><td>' + companyName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Người đề nghị:</td><td>' + requesterName + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Mục đích:</td><td>' + purpose + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Tổng cộng:</td><td>' + grandTotal + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Ngày cần hàng:</td><td>' + requiredDate + '</td></tr>'
    + '</table>'
    + attachHtml
    + '<p style="margin-top:16px;">Vui lòng đăng nhập vào hệ thống để xem chi tiết và phê duyệt.</p>'
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';

  [data.budgetApprover, data.supplierApprover].forEach(function(email) {
    if (!email) return;
    try {
      GmailApp.sendEmail(email, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
      Logger.log('[P2P] ✅ Resubmit email sent to: ' + email);
    } catch (e) {
      Logger.log('[P2P] ⚠️ Resubmit email to ' + email + ' failed: ' + e.message);
    }
  });
}

// ==================== P2P BRANCH & SHARED HELPERS ====================

/** @returns {'simplified'|'full'} */
function computeP2PBranch_(purchaseType, grandTotal) {
  var pt = (purchaseType || 'goods').toString().trim().toLowerCase();
  var gt = parseFloat(grandTotal) || 0;
  if (pt === 'services' || gt >= 2000000) return 'full';
  return 'simplified';
}

/** @returns {{ row:Array, rowIndex:number, metadata:Object }|null} */
function findPRByNo_(prNo) {
  prNo = (prNo || '').toString().trim();
  if (!prNo) return null;
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PR_SHEET_NAME);
  if (!sheet) return null;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if ((values[i][0] || '').toString().trim() === prNo) {
      var meta = {};
      try { meta = JSON.parse(values[i][16] || '{}'); } catch (_) {}
      if (!meta.p2pBranch) meta.p2pBranch = 'full';
      return { row: values[i], rowIndex: i, metadata: meta };
    }
  }
  return null;
}

function getPMTsByPR_(prNo) {
  prNo = (prNo || '').toString().trim();
  var results = [];
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet || sheet.getLastRow() <= 1) return results;
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      var rowPr = (rows[i][CONFIG.COLUMNS.PR_REQUEST_NO] || '').toString().trim();
      if (rowPr !== prNo) continue;
      var meta = {};
      try { meta = JSON.parse(rows[i][CONFIG.COLUMNS.METADATA] || '{}'); } catch (_) {}
      results.push({
        requestId: rows[i][CONFIG.COLUMNS.REQUEST_ID] || '',
        amount: parseFloat(rows[i][CONFIG.COLUMNS.TOTAL_AMOUNT]) || 0,
        status: (rows[i][CONFIG.COLUMNS.OVERALL_STATUS] || '').toString(),
        amNo: meta.amNo || '',
        installmentNo: meta.installmentNo || 0,
        installmentNote: meta.installmentNote || '',
        submittedAt: rows[i][CONFIG.COLUMNS.SUBMITTED_AT] || ''
      });
    }
  } catch (e) {
    Logger.log('[P2P] getPMTsByPR_ error: ' + e.message);
  }
  return results;
}

function sumPaidPMTsForPR_(prNo) {
  return getPMTsByPR_(prNo).filter(function(p) {
    var s = (p.status || '').toString();
    return s !== 'Rejected' && s !== 'Từ chối';
  }).reduce(function(sum, p) { return sum + (p.amount || 0); }, 0);
}

function _validatePRForDirectPayment_(prNo) {
  var prInfo = findPRByNo_(prNo);
  if (!prInfo) return { ok: false, message: 'Không tìm thấy PR: ' + prNo };
  var status = (prInfo.row[14] || '').toString().trim();
  if (status !== 'Hoàn thành') {
    return { ok: false, message: 'PR chưa được phê duyệt hoàn tất.' };
  }
  var p2pBranch = prInfo.metadata.p2pBranch || 'full';
  if (p2pBranch !== 'simplified') {
    return { ok: false, message: 'PR này thuộc quy trình đầy đủ — cần tạo Biên bản nghiệm thu trước khi thanh toán.' };
  }
  var existing = getPMTsByPR_(prNo).filter(function(p) {
    var s = (p.status || '').toString();
    return s !== 'Rejected' && s !== 'Từ chối';
  });
  if (existing.length > 0) {
    return { ok: false, message: 'Đã tồn tại đề nghị thanh toán cho PR này.' };
  }
  var meta = prInfo.metadata;
  return {
    ok: true,
    message: 'OK',
    data: {
      prNo: prNo,
      vendorName: (meta.vendorDetails && meta.vendorDetails.vendorName) || (prInfo.row[8] || ''),
      department: prInfo.row[3] || '',
      grandTotal: prInfo.row[13] || 0,
      requesterName: prInfo.row[4] || '',
      purchaseType: meta.purchaseType || 'goods',
      p2pBranch: p2pBranch
    }
  };
}

function handleValidatePRForDirectPayment(data) {
  var prNo = (data.prNo || '').toString().trim();
  if (!prNo) return createResponse(false, msg_('missingPrNo'));
  var result = _validatePRForDirectPayment_(prNo);
  if (!result.ok) return createResponse(false, result.message);
  return createResponse(true, 'OK', result.data);
}

function handleGetPaymentProgressByPR(data) {
  try {
    var prNo = (data.prNo || '').toString().trim();
    if (!prNo) return createResponse(false, msg_('missingPrNo'));
    var prInfo = findPRByNo_(prNo);
    if (!prInfo) return createResponse(false, msg_('prIdNotFoundPrefix') + prNo);

    var ceiling = parseFloat(prInfo.row[13]) || 0;
    var contracts = getContractsByPR_(prNo);
    var signed = contracts.filter(function(c) {
      return c.status === 'Đã ký' || c.status === 'Có phụ lục';
    });
    if (signed.length > 0) {
      ceiling = parseFloat(signed[signed.length - 1].contractValue) || ceiling;
    }

    var installments = getPMTsByPR_(prNo).filter(function(p) {
      var s = (p.status || '').toString();
      return s !== 'Rejected' && s !== 'Từ chối';
    });
    var paidTotal = installments.reduce(function(s, p) { return s + (p.amount || 0); }, 0);

    return createResponse(true, 'OK', {
      prNo: prNo,
      grandTotal: ceiling,
      installments: installments,
      paidTotal: paidTotal,
      remaining: Math.max(0, ceiling - paidTotal)
    });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

// ==================== P2P APPEND-ONLY HISTORY ====================

/**
 * Column layout for P2P history event rows (appended to each flow's main data sheet):
 *   Each sheet has its own base width (PR=20, PMT=36, AM=12, CT=16).
 *   Event rows are padded to that width, then have 10 trailing event columns:
 *   +0: Row_Type        ('submit' for the original row, 'event' for history rows)
 *   +1: Event_Action    ('Submit'|'Approve'|'Reject'|'Return'|'Resubmit'|'AmendmentApproved')
 *   +2: Event_Role      e.g. 'budget', 'supplier', 'requester', 'deptHead', 'contract'
 *   +3: Event_Actor_Email
 *   +4: Event_Actor_Name
 *   +5: Event_Prev_Status
 *   +6: Event_New_Status
 *   +7: Event_Timestamp (ISO 8601)
 *   +8: Event_Note
 *   +9: Event_Meta_JSON
 */

var PMT_HEADERS_ = [
  'request_id', 'request_date', 'company_name', 'requestor_name', 'requestor_email', 'department',
  'purchase_type', 'pr_no', 'purpose', 'supplier', 'recipient',
  'product_items_json', 'total_amount', 'payment_type', 'payment_phases_json',
  'budget_approver', 'budget_status', 'budget_signature',
  'supplier_approver', 'supplier_status', 'supplier_signature',
  'legal_approver', 'legal_status', 'legal_signature',
  'accounting_approver', 'accounting_status', 'accounting_signature',
  'director_approver', 'director_status', 'director_signature',
  'final_approver', 'final_status', 'final_signature',
  'status', 'submitted_at', 'metadata_json'
];

var PR_HEADERS_ = [
  'pr_no', 'company_name', 'company_key', 'department', 'requester_name',
  'required_date', 'priority', 'purpose', 'suggested_vendor', 'budget_code',
  'budget_approver_email', 'supplier_approver_email',
  'items_json', 'grand_total', 'status', 'submitted_at', 'metadata_json',
  'contract_approver_email', 'purchasing_approver_email', 'attachment_urls'
];

var AM_HEADERS_ = [
  'am_no', 'company_name', 'pr_no', 'department', 'receiver_name',
  'receiver_email', 'am_date', 'items_received_json', 'status',
  'submitted_at', 'dept_head_approver_email', 'metadata_json'
];

var CT_HEADERS_ = [
  'contract_no', 'pr_no', 'vendor_name', 'vendor_contact', 'contract_value',
  'start_date', 'end_date', 'payment_terms', 'contract_doc_url', 'status',
  'created_by', 'created_at', 'approved_by', 'approved_at', 'notes', 'metadata_json'
];

var CT_AMEND_HEADERS_ = [
  'amendment_no', 'contract_no', 'pr_no', 'amendment_type',
  'old_value', 'new_value', 'description', 'doc_url', 'status',
  'requested_by', 'requested_at', 'approved_by', 'approved_at', 'metadata_json'
];

var AUDIT_HEADERS_ = [
  'document_no', 'flow', 'company_name', 'action', 'role',
  'actor_email', 'actor_name', 'prev_status', 'new_status',
  'timestamp', 'note', 'extra_json'
];

var P2P_HISTORY_HEADERS_ = [
  'row_type', 'event_action', 'event_role',
  'event_actor_email', 'event_actor_name',
  'event_prev_status', 'event_new_status',
  'event_timestamp', 'event_note', 'event_metadata_json'
];

function applyStandardHeaders_(sheet, headers) {
  if (!sheet || !headers || !headers.length) return;
  var last = Math.max(sheet.getLastColumn(), headers.length);
  var current = sheet.getRange(1, 1, 1, last).getValues()[0];
  var changed = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(current[i] == null ? '' : current[i]).trim() !== headers[i]) {
      current[i] = headers[i];
      changed = true;
    }
  }
  if (changed) sheet.getRange(1, 1, 1, headers.length).setValues([current.slice(0, headers.length)]);
}

function workflowBaseHeaders_(baseWidth) {
  if (baseWidth === 36) return PMT_HEADERS_;
  if (baseWidth === 20) return PR_HEADERS_;
  if (baseWidth === 12) return AM_HEADERS_;
  if (baseWidth === 16) return CT_HEADERS_;
  return null;
}

function standardizeWorkflowSheet_(sheet, baseHeaders) {
  if (!sheet || !baseHeaders) return;
  applyStandardHeaders_(sheet, baseHeaders.concat(P2P_HISTORY_HEADERS_));
  ensureP2PHistoryColumns_(sheet);
}

/** Ensure the 10 event columns exist in the header row; add if missing. */
function ensureP2PHistoryColumns_(sheet) {
  if (!sheet || sheet.getLastColumn() < 1) return;
  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var alias = {
    'row_type': 'row_type',
    'event_action': 'event_action',
    'event_role': 'event_role',
    'event_actor_email': 'event_actor_email',
    'event_actor_name': 'event_actor_name',
    'event_prev_status': 'event_prev_status',
    'event_new_status': 'event_new_status',
    'event_timestamp': 'event_timestamp',
    'event_note': 'event_note',
    'event_meta_json': 'event_metadata_json',
    'event_metadata_json': 'event_metadata_json'
  };
  var changed = false;
  for (var i = 0; i < header.length; i++) {
    var key = String(header[i] || '').trim().toLowerCase().replace(/[\s]+/g, '_');
    if (alias[key] && String(header[i]).trim() !== alias[key]) {
      header[i] = alias[key];
      changed = true;
    }
  }
  if (changed) sheet.getRange(1, 1, 1, lastCol).setValues([header]);
  var missing = P2P_HISTORY_HEADERS_.filter(function(h) { return header.indexOf(h) === -1; });
  if (missing.length === 0) return;
  for (var j = 0; j < missing.length; j++) {
    sheet.getRange(1, lastCol + j + 1).setValue(missing[j]);
  }
  Logger.log('[P2P] Added history columns: ' + missing.join(', '));
}

/**
 * Appends one event row to a P2P flow's main data sheet.
 * @param {Sheet}  sheet      - the already-open Sheet object
 * @param {number} baseWidth  - number of data columns in that sheet (PR=20, PMT=36, AM=12, CT=16)
 * @param {string} docNo      - the document identifier (PR No / Request ID / AM No / Contract No)
 * @param {object} opts       - { action, role, actorEmail, actorName, prevStatus, newStatus, note, metaJson }
 */
function appendP2PHistoryRow_(sheet, baseWidth, docNo, opts) {
  var baseHeaders = workflowBaseHeaders_(baseWidth);
  if (baseHeaders) standardizeWorkflowSheet_(sheet, baseHeaders);
  var base = new Array(baseWidth).fill('');
  base[0] = docNo;
  sheet.appendRow(base.concat([
    'event',
    opts.action     || '',
    opts.role       || '',
    opts.actorEmail || '',
    opts.actorName  || '',
    opts.prevStatus || '',
    opts.newStatus  || '',
    new Date().toISOString(),
    opts.note       || '',
    opts.metaJson   || ''
  ]));
}

/**
 * Returns all event rows for a given document number and flow.
 * action: 'getP2PHistory', docNo: '<PR/PMT/AM/CT No>', flow: 'PR'|'PMT'|'AM'|'CT'
 */
function handleGetP2PHistory(data) {
  try {
    var docNo = (data.docNo || '').toString().trim();
    var flow  = (data.flow  || '').toString().trim();
    var cfgMap = {
      PR:  { sheetName: PR_SHEET_NAME,       baseWidth: 20 },
      PMT: { sheetName: CONFIG.SHEET_NAME,   baseWidth: 36 },
      AM:  { sheetName: AM_SHEET_NAME,       baseWidth: 12 },
      CT:  { sheetName: CT_SHEET_NAME,       baseWidth: 16 }
    };
    var cfg = cfgMap[flow];
    if (!cfg || !docNo) return createResponse(false, msg_('invalidDocNoFlow'));
    var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sheet = ss.getSheetByName(cfg.sheetName);
    if (!sheet || sheet.getLastRow() < 1) return createResponse(true, 'OK', { history: [] });
    var baseHeaders = workflowBaseHeaders_(cfg.baseWidth);
    if (baseHeaders) standardizeWorkflowSheet_(sheet, baseHeaders);
    if (sheet.getLastRow() <= 1) return createResponse(true, 'OK', { history: [] });
    var typeColIdx = cfg.baseWidth; // 0-based index of Row_Type column
    var rows = sheet.getDataRange().getValues().slice(1);
    var history = rows
      .filter(function(r) {
        return (r[0] || '').toString().trim() === docNo
            && (r[typeColIdx] || '').toString() === 'event';
      })
      .map(function(r) {
        var b = typeColIdx;
        return {
          action:     (r[b + 1] || '').toString(),
          role:       (r[b + 2] || '').toString(),
          actorEmail: (r[b + 3] || '').toString(),
          actorName:  (r[b + 4] || '').toString(),
          prevStatus: (r[b + 5] || '').toString(),
          newStatus:  (r[b + 6] || '').toString(),
          timestamp:  r[b + 7] ? r[b + 7].toString() : '',
          note:       (r[b + 8] || '').toString(),
          metaJson:   (r[b + 9] || '').toString()
        };
      });
    return createResponse(true, 'OK', { history: history });
  } catch (e) {
    Logger.log('[P2P] handleGetP2PHistory error: ' + e.message);
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

// ==================== CONTRACT MODULE ====================

var CT_SHEET_NAME = 'Contract_History';
var CT_AMEND_SHEET = 'Contract_Amendments';

var CT_COL = {
  CONTRACT_NO: 0, PR_NO: 1, VENDOR_NAME: 2, VENDOR_CONTACT: 3,
  CONTRACT_VALUE: 4, START_DATE: 5, END_DATE: 6, PAYMENT_TERMS: 7,
  DOC_URL: 8, STATUS: 9, CREATED_BY: 10, CREATED_AT: 11,
  APPROVED_BY: 12, APPROVED_AT: 13, NOTES: 14, METADATA: 15
};

var CT_AMD_COL = {
  AMENDMENT_NO: 0, CONTRACT_NO: 1, PR_NO: 2, AMENDMENT_TYPE: 3,
  OLD_VALUE: 4, NEW_VALUE: 5, DESCRIPTION: 6, DOC_URL: 7,
  STATUS: 8, REQUESTED_BY: 9, REQUESTED_AT: 10,
  APPROVED_BY: 11, APPROVED_AT: 12, METADATA: 13
};

function getOrCreateContractSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CT_SHEET_NAME);
    sheet.appendRow(CT_HEADERS_);
    sheet.setFrozenRows(1);
  } else {
    standardizeWorkflowSheet_(sheet, CT_HEADERS_);
  }
  return sheet;
}

function getOrCreateContractAmendmentSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(CT_AMEND_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CT_AMEND_SHEET);
    sheet.appendRow(CT_AMEND_HEADERS_);
    sheet.setFrozenRows(1);
  } else {
    applyStandardHeaders_(sheet, CT_AMEND_HEADERS_);
  }
  return sheet;
}

function generateContractNo_() {
  var now = new Date();
  var ds = Utilities.formatDate(now, 'Asia/Ho_Chi_Minh', 'yyyyMMdd');
  return 'CT-' + ds + '-' + Math.floor(Math.random() * 100000).toString().padStart(6, '0');
}

function contractRowToObj_(row) {
  var meta = {};
  try { meta = JSON.parse(row[CT_COL.METADATA] || '{}'); } catch (_) {}
  return {
    contractNo: row[CT_COL.CONTRACT_NO] || '',
    prNo: row[CT_COL.PR_NO] || '',
    vendorName: row[CT_COL.VENDOR_NAME] || '',
    vendorContact: row[CT_COL.VENDOR_CONTACT] || '',
    contractValue: row[CT_COL.CONTRACT_VALUE] || 0,
    startDate: row[CT_COL.START_DATE] || '',
    endDate: row[CT_COL.END_DATE] || '',
    paymentTerms: row[CT_COL.PAYMENT_TERMS] || '',
    docUrl: row[CT_COL.DOC_URL] || '',
    status: row[CT_COL.STATUS] || '',
    createdBy: row[CT_COL.CREATED_BY] || '',
    createdAt: row[CT_COL.CREATED_AT] || '',
    approvedBy: row[CT_COL.APPROVED_BY] || '',
    approvedAt: row[CT_COL.APPROVED_AT] || '',
    notes: row[CT_COL.NOTES] || '',
    metadata: meta
  };
}

function getContractByNo_(contractNo) {
  contractNo = (contractNo || '').toString().trim();
  if (!contractNo) return null;
  var sheet = getOrCreateContractSheet_();
  if (sheet.getLastRow() <= 1) return null;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if ((rows[i][CT_COL.CONTRACT_NO] || '').toString().trim() === contractNo) {
      return contractRowToObj_(rows[i]);
    }
  }
  return null;
}

function getContractsByPR_(prNo) {
  prNo = (prNo || '').toString().trim();
  var out = [];
  var sheet = getOrCreateContractSheet_();
  if (sheet.getLastRow() <= 1) return out;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if ((rows[i][CT_COL.PR_NO] || '').toString().trim() === prNo) {
      out.push(contractRowToObj_(rows[i]));
    }
  }
  return out;
}

function syncPRGrandTotalFromContract_(prNo, contractValue, contractNo, actorEmail) {
  var prInfo = findPRByNo_(prNo);
  if (!prInfo) return;
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(PR_SHEET_NAME);
  var oldTotal = parseFloat(prInfo.row[13]) || 0;
  var newTotal = parseFloat(contractValue) || 0;
  prInfo.metadata.contractNo = contractNo;
  prInfo.metadata.contractValue = newTotal;
  if (!prInfo.metadata.prGrandTotalBefore) prInfo.metadata.prGrandTotalBefore = oldTotal;
  sheet.getRange(prInfo.rowIndex + 1, 14).setValue(newTotal);
  sheet.getRange(prInfo.rowIndex + 1, 17).setValue(JSON.stringify(prInfo.metadata));
  SpreadsheetApp.flush();
  if (Math.abs(oldTotal - newTotal) > 0.01) {
    _appendAuditLog_({
      sheetName: 'PR_Audit_Log', docNo: prNo, flow: 'PR',
      company: (prInfo.row[1] || '').toString(), action: 'ContractApproved_PRUpdated',
      role: 'contract', actorEmail: actorEmail || '', actorName: '',
      prevStatus: (prInfo.row[14] || '').toString(), newStatus: (prInfo.row[14] || '').toString(),
      note: 'Cập nhật giá trị PR theo hợp đồng ' + contractNo,
      extra: { oldTotal: oldTotal, newTotal: newTotal, contractNo: contractNo }
    });
  }
}

function sendContractApprovalRequestEmail_(contractNo, prNo, contractValue, approverEmail, createdBy) {
  if (!approverEmail) return;
  var subject = '[THẨM ĐỊNH HỢP ĐỒNG] ' + contractNo + ' — PR ' + prNo;
  var valueFmt = (parseFloat(contractValue) || 0).toLocaleString('vi-VN') + ' ₫';
  var body = '<p>Kính gửi,</p>'
    + '<p>Có hợp đồng mới cần thẩm định cho <b>PR ' + prNo + '</b>.</p>'
    + '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
    + '<tr><td style="font-weight:700;padding-right:16px;">Số HĐ:</td><td>' + contractNo + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Giá trị:</td><td>' + valueFmt + '</td></tr>'
    + '<tr><td style="font-weight:700;padding-right:16px;">Người tạo:</td><td>' + (createdBy || '—') + '</td></tr>'
    + '</table>'
    + '<p style="margin-top:16px;">Vui lòng đăng nhập hệ thống để phê duyệt hợp đồng.</p>'
    + '<p>Trân trọng,<br>Hệ thống Workflow TLC Group</p>';
  try {
    GmailApp.sendEmail(approverEmail, subject, '', { htmlBody: body, name: 'TLC Group Workflow' });
  } catch (e) {
    Logger.log('[Contract] Email failed: ' + e.message);
  }
}

function handleCreateContract(data) {
  try {
    var prNo = (data.prNo || '').toString().trim();
    var vendorName = (data.vendorName || '').toString().trim();
    var contractValue = parseFloat(data.contractValue) || 0;
    if (!prNo) return createResponse(false, msg_('missingPrNo'));
    if (!vendorName) return createResponse(false, msg_('missingSupplierName'));
    if (contractValue <= 0) return createResponse(false, msg_('contractValuePositive'));

    var prInfo = findPRByNo_(prNo);
    if (!prInfo) return createResponse(false, msg_('prIdNotFoundPrefix') + prNo);
    if ((prInfo.row[14] || '').toString().trim() !== 'Hoàn thành') {
      return createResponse(false, msg_('prNotFullyApproved'));
    }
    if ((prInfo.metadata.p2pBranch || 'full') !== 'full') {
      return createResponse(false, msg_('prSimplifiedNoContract'));
    }

    var existing = getContractsByPR_(prNo).filter(function(c) {
      return c.status === 'Chờ thẩm định' || c.status === 'Đã ký' || c.status === 'Có phụ lục';
    });
    if (existing.length > 0) {
      return createResponse(false, msg_('contractExistsPrefix') + existing[0].contractNo);
    }

    var contractNo = (data.contractNo || '').toString().trim() || generateContractNo_();
    if (getContractByNo_(contractNo)) return createResponse(false, msg_('contractNoExists'));

    var prGrandTotal = parseFloat(prInfo.row[13]) || 0;
    var metadata = {
      prGrandTotalBefore: prGrandTotal,
      autoUpdated: false,
      currentVersion: 1,
      contractApproverEmail: (prInfo.row[17] || '').toString().trim()
    };

    var sheet = getOrCreateContractSheet_();
    var createdAt = new Date().toISOString();
    sheet.appendRow([
      contractNo, prNo, vendorName,
      (data.vendorContact || '').toString().trim(),
      contractValue,
      (data.startDate || '').toString().trim(),
      (data.endDate || '').toString().trim(),
      (data.paymentTerms || '').toString().trim(),
      (data.docUrl || '').toString().trim(),
      'Chờ thẩm định',
      (data.createdBy || '').toString().trim(),
      createdAt, '', '', (data.notes || '').toString().trim(),
      JSON.stringify(metadata)
    ]);
    SpreadsheetApp.flush();

    _appendAuditLog_({
      sheetName: 'Contract_Audit_Log', docNo: contractNo, flow: 'CT',
      company: (prInfo.row[1] || '').toString(), action: 'Submit', role: 'procurement',
      actorEmail: (data.createdByEmail || '').toString(), actorName: (data.createdBy || '').toString(),
      prevStatus: '', newStatus: 'Chờ thẩm định', note: 'PR: ' + prNo,
      extra: { prNo: prNo, contractValue: contractValue }
    });
    try { ensureP2PHistoryColumns_(sheet); appendP2PHistoryRow_(sheet, 16, contractNo, {
      action: 'Submit', role: 'procurement',
      actorEmail: (data.createdByEmail || '').toString(), actorName: (data.createdBy || '').toString(),
      prevStatus: '', newStatus: 'Chờ thẩm định', note: 'PR: ' + prNo
    }); } catch (histErr_) { Logger.log('[CT] history row error: ' + histErr_.message); }

    var approverEmail = (prInfo.row[17] || '').toString().trim();
    try {
      sendContractApprovalRequestEmail_(contractNo, prNo, contractValue, approverEmail, data.createdBy);
    } catch (_) {}

    return createResponse(true, 'Hợp đồng đã được tạo.', { contractNo: contractNo });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleApproveContract(data) {
  try {
    var contractNo = (data.contractNo || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    if (!contractNo) return createResponse(false, msg_('missingContractNo'));
    if (!approverEmail) return createResponse(false, msg_('missingApproverEmail2'));

    var sheet = getOrCreateContractSheet_();
    var rows = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][CT_COL.CONTRACT_NO] || '').toString().trim() === contractNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('contractNotFound'));

    var row = rows[rowIndex];
    var status = (row[CT_COL.STATUS] || '').toString();
    if (status !== 'Chờ thẩm định') {
      return createResponse(false, msg_('contractNotPendingReview'));
    }

    var prNo = (row[CT_COL.PR_NO] || '').toString().trim();
    var prInfo = findPRByNo_(prNo);
    var assigned = prInfo ? (prInfo.row[17] || '').toString().trim().toLowerCase() : '';
    if (assigned && approverEmail !== assigned) {
      return createResponse(false, msg_('notAssignedContractReview'));
    }

    var now = new Date().toISOString();
    sheet.getRange(rowIndex + 1, CT_COL.STATUS + 1).setValue('Đã ký');
    sheet.getRange(rowIndex + 1, CT_COL.APPROVED_BY + 1).setValue(data.approverName || approverEmail);
    sheet.getRange(rowIndex + 1, CT_COL.APPROVED_AT + 1).setValue(now);
    SpreadsheetApp.flush();

    syncPRGrandTotalFromContract_(prNo, row[CT_COL.CONTRACT_VALUE], contractNo, approverEmail);

    _appendAuditLog_({
      sheetName: 'Contract_Audit_Log', docNo: contractNo, flow: 'CT',
      company: (row[CT_COL.VENDOR_NAME] || '').toString(), action: 'Approve', role: 'contract',
      actorEmail: approverEmail, actorName: (data.approverName || '').toString(),
      prevStatus: 'Chờ thẩm định', newStatus: 'Đã ký',
      note: (data.note || '').toString(), extra: { prNo: prNo }
    });
    try { appendP2PHistoryRow_(sheet, 16, contractNo, {
      action: 'Approve', role: 'contract', actorEmail: approverEmail,
      actorName: (data.approverName || '').toString(),
      prevStatus: 'Chờ thẩm định', newStatus: 'Đã ký', note: (data.note || '').toString()
    }); } catch (histErr_) { Logger.log('[CT] history row error: ' + histErr_.message); }

    return createResponse(true, 'Hợp đồng đã được phê duyệt.', { contractNo: contractNo, status: 'Đã ký' });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleRejectContract(data) {
  try {
    var contractNo = (data.contractNo || '').toString().trim();
    var approverEmail = (data.approverEmail || '').toString().trim().toLowerCase();
    if (!contractNo) return createResponse(false, msg_('missingContractNo'));

    var sheet = getOrCreateContractSheet_();
    var rows = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][CT_COL.CONTRACT_NO] || '').toString().trim() === contractNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('contractNotFound'));

    var prevStatus = (rows[rowIndex][CT_COL.STATUS] || '').toString();
    sheet.getRange(rowIndex + 1, CT_COL.STATUS + 1).setValue('Từ chối');
    SpreadsheetApp.flush();

    _appendAuditLog_({
      sheetName: 'Contract_Audit_Log', docNo: contractNo, flow: 'CT',
      company: '', action: 'Reject', role: 'contract',
      actorEmail: approverEmail, actorName: '',
      prevStatus: prevStatus, newStatus: 'Từ chối',
      note: (data.note || '').toString(), extra: {}
    });
    try { appendP2PHistoryRow_(sheet, 16, contractNo, {
      action: 'Reject', role: 'contract', actorEmail: approverEmail,
      prevStatus: prevStatus, newStatus: 'Từ chối', note: (data.note || '').toString()
    }); } catch (histErr_) { Logger.log('[CT] history row error: ' + histErr_.message); }

    return createResponse(true, 'Đã từ chối hợp đồng.', { contractNo: contractNo });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleGetContractDetails(data) {
  try {
    var contractNo = (data.contractNo || '').toString().trim();
    if (!contractNo) return createResponse(false, msg_('missingContractNo'));
    var ct = getContractByNo_(contractNo);
    if (!ct) return createResponse(false, msg_('contractNotFound'));
    var prInfo = findPRByNo_(ct.prNo);
    var approverFromPr = prInfo ? (prInfo.row[17] || '').toString().trim() : '';
    ct.contractApproverEmail = approverFromPr || (ct.metadata && ct.metadata.contractApproverEmail) || '';
    var amendments = getContractAmendments_(contractNo);
    var prNo = ct.prNo;
    var paidTotal = sumPaidPMTsForPR_(prNo);
    return createResponse(true, 'OK', {
      contract: ct,
      amendments: amendments,
      paymentProgress: {
        contractValue: parseFloat(ct.contractValue) || 0,
        paidTotal: paidTotal,
        remaining: Math.max(0, (parseFloat(ct.contractValue) || 0) - paidTotal)
      }
    });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleGetContractsByPR(data) {
  try {
    var prNo = (data.prNo || '').toString().trim();
    if (!prNo) return createResponse(false, msg_('missingPrNo'));
    return createResponse(true, 'OK', { contracts: getContractsByPR_(prNo) });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function getContractAmendments_(contractNo) {
  contractNo = (contractNo || '').toString().trim();
  var out = [];
  var sheet = getOrCreateContractAmendmentSheet_();
  if (sheet.getLastRow() <= 1) return out;
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if ((rows[i][CT_AMD_COL.CONTRACT_NO] || '').toString().trim() !== contractNo) continue;
    out.push({
      amendmentNo: rows[i][CT_AMD_COL.AMENDMENT_NO] || '',
      contractNo: rows[i][CT_AMD_COL.CONTRACT_NO] || '',
      prNo: rows[i][CT_AMD_COL.PR_NO] || '',
      amendmentType: rows[i][CT_AMD_COL.AMENDMENT_TYPE] || '',
      oldValue: rows[i][CT_AMD_COL.OLD_VALUE] || '',
      newValue: rows[i][CT_AMD_COL.NEW_VALUE] || '',
      description: rows[i][CT_AMD_COL.DESCRIPTION] || '',
      docUrl: rows[i][CT_AMD_COL.DOC_URL] || '',
      status: rows[i][CT_AMD_COL.STATUS] || '',
      requestedBy: rows[i][CT_AMD_COL.REQUESTED_BY] || '',
      requestedAt: rows[i][CT_AMD_COL.REQUESTED_AT] || '',
      approvedBy: rows[i][CT_AMD_COL.APPROVED_BY] || '',
      approvedAt: rows[i][CT_AMD_COL.APPROVED_AT] || ''
    });
  }
  return out;
}

function handleGetContractAmendments(data) {
  var contractNo = (data.contractNo || '').toString().trim();
  if (!contractNo) return createResponse(false, msg_('missingContractNo'));
  return createResponse(true, 'OK', { amendments: getContractAmendments_(contractNo) });
}

function handleCreateContractAmendment(data) {
  try {
    var contractNo = (data.contractNo || '').toString().trim();
    if (!contractNo) return createResponse(false, msg_('missingContractNo'));
    var ct = getContractByNo_(contractNo);
    if (!ct) return createResponse(false, msg_('contractNotFound'));
    if (ct.status !== 'Đã ký' && ct.status !== 'Có phụ lục') {
      return createResponse(false, msg_('amendmentOnlySignedContract'));
    }

    var pending = getContractAmendments_(contractNo).filter(function(a) {
      return a.status === 'Chờ thẩm định';
    });
    if (pending.length > 0) {
      return createResponse(false, msg_('amendmentPendingReview'));
    }

    var version = (ct.metadata.currentVersion || 1) + 1;
    var amendNo = contractNo + '-PL-' + version;
    var sheet = getOrCreateContractAmendmentSheet_();
    var now = new Date().toISOString();
    sheet.appendRow([
      amendNo, contractNo, ct.prNo,
      (data.amendmentType || 'Khác').toString(),
      (data.oldValue !== undefined ? data.oldValue : ct.contractValue),
      (data.newValue || '').toString(),
      (data.description || '').toString(),
      (data.docUrl || '').toString(),
      'Chờ thẩm định',
      (data.requestedBy || '').toString(), now, '', '', '{}'
    ]);
    SpreadsheetApp.flush();

    var ctSheet = getOrCreateContractSheet_();
    var rows = ctSheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][CT_COL.CONTRACT_NO] || '').toString().trim() === contractNo) {
        ctSheet.getRange(i + 1, CT_COL.STATUS + 1).setValue('Có phụ lục');
        break;
      }
    }

    var prInfo = findPRByNo_(ct.prNo);
    var approverEmail = prInfo ? (prInfo.row[17] || '').toString().trim() : '';
    try {
      sendContractApprovalRequestEmail_(amendNo, ct.prNo, data.newValue || ct.contractValue, approverEmail, data.requestedBy);
    } catch (_) {}

    return createResponse(true, 'Phụ lục đã được tạo.', { amendmentNo: amendNo });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleApproveContractAmendment(data) {
  try {
    var amendmentNo = (data.amendmentNo || '').toString().trim();
    if (!amendmentNo) return createResponse(false, msg_('missingAmendmentNo'));

    var sheet = getOrCreateContractAmendmentSheet_();
    var rows = sheet.getDataRange().getValues();
    var rowIndex = -1;
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][CT_AMD_COL.AMENDMENT_NO] || '').toString().trim() === amendmentNo) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return createResponse(false, msg_('amendmentNotFound'));

    var row = rows[rowIndex];
    if ((row[CT_AMD_COL.STATUS] || '').toString() !== 'Chờ thẩm định') {
      return createResponse(false, msg_('amendmentNotPendingReview'));
    }

    var contractNo = (row[CT_AMD_COL.CONTRACT_NO] || '').toString().trim();
    var prNo = (row[CT_AMD_COL.PR_NO] || '').toString().trim();
    var amendType = (row[CT_AMD_COL.AMENDMENT_TYPE] || '').toString();
    var newValue = row[CT_AMD_COL.NEW_VALUE];
    var now = new Date().toISOString();

    sheet.getRange(rowIndex + 1, CT_AMD_COL.STATUS + 1).setValue('Đã duyệt');
    sheet.getRange(rowIndex + 1, CT_AMD_COL.APPROVED_BY + 1).setValue(data.approverName || data.approverEmail || '');
    sheet.getRange(rowIndex + 1, CT_AMD_COL.APPROVED_AT + 1).setValue(now);

    var ctSheet = getOrCreateContractSheet_();
    var ctRows = ctSheet.getDataRange().getValues();
    for (var j = 1; j < ctRows.length; j++) {
      if ((ctRows[j][CT_COL.CONTRACT_NO] || '').toString().trim() === contractNo) {
        if (amendType === 'Giá trị' && newValue !== '') {
          ctSheet.getRange(j + 1, CT_COL.CONTRACT_VALUE + 1).setValue(parseFloat(newValue) || 0);
          syncPRGrandTotalFromContract_(prNo, newValue, contractNo, data.approverEmail || '');
        }
        if (amendType === 'Thời gian' && newValue) {
          ctSheet.getRange(j + 1, CT_COL.END_DATE + 1).setValue(newValue);
        }
        ctSheet.getRange(j + 1, CT_COL.STATUS + 1).setValue('Đã ký');
        var meta = {};
        try { meta = JSON.parse(ctRows[j][CT_COL.METADATA] || '{}'); } catch (_) {}
        meta.currentVersion = (meta.currentVersion || 1) + 1;
        ctSheet.getRange(j + 1, CT_COL.METADATA + 1).setValue(JSON.stringify(meta));
        break;
      }
    }
    SpreadsheetApp.flush();

    _appendAuditLog_({
      sheetName: 'Contract_Audit_Log', docNo: contractNo, flow: 'CT',
      company: '', action: 'AmendmentApproved', role: 'contract',
      actorEmail: (data.approverEmail || '').toString(), actorName: '',
      prevStatus: 'Có phụ lục', newStatus: 'Đã ký',
      note: amendmentNo, extra: { amendmentNo: amendmentNo, amendmentType: amendType }
    });
    try {
      var ctHistSheet_ = getOrCreateContractSheet_();
      appendP2PHistoryRow_(ctHistSheet_, 16, contractNo, {
        action: 'AmendmentApproved', role: 'contract',
        actorEmail: (data.approverEmail || '').toString(),
        prevStatus: 'Có phụ lục', newStatus: 'Đã ký',
        note: amendmentNo + ' (' + amendType + ')'
      });
    } catch (histErr_) { Logger.log('[CT] history row error: ' + histErr_.message); }

    return createResponse(true, 'Phụ lục đã được phê duyệt.', { amendmentNo: amendmentNo });
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}

function handleRejectContractAmendment(data) {
  try {
    var amendmentNo = (data.amendmentNo || '').toString().trim();
    if (!amendmentNo) return createResponse(false, msg_('missingAmendmentNo'));

    var sheet = getOrCreateContractAmendmentSheet_();
    var rows = sheet.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if ((rows[i][CT_AMD_COL.AMENDMENT_NO] || '').toString().trim() === amendmentNo) {
        sheet.getRange(i + 1, CT_AMD_COL.STATUS + 1).setValue('Từ chối');
        SpreadsheetApp.flush();
        return createResponse(true, 'Đã từ chối phụ lục.', { amendmentNo: amendmentNo });
      }
    }
    return createResponse(false, msg_('amendmentNotFound'));
  } catch (e) {
    return createResponse(false, msg_('errPrefix') + e.message);
  }
}
