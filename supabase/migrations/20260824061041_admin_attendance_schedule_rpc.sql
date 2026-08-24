-- Complete current schedule directory for the attendance workspace.
--
-- The roster cache is the display authority. The employee table contributes
-- only canonical identity/lifecycle fields (UUID, hire date, status and type).
-- The privileged implementation remains in the non-exposed private schema;
-- the public function is a permission-checked RPC wrapper.

create schema if not exists attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;

create index if not exists report_employee_directory_cache_roster_source_row_idx
  on public.report_employee_directory_cache (source_row, employee_no)
  where source_kind = 'roster';

create or replace function public.report_employee_directory_cache_matches(
  p_rows jsonb
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with expected as materialized (
    select distinct on (upper(btrim(item->>'employee_id')))
      upper(btrim(item->>'employee_id')) employee_no,
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end source_row,
      nullif(btrim(item->>'name'), '') full_name,
      nullif(btrim(item->>'team'), '') team_name,
      nullif(btrim(item->>'group'), '') group_name,
      nullif(btrim(item->>'position'), '') position_name,
      nullif(btrim(item->>'country'), '') country_name,
      nullif(btrim(item->>'shift'), '') shift_name,
      nullif(btrim(item->>'platform'), '') platform_name,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer
    from jsonb_array_elements(
      case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end
    ) item
    where nullif(btrim(item->>'employee_id'), '') is not null
    order by upper(btrim(item->>'employee_id')),
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end desc nulls last
  ), cached as materialized (
    select
      upper(btrim(d.employee_no)) employee_no,
      d.source_row,
      d.full_name,
      d.team_name,
      d.group_name,
      d.position_name,
      d.country_name,
      d.shift_name,
      d.platform_name,
      d.responsible,
      d.onsite_trainer,
      d.online_leader,
      d.online_trainer
    from public.report_employee_directory_cache d
    where d.source_kind = 'roster'
  )
  select
    (select count(*) from expected) > 0
    and not exists (
      select 1
      from expected e
      left join cached c on c.employee_no = e.employee_no
      where c.employee_no is null
        or row(
          e.source_row, e.full_name, e.team_name, e.group_name,
          e.position_name, e.country_name, e.shift_name, e.platform_name,
          e.responsible, e.onsite_trainer, e.online_leader, e.online_trainer
        ) is distinct from row(
          c.source_row, c.full_name, c.team_name, c.group_name,
          c.position_name, c.country_name, c.shift_name, c.platform_name,
          c.responsible, c.onsite_trainer, c.online_leader, c.online_trainer
        )
    )
    and not exists (
      select 1
      from cached c
      left join expected e on e.employee_no = c.employee_no
      where e.employee_no is null
    );
$$;

revoke all on function public.report_employee_directory_cache_matches(jsonb)
  from public, anon, authenticated;
grant execute on function public.report_employee_directory_cache_matches(jsonb)
  to service_role;

-- Repair the derived directory from the latest durable snapshot during
-- deployment. Fail closed: a missing or empty snapshot must never wipe the
-- last known-good directory.
do $$
declare
  v_roster jsonb;
begin
  select s.payload
  into v_roster
  from public.report_sheet_snapshots s
  where s.source = '居家排班表/填表'
  limit 1;

  if v_roster is null
    or jsonb_typeof(v_roster) <> 'array'
    or jsonb_array_length(v_roster) = 0 then
    raise exception 'schedule_roster_snapshot_missing_or_empty';
  end if;

  perform public.sync_report_employee_directory(v_roster);
end;
$$;

create or replace function attendance_private.admin_attendance_schedule(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_group text := btrim(coalesce(
    p_filters->>'group',
    p_filters->>'group_name',
    ''
  ));
  v_shift_bucket text := lower(btrim(coalesce(
    p_filters->>'shift_bucket',
    p_filters->>'shift_group',
    ''
  )));
  v_shift_raw text := btrim(coalesce(
    p_filters->>'shift',
    p_filters->>'shift_raw',
    ''
  ));
  v_position text := btrim(coalesce(p_filters->>'position', ''));
  v_country text := btrim(coalesce(p_filters->>'country', ''));
  v_employee_status text := lower(btrim(coalesce(
    p_filters->>'employee_status',
    ''
  )));
  v_employment_type text := lower(btrim(coalesce(
    p_filters->>'employment_type',
    ''
  )));
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;

  -- public.has_permission() grants every permission to the founder and applies
  -- the normal role/individual permission overrides for other admin accounts.
  if not public.has_permission('schedule.view') then
    raise exception 'permission_denied';
  end if;

  if v_shift_bucket <> ''
    and v_shift_bucket not in ('day', 'mid', 'night', 'other') then
    raise exception 'invalid_shift_bucket';
  end if;

  with roster as materialized (
    select
      d.source_row,
      d.employee_no,
      d.full_name,
      d.team_name,
      d.group_name,
      d.position_name,
      d.country_name,
      nullif(btrim(d.shift_name), '') shift_raw,
      d.platform_name,
      d.responsible,
      d.onsite_trainer,
      d.online_leader,
      d.online_trainer,
      d.refreshed_at,
      e.id employee_id,
      e.hire_date,
      nullif(btrim(e.status), '') employee_status,
      nullif(btrim(e.employment_type), '') employment_type
    from public.report_employee_directory_cache d
    left join public.employees e
      on upper(btrim(e.employee_no)) = upper(btrim(d.employee_no))
    where d.source_kind = 'roster'
  ),
  classified as materialized (
    select
      r.*,
      case
        when lower(coalesce(r.shift_raw, '')) like '%白班%'
          or lower(coalesce(r.shift_raw, '')) like '%day%' then 'day'
        when lower(coalesce(r.shift_raw, '')) like '%中班%'
          or lower(coalesce(r.shift_raw, '')) like '%mid%' then 'mid'
        when lower(coalesce(r.shift_raw, '')) like '%夜班%'
          or lower(coalesce(r.shift_raw, '')) like '%night%' then 'night'
        else 'other'
      end shift_bucket,
      regexp_match(
        coalesce(r.shift_raw, ''),
        '([0-9]{1,2})[[:space:]]*[:：][[:space:]]*([0-5][0-9])'
      ) colon_time_parts,
      regexp_match(
        coalesce(r.shift_raw, ''),
        '([0-9]{1,2})[[:space:]]*[点時时]'
      ) hour_time_parts
    from roster r
  ),
  normalized as materialized (
    select
      c.source_row,
      c.employee_no,
      c.full_name,
      c.team_name,
      c.group_name,
      c.position_name,
      c.country_name,
      c.shift_raw,
      c.shift_bucket,
      case c.shift_bucket
        when 'day' then '白班'
        when 'mid' then '中班'
        when 'night' then '夜班'
        else '其他'
      end shift_bucket_label,
      case
        when c.shift_bucket <> 'mid' then null
        when c.colon_time_parts is not null
          and (c.colon_time_parts)[1]::integer between 0 and 23
          then lpad((c.colon_time_parts)[1], 2, '0')
            || ':' || (c.colon_time_parts)[2]
        when c.hour_time_parts is not null
          and (c.hour_time_parts)[1]::integer between 0 and 23
          then lpad((c.hour_time_parts)[1], 2, '0') || ':00'
        else null
      end shift_time,
      c.platform_name,
      c.responsible,
      c.onsite_trainer,
      c.online_leader,
      c.online_trainer,
      c.refreshed_at,
      c.employee_id,
      c.hire_date,
      coalesce(c.employee_status, 'unmatched') employee_status,
      c.employment_type,
      c.employee_id is not null employee_matched
    from classified c
  ),
  display_rows as materialized (
    select
      n.*,
      case
        when n.shift_bucket = 'mid' and n.shift_time is not null
          then '中班 · ' || n.shift_time
        when n.shift_bucket = 'mid' then '中班'
        when n.shift_bucket = 'day' then '白班'
        when n.shift_bucket = 'night' then '夜班'
        else coalesce(n.shift_raw, '未填写班次')
      end shift_display,
      case n.shift_bucket
        when 'day' then 1
        when 'mid' then 2
        when 'night' then 3
        else 4
      end shift_sort
    from normalized n
  ),
  filtered as materialized (
    select d.*
    from display_rows d
    where (
      v_search = ''
      or position(v_search in lower(concat_ws(
        ' ',
        d.employee_no,
        d.full_name,
        d.team_name,
        d.group_name,
        d.position_name,
        d.country_name,
        d.shift_raw,
        d.shift_display,
        d.platform_name,
        d.responsible,
        d.onsite_trainer,
        d.online_leader,
        d.online_trainer,
        d.hire_date,
        d.employee_status,
        d.employment_type
      ))) > 0
    )
      and (v_team = '' or public.exam_norm(d.team_name) = public.exam_norm(v_team))
      and (v_group = '' or public.exam_norm(d.group_name) = public.exam_norm(v_group))
      and (v_shift_bucket = '' or d.shift_bucket = v_shift_bucket)
      and (v_shift_raw = '' or public.exam_norm(d.shift_raw) = public.exam_norm(v_shift_raw))
      and (v_position = '' or public.exam_norm(d.position_name) = public.exam_norm(v_position))
      and (v_country = '' or public.exam_norm(d.country_name) = public.exam_norm(v_country))
      and (v_employee_status = '' or lower(d.employee_status) = v_employee_status)
      and (
        v_employment_type = ''
        or lower(coalesce(d.employment_type, '')) = v_employment_type
      )
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'directory_total', (select count(*) from display_rows),
    'refreshed_at', (select max(d.refreshed_at) from display_rows d),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'day', count(*) filter (where f.shift_bucket = 'day'),
        'mid', count(*) filter (where f.shift_bucket = 'mid'),
        'night', count(*) filter (where f.shift_bucket = 'night'),
        'other', count(*) filter (where f.shift_bucket = 'other'),
        'teams', count(distinct f.team_name)
          filter (where nullif(btrim(f.team_name), '') is not null),
        'groups', count(distinct f.group_name)
          filter (where nullif(btrim(f.group_name), '') is not null),
        'matched', count(*) filter (where f.employee_matched),
        'unmatched', count(*) filter (where not f.employee_matched),
        'active', count(*) filter (where lower(f.employee_status) = 'active'),
        'resigned', count(*) filter (where lower(f.employee_status) = 'resigned')
      )
      from filtered f
    ),
    'options', jsonb_build_object(
      'teams', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'value', o.value,
            'label', o.value,
            'count', o.row_count
          )
          order by o.first_source_row nulls last, o.value
        ), '[]'::jsonb)
        from (
          select
            d.team_name value,
            count(*) row_count,
            min(d.source_row) first_source_row
          from display_rows d
          where nullif(btrim(d.team_name), '') is not null
          group by d.team_name
        ) o
      ),
      'groups', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'value', o.value,
            'label', o.value,
            'count', o.row_count,
            'team', o.team_name
          )
          order by o.first_source_row nulls last, o.team_name, o.value
        ), '[]'::jsonb)
        from (
          select
            d.group_name value,
            d.team_name,
            count(*) row_count,
            min(d.source_row) first_source_row
          from display_rows d
          where nullif(btrim(d.group_name), '') is not null
          group by d.team_name, d.group_name
        ) o
      ),
      'shift_buckets', (
        select jsonb_agg(
          jsonb_build_object(
            'value', o.value,
            'label', o.label,
            'count', o.row_count
          )
          order by o.sort_order
        )
        from (
          select
            v.value,
            v.label,
            v.sort_order,
            count(d.employee_no) row_count
          from (values
            ('day'::text, '白班'::text, 1),
            ('mid'::text, '中班'::text, 2),
            ('night'::text, '夜班'::text, 3),
            ('other'::text, '其他 / 未填写'::text, 4)
          ) v(value, label, sort_order)
          left join display_rows d on d.shift_bucket = v.value
          group by v.value, v.label, v.sort_order
        ) o
      ),
      'shifts', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'value', o.shift_raw,
            'label', o.shift_display,
            'bucket', o.shift_bucket,
            'time', o.shift_time,
            'count', o.row_count
          )
          order by o.shift_sort, o.shift_time nulls last, o.shift_raw
        ), '[]'::jsonb)
        from (
          select
            d.shift_raw,
            d.shift_display,
            d.shift_bucket,
            d.shift_time,
            d.shift_sort,
            count(*) row_count
          from display_rows d
          where d.shift_raw is not null
          group by
            d.shift_raw,
            d.shift_display,
            d.shift_bucket,
            d.shift_time,
            d.shift_sort
        ) o
      ),
      'positions', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct d.position_name value
          from display_rows d
          where nullif(btrim(d.position_name), '') is not null
        ) o
      ),
      'countries', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct d.country_name value
          from display_rows d
          where nullif(btrim(d.country_name), '') is not null
        ) o
      ),
      'employee_statuses', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct d.employee_status value
          from display_rows d
          where nullif(btrim(d.employee_status), '') is not null
        ) o
      ),
      'employment_types', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct d.employment_type value
          from display_rows d
          where nullif(btrim(d.employment_type), '') is not null
        ) o
      )
    ),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_id', f.employee_id,
          'employee_no', f.employee_no,
          'full_name', f.full_name,
          'hire_date', f.hire_date,
          'employee_status', f.employee_status,
          'employment_type', f.employment_type,
          'employee_matched', f.employee_matched,
          'team_name', f.team_name,
          'group_name', f.group_name,
          'position_name', f.position_name,
          'country_name', f.country_name,
          'shift_raw', f.shift_raw,
          'shift_bucket', f.shift_bucket,
          'shift_bucket_label', f.shift_bucket_label,
          'shift_time', f.shift_time,
          'shift_display', f.shift_display,
          'platform_name', f.platform_name,
          'responsible', f.responsible,
          'onsite_trainer', f.onsite_trainer,
          'online_leader', f.online_leader,
          'online_trainer', f.online_trainer,
          'source_row', f.source_row,
          'refreshed_at', f.refreshed_at
        )
        order by f.source_row nulls last, f.employee_no
      )
      from filtered f
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function attendance_private.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
grant usage on schema attendance_private to authenticated;
grant execute on function attendance_private.admin_attendance_schedule(jsonb)
  to authenticated;

create or replace function public.admin_attendance_schedule(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select attendance_private.admin_attendance_schedule(p_filters);
$$;

revoke all on function public.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_attendance_schedule(jsonb)
  to authenticated;

comment on function public.admin_attendance_schedule(jsonb) is
  'Permission-checked complete current roster schedule with normalized shift buckets and canonical employee lifecycle fields.';

notify pgrst, 'reload schema';
