// tests/purchase-requests/fx-branch.test.js — the page's branch rule matches the server's (fx-branch.js vs state.js/rates.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import { computeBranch } from '../../api/lib/purchase-requests/state.js';
import { toVnd, normalizeCurrency } from '../../api/lib/fx/rates.js';

const sandbox = { self: {} };
vm.runInNewContext(fs.readFileSync(new URL('../../fx-branch.js', import.meta.url), 'utf8'), sandbox);
const FB = sandbox.self.FxBranch;
const rates = { USD: 26000, EUR: null };

test('FxBranch.branch agrees with the server for VND, USD and services', () => {
  for (const [type, total, cur] of [['goods', 1999999, 'VND'], ['goods', 2000000, ''], ['goods', 76.9, 'USD'], ['goods', 77, 'USD'], ['services', 1, 'USD']]) {
    const server = computeBranch(type, normalizeCurrency(cur) === 'VND' ? total : toVnd(total, rates[normalizeCurrency(cur)]));
    assert.equal(FB.branch(type, total, cur, rates), server, `${type} ${total} ${cur}`);
  }
});
test('FxBranch: no rate → the raw total (GAS rule), never a guess sent to the server', () => {
  assert.equal(FB.toVnd(100, 'EUR', rates), null);
  assert.equal(FB.toVnd(100, 'USD', null), null);
  assert.equal(FB.branch('goods', 100, 'EUR', rates), 'simplified');
  assert.equal(FB.branch('goods', 2500000, 'USD', null), 'full', 'GAS mode: raw total');
  assert.equal(FB.toVnd(1500.5, 'VNĐ', rates), 1500.5);
});
