# Employee master dual-source sync

This private endpoint accepts one atomic snapshot containing both allowlisted
Google sources:

- `1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8`, gid `970844334`,
  `在职名单 Current Staff List!A:P`
- `1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA`, gid `1457335551`,
  `填表!A:M`

The current-staff source owns official identity, the official display name, and explicit status evidence.
The schedule owns live assignment fields and can add an ID-backed schedule-only
employee only when `工作内容` includes `现场人员`. Duplicate IDs, source/header
drift, partial reads and large source outages fail closed before canonical rows
change.

Cross-source rows are joined by normalized employee ID. A differing schedule
name is retained in the source snapshot and recorded as a
`cross_source_name_mismatch` reconciliation issue, but it does not block the
complete snapshot or replace the official current-staff name.

The endpoint is intended for deployment with JWT verification disabled because
Google Apps Script cannot mint a Supabase JWT. It authenticates the dedicated
`X-Employee-Master-Sync-Token` against a committed SHA-256 digest before reading
the request body. The raw token must remain in Apps Script Properties.

```sh
supabase functions deploy employee-master-sync --no-verify-jwt
```

Apply `employee_master_dual_source_sync` first. The database RPC is explicitly
granted only to `service_role`. A normalized-name-only match to a `TMP-SCHED-*`
record is never rekeyed automatically; it records a manual-review issue. An ID
change requires stronger identity evidence outside this ingest path.

Absence from both complete sources only increments evidence and records a
`pending_manual_review` issue. It never changes employee status, portal access,
sessions, or Auth users, regardless of the number of missing snapshots. Only an
explicit resignation date or strict positive resignation marker in the home
source may set resigned status.

The home A:P payload retains full header/raw-hash integrity, while the combined
idempotency hash uses only employee-master fields A:L plus canonical dates.
Changes in M:P therefore do not cause a reconciliation write.

Run before deployment:

```sh
deno test supabase/functions/employee-master-sync/normalize_test.ts
node --test google-apps-script/employee-master-sync/Code.test.mjs
```
