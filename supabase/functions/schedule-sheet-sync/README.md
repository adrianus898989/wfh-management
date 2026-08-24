# Private schedule roster push

This Edge Function receives only the allowlisted private roster source:

- Spreadsheet: `1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA`
- gid: `1457335551`
- tab/range: `填表!A:M`
- snapshot key: `居家排班表/填表`

Deploy it with Supabase JWT verification disabled. Google Apps Script cannot
mint a Supabase user JWT; the function authenticates `X-Schedule-Sync-Token`
against the committed SHA-256 digest before reading the request body. The raw
token must never be committed. It may be the same existing high-entropy raw
token already used by the attendance push because this function intentionally
uses the same committed digest.

```sh
supabase functions deploy schedule-sheet-sync --no-verify-jwt
```

Before deployment, apply the schedule live-sync migration. The Edge Function
uses the runtime-provided service-role key only to call the locked, atomic
`ingest_schedule_roster_snapshot(jsonb)` RPC. The RPC upserts the durable roster
snapshot and rebuilds the derived employee directory in one transaction.

Run `deno test supabase/functions/schedule-sheet-sync/normalize_test.ts` before
deployment. After Google setup, edit one harmless `填表!A:M` cell, confirm a
successful row in `schedule_sheet_sync_runs`, then restore the cell and confirm
the reverse update. An unchanged five-minute fallback reads and hashes the sheet
but does not invoke Edge Functions.
