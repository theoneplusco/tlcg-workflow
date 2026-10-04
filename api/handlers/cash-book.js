// api/handlers/cash-book.js — Cash count (Bảng kiểm kê quỹ)
import pool from '../../db/pool.js';
import { publishEvent } from './sse.js';

const CASH_BOOK_ROLES = [
  { key: 'nguoiChiuTrachNhiem', label: 'Người chịu trách nhiệm kiểm kê quỹ' },
  { key: 'keToanTruong',       label: 'Kế toán trưởng' },
  { key: 'thuQuy',              label: 'Thủ quỹ' },
];

export async function handleGetCashBook(req, res) {
  const { companyName, companyKey } = req.body || req.query || {};
  try {
    let rows;
    if (companyKey) {
      ({ rows } = await pool.query(
        `SELECT * FROM cash_counts WHERE company_key = $1 ORDER BY saved_at DESC LIMIT 500`,
        [companyKey]
      ));
    } else if (companyName) {
      ({ rows } = await pool.query(
        `SELECT * FROM cash_counts WHERE company_name = $1 ORDER BY saved_at DESC LIMIT 500`,
        [companyName]
      ));
    } else {
      ({ rows } = await pool.query(`SELECT * FROM cash_counts ORDER BY saved_at DESC LIMIT 500`));
    }
    return res.json({ success: true, data: { counts: rows } });
  } catch (err) {
    console.error('[CashBook] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function handleSaveCashCount(req, res) {
  const body = req.body || {};
  const {
    companyKey, companyName, endDate, countHour, countMinute,
    quantities, bookBalance, countedTotal,
    reasonThua, reasonThieu, conclusion, reps,
    savedByEmail, lang,
  } = body;
  const vi = lang !== 'en';

  if (!companyName) return res.status(400).json({ success: false, message: vi ? 'Thiếu tên công ty' : 'Missing company' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO cash_counts
         (company_key, company_name, end_date, count_hour, count_minute,
          quantities, book_balance, counted_total, reason_thua, reason_thieu,
          conclusion, reps, saved_by_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [companyKey || '', companyName, endDate || '', countHour || 0, countMinute || 0,
       JSON.stringify(quantities || {}), bookBalance || 0, countedTotal || 0,
       reasonThua || '', reasonThieu || '', conclusion || '',
       JSON.stringify(reps || []), savedByEmail || '']
    );

    await publishEvent('cashcount:saved', { id: rows[0].id, company: companyName });

    return res.json({ success: true, data: { id: rows[0].id } });
  } catch (err) {
    console.error('[CashBook] Save error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function handleSignCashCount(req, res) {
  const { id, role, signerName, signerEmail, signature, lang } = req.body || {};
  const vi = lang !== 'en';

  if (!id || !role) return res.status(400).json({ success: false, message: vi ? 'Thiếu id hoặc vai trò' : 'Missing id or role' });

  const validRoles = CASH_BOOK_ROLES.map(r => r.key);
  if (!validRoles.includes(role)) return res.status(400).json({ success: false, message: vi ? 'Vai trò không hợp lệ' : 'Invalid role' });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM cash_counts WHERE id = $1 FOR UPDATE`, [id]);
      const count = rows[0];
      if (!count) { await client.query('ROLLBACK'); return res.json({ success: false, message: vi ? 'Không tìm thấy' : 'Not found' }); }

      const reps = count.reps || [];
      const existing = reps.find(r => r.key === role);
      if (existing) {
        existing.name = signerName || existing.name;
        existing.signature = signature || existing.signature;
        existing.signedAt = new Date().toISOString();
      } else {
        reps.push({ key: role, label: CASH_BOOK_ROLES.find(r => r.key === role)?.label || role, name: signerName || '', signature: signature || '', signedAt: new Date().toISOString() });
      }

      const allSigned = CASH_BOOK_ROLES.every(r => reps.some(rp => rp.key === r.key && rp.signature));
      const newRowStatus = allSigned ? 'signed' : 'pending';

      await client.query(
        `UPDATE cash_counts SET reps = $1, row_status = $2 WHERE id = $3`,
        [JSON.stringify(reps), newRowStatus, id]
      );
      await client.query('COMMIT');

      await publishEvent('cashcount:signed', { id, role, allSigned });

      return res.json({ success: true, data: { id, allSigned, rowStatus: newRowStatus } });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[CashBook] Sign error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}
