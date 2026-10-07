// api/lib/vouchers/reminders.js — Date logic for the daily voucher reminder (pure).

export const VN = 'Asia/Ho_Chi_Minh';

/** "YYYY-MM-DD" of a date in Vietnam time. */
export function vnDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: VN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Due date as "YYYY-MM-DD" from "2026-10-08", "2026-10-08T…", "10/8/2026" (sheet M/D/YYYY); '' if unknown. */
export function parseDue(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return '';
}

/** True when `due` (YYYY-MM-DD) is the day after `today` (YYYY-MM-DD). */
export function dueTomorrow(due, today) {
  if (!due) return false;
  const t = new Date(today + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10) === due;
}
