// api/lib/sheets/outbox.js — queue a Sheet write inside the caller's transaction.
export async function enqueue(client, { spreadsheetId, tab, mode, keyColumn = null, record }) {
  await client.query(
    'INSERT INTO sheet_outbox (spreadsheet_id, tab, mode, key_column, record) VALUES ($1, $2, $3, $4, $5)',
    [spreadsheetId, tab, mode, keyColumn, JSON.stringify(record)]
  );
}
