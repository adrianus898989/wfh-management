-- Normalize the Google report mirrors so report pages query indexed Postgres
-- rows instead of downloading and expanding large JSON snapshots per request.

create table if not exists public.report_employee_error_rows (
  source_row integer primary key,
  source_chunk_index integer not null,
  record_key text not null,
  employee_no text not null,
  member_order text,
  amount text,
  error_note text,
  correct_action text,
  error_type text,
  score text,
  qc_person text,
  qc_date date,
  leader_review text,
  qc_result text,
  review_date date,
  synced_at timestamptz not null default now()
);

alter table public.report_employee_error_rows enable row level security;
revoke all on table public.report_employee_error_rows from public, anon, authenticated;
grant select, insert, update, delete on table public.report_employee_error_rows to service_role;

create index if not exists report_employee_error_rows_qc_date_idx
  on public.report_employee_error_rows (qc_date desc, source_row desc);
create index if not exists report_employee_error_rows_review_date_idx
  on public.report_employee_error_rows (review_date desc, source_row desc);
create index if not exists report_employee_error_rows_employee_qc_idx
  on public.report_employee_error_rows (employee_no, qc_date desc, source_row desc);
create index if not exists report_employee_error_rows_type_idx
  on public.report_employee_error_rows (error_type) where error_type is not null;
create index if not exists report_employee_error_rows_qc_person_idx
  on public.report_employee_error_rows (qc_person) where qc_person is not null;
create index if not exists report_employee_error_rows_record_key_idx
  on public.report_employee_error_rows (record_key, synced_at desc, source_row desc);

create table if not exists public.report_error_sync_chunks (
  chunk_index integer primary key,
  chunk_size integer not null,
  content_hash text not null,
  row_count integer not null default 0,
  synced_at timestamptz not null default now()
);

alter table public.report_error_sync_chunks enable row level security;
revoke all on table public.report_error_sync_chunks from public, anon, authenticated;
grant select, insert, update, delete on table public.report_error_sync_chunks to service_role;

