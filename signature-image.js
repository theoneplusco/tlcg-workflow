// signature-image.js — turn a chosen signature photo/scan into the PNG sent to saveMySignature / adminSaveSignature.
// The paper becomes transparent (only the ink is kept), the image is cropped to the ink and fits 900×400 px, so the
// stamped signature prints cleanly over lines and stamps. The server re-checks type and size
// (api/lib/approval/signature-store.js). Plain <script>, no dependencies; transparentInk is also used by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignatureImage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_W = 900, MAX_H = 400;          // final size
  var WORK_W = 1800, WORK_H = 800;       // working size (big photos are scaled down first)
  var MAX_CHARS = 700 * 1024 * 4 / 3;    // ~700 KB decoded, as base64 characters
  var PAD = 12;                          // margin kept around the ink, px (working size)

  function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  /**
   * In place on RGBA pixels: the paper becomes transparent, the ink keeps its look on white.
   * The paper level is the median brightness of the image's border; pixels within ~25 of it vanish, pixels ~110
   * darker stay fully opaque, with a soft ramp between (smooth strokes). Returns the ink's bounding box or null.
   */
  function transparentInk(px, w, h) {
    var border = [];
    var edge = Math.max(2, Math.round(Math.min(w, h) * 0.03));
    for (var y = 0; y < h; y += 1) {
      for (var x = 0; x < w; x += 1) {
        if (x >= edge && x < w - edge && y >= edge && y < h - edge) { x = w - edge - 1; continue; }
        var i = (y * w + x) * 4, a = px[i + 3] / 255;
        border.push(lum(px[i], px[i + 1], px[i + 2]) * a + 255 * (1 - a)); // as seen on white
      }
    }
    border.sort(function (p, q) { return p - q; });
    var paper = border.length ? border[Math.floor(border.length / 2)] : 255;
    var hi = paper - 25, lo = Math.max(0, paper - 110);
    if (hi < 60) throw new Error('Ảnh quá tối, không tách được nền. Vui lòng chụp chữ ký trên giấy trắng, đủ sáng.');
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var p = 0; p < w * h; p += 1) {
      var k = p * 4;
      var a0 = px[k + 3] / 255;
      var r = px[k] * a0 + 255 * (1 - a0), g = px[k + 1] * a0 + 255 * (1 - a0), b = px[k + 2] * a0 + 255 * (1 - a0);
      var L = lum(r, g, b);
      var alpha = L >= hi ? 0 : L <= lo ? 1 : (hi - L) / (hi - lo);
      if (alpha <= 0) { px[k] = px[k + 1] = px[k + 2] = px[k + 3] = 0; continue; }
      // Colour that looks the same on white at this opacity: alpha*c + (1-alpha)*255 = original
      px[k] = Math.max(0, Math.min(255, Math.round((r - (1 - alpha) * 255) / alpha)));
      px[k + 1] = Math.max(0, Math.min(255, Math.round((g - (1 - alpha) * 255) / alpha)));
      px[k + 2] = Math.max(0, Math.min(255, Math.round((b - (1 - alpha) * 255) / alpha)));
      px[k + 3] = Math.round(alpha * 255);
      if (px[k + 3] > 24) {
        var xx = p % w, yy = (p - xx) / w;
        if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      }
    }
    if (maxX < 0 || maxX - minX < 8 || maxY - minY < 4) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

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

  /** File → transparent PNG data URL of the ink only. Rejects with a Vietnamese message. */
  function fromFile(file) {
    if (!file) return Promise.reject(new Error('Vui lòng chọn ảnh chữ ký.'));
    if (!/^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.type || '')) return Promise.reject(new Error('Chữ ký phải là ảnh (PNG hoặc JPG).'));
    if (file.size > 15 * 1024 * 1024) return Promise.reject(new Error('Ảnh quá lớn (tối đa 15 MB trước khi thu nhỏ).'));
    return readAsDataUrl(file).then(loadImage).then(function (img) {
      var s1 = Math.min(1, WORK_W / img.naturalWidth, WORK_H / img.naturalHeight);
      var w = Math.max(1, Math.round(img.naturalWidth * s1)), h = Math.max(1, Math.round(img.naturalHeight * s1));
      var work = document.createElement('canvas');
      work.width = w; work.height = h;
      var wctx = work.getContext('2d');
      wctx.drawImage(img, 0, 0, w, h);
      var data = wctx.getImageData(0, 0, w, h);
      var box = transparentInk(data.data, w, h);
      if (!box) throw new Error('Không thấy nét chữ ký trong ảnh. Vui lòng chọn ảnh rõ hơn.');
      wctx.putImageData(data, 0, 0);
      var cx = Math.max(0, box.x - PAD), cy = Math.max(0, box.y - PAD);
      var cw = Math.min(w, box.x + box.w + PAD) - cx, ch = Math.min(h, box.y + box.h + PAD) - cy;
      for (var scale = Math.min(1, MAX_W / cw, MAX_H / ch); scale > 0.1; scale *= 0.8) {
        var out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(cw * scale)); out.height = Math.max(1, Math.round(ch * scale));
        out.getContext('2d').drawImage(work, cx, cy, cw, ch, 0, 0, out.width, out.height);
        var png = out.toDataURL('image/png');
        if (png.length <= MAX_CHARS) return png;
      }
      throw new Error('Ảnh chữ ký quá lớn sau khi thu nhỏ. Vui lòng chụp lại gọn hơn.');
    });
  }

  return { fromFile: fromFile, transparentInk: transparentInk };
});
