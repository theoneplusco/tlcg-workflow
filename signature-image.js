// signature-image.js — turn a chosen signature photo/scan into the PNG sent to saveMySignature / adminSaveSignature:
// drawn on white, at most 900×400 px (keeps the aspect), PNG; JPEG if the PNG would still be over ~700 KB.
// The server re-checks type and size (api/lib/approval/signature-store.js). Plain <script>, no dependencies.
(function (root) {
  'use strict';
  var MAX_W = 900, MAX_H = 400, MAX_CHARS = 700 * 1024 * 4 / 3; // ~700 KB decoded, as base64 characters

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(new Error('Không đọc được tệp ảnh.')); };
      r.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Tệp này không phải ảnh hợp lệ.')); };
      img.src = src;
    });
  }

  /** File → data URL (PNG, or JPEG for very detailed photos). Rejects with a Vietnamese message. */
  function fromFile(file) {
    if (!file) return Promise.reject(new Error('Vui lòng chọn ảnh chữ ký.'));
    if (!/^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.type || '')) return Promise.reject(new Error('Chữ ký phải là ảnh (PNG hoặc JPG).'));
    if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error('Ảnh quá lớn (tối đa 15 MB trước khi thu nhỏ).'));
    return readAsDataUrl(file).then(loadImage).then(function (img) {
      var scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
      var w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      var png = canvas.toDataURL('image/png');
      if (png.length <= MAX_CHARS) return png;
      var jpg = canvas.toDataURL('image/jpeg', 0.85);
      if (jpg.length <= MAX_CHARS) return jpg;
      throw new Error('Ảnh chữ ký quá lớn sau khi thu nhỏ. Vui lòng chụp lại gọn hơn.');
    });
  }

  root.SignatureImage = { fromFile: fromFile };
})(typeof self !== 'undefined' ? self : this);
