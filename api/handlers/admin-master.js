// api/handlers/admin-master.js — Admin grid over the migrated master sheets:
// list tables, read a table, edit a cell, add / delete a column; the audit log of audited
// tables; add / remove an exchange-rate currency (app-only table).
import pool from '../../db/pool.js';
import { MASTER_TABLES, getMasterTable, isProtectedColumn, coreColumns, coreCellValue, columnRule, checkRule, formatLabel } from '../lib/master-registry.js';
import { requireAdmin, clearMasterDataCache } from './admin-employees.js';

const MAX_COLUMN_NAME = 100;

/** Column names in display order; falls back to the registry before the first import. */
async function loadColumns(key, def, client = pool) {
  return (await loadColumnRows(key, def, client)).map((c) => c.name);
}

/** [{ name, label }] in display order. label is null when it equals the name. */
async function loadColumnRows(key, def, client = pool) {
  const { rows } = await client.query(
    `SELECT name, label FROM master_columns WHERE table_key = $1 ORDER BY position, name`, [key]
  );
  return rows.length ? rows : [...Object.keys(def.core), ...def.locked].map((name) => ({ name, label: null }));
}

function visibleColumns(def, columnRows) {
  return columnRows
    .filter((c) => !def.hidden.includes(c.name))
    .map((c) => ({
      name: c.name,
      label: formatLabel(c.label || c.name),
      core: Object.prototype.hasOwnProperty.call(def.core, c.name),
      locked: isProtectedColumn(def, c.name),
      readOnly: (def.readOnly || []).includes(c.name),
      rule: columnRule(def, c.name),
    }));
}

/** True when `text` would show the same label as another column (labels are formatted). */
function clashes(columnRows, text, exceptName) {
  const t = formatLabel(text).toLowerCase();
  return columnRows.some((c) => c.name !== exceptName &&
    (c.name.toLowerCase() === text.toLowerCase() || formatLabel(c.label || c.name).toLowerCase() === t));
}

function cellValue(def, row, name) {
  const core = def.core[name];
  const v = row.extra ? row.extra[name] : undefined;
  if (core) return coreCellValue(core, v, row[core.col]);
  return v == null ? '' : String(v);
}

function tableFromBody(req, res) {
  const key = String(req.body?.table || '');
  const def = getMasterTable(key);
  if (!def) {
    res.json({ success: false, message: 'Bảng không hợp lệ.' });
    return null;
  }
  return { key, def };
}

