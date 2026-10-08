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
      set innerHTML(_) { for (const id of ['apw-title', 'apw-hint', 'apw-error', 'apw-label', 'apw-input', 'apw-abort', 'apw-cancel', 'apw-ok', 'form']) kids[id] = el(); },
      querySelector(sel) { return kids[sel.replace('#', '')]; },
      addEventListener(type, fn) { ev[type] = fn; },
      fire(type, e) { ev[type](e || { preventDefault() {} }); },
      removeChild(c) { c.parentNode = null; this.children = this.children.filter((x) => x !== c); },
      children: [],
    };
  };
  const body = el();
  body.appendChild = (c) => { c.parentNode = body; body.children.push(c); };
  return { body, createElement: el, addEventListener(t, f) { listeners[t] = f; }, removeEventListener(t) { delete listeners[t]; }, key(k) { if (listeners.keydown) listeners.keydown({ key: k }); } };
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

const tick = () => new Promise((r) => setImmediate(r));
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects made inside the vm context have another Object prototype

test('ApprovalPassword.selfApproval: a GAS answer (or any answer without needSelfApproval) passes through, no dialog, no resend', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  let resent = 0;
  const gas = { success: true, message: 'Đã gửi' };
  assert.equal(await box.self.ApprovalPassword.selfApproval(gas, async () => { resent += 1; }), gas);
  const err = { success: false, message: 'Lỗi' };
  assert.equal(await box.self.ApprovalPassword.selfApproval(err, async () => { resent += 1; }), err);
  assert.equal(resent, 0);
  assert.equal(doc.body.children.length, 0);
});

test('ApprovalPassword.selfApproval: server prompt; password resent; error shown on the retry; cancel → declined', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  const sent = [];
  const answers = [
    { success: false, needSelfApproval: true, message: 'Mật khẩu không đúng.', selfApproval: { prompt: 'P', steps: [] } },
    { success: true, message: 'done' },
  ];
  const first = { success: false, needSelfApproval: true, message: 'P', selfApproval: { prompt: 'P', steps: [] } };
  const p = box.self.ApprovalPassword.selfApproval(first, async (extra) => { sent.push(extra); return answers.shift(); });
  await tick();
  let dlg = doc.body.children[0];
  assert.equal(dlg.querySelector('#apw-title').textContent, 'Tự động duyệt bước của bạn');
  assert.equal(dlg.querySelector('#apw-hint').textContent, 'P');
  assert.equal(dlg.querySelector('#apw-error').textContent, '', 'no error before a password was sent');
  assert.equal(dlg.querySelector('#apw-ok').textContent, 'Gửi và tự động duyệt');
  assert.equal(dlg.querySelector('#apw-cancel').textContent, 'Bỏ qua, tôi duyệt sau');
  dlg.querySelector('#apw-input').value = 'wrong';
  dlg.querySelector('form').fire('submit');
  await tick(); await tick();
  dlg = doc.body.children[0];
  assert.equal(dlg.querySelector('#apw-error').textContent, 'Mật khẩu không đúng.');
  dlg.querySelector('#apw-cancel').fire('click');
  assert.deepEqual(await p, { success: true, message: 'done' });
  assert.deepEqual(plain(sent), [{ selfApprovalPassword: 'wrong' }, { selfApprovalDeclined: true }]);
});

test('ApprovalPassword.selfApproval: "Hủy" (third button) and Escape send nothing and resolve cancelled', async () => {
  for (const how of ['abort', 'escape']) {
    const doc = fakeDocument();
    const box = { self: {}, document: doc };
    vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
    let resent = 0;
    const first = { success: false, needSelfApproval: true, message: 'P', selfApproval: { prompt: 'P', steps: [] } };
    const p = box.self.ApprovalPassword.selfApproval(first, async () => { resent += 1; return { success: true }; });
    await tick();
    const dlg = doc.body.children[0];
    assert.equal(dlg.querySelector('#apw-abort').textContent, 'Hủy');
    dlg.querySelector('#apw-input').value = 'typed';
    if (how === 'abort') dlg.querySelector('#apw-abort').fire('click'); else doc.key('Escape');
    const r = plain(await p);
    assert.deepEqual(r, { success: false, cancelled: true, message: 'Đã hủy. Phiếu chưa được gửi.' }, how);
    assert.equal(resent, 0, how + ': nothing sent');
    assert.equal(doc.body.children.length, 0, how + ': dialog closed');
    assert.equal(dlg.querySelector('#apw-input').value, '', how + ': typed password cleared');
  }
});

test('ApprovalPassword.ask: old callers get no third button; Escape still resolves null', async () => {
  const doc = fakeDocument();
  const box = { self: {}, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../../approval-password.js', import.meta.url), 'utf8'), box);
  const p = box.self.ApprovalPassword.ask();
  assert.equal(doc.body.children[0].querySelector('#apw-abort').textContent, '', 'abort button not filled');
  doc.key('Escape');
  assert.equal(await p, null);
});
