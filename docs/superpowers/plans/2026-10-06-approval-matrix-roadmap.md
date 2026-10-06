# Approval Matrix + Vouchers on Postgres — Roadmap

Decisions (user, 2026-10-06):
- Only **admins** edit approval flows (many admins; no per-workflow owners).
- Flows vary **per company** (no amount / department conditions).
- Approvers are a **role resolved per company, shown with today's person** —
  e.g. "Chief Accountant (Nguyễn Thị Nhanh)" — or a **named person**. When the
  Chief Accountant changes in Master Data, flows pick up the new person
  without being edited.
- A step with several approvers needs **all** of them.
- Start with **Vouchers**: migrate to Postgres, then drive them by the matrix.

Three plans, each shippable and testable alone:

| # | Plan | Delivers | Depends on |
|---|---|---|---|
| 1 | `2026-10-06-approval-matrix-foundation.md` | Flow tables + versions, role resolver, pure approval engine (tested), admin API, **Approval Flows editor** page | — |
| 2 | `voucher-postgres-parity` (to write after 1) | Voucher actions on Postgres at parity with GAS (summary + visibility, history, status, bulk approve, acknowledge, uploads, signatures, emails, reminders), driven by the engine; import of Voucher_Current + Voucher_History | 1 |
| 3 | `voucher-ui-dynamic-steps` (to write after 2) | voucher.html / approve_voucher.html show N steps and group steps instead of the fixed 3; My Task by "my pending step"; cutover with `PG_WORKFLOWS=vouchers` | 2 |

In-flight safety: every document stores a **snapshot of its resolved plan**
at submit time; editing a flow only affects documents submitted afterwards.