/** adminMasterTables — the master tables with row counts. */
export async function handleAdminMasterTables(req, res) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const entries = Object.entries(MASTER_TABLES);
    const counts = await Promise.all(entries.map(([, def]) =>
      pool.query(`SELECT COUNT(*)::int AS n FROM ${def.table}`).then((r) => r.rows[0].n)
        .catch((e) => { if (e.code === '42P01') return null; throw e; }))); // table of a migration not applied yet
    return res.json({
      success: true,
      data: {
        tables: entries.map(([key, def], i) => ({ key, title: def.title, sheet: def.sheet, audit: !!def.audit, rows: counts[i] }))
          .filter((t) => t.rows !== null),
      },
    });
  } catch (err) {
    console.error('[AdminMaster] tables error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/**
 * adminMasterGet — one table as columns + rows (values aligned to columns).
 * Employees also carry account flags for the account dialog.
 */
export async function handleAdminMasterGet(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  try {
    const columns = visibleColumns(def, await loadColumnRows(key, def));
    const isEmployees = key === 'employees';
    const select = ['id', 'extra', ...coreColumns(def)];
    if (isEmployees) {
      select.push(`(password_hash <> '') AS has_bcrypt`,
        `(COALESCE(legacy_password_sha256, '') <> '') AS has_legacy`);
    }
    const { rows } = await pool.query(
      `SELECT ${select.join(', ')} FROM ${def.table} ORDER BY sheet_row NULLS LAST, id`
    );

    return res.json({
      success: true,
      data: {
        table: { key, title: def.title, sheet: def.sheet, audit: !!def.audit },
        columns,
        rows: rows.map((r) => {
          const out = { id: r.id, v: columns.map((c) => cellValue(def, r, c.name)) };
          if (isEmployees) {
            out.account = {
              active: r.status === 'active',
              isAdmin: !!r.is_admin,
              hasPassword: !!(r.has_bcrypt || r.has_legacy),
              legacyPassword: !!r.has_legacy && !r.has_bcrypt,
              mustChangePassword: !!r.must_change_password,
              placeholderEmail: /@local$/.test(r.email || ''),
            };
          }
          return out;
        }),
      },
    });
  } catch (err) {
    console.error('[AdminMaster] get error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

/** Write one checked value on `q` (pool or transaction client). Returns { value } | { error }. */
async function writeCell(q, key, def, id, column, clean, admin) {
  const core = def.core[column];
  if (!core) {
    const { rowCount } = await q.query(
      `UPDATE ${def.table} SET extra = jsonb_set(extra, ARRAY[$1::text], to_jsonb($2::text), true), updated_at = NOW() WHERE id = $3`,
      [column, clean, id]);
    return rowCount ? { value: clean } : { error: 'Không tìm thấy dòng.' };
  }
  let value;
  try { value = core.type.parse(clean); } catch (e) { return { error: e.message }; }
  if (key === 'employees' && id === admin.id) {
    if (core.col === 'is_admin' && !value) return { error: 'Không thể tự bỏ quyền quản trị của mình.' };
    if (core.col === 'status' && value !== 'active') return { error: 'Không thể tự vô hiệu hoá tài khoản của mình.' };
  }
  // Keep the text as typed beside the typed value (see coreCellValue)
  const { rows } = await q.query(
    `UPDATE ${def.table}
        SET ${core.col} = $1, extra = jsonb_set(extra, ARRAY[$3::text], to_jsonb($4::text), true), updated_at = NOW()
      WHERE id = $2
      RETURNING ${core.col}`,
    [value, id, column, clean]);
  return rows[0] ? { value: coreCellValue(core, clean, rows[0][core.col]) } : { error: 'Không tìm thấy dòng.' };
}

/** One master_audit row on `q` (inside the caller's transaction). */
function audit(q, key, id, column, oldValue, newValue, email) {
  return q.query(
    `INSERT INTO master_audit (table_key, row_id, column_name, old_value, new_value, actor_email) VALUES ($1, $2, $3, $4, $5, $6)`,
    [key, id, column, oldValue, newValue, email]);
}

/** adminMasterUpdateCell — edit one value. Typed columns are validated; audited tables log who changed what. */
export async function handleAdminMasterUpdateCell(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  const id = parseInt(req.body.id, 10);
  const column = String(req.body.column || '');
  const raw = req.body.value == null ? '' : String(req.body.value);
  if (!id || !column) return res.json({ success: false, message: 'Thiếu thông tin.' });
  if (def.hidden.includes(column) || (def.readOnly || []).includes(column)) return res.json({ success: false, message: 'Cột này không sửa ở đây.' });

  let client = null;
  try {
    const names = await loadColumns(key, def);
    if (!names.includes(column)) return res.json({ success: false, message: 'Cột không tồn tại.' });

    // Column rule first (allowed values / format), then the typed column's own parse
    const checked = checkRule(columnRule(def, column), raw);
    if (!checked.ok) return res.json({ success: false, message: checked.message });

    let out;
    if (def.audit) {
      client = await pool.connect();
      await client.query('BEGIN');
      const before = (await client.query(`SELECT id, extra, ${coreColumns(def).join(', ')} FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      out = before ? await writeCell(client, key, def, id, column, checked.value, admin) : { error: 'Không tìm thấy dòng.' };
      if (out.error) {
        await client.query('ROLLBACK');
      } else {
        await audit(client, key, id, column, cellValue(def, before, column), out.value, admin.email);
        await client.query('COMMIT');
      }
    } else {
      out = await writeCell(pool, key, def, id, column, checked.value, admin);
    }
    if (out.error) return res.json({ success: false, message: out.error });

    clearMasterDataCache();
    console.log(`[AdminMaster] ${admin.email} set ${key}#${id}.${column}`);
    return res.json({ success: true, data: { value: out.value } });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.json({ success: false, message: 'Giá trị này đã tồn tại ở dòng khác.' });
    console.error('[AdminMaster] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    if (client) client.release();
  }
}

/** adminMasterAudit — the last 200 changes of an audited table, newest first. */
export async function handleAdminMasterAudit(req, res) {
  if (!(await requireAdmin(req, res))) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  if (!t.def.audit) return res.json({ success: false, message: 'Bảng này không lưu lịch sử thay đổi.' });
  try {
    const { rows } = await pool.query(
      `SELECT row_id, column_name, old_value, new_value, actor_email, created_at FROM master_audit
        WHERE table_key = $1 ORDER BY id DESC LIMIT 200`, [t.key]);
    return res.json({ success: true, data: { entries: rows.map((r) => ({ rowId: r.row_id, column: r.column_name,
      oldValue: r.old_value, newValue: r.new_value, actorEmail: r.actor_email, at: r.created_at })) } });
  } catch (err) {
    console.error('[AdminMaster] audit error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  }
}

// ── Exchange-rate currencies (decision 2026-10-07): admins add a currency with its rate, and remove
// one only while no PR uses it. Each add / remove writes Currency + Rate_To_VND rows to master_audit.
const FX_KEY = 'exchange_rates';

/** adminExchangeRateAdd { currency, rate } → { id } */
export async function handleAdminExchangeRateAdd(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const def = MASTER_TABLES[FX_KEY];
  const cur = checkRule(def.rules.Currency, req.body?.currency);
  if (!cur.ok) return res.json({ success: false, message: cur.message });
  if (cur.value === 'VND') return res.json({ success: false, message: 'VND là tiền gốc, không cần tỷ giá.' });
  const rate = checkRule(def.rules.Rate_To_VND, req.body?.rate);
  if (!rate.ok) return res.json({ success: false, message: rate.message });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO exchange_rates (currency, rate_to_vnd, extra, sheet_row)
       SELECT $1, $2, jsonb_build_object('Rate_To_VND', $3::text), COALESCE(MAX(sheet_row), 0) + 1 FROM exchange_rates
       ON CONFLICT (currency) DO NOTHING RETURNING id`,
      [cur.value, Number(rate.value.replace(/,/g, '')), rate.value]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Loại tiền ${cur.value} đã có.` });
    }
    const id = rows[0].id;
    await audit(client, FX_KEY, id, 'Currency', '', cur.value, admin.email);
    await audit(client, FX_KEY, id, 'Rate_To_VND', '', rate.value, admin.email);
    await client.query('COMMIT');
    clearMasterDataCache();
    console.log(`[AdminMaster] ${admin.email} added currency ${cur.value}`);
    return res.json({ success: true, message: `Đã thêm ${cur.value}.`, data: { id } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AdminMaster] addCurrency error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

/** adminExchangeRateDelete { id } — refused while any PR (any case of the code) uses the currency. */
export async function handleAdminExchangeRateDelete(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const def = MASTER_TABLES[FX_KEY];
  const id = parseInt(req.body?.id, 10);
  if (!id) return res.json({ success: false, message: 'Thiếu thông tin.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT id, extra, currency, rate_to_vnd FROM exchange_rates WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Không tìm thấy dòng.' });
    }
    const used = await client.query(`SELECT 1 FROM purchase_requests WHERE UPPER(TRIM(currency)) = $1 LIMIT 1`, [row.currency]);
    if (used.rowCount) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Không xoá được ${row.currency}: đã có đề nghị mua hàng dùng loại tiền này.` });
    }
    await client.query(`DELETE FROM exchange_rates WHERE id = $1`, [id]);
    await audit(client, FX_KEY, id, 'Currency', row.currency, '', admin.email);
    await audit(client, FX_KEY, id, 'Rate_To_VND', cellValue(def, row, 'Rate_To_VND'), '', admin.email);
    await client.query('COMMIT');
    clearMasterDataCache();
    console.log(`[AdminMaster] ${admin.email} removed currency ${row.currency}`);
    return res.json({ success: true, message: `Đã xoá ${row.currency}.` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AdminMaster] deleteCurrency error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

/** Persist the registry order the first time a table's columns are changed. */
async function seedColumns(client, key, names) {
  await client.query(
    `INSERT INTO master_columns (table_key, name, position)
     SELECT $1, n, ord FROM unnest($2::text[]) WITH ORDINALITY AS t(n, ord)
     ON CONFLICT (table_key, name) DO NOTHING`,
    [key, names]
  );
}

/** adminMasterAddColumn — append an empty column (values live in `extra`). */
export async function handleAdminMasterAddColumn(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  const name = String(req.body.name || '').trim();
  if (!name || name.length > MAX_COLUMN_NAME) {
    return res.json({ success: false, message: `Tên cột cần 1–${MAX_COLUMN_NAME} ký tự.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const columnRows = await loadColumnRows(key, def, client);
    if (clashes(columnRows, name)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Cột "${name}" đã có.` });
    }
    await seedColumns(client, key, columnRows.map((c) => c.name));
    await client.query(
      `INSERT INTO master_columns (table_key, name, position, created_by)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1, $3 FROM master_columns WHERE table_key = $1`,
      [key, name, admin.email]
    );
    await client.query('COMMIT');
    console.log(`[AdminMaster] ${admin.email} added column ${key}."${name}"`);
    return res.json({ success: true, message: `Đã thêm cột "${name}".` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AdminMaster] addColumn error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

/** adminMasterDeleteColumn — remove a column and its values from every row. */
export async function handleAdminMasterDeleteColumn(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  const name = String(req.body.name || '');
  if (isProtectedColumn(def, name) || def.hidden.includes(name)) {
    return res.json({ success: false, message: `Cột "${name}" được hệ thống sử dụng nên không xoá được.` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const names = await loadColumns(key, def, client);
    if (!names.includes(name)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Cột không tồn tại.' });
    }
    await seedColumns(client, key, names);
    await client.query(`DELETE FROM master_columns WHERE table_key = $1 AND name = $2`, [key, name]);
    const { rowCount } = await client.query(
      `UPDATE ${def.table} SET extra = extra - $1::text WHERE extra ? $1::text`, [name]
    );
    await client.query('COMMIT');
    console.log(`[AdminMaster] ${admin.email} deleted column ${key}."${name}" (${rowCount} values)`);
    return res.json({ success: true, message: `Đã xoá cột "${name}".` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AdminMaster] deleteColumn error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

/**
 * adminMasterRenameColumn — change the label shown on the admin page.
 * The sheet header (name) stays the key, so imports and app logic keep working.
 */
export async function handleAdminMasterRenameColumn(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const t = tableFromBody(req, res);
  if (!t) return;
  const { key, def } = t;

  const name = String(req.body.name || '');
  const label = String(req.body.label || '').trim();
  if (!label || label.length > MAX_COLUMN_NAME) {
    return res.json({ success: false, message: `Tên cột cần 1–${MAX_COLUMN_NAME} ký tự.` });
  }
  if (def.hidden.includes(name)) return res.json({ success: false, message: 'Cột không tồn tại.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const columnRows = await loadColumnRows(key, def, client);
    if (!columnRows.some((c) => c.name === name)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: 'Cột không tồn tại.' });
    }
    if (clashes(columnRows, label, name)) {
      await client.query('ROLLBACK');
      return res.json({ success: false, message: `Đã có cột tên "${label}".` });
    }
    await seedColumns(client, key, columnRows.map((c) => c.name));
    await client.query(
      `UPDATE master_columns SET label = $3 WHERE table_key = $1 AND name = $2`,
      [key, name, formatLabel(label) === formatLabel(name) ? null : formatLabel(label)]
    );
    await client.query('COMMIT');
    console.log(`[AdminMaster] ${admin.email} renamed ${key}."${name}" → "${label}"`);
    return res.json({ success: true, data: { name, label: formatLabel(label) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[AdminMaster] renameColumn error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
}
