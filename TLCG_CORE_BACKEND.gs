/**
 * TLCG INTRANET BACKEND - COMPLETE CODE
 * Google Apps Script for TLCGroup Intranet Authentication & Voucher System
 * 
 * Hướng dẫn setup:
 * 1. Mở script.google.com
 * 2. Tạo project mới hoặc mở project hiện có
 * 3. Copy toàn bộ code này vào Code.gs
 * 4. Deploy -> New deployment -> Web app
 * 5. Copy Web App URL vào file HTML
 * 
 * Features:
 * - User Authentication (Login)
 * - Send Approval Email
 * - Sync to Google Sheets
 * - Approve/Reject Voucher
 */

// ==================== I18N (server-side messages) ====================

/**
 * Server-side message localisation.
 *
 * API response messages follow the caller's UI language, passed as `lang` on
 * the request payload (i18n.js stamps every JSON/FormData action payload).
 * Falls back to Vietnamese.
 *
 * Outbound EMAIL is intentionally NOT localised this way: emails go to
 * approvers, not the submitter, and the backend has no per-recipient language
 * preference. Email templates stay Vietnamese.
 *
 * Status values, sheet names and column headers are never translated — they are
 * compared against and written into Sheets.
 */
var MSG_ = {
  vi: {
    errGeneric: 'Lỗi: ',
    wrongCurrentPassword: 'Mật khẩu hiện tại không đúng',
    invalidToken: 'Token không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.',
    missingRequired: 'Thiếu thông tin bắt buộc',
    errSendEmail: 'Error sending email: ',
    diagnosticFailedPrefix: 'Diagnostic failed: ',
    invalidActionPrefixCore: 'Invalid action: ',
    testFailedPrefix: 'Test failed: ',
    webAppCtxFailedPrefix: 'Web app execution context test failed: ',
    cannotAccessSpreadsheet: 'Không thể truy cập spreadsheet: ',
    cannotParseBody: 'Could not parse request body. Check logs for details.',
    changePwFieldsRequired: 'Email, current password, and new password are required',
    dataRequired: 'Data is required',
    emailOtpRequired: 'Email và mã OTP là bắt buộc',
    emailRequired: 'Email is required',
    errApproveVoucher: 'Error approving voucher: ',
    errChangePassword: 'Error changing password: ',
    errFetchMasterData: 'Error fetching master data: ',
    errLogin: 'Login error: ',
    errRejectVoucher: 'Error rejecting voucher: ',
    errSendingEmail: 'Error sending email: ',
    errServerCore: 'Server error: ',
    errSyncSheets: 'Error syncing to sheets: ',
    newPwSameAsDefault: 'Mật khẩu mới không được trùng mật khẩu mặc định',
    otpExpired: 'Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới.',
    otpIncorrect: 'Mã OTP không đúng.',
    recipientEmailRequired: 'Recipient email is required',
    rejectReasonRequired: 'Reject reason is required',
    requestorEmailRequired: 'Requestor email is required',
    spreadsheetIdRequired: 'Spreadsheet ID is required',
    tooManyAttempts: 'Quá nhiều lần thử. Vui lòng yêu cầu mã mới.',
    tooManyRequests: 'Quá nhiều yêu cầu. Vui lòng thử lại sau 30 phút.',
    userNotFound: 'User not found',
    voucherDataRequired: 'Voucher data is required',
  },
  en: {
    errGeneric: 'Error: ',
    wrongCurrentPassword: 'Current password is incorrect',
    invalidToken: 'Invalid or expired token. Please try again.',
    missingRequired: 'Missing required information',
    errSendEmail: 'Error sending email: ',
    diagnosticFailedPrefix: 'Diagnostic failed: ',
    invalidActionPrefixCore: 'Invalid action: ',
    testFailedPrefix: 'Test failed: ',
    webAppCtxFailedPrefix: 'Web app execution context test failed: ',
    cannotAccessSpreadsheet: 'Cannot access the spreadsheet: ',
    cannotParseBody: 'Could not parse request body. Check logs for details.',
    changePwFieldsRequired: 'Email, current password, and new password are required',
    dataRequired: 'Data is required',
    emailOtpRequired: 'Email and OTP code are required',
    emailRequired: 'Email is required',
    errApproveVoucher: 'Error approving voucher: ',
    errChangePassword: 'Error changing password: ',
    errFetchMasterData: 'Error fetching master data: ',
    errLogin: 'Login error: ',
    errRejectVoucher: 'Error rejecting voucher: ',
    errSendingEmail: 'Error sending email: ',
    errServerCore: 'Server error: ',
    errSyncSheets: 'Error syncing to sheets: ',
    newPwSameAsDefault: 'The new password must not match the default password',
    otpExpired: 'The OTP code has expired. Please request a new one.',
    otpIncorrect: 'Incorrect OTP code.',
    recipientEmailRequired: 'Recipient email is required',
    rejectReasonRequired: 'Reject reason is required',
    requestorEmailRequired: 'Requestor email is required',
    spreadsheetIdRequired: 'Spreadsheet ID is required',
    tooManyAttempts: 'Too many attempts. Please request a new code.',
    tooManyRequests: 'Too many requests. Please try again in 30 minutes.',
    userNotFound: 'User not found',
    voucherDataRequired: 'Voucher data is required',
  }
};

/** Language for the current request; set by doPost from the payload. */
var REQ_LANG_ = 'vi';

function setReqLang_(lang) {
  REQ_LANG_ = (lang === 'en') ? 'en' : 'vi';
  return REQ_LANG_;
}

/** Localised message with {0}/{1} substitution; unknown keys return the key. */
function msg_(key, a, b) {
  var table = MSG_[REQ_LANG_] || MSG_.vi;
  var text = table[key];
  if (text == null) text = (MSG_.vi[key] != null) ? MSG_.vi[key] : key;
  if (a !== undefined) text = text.replace('{0}', a);
  if (b !== undefined) text = text.replace('{1}', b);
  return text;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

// ⚠️ IMPORTANT: Google Sheet ID for TLCG Master Data (Users)
const USERS_SHEET_ID = '1ujmPbtEdkGLgEshfhvV8gRB6R0GLI31jsZM5rDOJS0g'; // TLCG Master Data
const USERS_SHEET_NAME = 'Master Employee'; // Sheet name: Master Employee
// Alternative: Use gid=2018642708 if sheet name doesn't work

// ============================================================================
// HELPER FUNCTIONS FOR ERROR HANDLING
// ============================================================================

/**
 * Helper function to safely open a spreadsheet with detailed error handling
 * @param {string} spreadsheetId - The ID of the spreadsheet to open
 * @param {string} context - Context description for logging (e.g., "handleLogin")
 * @returns {Spreadsheet} - The spreadsheet object
 * @throws {Error} - Throws detailed error if spreadsheet cannot be opened
 */
function safeOpenSpreadsheet(spreadsheetId, context) {
  try {
    
    Logger.log('[' + context + '] ========================================');
    Logger.log('[' + context + '] safeOpenSpreadsheet called');
    Logger.log('[' + context + '] Spreadsheet ID: ' + spreadsheetId);
    Logger.log('[' + context + '] Context: ' + context);
    Logger.log('[' + context + '] Execution context - SpreadsheetApp type: ' + typeof SpreadsheetApp);
    Logger.log('[' + context + '] Execution context - SpreadsheetApp defined: ' + (typeof SpreadsheetApp !== 'undefined'));
    if (typeof SpreadsheetApp !== 'undefined') {
      Logger.log('[' + context + '] Execution context - openById type: ' + typeof SpreadsheetApp.openById);
      Logger.log('[' + context + '] Execution context - openById is function: ' + (typeof SpreadsheetApp.openById === 'function'));
    }
    Logger.log('[' + context + '] Attempting to open spreadsheet: ' + spreadsheetId);


    // Check if SpreadsheetApp is available
    if (typeof SpreadsheetApp === 'undefined') {
      Logger.log('[' + context + '] ❌ ERROR: SpreadsheetApp is undefined');
      throw new Error('SpreadsheetApp không khả dụng. Script có thể chưa được cấp quyền hoặc đang chạy trong môi trường không hỗ trợ Google Sheets.');
    }

    // Check if openById method exists (authorization check)
    if (typeof SpreadsheetApp.openById !== 'function') {
      Logger.log('[' + context + '] ❌ ERROR: SpreadsheetApp.openById is not a function');
      Logger.log('[' + context + '] Available SpreadsheetApp methods: ' + Object.keys(SpreadsheetApp).join(', '));
      throw new Error('Script chưa được cấp quyền truy cập Google Sheets. SpreadsheetApp.openById không khả dụng.\n\nGiải pháp:\n1. Mở Apps Script editor (script.google.com)\n2. Chạy function testSpreadsheetAccess một lần\n3. Cấp quyền khi được yêu cầu\n4. Deploy lại web app: Deploy > Manage deployments > Edit\n5. Đặt "Execute as: Me (your-email@gmail.com)" và "Who has access: Anyone"\n6. Click "Deploy" và copy URL mới\n\nSpreadsheet ID: ' + spreadsheetId);
    }

    if (!spreadsheetId || spreadsheetId === '') {
      throw new Error('Spreadsheet ID không được định nghĩa hoặc rỗng');
    }


    const ss = SpreadsheetApp.openById(spreadsheetId);
    
    
    Logger.log('[' + context + '] ✅ Successfully opened spreadsheet');
    return ss;

  } catch (error) {
    
    Logger.log('[' + context + '] ❌ ERROR opening spreadsheet: ' + error.toString());
    Logger.log('[' + context + '] Error details: ' + error.message);

    // Provide specific, actionable error messages
    // Check for the specific "Unexpected error while getting the method or property openById" error
    if (error.message.includes('openById') || error.message.includes('Unexpected error') || 
        error.toString().includes('openById') || error.toString().includes('Unexpected error')) {
      const friendlyMessage = 'Script chưa được cấp quyền truy cập Google Sheets.\n\nGiải pháp:\n1. Mở Apps Script editor (script.google.com)\n2. Chạy function testSpreadsheetAccess một lần\n3. Cấp quyền khi được yêu cầu\n4. Deploy lại web app: Deploy > Manage deployments > Edit\n5. Đặt "Execute as: Me" và "Who has access: Anyone"\n6. Click "Deploy" và copy URL mới\n\nSpreadsheet ID: ' + spreadsheetId;
      Logger.log('[' + context + '] Transforming openById error to friendly message');
      throw new Error(friendlyMessage);
    } else if (error.message.includes('not found') || error.message.includes('does not exist')) {
      throw new Error('Không tìm thấy spreadsheet với ID: ' + spreadsheetId + '\n\nVui lòng kiểm tra:\n1. Spreadsheet có tồn tại không?\n2. ID có chính xác không?\n3. URL spreadsheet: https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/edit');
    } else if (error.message.includes('permission') || error.message.includes('access') || error.message.includes('Authorization')) {
      throw new Error('Không có quyền truy cập spreadsheet.\n\nGiải pháp:\n1. Share spreadsheet với email account đang chạy script\n2. Hoặc đặt spreadsheet thành "Anyone with link can view/edit"\n3. Kiểm tra lại quyền trong spreadsheet settings\n\nSpreadsheet ID: ' + spreadsheetId);
    }

    throw new Error('Lỗi mở spreadsheet: ' + error.message + '\nSpreadsheet ID: ' + spreadsheetId);
  }
}

/**
 * Helper function to safely get a sheet by name with error handling
 * @param {Spreadsheet} spreadsheet - The spreadsheet object
 * @param {string} sheetName - Name of the sheet to get
 * @param {string} context - Context for logging
 * @returns {Sheet} - The sheet object
 * @throws {Error} - Throws error if sheet not found
 */
function safeGetSheet(spreadsheet, sheetName, context) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    const availableSheets = spreadsheet.getSheets().map(function(s) { return s.getName(); }).join(', ');
    Logger.log('[' + context + '] ❌ Sheet "' + sheetName + '" not found');
    Logger.log('[' + context + '] Available sheets: ' + availableSheets);
    throw new Error('Không tìm thấy sheet "' + sheetName + '" trong spreadsheet.\n\nCác sheet có sẵn: ' + availableSheets + '\n\nVui lòng kiểm tra tên sheet có chính xác không.');
  }
  Logger.log('[' + context + '] ✅ Successfully got sheet: ' + sheetName);
  return sheet;
}

