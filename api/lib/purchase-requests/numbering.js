// api/lib/purchase-requests/numbering.js — "{CODE}-PR{YYYYMMDD}{NNNNNN}" (purchase_request.html format).
// Pure rules + one DB function that must run inside the caller's transaction.
// allocatePRNo needs READ COMMITTED (the default): it takes the advisory lock first and reads after,
// so each statement sees what the previous lock holder committed. hashtext is 32-bit; a collision only
// serializes two unrelated keys, it never hands out a duplicate.
// The tail is bounded (6-9 digits) so Number() stays exact; a longer requested tail is treated as garbage.
export const PR_NO_RE = /^([A-Z0-9]+)-PR(\d{8})(\d{6,9})$/;
const MAX_SEARCH = 1e6;

export function vnDate(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}

/** Same cleaning as the page's dataset.code: accents dropped, non-alphanumerics removed, upper-cased. */
export const cleanPrefix = (code) => String(code || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const parse = (requested) => PR_NO_RE.exec(String(requested || '').trim().toUpperCase());

export function prefixFor(company, requested) {
  const m = parse(requested);
  return cleanPrefix(company && company.company_code) || (m ? m[1] : '') || 'PR';
}

/** Keep the page's number when it is today's, has the company prefix and is free; else the next free tail. */
export function choosePRNo({ prefix, date, requested, taken }) {
  const base = `${prefix}-PR${date}`;
  const m = parse(requested);
  const sameBase = !!m && m[1] === prefix && m[2] === date;
  if (sameBase && !taken.has(m[0])) return m[0];
  const width = sameBase ? m[3].length : 6;
  const fmt = (n) => base + String(n).padStart(width, '0');
  let n = sameBase ? Number(m[3]) : 1;
  for (let i = 0; taken.has(fmt(n)); i += 1) {
    if (i >= MAX_SEARCH) throw new Error(`choosePRNo: no free number under ${base} after ${MAX_SEARCH} tries`);
    n += 1;
  }
  return fmt(n);
}

/** One number per (prefix, Vietnam day) at a time: the advisory lock is held until the caller commits. */
export async function allocatePRNo(client, { prefix, requested, now = new Date() }) {
  const p = cleanPrefix(prefix) || 'PR';
  const date = vnDate(now);
  const base = `${p}-PR${date}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['pr_no:' + base]);
  const { rows } = await client.query(
    `SELECT pr_no AS no FROM purchase_requests WHERE pr_no LIKE $1
     UNION SELECT doc_no FROM pr_audit_log WHERE doc_no LIKE $1`, [base + '%']);
  return choosePRNo({ prefix: p, date, requested, taken: new Set(rows.map((r) => r.no)) });
}
