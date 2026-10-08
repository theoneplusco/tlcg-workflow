/**
 * TLCG Workflow — shared bilingual (VI/EN) layer.
 *
 * Loaded by every page via <script src="i18n.js"></script> before the page's
 * own inline script. No build step; mirrors the tlcg_companies_embed.js pattern.
 *
 * IMPORTANT — display-only status mapping:
 * Vietnamese status strings ('Chờ duyệt', 'Đã duyệt', 'Từ chối', ...) are used
 * as COMPARISON values in filter logic and in the Apps Script backend, and are
 * written into Google Sheets. They are never translated in place. Use tStatus()
 * only where a status is painted into the DOM.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'tlc_language';
  var SUPPORTED = ['vi', 'en'];
  var DEFAULT_LANG = 'vi';

  // ---------------------------------------------------------------- storage

  // Safari private mode throws on localStorage write; degrade to in-memory.
  var memoryLang = null;

  function readStored() {
    try {
      return global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return memoryLang;
    }
  }

  function writeStored(lang) {
    memoryLang = lang;
    try {
      global.localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      /* in-memory only */
    }
  }

  function isSupported(lang) {
    return SUPPORTED.indexOf(lang) !== -1;
  }

  /** Stored choice -> browser language -> Vietnamese. */
  function detectLang() {
    var stored = readStored();
    if (isSupported(stored)) return stored;

    var nav = global.navigator || {};
    var candidates = [].concat(nav.languages || [], [nav.language || '']);
    for (var i = 0; i < candidates.length; i++) {
      var tag = String(candidates[i] || '').toLowerCase();
      if (!tag) continue;
      if (tag.indexOf('vi') === 0) return 'vi';
      if (tag.indexOf('en') === 0) return 'en';
    }
    return DEFAULT_LANG;
  }

  var currentLang = null;

  // ----------------------------------------------------------- translations

  // Shared chrome. Page-specific keys are merged in via TLCI18n.extend().
  var strings = {
    vi: {
      // Brand / nav
      appName: 'Business Process Management (BPM)',
      navHome: 'Trang chủ',
      navAdmin: 'Quản trị',
      apwTitle: 'Xác nhận phê duyệt',
      apwHint: 'Nhập mật khẩu đăng nhập của bạn. Hệ thống sẽ đóng chữ ký mẫu đã đăng ký của bạn lên phiếu.',
      apwLabel: 'Mật khẩu đăng nhập',
      apwConfirm: 'Duyệt',
      apwCancel: 'Hủy',
      sapTitle: 'Tự động duyệt bước của bạn',
      sapConfirm: 'Gửi và tự động duyệt',
      sapCancel: 'Bỏ qua, tôi duyệt sau',
      sapAborted: 'Đã hủy. Phiếu chưa được gửi.',
      admMigrationDesc: 'Xem và sửa dữ liệu gốc: nhân viên, công ty, khách hàng, nhà cung cấp, tài khoản ngân hàng, hàng hoá.',
      admOpenMigration: 'Mở Dữ liệu gốc',
      admMasterData: 'Dữ liệu gốc',
      admOpenFlows: 'Luồng phê duyệt',
      admUserMgmt: 'Quản lý người dùng',
      admFullName: 'Họ và tên *',
      admEmailLogin: 'Email (tên đăng nhập) *',
      admPasswordBlank: 'Mật khẩu tạm (để trống = tự tạo)',
      admSendEmail: 'Gửi email đăng nhập cho nhân viên',
      admIsAdmin: 'Quyền quản trị',
      admAddEmployee: 'THÊM NHÂN VIÊN',
      admNeedRelogin: 'Phiên đăng nhập không có quyền quản trị mới. Vui lòng đăng xuất và đăng nhập lại.',
      admCreateFailed: 'Không tạo được tài khoản.',
      admTempPassword: 'Mật khẩu tạm',
      admEmailNotSent: 'Chưa gửi được email — hãy gửi mật khẩu tạm cho nhân viên.',
      admPickTitle: 'Chọn chức vụ',
      admPickDept: 'Chọn phòng ban',
      admPickCompany: 'Chọn công ty',
      admAddNewTitle: '+ Thêm chức vụ mới…',
      admAddNewDept: '+ Thêm phòng ban mới…',
      admAddNewCompany: '+ Thêm công ty mới…',
      admNewTitle: 'Tên chức vụ mới',
      admNewDept: 'Tên phòng ban mới',
      admNewCompanyName: 'Tên công ty mới',
      admNewCompanyKey: 'Mã (vd TLC)',
      admNewPassword: 'Tạo mật khẩu khác',
      admPasswordHelp: 'Mật khẩu tạm cho lần đăng nhập đầu — nhân viên bắt buộc đổi ngay khi đăng nhập.',
      admMustChange: 'phải đổi khi đăng nhập lần đầu',
      admNewTag: '(mới — thêm vào Dữ liệu gốc)',
      admFillNew: 'Hãy nhập giá trị mới (công ty mới cần cả tên và mã).',
      admCompanyAdded: 'Đã thêm công ty mới vào Dữ liệu gốc — nhớ bổ sung người duyệt trong Dữ liệu gốc › Công ty.',
      admConfirmCreate: 'Tạo tài khoản này?',
      admConfirmCreateBtn: 'Xác nhận tạo',
      admPasswordAuto: 'Tự tạo',
      backToDash: 'Quay lại',
      backToHome: 'Về trang chủ',

      // Hubs
      opsHubTitle: 'Vận hành Nhóm',
      o2cTitle: 'Bán hàng (O2C)',
      p2pTitle: 'Mua hàng (P2P)',
      cashTitle: 'Tiền mặt & Quản trị',
      openProcesses: 'Mở hệ thống',

      // Documents
      quotation: 'Báo giá',
      contract: 'Hợp đồng',
      vatInvoice: 'Hóa đơn VAT',
      purchaseRequest: 'Yêu cầu mua hàng',
      acceptance: 'Biên bản nghiệm thu',
      paymentRequest: 'Đề nghị thanh toán',
      cashBook: 'Sổ quỹ',
      vouchers: 'Phiếu thu/chi',

      // Auth
      loginTitle: 'Đăng nhập TLCGroup',
      loginSubtitle: 'Đăng nhập vào tài khoản của bạn',
      signIn: 'Đăng nhập',
      signOut: 'Đăng xuất',
      email: 'Email',
      password: 'Mật khẩu',
      forgotPassword: 'Quên mật khẩu?',
      profile: 'Hồ sơ',

      // Common actions
      save: 'Lưu',
      submit: 'Gửi phê duyệt',
      cancel: 'Hủy',
      close: 'Đóng',
      confirm: 'Xác nhận',
      search: 'Tìm kiếm',
      filter: 'Bộ lọc',
      refresh: 'Làm mới',
      exportLabel: 'Xuất file',
      print: 'In',
      previous: 'Quay lại',
      next: 'Tiếp theo',
      approve: 'Phê duyệt',
      reject: 'Từ chối',
      delete: 'Xóa',
      edit: 'Sửa',
      view: 'Xem',
      add: 'Thêm',

      // Common fields
      company: 'Công ty',
      date: 'Ngày',
      currency: 'Tiền tệ',
      amount: 'Số tiền',
      total: 'Tổng cộng',
      note: 'Ghi chú',
      status: 'Trạng thái',
      atTime: 'lúc',
      // Shared across pages
      navPurchaseRequest: 'Đề Nghị Mua Hàng',
      navAcceptance: 'Biên Bản Nghiệm Thu',
      navPaymentRequest: 'Đề Nghị Thanh Toán',
      navVoucher: 'Phiếu Thu Chi',
      notifications: 'Thông báo',
      openMenu: 'Mở menu',
      myTasks: 'Việc cần làm của tôi',
      myTaskFilterTitle: 'Chỉ hiện việc cần làm của tôi',
      refreshListTitle: 'Làm mới danh sách',
      backToPrev: 'Quay lại trang trước',
      skipToMain: 'Bỏ qua đến nội dung',
      toggleSidebar: 'Thu hoặc mở rộng thanh điều hướng',
      btnPrev: '← Quay lại',
      btnNext: 'Tiếp theo →',
      noSignature: 'Chưa có chữ ký',
      uploadSignature: 'Tải chữ ký lên',
      requesterSignature: 'Chữ ký người đề nghị',
      notSigned: 'Chưa ký',
      approval: 'Phê duyệt',
      optChooseCompany: '-- Chọn công ty --',
      optChoose: '-- Chọn --',
      optNone: '-- Không có --',
      addRow: 'Thêm dòng',
      colQty: 'Số lượng',
      colUnit: 'Đơn vị',
      colLineTotal: 'Thành tiền',
      statAll: 'Tất cả',
      statInProgress: 'Đang xử lý',
      statCompleted: 'Hoàn thành',
      statRejected: 'Từ chối',
      sendBack: 'Trả lại',
      secCompanyGeneral: 'Công Ty & Thông Tin Chung',
      secAttachments: 'Tài Liệu Đính Kèm',
      stepGoods: 'Hàng hóa',
      stepAria2: 'Bước 2 — Hàng hóa',
      labelPrNo: 'Số phiếu:',
      labelVendorList: 'NCC từ danh sách',
      labelVendorNew: 'Hoặc nhập NCC mới',
      labelVendorName: 'Tên NCC',
      labelVendorType: 'Loại NCC',
      labelVendorAddr: 'Địa chỉ NCC',
      vendorInfo: 'Thông tin Nhà cung cấp',
      newVendorNotice: 'NCC mới chưa có trong danh sách — sẽ được admin xem xét trước khi xử lý',
      clearVendor: 'Xóa NCC',
      optChooseVendorFirst: '-- Chọn NCC trước --',
      phVendorSearch: 'Gõ để tìm nhà cung cấp...',
      phVendorNew: 'Tên NCC nếu không có trong DS',
      backPlain: 'Quay lại',
      stepVendor: 'Nhà cung cấp',
      processing: 'Đang xử lý...',
      confirmApprove: 'Xác nhận phê duyệt',
      confirmReject: 'Xác nhận từ chối',
      approverSignature: '✍️ Chữ ký người phê duyệt',
      approverSignaturePlain: 'Chữ ký người phê duyệt',
      apRequestId: 'Số đề nghị:',
      apRequestType: 'Loại đề nghị:',
      apCompany: 'Công ty:',
      apRequestor: 'Người đề nghị:',
      apAmount: 'Tổng số tiền:',
      apStage: 'Giai đoạn phê duyệt:',
      nextPlain: 'Tiếp theo',
      requester: 'Người đề nghị',
      department: 'Bộ phận',

      // Feedback
      loading: 'Đang tải...',
      saving: 'Đang lưu...',
      noData: 'Không có dữ liệu',
      required: 'Bắt buộc',
      errorGeneric: 'Đã xảy ra lỗi. Vui lòng thử lại.',
      errorNetwork: 'Lỗi kết nối. Vui lòng kiểm tra mạng.',
      successSaved: 'Đã lưu thành công',
      successSubmitted: 'Đã gửi thành công',

      // AI
      aiTitle: '✨ Hỏi Đáp TLC AI',
      aiWelcome: 'Xin chào! Tôi có thể giúp gì về O2C, P2P hay Tiền mặt?'
    },
    en: {
      appName: 'Business Process Management (BPM)',
      navHome: 'Home',
      navAdmin: 'Admin',
      apwTitle: 'Confirm approval',
      apwHint: 'Enter your login password. Your registered sample signature will be stamped on the document.',
      apwLabel: 'Login password',
      apwConfirm: 'Approve',
      apwCancel: 'Cancel',
      sapTitle: 'Approve your own steps',
      sapConfirm: 'Submit and approve',
      sapCancel: 'Skip, I will approve later',
      sapAborted: 'Cancelled. Nothing was submitted.',
      admMigrationDesc: 'View and edit master data: employees, companies, clients, vendors, vendor banks and goods.',
      admOpenMigration: 'Open Master Data',
      admMasterData: 'Master Data',
      admOpenFlows: 'Approval Flows',
      admUserMgmt: 'User Management',
      admFullName: 'Full name *',
      admEmailLogin: 'Email (login) *',
      admPasswordBlank: 'Temporary password (blank = generate)',
      admSendEmail: 'Email login details to the employee',
      admIsAdmin: 'Admin rights',
      admAddEmployee: 'ADD EMPLOYEE',
      admNeedRelogin: 'This session has no admin token yet. Please sign out and sign in again.',
      admCreateFailed: 'Could not create the account.',
      admTempPassword: 'Temporary password',
      admEmailNotSent: 'The email did not go out — pass the temporary password to the employee.',
      admPickTitle: 'Choose a title',
      admPickDept: 'Choose a department',
      admPickCompany: 'Choose a company',
      admAddNewTitle: '+ Add a new title…',
      admAddNewDept: '+ Add a new department…',
      admAddNewCompany: '+ Add a new company…',
      admNewTitle: 'New title',
      admNewDept: 'New department',
      admNewCompanyName: 'New company name',
      admNewCompanyKey: 'Key (e.g. TLC)',
      admNewPassword: 'Suggest another password',
      admPasswordHelp: 'Temporary password for the first sign-in — the employee must change it right away.',
      admMustChange: 'must be changed at first sign-in',
      admNewTag: '(new — added to Master Data)',
      admFillNew: 'Type the new value (a new company needs both a name and a key).',
      admCompanyAdded: 'The new company was added to Master Data — add its approvers under Master Data › Companies.',
      admConfirmCreate: 'Create this account?',
      admConfirmCreateBtn: 'Confirm and create',
      admPasswordAuto: 'Generated',
      backToDash: 'Back',
      backToHome: 'Back to Home',

      opsHubTitle: 'Group Operations Hub',
      o2cTitle: 'Order to Cash',
      p2pTitle: 'Purchase to Pay',
      cashTitle: 'Cash & Admin',
      openProcesses: 'Launch System',

      quotation: 'Quotation',
      contract: 'Contract',
      vatInvoice: 'VAT Invoice',
      // Official workflow names stay Vietnamese (same as VI)
      purchaseRequest: 'Đề Nghị Mua Hàng',
      acceptance: 'Biên Bản Nghiệm Thu',
      paymentRequest: 'Đề Nghị Thanh Toán',
      cashBook: 'Sổ Quỹ',
      vouchers: 'Phiếu Thu Chi',

      loginTitle: 'TLCGroup Login',
      loginSubtitle: 'Sign in to your account',
      signIn: 'Sign In',
      signOut: 'Sign Out',
      email: 'Email',
      password: 'Password',
      forgotPassword: 'Forgot password?',
      profile: 'Profile',

      save: 'Save',
      submit: 'Submit',
      cancel: 'Cancel',
      close: 'Close',
      confirm: 'Confirm',
      search: 'Search',
      filter: 'Filter',
      refresh: 'Refresh',
      exportLabel: 'Export',
      print: 'Print',
      previous: 'Previous',
      next: 'Next',
      approve: 'Approve',
      reject: 'Reject',
      delete: 'Delete',
      edit: 'Edit',
      view: 'View',
      add: 'Add',

      company: 'Company',
      date: 'Date',
      currency: 'Currency',
      amount: 'Amount',
      total: 'Total',
      note: 'Note',
      status: 'Status',
      atTime: 'at',
      // Shared across pages
      navPurchaseRequest: 'Đề Nghị Mua Hàng',
      navAcceptance: 'Biên Bản Nghiệm Thu',
      navPaymentRequest: 'Đề Nghị Thanh Toán',
      // Keep Vietnamese — official workflow name (same as VI chrome)
      navVoucher: 'Phiếu Thu Chi',
      notifications: 'Notifications',
      openMenu: 'Open menu',
      myTasks: 'My tasks',
      myTaskFilterTitle: 'Show only my tasks',
      refreshListTitle: 'Refresh list',
      backToPrev: 'Back to previous page',
      skipToMain: 'Skip to content',
      toggleSidebar: 'Collapse or expand the sidebar',
      btnPrev: '\u2190 Back',
      btnNext: 'Next \u2192',
      noSignature: 'No signature yet',
      uploadSignature: 'Upload signature',
      requesterSignature: 'Requester signature',
      notSigned: 'Not signed',
      approval: 'Approval',
      optChooseCompany: '-- Select company --',
      optChoose: '-- Select --',
      optNone: '-- None --',
      addRow: 'Add row',
      colQty: 'Qty',
      colUnit: 'Unit',
      colLineTotal: 'Line total',
      statAll: 'All',
      statInProgress: 'In progress',
      statCompleted: 'Completed',
      statRejected: 'Rejected',
      sendBack: 'Send back',
      secCompanyGeneral: 'Company & General Information',
      secAttachments: 'Attachments',
      stepGoods: 'Goods',
      stepAria2: 'Step 2 — Goods',
      labelPrNo: 'Request no.:',
      labelVendorList: 'Vendor from list',
      labelVendorNew: 'Or enter a new vendor',
      labelVendorName: 'Vendor name',
      labelVendorType: 'Vendor type',
      labelVendorAddr: 'Vendor address',
      vendorInfo: 'Vendor information',
      newVendorNotice: 'New vendor not yet in the list — an admin will review it before processing',
      clearVendor: 'Clear vendor',
      optChooseVendorFirst: '-- Select a vendor first --',
      phVendorSearch: 'Type to search vendors...',
      phVendorNew: 'Vendor name if not in the list',
      backPlain: 'Back',
      stepVendor: 'Vendor',
      processing: 'Processing...',
      confirmApprove: 'Confirm approval',
      confirmReject: 'Confirm rejection',
      approverSignature: '✍️ Approver signature',
      approverSignaturePlain: 'Approver signature',
      apRequestId: 'Request no.:',
      apRequestType: 'Request type:',
      apCompany: 'Company:',
      apRequestor: 'Requester:',
      apAmount: 'Total amount:',
      apStage: 'Approval stage:',
      nextPlain: 'Next',
      requester: 'Requester',
      department: 'Department',

      loading: 'Loading...',
      saving: 'Saving...',
      noData: 'No data',
      required: 'Required',
      errorGeneric: 'Something went wrong. Please try again.',
      errorNetwork: 'Connection error. Please check your network.',
      successSaved: 'Saved successfully',
      successSubmitted: 'Submitted successfully',

      aiTitle: '✨ Ask TLC AI',
      aiWelcome: 'Hello! I can help with O2C, P2P or Cash.'
    }
  };

  /**
   * Display-only status map, keyed by the exact Vietnamese value stored in
   * Sheets. Never use this for comparisons — only for rendering.
   */
  var statusMap = {
    'Chờ duyệt': { vi: 'Chờ duyệt', en: 'Pending' },
    'Chờ xác nhận': { vi: 'Chờ xác nhận', en: 'Awaiting Confirmation' },
    'Đã duyệt': { vi: 'Đã duyệt', en: 'Approved' },
    'Đã xác nhận': { vi: 'Đã xác nhận', en: 'Confirmed' },
    'Đã nghiệm thu': { vi: 'Đã nghiệm thu', en: 'Accepted' },
    'Từ chối': { vi: 'Từ chối', en: 'Rejected' },
    'Trả lại': { vi: 'Trả lại', en: 'Returned' },
    'Đang xử lý': { vi: 'Đang xử lý', en: 'In Progress' },
    'Hoàn thành': { vi: 'Hoàn thành', en: 'Completed' },
    'Đã hủy': { vi: 'Đã hủy', en: 'Cancelled' },
    'Nháp': { vi: 'Nháp', en: 'Draft' },
    'Đã thanh toán': { vi: 'Đã thanh toán', en: 'Paid' },
    'Đã từ chối': { vi: 'Đã từ chối', en: 'Rejected' },
    'Đã nhận': { vi: 'Đã nhận', en: 'Received' },
    'Đã thu': { vi: 'Đã thu', en: 'Received' },
    // Composite progress badges from formatApprovalStatusText().
    'Chờ Duyệt': { vi: 'Chờ Duyệt', en: 'Pending' },
    'Đang Duyệt': { vi: 'Đang Duyệt', en: 'In Review' },
    'Đã Duyệt': { vi: 'Đã Duyệt', en: 'Approved' },
    'Đang chờ phê duyệt': { vi: 'Đang chờ phê duyệt', en: 'Awaiting approval' },
    // English values already present in some backend rows.
    Pending: { vi: 'Chờ duyệt', en: 'Pending' },
    Approved: { vi: 'Đã duyệt', en: 'Approved' },
    Rejected: { vi: 'Từ chối', en: 'Rejected' }
  };

  // -------------------------------------------------------------- accessors

  function getLang() {
    if (currentLang === null) currentLang = detectLang();
    return currentLang;
  }

  /** Look up a key. Falls back to the vi table, then `fallback`, then the key. */
  function t(key, fallback) {
    var lang = getLang();
    var table = strings[lang] || strings[DEFAULT_LANG];
    if (table && table[key] != null) return table[key];

    var base = strings[DEFAULT_LANG];
    if (base && base[key] != null) return base[key];

    return fallback != null ? fallback : key;
  }

  /**
   * Translate a status for DISPLAY only. Unknown values pass through unchanged.
   *
   * Handles the composite badges used by the voucher list, which carry a
   * progress counter — 'Đã Duyệt (3/3)' -> 'Approved (3/3)'. Matching is
   * case-insensitive because the same status appears with different casing
   * ('Đã duyệt' from the backend, 'Đã Duyệt' from formatApprovalStatusText).
   */
  function tStatus(status) {
    if (status == null || status === '') return status;

    var raw = String(status).trim();
    var lang = getLang();

    var direct = statusMap[raw];
    if (direct) return direct[lang] || raw;

    // Split a trailing counter/qualifier, e.g. 'Đang Duyệt (2/3)'.
    var m = raw.match(/^(.*?)\s*(\([^)]*\))\s*$/);
    var base = m ? m[1].trim() : raw;
    var suffix = m ? ' ' + m[2] : '';

    var key = lookupCaseInsensitive(base);
    if (!key) return status;

    var translated = statusMap[key][lang] || base;
    return translated + suffix;
  }

  var lowerIndex = null;

  function lookupCaseInsensitive(value) {
    if (lowerIndex === null) {
      lowerIndex = {};
      Object.keys(statusMap).forEach(function (k) {
        lowerIndex[k.toLowerCase()] = k;
      });
    }
    return lowerIndex[value.toLowerCase()] || null;
  }

  /** Merge page-specific strings: extend({vi: {...}, en: {...}}). */
  function extend(extra) {
    if (!extra) return;
    SUPPORTED.forEach(function (lang) {
      if (!extra[lang]) return;
      if (!strings[lang]) strings[lang] = {};
      Object.keys(extra[lang]).forEach(function (key) {
        strings[lang][key] = extra[lang][key];
      });
    });
  }

  // ---------------------------------------------------------------- render

  var ATTR_TARGETS = [
    { attr: 'data-i18n', apply: setText },
    { attr: 'data-i18n-html', apply: setHtml },
    { attr: 'data-i18n-placeholder', apply: setProp('placeholder') },
    { attr: 'data-i18n-title', apply: setProp('title') },
    { attr: 'data-i18n-aria', apply: setAttr('aria-label') },
    { attr: 'data-i18n-value', apply: setProp('value') }
  ];

  function setText(el, value) {
    el.textContent = value;
  }

  // Only for keys whose translations intentionally contain markup.
  function setHtml(el, value) {
    el.innerHTML = value;
  }

  function setProp(prop) {
    return function (el, value) {
      el[prop] = value;
    };
  }

  function setAttr(name) {
    return function (el, value) {
      el.setAttribute(name, value);
    };
  }

  /**
   * Paint every tagged element under `root`. Elements keep their original
   * inline text as the fallback, so an unknown key never blanks the UI.
   */
  function apply(root) {
    var scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return;

    ATTR_TARGETS.forEach(function (target) {
      var nodes = scope.querySelectorAll('[' + target.attr + ']');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var key = el.getAttribute(target.attr);
        if (!key) continue;

        // Remember the authored text so we can fall back to it forever.
        var cacheAttr = 'data-i18n-orig-' + target.attr;
        if (!el.hasAttribute(cacheAttr)) {
          var original =
            target.attr === 'data-i18n' ? el.textContent
              : target.attr === 'data-i18n-html' ? el.innerHTML
                : target.attr === 'data-i18n-aria' ? el.getAttribute('aria-label')
                  : el[target.attr.replace('data-i18n-', '')];
          el.setAttribute(cacheAttr, original == null ? '' : original);
        }

        target.apply(el, t(key, el.getAttribute(cacheAttr)));
      }
    });
  }

  /** Keep every EN/VI switcher on the page in sync. */
  function syncSwitchers(lang) {
    var doc = global.document;
    if (!doc || !doc.querySelectorAll) return;

    // Preferred markup: <button data-lang="en">. Legacy: id="lang-en".
    var buttons = doc.querySelectorAll('[data-lang]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var btnLang = btn.getAttribute('data-lang');
      if (!isSupported(btnLang)) continue;
      var active = btnLang === lang;
      // classList.toggle preserves ios-segmented-item; never reassign className.
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    SUPPORTED.forEach(function (code) {
      var legacy = doc.getElementById('lang-' + code);
      if (!legacy || legacy.hasAttribute('data-lang')) return;
      var isActive = code === lang;
      legacy.classList.toggle('active', isActive);
      legacy.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  /**
   * Inject switcher styles so pages without the iOS design system still get a
   * correctly-styled control. Scoped under [data-tlc-i18n-css] and written so
   * pages that already define .ios-segmented keep their own look.
   */
  function injectStyles() {
    var doc = global.document;
    if (!doc || !doc.head || doc.getElementById('tlc-i18n-styles')) return;

    var css =
      '.tlc-lang-switch{display:inline-flex;background:rgba(118,118,128,0.12);' +
      'border-radius:8px;padding:2px;gap:0;}' +
      '.tlc-lang-switch button{flex:1;padding:4px 10px;font-size:12px;' +
      'font-weight:600;text-align:center;border:none;background:transparent;' +
      'color:#1c1c1e;cursor:pointer;border-radius:6px;line-height:1.4;' +
      'transition:background-color .2s,box-shadow .2s;}' +
      '.tlc-lang-switch button.active{background:#fff;' +
      'box-shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.08);}' +
      '.tlc-lang-switch button:focus-visible{outline:2px solid #007AFF;' +
      'outline-offset:2px;}';

    var style = doc.createElement('style');
    style.id = 'tlc-i18n-styles';
    style.textContent = css;
    doc.head.appendChild(style);
  }

  var listeners = [];

  /** Register a callback to re-render dynamic content after a change. */
  function onChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  function setLanguage(lang) {
    if (!isSupported(lang)) lang = DEFAULT_LANG;

    currentLang = lang;
    writeStored(lang);

    var doc = global.document;
    if (doc && doc.documentElement) doc.documentElement.lang = lang;

    apply();
    syncSwitchers(lang);

    listeners.forEach(function (fn) {
      // One bad listener must not stop the rest of the page updating.
      try {
        fn(lang);
      } catch (e) {
        if (global.console) global.console.error('[i18n] listener failed:', e);
      }
    });

    return lang;
  }

  /**
   * Build an EN/VI switcher and prepend it to `target` (element or selector).
   * Used by pages that have a nav but no iOS segmented control of their own.
   * No-op if that container already holds a switcher.
   */
  function mountSwitcher(target) {
    var doc = global.document;
    if (!doc) return null;

    var host = typeof target === 'string' ? doc.querySelector(target) : target;
    if (!host || host.querySelector('.tlc-lang-switch')) return null;

    var wrap = doc.createElement('div');
    wrap.className = 'tlc-lang-switch';

    SUPPORTED.forEach(function (code) {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-lang', code);
      btn.textContent = code.toUpperCase();
      btn.setAttribute(
        'aria-label',
        code === 'en' ? 'Switch to English' : 'Switch to Vietnamese'
      );
      btn.addEventListener('click', function () {
        setLanguage(code);
      });
      wrap.appendChild(btn);
    });

    host.insertBefore(wrap, host.firstChild);
    syncSwitchers(getLang());
    return wrap;
  }

  /**
   * Stamp the current language onto outgoing JSON POST bodies so the backend
   * can localise its response messages (see msg_() in the .gs backends).
   *
   * Done once here rather than at ~25 call sites. Deliberately conservative:
   * only same-origin-style JSON string bodies that already look like an action
   * payload are touched, an existing `lang` is never overwritten, and any
   * parse failure leaves the request byte-for-byte unchanged.
   */
  function installFetchLangStamp() {
    if (!global.fetch || global.__tlcI18nFetchPatched) return;
    global.__tlcI18nFetchPatched = true;

    var nativeFetch = global.fetch.bind(global);

    // Add lang to a JSON action payload; returns null if it isn't one.
    function stampJson(text) {
      if (typeof text !== 'string' || text.indexOf('"action"') === -1) return null;
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        return null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (parsed.lang != null) return null;
      parsed.lang = getLang();
      return JSON.stringify(parsed);
    }

    global.fetch = function (input, init) {
      try {
        if (init && init.body) {
          var body = init.body;

          // Plain JSON body.
          var stamped = stampJson(body);
          if (stamped !== null) {
            init = Object.assign({}, init, { body: stamped });
          } else if (
            global.FormData && body instanceof global.FormData &&
            typeof body.get === 'function' && typeof body.set === 'function'
          ) {
            // Multipart upload: the payload rides in a `data` field.
            var inner = stampJson(body.get('data'));
            if (inner !== null) body.set('data', inner);
          }
        }
      } catch (e) {
        /* not ours — send the original request untouched */
      }
      try {
        init = withLoginToken(input, init);
      } catch (e) {
        /* never block a request over the token */
      }
      return nativeFetch(input, init);
    };
  }

  /**
   * Same-origin /api/ calls carry the signed-in user's token, so the server
   * knows who is acting instead of trusting emails sent in the body. Never
   * added to other origins (a custom header would trigger a CORS preflight
   * that Apps Script cannot answer).
   */
  function withLoginToken(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var loc = global.location;
    if (!loc || !url) return init;
    var target;
    try { target = new URL(url, loc.href); } catch (e) { return init; }
    if (target.origin !== loc.origin || target.pathname.indexOf('/api/') !== 0) return init;
    var token = '';
    try {
      var user = JSON.parse(global.localStorage.getItem('tlc_current_user') || 'null');
      token = (user && user.token) || '';
    } catch (e) { return init; }
    if (!token) return init;
    var headers = new global.Headers((init && init.headers) || (typeof input !== 'string' && input.headers) || undefined);
    if (headers.has('Authorization')) return init;
    headers.set('Authorization', 'Bearer ' + token);
    return Object.assign({}, init || {}, { headers: headers });
  }

  /** Apply the resolved language on load without overwriting the stored one. */
  function init() {
    injectStyles();

    // Pages opt in declaratively with <div data-tlc-lang-switcher></div> or by
    // marking an existing nav container.
    var doc = global.document;
    if (doc && doc.querySelectorAll) {
      var hosts = doc.querySelectorAll('[data-tlc-lang-switcher]');
      for (var i = 0; i < hosts.length; i++) mountSwitcher(hosts[i]);
    }

    setLanguage(getLang());
  }

  var TLCI18n = {
    getLang: getLang,
    setLanguage: setLanguage,
    t: t,
    tStatus: tStatus,
    apply: apply,
    extend: extend,
    onChange: onChange,
    mountSwitcher: mountSwitcher,
    init: init,
    STORAGE_KEY: STORAGE_KEY,
    SUPPORTED: SUPPORTED
  };

  global.TLCI18n = TLCI18n;

  // Existing inline handlers call setLanguage('en') directly.
  global.setLanguage = setLanguage;

  // Patch fetch at load, not in init(): a page may fire a request before
  // DOMContentLoaded, and those must carry the language too.
  installFetchLangStamp();

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})(typeof window !== 'undefined' ? window : this);
