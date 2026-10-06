// api/handlers/admin-master.js — Admin grid over the migrated master sheets:
// list tables, read a table, edit a cell, add / delete a column.
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
      pool.query(`SELECT COUNT(*)::int AS n FROM ${def.table}`).then((r) => r.rows[0].n)));
    return res.json({
      success: true,
      data: {
        tables: entries.map(([key, def], i) => ({ key, title: def.title, sheet: def.sheet, rows: counts[i] })),
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
        table: { key, title: def.title, sheet: def.sheet },
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

/** adminMasterUpdateCell — edit one value. Typed columns are validated. */
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
  if (def.hidden.includes(column)) return res.json({ success: false, message: 'Cột này không sửa ở đây.' });

  try {
    const names = await loadColumns(key, def);
    if (!names.includes(column)) return res.json({ success: false, message: 'Cột không tồn tại.' });

    // Column rule first (allowed values / format), then the typed column's own parse
    const checked = checkRule(columnRule(def, column), raw);
    if (!checked.ok) return res.json({ success: false, message: checked.message });
    const clean = checked.value;

    const core = def.core[column];
    let value;
    if (core) {
      try {
        value = core.type.parse(clean);
      } catch (e) {
        return res.json({ success: false, message: e.message });
      }
      if (key === 'employees' && id === admin.id) {
        if (core.col === 'is_admin' && !value) return res.json({ success: false, message: 'Không thể tự bỏ quyền quản trị của mình.' });
        if (core.col === 'status' && value !== 'active') return res.json({ success: false, message: 'Không thể tự vô hiệu hoá tài khoản của mình.' });
      }
      // Keep the text as typed beside the typed value (see coreCellValue)
      const { rows } = await pool.query(
        `UPDATE ${def.table}
            SET ${core.col} = $1,
                extra = jsonb_set(extra, ARRAY[$3::text], to_jsonb($4::text), true),
                updated_at = NOW()
          WHERE id = $2
          RETURNING ${core.col}`,
        [value, id, column, clean]
      );
      if (!rows[0]) return res.json({ success: false, message: 'Không tìm thấy dòng.' });
      value = coreCellValue(core, clean, rows[0][core.col]);
    } else {
      value = clean;
      const { rowCount } = await pool.query(
        `UPDATE ${def.table} SET extra = jsonb_set(extra, ARRAY[$1::text], to_jsonb($2::text), true),
                updated_at = NOW()
         WHERE id = $3`,
        [column, value, id]
      );
      if (!rowCount) return res.json({ success: false, message: 'Không tìm thấy dòng.' });
    }

    clearMasterDataCache();
    console.log(`[AdminMaster] ${admin.email} set ${key}#${id}.${column}`);
    return res.json({ success: true, data: { value } });
  } catch (err) {
    if (err.code === '23505') return res.json({ success: false, message: 'Giá trị này đã tồn tại ở dòng khác.' });
    console.error('[AdminMaster] update error:', err.message);
    return res.status(500).json({ success: false, message: 'Lỗi server' });
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
