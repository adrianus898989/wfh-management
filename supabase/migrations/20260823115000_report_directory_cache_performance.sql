-- Keep the report error view cheap: resolve roster/current/historical employee
-- metadata once when the roster changes, not once per result row and per filter.

alter table public.report_employee_directory_cache
  add column if not exists source_kind text not null default 'roster',
  add column if not exists employee_status text;

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
    online_leader, online_trainer, refreshed_at, source_kind, employee_status
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
    now(), 'roster', 'active'
  from jsonb_array_elements(p_rows) item
  where nullif(btrim(item->>'employee_id'), '') is not null
  order by upper(btrim(item->>'employee_id')),
    case when coalesce(item->>'source_row', '') ~ '^\d+$' then (item->>'source_row')::integer end desc nulls last;

  -- Current employee records fill IDs that are absent from the current roster.
  insert into public.report_employee_directory_cache (
    employee_no, source_row, full_name, team_name, group_name, position_name,
    country_name, shift_name, platform_name, responsible, onsite_trainer,
    online_leader, online_trainer, refreshed_at, source_kind, employee_status
  )
  select
    upper(btrim(e.employee_no)), e.source_row, nullif(btrim(e.full_name), ''),
    nullif(btrim(t.name), ''), nullif(btrim(e.group_name), ''), nullif(btrim(p.name), ''),
    coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), '')),
    nullif(btrim(e.shift_name), ''), nullif(btrim(e.platform_scope), ''),
    nullif(btrim(e.person_in_charge), ''), nullif(btrim(e.on_site_trainer), ''),
    nullif(btrim(e.online_leader), ''), nullif(btrim(e.online_trainer), ''),
    now(), 'employee', e.status
  from public.employees e
  left join public.teams t on t.id = e.team_id
  left join public.positions p on p.id = e.position_id
  where nullif(btrim(e.employee_no), '') is not null
  on conflict (employee_no) do nothing;

  -- Historical lifecycle snapshots fill former employees not present above.
  insert into public.report_employee_directory_cache (
    employee_no, full_name, team_name, group_name, position_name, country_name,
    shift_name, platform_name, refreshed_at, source_kind, employee_status
  )
  select
    h.employee_no,
    coalesce(nullif(btrim(h.full_name), ''), nullif(btrim(h.snapshot->>'名字 Name'), ''),
      nullif(btrim(h.snapshot->>'姓名'), ''), nullif(btrim(h.snapshot->>'Name'), '')),
    coalesce(nullif(btrim(h.snapshot->>'盘口国家'), ''), nullif(btrim(h.snapshot->>'团队'), ''),
      nullif(btrim(h.snapshot->>'團隊'), ''), nullif(btrim(h.snapshot->>'team'), '')),
    coalesce(nullif(btrim(h.snapshot->>'组别'), ''), nullif(btrim(h.snapshot->>'組別'), ''),
      nullif(btrim(h.snapshot->>'group'), '')),
    coalesce(nullif(btrim(h.snapshot->>'岗位'), ''), nullif(btrim(h.snapshot->>'崗位'), ''),
      nullif(btrim(h.snapshot->>'Position'), '')),
    coalesce(nullif(btrim(h.snapshot->>'国家 country'), ''), nullif(btrim(h.snapshot->>'国家'), ''),
      nullif(btrim(h.snapshot->>'國家'), ''), nullif(btrim(h.snapshot->>'Country'), '')),
    coalesce(nullif(btrim(h.snapshot->>'班次'), ''), nullif(btrim(h.snapshot->>'Shift'), '')),
    coalesce(nullif(btrim(h.snapshot->>'盘口岗位 Platform position'), ''),
      nullif(btrim(h.snapshot->>'盘口'), ''), nullif(btrim(h.snapshot->>'盤口'), ''),
      nullif(btrim(h.snapshot->>'Platform'), '')),
    now(), 'lifecycle', case when h.event_type = 'resign' then 'resigned' else h.event_type end
  from (
    select distinct on (upper(btrim(l.employee_no)))
      upper(btrim(l.employee_no)) employee_no,
      l.full_name, l.event_type, l.snapshot
    from public.employee_lifecycle_events l
    where nullif(btrim(l.employee_no), '') is not null
      and l.event_type in ('resign', 'reactivate', 'join')
    order by upper(btrim(l.employee_no)), l.effective_date desc nulls last, l.created_at desc
  ) h
  on conflict (employee_no) do nothing;

  select count(*) into v_count from public.report_employee_directory_cache;
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
from public.report_employee_error_rows e
left join public.report_employee_directory_cache d on d.employee_no = e.employee_no
left join public.employee_error_summary summary on upper(btrim(summary.employee_no)) = e.employee_no;

revoke all on public.report_employee_error_admin_v from public, anon, authenticated;
grant select on public.report_employee_error_admin_v to service_role;

comment on table public.report_employee_directory_cache is
  'Pre-resolved roster, current employee and lifecycle metadata used by indexed report queries.';
