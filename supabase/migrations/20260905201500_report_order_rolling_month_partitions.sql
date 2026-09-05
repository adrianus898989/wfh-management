begin;

-- This migration rewrites only the small efficiency mirror (about one to two
-- months of rows).  Fail rather than queue behind production traffic; a retry
-- is safer than holding catalog or row locks on the reports hot path.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $verify_report_order_month_prerequisites$
begin
  if pg_catalog.to_regclass('public.report_order_rows') is null
     or pg_catalog.to_regclass('public.report_order_sync_chunks') is null
     or pg_catalog.to_regclass(
       'attendance_private.report_order_cache_dirty_accounts'
     ) is null
     or pg_catalog.to_regclass(
       'attendance_private.sheet_sync_runtime_leases'
     ) is null then
    raise exception using
      errcode = '55000',
      message = 'report_order_month_prerequisite_missing';
  end if;
end;
$verify_report_order_month_prerequisites$;

-- Preserve the exact legacy rows removed by the one-time canonicalization.
-- This table is intentionally private and has no API/service-role grants; a
-- database owner can perform an explicit recovery if the source evidence is
-- ever needed, without keeping duplicate rows on the public hot path.
create table attendance_private.report_order_legacy_fill_archive (
  source_sheet text not null,
  source_row integer not null,
  work_date date not null,
  account text not null,
  processed integer not null,
  rejected integer not null,
  content_hash text not null,
  synced_at timestamptz not null,
  archived_at timestamptz not null,
  archive_reason text not null,
  finalized_through date not null,
  primary key (source_sheet, source_row),
  constraint report_order_fill_archive_source_row_check check (
    source_row >= 2
  ),
  constraint report_order_fill_archive_source_check check (
    source_sheet = '填表'
    or source_sheet like '填表/%'
  ),
  constraint report_order_fill_archive_reason_check check (
    archive_reason = 'covered_by_finalized_work_sheet_4'
  )
);

alter table attendance_private.report_order_legacy_fill_archive
  enable row level security;
revoke all on table attendance_private.report_order_legacy_fill_archive
  from public, anon, authenticated, service_role;