// ============================================================================
// MAIN REQUEST HANDLERS
// ============================================================================

/**
 * Hàm xử lý POST request từ web app
 */
function doPost(e) {
  try {
    
    Logger.log('========================================');
    Logger.log('=== doPost called ===');
    Logger.log('========================================');
    Logger.log('Execution context check - SpreadsheetApp available: ' + (typeof SpreadsheetApp !== 'undefined'));
    Logger.log('Execution context check - openById available: ' + (typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.openById === 'function'));
    if (typeof SpreadsheetApp !== 'undefined') {
      Logger.log('Execution context - SpreadsheetApp type: ' + typeof SpreadsheetApp);
      Logger.log('Execution context - openById type: ' + typeof SpreadsheetApp.openById);
    }
    Logger.log('e.postData: ' + JSON.stringify(e.postData));
    Logger.log('e.parameter: ' + JSON.stringify(e.parameter));
    Logger.log('e object keys: ' + Object.keys(e || {}).join(', '));
    
    // Enable CORS
    const output = ContentService.createTextOutput();
    
    // Parse request body - try multiple methods
    let requestBody;
    
    // Method 1: Try e.postData.contents (standard POST)
    if (e.postData && e.postData.contents) {
      try {
        requestBody = JSON.parse(e.postData.contents);
        Logger.log('Parsed from e.postData.contents');
      } catch (parseError) {
        Logger.log('Error parsing e.postData.contents: ' + parseError.toString());
      }
    }
    
    // Method 2: Try e.parameter (form data or query string)
    if (!requestBody && e.parameter) {
      try {
        // Check if it's form data (from FormData) - this avoids CORS preflight
        if (e.parameter.action) {
          // Form data format — copy all parameters so any action can access its fields
          requestBody = Object.assign({}, e.parameter);
          Logger.log('Parsed from e.parameter (form data)');
          Logger.log('Form data - action: ' + requestBody.action + ', email: ' + requestBody.email);
        } else {
          // If data is in parameter, it might be a string
          const dataParam = e.parameter.data || e.parameter.body;
          if (dataParam) {
            requestBody = typeof dataParam === 'string' ? JSON.parse(dataParam) : dataParam;
            Logger.log('Parsed from e.parameter');
          }
        }
      } catch (parseError) {
        Logger.log('Error parsing e.parameter: ' + parseError.toString());
      }
    }
    
    // Method 3: Try direct e.postData (if it's already an object)
    if (!requestBody && e.postData) {
      try {
        if (typeof e.postData === 'object' && !e.postData.contents) {
          requestBody = e.postData;
          Logger.log('Using e.postData directly');
        }
      } catch (error) {
        Logger.log('Error using e.postData directly: ' + error.toString());
      }
    }
    
    if (!requestBody) {
      Logger.log('Error: Could not parse request body');
      Logger.log('e object keys: ' + Object.keys(e).join(', '));
      return createResponse(false, msg_('cannotParseBody'));
    }
    
    Logger.log('========================================');
    Logger.log('✅ Request body parsed successfully');
    Logger.log('========================================');
    Logger.log('Request body: ' + JSON.stringify(requestBody));
    Logger.log('Request body type: ' + typeof requestBody);
    Logger.log('Request body keys: ' + Object.keys(requestBody || {}).join(', '));
    if (requestBody.action) {
      Logger.log('Action found: ' + requestBody.action);
    }
    if (requestBody.email) {
      Logger.log('Email found: ' + requestBody.email);
    }
    if (requestBody.password) {
      Logger.log('Password found: ' + (requestBody.password ? '***' : 'NULL'));
    }
    
    const action = requestBody.action;

    // Response messages follow the caller's UI language (emails do not).
    setReqLang_(requestBody.lang);

    let result;

    Logger.log('Routing to handler for action: ' + action);
    
    switch (action) {
      case 'login':
        Logger.log('========================================');
        Logger.log('Calling handleLogin from doPost');
        Logger.log('Request body being passed: ' + JSON.stringify(requestBody));
        Logger.log('========================================');
        result = handleLogin(requestBody);
        Logger.log('handleLogin returned, result type: ' + typeof result);
        break;
      
      case 'sendApprovalEmail':
        result = handleSendEmail(requestBody);
        break;
      
      case 'syncToSheets':
        result = handleSyncToSheets(requestBody);
        break;
      
      case 'rejectVoucher':
        result = handleRejectVoucher(requestBody);
        break;
      
      case 'approveVoucher':
        result = handleApproveVoucher(requestBody);
        break;
      
      case 'getMasterData':
        result = handleGetMasterData(requestBody);
        break;

      case 'changePassword':
        result = handleChangePassword(requestBody);
        break;

      case 'requestPasswordReset':
        result = handleRequestPasswordReset(requestBody);
        break;

      case 'verifyOTP':
        result = handleVerifyOTP(requestBody);
        break;

      case 'resetPassword':
        result = handleResetPassword(requestBody);
        break;
      
      case 'diagnose':
        // Diagnostic endpoint - returns diagnostic information
        try {
          Logger.log('=== DIAGNOSE ACTION CALLED VIA WEB APP ===');
          Logger.log('This tests execution context in web app deployment');
          const diagnosticResult = diagnoseSpreadsheetAccess();
          result = createResponse(diagnosticResult.success, diagnosticResult.error || diagnosticResult.message, diagnosticResult);
        } catch (diagError) {
          Logger.log('Diagnostic failed: ' + diagError.message);
          result = createResponse(false, msg_('diagnosticFailedPrefix') + diagError.message);
        }
        break;
      
      case 'testLoginContext':
        // Test login execution context - simulates login without actual authentication
        try {
          Logger.log('=== TEST LOGIN CONTEXT VIA WEB APP ===');
          Logger.log('Testing execution context for login flow');
          
          // Check execution context
          const contextInfo = {
            spreadSheetAppDefined: typeof SpreadsheetApp !== 'undefined',
            openByIdExists: typeof SpreadsheetApp !== 'undefined' && typeof SpreadsheetApp.openById === 'function',
            spreadSheetAppType: typeof SpreadsheetApp,
            openByIdType: typeof SpreadsheetApp !== 'undefined' ? typeof SpreadsheetApp.openById : 'N/A'
          };
          
          Logger.log('Execution context: ' + JSON.stringify(contextInfo));
          
          // Try to open spreadsheet (this is where the error occurs)
          try {
            const testSS = SpreadsheetApp.openById(USERS_SHEET_ID);
            Logger.log('✅ Spreadsheet opened successfully in web app context!');
            Logger.log('Spreadsheet name: ' + testSS.getName());
            
            result = createResponse(true, 'Web app execution context test passed', {
              context: contextInfo,
              spreadsheetName: testSS.getName(),
              message: 'Spreadsheet access works in web app deployment'
            });
          } catch (openError) {
            Logger.log('❌ Failed to open spreadsheet in web app context');
            Logger.log('Error: ' + openError.message);
            Logger.log('Error toString: ' + openError.toString());
            
            result = createResponse(false, msg_('webAppCtxFailedPrefix') + openError.message, {
              context: contextInfo,
              error: {
                message: openError.message,
                toString: openError.toString(),
                name: openError.name
              }
            });
          }
        } catch (testError) {
          Logger.log('Test login context failed: ' + testError.message);
          result = createResponse(false, msg_('testFailedPrefix') + testError.message);
        }
        break;
      
      default:
        result = createResponse(false, msg_('invalidActionPrefixCore') + action);
    }
    
    // Set CORS headers
    output.setMimeType(ContentService.MimeType.JSON);
    return result;
  } catch (error) {
    Logger.log('========================================');
    Logger.log('❌ ERROR IN doPost ❌');
    Logger.log('========================================');
    Logger.log('Error name: ' + error.name);
    Logger.log('Error message: ' + error.message);
    Logger.log('Error toString: ' + error.toString());
    if (error.stack) {
      Logger.log('Error stack: ' + error.stack);
    }
    Logger.log('Full error object keys: ' + Object.keys(error).join(', '));
    
    // Check if it's the openById error
    if (error.message && (error.message.includes('openById') || error.message.includes('Unexpected error'))) {
      Logger.log('\n⚠️ DETECTED: openById authorization error');
      Logger.log('Solution: Run diagnoseSpreadsheetAccess() or testSpreadsheetAccess() function');
      Logger.log('Then re-deploy with "Execute as: Me"');
    }
    
    return createResponse(false, msg_('errServerCore') + error.message + (error.stack ? '\nStack: ' + error.stack.substring(0, 200) : ''));
  }
}

/**
 * Hàm xử lý GET request (fallback cho approve/reject)
 */
