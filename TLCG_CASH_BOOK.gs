/**
 * Cash book — Bảng kiểm kê quỹ
 *
 * Second .gs file in the same Cash Apps Script project as TLCG_CASH_BACKEND.gs.
 * doPost in that file routes getCashBook, getCashCount, and saveCashCount here.
 * Do not paste this file into Core or P2P. Do not create a second web app.
 * After adding this file in the Cash project (+), redeploy the existing web app
 * (Execute as: Me).
 */

// ── Cash book (Bảng kiểm kê quỹ) ─────────────────────────────────────────

var CASH_COUNT_SHEET = 'Cash_Count';
var CASH_COUNT_HEADERS = [
  'company_key', 'company_name', 'end_date', 'count_hour', 'count_minute',
  'quantities', 'book_balance', 'counted_total', 'reason_thua', 'reason_thieu',
  'conclusion', 'reps', 'saved_by_email', 'saved_at', 'row_status'
];
var CASH_BOOK_ROLES = [
  { key: 'keToan', label: 'Đại diện kế toán' },
  { key: 'keToanTruong', label: 'Kế toán trưởng' },
  { key: 'thuQuy', label: 'Thủ quỹ' },
  { key: 'giamDoc', label: 'Giám đốc' }
];

function cashBookNorm_(value) {
  return String(value || '').trim().toLowerCase();
}

function cashBookAmount_(value) {
  if (typeof value === 'number') return isFinite(value) ? value : NaN;
  var s = String(value || '').trim();
  if (!s) return NaN;
  var n = parseFloat(s.replace(/\./g, '').replace(/,/g, '.'));
  return isFinite(n) ? n : NaN;
}

function cashBookYmd_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
  }
  var s = String(value || '').trim();
  if (!s) return '';
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    var dd = ('0' + dmy[1]).slice(-2);
    var mm = ('0' + dmy[2]).slice(-2);
    return dmy[3] + '-' + mm + '-' + dd;
  }
  return '';
}

function cashBookToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Ho_Chi_Minh', 'yyyy-MM-dd');
}

function cashBookType_(raw) {
  var s = String(raw || '').toUpperCase();
  if (s.indexOf('THU') !== -1) return 'Thu';
  if (s.indexOf('CHI') !== -1) return 'Chi';
  return '';
}

function cashBookBucket_(status, action) {
  var s = String(status || '').trim();
  var a = String(action || '').trim();
  if (s === 'Rejected' || s === 'Đã từ chối' || a === 'Rejected' || a === 'Đã từ chối') return 'out';
  if (s === 'Received' || s === 'Đã duyệt' || s === 'Approved' || s === 'Fully Approved') return 'book';
  if (s === 'Pending' || s === 'Đang treo' || s === 'Chờ duyệt' || s === 'Đang duyệt (1/3)' || s === 'Đang duyệt (2/3)') return 'pending';
  return 'out';
}

function cashBookCompanyHit_(rowName, rowKey, companyName, companyKey) {
  var key = String(rowKey || '').trim();
  if (key) return !!companyKey && key === String(companyKey).trim();
  return cashBookNorm_(rowName) === cashBookNorm_(companyName);
}

function cashBookFindCompany_(companyName, companyKey) {
  var ss = safeOpenSpreadsheet(TLCG_MASTER_DATA_SHEET_ID, 'cashBookFindCompany_');
  var sheet = safeGetSheet(ss, COMPANY_SHEET_NAME, 'cashBookFindCompany_');
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var searchKey = String(companyKey || '').trim();
  var searchName = cashBookNorm_(companyName);
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rowName = String(row[0] || '').trim();
    var rowKey = String(row[2] || '').trim();
    var hit = searchKey ? rowKey === searchKey : cashBookNorm_(rowName) === searchName;
    if (hit) return row;
  }
  return null;
}

