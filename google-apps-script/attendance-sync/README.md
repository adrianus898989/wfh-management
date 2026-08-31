# Attendance and adjustment live sync setup

This is a private, change-detected Google Sheets push. It keeps the two legacy
August `休假填表` sources and adds twelve logical September-December sources from
the three 2026 annual workbooks:

- onsite-to-home: USD
- home Vietnam / Indonesia / Myanmar: USD
- home Philippines: PHP

Each annual logical source combines one monthly attendance tab with that month's
block in `奖惩填表`. Monthly day cells produce only sparse exception events (`公`,
`回`, `请`, `半`, `缺`/`旷工`, `离`). Blank or unknown day cells are not stored.
Every non-zero fill-form amount is interpreted by its sign: positive is a bonus
and negative is a deduction.

The two standard USD workbooks keep dynamic compatibility with both their
current seven-column layout (`姓名 / ID / 奖金 / 扣除 / 类型 / 备注 / 日期`) and
the earlier six-column layout without `类型`. The Philippines workbook is a
separate exact nine-column protocol:

`姓名 / ID / 金额1-15 / 类型 / 金额16-末 / 类型 / 备注1-15 / 备注16-末 / 日期`

Its live September–December business blocks start at `A / K / U / AE`; the
paired six-column metadata blocks start at `AO / AU / BA / BG`. The resolver
accepts a Philippines block only when its row-1 month title and all nine row-2
headers match, then derives the installed metadata region from all four exact
six-column headers. Missing, partial, reordered, or conflicting headers stop the
read before any business row is sent. The Apps Script is read-only and does not
alter business structure or access March–August blocks.

The Philippines first-half and second-half amounts become separate records,
carry their own type and paired note, and share the row's date. The outbound
payload declares `adjustment_schema: philippines` and preserves all nine cells.

The reader also includes the hidden adjustment-v1 ownership metadata in every
annual snapshot. A complete valid managed triplet makes the annual importer skip
that adjustment (the Philippines halves are independent). Any non-empty partial
or invalid triplet rejects the whole snapshot, so the annual and bidirectional
adjustment importers cannot silently double-count or guess ownership.

## Cost and retry behavior

- An annual `onEdit` trigger only records which logical month changed. It reads
  no annual ranges and sends no HTTP request.
- A one-minute trigger waits at least 45 seconds after the latest edit, combining
  an edit burst into one month snapshot.
- The monthly snapshot projects only employee identity/context and day-status
  columns, so salary or bank-detail edits do not change its hash.
- An unchanged hash performs zero Edge Function calls and zero Supabase writes.
- A daily low-frequency reconciliation catches formula/API changes that do not
  emit `onEdit`; it also skips unchanged hashes.
- HTTP 4xx/redirect responses are blocked for that exact hash and are not retried.
  A changed sheet hash or a deliberate manual run can try again.
- Network and HTTP 5xx failures use exponential backoff and reuse the same
  `request_id`, so a lost success response cannot duplicate records.

## Trust boundary

The spreadsheets remain private and no Google credential enters Supabase. The
Edge Function accepts only exact combinations of source key, spreadsheet ID,
monthly tab/gid, and `填表` gid. The raw sync token stays only in Apps Script
Properties. The committed Edge code contains only its SHA-256 digest.

Annual record identity is derived from employee ID (name only when ID is blank),
event date, source block/adjustment slot, and logical source. It does not use the
physical Google row number. Row insertions therefore update audit location rather
than deleting and recreating the logical event. Employee matching in Supabase is
also exact employee ID first, followed by unique normalized name only when needed.
The fixed source metadata is authoritative for adjustment currency: onsite and
Vietnam/Indonesia/Myanmar are always USD, and Philippines is always PHP, even
before an employee can be matched or a country value is available.

The database still rejects automatic removals by default. Migration
`20260831123000_attendance_count_preserving_date_corrections.sql` adds one narrow
exception for correcting a date: at most five old keys may move, the complete
snapshot may not shrink, and every employee/source-block/event-kind count must
stay equal or increase. Removing a record, changing its employee/type, or a
larger correction remains blocked for explicit review. Failed-run diagnostics
retain the proposed record count and detected deletion count instead of showing
misleading zeroes after the staging transaction rolls back.

## Deployment preparation

Do not put the raw token in source control.

Install the bidirectional adjustment chain first. In particular, apply
`20260825143710_admin_adjustment_bidirectional_outbox.sql`, deploy
`supabase/functions/adjustment-sheet-sync`, and run its Apps Script installer so
the managed hidden metadata headers exist. Do not install the annual attendance
triggers before that step: this reader intentionally fails closed when those
headers are missing or malformed.

Then install the attendance chain in this order:

1. Apply `20260825144614_annual_attendance_sep_dec_incremental_sync.sql`, then
   `20260831123000_attendance_count_preserving_date_corrections.sql`, after review.
2. Deploy `supabase/functions/attendance-sheet-sync` with Supabase JWT verification
   disabled. Google Apps Script cannot mint a Supabase user JWT; the function
   validates the high-entropy shared token before parsing.
3. Copy `Code.gs` and `appsscript.json` into the standalone Apps Script project.
4. Set Script Properties:
   - `ATTENDANCE_SYNC_URL` =
     `https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync`
   - `ATTENDANCE_SYNC_TOKEN` = the raw token whose SHA-256 matches the committed
     Edge Function digest.
5. Run `installAttendanceSync()` once using a trusted Google account that can
   read all five private workbooks. It replaces managed triggers, validates all
   exact tabs/gids, installs five source-bound `onEdit` triggers, one one-minute
   flusher, and one daily reconciliation trigger, then performs a manual initial
   reconciliation.

`runAttendanceReconciliation()` is the deliberate force-retry entrypoint.
Run it once after deploying the correction migration when the current hash was
already blocked by the former any-delete rule; the existing blocked hash will
otherwise wait for another relevant sheet edit.
`removeAttendanceSyncTriggers()` removes only the handlers managed here.

## Verification before deployment

1. Run `deno check` on the Edge Function sources.
2. Run `deno test supabase/functions/attendance-sheet-sync/normalize_test.ts`.
3. Apply the migration to an isolated/local database, then run
   `supabase/tests/annual_attendance_sep_dec_sync.sql`.
4. Test one month in each layout: change a day status, a positive amount, a
   negative amount, and both Philippines half-month amounts.
5. Confirm an unchanged follow-up causes no HTTP call; simulate one 422 and one
   503 to verify no-retry vs idempotent backoff behavior.

This repository change does not deploy the Edge Function, execute production SQL,
install Apps Script triggers, or write any Google Sheet.
