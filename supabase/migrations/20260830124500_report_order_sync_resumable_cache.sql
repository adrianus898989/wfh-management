begin;

-- Production safety: never sit behind a busy session while acquiring the
-- ACCESS EXCLUSIVE locks required by the lease constraint/table DDL.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- Report order imports used to rebuild the full history cache for every
-- changed 5,000-row sheet chunk. A chunk commonly touches 1,000-2,000
-- accounts, so that work exceeded the statement budget and overlapping cron
-- invocations queued behind the same advisory lock.
--
-- Keep the authoritative row/chunk write atomic, but defer cache maintenance
-- through a durable private queue. Each bounded cache batch removes its queue
-- rows in the same transaction as the cache update, so an Edge crash or SQL
-- timeout leaves the accounts queued for the next scheduled invocation.
create table if not exists attendance_private.report_order_cache_dirty_accounts (
  account text primary key,
  first_marked_at timestamptz not null default clock_timestamp(),
  last_marked_at timestamptz not null default clock_timestamp(),
  constraint report_order_cache_dirty_accounts_account_check check (
    account = lower(btrim(account)) and char_length(account) between 1 and 256
  )
);

create index if not exists report_order_cache_dirty_accounts_oldest_idx
  on attendance_private.report_order_cache_dirty_accounts (first_marked_at, account);

alter table attendance_private.report_order_cache_dirty_accounts enable row level security;
revoke all on table attendance_private.report_order_cache_dirty_accounts
  from public, anon, authenticated, service_role;

-- Admit report-sheet-sync to the existing cross-isolate TTL lease. The Edge
-- worker renews the same holder while processing; expiry remains the recovery
-- path if the worker is killed before its finally block can release the lease.
alter table attendance_private.sheet_sync_runtime_leases
  drop constraint if exists sheet_sync_runtime_leases_job_name_check;
alter table attendance_private.sheet_sync_runtime_leases
  add constraint sheet_sync_runtime_leases_job_name_check check (
    job_name in (
      'adjustment-sheet-sync',
      'employee-master-sync',
      'attendance-sheet-sync',
      'schedule-sheet-sync',
      'staff-sheet-sync',
      'report-sheet-sync'
    )
  );

create or replace function public.claim_sheet_sync_runtime_lease(
  p_job_name text,
  p_holder uuid,
  p_ttl_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job_name text := lower(btrim(coalesce(p_job_name, '')));
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 90), 10), 300);
  v_holder uuid;
  v_expires_at timestamptz;
  v_retry_after integer := 1;
begin
  if v_job_name not in (
    'adjustment-sheet-sync',
    'employee-master-sync',
    'attendance-sheet-sync',
    'schedule-sheet-sync',
    'staff-sheet-sync',
    'report-sheet-sync'
  ) or p_holder is null then
    raise exception using errcode = '22023', message = 'invalid_sheet_sync_lease';
  end if;

  insert into attendance_private.sheet_sync_runtime_leases as lease (
    job_name, holder, acquired_at, expires_at
  ) values (
    v_job_name, p_holder, clock_timestamp(),
    clock_timestamp() + make_interval(secs => v_ttl)
  )
  on conflict (job_name) do update
  set holder = excluded.holder,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
  where lease.expires_at <= clock_timestamp()
     or lease.holder = excluded.holder
  returning holder, expires_at into v_holder, v_expires_at;

  if found then
    return jsonb_build_object(
      'ok', true, 'acquired', true, 'job_name', v_job_name,
      'holder', v_holder, 'expires_at', v_expires_at
    );
  end if;

  select greatest(
           1,
           ceil(extract(epoch from (lease.expires_at - clock_timestamp())))::integer
         )
  into v_retry_after
  from attendance_private.sheet_sync_runtime_leases lease
  where lease.job_name = v_job_name;

  return jsonb_build_object(
    'ok', true, 'acquired', false, 'job_name', v_job_name,
    'retry_after_seconds', coalesce(v_retry_after, 1)
  );
end;
$function$;

alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set statement_timeout = '3s';
alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set lock_timeout = '1s';
revoke all on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  to service_role;