-- Backfill the normalized mirror from the already synchronized Google chunks.
insert into public.report_employee_error_rows (
  source_row, source_chunk_index, record_key, employee_no, member_order,
  amount, error_note, correct_action, error_type, score, qc_person,
  qc_date, leader_review, qc_result, review_date, synced_at
)
select distinct on (parsed.source_row)
  parsed.source_row,
  parsed.chunk_index,
  coalesce(
    nullif(parsed.item->>'record_key', ''),
    concat_ws('|', upper(btrim(parsed.item->>'employee_id')), parsed.item->>'qc_date', parsed.source_row::text)
  ),
  upper(btrim(parsed.item->>'employee_id')),
  nullif(btrim(parsed.item->>'member_order'), ''),
  nullif(btrim(parsed.item->>'amount'), ''),
  nullif(btrim(parsed.item->>'error_note'), ''),
  nullif(btrim(parsed.item->>'correct_action'), ''),
  nullif(btrim(parsed.item->>'error_type'), ''),
  nullif(btrim(parsed.item->>'score'), ''),
  nullif(btrim(parsed.item->>'qc_person'), ''),
  case when coalesce(parsed.item->>'qc_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    then (parsed.item->>'qc_date')::date end,
  nullif(btrim(parsed.item->>'leader_review'), ''),
  nullif(btrim(parsed.item->>'qc_result'), ''),
  case when coalesce(parsed.item->>'review_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    then (parsed.item->>'review_date')::date end,
  parsed.synced_at
from (
  select
    c.chunk_index,
    c.synced_at,
    item,
    case when coalesce(item->>'source_row', '') ~ '^\d+$'
      then (item->>'source_row')::integer end source_row
  from public.report_sheet_snapshot_chunks c
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(c.payload) = 'array' then c.payload else '[]'::jsonb end
  ) item
  where c.source = '效率表/员工错误'
) parsed
where parsed.source_row is not null
  and nullif(btrim(parsed.item->>'employee_id'), '') is not null
order by parsed.source_row, parsed.synced_at desc
on conflict (source_row) do update set
  source_chunk_index = excluded.source_chunk_index,
  record_key = excluded.record_key,
  employee_no = excluded.employee_no,
  member_order = excluded.member_order,
  amount = excluded.amount,
  error_note = excluded.error_note,
  correct_action = excluded.correct_action,
  error_type = excluded.error_type,
  score = excluded.score,
  qc_person = excluded.qc_person,
  qc_date = excluded.qc_date,
  leader_review = excluded.leader_review,
  qc_result = excluded.qc_result,
  review_date = excluded.review_date,
  synced_at = excluded.synced_at;

insert into public.report_error_sync_chunks (
  chunk_index, chunk_size, content_hash, row_count, synced_at
)
select chunk_index, 500, content_hash, row_count, synced_at
from public.report_sheet_snapshot_chunks
where source = '效率表/员工错误'
on conflict (chunk_index) do update set
  chunk_size = excluded.chunk_size,
  content_hash = excluded.content_hash,
  row_count = excluded.row_count,
  synced_at = excluded.synced_at;

create or replace function public.sync_report_employee_error_chunk(
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
begin
  if p_chunk_index < 0 or p_chunk_size < 1
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '错误统计同步分块参数无效';
  end if;

  delete from public.report_employee_error_rows
  where source_chunk_index = p_chunk_index
     or source_row between v_start and v_end;

  insert into public.report_employee_error_rows (
    source_row, source_chunk_index, record_key, employee_no, member_order,
    amount, error_note, correct_action, error_type, score, qc_person,
    qc_date, leader_review, qc_result, review_date, synced_at
  )
  select distinct on (source_row)
    source_row,
    p_chunk_index,
    coalesce(
      nullif(item->>'record_key', ''),
      concat_ws('|', upper(btrim(item->>'employee_id')), item->>'qc_date', source_row::text)
    ),
    upper(btrim(item->>'employee_id')),
    nullif(btrim(item->>'member_order'), ''),
    nullif(btrim(item->>'amount'), ''),
    nullif(btrim(item->>'error_note'), ''),
    nullif(btrim(item->>'correct_action'), ''),
    nullif(btrim(item->>'error_type'), ''),
    nullif(btrim(item->>'score'), ''),
    nullif(btrim(item->>'qc_person'), ''),
    case when coalesce(item->>'qc_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
      then (item->>'qc_date')::date end,
    nullif(btrim(item->>'leader_review'), ''),
    nullif(btrim(item->>'qc_result'), ''),
    case when coalesce(item->>'review_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
      then (item->>'review_date')::date end,
    now()
  from (
    select item,
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end source_row
    from jsonb_array_elements(p_rows) item
  ) parsed
  where source_row between v_start and v_end
    and nullif(btrim(item->>'employee_id'), '') is not null
  order by source_row;

  get diagnostics v_count = row_count;

  insert into public.report_error_sync_chunks (
    chunk_index, chunk_size, content_hash, row_count, synced_at
  ) values (
    p_chunk_index, p_chunk_size, p_content_hash, v_count, now()
  )
  on conflict (chunk_index) do update set
    chunk_size = excluded.chunk_size,
    content_hash = excluded.content_hash,
    row_count = excluded.row_count,
    synced_at = excluded.synced_at;

  return jsonb_build_object('chunk_index', p_chunk_index, 'rows', v_count);
end;
$$;

revoke all on function public.sync_report_employee_error_chunk(integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_error_chunk(integer, integer, text, jsonb)
  to service_role;

create or replace function public.finalize_report_employee_error_sync(p_chunk_count integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  if p_chunk_count < 0 then raise exception '错误统计分块数量无效'; end if;
  delete from public.report_employee_error_rows where source_chunk_index >= p_chunk_count;
  get diagnostics v_deleted = row_count;
  delete from public.report_error_sync_chunks where chunk_index >= p_chunk_count;
  return jsonb_build_object('deleted_rows', v_deleted, 'chunks', p_chunk_count);
end;
$$;

revoke all on function public.finalize_report_employee_error_sync(integer)
  from public, anon, authenticated;
grant execute on function public.finalize_report_employee_error_sync(integer)
  to service_role;

create table if not exists public.report_employee_directory_cache (
  employee_no text primary key,
  source_row integer,
  full_name text,
  team_name text,
  group_name text,
  position_name text,
  country_name text,
  shift_name text,
  platform_name text,
  responsible text,
  onsite_trainer text,
  online_leader text,
  online_trainer text,
  refreshed_at timestamptz not null default now()
);

alter table public.report_employee_directory_cache enable row level security;
revoke all on table public.report_employee_directory_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.report_employee_directory_cache to service_role;
create index if not exists report_employee_directory_cache_name_idx
  on public.report_employee_directory_cache (full_name);
create index if not exists report_employee_directory_cache_team_idx
  on public.report_employee_directory_cache (team_name);
create index if not exists report_employee_directory_cache_position_idx
  on public.report_employee_directory_cache (position_name);

create or replace function public.sync_report_employee_directory(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '员工目录同步参数无效';
  end if;

  delete from public.report_employee_directory_cache;
  insert into public.report_employee_directory_cache (
    employee_no, source_row, full_name, team_name, group_name, position_name,
    country_name, shift_name, platform_name, responsible, onsite_trainer,
    online_leader, online_trainer, refreshed_at
  )
  select distinct on (upper(btrim(item->>'employee_id')))
    upper(btrim(item->>'employee_id')),
    case when coalesce(item->>'source_row', '') ~ '^\d+$' then (item->>'source_row')::integer end,
    nullif(btrim(item->>'name'), ''),
    nullif(btrim(item->>'team'), ''),
    nullif(btrim(item->>'group'), ''),
    nullif(btrim(item->>'position'), ''),
    nullif(btrim(item->>'country'), ''),
    nullif(btrim(item->>'shift'), ''),
    nullif(btrim(item->>'platform'), ''),
    nullif(btrim(item->>'responsible'), ''),
    nullif(btrim(item->>'onsite_trainer'), ''),
    nullif(btrim(item->>'online_leader'), ''),
    nullif(btrim(item->>'online_trainer'), ''),
    now()
  from jsonb_array_elements(p_rows) item
  where nullif(btrim(item->>'employee_id'), '') is not null
  order by upper(btrim(item->>'employee_id')),
    case when coalesce(item->>'source_row', '') ~ '^\d+$' then (item->>'source_row')::integer end desc nulls last;
  get diagnostics v_count = row_count;
  return jsonb_build_object('rows', v_count);
end;
$$;

revoke all on function public.sync_report_employee_directory(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_directory(jsonb)
  to service_role;

select public.sync_report_employee_directory(
  coalesce((select payload from public.report_sheet_snapshots where source = '居家排班表/填表'), '[]'::jsonb)
);

create index if not exists employees_employee_no_normalized_idx
  on public.employees (upper(btrim(employee_no)));

create or replace view public.report_employee_errors_v
with (security_invoker = true)
as
select distinct on (e.record_key)
  e.record_key,
  e.source_row,
  e.employee_no,
  e.member_order,
  e.amount,
  e.error_note,
  e.correct_action,
  e.error_type,
  e.score,
  e.qc_person,
  e.qc_date,
  e.leader_review,
  e.qc_result,
  e.review_date,
  e.synced_at
from public.report_employee_error_rows e
where nullif(e.employee_no, '') is not null
order by e.record_key, e.synced_at desc, e.source_row desc;

revoke all on public.report_employee_errors_v from public, anon, authenticated;
grant select on public.report_employee_errors_v to service_role;

create or replace view public.report_employee_error_admin_v
with (security_invoker = true)
as
with latest_lifecycle as (
  select distinct on (upper(btrim(l.employee_no)))
    upper(btrim(l.employee_no)) employee_no,
    l.full_name,
    l.event_type,
    l.snapshot
  from public.employee_lifecycle_events l
  where nullif(btrim(l.employee_no), '') is not null
    and l.event_type in ('resign', 'reactivate', 'join')
  order by upper(btrim(l.employee_no)), l.effective_date desc nulls last, l.created_at desc
)
select
  e.source_row,
  e.record_key,
  e.employee_no employee_id,
  e.member_order,
  e.amount,
  e.error_note,
  e.correct_action,
  e.error_type,
  e.score,
  case when coalesce(e.score, '') ~ '-?\d+(\.\d+)?' then
    (regexp_match(e.score, '-?\d+(\.\d+)?'))[1]::numeric end score_value,
  e.qc_person,
  e.qc_date,
  e.leader_review,
  e.qc_result,
  e.review_date,
  coalesce(e.review_date, e.qc_date) review_basis_date,
  e.synced_at,
  coalesce(d.full_name, emp.full_name, life.full_name, '-') name,
  coalesce(d.team_name, team.name,
    nullif(life.snapshot->>'盘口国家', ''), nullif(life.snapshot->>'团队', ''),
    nullif(life.snapshot->>'團隊', ''), nullif(life.snapshot->>'team', ''), '-') team,
  coalesce(d.group_name, emp.group_name,
    nullif(life.snapshot->>'组别', ''), nullif(life.snapshot->>'組別', ''),
    nullif(life.snapshot->>'group', ''), '-') group_name,
  coalesce(d.position_name, position.name,
    nullif(life.snapshot->>'岗位', ''), nullif(life.snapshot->>'崗位', ''),
    nullif(life.snapshot->>'Position', ''), '-') position,
  coalesce(d.country_name, emp.country, emp.nationality,
    nullif(life.snapshot->>'国家 country', ''), nullif(life.snapshot->>'国家', ''),
    nullif(life.snapshot->>'國家', ''), nullif(life.snapshot->>'Country', ''), '-') country,
  coalesce(d.shift_name, emp.shift_name,
    nullif(life.snapshot->>'班次', ''), nullif(life.snapshot->>'Shift', ''), '-') shift,
  coalesce(d.platform_name, emp.platform_scope,
    nullif(life.snapshot->>'盘口岗位 Platform position', ''),
    nullif(life.snapshot->>'盘口', ''), nullif(life.snapshot->>'盤口', ''),
    nullif(life.snapshot->>'Platform', ''), '-') platform,
  concat_ws('|', d.responsible, d.onsite_trainer, d.online_leader, d.online_trainer,
    emp.person_in_charge, emp.on_site_trainer, emp.online_leader, emp.online_trainer,
    emp.leader_name, emp.trainer_name) manager_search,
  coalesce(summary.risk_level, 'excellent') risk_level,
  coalesce(summary.month_error_count, 0) month_error_count,
  coalesce(summary.total_error_count, 0) total_error_count,
  coalesce(emp.status, case when life.event_type = 'resign' then 'resigned' else life.event_type end, '') employee_status,
  d.employee_no is not null roster_match,
  emp.id is not null employee_match,
  life.employee_no is not null historical_match
from public.report_employee_error_rows e
left join public.report_employee_directory_cache d on d.employee_no = e.employee_no
left join public.employees emp on upper(btrim(emp.employee_no)) = e.employee_no
left join public.teams team on team.id = emp.team_id
left join public.positions position on position.id = emp.position_id
left join latest_lifecycle life on life.employee_no = e.employee_no
left join public.employee_error_summary summary on upper(btrim(summary.employee_no)) = e.employee_no;

revoke all on public.report_employee_error_admin_v from public, anon, authenticated;
grant select on public.report_employee_error_admin_v to service_role;

create or replace function public.report_error_query_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with params as (
  select
    nullif(btrim(p_filters->>'date_from'), '')::date date_from,
    nullif(btrim(p_filters->>'date_to'), '')::date date_to,
    case when p_filters->>'date_basis' = 'review' then 'review' else 'qc' end date_basis,
    nullif(upper(btrim(p_filters->>'employee_id')), '') employee_id,
    nullif(lower(btrim(p_filters->>'employee_name')), '') employee_name,
    nullif(btrim(p_filters->>'risk_level'), '') risk_level,
    nullif(btrim(p_filters->>'error_type'), '') error_type,
    nullif(btrim(p_filters->>'qc_person'), '') qc_person,
    nullif(btrim(p_filters->>'shift'), '') shift_name,
    nullif(btrim(p_filters->>'team'), '') team_name,
    nullif(btrim(p_filters->>'group'), '') group_name,
    nullif(btrim(p_filters->>'position'), '') position_name,
    nullif(btrim(p_filters->>'country'), '') country_name,
    nullif(lower(btrim(p_filters->>'manager')), '') manager_name,
    nullif(btrim(p_filters->>'platform'), '') platform_name
), filtered as materialized (
  select v.*
  from public.report_employee_error_admin_v v
  cross join params p
  where (p.date_from is null or (case when p.date_basis = 'review' then v.review_basis_date else v.qc_date end) >= p.date_from)
    and (p.date_to is null or (case when p.date_basis = 'review' then v.review_basis_date else v.qc_date end) <= p.date_to)
    and (p.employee_id is null or v.employee_id like '%' || p.employee_id || '%')
    and (p.employee_name is null or lower(v.name) like '%' || p.employee_name || '%')
    and (p.risk_level is null or v.risk_level = p.risk_level)
    and (p.error_type is null or v.error_type = p.error_type)
    and (p.qc_person is null or v.qc_person = p.qc_person)
    and (p.shift_name is null or v.shift = p.shift_name)
    and (p.team_name is null or v.team = p.team_name)
    and (p.group_name is null or v.group_name = p.group_name)
    and (p.position_name is null or v.position = p.position_name)
    and (p.country_name is null or v.country = p.country_name)
    and (p.manager_name is null or lower(v.manager_search) like '%' || p.manager_name || '%')
    and (p.platform_name is null or v.platform = p.platform_name)
), options as (
  select jsonb_build_object(
    'error_types', coalesce((select jsonb_agg(value order by value) from (select distinct error_type value from public.report_employee_error_rows where error_type is not null) x), '[]'::jsonb),
    'qc_people', coalesce((select jsonb_agg(value order by value) from (select distinct qc_person value from public.report_employee_error_rows where qc_person is not null) x), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(value order by value) from (select distinct shift value from public.report_employee_error_admin_v where shift <> '-') x), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(value order by value) from (select distinct team value from public.report_employee_error_admin_v where team <> '-') x), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(value order by value) from (select distinct group_name value from public.report_employee_error_admin_v where group_name <> '-') x), '[]'::jsonb),
    'positions', coalesce((select jsonb_agg(value order by value) from (select distinct position value from public.report_employee_error_admin_v where position <> '-') x), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(value order by value) from (select distinct country value from public.report_employee_error_admin_v where country <> '-') x), '[]'::jsonb),
    'managers', coalesce((select jsonb_agg(value order by value) from (
      select distinct unnest(array_remove(array[d.responsible,d.onsite_trainer,d.online_leader,d.online_trainer], null)) value
      from public.report_employee_directory_cache d
    ) x where nullif(btrim(value), '') is not null), '[]'::jsonb),
    'platforms', coalesce((select jsonb_agg(value order by value) from (select distinct platform value from public.report_employee_error_admin_v where platform <> '-') x), '[]'::jsonb)
  ) value
)
select jsonb_build_object(
  'total', count(*),
  'period_counts', jsonb_build_object(
    'month', count(*) filter (where qc_date >= date_trunc('month', current_date)::date and qc_date <= current_date),
    'last_3d', count(*) filter (where qc_date between current_date - 2 and current_date),
    'last_7d', count(*) filter (where qc_date between current_date - 6 and current_date),
    'last_30d', count(*) filter (where qc_date between current_date - 29 and current_date),
    'total', count(*),
    'as_of', current_date
  ),
  'source_raw_count', (select count(*) from public.report_employee_error_rows),
  'source_normalized_count', (select count(distinct record_key) from public.report_employee_error_rows),
  'source_synced_at', (select max(synced_at) from public.report_employee_error_rows),
  'available_from', (select min(qc_date) from public.report_employee_error_rows),
  'available_to', (select max(qc_date) from public.report_employee_error_rows),
  'options', (select value from options)
)
from filtered;
$$;

revoke all on function public.report_error_query_stats(jsonb) from public, anon, authenticated;
grant execute on function public.report_error_query_stats(jsonb) to service_role;

create or replace function public.report_error_counts_by_employee(
  p_date_from date default null,
  p_date_to date default null
)
returns table(employee_no text, error_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select e.employee_no, count(*) error_count
  from public.report_employee_error_rows e
  where e.review_date is not null
    and (p_date_from is null or e.review_date >= p_date_from)
    and (p_date_to is null or e.review_date <= p_date_to)
  group by e.employee_no;
$$;

revoke all on function public.report_error_counts_by_employee(date, date)
  from public, anon, authenticated;
grant execute on function public.report_error_counts_by_employee(date, date)
  to service_role;

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
as $$
declare
  v_available_from date;
  v_available_to date;
  v_from date;
  v_to date;
  v_dates jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  select min(r.work_date), max(r.work_date)
    into v_available_from, v_available_to
  from public.report_order_rows r
  where p_accounts is null or r.account = any(p_accounts);

  if v_available_from is null or v_available_to is null then
    return jsonb_build_object('available_from', '', 'available_to', '', 'dates', '[]'::jsonb, 'rows', '[]'::jsonb);
  end if;

  v_to := least(coalesce(p_date_to, v_available_to), v_available_to);
  v_from := greatest(
    coalesce(p_date_from,
      case when coalesce(p_default_days, 7) > 0
        then v_to - (greatest(p_default_days, 1) - 1)
        else v_available_from end),
    v_available_from
  );

  if v_from <= v_to then
    select coalesce(jsonb_agg(to_char(day, 'YYYY-MM-DD') order by day), '[]'::jsonb)
      into v_dates
    from generate_series(v_from, v_to, interval '1 day') day;

    select coalesce(jsonb_agg(
      jsonb_build_object('account', scoped.account, 'daily', scoped.daily)
      order by scoped.account
    ), '[]'::jsonb)
      into v_rows
    from (
      select
        daily.account,
        jsonb_object_agg(
          daily.work_date::text,
          jsonb_build_object('success', daily.processed, 'reject', daily.rejected)
          order by daily.work_date
        ) daily
      from (
        select r.account, r.work_date,
          sum(r.processed)::bigint processed,
          sum(r.rejected)::bigint rejected
        from public.report_order_rows r
        where (p_accounts is null or r.account = any(p_accounts))
          and r.work_date between v_from and v_to
        group by r.account, r.work_date
      ) daily
      group by daily.account
    ) scoped;
  end if;

  return jsonb_build_object(
    'available_from', v_available_from::text,
    'available_to', v_available_to::text,
    'from', v_from::text,
    'to', v_to::text,
    'dates', v_dates,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.report_order_account_summary_v2(date, date, text[], integer)
  from public, anon, authenticated;
grant execute on function public.report_order_account_summary_v2(date, date, text[], integer)
  to service_role;

-- External Google Sheets do not emit Supabase Realtime events. Poll every minute;
-- changed chunks only are written, so unchanged data does not rewrite the mirror.
do $$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'wfh-report-sheet-sync-every-minute' limit 1;
  if v_job_id is not null then
    perform cron.alter_job(v_job_id, schedule := '* * * * *');
  end if;
end;
$$;

comment on table public.report_employee_error_rows is
  'Indexed Supabase mirror of the Google 员工错误 sheet, updated by changed 500-row chunks.';
comment on function public.report_order_account_summary_v2(date, date, text[], integer) is
  'Returns scoped order totals from indexed Supabase rows; defaults to the latest seven days.';
