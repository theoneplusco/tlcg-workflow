// tests/sheets/pr-records.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prRecord, auditRecord, PR_KEY } from '../../api/lib/sheets/pr-records.js';
import { rowForHeader } from '../../api/lib/sheets/rows.js';

// The live Purchase_Request_History header (exported 2026-10-06): 20 base columns, then row_type + event_* five times.
const G = 'row_type,event_action,event_role,event_actor_email,event_actor_name,event_prev_status,event_new_status,event_timestamp,event_note,event_metadata_json';
const HEADER = ('pr_no,company_name,company_key,department,requester_name,required_date,priority,purpose,suggested_vendor,budget_code,'
  + 'budget_approver_email,supplier_approver_email,items_json,grand_total,status,submitted_at,metadata_json,contract_approver_email,'
  + `purchasing_approver_email,attachment_urls,${G},${G},${G},${G},`
  + 'Row_Type,Event_Action,Event_Role,Event_Actor_Email,Event_Actor_Name,Event_Prev_Status,Event_New_Status,Event_Timestamp,Event_Note,Event_Meta_JSON').split(',');

const row = {
  pr_no: 'EV-PR20261007000001', company_name: 'CT', company_key: 'E.V', department: 'BH', requester_name: 'Thư', required_date: '2026-10-20',
  priority: 'Gấp', purpose: 'Mua', vendor_name: 'NCC', budget_code: '', budget_approver_email: 'linh@x.vn', supplier_approver_email: 'linh@x.vn',
  items: [{ desc: 'Khăn', price: '029900' }], grand_total: '149500', status: 'Mua hàng (5/5)', submitted_at: new Date('2026-10-07T01:00:00Z'),
  metadata: { p2pBranch: 'simplified', requesterSignature: 'data:image/png;base64,' + 'A'.repeat(50000) }, contract_approver_email: '',
  purchasing_approver_email: 'tlc.ap@x.vn', attachments: [{ fileName: 'a', fileUrl: 'https://r2/a' }, { fileName: 'b', fileUrl: 'https://r2/b' }],
};

test('the live header has 70 columns; the PR row lands positionally where GAS reads it', () => {
  assert.equal(HEADER.length, 70);
  const cells = rowForHeader(HEADER, prRecord(row));
  assert.equal(cells.length, 70);
  assert.equal(cells[0], 'EV-PR20261007000001');
  assert.equal(cells[13], 149500);
  assert.equal(cells[14], 'Mua hàng (5/5)');
  assert.equal(cells[15], '2026-10-07T01:00:00.000Z');
  assert.equal(cells[19], 'https://r2/a, https://r2/b');
  assert.equal(cells[20], 'submit', 'first row_type column (GAS row[20])');
  assert.deepEqual(cells.slice(21), Array(49).fill(''), 'repeated row_type/event_* columns stay empty');
  const meta = JSON.parse(cells[16]);
  assert.equal(meta.p2pBranch, 'simplified');
  assert.equal(meta.requesterSignature, '[đã lưu trong hệ thống]', 'cell limit');
  assert.equal(JSON.parse(cells[12])[0].price, '029900');
});
test('PR_KEY matches the submit row, never an event row', () => {
  assert.equal(PR_KEY, 'pr_no,row_type');
});
test('auditRecord: PR_Audit_Log columns', () => {
  assert.deepEqual(auditRecord({ docNo: 'EV-1', company: 'CT', action: 'Approve', role: 'budget', actorEmail: 'linh@x.vn', actorName: '',
    prevStatus: 'a', newStatus: 'b', at: '2026-10-07T02:00:00.000Z', note: '', extra: { signatureUploaded: true } }), {
    document_no: 'EV-1', flow: 'PR', company_name: 'CT', action: 'Approve', role: 'budget', actor_email: 'linh@x.vn', actor_name: '',
    prev_status: 'a', new_status: 'b', timestamp: '2026-10-07T02:00:00.000Z', note: '', extra_json: '{"signatureUploaded":true}',
  });
});
test('auditRecord lands positionally under the live PR_Audit_Log header', () => {
  const header = 'document_no,flow,company_name,action,role,actor_email,actor_name,prev_status,new_status,timestamp,note,extra_json'.split(',');
  const cells = rowForHeader(header, auditRecord({ docNo: 'EV-1', action: 'Reject', role: 'budget', actorEmail: ' Linh@X.vn ', at: '2026-10-07T02:00:00.000Z', note: 'thiếu' }));
  assert.deepEqual(cells, ['EV-1', 'PR', '', 'Reject', 'budget', 'linh@x.vn', '', '', '', '2026-10-07T02:00:00.000Z', 'thiếu', '']);
});
test('items_json stays valid JSON under 45,000 chars: long note/desc cut first, then a summary', () => {
  const long = (n) => Array.from({ length: n }, (_, i) => ({ desc: 'D'.repeat(1000), note: 'N'.repeat(1000), qty: '1', price: '10', total: 10, section: 's' + i }));
  const small = JSON.parse(prRecord({ ...row, items: long(2) }).items_json);
  assert.equal(small[0].desc.length, 1000, 'verbatim when it fits');
  const cut = prRecord({ ...row, items: long(40) }).items_json; // ~80k verbatim
  assert.ok(cut.length <= 45000, `cut: ${cut.length}`);
  const c = JSON.parse(cut);
  assert.equal(c.length, 40);
  assert.equal(c[0].desc, 'D'.repeat(200) + '…');
  assert.equal(c[0].note, 'N'.repeat(200) + '…');
  assert.equal(c[39].section, 's39');
  const huge = prRecord({ ...row, items: long(200).map((it) => ({ ...it, unit: 'U'.repeat(1000) })) }).items_json; // still too big after cutting
  assert.ok(huge.length <= 45000);
  assert.deepEqual(JSON.parse(huge), [{ truncated: true, count: 200, grandTotal: 149500 }]);
  const cells = rowForHeader(HEADER, prRecord({ ...row, items: long(200) }));
  assert.doesNotThrow(() => JSON.parse(cells[12]), 'the cell itself parses (never cut by the 49k cap)');
});
