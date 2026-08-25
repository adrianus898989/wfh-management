-- Serialize efficiency/order cache maintenance. The same account can appear in
-- multiple sheet chunks, and concurrent delete+insert refreshes previously raced
-- on report_order_account_cache_pkey.

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
  v_accounts text[] := '{}'::text[];
begin
  if p_source_sheet not in ('工作表4', '填表') then
    raise exception '不支持的效率工作表';
  end if;
  if p_chunk_index < 0 or p_chunk_size < 1
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '同步分块参数无效';
  end if;

  -- Use one transaction-scoped key for both incremental and full refreshes.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-report-order-cache-sync', 0)
  );

  select coalesce(array_agg(distinct affected.account), '{}'::text[])
    into v_accounts
  from (
    select r.account
    from public.report_order_rows r
    where r.source_sheet = p_source_sheet
      and r.source_row between v_start and v_end
    union
    select lower(btrim(item->>'account'))
    from jsonb_array_elements(p_rows) item
    where nullif(btrim(item->>'account'), '') is not null
  ) affected;

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
  from jsonb_array_elements(p_rows) item
  where nullif(item->>'work_date', '') is not null
    and nullif(btrim(item->>'account'), '') is not null
    and (item->>'source_row')::integer between v_start and v_end;

  get diagnostics v_count = row_count;

  delete from public.report_order_account_cache c
  where c.account = any(v_accounts);

  insert into public.report_order_account_cache (
    account, available_from, available_to, daily, refreshed_at
  )
  with account_days as (
    select
      r.account,
      r.work_date,
      sum(r.processed)::bigint processed,
      sum(r.rejected)::bigint rejected
    from public.report_order_rows r
    where r.account = any(v_accounts)
    group by r.account, r.work_date
  )
  select
    d.account,
    min(d.work_date),
    max(d.work_date),
    jsonb_object_agg(
      d.work_date::text,
      jsonb_build_object('success', d.processed, 'reject', d.rejected)
      order by d.work_date
    ),
    now()
  from account_days d
  group by d.account
  on conflict (account) do update set
    available_from = excluded.available_from,
    available_to = excluded.available_to,
    daily = excluded.daily,
    refreshed_at = excluded.refreshed_at;

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
    'cache_accounts', coalesce(cardinality(v_accounts), 0)
  );
end;
$function$;

create or replace function public.refresh_report_order_account_cache()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wfh-report-order-cache-sync', 0)
  );

  delete from public.report_order_account_cache;

  insert into public.report_order_account_cache (
    account, available_from, available_to, daily, refreshed_at
  )
  with account_days as (
    select
      r.account,
      r.work_date,
      sum(r.processed)::bigint processed,
      sum(r.rejected)::bigint rejected
    from public.report_order_rows r
    group by r.account, r.work_date
  )
  select
    d.account,
    min(d.work_date),
    max(d.work_date),
    jsonb_object_agg(
      d.work_date::text,
      jsonb_build_object('success', d.processed, 'reject', d.rejected)
      order by d.work_date
    ),
    now()
  from account_days d
  group by d.account
  on conflict (account) do update set
    available_from = excluded.available_from,
    available_to = excluded.available_to,
    daily = excluded.daily,
    refreshed_at = excluded.refreshed_at;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'accounts', v_count);
end;
$function$;

revoke all on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  to service_role;

revoke all on function public.refresh_report_order_account_cache()
  from public, anon, authenticated;
grant execute on function public.refresh_report_order_account_cache()
  to service_role;

comment on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  is 'Synchronizes one efficiency sheet chunk while serializing shared account-cache maintenance.';