-- A marker is deliberately kept outside the exposed public schema.  The Edge
-- function does not need direct table access: the monthly replacement RPC both
-- checks and updates the marker in the same transaction as the row swap.
create table attendance_private.report_order_rolling_month_markers (
  month_key text primary key,
  content_hash text not null,
  row_count integer not null,
  finalized_through date not null,
  synced_at timestamptz not null default clock_timestamp(),
  constraint report_order_rolling_month_markers_month_check check (
    month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
  ),
  constraint report_order_rolling_month_markers_hash_check check (
    content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint report_order_rolling_month_markers_count_check check (
    row_count between 0 and 100000
  )
);

alter table attendance_private.report_order_rolling_month_markers
  enable row level security;
revoke all on table attendance_private.report_order_rolling_month_markers
  from public, anon, authenticated, service_role;

-- Canonicalize the legacy combined Fill sheet.  Work Sheet 4 is the finalized
-- source.  Legacy Fill rows on or before its latest date duplicate finalized
-- data and must be removed; later rows are retained under stable month source
-- names so Google may restart row numbering every month without a PK collision.
do $canonicalize_report_order_rolling_months$
declare
  v_finalized_through date;
  v_work4_rows_before bigint;
  v_work4_processed_before numeric;
  v_work4_rejected_before numeric;
  v_work4_synced_before timestamptz;
  v_work4_rows_after bigint;
  v_work4_processed_after numeric;
  v_work4_rejected_after numeric;
  v_work4_synced_after timestamptz;
  v_rolling_rows_before bigint;
  v_rolling_rows_after bigint;
  v_delete_expected bigint;
  v_archived bigint;
  v_deleted bigint;
  v_move_expected bigint;
  v_moved bigint;
  v_dirty_accounts text[] := '{}'::text[];
  v_archive_at constant timestamptz := clock_timestamp();
  v_archive_reason constant text := 'covered_by_finalized_work_sheet_4';
  v_migration_holder constant uuid :=
    '00000000-0000-0000-0000-202609052015'::uuid;
  v_report_lease_holder uuid;
  v_report_lease_released integer := 0;
begin
  -- Serialize migration cleanup with the bounded cache finalizer.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-report-order-cache-sync', 0)
  ) or not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-report-order-rolling-migration', 0)
  ) then
    raise exception using
      errcode = '55P03',
      message = 'report_order_month_migration_busy';
  end if;

  -- Claim a transaction-owned sentinel lease.  Production normally deletes
  -- this row after each run, so INSERT handles the common absent-row case.
  -- ON CONFLICT atomically takes an expired row, but returns nothing for a live
  -- holder.  The inserted/updated row remains locked until commit, preventing a
  -- cron invocation from claiming the report lease during canonicalization.
  insert into attendance_private.sheet_sync_runtime_leases as lease (
    job_name,
    holder,
    acquired_at,
    expires_at
  ) values (
    'report-sheet-sync',
    v_migration_holder,
    clock_timestamp(),
    clock_timestamp() + interval '2 minutes'
  )
  on conflict (job_name) do update
  set holder = excluded.holder,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
  where lease.expires_at <= clock_timestamp()
     or lease.holder = excluded.holder
  returning holder into v_report_lease_holder;

  if v_report_lease_holder is distinct from v_migration_holder then
    raise exception using
      errcode = '55P03',
      message = 'report_order_month_sync_is_active';
  end if;

  -- The lease coordinates normal Edge invocations; this bounded table lock
  -- also excludes any direct service-role writer so the archive snapshot and
  -- subsequent delete are provably the same row set.  Reads remain available.
  lock table public.report_order_rows in share row exclusive mode;

  select
    max(rows.work_date),
    count(*)::bigint,
    coalesce(sum(rows.processed), 0),
    coalesce(sum(rows.rejected), 0),
    max(rows.synced_at)
  into
    v_finalized_through,
    v_work4_rows_before,
    v_work4_processed_before,
    v_work4_rejected_before,
    v_work4_synced_before
  from public.report_order_rows rows
  where rows.source_sheet = '工作表4';

  if v_finalized_through is null or v_work4_rows_before = 0 then
    raise exception using
      errcode = '55000',
      message = 'report_order_finalized_source_empty';
  end if;

  if exists (
    select 1
    from public.report_order_rows rows
    where (
      rows.source_sheet = '填表'
      or rows.source_sheet like '填表/%'
    )
      and (
        nullif(btrim(rows.account), '') is null
        or char_length(lower(btrim(rows.account))) > 256
      )
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid_legacy_report_order_account';
  end if;

  select
    count(*)::bigint,
    count(*) filter (
      where rows.work_date <= v_finalized_through
    )::bigint,
    count(*) filter (
      where rows.source_sheet = '填表'
        and rows.work_date > v_finalized_through
    )::bigint,
    coalesce(
      array_agg(distinct lower(btrim(rows.account))) filter (
        where nullif(btrim(rows.account), '') is not null
      ),
      '{}'::text[]
    )
  into
    v_rolling_rows_before,
    v_delete_expected,
    v_move_expected,
    v_dirty_accounts
  from public.report_order_rows rows
  where rows.source_sheet = '填表'
     or rows.source_sheet like '填表/%';

  insert into attendance_private.report_order_legacy_fill_archive (
    source_sheet,
    source_row,
    work_date,
    account,
    processed,
    rejected,
    content_hash,
    synced_at,
    archived_at,
    archive_reason,
    finalized_through
  )
  select
    rows.source_sheet,
    rows.source_row,
    rows.work_date,
    rows.account,
    rows.processed,
    rows.rejected,
    rows.content_hash,
    rows.synced_at,
    v_archive_at,
    v_archive_reason,
    v_finalized_through
  from public.report_order_rows rows
  where (
    rows.source_sheet = '填表'
    or rows.source_sheet like '填表/%'
  )
    and rows.work_date <= v_finalized_through;
  get diagnostics v_archived = row_count;

  -- INSERT ... SELECT copies every original column directly from the exact
  -- locked predicate later used by DELETE.  The archive primary key prevents
  -- duplicate target identities, and ROW_COUNT proves set-level coverage
  -- without performing tens of thousands of per-row archive index probes.
  if v_archived <> v_delete_expected then
    raise exception using
      errcode = '55000',
      message = 'report_order_legacy_archive_count_mismatch';
  end if;

  -- Queue every account before changing raw rows.  Queue writes and the row
  -- rewrite commit together, so cache refresh can never acknowledge a change
  -- which did not commit.
  insert into attendance_private.report_order_cache_dirty_accounts as dirty (
    account,
    first_marked_at,
    last_marked_at
  )
  select affected.account, clock_timestamp(), clock_timestamp()
  from pg_catalog.unnest(v_dirty_accounts) affected(account)
  on conflict (account) do update
  set last_marked_at = excluded.last_marked_at;

  delete from public.report_order_rows rows
  where (
    rows.source_sheet = '填表'
    or rows.source_sheet like '填表/%'
  )
    and rows.work_date <= v_finalized_through;
  get diagnostics v_deleted = row_count;

  update public.report_order_rows rows
  set source_sheet = '填表/' || pg_catalog.to_char(rows.work_date, 'YYYY-MM')
  where rows.source_sheet = '填表'
    and rows.work_date > v_finalized_through;
  get diagnostics v_moved = row_count;

  -- Chunk markers belong to the retired, row-position-based Fill protocol.
  delete from public.report_order_sync_chunks chunks
  where chunks.source_sheet = '填表';

  insert into attendance_private.report_order_rolling_month_markers as marker (
    month_key,
    content_hash,
    row_count,
    finalized_through,
    synced_at
  )
  select
    pg_catalog.to_char(rows.work_date, 'YYYY-MM'),
    pg_catalog.repeat('0', 64),
    count(*)::integer,
    v_finalized_through,
    max(rows.synced_at)
  from public.report_order_rows rows
  where rows.source_sheet like '填表/%'
  group by pg_catalog.to_char(rows.work_date, 'YYYY-MM')
  on conflict (month_key) do update
  set content_hash = excluded.content_hash,
      row_count = excluded.row_count,
      finalized_through = excluded.finalized_through,
      synced_at = excluded.synced_at;

  select count(*)::bigint
  into v_rolling_rows_after
  from public.report_order_rows rows
  where rows.source_sheet like '填表/%';

  select
    count(*)::bigint,
    coalesce(sum(rows.processed), 0),
    coalesce(sum(rows.rejected), 0),
    max(rows.synced_at)
  into
    v_work4_rows_after,
    v_work4_processed_after,
    v_work4_rejected_after,
    v_work4_synced_after
  from public.report_order_rows rows
  where rows.source_sheet = '工作表4';

  if v_archived <> v_delete_expected
     or v_deleted <> v_delete_expected
     or v_moved <> v_move_expected
     or v_rolling_rows_after <> v_rolling_rows_before - v_delete_expected then
    raise exception using
      errcode = '55000',
      message = 'report_order_rolling_canonicalization_count_mismatch';
  end if;

  if v_work4_rows_after is distinct from v_work4_rows_before
     or v_work4_processed_after is distinct from v_work4_processed_before
     or v_work4_rejected_after is distinct from v_work4_rejected_before
     or v_work4_synced_after is distinct from v_work4_synced_before then
    raise exception using
      errcode = '55000',
      message = 'report_order_finalized_source_changed';
  end if;

  if exists (
    select 1
    from public.report_order_rows rows
    where rows.source_sheet = '填表'
       or (
         rows.source_sheet like '填表/%'
         and (
           rows.work_date <= v_finalized_through
           or rows.source_sheet <>
             '填表/' || pg_catalog.to_char(rows.work_date, 'YYYY-MM')
         )
       )
  ) then
    raise exception using
      errcode = '55000',
      message = 'report_order_rolling_partition_invariant_failed';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(v_dirty_accounts) affected(account)
    where not exists (
      select 1
      from attendance_private.report_order_cache_dirty_accounts dirty
      where dirty.account = affected.account
    )
  ) then
    raise exception using
      errcode = '55000',
      message = 'report_order_dirty_account_coverage_failed';
  end if;

  -- Releasing inside the transaction still holds the unique-key lock until
  -- commit.  After commit, the next cron run can insert and own a fresh lease.
  delete from attendance_private.sheet_sync_runtime_leases lease
  where lease.job_name = 'report-sheet-sync'
    and lease.holder = v_migration_holder;
  get diagnostics v_report_lease_released = row_count;

  if v_report_lease_released <> 1 then
    raise exception using
      errcode = '55000',
      message = 'report_order_migration_lease_release_failed';
  end if;