function cashBookCompanyMiss_(companyName, companyKey) {
  var sent = String(companyKey || '').trim();
  var keys = [];
  try {
    var ss = safeOpenSpreadsheet(TLCG_MASTER_DATA_SHEET_ID, 'cashBookCompanyMiss_');
    var sheet = safeGetSheet(ss, COMPANY_SHEET_NAME, 'cashBookCompanyMiss_');
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      var searchName = cashBookNorm_(companyName);
      for (var i = 1; i < data.length; i++) {
        var rowName = String(data[i][0] || '').trim();
        var rowKey = String(data[i][2] || '').trim();
        if (rowKey && cashBookNorm_(rowName) === searchName) keys.push(rowKey);
      }
    }
  } catch (err) {}
  var msg = 'Không tìm thấy công ty: ' + companyName;
  if (sent) msg += ' (' + sent + ')';
  if (keys.length) msg += '. Mã trên sổ: ' + keys.join(', ');
  return msg;
}

function cashBookReadEmployees_() {
  var ss = safeOpenSpreadsheet(USERS_SHEET_ID, 'cashBookReadEmployees_');
  var sheet = safeGetSheet(ss, EMPLOYEES_SHEET_NAME, 'cashBookReadEmployees_');
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var status = String(row[6] || '').trim();
    if (status && status !== 'Active') continue;
    out.push({
      name: String(row[0] || '').trim(),
      position: String(row[1] || '').trim(),
      department: String(row[2] || '').trim(),
      company: String(row[3] || '').trim(),
      email: String(row[4] || '').trim(),
      isAdmin: row[9] === true || String(row[9] || '').toUpperCase() === 'TRUE'
    });
  }
  return out;
}

function cashBookEmployeeOfCompany_(employee, companyRow) {
  var company = cashBookNorm_(employee.company);
  if (!company) return false;
  var names = [companyRow[0], companyRow[1], companyRow[14]];
  for (var i = 0; i < names.length; i++) {
    if (company === cashBookNorm_(names[i])) return true;
  }
  return false;
}

function cashBookMaySave_(callerEmail, companyRow, employees, repEmail) {
  var email = cashBookNorm_(callerEmail);
  if (!email || !companyRow) return false;
  var isAdmin = false;
  var ofCompany = false;
  for (var i = 0; i < employees.length; i++) {
    if (cashBookNorm_(employees[i].email) !== email) continue;
    if (employees[i].isAdmin) isAdmin = true;
    if (cashBookEmployeeOfCompany_(employees[i], companyRow)) ofCompany = true;
  }
  if (isAdmin) return true;
  var masters = [companyRow[8], companyRow[12], companyRow[4]];
  for (var m = 0; m < masters.length; m++) {
    if (email === cashBookNorm_(masters[m])) return true;
  }
  return email === cashBookNorm_(repEmail) && ofCompany;
}

