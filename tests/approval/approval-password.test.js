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

/** A minimal DOM: enough for ask() to build its overlay and for the test to submit or cancel it. */
function fakeDocument() {
  const listeners = {};
  const el = () => {
    const kids = {}; const ev = {};
    return {
      style: {}, value: '', parentNode: null, textContent: '',
      setAttribute() {}, focus() {},
      set innerHTML(_) { for (const id of ['apw-title', 'apw-hint', 'apw-label', 'apw-input', 'apw-cancel', 'apw-ok', 'form']) kids[id] = el(); },
      querySelector(sel) { return kids[sel.replace('#', '')]; },
      addEventListener(type, fn) { ev[type] = fn; },
      fire(type, e) { ev[type](e || { preventDefault() {} }); },
      removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); },
      children: [],
    };
  };
  const body = el();
  body.appendChild = (c) => { c.parentNode = body; body.children.push(c); };
  return { body, createElement: el, addEventListener(t, f) { listeners[t] = f; }, removeEventListener(t) { delete listeners[t]; } };
}

test('ApprovalPassword.ask: a second call while the dialog is open opens no second dialog and resolves null', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  const ap = box.self.ApprovalPassword;
  const first = ap.ask();
  const second = ap.ask();
  assert.equal(doc.body.children.length, 1, 'one dialog only');
  assert.equal(await second, null, 'the re-entrant call is ignored');
  const overlay = doc.body.children[0];
  overlay.querySelector('#apw-input').value = 'Test#2026';
  overlay.querySelector('form').fire('submit');
  assert.equal(await first, 'Test#2026');
  assert.equal(doc.body.children.length, 0);
  const third = ap.ask(); // closed → a new dialog can open again
  assert.equal(doc.body.children.length, 1);
  doc.body.children[0].querySelector('#apw-cancel').fire('click');
  assert.equal(await third, null);
});
