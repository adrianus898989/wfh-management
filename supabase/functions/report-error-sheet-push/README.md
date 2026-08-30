# Private finance error sheet push

`report-error-sheet-push` is the source-bound writer for the private workbook
`财务 出款 质检错误记录`. It exists because OpenSheet and anonymous Google CSV
exports cannot read that workbook (OpenSheet returns 400 and Google gviz returns
401). Do not make the finance workbook public.

The endpoint:

- authenticates `X-Report-Error-Sync-Token` before reading the body;
- reuses the same committed token digest as the existing attendance, schedule,
  and employee-master private-sheet writers, or the existing WFH System
  `STAFF_SHEET_SYNC_SECRET`, so the raw token can remain in the already-authorized
  Apps Script project's Script Properties;
- allowlists the exact spreadsheet ID, gid, tab name, and source name;
- rejects malformed hashes, empty snapshots, excessive invalid rows, stale
  captures, and unconfirmed large shrinks;
- shares the `report-sheet-sync` runtime lease, so cron and push cannot write the
  same source concurrently;
- updates only the finance error chunks. The existing 10-minute report cron sees
  the changed detail generation and rebuilds employee summaries.

Deploy with platform JWT verification disabled; the function performs its own
source-token verification:

```sh
supabase functions deploy report-error-sheet-push --no-verify-jwt
```

Then install `google-apps-script/report-error-sync/Code.gs` in the existing
private-sheet Apps Script project and run `installReportErrorSheetSync` once.

Tests:

```sh
deno test supabase/functions/report-sheet-sync/errorNormalization_test.ts \
  supabase/functions/report-error-sheet-push/protocol_test.ts
deno check supabase/functions/report-error-sheet-push/index.ts
```
