import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveDownloadUrl, isAllowedImageUrl } from '../../api/lib/files/signature-fetch.js';

test('driveDownloadUrl: the three Drive formats GAS handled', () => {
  const d = 'https://drive.google.com/uc?export=download&id=1AbC_d-9xyz';
  assert.equal(driveDownloadUrl('https://drive.google.com/file/d/1AbC_d-9xyz/view?usp=sharing'), d);
  assert.equal(driveDownloadUrl('https://drive.google.com/open?id=1AbC_d-9xyz'), d);
  assert.equal(driveDownloadUrl('https://drive.google.com/uc?id=1AbC_d-9xyz'), d);
  assert.equal(driveDownloadUrl('https://attachments.tl-c.us/sig/a.png'), 'https://attachments.tl-c.us/sig/a.png');
});
test('isAllowedImageUrl: Drive, Google image hosts and our R2 only (no SSRF)', () => {
  assert.equal(isAllowedImageUrl('https://drive.google.com/file/d/x/view'), true);
  assert.equal(isAllowedImageUrl('https://lh3.googleusercontent.com/d/x'), true);
  assert.equal(isAllowedImageUrl('https://attachments.tl-c.us/a.png'), true);
  assert.equal(isAllowedImageUrl('http://drive.google.com/x'), false);
  assert.equal(isAllowedImageUrl('https://127.0.0.1/x'), false);
  assert.equal(isAllowedImageUrl('https://drive.google.com.evil.io/x'), false);
  assert.equal(isAllowedImageUrl('not a url'), false);
});
