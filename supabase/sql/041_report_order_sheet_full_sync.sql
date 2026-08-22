-- Persist both efficiency workbook order tabs in Supabase.
-- The browser never receives direct access to these tables; only service-role
-- Edge Functions can synchronize and aggregate the data.

create table if not exists public.report_order_rows (
  source_sheet text not null,
  source_row integer not null check (source_row >= 2),
  work_date date not null,
  account text not null,
  processed integer not null default 0,
  rejected integer not null default 0,
  content_hash text not null default '',
  synced_at timestamptz not null default now(),
  primary key (source_sheet, source_row)
);

create index if not exists report_order_rows_date_account_idx
  on public.report_order_rows (work_date, account);
create index if not exists report_order_rows_account_date_idx
  on public.report_order_rows (account, work_date);

alter table public.report_order_rows enable row level security;
revoke all on table public.report_order_rows from public, anon, authenticated;
grant select, insert, update, delete on table public.report_order_rows to service_role;

create table if not exists public.report_order_sync_chunks (
  source_sheet text not null,
  chunk_index integer not null check (chunk_index >= 0),
  chunk_size integer not null check (chunk_size > 0),
  content_hash text not null,
  row_count integer not null default 0,
  synced_at timestamptz not null default now(),
  primary key (source_sheet, chunk_index)
);

alter table public.report_order_sync_chunks enable row level security;
revoke all on table public.report_order_sync_chunks from public, anon, authenticated;
grant select, insert, update, delete on table public.report_order_sync_chunks to service_role;

create or replace function public.sync_report_order_chunk(
  p_source_sheet text,
  p_chunk_index integer,
  p_chunk_size integer,
  p_content_hash text,
  p_rows jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_start integer := 2 + p_chunk_index * p_chunk_size;
  v_end integer := 1 + (p_chunk_index + 1) * p_chunk_size;
  v_count integer := 0;
begin
  if p_source_sheet not in ('工作表4', '填表') then
    raise exception '不支持的效率工作表';
  end if;
  if p_chunk_index < 0 or p_chunk_size < 1 or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '同步分块参数无效';
  end if;

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
    'rows', v_count
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
language sql
stable
set search_path = ''
as $$
  with selected as (
    select
      r.work_date,
      r.account,
      sum(r.processed)::bigint processed,
      sum(r.rejected)::bigint rejected
    from public.report_order_rows r
    where (p_date_from is null or r.work_date >= p_date_from)
      and (p_date_to is null or r.work_date <= p_date_to)
      and (p_accounts is null or r.account = any(p_accounts))
    group by r.work_date, r.account
  ), account_rows as (
    select
      s.account,
      jsonb_object_agg(
        s.work_date::text,
        jsonb_build_object('success', s.processed, 'reject', s.rejected)
        order by s.work_date
      ) daily
    from selected s
    group by s.account
  ), available as (
    select min(r.work_date) available_from, max(r.work_date) available_to
    from public.report_order_rows r
    where (p_accounts is null or r.account = any(p_accounts))
  )
  select jsonb_build_object(
    'available_from', coalesce((select available_from::text from available), ''),
    'available_to', coalesce((select available_to::text from available), ''),
    'dates', coalesce((select jsonb_agg(d.work_date order by d.work_date)
      from (select distinct work_date::text work_date from selected) d), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(
      jsonb_build_object('account', a.account, 'daily', a.daily)
      order by a.account
    ) from account_rows a), '[]'::jsonb)
  );
$$;

revoke all on function public.report_order_account_summary(date, date, text[])
  from public, anon, authenticated;
grant execute on function public.report_order_account_summary(date, date, text[])
  to service_role;

comment on table public.report_order_rows is
  'Server-only synchronized rows from efficiency workbook tabs 工作表4 and 填表.';
comment on function public.report_order_account_summary(date, date, text[]) is
  'Server-only compact account/day aggregation for the reports Edge Function.';

-- The reports UI refreshes every five minutes. Keep the server-side workbook
-- synchronization on the same cadence when the existing cron job is present.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'wfh-report-sheet-sync-every-minute'
  limit 1;

  if v_job_id is not null then
    perform cron.alter_job(job_id := v_job_id, schedule := '*/5 * * * *');
  end if;
end;
$$;
