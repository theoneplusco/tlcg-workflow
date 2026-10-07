// api/jobs/voucher-reminders.js — Daily voucher reminders (port of GAS sendReminderEmails).
//
// Every open voucher whose due date is tomorrow (Vietnam time) gets one email
// per approver still pending on its current step. GAS only reminded vouchers
// already "Đang duyệt"; this also covers ones waiting on their first step.
// Runs only when vouchers are on Postgres (otherwise the GAS trigger does it),
// once per day across the 12 PM2 workers (Redis SET NX lock), from 08:00 VN.
import pool from '../../db/pool.js';
import redis from '../../db/redis.js';
import { queueMail } from '../handlers/email-queue.js';
import { reminder } from '../lib/vouchers/emails.js';
import { pendingStep } from '../lib/approval/engine.js';
import { planOf, voucherView } from '../lib/vouchers/repo.js';

import { VN, vnDay, parseDue, dueTomorrow } from '../lib/vouchers/reminders.js';

export async function runVoucherReminders(db = pool, today = vnDay()) {
  const { rows } = await db.query(
    `SELECT * FROM vouchers WHERE status NOT IN ('Đã duyệt', 'Đã từ chối', 'Received') AND COALESCE(due_date, '') <> ''`);
  let sent = 0;
  for (const row of rows) {
    const due = parseDue(row.due_date);
    if (!dueTomorrow(due, today)) continue;
    const plan = planOf(row);
    const i = pendingStep(plan);
    if (i < 0) continue;
    const [y, mo, d] = due.split('-');
    for (const a of plan.steps[i].approvers.filter((x) => x.status !== 'approved' && x.email)) {
      await queueMail(reminder(voucherView(row), a, `${d}/${mo}/${y}`, row.status), db);
      sent++;
    }
  }
  return sent;
}

let timer = null;
/** Check every 10 minutes; the first worker past 08:00 VN takes today's lock and sends. */
export function startVoucherReminderJob() {
  if (timer) return;
  const tick = async () => {
    try {
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: VN, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
      if (hour < 8) return;
      const day = vnDay();
      const got = await redis.set(`tlcg:job:voucher-reminders:${day}`, String(process.pid), 'EX', 3 * 86400, 'NX');
      if (got !== 'OK') return;
      const n = await runVoucherReminders(pool, day);
      console.log(`[VoucherReminders] ${day}: queued ${n} reminder(s)`);
    } catch (err) {
      console.error('[VoucherReminders] error:', err.message);
    }
  };
  timer = setInterval(tick, 10 * 60 * 1000);
  setTimeout(tick, 30 * 1000);
}
