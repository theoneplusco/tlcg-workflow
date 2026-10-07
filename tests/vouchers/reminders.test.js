import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDue, dueTomorrow, vnDay } from '../../api/lib/vouchers/reminders.js';
import { reminder } from '../../api/lib/vouchers/emails.js';

test('due dates from the form and from the sheet', () => {
  assert.equal(parseDue('2026-10-08'), '2026-10-08');
  assert.equal(parseDue('2026-10-08T00:00:00.000Z'), '2026-10-08');
  assert.equal(parseDue('10/8/2026'), '2026-10-08');
  assert.equal(parseDue('soon'), '');
});
test('dueTomorrow crosses month and year ends', () => {
  assert.equal(dueTomorrow('2026-10-08', '2026-10-07'), true);
  assert.equal(dueTomorrow('2026-11-01', '2026-10-31'), true);
  assert.equal(dueTomorrow('2027-01-01', '2026-12-31'), true);
  assert.equal(dueTomorrow('2026-10-09', '2026-10-07'), false);
  assert.equal(dueTomorrow('', '2026-10-07'), false);
});
test('vnDay is the Vietnam calendar day', () => {
  assert.equal(vnDay(new Date('2026-10-06T18:30:00Z')), '2026-10-07');
});
test('reminder email keeps the GAS subject and approve link', () => {
  const m = reminder({ voucherNumber: 'MI-PC20261007000001', voucherType: 'Phiếu Chi', employee: 'A', amount: 2000000 },
    { email: 'k@x.vn', name: 'Kế Toán' }, '08/10/2026', 'Đang duyệt (1/3)');
  assert.equal(m.subject, '[NHẮC NHỞ] Phiếu MI-PC20261007000001 sắp đến hạn');
  assert.match(m.html, /voucher\.html\?approveVoucher=MI-PC20261007000001/);
  assert.match(m.html, /ngày mai \(08\/10\/2026\)/);
});