create or replace function public.sync_report_order_chunk(
  p_source_sheet text,
  p_chunk_index integer,
  p_chunk_size integer,
  p_content_hash text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_start integer := 2 + p_chunk_index * p_chunk_size;
  v_end integer := 1 + (p_chunk_index + 1) * p_chunk_size;
  v_count integer := 0;
  v_dirty integer := 0;
begin
  if p_source_sheet not in ('工作表4', '填表') then
    raise exception using errcode = '22023', message = 'unsupported_report_order_sheet';
  end if;
  if p_chunk_index < 0 or p_chunk_size < 1
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_report_order_chunk';
  end if;

  -- The Edge lease is the primary whole-run guard. This fail-fast per-chunk
  -- lock is a second line of defence for manual/direct service-role calls; it
  -- never waits behind an overlapping writer or amplifies database pressure.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'wfh-report-order-chunk:' || p_source_sheet || ':' || p_chunk_index::text,
      0
    )
  ) then
    raise exception using errcode = '55P03', message = 'report_order_chunk_busy';
  end if;

  insert into attendance_private.report_order_cache_dirty_accounts as dirty (
    account, first_marked_at, last_marked_at
  )
  select affected.account, clock_timestamp(), clock_timestamp()
  from (
    select lower(btrim(r.account)) as account
    from public.report_order_rows r
    where r.source_sheet = p_source_sheet
      and r.source_row between v_start and v_end
      and nullif(btrim(r.account), '') is not null
    union
    select lower(btrim(item->>'account'))
    from pg_catalog.jsonb_array_elements(p_rows) item
    where nullif(btrim(item->>'account'), '') is not null
  ) affected
  where nullif(affected.account, '') is not null
  on conflict (account) do update
  set last_marked_at = excluded.last_marked_at;
  get diagnostics v_dirty = row_count;

  delete from public.report_order_rows
  where source_sheet = p_source_sheet
    and source_row between v_start and v_end;

  insert into public.report_order_rows (
    source_sheet, source_row, work_date, account,
    processed, rejected, content_hash, synced_at
  )
  select
    p_source_sheet,
    (item->>'source_row')::integer,
    (item->>'work_date')::date,
    lower(btrim(item->>'account')),
    greatest(0, coalesce((item->>'processed')::integer, 0)),
    greatest(0, coalesce((item->>'rejected')::integer, 0)),
    coalesce(item->>'content_hash', ''),
    now()
  from pg_catalog.jsonb_array_elements(p_rows) item
  where nullif(item->>'work_date', '') is not null
    and nullif(btrim(item->>'account'), '') is not null
    and coalesce(item->>'source_row', '') ~ '^\d+$'
    and (item->>'source_row')::integer between v_start and v_end;

  get diagnostics v_count = row_count;

  insert into public.report_order_sync_chunks (
    source_sheet, chunk_index, chunk_size, content_hash, row_count, synced_at
  ) values (
    p_source_sheet, p_chunk_index, p_chunk_size,
    p_content_hash, v_count, now()
  )
  on conflict (source_sheet, chunk_index) do update set
    chunk_size = excluded.chunk_size,
    content_hash = excluded.content_hash,
    row_count = excluded.row_count,
    synced_at = excluded.synced_at;

  return jsonb_build_object(
    'source_sheet', p_source_sheet,
    'chunk_index', p_chunk_index,
    'rows', v_count,
    'cache_accounts_queued', v_dirty
  );
end;
$function$;

-- Rebuild a small, oldest-first set of dirty accounts. Cache replacement and
-- queue acknowledgement are one transaction: a crash or timeout rolls both
-- back, so the next invocation safely retries the same accounts.
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
    select count(*)::integer into v_remaining
    from attendance_private.report_order_cache_dirty_accounts;
    return jsonb_build_object(
      'ok', true,
      'busy', true,
      'processed', 0,
      'refreshed', 0,
      'remaining', v_remaining
    );
  end if;

  select coalesce(array_agg(picked.account order by picked.first_marked_at, picked.account), '{}'::text[])
    into v_accounts
  from (
    select dirty.account, dirty.first_marked_at
    from attendance_private.report_order_cache_dirty_accounts dirty
    order by dirty.first_marked_at, dirty.account
    limit v_limit
    for update skip locked
  ) picked;

  if coalesce(pg_catalog.cardinality(v_accounts), 0) = 0 then
    return jsonb_build_object(
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
    account, available_from, available_to, daily, refreshed_at
  )
  with account_days as (
    select
      rows.account,
      rows.work_date,
      sum(rows.processed)::bigint processed,
      sum(rows.rejected)::bigint rejected
    from public.report_order_rows rows
    where rows.account = any(v_accounts)
    group by rows.account, rows.work_date
  )
  select
    days.account,
    min(days.work_date),
    max(days.work_date),
    pg_catalog.jsonb_object_agg(
      days.work_date::text,
      pg_catalog.jsonb_build_object('success', days.processed, 'reject', days.rejected)
      order by days.work_date
    ),
    now()
  from account_days days
  group by days.account
  on conflict (account) do update set
    available_from = excluded.available_from,
    available_to = excluded.available_to,
    daily = excluded.daily,
    refreshed_at = excluded.refreshed_at;
  get diagnostics v_refreshed = row_count;

  delete from attendance_private.report_order_cache_dirty_accounts dirty
  where dirty.account = any(v_accounts);
  get diagnostics v_processed = row_count;

  select count(*)::integer into v_remaining
  from attendance_private.report_order_cache_dirty_accounts;

  return jsonb_build_object(
    'ok', true,
    'busy', false,
    'processed', v_processed,
    'refreshed', v_refreshed,
    'remaining', v_remaining
  );
end;
$function$;

revoke all on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  to service_role;

revoke all on function public.refresh_dirty_report_order_account_cache(integer)
  from public, anon, authenticated;
grant execute on function public.refresh_dirty_report_order_account_cache(integer)
  to service_role;

alter function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  set statement_timeout = '8s';
alter function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  set lock_timeout = '1s';
alter function public.refresh_dirty_report_order_account_cache(integer)
  set statement_timeout = '5s';
alter function public.refresh_dirty_report_order_account_cache(integer)
  set lock_timeout = '1s';

comment on table attendance_private.report_order_cache_dirty_accounts is
  'Durable retry queue for report order account-cache rows affected by chunk replacement.';
comment on function public.sync_report_order_chunk(text, integer, integer, text, jsonb) is
  'Atomically replaces one report order chunk and queues affected accounts for bounded cache refresh.';
comment on function public.refresh_dirty_report_order_account_cache(integer) is
  'Refreshes one bounded batch of queued report order cache accounts; queue acknowledgement is atomic.';

notify pgrst, 'reload schema';

commit;