end;
$canonicalize_report_order_rolling_months$;

-- Only finalized Work Sheet 4 and month-qualified rolling Fill sources are
-- valid after the one-time conversion.  NOT VALID avoids a long initial lock;
-- validation follows after the bounded data rewrite above.
alter table public.report_order_rows
  drop constraint if exists report_order_rows_canonical_source_sheet_check;
alter table public.report_order_rows
  add constraint report_order_rows_canonical_source_sheet_check check (
    source_sheet = '工作表4'
    or source_sheet ~ '^填表/[0-9]{4}-(0[1-9]|1[0-2])$'
  ) not valid;
alter table public.report_order_rows
  validate constraint report_order_rows_canonical_source_sheet_check;

-- One small preflight lets the Edge skip sending/replacing an unchanged month.
-- The private marker table itself remains inaccessible to API roles.
create or replace function public.report_order_rolling_month_markers()
returns table (
  month_key text,
  content_hash text,
  row_count integer,
  finalized_through date
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    marker.month_key,
    marker.content_hash,
    marker.row_count,
    marker.finalized_through
  from attendance_private.report_order_rolling_month_markers marker
  order by marker.month_key desc
  limit 120;
$function$;

revoke all on function public.report_order_rolling_month_markers()
  from public, anon, authenticated, service_role;
grant execute on function public.report_order_rolling_month_markers()
  to service_role;
alter function public.report_order_rolling_month_markers()
  set statement_timeout = '2s';
alter function public.report_order_rolling_month_markers()
  set lock_timeout = '500ms';

-- Replace one complete rolling month.  The function is intentionally fixed to
-- the Fill source family; callers cannot use it to replace finalized rows.
-- Empty rows are accepted only when Work Sheet 4 has finalized that entire
-- month, which provides an explicit and safe rollover cleanup path.
create or replace function public.sync_report_order_rolling_month(
  p_month text,
  p_content_hash text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_month text := btrim(coalesce(p_month, ''));
  v_hash text := btrim(coalesce(p_content_hash, ''));
  v_month_start date;
  v_month_end date;
  v_source_sheet text;
  v_finalized_through date;
  v_input_rows integer;
  v_existing_rows integer := 0;
  v_baseline_rows integer := 0;
  v_minimum_rows integer := 0;
  v_deleted integer := 0;
  v_inserted integer := 0;
  v_dirty integer := 0;
  v_marker_hash text;
  v_marker_rows integer;
  v_marker_finalized_through date;
  v_marker_synced_at timestamptz;
  v_synced_at timestamptz := clock_timestamp();
begin
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using
      errcode = '22023',
      message = 'invalid_report_order_month';
  end if;
  v_month_start := (v_month || '-01')::date;
  v_month_end := (
    v_month_start + interval '1 month' - interval '1 day'
  )::date;
  v_source_sheet := '填表/' || v_month;

  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'invalid_report_order_month_hash';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'invalid_report_order_month_rows';
  end if;

  v_input_rows := pg_catalog.jsonb_array_length(p_rows);
  if v_input_rows > 100000 then
    raise exception using
      errcode = '22023',
      message = 'report_order_month_row_limit_exceeded';
  end if;

  -- Validate strings before any integer/date casts.  A malformed item aborts
  -- the whole transaction; no input row is silently skipped.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) item
    where pg_catalog.jsonb_typeof(item) <> 'object'
       or not (
         case
           when coalesce(item->>'source_row', '') ~ '^[0-9]{1,10}$'
             then (item->>'source_row')::numeric between 2 and 2147483647
           else false
         end
       )
       or coalesce(item->>'work_date', '') !~
         '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
       or nullif(btrim(item->>'account'), '') is null
       or char_length(lower(btrim(item->>'account'))) > 256
       or not (
         case
           when coalesce(nullif(item->>'processed', ''), '0') ~ '^[0-9]{1,10}$'
             then coalesce(nullif(item->>'processed', ''), '0')::numeric
               between 0 and 2147483647
           else false
         end
       )
       or not (
         case
           when coalesce(nullif(item->>'rejected', ''), '0') ~ '^[0-9]{1,10}$'
             then coalesce(nullif(item->>'rejected', ''), '0')::numeric
               between 0 and 2147483647
           else false
         end
       )
       or char_length(coalesce(item->>'content_hash', '')) > 128
  ) then
    raise exception using
      errcode = '22023',
      message = 'malformed_report_order_month_row';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) item
    where (item->>'work_date')::date < v_month_start
       or (item->>'work_date')::date > v_month_end
  ) then
    raise exception using
      errcode = '22023',
      message = 'report_order_row_outside_month';
  end if;

  if (
    select count(*)
    from pg_catalog.jsonb_array_elements(p_rows) item
  ) <> (
    select count(distinct (item->>'source_row')::integer)
    from pg_catalog.jsonb_array_elements(p_rows) item
  ) then
    raise exception using
      errcode = '22023',
      message = 'duplicate_report_order_month_source_row';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wfh-report-order-rolling-month:' || v_month,
      0
    )
  ) then
    raise exception using
      errcode = '55P03',
      message = 'report_order_month_busy';
  end if;

  select max(rows.work_date)
  into v_finalized_through
  from public.report_order_rows rows
  where rows.source_sheet = '工作表4';

  if v_finalized_through is null then
    raise exception using
      errcode = '55000',
      message = 'report_order_finalized_source_empty';
  end if;

  -- The Edge filters with the same cutoff; this repeat check ensures a direct
  -- service-role RPC can never reintroduce overlap with finalized Work Sheet 4.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_rows) item
    where (item->>'work_date')::date <= v_finalized_through
  ) then
    raise exception using
      errcode = '22023',
      message = 'report_order_row_already_finalized';
  end if;

  select count(*)::integer,
         count(*) filter (
           where rows.work_date > v_finalized_through
         )::integer
  into v_existing_rows, v_baseline_rows
  from public.report_order_rows rows
  where rows.source_sheet = v_source_sheet;

  v_minimum_rows := case
    when v_baseline_rows > 0
      then pg_catalog.ceil(v_baseline_rows::numeric * 0.80)::integer
    else 0
  end;

  if v_input_rows < v_minimum_rows then
    raise exception using
      errcode = '22023',
      message = 'report_order_month_below_baseline',
      detail = pg_catalog.format(
        'month=%s incoming=%s baseline=%s minimum=%s',
        v_month,
        v_input_rows,
        v_baseline_rows,
        v_minimum_rows
      );
  end if;

  if v_input_rows = 0 and v_month_end > v_finalized_through then
    raise exception using
      errcode = '22023',
      message = 'empty_unfinalized_report_order_month';
  end if;

  select
    marker.content_hash,
    marker.row_count,
    marker.finalized_through,
    marker.synced_at
  into
    v_marker_hash,
    v_marker_rows,
    v_marker_finalized_through,
    v_marker_synced_at
  from attendance_private.report_order_rolling_month_markers marker
  where marker.month_key = v_month
  for update;

  if v_marker_hash = v_hash
     and v_marker_rows = v_input_rows
     and v_marker_finalized_through = v_finalized_through
     and v_existing_rows = v_input_rows
     and v_existing_rows = v_baseline_rows then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'changed', false,
      'source_sheet', v_source_sheet,
      'month', v_month,
      'rows', v_input_rows,
      'inserted_rows', 0,
      'deleted_rows', 0,
      'cache_accounts_queued', 0,
      'baseline_rows', v_baseline_rows,
      'minimum_rows', v_minimum_rows,
      'minimum_retained_percent', 80,
      'content_hash', v_hash,
      'finalized_through', v_finalized_through,
      'synced_at', v_marker_synced_at
    );
  end if;

  insert into attendance_private.report_order_cache_dirty_accounts as dirty (
    account,
    first_marked_at,
    last_marked_at
  )
  select affected.account, v_synced_at, v_synced_at
  from (
    select lower(btrim(rows.account)) account
    from public.report_order_rows rows
    where rows.source_sheet = v_source_sheet
      and nullif(btrim(rows.account), '') is not null
    union
    select lower(btrim(item->>'account')) account
    from pg_catalog.jsonb_array_elements(p_rows) item
  ) affected
  on conflict (account) do update
  set last_marked_at = excluded.last_marked_at;
  get diagnostics v_dirty = row_count;

  delete from public.report_order_rows rows
  where rows.source_sheet = v_source_sheet;
  get diagnostics v_deleted = row_count;

  insert into public.report_order_rows (
    source_sheet,
    source_row,
    work_date,
    account,
    processed,
    rejected,
    content_hash,
    synced_at
  )
  select
    v_source_sheet,
    (item->>'source_row')::integer,
    (item->>'work_date')::date,
    lower(btrim(item->>'account')),
    coalesce(nullif(item->>'processed', ''), '0')::integer,
    coalesce(nullif(item->>'rejected', ''), '0')::integer,
    coalesce(item->>'content_hash', ''),
    v_synced_at
  from pg_catalog.jsonb_array_elements(p_rows) item;
  get diagnostics v_inserted = row_count;

  if v_inserted <> v_input_rows then
    raise exception using
      errcode = '55000',
      message = 'report_order_month_insert_count_mismatch';
  end if;

  insert into attendance_private.report_order_rolling_month_markers as marker (
    month_key,
    content_hash,
    row_count,
    finalized_through,
    synced_at
  ) values (
    v_month,
    v_hash,
    v_inserted,
    v_finalized_through,
    v_synced_at
  )
  on conflict (month_key) do update
  set content_hash = excluded.content_hash,
      row_count = excluded.row_count,
      finalized_through = excluded.finalized_through,
      synced_at = excluded.synced_at;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'changed', true,
    'source_sheet', v_source_sheet,
    'month', v_month,
    'rows', v_inserted,
    'inserted_rows', v_inserted,
    'deleted_rows', v_deleted,
    'cache_accounts_queued', v_dirty,
    'baseline_rows', v_baseline_rows,
    'minimum_rows', v_minimum_rows,
    'minimum_retained_percent', 80,
    'content_hash', v_hash,
    'finalized_through', v_finalized_through,
    'synced_at', v_synced_at
  );