function doGet(e) {
  try {
    Logger.log('=== doGet called ===');
    Logger.log('Full e object: ' + JSON.stringify(e));
    Logger.log('e.parameter: ' + JSON.stringify(e.parameter));
    Logger.log('e.parameter keys: ' + Object.keys(e.parameter || {}).join(', '));
    
    const action = e.parameter ? e.parameter.action : null;
    Logger.log('Action: ' + action);
    
    if (action === 'approveVoucher' || action === 'rejectVoucher') {
      // Parse data from query parameters
      let requestBody = {
        action: action,
        voucher: {}
      };
      
      if (e.parameter && e.parameter.voucherNumber) {
        requestBody.voucher.voucherNumber = e.parameter.voucherNumber || '';
        requestBody.voucher.voucherType = e.parameter.voucherType || '';
        requestBody.voucher.company = e.parameter.company || '';
        requestBody.voucher.employee = e.parameter.employee || '';
        requestBody.voucher.amount = e.parameter.amount || '';
        requestBody.voucher.requestorEmail = e.parameter.requestorEmail || '';
        requestBody.voucher.approverEmail = e.parameter.approverEmail || '';
        requestBody.voucher.approvedBy = e.parameter.approvedBy || e.parameter.approverEmail || '';
        requestBody.voucher.rejectReason = e.parameter.rejectReason || '';
        requestBody.voucher.rejectedBy = e.parameter.rejectedBy || e.parameter.approverEmail || '';
        
        Logger.log('Parsed requestorEmail: ' + requestBody.voucher.requestorEmail);
        Logger.log('Parsed approverEmail: ' + requestBody.voucher.approverEmail);
      } else {
        Logger.log('⚠️ WARNING: e.parameter.voucherNumber is missing!');
        Logger.log('Available parameters: ' + JSON.stringify(e.parameter));
      }
      
      Logger.log('Request body from GET: ' + JSON.stringify(requestBody));
      
      if (action === 'approveVoucher') {
        Logger.log('Calling handleApproveVoucher...');
        return handleApproveVoucher(requestBody);
      } else if (action === 'rejectVoucher') {
        Logger.log('Calling handleRejectVoucher...');
        return handleRejectVoucher(requestBody);
      }
    } else {
      Logger.log('Action is not approveVoucher or rejectVoucher, returning default message');
    }
    
    return ContentService.createTextOutput('Google Apps Script is running!')
      .setMimeType(ContentService.MimeType.TEXT);
  } catch (error) {
    Logger.log('Error in doGet: ' + error.toString());
    return ContentService.createTextOutput('Error: ' + error.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

// ============================================================================
// AUTHENTICATION FUNCTIONS
// ============================================================================

/**
 * Authenticate user with email and password
 */
function authenticateUser(email, password) {
  try {
    
    Logger.log('=== AUTHENTICATE USER ===');
    Logger.log('Email: ' + email);
    Logger.log('USERS_SHEET_ID: ' + USERS_SHEET_ID);
    Logger.log('USERS_SHEET_NAME: ' + USERS_SHEET_NAME);

    // Open the users spreadsheet with error handling
    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'authenticateUser');

    // Try to get sheet by name first
    let sheet;
    try {
      sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'authenticateUser');
    } catch (sheetError) {
      // If sheet name not found, try using first sheet as fallback
      Logger.log('Sheet name not found, trying first sheet as fallback');
      const sheets = spreadsheet.getSheets();
      if (sheets && sheets.length > 0) {
        sheet = sheets[0];
        Logger.log('Using first sheet: ' + sheet.getName());
      } else {
        throw new Error('Không tìm thấy sheet nào trong spreadsheet');
      }
    }
    
    const data = sheet.getDataRange().getValues();
    if (data.length < 2) {
      Logger.log('No users found in sheet');
      return { success: false, message: 'No users configured' };
    }
    
    // Map columns based on actual sheet structure from Google Sheet:
    // A: Họ và tên (Name)
    // B: Chức vụ (Position/Role)
    // C: Phòng ban (Department) - Note: Some rows have Company here
    // D: Công ty (Company)
    // E: Email - USED FOR AUTHENTICATION (find user by email)
    // F: Điện thoại (Phone)
    // G: Status - USED FOR AUTHENTICATION (must be "Active")
    // H: EmployeeId
    // I: Role
    // J: isAdmin
    // K: Login_password - NOT USED FOR AUTHENTICATION (contains display names like "Manager 1")
    // L: Password - SHA-256 hash - USED FOR AUTHENTICATION (compare hashed password)
    
    const headers = data[0];
    
    // Debug: Log all headers
    Logger.log('Sheet headers: ' + JSON.stringify(headers));
    Logger.log('Total columns: ' + headers.length);
    
    // Find columns by header name (supports both English snake_case and Vietnamese)
    const h = headers;
    const findCol = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };

    const emailCol      = findCol('employee_email', 'Email', 'email') !== -1 ? findCol('employee_email', 'Email', 'email') : 4;
    const nameCol       = findCol('full_name', 'Họ và tên', 'name') !== -1 ? findCol('full_name', 'Họ và tên', 'name') : 0;
    const roleCol       = findCol('position', 'Chức vụ', 'Role', 'role', 'employee_role') !== -1 ? findCol('position', 'Chức vụ', 'Role', 'role', 'employee_role') : 1;
    const isAdminCol    = findCol('isAdmin', 'IsAdmin') !== -1 ? findCol('isAdmin', 'IsAdmin') : 9;
    const employeeIdCol = findCol('employee_id', 'EmployeeId', 'employeeId', 'Employee ID', 'Mã nhân viên') !== -1 ? findCol('employee_id', 'EmployeeId', 'employeeId', 'Employee ID', 'Mã nhân viên') : 7;
    const departmentCol = findCol('department_name', 'Phòng ban', 'department') !== -1 ? findCol('department_name', 'Phòng ban', 'department') : 2;
    const companyCol    = findCol('company_name', 'Công ty', 'company') !== -1 ? findCol('company_name', 'Công ty', 'company') : 3;
    const phoneCol      = findCol('employee_phone', 'Điện thoại', 'phone') !== -1 ? findCol('employee_phone', 'Điện thoại', 'phone') : 5;
    const statusCol     = findCol('employee_status', 'Status', 'status') !== -1 ? findCol('employee_status', 'Status', 'status') : 6;
    const passwordCol   = 11; // Column L — always fixed
    const mustChangeCol = findCol('mustChangePassword');

    Logger.log('Column mapping:');
    Logger.log('Email: ' + emailCol + ' (header: ' + (headers[emailCol] || 'N/A') + ')');
    Logger.log('Password: ' + passwordCol + ' (header: ' + (headers[passwordCol] || 'N/A') + ')');
    Logger.log('Name: ' + nameCol + ', Role: ' + roleCol + ', isAdmin: ' + isAdminCol + ', Status: ' + statusCol);
    Logger.log('mustChangePassword column: ' + mustChangeCol);

    // Validate required columns exist
    if (emailCol === -1) {
      Logger.log('ERROR: Email column not found');
      return { success: false, message: 'Database configuration error: Email column not found' };
    }
    
    // Validate password input
    if (!password || password === null || password === undefined || password.toString().trim() === '') {
      Logger.log('ERROR: Password is null, undefined, or empty');
      return { success: false, message: 'Password is required' };
    }

    // Frontend sends plain text — backend hashes for comparison
    const submittedPassword = password.toString().trim();
    Logger.log('Password received (plain text over HTTPS)');
    
    // Search for user
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowEmail = row[emailCol];
      
      // Skip empty rows
      if (!rowEmail || rowEmail.toString().trim() === '') {
        continue;
      }
      
      const rowPassword = passwordCol >= 0 ? row[passwordCol] : '';
      const rowStatus = statusCol >= 0 ? row[statusCol] : 'Active';
      
      // Check email match (case insensitive)
      if (rowEmail.toString().toLowerCase().trim() === email.toLowerCase().trim()) {
        Logger.log('Found user: ' + rowEmail);
        Logger.log('Row password (raw): ' + (rowPassword ? rowPassword.toString().substring(0, 20) + '...' : 'EMPTY'));
        Logger.log('Submitted password received (plain text over HTTPS)');
        
        // Check status
        if (rowStatus && rowStatus.toString().toLowerCase() !== 'active') {
          Logger.log('User account is inactive. Status: ' + rowStatus);
          return { success: false, message: 'Account is inactive' };
        }
        
        const colKPassword = (row[10] || '').toString().trim(); // Column K — default plain text
        const storedHash   = (rowPassword || '').toString().trim(); // Column L — SHA-256 hash

        if (!storedHash) {
          // Column L empty — check Column K default password
          if (!colKPassword) {
            Logger.log('No password set — mustChangePassword');
          } else if (submittedPassword !== colKPassword) {
            Logger.log('Column K password mismatch');
            return { success: false, message: 'Invalid email or password' };
          } else {
            Logger.log('Column K matched — mustChangePassword');
          }
          // Return full user data so profile page is populated correctly
          return { success: true, data: buildUserData(row, email, nameCol, roleCol, isAdminCol, employeeIdCol, departmentCol, companyCol, phoneCol, mustChangeCol, true) };
        }

        // Column L has hash — normal login
        const hashedSubmitted = hashPassword(submittedPassword);
        Logger.log('Comparing hashes...');
        if (hashedSubmitted === storedHash) {
          Logger.log('Password match! Authentication successful');
          return {
            success: true,
            user: buildUserData(row, rowEmail.toString().trim(), nameCol, roleCol, isAdminCol, employeeIdCol, departmentCol, companyCol, phoneCol, mustChangeCol, false)
          };
        } else {
          Logger.log('Password mismatch');
          return { success: false, message: 'Invalid email or password' };
        }

      }
    }
    
    Logger.log('User not found: ' + email);
    return { success: false, message: 'Invalid email or password' };
    
  } catch (error) {
    Logger.log('Authentication error: ' + error.toString());
    Logger.log('Error stack: ' + error.stack);
    
    // Check if this is the openById authorization error and preserve the friendly message
    if (error.message && (error.message.includes('Script chưa được cấp quyền') || 
        error.message.includes('openById') || error.message.includes('Unexpected error'))) {
      // Return the friendly error message directly (already transformed by safeOpenSpreadsheet)
      return { success: false, message: error.message };
    }
    
    // For other errors, return with prefix
    return { success: false, message: 'Authentication error: ' + error.message };
  }
}

/**
 * Hash password using SHA-256
 * Note: For production, consider using bcrypt or Argon2
 */