function cashBookEnsureSheet_() {
  var ss = safeOpenSpreadsheet(VOUCHER_HISTORY_SHEET_ID, 'cashBookEnsureSheet_');
  var sheet = ss.getSheetByName(CASH_COUNT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CASH_COUNT_SHEET);
    sheet.getRange(1, 1, 1, CASH_COUNT_HEADERS.length).setValues([CASH_COUNT_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  if (String(sheet.getRange(1, 1).getValue() || '') !== 'company_key') {
    sheet.getRange(1, 1, 1, CASH_COUNT_HEADERS.length).setValues([CASH_COUNT_HEADERS]);
  }
  return sheet;
}

function cashBookCountKey_(companyRow, companyName) {
  var key = String(companyRow[2] || '').trim();
  return key || String(companyName || '').trim();
}

function cashBookLine_(group) {
  var row = group.row;
  return {
    voucherNumber: String(row[0] || '').trim(),
    createdDate: group.firstYmd,
    type: cashBookType_(row[1]),
    description: String(row[13] || '').trim(),
    amount: cashBookAmount_(row[8]),
    status: String(row[9] || '').trim()
  };
}

function handleGetCashBook(requestBody) {
  try {
    var companyName = String((requestBody && (requestBody.companyName || requestBody.company)) || '').trim();
    var companyKey = String((requestBody && requestBody.companyKey) || '').trim();
    var startDate = cashBookYmd_(requestBody && requestBody.startDate);
    var endDate = cashBookYmd_(requestBody && requestBody.endDate);
    var callerEmail = String((requestBody && requestBody.callerEmail) || '').trim();
    if (!companyName || !endDate) return createResponse(false, 'Chọn công ty và ngày kết thúc.');
    if (endDate > cashBookToday_()) return createResponse(false, 'Ngày kết thúc không được ở tương lai.');
    if (startDate && startDate > cashBookToday_()) return createResponse(false, 'Ngày bắt đầu không được ở tương lai.');
    if (startDate && startDate > endDate) return createResponse(false, 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.');

    var companyRow = cashBookFindCompany_(companyName, companyKey);
    if (!companyRow) return createResponse(false, cashBookCompanyMiss_(companyName, companyKey));

    var ss = safeOpenSpreadsheet(VOUCHER_HISTORY_SHEET_ID, 'handleGetCashBook');
    var sheet = safeGetSheet(ss, VH_SHEET_NAME, 'handleGetCashBook');
    if (!sheet) return createResponse(false, msg_('sheetMissingCash', VH_SHEET_NAME));
    if (typeof ensureVoucherHistoryHeaders_ === 'function') ensureVoucherHistoryHeaders_(sheet);

    var lastRow = sheet.getLastRow();
    var groups = {};
    if (lastRow >= 2) {
      var values = sheet.getRange(2, 1, lastRow - 1, 14).getValues();
      for (var i = 0; i < values.length; i++) {
        var row = values[i];
        var vnum = String(row[0] || '').trim();
        if (!vnum) continue;
        var ymd = cashBookYmd_(row[7]);
        if (!groups[vnum]) {
          groups[vnum] = { firstYmd: ymd, row: row };
        } else {
          if (ymd && (!groups[vnum].firstYmd || ymd < groups[vnum].firstYmd)) groups[vnum].firstYmd = ymd;
          groups[vnum].row = row;
        }
      }
    }

    var bookLines = [];
    var pendingLines = [];
    var bookThu = 0;
    var bookChi = 0;
    var pendingThu = 0;
    var pendingChi = 0;
    Object.keys(groups).forEach(function(vnum) {
      var group = groups[vnum];
      var row = group.row;
      if (!cashBookCompanyHit_(row[2], row[3], companyName, companyKey || String(companyRow[2] || '').trim())) return;
      if (!group.firstYmd || group.firstYmd > endDate) return;
      if (startDate && group.firstYmd < startDate) return;
      var type = cashBookType_(row[1]);
      var amount = cashBookAmount_(row[8]);
      if (!type || !(amount > 0)) return;
      var bucket = cashBookBucket_(row[9], row[11]);
      if (bucket === 'out') return;
      var line = cashBookLine_(group);
      if (bucket === 'book') {
        bookLines.push(line);
        if (type === 'Thu') bookThu += amount;
        else bookChi += amount;
      } else {
        pendingLines.push(line);
        if (type === 'Thu') pendingThu += amount;
        else pendingChi += amount;
      }
    });

    bookLines.sort(function(a, b) { return a.createdDate < b.createdDate ? 1 : -1; });
    pendingLines.sort(function(a, b) { return a.createdDate < b.createdDate ? 1 : -1; });

    var employees = cashBookReadEmployees_();
    var repEmail = requestBody && requestBody.repEmail;
    return createResponse(true, 'Thành công', {
      bookLines: bookLines,
      bookBalance: bookThu - bookChi,
      bookThu: bookThu,
      bookChi: bookChi,
      bookCount: bookLines.length,
      pendingLines: pendingLines,
      pendingThu: pendingThu,
      pendingChi: pendingChi,
      pendingNet: pendingThu - pendingChi,
      canSave: cashBookMaySave_(callerEmail, companyRow, employees, repEmail),
      companyKey: String(companyRow[2] || '').trim(),
      companyName: String(companyRow[0] || '').trim()
    });
  } catch (error) {
    Logger.log('❌ handleGetCashBook: ' + error);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

function cashBookReadCountRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, CASH_COUNT_HEADERS.length).getValues();
}

function handleGetCashCount(requestBody) {
  try {
    var companyName = String((requestBody && (requestBody.companyName || requestBody.company)) || '').trim();
    var companyKey = String((requestBody && requestBody.companyKey) || '').trim();
    var endDate = cashBookYmd_(requestBody && requestBody.endDate);
    if (!companyName || !endDate) return createResponse(false, 'Chọn công ty và ngày kết thúc.');
    var companyRow = cashBookFindCompany_(companyName, companyKey);
    if (!companyRow) return createResponse(false, cashBookCompanyMiss_(companyName, companyKey));
    var key = cashBookCountKey_(companyRow, companyName);
    var sheet = cashBookEnsureSheet_();
    var rows = cashBookReadCountRows_(sheet);
    var found = null;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][0] || '').trim() !== key) continue;
      if (cashBookYmd_(rows[i][2]) !== endDate) continue;
      if (String(rows[i][14] || '').trim() !== 'current') continue;
      found = rows[i];
    }
    if (!found) return createResponse(true, 'Thành công', { count: null });
    var reps = [];
    try { reps = JSON.parse(String(found[11] || '[]')); } catch (e) { reps = []; }
    var quantities = [];
    try { quantities = JSON.parse(String(found[5] || '[]')); } catch (e2) { quantities = []; }
    return createResponse(true, 'Thành công', {
      count: {
        companyKey: key,
        companyName: String(found[1] || ''),
        endDate: endDate,
        countHour: Number(found[3]),
        countMinute: Number(found[4]),
        quantities: quantities,
        bookBalance: Number(found[6]) || 0,
        countedTotal: Number(found[7]) || 0,
        reasonThua: String(found[8] || ''),
        reasonThieu: String(found[9] || ''),
        conclusion: String(found[10] || ''),
        reps: reps,
        savedByEmail: String(found[12] || ''),
        savedAt: String(found[13] || '')
      }
    });
  } catch (error) {
    Logger.log('❌ handleGetCashCount: ' + error);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

function cashBookMarkReplaced_(sheet, key, endDate, keepRow) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var rows = sheet.getRange(2, 1, last - 1, CASH_COUNT_HEADERS.length).getValues();
  var currents = [];
  for (var i = 0; i < rows.length; i++) {
    var sheetRow = i + 2;
    if (keepRow && sheetRow === keepRow) continue;
    if (String(rows[i][0] || '').trim() !== key) continue;
    if (cashBookYmd_(rows[i][2]) !== endDate) continue;
    if (String(rows[i][14] || '').trim() !== 'current') continue;
    currents.push({ sheetRow: sheetRow, savedAt: String(rows[i][13] || '') });
  }
  currents.forEach(function(item) {
    sheet.getRange(item.sheetRow, 15).setValue('replaced');
  });
}