end;
$function$;

revoke all on function public.sync_report_order_rolling_month(text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.sync_report_order_rolling_month(text, text, jsonb)
  to service_role;
alter function public.sync_report_order_rolling_month(text, text, jsonb)
  set statement_timeout = '8s';
alter function public.sync_report_order_rolling_month(text, text, jsonb)
  set lock_timeout = '1s';

-- Build daily totals within each source family first, then select one family
-- per account/date.  Finalized Work Sheet 4 wins over any rolling partition;
-- multiple rows inside the chosen family continue to be summed.
create or replace function public.report_order_account_summary_v2(
  p_date_from date default null,
  p_date_to date default null,
  p_accounts text[] default null,
  p_default_days integer default 7
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_available_from date;
  v_available_to date;
  v_from date;
  v_to date;
  v_dates jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  select min(rows.work_date), max(rows.work_date)
  into v_available_from, v_available_to
  from public.report_order_rows rows
  where (p_accounts is null or rows.account = any(p_accounts))
    and (
      rows.source_sheet = '工作表4'
      or rows.source_sheet like '填表/%'
    );

  if v_available_from is null or v_available_to is null then
    return pg_catalog.jsonb_build_object(
      'available_from', '',
      'available_to', '',
      'dates', '[]'::jsonb,
      'rows', '[]'::jsonb
    );
  end if;

  v_to := least(coalesce(p_date_to, v_available_to), v_available_to);
  v_from := greatest(
    coalesce(
      p_date_from,
      case
        when coalesce(p_default_days, 7) > 0
          then v_to - (greatest(p_default_days, 1) - 1)
        else v_available_from
      end
    ),
    v_available_from
  );

  if v_from <= v_to then
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.to_char(day, 'YYYY-MM-DD') order by day
      ),
      '[]'::jsonb
    )
    into v_dates
    from pg_catalog.generate_series(v_from, v_to, interval '1 day') day;

    with source_family_days as materialized (
      select
        rows.account,
        rows.work_date,
        case
          when rows.source_sheet = '工作表4' then 'finalized'
          else 'rolling'
        end source_family,
        sum(rows.processed)::bigint processed,
        sum(rows.rejected)::bigint rejected
      from public.report_order_rows rows
      where (p_accounts is null or rows.account = any(p_accounts))
        and rows.work_date between v_from and v_to
        and (
          rows.source_sheet = '工作表4'
          or rows.source_sheet like '填表/%'
        )
      group by
        rows.account,
        rows.work_date,
        case
          when rows.source_sheet = '工作表4' then 'finalized'
          else 'rolling'
        end
    ), canonical_days as materialized (
      select distinct on (family.account, family.work_date)
        family.account,
        family.work_date,
        family.processed,
        family.rejected
      from source_family_days family
      order by
        family.account,
        family.work_date,
        case when family.source_family = 'finalized' then 0 else 1 end
    ), account_days as (
      select
        canonical.account,
        pg_catalog.jsonb_object_agg(
          canonical.work_date::text,
          pg_catalog.jsonb_build_object(
            'success', canonical.processed,
            'reject', canonical.rejected
          )
          order by canonical.work_date
        ) daily
      from canonical_days canonical
      group by canonical.account
    )
    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'account', account_days.account,
          'daily', account_days.daily
        )
        order by account_days.account
      ),
      '[]'::jsonb
    )
    into v_rows
    from account_days;
  end if;

  return pg_catalog.jsonb_build_object(
    'available_from', v_available_from::text,
    'available_to', v_available_to::text,
    'from', v_from::text,
    'to', v_to::text,
    'dates', v_dates,
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.report_order_account_summary_v2(
  date,
  date,
  text[],
  integer
) from public, anon, authenticated;
grant execute on function public.report_order_account_summary_v2(
  date,
  date,
  text[],
  integer
) to service_role;

create or replace function public.refresh_dirty_report_order_account_cache(
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 250), 1), 500);
  v_accounts text[] := '{}'::text[];
  v_processed integer := 0;
  v_refreshed integer := 0;
  v_remaining integer := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-report-order-cache-sync', 0)
  ) then
    select count(*)::integer
    into v_remaining
    from attendance_private.report_order_cache_dirty_accounts;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'busy', true,
      'processed', 0,
      'refreshed', 0,
      'remaining', v_remaining
    );
  end if;

  select coalesce(
    array_agg(
      picked.account order by picked.first_marked_at, picked.account
    ),
    '{}'::text[]
  )
  into v_accounts
  from (
    select dirty.account, dirty.first_marked_at
    from attendance_private.report_order_cache_dirty_accounts dirty
    order by dirty.first_marked_at, dirty.account
    limit v_limit
    for update skip locked
  ) picked;

  if coalesce(pg_catalog.cardinality(v_accounts), 0) = 0 then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'busy', false,
      'processed', 0,
      'refreshed', 0,
      'remaining', 0
    );
  end if;

  delete from public.report_order_account_cache cache
  where cache.account = any(v_accounts);

  insert into public.report_order_account_cache (
    account,
    available_from,
    available_to,
    daily,
    refreshed_at
  )
  with source_family_days as materialized (
    select
      rows.account,
      rows.work_date,
      case
        when rows.source_sheet = '工作表4' then 'finalized'
        else 'rolling'
      end source_family,
      sum(rows.processed)::bigint processed,
      sum(rows.rejected)::bigint rejected
    from public.report_order_rows rows
    where rows.account = any(v_accounts)
      and (
        rows.source_sheet = '工作表4'
        or rows.source_sheet like '填表/%'
      )
    group by
      rows.account,
      rows.work_date,
      case
        when rows.source_sheet = '工作表4' then 'finalized'
        else 'rolling'
      end
  ), canonical_days as materialized (
    select distinct on (family.account, family.work_date)
      family.account,
      family.work_date,
      family.processed,
      family.rejected
    from source_family_days family
    order by
      family.account,
      family.work_date,
      case when family.source_family = 'finalized' then 0 else 1 end
  )
  select
    canonical.account,
    min(canonical.work_date),
    max(canonical.work_date),
    pg_catalog.jsonb_object_agg(
      canonical.work_date::text,
      pg_catalog.jsonb_build_object(
        'success', canonical.processed,
        'reject', canonical.rejected
      )
      order by canonical.work_date
    ),
    now()
  from canonical_days canonical
  group by canonical.account
  on conflict (account) do update
  set available_from = excluded.available_from,
      available_to = excluded.available_to,
      daily = excluded.daily,
      refreshed_at = excluded.refreshed_at;
  get diagnostics v_refreshed = row_count;

  delete from attendance_private.report_order_cache_dirty_accounts dirty
  where dirty.account = any(v_accounts);
  get diagnostics v_processed = row_count;

  select count(*)::integer
  into v_remaining
  from attendance_private.report_order_cache_dirty_accounts;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'busy', false,
    'processed', v_processed,
    'refreshed', v_refreshed,
    'remaining', v_remaining
  );
