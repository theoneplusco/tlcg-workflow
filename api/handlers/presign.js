// api/handlers/presign.js — R2 presigned URL for direct file upload
// The browser uploads directly to R2 — the Mac Mini never touches the file bytes.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET = process.env.R2_BUCKET_NAME || 'tlcg-attachments';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://attachments.tl-c.us';

let s3Client = null;

function getS3() {
  if (s3Client) return s3Client;
  if (!R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return null; // R2 not configured — caller handles null
  }
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

export async function handlePresign(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'POST only' });
  }

  const { fileName, mimeType, folder, documentId } = req.body || {};
  if (!fileName) {
    return res.status(400).json({ success: false, message: 'fileName is required' });
  }

  const s3 = getS3();
  if (!s3) {
    // R2 not configured — return a fallback so the app still works
    // (files will be stored as base64 in the DB, like the old ≤700KB path)
    return res.status(503).json({
      success: false,
      message: 'R2 not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.',
    });
  }

  // Build a safe key: {folder}/{documentId}/{timestamp}-{filename}
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${folder || 'misc'}/${documentId || 'unassigned'}/${Date.now()}-${safeName}`;

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    ContentType: mimeType || 'application/octet-stream',
  });

  try {
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const fileUrl = `${R2_PUBLIC_URL}/${key}`;

    return res.json({
      success: true,
      data: { uploadUrl, fileUrl, key, bucket: R2_BUCKET },
    });
  } catch (err) {
    console.error('[Presign] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Could not generate upload URL' });
  }
}
