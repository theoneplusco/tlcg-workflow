// api/lib/files/fetch-image.js — fetch an allow-listed image (Drive share link or R2) as a data URL.
// Used by fetchSignatureImage (the page) and by the approval stamp (api/lib/approval/step-up.js).
import { driveDownloadUrl, isAllowedImageUrl, MAX_IMAGE_BYTES } from './signature-fetch.js';

export class ImageFetchError extends Error {}

/** Redirects followed at most (each one re-checked against the allow-list): 4 redirects = 5 fetches in all. */
export const MAX_REDIRECTS = 4;

/** fetchImpl defaults to the global fetch at call time (tests replace globalThis.fetch). */
export async function fetchImageDataUrl(url, { fetchImpl = (...a) => globalThis.fetch(...a), maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!isAllowedImageUrl(url)) throw new ImageFetchError('URL hình ảnh không được phép');
  let target = driveDownloadUrl(url);
  let r;
  for (let hop = 0; ; hop += 1) {
    r = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (r.status < 300 || r.status >= 400) break;
    const next = r.headers.get('location');
    if (!next || hop >= MAX_REDIRECTS) throw new ImageFetchError('Không tải được hình ảnh (chuyển hướng quá nhiều)');
    target = new URL(next, target).toString();
    if (!isAllowedImageUrl(target)) throw new ImageFetchError('URL hình ảnh không được phép');
  }
  if (!r.ok) throw new ImageFetchError(`Không tải được hình ảnh (HTTP ${r.status})`);
  if (Number(r.headers.get('content-length')) > maxBytes) throw new ImageFetchError('Hình ảnh quá lớn');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new ImageFetchError('Hình ảnh quá lớn');
  const mime = (r.headers.get('content-type') || 'image/png').split(';')[0];
  if (!/^image\//.test(mime)) throw new ImageFetchError('Tệp không phải hình ảnh');
  return `data:${mime};base64,${buf.toString('base64')}`;
}