end;
$function$;

revoke all on function public.refresh_dirty_report_order_account_cache(integer)
  from public, anon, authenticated;
grant execute on function public.refresh_dirty_report_order_account_cache(integer)
  to service_role;
alter function public.refresh_dirty_report_order_account_cache(integer)
  set statement_timeout = '5s';
alter function public.refresh_dirty_report_order_account_cache(integer)
  set lock_timeout = '1s';

comment on table public.report_order_rows is
  'Server-only efficiency rows: finalized 工作表4 plus rolling 填表/YYYY-MM month partitions.';
comment on table attendance_private.report_order_legacy_fill_archive is
  'Owner-only recovery archive of legacy rolling Fill rows removed after finalized Work Sheet 4 coverage.';
comment on table attendance_private.report_order_rolling_month_markers is
  'Private hash/count markers for atomic rolling Fill month replacement.';
comment on function public.report_order_rolling_month_markers() is
  'Service-role-only bounded marker preflight for skipping unchanged rolling Fill months.';
comment on function public.sync_report_order_rolling_month(text, text, jsonb) is
  'Service-role-only atomic replacement for one 填表/YYYY-MM rolling month; finalized 工作表4 rows always win.';
comment on function public.report_order_account_summary_v2(
  date,
  date,
  text[],
  integer
) is
  'Returns canonical account/day order totals, preferring finalized 工作表4 over rolling 填表 month partitions.';
comment on function public.refresh_dirty_report_order_account_cache(integer) is
  'Refreshes queued canonical order totals in bounded batches, preferring finalized 工作表4 over rolling Fill rows.';

notify pgrst, 'reload schema';

commit;