function cashBookStoreSignature_(dataUrl, url, fileName) {
  var existing = String(url || '').trim();
  var incoming = String(dataUrl || '').trim();
  if (incoming.indexOf('data:') === 0) {
    var mime = 'image/jpeg';
    var match = incoming.match(/^data:([^;]+);base64,/);
    if (match) mime = match[1];
    var uploaded = uploadFilesToDrive_([{
      fileName: fileName,
      fileData: incoming,
      mimeType: mime
    }], 'Cash_Count');
    if (!uploaded || !uploaded[0] || uploaded[0].error || !uploaded[0].fileUrl) {
      throw new Error((uploaded && uploaded[0] && uploaded[0].errorMessage) || 'Không lưu được chữ ký.');
    }
    return uploaded[0].fileUrl;
  }
  return existing;
}

function handleSaveCashCount(requestBody) {
  try {
    var body = requestBody || {};
    var companyName = String(body.companyName || body.company || '').trim();
    var companyKey = String(body.companyKey || '').trim();
    var endDate = cashBookYmd_(body.endDate);
    var callerEmail = String(body.callerEmail || '').trim();
    var hour = Number(body.countHour);
    var minute = Number(body.countMinute);
    if (!companyName || !endDate) return createResponse(false, 'Chọn công ty và ngày kết thúc.');
    if (endDate > cashBookToday_()) return createResponse(false, 'Ngày kết thúc không được ở tương lai.');
    if (!isFinite(hour) || hour < 0 || hour > 23 || !isFinite(minute) || minute < 0 || minute > 59 || Math.floor(hour) !== hour || Math.floor(minute) !== minute) {
      return createResponse(false, 'Giờ phải từ 0 đến 23 và phút từ 0 đến 59.');
    }

    var companyRow = cashBookFindCompany_(companyName, companyKey);
    if (!companyRow) return createResponse(false, cashBookCompanyMiss_(companyName, companyKey));
    var employees = cashBookReadEmployees_();
    var repsIn = body.reps || [];
    var repEmail = repsIn[0] && repsIn[0].email;
    if (!cashBookMaySave_(callerEmail, companyRow, employees, repEmail)) {
      return createResponse(false, 'Chỉ người đại diện của công ty này mới lưu được bảng kiểm kê.');
    }

    var quantities = body.quantities || [];
    if (!quantities || quantities.length !== 10) return createResponse(false, 'Nhập đủ 10 mệnh giá.');
    var qty = [];
    for (var q = 0; q < 10; q++) {
      var n = Number(quantities[q] || 0);
      if (!isFinite(n) || n < 0 || Math.floor(n) !== n) return createResponse(false, 'Số lượng phải là số nguyên từ 0 trở lên.');
      qty.push(n);
    }

    var faces = [500000, 200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000, 500];
    var counted = 0;
    for (var f = 0; f < 10; f++) counted += qty[f] * faces[f];

    var storedReps = [];
    var seenSig = {};
    for (var r = 0; r < CASH_BOOK_ROLES.length; r++) {
      var role = CASH_BOOK_ROLES[r];
      var src = repsIn[r] || {};
      var name = String(src.name || '').trim();
      var email = String(src.email || '').trim();
      if (!name) return createResponse(false, 'Còn thiếu tên ' + role.label + '.');
      var sigUrl = String(src.signatureUrl || '').trim();
      if (email && seenSig[cashBookNorm_(email)]) sigUrl = seenSig[cashBookNorm_(email)];
      sigUrl = cashBookStoreSignature_(src.signatureData, sigUrl, 'cash-count-' + endDate + '-' + role.key + '.jpg');
      if (!sigUrl) return createResponse(false, 'Còn thiếu chữ ký ' + role.label + '.');
      if (email) seenSig[cashBookNorm_(email)] = sigUrl;
      storedReps.push({ role: role.key, name: name, email: email, signatureUrl: sigUrl });
    }

    var key = cashBookCountKey_(companyRow, companyName);
    var sheet = cashBookEnsureSheet_();
    cashBookMarkReplaced_(sheet, key, endDate, null);
    var savedAt = new Date().toISOString();
    sheet.appendRow([
      key,
      String(companyRow[0] || companyName),
      endDate,
      hour,
      minute,
      JSON.stringify(qty),
      Number(body.bookBalance) || 0,
      counted,
      String(body.reasonThua || ''),
      String(body.reasonThieu || ''),
      String(body.conclusion || ''),
      JSON.stringify(storedReps),
      callerEmail,
      savedAt,
      'current'
    ]);
    var newRow = sheet.getLastRow();
    cashBookMarkReplaced_(sheet, key, endDate, newRow);
    return createResponse(true, 'Đã lưu bảng kiểm kê.', { savedAt: savedAt });
  } catch (error) {
    Logger.log('❌ handleSaveCashCount: ' + error);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}

function handleGetCashBookSummary() {
  try {
    var ss = safeOpenSpreadsheet(VOUCHER_HISTORY_SHEET_ID, 'handleGetCashBookSummary');
    var sheet = ss.getSheetByName(CASH_COUNT_SHEET);
    if (!sheet || sheet.getLastRow() < 2) {
      return createResponse(true, 'Thành công', { currentCounts: 0, companyCount: 0, latestEndDate: '', latestSavedAt: '' });
    }
    var rows = cashBookReadCountRows_(sheet);
    var companies = {};
    var current = 0;
    var latestSaved = '';
    var latestEnd = '';
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][14] || '').trim() !== 'current') continue;
      current++;
      var key = String(rows[i][0] || '').trim();
      if (key) companies[key] = true;
      var savedAt = String(rows[i][13] || '');
      if (savedAt >= latestSaved) {
        latestSaved = savedAt;
        latestEnd = cashBookYmd_(rows[i][2]);
      }
    }
    return createResponse(true, 'Thành công', {
      currentCounts: current,
      companyCount: Object.keys(companies).length,
      latestEndDate: latestEnd,
      latestSavedAt: latestSaved
    });
  } catch (error) {
    Logger.log('❌ handleGetCashBookSummary: ' + error);
    return createResponse(false, msg_('errGeneric') + error.message);
  }
}
