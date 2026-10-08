// tests/approval/approval-password.test.js — the browser password prompt, loaded like a plain <script>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), sandbox);
const AP = sandbox.self.ApprovalPassword;

test('ApprovalPassword: defines ask(); valid() accepts 1–200 characters, never trims', () => {
  assert.equal(typeof AP.ask, 'function');
  assert.equal(AP.MAX, 200);
  assert.equal(AP.valid(''), false);
  assert.equal(AP.valid(null), false);
  assert.equal(AP.valid(' '), true, 'spaces are part of a password');
  assert.equal(AP.valid('Test#2026'), true);
  assert.equal(AP.valid('x'.repeat(200)), true);
  assert.equal(AP.valid('x'.repeat(201)), false);
});
