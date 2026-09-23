// POST /api/voucher-file
//
// Large voucher attachments. The browser sends the raw file. This server asks
// Apps Script for a Drive upload session (no file bytes), then PUTs the bytes
// straight to Drive. Apps Script only sets sharing afterwards.

import Busboy from 'busboy';

const MAX_BYTES = 10 * 1024 * 1024;

function cashBackendUrl() {
  return process.env.TLCG_CASH_BACKEND_URL ||
    process.env.VOUCHER_BACKEND_URL ||
    'https://script.google.com/macros/s/AKfycbxyzw_9y4GVkTWvDmcIWOigHI39zYphCMa0JLZUXuTKWTRedIIYETSeBluFUdJrDgbt/exec';
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_BYTES + 1 }
    });
    const fields = {};
    const chunks = [];
    let fileName = '';
    let fileMime = '';
    let tooBig = false;

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('file', (_name, stream, info) => {
      fileName = info.filename;
      fileMime = info.mimeType;
      stream.on('data', (d) => chunks.push(d));
      stream.on('limit', () => { tooBig = true; });
    });
    busboy.on('finish', () => {
      resolve({
        fields,
        fileBuffer: Buffer.concat(chunks),
        fileName,
        fileMime,
        tooBig
      });
    });
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

async function gasPost(payload) {
  const params = new URLSearchParams();
  params.set('data', JSON.stringify(payload));
  const response = await fetch(cashBackendUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error('Apps Script trả về dữ liệu không hợp lệ');
  }
  if (!response.ok || !json.success) {
    throw new Error(json.message || 'Apps Script từ chối yêu cầu');
  }
  return json.data || {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'POST only' });
  }

  try {
    const { fields, fileBuffer, fileName, fileMime, tooBig } = await parseMultipart(req);
    if (tooBig || fileBuffer.length > MAX_BYTES) {
      return res.status(400).json({ success: false, message: 'File vượt quá 10 MB' });
    }
    if (!fileBuffer.length) {
      return res.status(400).json({ success: false, message: 'Thiếu file' });
    }

    const mimeType = fileMime || 'application/octet-stream';
    const session = await gasPost({
      action: 'createVoucherUploadSession',
      fileName: fileName || 'attachment',
      mimeType,
      fileSize: fileBuffer.length,
      voucherNumber: fields.voucherNumber || ''
    });
    if (!session.uploadUrl) {
      return res.status(502).json({ success: false, message: 'Không tạo được phiên tải lên Drive' });
    }

    const put = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileBuffer.length)
      },
      body: fileBuffer
    });
    const putText = await put.text();
    if (!put.ok) {
      console.error('[voucher-file] Drive PUT', put.status, putText.slice(0, 180));
      return res.status(502).json({ success: false, message: 'Drive từ chối file' });
    }
    const created = JSON.parse(putText);
    if (!created.id) {
      return res.status(502).json({ success: false, message: 'Drive không trả về file' });
    }

    const saved = await gasPost({
      action: 'finalizeVoucherUpload',
      fileId: created.id
    });
    return res.status(200).json({
      success: true,
      data: {
        fileName: saved.fileName || fileName,
        fileUrl: saved.fileUrl,
        fileSize: saved.fileSize || fileBuffer.length
      }
    });
  } catch (err) {
    console.error('[voucher-file]', err);
    return res.status(500).json({ success: false, message: err.message || 'Không tải được file' });
  }
}
