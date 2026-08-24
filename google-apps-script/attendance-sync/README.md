# August attendance live sync setup

This is a change-detected push, not a service-account pull. The standalone Apps
Script reads only the exact `休假填表!A:N` ranges in the two allowlisted August
2026 spreadsheets. Two source-bound installable `onEdit` triggers provide
near-immediate sync for human edits and read only the spreadsheet that emitted
the event. A five-minute fallback hashes both sources to catch formula/API edits,
which do not emit `onEdit`. The Edge Function is called only when a hash changes,
plus one unchanged reconciliation per source per day.

## Why this architecture

- The private spreadsheets do not need to be shared with a service account.
- Google credentials never enter Supabase, and the Supabase service role never
  enters Google Apps Script or a browser.
- Human edits do not poll the other source. Unchanged five-minute fallback checks
  consume Apps Script time but no Edge invocation.
- The Edge Function accepts only the two exact August-source spreadsheet IDs,
  gids, tab name, and source keys. The source window is `[2026-08-01, 2026-10-01)`
  rather than a hard event-date cut at August 31 because the current home source
  legitimately contains several early-September rows.
- The database applies each complete snapshot atomically, with idempotent request
  IDs, fixed row identities, authoritative missing-row deletes, and before/after
  audit. A guard rejects empty snapshots and automatic deletes that exceed 50%
  or 100 rows.

## Deployment preparation

Do not put the raw token in source control.

1. Apply `supabase/migrations/20260824060000_attendance_august_live_sync.sql`.
2. Use the high-entropy raw token whose SHA-256 matches the committed
   `EXPECTED_TOKEN_SHA256` constant. That public digest is the sole authoritative
   expected hash for this deployment; the Edge code never contains the raw token.
3. Deploy `supabase/functions/attendance-sheet-sync` with Supabase JWT verification
   disabled. Google Apps Script cannot mint a Supabase user JWT; the function
   instead checks the high-entropy token before parsing the body. It then uses the
   Edge runtime's server-only `SUPABASE_SERVICE_ROLE_KEY` solely for the locked RPC.
4. Create a standalone Apps Script project and copy `Code.gs` and
   `appsscript.json`. In Project Settings, add Script Properties:
   - `ATTENDANCE_SYNC_URL` =
     `https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync`
   - `ATTENDANCE_SYNC_TOKEN` = the raw token from step 2.

The script rejects any URL other than that exact production endpoint, including
lookalike hosts, alternate paths, query strings, and redirects.

## The one Google authorization step

While signed in as a Google user who already has editor access to both private
spreadsheets, run `installAttendanceSync()` once and approve Google's prompt. That
single authorization creates two installable `onEdit` triggers and one five-minute
fallback trigger, then immediately performs a full reconciliation of both sources.

Google requires the full `spreadsheets` OAuth scope to create an installable
`onEdit` trigger for spreadsheets referenced by ID from a standalone project.
The supplied code still performs reads only (`openById`, `getDisplayValues`) and
contains no sheet write operation. Use a dedicated trusted Workspace account with
access limited to these sheets if the broader Google consent is undesirable.

There is no service-account key, OAuth refresh token, or private-sheet sharing
step. `runAttendanceReconciliation()` is available for a deliberate manual retry.

To rotate the ingest credential, generate a new high-entropy raw token, replace
the committed `EXPECTED_TOKEN_SHA256` with its digest and deploy the Edge
Function, then update the Apps Script `ATTENDANCE_SYNC_TOKEN` property. Never put
the raw token in the repository or Edge source. If a future deployment migrates
to an Edge secret, make that a separate code change whose missing-secret behavior
fails closed; do not add an environment-variable fallback.

## Update and delete behavior

The stable identity is `(source_id, source_block, source_row, source_item_key)`;
`is_mirror` is updateable and never part of that identity. Each accepted snapshot
upserts changed rows and deletes only records from the same allowlisted August
source that are missing from the new full snapshot. Audit runs are stored in
`attendance_sheet_sync_runs`, while row-level before/after changes are stored in
`attendance_sheet_sync_changes`. Both tables deny anon/authenticated direct access.
The first live run treats the legacy 32-character source MD5 as non-comparable
and performs a full reconciliation; successful live runs then store SHA-256.

Automatic empty snapshots or snapshots deleting more than 50% or more than 100
rows are rejected. A true bulk clear requires a direct service-role manual RPC
with both `trigger_kind = "manual"` and `allow_large_delete = true`; the public
Apps Script/Edge path never forwards that override.

## Verification after deployment

1. Run `deno test supabase/functions/attendance-sheet-sync/normalize_test.ts`.
2. Run `installAttendanceSync()` and confirm two successful rows in
   `attendance_sheet_sync_runs`.
3. Change one harmless August test cell and confirm the onEdit run's update count
   and before/after audit row. The fallback normally runs about every five
   minutes, but Google scheduling and Apps Script quotas can delay execution.
4. Restore the cell and confirm the reverse update. Verify no March-July source
   IDs appear in either audit table.
