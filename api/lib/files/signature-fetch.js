// api/lib/files/signature-fetch.js — rules for fetching sample signature images (pure).
import { R2_PUBLIC_URL } from './r2.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** GAS handleFetchSignatureImage: Drive share links → direct download. */
export function driveDownloadUrl(url) {
  if (!String(url).includes('drive.google.com')) return url;
  const id = (url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || [])[1];
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'lh3.googleusercontent.com', 'drive.usercontent.google.com']);

export function isAllowedImageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  let r2Host = '';
  try { r2Host = new URL(R2_PUBLIC_URL).host; } catch { /* unset */ }
  return ALLOWED_HOSTS.has(u.host) || (!!r2Host && u.host === r2Host);
}
