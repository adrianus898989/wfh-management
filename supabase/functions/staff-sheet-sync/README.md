# staff-sheet-sync v20

This Edge Function is the compatibility router for the legacy staff workbook.

- `在职名单 Current Staff List` and schedule edits are acknowledged as
  `managed_by: employee-master-sync`; this function never writes those rows.
- `银行信息` is acknowledged as `managed_by: staff-full-reconcile-v2`; the
  Apps Script invokes that function next, and treats the edit as successful
  only when both responses are 2xx with `ok === true`, `paused !== true`, and
  no `error` field. `staff-full-reconcile-v2` remains the only bank writer.
- `现场转居家` is the only source written by v20. It uses a cross-isolate lease
  and one transactional Postgres RPC with a durable idempotency ledger.
- A request contains at most eight rows.

Deploy with JWT verification disabled because Google Apps Script uses the
private staff sync secret. v20 accepts the preferred `x-sync-secret` header and
the legacy bounded JSON `secret` field used by the installed batch trigger.
The body must be read first for that compatibility path; its declared and
actual byte sizes are bounded before processing. The secret is removed by the
explicit protocol normalizer and is never included in the payload hash, RPC,
ledger, or logs.
