-- Keep the reports page fast by pre-aggregating each backend account once when
-- a synchronized sheet chunk changes. Browser requests then read a few thousand
-- compact cache rows instead of grouping ~243k raw rows on every page load.

create table if not exists public.report_order_account_cache (
  account text primary key,
  available_from date not null,
  available_to date not null,
  daily jsonb not null default '{}'::jsonb,
  refreshed_at timestamptz not null default now()
);

alter table public.report_order_account_cache enable row level security;
revoke all on table public.report_order_account_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.report_order_account_cache to service_role;

create or replace function public.refresh_report_order_account_cache()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
begin
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
  group by d.account;

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'accounts', v_count);
end;
$$;

revoke all on function public.refresh_report_order_account_cache()
  from public, anon, authenticated;
grant execute on function public.refresh_report_order_account_cache()
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
as $$
declare
  v_start integer := 2 + p_chunk_index * p_chunk_size;
  v_end integer := 1 + (p_chunk_index + 1) * p_chunk_size;
  v_count integer := 0;
  v_accounts text[] := '{}'::text[];
begin
  if p_source_sheet not in ('工作表4', '填表') then
    raise exception '不支持的效率工作表';
  end if;
  if p_chunk_index < 0 or p_chunk_size < 1 or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '同步分块参数无效';
  end if;

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
  group by d.account;

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
$$;

revoke all on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_order_chunk(text, integer, integer, text, jsonb)
  to service_role;

create or replace function public.report_order_account_summary(
  p_date_from date default null,
  p_date_to date default null,
  p_accounts text[] default null
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_available_from date;
  v_available_to date;
  v_from date;
  v_to date;
  v_dates jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  select min(c.available_from), max(c.available_to)
    into v_available_from, v_available_to
  from public.report_order_account_cache c
  where p_accounts is null or c.account = any(p_accounts);

  if v_available_from is null or v_available_to is null then
    return jsonb_build_object(
      'available_from', '', 'available_to', '',
      'dates', '[]'::jsonb, 'rows', '[]'::jsonb
    );
  end if;

  v_from := greatest(coalesce(p_date_from, v_available_from), v_available_from);
  v_to := least(coalesce(p_date_to, v_available_to), v_available_to);

  if v_from <= v_to then
    select coalesce(jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day), '[]'::jsonb)
      into v_dates
    from generate_series(v_from, v_to, interval '1 day') day;

    if p_date_from is null and p_date_to is null then
      select coalesce(jsonb_agg(
        jsonb_build_object('account', c.account, 'daily', c.daily)
        order by c.account
      ), '[]'::jsonb)
        into v_rows
      from public.report_order_account_cache c
      where p_accounts is null or c.account = any(p_accounts);
    else
      select coalesce(jsonb_agg(
        jsonb_build_object('account', scoped.account, 'daily', scoped.daily)
        order by scoped.account
      ), '[]'::jsonb)
        into v_rows
      from (
        select
          c.account,
          jsonb_object_agg(entry.key, entry.value order by entry.key) daily
        from public.report_order_account_cache c
        cross join lateral jsonb_each(c.daily) entry
        where (p_accounts is null or c.account = any(p_accounts))
          and entry.key::date between v_from and v_to
        group by c.account
      ) scoped;
    end if;
  end if;

  return jsonb_build_object(
    'available_from', v_available_from::text,
    'available_to', v_available_to::text,
    'dates', v_dates,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.report_order_account_summary(date, date, text[])
  from public, anon, authenticated;
grant execute on function public.report_order_account_summary(date, date, text[])
  to service_role;

select public.refresh_report_order_account_cache();

comment on table public.report_order_account_cache is
  'Service-role-only pre-aggregated account/day order totals for fast reports queries.';
comment on function public.report_order_account_summary(date, date, text[]) is
  'Reads the synchronized order account cache without re-aggregating raw sheet rows.';