function hashPassword(password) {
  try {
    // Validate input
    if (!password || password === null || password === undefined) {
      Logger.log('Hash error: Password is null or undefined');
      throw new Error('Password cannot be null or undefined');
    }
    
    // Convert to string if not already
    const passwordString = password.toString().trim();
    
    if (passwordString === '') {
      Logger.log('Hash error: Password is empty');
      throw new Error('Password cannot be empty');
    }
    
    Logger.log('Hashing password (length: ' + passwordString.length + ')');
    
    const rawHash = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      passwordString,
      Utilities.Charset.UTF_8
    );
    
    // Convert to hex string
    const hashString = rawHash.map(function(byte) {
      return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('');
    
    Logger.log('Hash generated successfully (length: ' + hashString.length + ')');
    return hashString;
  } catch (error) {
    Logger.log('Hash error: ' + error.toString());
    Logger.log('Error stack: ' + error.stack);
    throw error; // Re-throw to see the actual error
  }
}

/**
 * Build full user data object from a sheet row — used by authenticateUser
 */
function buildUserData(row, email, nameCol, roleCol, isAdminCol, employeeIdCol, departmentCol, companyCol, phoneCol, mustChangeCol, mustChangePassword) {
  const userName = nameCol >= 0 && row[nameCol] ? row[nameCol].toString().trim() : 'User';
  const userRole = roleCol >= 0 && row[roleCol] ? row[roleCol].toString().trim() : 'User';

  let userEmployeeId = '';
  if (employeeIdCol >= 0 && employeeIdCol < row.length && row[employeeIdCol] !== null && row[employeeIdCol] !== '') {
    userEmployeeId = row[employeeIdCol].toString().trim();
  }

  const userDepartment = departmentCol >= 0 && row[departmentCol] ? row[departmentCol].toString().trim() : '';
  const userCompany    = (companyCol >= 0 && row[companyCol]) ? row[companyCol].toString().trim() : (row[3] ? row[3].toString().trim() : '');
  const userPhone      = phoneCol >= 0 && row[phoneCol] ? row[phoneCol].toString().trim() : '';
  const userIsAdmin    = isAdminCol >= 0 ? (row[isAdminCol] === true || row[isAdminCol] === 'TRUE' || row[isAdminCol] === 'true' || row[isAdminCol] === 'True') : false;
  const mustChange     = mustChangePassword || (mustChangeCol >= 0 && (row[mustChangeCol] === true || row[mustChangeCol] === 'TRUE' || row[mustChangeCol] === 'true'));

  return {
    email:             email,
    name:              userName,
    role:              userRole,
    isAdmin:           userIsAdmin,
    employeeId:        userEmployeeId,
    department:        userDepartment,
    company:           userCompany,
    phone:             userPhone,
    mustChangePassword: mustChange
  };
}

/**
 * Validate password against security rules
 */
function validatePasswordRules(password) {
  if (!password || password.length < 8)
    return { valid: false, message: 'Mật khẩu phải có ít nhất 8 ký tự' };
  if (!/[A-Z]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 chữ hoa' };
  if (!/[0-9]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 số' };
  if (!/[!@#$%^&*()_+\-=\[\]{};\':"\\|,.<>\/?]/.test(password))
    return { valid: false, message: 'Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$%^&*)' };
  return { valid: true };
}

/**
 * Generate a random 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Request password reset — send OTP to user email
 */
function handleRequestPasswordReset(requestBody) {
  try {
    const email = (requestBody.email || '').toString().trim().toLowerCase();
    if (!email) return createResponse(false, msg_('emailRequired'));

    // Always return same message to prevent user enumeration
    const genericMsg = 'Nếu email tồn tại trong hệ thống, mã OTP đã được gửi.';

    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'handleRequestPasswordReset');
    const sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'handleRequestPasswordReset');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const findCol2 = (...names) => { for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; } return -1; };
    const emailCol  = findCol2('employee_email', 'Email', 'email') !== -1 ? findCol2('employee_email', 'Email', 'email') : 4;
    const statusCol = findCol2('employee_status', 'Status', 'status') !== -1 ? findCol2('employee_status', 'Status', 'status') : 6;
    const nameCol   = findCol2('full_name', 'Họ và tên', 'name') !== -1 ? findCol2('full_name', 'Họ và tên', 'name') : 0;

    let userEmail = null;
    let userName = '';
    for (let i = 1; i < data.length; i++) {
      const rowEmail = (data[i][emailCol] || '').toString().trim().toLowerCase();
      const rowStatus = (data[i][statusCol] || '').toString().toLowerCase();
      if (rowEmail === email && rowStatus === 'active') {
        userEmail = data[i][emailCol].toString().trim();
        userName  = (data[i][nameCol] || '').toString().trim();
        break;
      }
    }

    if (!userEmail) {
      Logger.log('❌ Password reset — email not found or inactive: ' + email);
      Logger.log('Total rows searched: ' + (data.length - 1));
      Logger.log('Email col used: ' + emailCol + ', Status col used: ' + statusCol);
      return createResponse(true, genericMsg); // Don't reveal email not found
    }
    Logger.log('✅ User found for OTP: ' + userEmail);

    // Check rate limit — max 3 OTP requests per 30 min
    const cache = CacheService.getScriptCache();
    const rateLimitKey = 'otp_rate_' + email;
    const attempts = parseInt(cache.get(rateLimitKey) || '0');
    if (attempts >= 3) {
      Logger.log('OTP rate limit hit for: ' + email);
      return createResponse(false, msg_('tooManyRequests'));
    }

    // Generate OTP and store with 10 min expiry
    const otp = generateOTP();
    cache.put('otp_' + email, otp, 600); // 10 minutes
    cache.put('otp_attempts_' + email, '0', 600);
    cache.put(rateLimitKey, (attempts + 1).toString(), 1800); // 30 min window

    // Send OTP email
    const subject = '[TLCGroup] Mã xác nhận đặt lại mật khẩu';
    const body = `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <div style="background: #007AFF; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin:0;">🔐 Đặt lại mật khẩu</h2>
        </div>
        <div style="background: white; padding: 24px; border: 1px solid #eee; border-top: none; border-radius: 0 0 8px 8px;">
          <p>Xin chào <b>${userName}</b>,</p>
          <p>Mã OTP của bạn là:</p>
          <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; text-align: center; color: #007AFF; background: #F2F2F7; padding: 16px; border-radius: 8px; margin: 16px 0;">
            ${otp}
          </div>
          <p style="color: #666; font-size: 13px;">Mã có hiệu lực trong <b>10 phút</b>. Không chia sẻ mã này với ai.</p>
          <p style="color: #666; font-size: 13px;">Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.</p>
        </div>
      </div>`;

    MailApp.sendEmail({ to: userEmail, subject: subject, htmlBody: body });
    Logger.log('OTP sent to: ' + userEmail);
    return createResponse(true, genericMsg);
  } catch (error) {
    Logger.log('Error in handleRequestPasswordReset: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

/**
 * Verify OTP — return a one-time reset token on success
 */
function handleVerifyOTP(requestBody) {
  try {
    const email = (requestBody.email || '').toString().trim().toLowerCase();
    const otp   = (requestBody.otp   || '').toString().trim();
    if (!email || !otp) return createResponse(false, msg_('emailOtpRequired'));

    const cache = CacheService.getScriptCache();

    // Check OTP attempt rate
    const attemptsKey = 'otp_attempts_' + email;
    const attempts = parseInt(cache.get(attemptsKey) || '0');
    if (attempts >= 3) {
      return createResponse(false, msg_('tooManyAttempts'));
    }

    const storedOTP = cache.get('otp_' + email);
    if (!storedOTP) {
      return createResponse(false, msg_('otpExpired'));
    }
    if (otp !== storedOTP) {
      cache.put(attemptsKey, (attempts + 1).toString(), 600);
      Logger.log('OTP mismatch for: ' + email);
      return createResponse(false, msg_('otpIncorrect'));
    }

    // OTP valid — generate one-time reset token (valid 5 min), invalidate OTP
    const resetToken = Utilities.getUuid().replace(/-/g, '');
    cache.put('reset_token_' + email, resetToken, 300); // 5 minutes
    cache.remove('otp_' + email);
    cache.remove(attemptsKey);

    Logger.log('OTP verified for: ' + email);
    return createResponse(true, 'OTP hợp lệ', { resetToken: resetToken });
  } catch (error) {
    Logger.log('Error in handleVerifyOTP: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

/**
 * Reset password using one-time token
 */
function handleResetPassword(requestBody) {
  try {
    const email      = (requestBody.email      || '').toString().trim().toLowerCase();
    const resetToken = (requestBody.resetToken || '').toString().trim();
    const newPassword = (requestBody.newPassword || '').toString();
    if (!email || !resetToken || !newPassword) return createResponse(false, msg_('missingRequired'));

    // Validate password rules
    const pwValidation = validatePasswordRules(newPassword);
    if (!pwValidation.valid) return createResponse(false, pwValidation.message);

    // Verify reset token
    const cache = CacheService.getScriptCache();
    const storedToken = cache.get('reset_token_' + email);
    if (!storedToken || storedToken !== resetToken) {
      return createResponse(false, msg_('invalidToken'));
    }

    // Update password in sheet
    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'handleResetPassword');
    const sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'handleResetPassword');
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    let emailCol = headers.indexOf('Email');
    if (emailCol === -1) emailCol = 4;
    const colK = 10;
    const colL = 11;
    // Use same fallback as handleChangePassword — if no named column, write to column M (index 12)
    let mustChangeCol = headers.indexOf('mustChangePassword');
    if (mustChangeCol === -1) mustChangeCol = 12;

    for (let i = 1; i < data.length; i++) {
      if ((data[i][emailCol] || '').toString().trim().toLowerCase() === email) {
        sheet.getRange(i + 1, colL + 1).setValue(hashPassword(newPassword));
        sheet.getRange(i + 1, colK + 1).setValue('');
        sheet.getRange(i + 1, mustChangeCol + 1).setValue(false); // always clear the flag
        cache.remove('reset_token_' + email);
        Logger.log('Password reset successfully for: ' + email);
        return createResponse(true, 'Đặt lại mật khẩu thành công');
      }
    }
    return createResponse(false, msg_('userNotFound'));
  } catch (error) {
    Logger.log('Error in handleResetPassword: ' + error.toString());
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

/**
 * Handle login request from frontend
 */
function handleLogin(requestBody) {
  try {
    
    Logger.log('=== HANDLE LOGIN ===');
    Logger.log('Request body: ' + JSON.stringify(requestBody));
    Logger.log('Request body type: ' + typeof requestBody);
    Logger.log('Request body keys: ' + Object.keys(requestBody || {}).join(', '));
    
    const email = requestBody.email;
    const password = requestBody.password;
    
    Logger.log('Email: ' + email + ' (type: ' + typeof email + ')');
    Logger.log('Password: ' + (password ? '***' : 'NULL/UNDEFINED') + ' (type: ' + typeof password + ')');
    
    if (!email || email === null || email === undefined || email.toString().trim() === '') {
      Logger.log('ERROR: Email is missing, null, or empty');
      return createResponse(false, msg_('emailRequired'));
    }
    
    if (!password || password === null || password === undefined || password.toString().trim() === '') {
      Logger.log('ERROR: Password is missing, null, or empty');
      return createResponse(false, 'Password is required');
    }
    
    // Authenticate user
    const authResult = authenticateUser(email, password);
    
    if (authResult.success) {
      Logger.log('Login successful for: ' + email);
      return createResponse(true, 'Login successful', authResult.user || authResult.data);
    } else {
      Logger.log('Login failed: ' + authResult.message);
      return createResponse(false, authResult.message || 'Invalid credentials');
    }
  } catch (error) {
    Logger.log('========================================');
    Logger.log('❌ ERROR IN handleLogin ❌');
    Logger.log('========================================');
    Logger.log('Error name: ' + error.name);
    Logger.log('Error message: ' + error.message);
    Logger.log('Error toString: ' + error.toString());
    if (error.stack) {
      Logger.log('Error stack: ' + error.stack);
    }
    Logger.log('Error object keys: ' + Object.keys(error).join(', '));
    
    // Check if this is the openById authorization error and preserve the friendly message
    if (error.message && (error.message.includes('Script chưa được cấp quyền') || 
        error.message.includes('openById') || error.message.includes('Unexpected error') ||
        error.toString().includes('openById') || error.toString().includes('Unexpected error'))) {
      Logger.log('⚠️ DETECTED: openById authorization error in handleLogin');
      Logger.log('Returning friendly error message: ' + error.message);
      // Return the friendly error message directly (already transformed)
      return createResponse(false, error.message);
    }
    
    // For other errors, return with prefix
    Logger.log('Returning generic error message');
    return createResponse(false, msg_('errLogin') + error.message);
  }
}

/**
 * Create a new user (Admin only function)
 */
function createUser(email, password, name, role, isAdmin, employeeId, department, company) {
  try {
    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'createUser');
    let sheet;
    try {
      sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'createUser');
    } catch (e) {
      sheet = spreadsheet.getSheets()[0];
      Logger.log('Using first sheet as fallback');
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // Use correct capitalized header names matching the Master Employee sheet
    const emailCol    = headers.indexOf('Email');
    const nameCol     = headers.indexOf('Họ và tên');
    const roleCol     = headers.indexOf('Chức vụ');
    const deptCol     = headers.indexOf('Phòng ban');
    const companyCol  = headers.indexOf('Công ty');
    const phoneCol    = headers.indexOf('Điện thoại');
    const statusCol   = headers.indexOf('Status');
    const empIdCol    = headers.indexOf('EmployeeId');
    const isAdminCol  = headers.indexOf('isAdmin');
    const passwordCol = 11; // Column L — SHA-256 hash
    const mustChangeCol = headers.indexOf('mustChangePassword');

    if (emailCol === -1) {
      return { success: false, message: 'Email column not found in sheet' };
    }

    // Check if user already exists
    for (let i = 1; i < data.length; i++) {
      if (data[i][emailCol] && data[i][emailCol].toString().toLowerCase() === email.toLowerCase()) {
        return { success: false, message: 'User already exists' };
      }
    }

    // Hash password
    const hashedPassword = hashPassword(password);

    // Build row matching actual sheet column order
    const newRow = new Array(Math.max(headers.length, passwordCol + 1)).fill('');
    if (nameCol >= 0)     newRow[nameCol]     = name || '';
    if (roleCol >= 0)     newRow[roleCol]     = role || 'Employee';
    if (deptCol >= 0)     newRow[deptCol]     = department || '';
    if (companyCol >= 0)  newRow[companyCol]  = company || '';
    if (emailCol >= 0)    newRow[emailCol]    = email;
    if (phoneCol >= 0)    newRow[phoneCol]    = '';
    if (statusCol >= 0)   newRow[statusCol]   = 'Active';
    if (empIdCol >= 0)    newRow[empIdCol]    = employeeId || '';
    if (isAdminCol >= 0)  newRow[isAdminCol]  = isAdmin || false;
    newRow[passwordCol] = hashedPassword;
    if (mustChangeCol >= 0) newRow[mustChangeCol] = true; // Force password change on first login

    sheet.appendRow(newRow);
    Logger.log('User created: ' + email);
    return { success: true, message: 'User created successfully' };
  } catch (error) {
    Logger.log('Create user error: ' + error.toString());
    return { success: false, message: 'Error creating user: ' + error.message };
  }
}

/**
 * Update user password
 */
function updateUserPassword(email, oldPassword, newPassword) {
  try {
    const authResult = authenticateUser(email, oldPassword);
    if (!authResult.success) {
      return { success: false, message: 'Current password is incorrect' };
    }

    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'updateUserPassword');
    let sheet;
    try {
      sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'updateUserPassword');
    } catch (e) {
      sheet = spreadsheet.getSheets()[0];
      Logger.log('Using first sheet as fallback');
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const emailCol = headers.indexOf('Email'); // Capitalized — matches sheet header
    const passwordCol = 11; // Column L — SHA-256 hash, always index 11

    if (emailCol === -1) {
      return { success: false, message: 'Email column not found in sheet' };
    }

    for (let i = 1; i < data.length; i++) {
      if (data[i][emailCol] && data[i][emailCol].toString().toLowerCase() === email.toLowerCase()) {
        const hashedPassword = hashPassword(newPassword);
        sheet.getRange(i + 1, passwordCol + 1).setValue(hashedPassword);
        Logger.log('Password updated for: ' + email);
        return { success: true, message: 'Password updated successfully' };
      }
    }

    return { success: false, message: 'User not found' };
  } catch (error) {
    Logger.log('Update password error: ' + error.toString());
    return { success: false, message: 'Error updating password: ' + error.message };
  }
}

/**
 * Handle change password request (used for first-login forced change and self-service change)
 */
function handleChangePassword(requestBody) {
  try {
    Logger.log('=== HANDLE CHANGE PASSWORD ===');
    const email       = requestBody.email;
    const currentPassword = requestBody.currentPassword;
    const newPassword = requestBody.newPassword;

    if (!email || !currentPassword || !newPassword) {
      return createResponse(false, msg_('changePwFieldsRequired'));
    }

    // Validate new password rules
    const pwValidation = validatePasswordRules(newPassword);
    if (!pwValidation.valid) {
      return createResponse(false, pwValidation.message);
    }

    const spreadsheet = safeOpenSpreadsheet(USERS_SHEET_ID, 'handleChangePassword');
    let sheet;
    try {
      sheet = safeGetSheet(spreadsheet, USERS_SHEET_NAME, 'handleChangePassword');
    } catch (e) {
      sheet = spreadsheet.getSheets()[0];
    }

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    let emailCol = headers.indexOf('Email');
    if (emailCol === -1) emailCol = headers.indexOf('email');
    if (emailCol === -1) emailCol = 4;
    const colK         = 10; // Column K — default plain text password
    const passwordCol  = 11; // Column L — SHA-256 hash
    let mustChangeCol = headers.indexOf('mustChangePassword');
    if (mustChangeCol === -1) mustChangeCol = 12; // Column M fallback

    for (let i = 1; i < data.length; i++) {
      if (data[i][emailCol] && data[i][emailCol].toString().toLowerCase() === email.toLowerCase()) {
        const storedHash    = (data[i][passwordCol] || '').toString().trim();
        const colKPlainText = (data[i][colK]         || '').toString().trim();

        if (storedHash) {
          // Normal change — verify current password against Column L hash
          if (hashPassword(currentPassword) !== storedHash) {
            Logger.log('Current password mismatch for: ' + email);
            return createResponse(false, msg_('wrongCurrentPassword'));
          }
        } else if (colKPlainText) {
          // First login — verify current password against Column K plain text
          if (currentPassword !== colKPlainText) {
            Logger.log('Column K mismatch for: ' + email);
            return createResponse(false, msg_('wrongCurrentPassword'));
          }
          // Prevent setting same password as default
          if (newPassword === colKPlainText) {
            return createResponse(false, msg_('newPwSameAsDefault'));
          }
        }

        // Hash new password and store in Column L
        const newHash = hashPassword(newPassword);
        sheet.getRange(i + 1, passwordCol + 1).setValue(newHash);
        // Clear Column K default password
        sheet.getRange(i + 1, colK + 1).setValue('');
        // Clear mustChangePassword flag
        sheet.getRange(i + 1, mustChangeCol + 1).setValue(false);
        SpreadsheetApp.flush();

        Logger.log('Password changed successfully for: ' + email);
        return createResponse(true, 'Đổi mật khẩu thành công');
      }
    }

    return createResponse(false, msg_('userNotFound'));
  } catch (error) {
    Logger.log('Change password error: ' + error.toString());
    return createResponse(false, msg_('errChangePassword') + error.message);
  }
}

// ============================================================================
// VOUCHER EMAIL FUNCTIONS
// ============================================================================

/**
 * Xử lý gửi email phê duyệt
 */
function handleSendEmail(requestBody) {
  try {
    const emailData = requestBody.email;
    const to = emailData.to;
    const cc = emailData.cc || '';
    const subject = emailData.subject;
    const body = emailData.body;

    if (!to) {
      return createResponse(false, msg_('recipientEmailRequired'));
    }

    GmailApp.sendEmail(to, subject, '', {
      htmlBody: body,
      cc: cc
    });

    Logger.log('Email sent successfully to: ' + to);
    return createResponse(true, 'Email sent successfully');
  } catch (error) {
    Logger.log('Error sending email: ' + error.toString());
    return createResponse(false, msg_('errSendingEmail') + error.message);
  }
}

/**
 * Xử lý phê duyệt phiếu
 */
function handleApproveVoucher(requestBody) {
  try {
    Logger.log('=== APPROVE VOUCHER ===');
    Logger.log('Request body: ' + JSON.stringify(requestBody));
    
    const voucher = requestBody.voucher;
    if (!voucher) {
      Logger.log('Error: voucher object is missing');
      return createResponse(false, msg_('voucherDataRequired'));
    }
    
    const voucherNumber = voucher.voucherNumber || 'N/A';
    const voucherType = voucher.voucherType || 'N/A';
    const company = voucher.company || 'N/A';
    const employee = voucher.employee || 'N/A';
    const amount = voucher.amount || 'N/A';
    const requestorEmail = voucher.requestorEmail;
    const approverEmail = voucher.approverEmail || '';
    const approvedBy = voucher.approvedBy || approverEmail;

    Logger.log('Voucher Number: ' + voucherNumber);
    Logger.log('Requestor Email: ' + requestorEmail);
    Logger.log('Approver Email: ' + approverEmail);

    if (!requestorEmail || requestorEmail.trim() === '') {
      Logger.log('Error: Requestor email is missing or empty');
      return createResponse(false, msg_('requestorEmailRequired'));
    }

    // Create approval email
    const subject = `[ĐÃ PHÊ DUYỆT] Phiếu ${voucherType.toUpperCase()} - ${voucherNumber}`;
    
    const emailBodyHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #34A853; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">✅ Phiếu đã được phê duyệt</h2>
        </div>
        
        <div style="background-color: #fff; padding: 30px; border: 1px solid #ddd; border-top: none;">
          <p>Kính gửi <b>${employee}</b>,</p>
          
          <p>Phiếu <b>${voucherType}</b> số <b>${voucherNumber}</b> của bạn đã được <b style="color: #34A853;">phê duyệt</b>.</p>
          
          <div style="background-color: #d4edda; border-left: 4px solid #34A853; padding: 15px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #155724;">Thông tin phê duyệt:</h3>
            <ul style="margin: 0; padding-left: 20px; color: #155724;">
              <li><b>Trạng thái:</b> Đã phê duyệt</li>
              <li><b>Người phê duyệt:</b> ${approvedBy || approverEmail}</li>
              <li><b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}</li>
            </ul>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Thông tin phiếu:</h3>
            <ul style="margin: 0; padding-left: 20px;">
              <li><b>Số phiếu:</b> ${voucherNumber}</li>
              <li><b>Loại phiếu:</b> ${voucherType}</li>
              <li><b>Công ty:</b> ${company}</li>
              <li><b>Người đề nghị:</b> ${employee}</li>
              <li><b>Tổng số tiền:</b> ${amount}</li>
            </ul>
          </div>
          
          <p style="margin-top: 30px;">Trân trọng,<br>Hệ thống Kế toán Tự động</p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; color: #666; font-size: 12px;">
          <p style="margin: 0;">Email này được gửi tự động từ hệ thống. Vui lòng không reply email này.</p>
        </div>
      </div>
    `;

    // Send email to requestor
    try {
      Logger.log('Attempting to send email to: ' + requestorEmail);
      
      const emailOptions = {
        htmlBody: emailBodyHtml
      };
      
      if (approverEmail && approverEmail.trim() !== '') {
        emailOptions.cc = approverEmail;
        Logger.log('CC to: ' + approverEmail);
      }
      
      GmailApp.sendEmail(requestorEmail, subject, '', emailOptions);
      
      Logger.log('✅ Approval email sent successfully to: ' + requestorEmail);
      return createResponse(true, 'Voucher approved and notification email sent to ' + requestorEmail);
    } catch (emailError) {
      Logger.log('❌ Error sending email: ' + emailError.toString());
      Logger.log('Error details: ' + JSON.stringify(emailError));
      return createResponse(false, msg_('errSendingEmail') + emailError.message);
    }
    
  } catch (error) {
    Logger.log('Error approving voucher: ' + error.toString());
    return createResponse(false, msg_('errApproveVoucher') + error.message);
  }
}

/**
 * Xử lý trả lại/từ chối phiếu
 */
function handleRejectVoucher(requestBody) {
  try {
    const voucher = requestBody.voucher;
    const voucherNumber = voucher.voucherNumber;
    const voucherType = voucher.voucherType;
    const company = voucher.company;
    const employee = voucher.employee;
    const amount = voucher.amount;
    const requestorEmail = voucher.requestorEmail;
    const approverEmail = voucher.approverEmail;
    const rejectReason = voucher.rejectReason;
    const rejectedBy = voucher.rejectedBy;

    if (!requestorEmail) {
      return createResponse(false, msg_('requestorEmailRequired'));
    }

    if (!rejectReason) {
      return createResponse(false, msg_('rejectReasonRequired'));
    }

    // Create rejection email
    const subject = `[TRẢ LẠI] Phiếu ${voucherType.toUpperCase()} - ${voucherNumber}`;
    
    const emailBodyHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #EA4335; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
          <h2 style="margin: 0;">❌ Phiếu đã bị trả lại</h2>
        </div>
        
        <div style="background-color: #fff; padding: 30px; border: 1px solid #ddd; border-top: none;">
          <p>Kính gửi <b>${employee}</b>,</p>
          
          <p>Phiếu <b>${voucherType}</b> số <b>${voucherNumber}</b> của bạn đã bị <b style="color: #EA4335;">trả lại</b> và cần được chỉnh sửa.</p>
          
          <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: #856404;">Lý do trả lại:</h3>
            <p style="margin-bottom: 0; color: #856404; white-space: pre-wrap;">${rejectReason}</p>
          </div>
          
          <div style="background-color: #f8f9fa; padding: 15px; border-radius: 6px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Thông tin phiếu:</h3>
            <ul style="margin: 0; padding-left: 20px;">
              <li><b>Số phiếu:</b> ${voucherNumber}</li>
              <li><b>Loại phiếu:</b> ${voucherType}</li>
              <li><b>Công ty:</b> ${company}</li>
              <li><b>Người đề nghị:</b> ${employee}</li>
              <li><b>Tổng số tiền:</b> ${amount}</li>
              <li><b>Người trả lại:</b> ${rejectedBy || approverEmail}</li>
              <li><b>Thời gian:</b> ${new Date().toLocaleString('vi-VN')}</li>
            </ul>
          </div>
          
          <p><b>Vui lòng:</b></p>
          <ol>
            <li>Xem lại lý do trả lại ở trên</li>
            <li>Chỉnh sửa phiếu theo yêu cầu</li>
            <li>Gửi lại yêu cầu phê duyệt sau khi đã sửa</li>
          </ol>
          
          <p style="margin-top: 30px;">Trân trọng,<br>Hệ thống Kế toán Tự động</p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; color: #666; font-size: 12px;">
          <p style="margin: 0;">Email này được gửi tự động từ hệ thống. Vui lòng không reply email này.</p>
        </div>
      </div>
    `;

    // Send email to requestor
    GmailApp.sendEmail(requestorEmail, subject, '', {
      htmlBody: emailBodyHtml,
      cc: approverEmail || ''
    });

    Logger.log('Rejection email sent successfully to: ' + requestorEmail);
    return createResponse(true, 'Voucher rejected and notification email sent');
    
  } catch (error) {
    Logger.log('Error rejecting voucher: ' + error.toString());
    return createResponse(false, msg_('errRejectVoucher') + error.message);
  }
}

// ============================================================================
// GOOGLE SHEETS SYNC FUNCTIONS
// ============================================================================

/**
 * Xử lý đồng bộ dữ liệu vào Google Sheets
 */
function handleSyncToSheets(requestBody) {
  try {
    const spreadsheetId = requestBody.spreadsheetId;
    const sheetName = requestBody.sheetName || 'Phiếu Thu Chi';
    const data = requestBody.data;

    if (!spreadsheetId) {
      return createResponse(false, msg_('spreadsheetIdRequired'));
    }

    if (!data) {
      return createResponse(false, msg_('dataRequired'));
    }

    // Mở spreadsheet
    let spreadsheet;
    try {
      spreadsheet = safeOpenSpreadsheet(spreadsheetId, 'syncToGoogleSheets');
    } catch (error) {
      return createResponse(false, msg_('cannotAccessSpreadsheet') + error.message);
    }

    // Lấy hoặc tạo sheet
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
      // Tạo header row
      createHeaderRow(sheet);
    }

    // Ghi dữ liệu vào sheet
    writeVoucherData(sheet, data);

    Logger.log('Data synced successfully to sheet: ' + sheetName);
    return createResponse(true, 'Data synced successfully');
  } catch (error) {
    Logger.log('Error syncing to sheets: ' + error.toString());
    return createResponse(false, msg_('errSyncSheets') + error.message);
  }
}

/**
 * Tạo header row cho sheet
 */
function createHeaderRow(sheet) {
  const headers = [
    'Thời gian',
    'Số phiếu',
    'Loại phiếu',
    'Ngày lập',
    'Công ty',
    'Người đề nghị',
    'Bộ phận',
    'Người nộp/nhận',
    'Loại tiền',
    'Tổng số tiền',
    'Số tiền bằng chữ',
    'Lý do',
    'Người phê duyệt',
    'Trạng thái',
    'Số dòng chi tiết',
    'Chi tiết (JSON)',
    'Lịch sử phê duyệt (JSON)'
  ];

  // Format header row
  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4285F4');
  headerRange.setFontColor('#FFFFFF');
  headerRange.setHorizontalAlignment('center');
  
  // Freeze header row
  sheet.setFrozenRows(1);
  
  // Auto-resize columns
  for (let i = 1; i <= headers.length; i++) {
    sheet.autoResizeColumn(i);
  }
}

/**
 * Ghi dữ liệu phiếu vào sheet
 */
function writeVoucherData(sheet, data) {
  const row = [
    data.timestamp || new Date().toISOString(),
    data.voucherNumber || '',
    data.voucherType || '',
    data.voucherDate || '',
    data.company || '',
    data.employee || '',
    data.department || '',
    data.payeeName || '',
    data.currency || '',
    data.totalAmount || '',
    data.amountInWords || '',
    data.reason || '',
    data.approver || '',
    data.status || '',
    data.expenseItems ? data.expenseItems.length : 0,
    JSON.stringify(data.expenseItems || []),
    JSON.stringify(data.approvalHistory || [])
  ];

  // Thêm dòng mới
  const lastRow = sheet.getLastRow();
  const newRow = lastRow + 1;
  
  // Ghi dữ liệu
  sheet.getRange(newRow, 1, 1, row.length).setValues([row]);
  
  // Format số tiền
  const amountColumn = 10; // Cột tổng số tiền
  const amountCell = sheet.getRange(newRow, amountColumn);
  amountCell.setNumberFormat('#,##0');
  
  // Format ngày
  const dateColumn = 4; // Cột ngày lập
  const dateCell = sheet.getRange(newRow, dateColumn);
  if (data.voucherDate) {
    dateCell.setNumberFormat('dd/mm/yyyy');
  }
  
  // Auto-resize columns
  sheet.autoResizeColumns(1, row.length);
  
  // Thêm conditional formatting cho trạng thái
  formatStatusColumn(sheet, newRow);
  
  // Tạo sheet chi tiết nếu có expense items
  if (data.expenseItems && data.expenseItems.length > 0) {
    createDetailSheet(spreadsheet, data.voucherNumber, data.expenseItems);
  }
}

/**
 * Format cột trạng thái với màu sắc
 */
function formatStatusColumn(sheet, row) {
  const statusColumn = 14; // Cột trạng thái
  const statusCell = sheet.getRange(row, statusColumn);
  const status = statusCell.getValue().toString().toLowerCase();
  
  if (status.includes('đã phê duyệt') || status.includes('approved')) {
    statusCell.setBackground('#e8f5e9');
    statusCell.setFontColor('#4caf50');
  } else if (status.includes('từ chối') || status.includes('rejected')) {
    statusCell.setBackground('#ffebee');
    statusCell.setFontColor('#f44336');
  } else {
    statusCell.setBackground('#fff8e1');
    statusCell.setFontColor('#ff9800');
  }
  
  statusCell.setFontWeight('bold');
  statusCell.setHorizontalAlignment('center');
}

/**
 * Tạo sheet chi tiết cho từng phiếu
 */
function createDetailSheet(spreadsheet, voucherNumber, expenseItems) {
  const detailSheetName = 'Chi tiết ' + voucherNumber;
  
  // Xóa sheet cũ nếu tồn tại
  const existingSheet = spreadsheet.getSheetByName(detailSheetName);
  if (existingSheet) {
    spreadsheet.deleteSheet(existingSheet);
  }
  
  // Tạo sheet mới
  const detailSheet = spreadsheet.insertSheet(detailSheetName);
  
  // Header
  const headers = ['STT', 'Nội dung', 'Số tiền', 'Số file đính kèm'];
  detailSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  detailSheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  detailSheet.getRange(1, 1, 1, headers.length).setBackground('#4285F4');
  detailSheet.getRange(1, 1, 1, headers.length).setFontColor('#FFFFFF');
  
  // Dữ liệu
  const dataRows = expenseItems.map((item, index) => [
    index + 1,
    item.content || '',
    item.amount || 0,
    item.attachments || 0
  ]);
  
  if (dataRows.length > 0) {
    detailSheet.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
    
    // Format số tiền
    detailSheet.getRange(2, 3, dataRows.length, 1).setNumberFormat('#,##0');
    
    // Tổng cộng
    const totalRow = dataRows.length + 2;
    detailSheet.getRange(totalRow, 2, 1, 1).setValue('TỔNG CỘNG');
    detailSheet.getRange(totalRow, 2, 1, 1).setFontWeight('bold');
    detailSheet.getRange(totalRow, 3, 1, 1).setFormula('=SUM(C2:C' + (totalRow - 1) + ')');
    detailSheet.getRange(totalRow, 3, 1, 1).setFontWeight('bold');
    detailSheet.getRange(totalRow, 3, 1, 1).setNumberFormat('#,##0');
  }
  
  // Auto-resize columns
  detailSheet.autoResizeColumns(1, headers.length);
  
  // Freeze header
  detailSheet.setFrozenRows(1);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Tạo response JSON với CORS headers
 */
function createResponse(success, message, data) {
  const response = {
    success: success,
    message: message
  };
  
  if (data) {
    response.data = data;
  }
  
  const output = ContentService.createTextOutput(JSON.stringify(response));
  output.setMimeType(ContentService.MimeType.JSON);
  
  // Note: Google Apps Script automatically handles CORS for Web Apps
  // But we can't set custom headers directly
  
  return output;
}

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

/**
 * Test email authorization — run this once to grant MailApp access
 * Replace the email below with your own before running
 */
function testGmailAccess() {
  try {
    MailApp.sendEmail({
      to: Session.getActiveUser().getEmail(),
      subject: '[TLCGroup] Test email authorization',
      body: 'Email authorization is working correctly.'
    });
    Logger.log('✅ MailApp authorized and test email sent to: ' + Session.getActiveUser().getEmail());
    return { success: true };
  } catch (e) {
    Logger.log('❌ MailApp not authorized: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Test function - để test hash password
 */
function testHashPassword() {
  const password = 'test123';
  const hash = hashPassword(password);
  Logger.log('Password: ' + password);
  Logger.log('Hash: ' + hash);
  return hash;
}

/**
 * Handle getMasterData action
 * Fetches data from Nhân viên, Khách hàng, Nhà cung cấp sheets
 */
function handleGetMasterData(requestBody) {
  try {
    Logger.log('=== handleGetMasterData called ===');

    const ss = safeOpenSpreadsheet(USERS_SHEET_ID, 'handleGetMasterData');
    
    // Fetch Nhân viên (Employees)
    const employeesSheet = ss.getSheetByName('Master Employee');
    let employeesData = [];
    if (employeesSheet) {
      const employeesValues = employeesSheet.getDataRange().getValues();
      const employeesHeaders = employeesValues[0];
      employeesData = employeesValues.slice(1).map(row => {
        const obj = {};
        employeesHeaders.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });
      Logger.log('Nhân viên records: ' + employeesData.length);
    } else {
      Logger.log('⚠️ Sheet "Nhân viên" not found');
    }
    
    // Fetch Khách hàng (Customers)
    const customersSheet = ss.getSheetByName('Khách hàng');
    let customersData = [];
    if (customersSheet) {
      const customersValues = customersSheet.getDataRange().getValues();
      const customersHeaders = customersValues[0];
      customersData = customersValues.slice(1).map(row => {
        const obj = {};
        customersHeaders.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });
      Logger.log('Khách hàng records: ' + customersData.length);
    } else {
      Logger.log('⚠️ Sheet "Khách hàng" not found');
    }
    
    // Fetch Nhà cung cấp (Suppliers)
    const suppliersSheet = ss.getSheetByName('Nhà cung cấp');
    let suppliersData = [];
    if (suppliersSheet) {
      const suppliersValues = suppliersSheet.getDataRange().getValues();
      const suppliersHeaders = suppliersValues[0];
      suppliersData = suppliersValues.slice(1).map(row => {
        const obj = {};
        suppliersHeaders.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });
      Logger.log('Nhà cung cấp records: ' + suppliersData.length);
    } else {
      Logger.log('⚠️ Sheet "Nhà cung cấp" not found');
    }
    
    // Fetch Goods-KTT (MOQ catalog)
    const goodsSheet = ss.getSheetByName('Goods-KTT');
    let goodsData = [];
    if (goodsSheet) {
      const goodsValues = goodsSheet.getDataRange().getValues();
      const goodsHeaders = goodsValues[0];
      goodsData = goodsValues.slice(1).map(row => {
        const obj = {};
        goodsHeaders.forEach((header, index) => { obj[header] = row[index]; });
        return obj;
      }).filter(r => r[goodsHeaders[0]]);
      Logger.log('Goods-KTT records: ' + goodsData.length);
    } else {
      Logger.log('⚠️ Sheet "Goods-KTT" not found');
    }

    const masterData = {
      employees: employeesData,
      customers: customersData,
      suppliers: suppliersData,
      goods:     goodsData,
      timestamp: new Date().toISOString()
    };
    
    Logger.log('✅ Master data fetched successfully');
    return createResponse(true, 'Master data fetched successfully', masterData);
  } catch (error) {
    Logger.log('❌ Error in handleGetMasterData: ' + error.toString());
    Logger.log('Stack: ' + error.stack);
    return createResponse(false, msg_('errFetchMasterData') + error.message);
  }
}

/**
 * Test function - để test authentication
 */
function testAuthentication() {
  const email = 'anh.le@mediainsider.vn'; // Thay bằng email trong sheet
  const password = 'yourpassword'; // Thay bằng password
  const result = authenticateUser(email, password);
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
  return result;
}

/**
 * Test function - để test login handler
 */
function testLoginHandler() {
  const requestBody = {
    action: 'login',
    email: 'anh.le@mediainsider.vn', // Thay bằng email trong sheet
    password: 'yourpassword' // Thay bằng password
  };

  const result = handleLogin(requestBody);
  Logger.log('Result: ' + JSON.stringify(result, null, 2));
  return result;
}

/**
 * Diagnostic function - Check all prerequisites for spreadsheet access
 * Chạy function này để kiểm tra tất cả điều kiện cần thiết
 */
function diagnoseSpreadsheetAccess() {
  try {
    Logger.log('========================================');
    Logger.log('=== DIAGNOSTIC CHECK ===');
    Logger.log('========================================\n');

    // Test 1: Check SpreadsheetApp availability
    Logger.log('Test 1: Checking SpreadsheetApp availability...');
    if (typeof SpreadsheetApp === 'undefined') {
      Logger.log('❌ FAILED: SpreadsheetApp is undefined');
      return { success: false, error: 'SpreadsheetApp is undefined' };
    }
    Logger.log('✅ PASSED: SpreadsheetApp is available');
    Logger.log('   Type: ' + typeof SpreadsheetApp);
    Logger.log('   Available methods: ' + Object.keys(SpreadsheetApp).slice(0, 10).join(', ') + '...\n');

    // Test 2: Check openById method
    Logger.log('Test 2: Checking openById method...');
    if (typeof SpreadsheetApp.openById !== 'function') {
      Logger.log('❌ FAILED: SpreadsheetApp.openById is not a function');
      Logger.log('   Type: ' + typeof SpreadsheetApp.openById);
      Logger.log('   This usually means the script needs authorization');
      return { 
        success: false, 
        error: 'openById method not available - authorization required',
        solution: 'Run testSpreadsheetAccess() function to authorize'
      };
    }
    Logger.log('✅ PASSED: SpreadsheetApp.openById is available\n');

    // Test 3: Check spreadsheet ID
    Logger.log('Test 3: Checking spreadsheet ID...');
    Logger.log('   USERS_SHEET_ID: ' + USERS_SHEET_ID);
    Logger.log('   Type: ' + typeof USERS_SHEET_ID);
    Logger.log('   Length: ' + (USERS_SHEET_ID ? USERS_SHEET_ID.length : 0));
    if (!USERS_SHEET_ID || USERS_SHEET_ID === '') {
      Logger.log('❌ FAILED: USERS_SHEET_ID is empty or undefined');
      return { success: false, error: 'USERS_SHEET_ID is not defined' };
    }
    Logger.log('✅ PASSED: Spreadsheet ID is defined\n');

    // Test 4: Try to open spreadsheet
    Logger.log('Test 4: Attempting to open spreadsheet...');
    Logger.log('   Spreadsheet ID: ' + USERS_SHEET_ID);
    let ss;
    try {
      ss = SpreadsheetApp.openById(USERS_SHEET_ID);
      Logger.log('✅ PASSED: Spreadsheet opened successfully!');
      Logger.log('   Spreadsheet name: ' + ss.getName());
      Logger.log('   Spreadsheet URL: ' + ss.getUrl());
    } catch (openError) {
      Logger.log('❌ FAILED: Could not open spreadsheet');
      Logger.log('   Error name: ' + openError.name);
      Logger.log('   Error message: ' + openError.message);
      Logger.log('   Error toString: ' + openError.toString());
      
      if (openError.message.includes('openById') || openError.message.includes('Unexpected error')) {
        Logger.log('\n   ⚠️ AUTHORIZATION ERROR DETECTED');
        Logger.log('   Solution: Run testSpreadsheetAccess() to authorize');
      } else if (openError.message.includes('not found') || openError.message.includes('does not exist')) {
        Logger.log('\n   ⚠️ SPREADSHEET NOT FOUND');
        Logger.log('   Check spreadsheet ID: ' + USERS_SHEET_ID);
        Logger.log('   URL: https://docs.google.com/spreadsheets/d/' + USERS_SHEET_ID + '/edit');
      }
      
      return { 
        success: false, 
        error: openError.message,
        errorName: openError.name,
        errorToString: openError.toString()
      };
    }

    // Test 5: Check sheet access
    Logger.log('\nTest 5: Checking sheet access...');
    Logger.log('   Sheet name: ' + USERS_SHEET_NAME);
    let sheet;
    try {
      sheet = ss.getSheetByName(USERS_SHEET_NAME);
      if (!sheet) {
        Logger.log('⚠️ WARNING: Sheet "' + USERS_SHEET_NAME + '" not found');
        const allSheets = ss.getSheets();
        Logger.log('   Available sheets: ' + allSheets.map(s => s.getName()).join(', '));
        sheet = allSheets[0];
        Logger.log('   Using first sheet: ' + sheet.getName());
      } else {
        Logger.log('✅ PASSED: Sheet found');
      }
    } catch (sheetError) {
      Logger.log('❌ FAILED: Could not access sheet');
      Logger.log('   Error: ' + sheetError.message);
      return { success: false, error: 'Sheet access failed: ' + sheetError.message };
    }

    // Test 6: Read data
    Logger.log('\nTest 6: Reading data from sheet...');
    try {
      const data = sheet.getDataRange().getValues();
      Logger.log('✅ PASSED: Data read successfully');
      Logger.log('   Total rows: ' + data.length);
      Logger.log('   Total columns: ' + (data[0] ? data[0].length : 0));
      if (data.length > 0) {
        Logger.log('   Headers: ' + JSON.stringify(data[0].slice(0, 5)) + '...');
      }
    } catch (readError) {
      Logger.log('❌ FAILED: Could not read data');
      Logger.log('   Error: ' + readError.message);
      return { success: false, error: 'Data read failed: ' + readError.message };
    }

    Logger.log('\n========================================');
    Logger.log('✅✅✅ ALL DIAGNOSTIC TESTS PASSED! ✅✅✅');
    Logger.log('========================================');
    return { success: true, message: 'All tests passed' };

  } catch (error) {
    Logger.log('\n========================================');
    Logger.log('❌❌❌ DIAGNOSTIC TEST FAILED ❌❌❌');
    Logger.log('========================================');
    Logger.log('Error: ' + error.message);
    Logger.log('Stack: ' + error.stack);
    return { success: false, error: error.message, stack: error.stack };
  }
}

/**
 * Test spreadsheet access - RUN THIS FIRST to authorize the script
 * Chạy function này trước tiên để cấp quyền cho script
 */
function testSpreadsheetAccess() {
  try {
    Logger.log('=== TESTING SPREADSHEET ACCESS ===');
    Logger.log('USERS_SHEET_ID: ' + USERS_SHEET_ID);
    Logger.log('USERS_SHEET_NAME: ' + USERS_SHEET_NAME);

    // Test opening spreadsheet
    Logger.log('Attempting to open spreadsheet...');
    const ss = safeOpenSpreadsheet(USERS_SHEET_ID, 'testSpreadsheetAccess');
    Logger.log('✅ Spreadsheet opened successfully!');
    Logger.log('Spreadsheet name: ' + ss.getName());

    // Test getting sheet
    Logger.log('Attempting to get sheet: ' + USERS_SHEET_NAME);
    let sheet;
    try {
      sheet = safeGetSheet(ss, USERS_SHEET_NAME, 'testSpreadsheetAccess');
    } catch (e) {
      Logger.log('Sheet "' + USERS_SHEET_NAME + '" not found, using first sheet');
      sheet = ss.getSheets()[0];
    }
    Logger.log('✅ Sheet accessed successfully!');
    Logger.log('Sheet name: ' + sheet.getName());

    // Test reading data
    const data = sheet.getDataRange().getValues();
    Logger.log('✅ Data read successfully!');
    Logger.log('Total rows: ' + data.length);
    Logger.log('Total columns: ' + (data[0] ? data[0].length : 0));
    if (data.length > 0) {
      Logger.log('Headers: ' + JSON.stringify(data[0]));
    }

    Logger.log('\n========================================');
    Logger.log('✅✅✅ ALL TESTS PASSED! ✅✅✅');
    Logger.log('========================================');
    Logger.log('Script has been authorized successfully!');
    Logger.log('You can now deploy this as a web app.');
    Logger.log('\nNext steps:');
    Logger.log('1. Click Deploy > New deployment (or Manage deployments)');
    Logger.log('2. Set "Execute as: Me"');
    Logger.log('3. Set "Who has access: Anyone"');
    Logger.log('4. Click Deploy');
    Logger.log('5. Copy the Web App URL to your index.html');

    return {
      success: true,
      message: 'Spreadsheet access test passed!',
      spreadsheetName: ss.getName(),
      sheetName: sheet.getName(),
      rowCount: data.length
    };

  } catch (error) {
    Logger.log('\n========================================');
    Logger.log('❌❌❌ TEST FAILED ❌❌❌');
    Logger.log('========================================');
    Logger.log('Error: ' + error.message);
    Logger.log('Stack: ' + error.stack);
    Logger.log('\nTroubleshooting:');
    Logger.log('1. Make sure you authorized the script when prompted');
    Logger.log('2. Check that spreadsheet ID is correct: ' + USERS_SHEET_ID);
    Logger.log('3. Verify spreadsheet exists: https://docs.google.com/spreadsheets/d/' + USERS_SHEET_ID + '/edit');
    Logger.log('4. Ensure your account has access to the spreadsheet');

    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Test handleLogin directly with a test request
 * This helps verify if handleLogin works correctly
 */
function testHandleLoginDirect() {
  try {
    Logger.log('=== TESTING handleLogin DIRECTLY ===');
    
    const testRequestBody = {
      action: 'login',
      email: 'test@example.com', // This will fail authentication, but should pass spreadsheet access
      password: 'test'
    };
    
    Logger.log('Test request body: ' + JSON.stringify(testRequestBody));
    
    const result = handleLogin(testRequestBody);
    const resultText = result.getContent();
    Logger.log('Response: ' + resultText);
    
    try {
      const resultJson = JSON.parse(resultText);
      Logger.log('Parsed response: ' + JSON.stringify(resultJson, null, 2));
      
      if (resultJson.message && resultJson.message.includes('openById')) {
        Logger.log('\n❌❌❌ handleLogin TEST FAILED ❌❌❌');
        Logger.log('Spreadsheet access error detected in handleLogin');
        Logger.log('Error: ' + resultJson.message);
        return { success: false, message: 'handleLogin has spreadsheet access issue', error: resultJson.message };
      } else if (resultJson.message && (
          resultJson.message.includes('Invalid email') || 
          resultJson.message.includes('Invalid password') ||
          resultJson.message.includes('Password is required')
        )) {
        Logger.log('\n✅✅✅ handleLogin TEST PASSED! ✅✅✅');
        Logger.log('handleLogin can access spreadsheet!');
        Logger.log('Authentication failed as expected (test credentials).');
        return { success: true, message: 'handleLogin works correctly' };
      } else {
        Logger.log('\n⚠️ Unexpected response from handleLogin');
        Logger.log('Response: ' + resultText);
        return { success: false, message: 'Unexpected response', response: resultJson };
      }
    } catch (parseError) {
      Logger.log('Could not parse response as JSON: ' + parseError.message);
      Logger.log('Raw response: ' + resultText);
      return { success: false, message: 'Invalid response format', rawResponse: resultText };
    }
    
  } catch (error) {
    Logger.log('\n❌❌❌ handleLogin TEST FAILED ❌❌❌');
    Logger.log('Error: ' + error.message);
    Logger.log('Stack: ' + error.stack);
    return { success: false, message: error.message };
  }
}

/**
 * Test web app deployment - Call this to verify web app has correct permissions
 * This simulates what happens when the web app is called via URL
 */
function testWebAppDeployment() {
  try {
    Logger.log('=== TESTING WEB APP DEPLOYMENT ===');
    Logger.log('This simulates a web app call to verify permissions');
    
    // Test with real credentials (chinh.nguyen@mediainsider.vn / Manager 4)
    const testRequestBody = {
      action: 'login',
      email: 'chinh.nguyen@mediainsider.vn',
      password: 'Manager 4'
    };
    
    Logger.log('Simulating web app call with request body: ' + JSON.stringify({
      action: testRequestBody.action,
      email: testRequestBody.email,
      password: '***'
    }));
    
    // Call handleLogin directly (this is what doPost does)
    const result = handleLogin(testRequestBody);
    
    // Check if we got past the spreadsheet access part
    const resultText = result.getContent();
    Logger.log('Response: ' + resultText);
    
    try {
      const resultJson = JSON.parse(resultText);
      Logger.log('Parsed response: ' + JSON.stringify(resultJson, null, 2));
      
      // Login success = spreadsheet access AND auth both worked
      if (resultJson.success === true) {
        Logger.log('\n✅✅✅ WEB APP DEPLOYMENT TEST PASSED! ✅✅✅');
        Logger.log('Login succeeded! Spreadsheet access and authentication both working.');
        return { success: true, message: 'Web app deployment OK – login with chinh.nguyen@mediainsider.vn succeeded' };
      }
      
      // "Invalid email or password" etc. = spreadsheet access worked, auth failed (wrong credentials)
      if (resultJson.message && (
          resultJson.message.includes('Invalid email') || 
          resultJson.message.includes('Invalid password') ||
          resultJson.message.includes('Password is required')
        )) {
        Logger.log('\n✅✅✅ WEB APP DEPLOYMENT TEST PASSED! ✅✅✅');
        Logger.log('Spreadsheet access is working. Auth failed (check email/password in sheet).');
        return { success: true, message: 'Web app deployment has correct permissions' };
      }
      
      // openById or similar = spreadsheet access failed
      if (resultJson.message && resultJson.message.includes('openById')) {
        Logger.log('\n❌❌❌ WEB APP DEPLOYMENT TEST FAILED ❌❌❌');
        Logger.log('Spreadsheet access is NOT working in web app deployment.');
        Logger.log('Error: ' + resultJson.message);
        Logger.log('\nSolution:');
        Logger.log('1. Check deployment settings: Execute as: Me (linh.le@tl-c.com.vn)');
        Logger.log('2. Verify spreadsheet is shared with linh.le@tl-c.com.vn');
        Logger.log('3. Re-deploy the web app');
        return { success: false, message: 'Web app deployment lacks permissions', error: resultJson.message };
      }
    } catch (parseError) {
      Logger.log('Could not parse response as JSON: ' + parseError.message);
    }
    
    return { success: false, message: 'Unexpected response format' };
    
  } catch (error) {
    Logger.log('\n❌❌❌ WEB APP DEPLOYMENT TEST FAILED ❌❌❌');
    Logger.log('Error: ' + error.message);
    Logger.log('Stack: ' + error.stack);
    return { success: false, message: error.message };
  }
}

