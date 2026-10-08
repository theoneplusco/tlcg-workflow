// tests/approval/signature-image.test.js — signature-image.js: the paper becomes transparent, the ink is kept and boxed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

// Loaded like a plain <script>, as approval-password.test.js does
const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../signature-image.js', import.meta.url), 'utf8'), sandbox);
const { transparentInk } = sandbox.self.SignatureImage;

/** w×h RGBA filled with `paper` (grey level, alpha), with a dark `ink` rectangle at x 20–59, y 10–19. */
function sheet({ w = 80, h = 30, paper = 255, paperAlpha = 255, ink = 30 } = {}) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = (y * w + x) * 4;
    const v = x >= 20 && x < 60 && y >= 10 && y < 20 ? ink : paper;
    px[i] = px[i + 1] = px[i + 2] = v;
    px[i + 3] = v === ink ? 255 : paperAlpha;
  }
  return { px, w, h };
}
const at = (s, x, y) => Array.from(s.px.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4));

test('white paper becomes transparent; the ink stays opaque and is boxed', () => {
  const s = sheet();
  assert.deepEqual({ ...transparentInk(s.px, s.w, s.h) }, { x: 20, y: 10, w: 40, h: 10 });
  assert.deepEqual(at(s, 2, 2), [0, 0, 0, 0]);
  assert.deepEqual(at(s, 30, 15), [30, 30, 30, 255]);
});

test('grey paper from a phone photo is removed too', () => {
  const s = sheet({ paper: 190, ink: 40 });
  assert.ok(transparentInk(s.px, s.w, s.h));
  assert.equal(at(s, 5, 5)[3], 0);
  assert.equal(at(s, 40, 12)[3], 255);
});

test('an already transparent PNG keeps its transparent background', () => {
  const s = sheet({ paperAlpha: 0 });
  assert.deepEqual({ ...transparentInk(s.px, s.w, s.h) }, { x: 20, y: 10, w: 40, h: 10 });
  assert.equal(at(s, 70, 25)[3], 0);
});

test('faint strokes become partly transparent but keep their look on white', () => {
  const s = sheet({ ink: 180 }); // paper 255 → ramp 230..145: 180 is ~59% opaque
  transparentInk(s.px, s.w, s.h);
  const [r, , , a] = at(s, 30, 15);
  assert.ok(a > 100 && a < 200, String(a));
  assert.ok(Math.abs((a / 255) * r + (1 - a / 255) * 255 - 180) <= 2, 'same grey on white');
});

test('a blank page has no ink; a very dark photo is refused', () => {
  const blank = sheet({ ink: 255 });
  assert.equal(transparentInk(blank.px, blank.w, blank.h), null);
  const dark = sheet({ paper: 70, ink: 10 });
  assert.throws(() => transparentInk(dark.px, dark.w, dark.h), /Ảnh quá tối/);
});
