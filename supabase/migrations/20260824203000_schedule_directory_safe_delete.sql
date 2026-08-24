-- pg-safeupdate rejects unqualified DELETE statements, including inside a
-- SECURITY DEFINER function. Keep the cache rebuild atomic while making the
-- full-row target explicit through its NOT NULL primary key column.

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

  delete from public.report_employee_directory_cache
  where employee_no is not null;

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

comment on function public.sync_report_employee_directory(jsonb) is
  'Atomically rebuilds the roster/employee/lifecycle directory cache with an explicit safe-delete predicate.';

notify pgrst, 'reload schema';
