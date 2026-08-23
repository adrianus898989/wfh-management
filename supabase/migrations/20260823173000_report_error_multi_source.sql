-- Persist every Google error source independently, while exposing one
-- fingerprint-deduplicated result set to the report and employee profiles.

alter table public.report_employee_error_rows
  add column if not exists source_name text;

update public.report_employee_error_rows
set source_name = '效率表/员工错误'
where source_name is null or btrim(source_name) = '';

alter table public.report_employee_error_rows
  alter column source_name set default '效率表/员工错误',
  alter column source_name set not null;

alter table public.report_employee_error_rows
  drop constraint if exists report_employee_error_rows_pkey;

alter table public.report_employee_error_rows
  add constraint report_employee_error_rows_pkey primary key (source_name, source_row);

create index if not exists report_employee_error_rows_source_chunk_idx
  on public.report_employee_error_rows (source_name, source_chunk_index);

alter table public.report_error_sync_chunks
  add column if not exists source_name text;

update public.report_error_sync_chunks
set source_name = '效率表/员工错误'
where source_name is null or btrim(source_name) = '';

alter table public.report_error_sync_chunks
  alter column source_name set default '效率表/员工错误',
  alter column source_name set not null;

alter table public.report_error_sync_chunks
  drop constraint if exists report_error_sync_chunks_pkey;

alter table public.report_error_sync_chunks
  add constraint report_error_sync_chunks_pkey primary key (source_name, chunk_index);

create or replace function public.sync_report_employee_error_chunk(
  p_source_name text,
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
  v_source_name text := nullif(btrim(p_source_name), '');
  v_count integer := 0;
begin
  if v_source_name is null or p_chunk_index < 0 or p_chunk_size < 1
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception '错误统计多来源同步分块参数无效';
  end if;

  delete from public.report_employee_error_rows
  where source_name = v_source_name
    and source_chunk_index = p_chunk_index;

  insert into public.report_employee_error_rows (
    source_name, source_row, source_chunk_index, record_key, employee_no,
    member_order, amount, error_note, correct_action, error_type, score,
    qc_person, qc_date, leader_review, qc_result, review_date, synced_at
  )
  select distinct on (source_row)
    v_source_name,
    source_row,
    p_chunk_index,
    coalesce(
      nullif(item->>'record_key', ''),
      concat_ws('|', upper(btrim(item->>'employee_id')), item->>'qc_date', source_row::text)
    ),
    regexp_replace(upper(btrim(item->>'employee_id')), '[-–—]+$', ''),
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
  where source_row is not null
    and nullif(regexp_replace(upper(btrim(item->>'employee_id')), '[-–—]+$', ''), '') is not null
  order by source_row;

  get diagnostics v_count = row_count;

  insert into public.report_error_sync_chunks (
    source_name, chunk_index, chunk_size, content_hash, row_count, synced_at
  ) values (
    v_source_name, p_chunk_index, p_chunk_size, p_content_hash, v_count, now()
  )
  on conflict (source_name, chunk_index) do update set
    chunk_size = excluded.chunk_size,
    content_hash = excluded.content_hash,
    row_count = excluded.row_count,
    synced_at = excluded.synced_at;

  return jsonb_build_object(
    'source_name', v_source_name,
    'chunk_index', p_chunk_index,
    'rows', v_count
  );
end;
$$;

revoke all on function public.sync_report_employee_error_chunk(text, integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_error_chunk(text, integer, integer, text, jsonb)
  to service_role;

-- Keep the previous RPC signature safe during a rolling Edge Function deploy.
create or replace function public.sync_report_employee_error_chunk(
  p_chunk_index integer,
  p_chunk_size integer,
  p_content_hash text,
  p_rows jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.sync_report_employee_error_chunk(
    '效率表/员工错误', p_chunk_index, p_chunk_size, p_content_hash, p_rows
  );
$$;

revoke all on function public.sync_report_employee_error_chunk(integer, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_error_chunk(integer, integer, text, jsonb)
  to service_role;

create or replace function public.finalize_report_employee_error_sync(
  p_source_name text,
  p_chunk_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_name text := nullif(btrim(p_source_name), '');
  v_deleted integer := 0;
begin
  if v_source_name is null or p_chunk_count < 0 then
    raise exception '错误统计多来源分块数量无效';
  end if;

  delete from public.report_employee_error_rows
  where source_name = v_source_name
    and source_chunk_index >= p_chunk_count;
  get diagnostics v_deleted = row_count;

  delete from public.report_error_sync_chunks
  where source_name = v_source_name
    and chunk_index >= p_chunk_count;

  return jsonb_build_object(
    'source_name', v_source_name,
    'deleted_rows', v_deleted,
    'chunks', p_chunk_count
  );
end;
$$;

revoke all on function public.finalize_report_employee_error_sync(text, integer)
  from public, anon, authenticated;
grant execute on function public.finalize_report_employee_error_sync(text, integer)
  to service_role;

create or replace function public.finalize_report_employee_error_sync(p_chunk_count integer)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.finalize_report_employee_error_sync('效率表/员工错误', p_chunk_count);
$$;

revoke all on function public.finalize_report_employee_error_sync(integer)
  from public, anon, authenticated;
grant execute on function public.finalize_report_employee_error_sync(integer)
  to service_role;

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
  coalesce(d.full_name, '-') name,
  coalesce(d.team_name, '-') team,
  coalesce(d.group_name, '-') group_name,
  coalesce(d.position_name, '-') position,
  coalesce(d.country_name, '-') country,
  coalesce(d.shift_name, '-') shift,
  coalesce(d.platform_name, '-') platform,
  concat_ws('|', d.responsible, d.onsite_trainer, d.online_leader, d.online_trainer) manager_search,
  coalesce(summary.risk_level, 'excellent') risk_level,
  coalesce(summary.month_error_count, 0) month_error_count,
  coalesce(summary.total_error_count, 0) total_error_count,
  coalesce(d.employee_status, '') employee_status,
  d.source_kind = 'roster' roster_match,
  d.source_kind = 'employee' employee_match,
  d.source_kind = 'lifecycle' historical_match
from public.report_employee_errors_v e
left join public.report_employee_directory_cache d on d.employee_no = e.employee_no
left join public.employee_error_summary summary on upper(btrim(summary.employee_no)) = e.employee_no;

revoke all on public.report_employee_error_admin_v from public, anon, authenticated;
grant select on public.report_employee_error_admin_v to service_role;

comment on column public.report_employee_error_rows.source_name is
  'Stable Google source identifier; source rows are unique only inside one sheet.';
comment on table public.report_error_sync_chunks is
  'Per-Google-source incremental synchronization state for normalized error rows.';
comment on view public.report_employee_errors_v is
  'Supabase-first combined error mirror, deduplicated across Google sources by record fingerprint.';
