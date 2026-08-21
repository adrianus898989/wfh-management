begin;

-- Keep the initial page request small.  The older bootstrap function returns the
-- full manager roster (more than one thousand rows) even before a report is
-- opened.  This context keeps the same permission rules but returns only the
-- current trainer's roster, manager names and compact filter options.
create or replace function public.online_training_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_full jsonb;
  v_roster jsonb;
  v_options jsonb;
begin
  v_full := public.online_training_bootstrap();
  v_roster := coalesce(v_full->'roster', '[]'::jsonb);

  select jsonb_build_object(
    'trainer', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'online_trainer') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'online_trainer'), '') is not null
    ) valueset), '[]'::jsonb),
    'team', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'team') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'team'), '') is not null
    ) valueset), '[]'::jsonb),
    'group', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'group') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'group'), '') is not null
    ) valueset), '[]'::jsonb),
    'position', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'position') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'position'), '') is not null
    ) valueset), '[]'::jsonb),
    'shift', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'shift') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'shift'), '') is not null
    ) valueset), '[]'::jsonb),
    'platform', coalesce((select jsonb_agg(value order by value) from (
      select distinct btrim(item->>'platform') value
      from jsonb_array_elements(v_roster) roster(item)
      where nullif(btrim(item->>'platform'), '') is not null
    ) valueset), '[]'::jsonb)
  ) into v_options;

  return (v_full - 'roster') || jsonb_build_object(
    'roster', '[]'::jsonb,
    'filter_options', v_options
  );
end;
$$;

-- Managers fetch one trainer's people only when they choose that trainer in the
-- report dialog.  Regular trainers continue to receive their own roster in the
-- lightweight context above.
create or replace function public.online_training_roster_for_trainer(p_trainer_name text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_full jsonb;
  v_roster jsonb;
  v_access jsonb;
  v_key text := public.online_training_identity_key(p_trainer_name);
  v_result jsonb;
begin
  if nullif(v_key, '') is null then return '[]'::jsonb; end if;

  v_full := public.online_training_bootstrap();
  v_access := coalesce(v_full->'access', '{}'::jsonb);
  if not coalesce((v_access->>'is_founder')::boolean, false)
     and not coalesce((v_access->>'can_manage')::boolean, false) then
    raise exception '当前账号没有代填线上培训日报权限';
  end if;

  v_roster := coalesce(v_full->'roster', '[]'::jsonb);
  select coalesce(jsonb_agg(item order by item->>'team', item->>'group', item->>'position', item->>'full_name'), '[]'::jsonb)
  into v_result
  from jsonb_array_elements(v_roster) roster(item)
  where public.online_training_identity_key(item->>'online_trainer') = v_key;

  return v_result;
end;
$$;

create or replace function public.online_training_search_reports(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword', '')));
  v_team text := lower(btrim(coalesce(p_filters->>'team', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', '')));
  v_position text := lower(btrim(coalesce(p_filters->>'position', '')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift', '')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform', '')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance', '')));
  v_date_from date := nullif(p_filters->>'from', '')::date;
  v_date_to date := nullif(p_filters->>'to', '')::date;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with visible as materialized (
    select r.*
    from public.online_training_reports r
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and (v_date_from is null or r.report_date >= v_date_from)
      and (v_date_to is null or r.report_date <= v_date_to)
      and (
        v_trainer = ''
        or lower(concat_ws(' ', r.author_name, r.author_employee_no, r.trainer_name)) like '%' || v_trainer || '%'
        or exists (
          select 1 from public.online_training_report_members tm
          where tm.report_id = r.id and lower(coalesce(tm.trainer_name, '')) like '%' || v_trainer || '%'
        )
      )
      and (
        (v_employee_no = '' and v_employee_name = '' and v_team = '' and v_group = ''
          and v_position = '' and v_shift = '' and v_platform = '' and v_attendance = '')
        or exists (
          select 1
          from public.online_training_report_members m
          where m.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and (v_employee_no = '' or lower(coalesce(m.employee_no, '')) like '%' || v_employee_no || '%')
            and (v_employee_name = '' or lower(coalesce(m.employee_name, '')) like '%' || v_employee_name || '%')
            and (v_team = '' or lower(btrim(coalesce(m.team_name, ''))) = v_team)
            and (v_group = '' or lower(btrim(coalesce(m.group_name, ''))) = v_group)
            and (v_position = '' or lower(btrim(coalesce(m.position_name, ''))) = v_position)
            and (v_shift = '' or lower(btrim(coalesce(m.shift_name, ''))) = v_shift)
            and (v_platform = '' or lower(btrim(coalesce(m.platform, ''))) = v_platform)
            and (v_attendance = '' or lower(coalesce(m.attendance_status, '')) = v_attendance)
        )
      )
      and (
        v_keyword = ''
        or lower(concat_ws(' ', r.title, r.platform, r.shift_name, r.team_name, r.group_name,
          r.leader_name, r.trainer_name, r.course_type, r.report_summary, r.issues_summary, r.next_plan))
          like '%' || v_keyword || '%'
        or exists (
          select 1
          from public.online_training_report_members km
          where km.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(km.employee_id)
            )
            and lower(concat_ws(' ', km.employee_no, km.employee_name, km.position_name,
              km.team_name, km.group_name, km.shift_name, km.platform, km.status_note,
              km.work_details, km.performance, km.issues, km.follow_up, km.metrics::text))
              like '%' || v_keyword || '%'
        )
      )
  )
  select
    (select count(*)::integer from visible),
    coalesce((
      select jsonb_agg(
        to_jsonb(v)
        || jsonb_build_object(
          'can_edit', public.online_training_can_edit_report(v.id),
          'can_review', public.online_training_can_review_report(v.id),
          'members', coalesce((
            select jsonb_agg(to_jsonb(m) order by m.sort_order, m.employee_name)
            from public.online_training_report_members m
            where m.report_id = v.id
              and (
                v.created_by = (select auth.uid())
                or public.has_permission('online_training.manage')
                or public.online_training_employee_in_scope(m.employee_id)
              )
          ), '[]'::jsonb)
        )
        order by v.report_date desc, v.created_at desc
      )
      from (
        select * from visible
        order by report_date desc, created_at desc
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) v
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

create or replace function public.online_training_search_people(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword', '')));
  v_team text := lower(btrim(coalesce(p_filters->>'team', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', '')));
  v_position text := lower(btrim(coalesce(p_filters->>'position', '')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift', '')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform', '')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance', '')));
  v_date_from date := nullif(p_filters->>'from', '')::date;
  v_date_to date := nullif(p_filters->>'to', '')::date;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with people as materialized (
    select
      m.employee_id,
      (array_agg(m.employee_no order by r.report_date desc, r.created_at desc))[1] as employee_no,
      (array_agg(m.employee_name order by r.report_date desc, r.created_at desc))[1] as employee_name,
      (array_agg(m.position_name order by r.report_date desc, r.created_at desc))[1] as position_name,
      (array_agg(m.team_name order by r.report_date desc, r.created_at desc))[1] as team_name,
      (array_agg(m.group_name order by r.report_date desc, r.created_at desc))[1] as group_name,
      (array_agg(m.shift_name order by r.report_date desc, r.created_at desc))[1] as shift_name,
      (array_agg(m.platform order by r.report_date desc, r.created_at desc))[1] as platform,
      (array_agg(coalesce(nullif(m.trainer_name, ''), nullif(r.trainer_name, ''), r.author_name)
        order by r.report_date desc, r.created_at desc))[1] as trainer_name,
      count(distinct r.id)::integer as report_count,
      count(*) filter (where m.attendance_status = 'normal')::integer as normal_count,
      count(*) filter (where m.attendance_status = 'rest')::integer as rest_count,
      count(*) filter (where m.attendance_status = 'leave')::integer as leave_count,
      count(*) filter (where m.attendance_status = 'absent')::integer as absent_count,
      count(*) filter (where m.attendance_status = 'transferred')::integer as home_count,
      count(*) filter (where nullif(btrim(m.issues), '') is not null)::integer as issue_count,
      max(r.report_date) as last_report_date
    from public.online_training_report_members m
    join public.online_training_reports r on r.id = m.report_id
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and public.online_training_employee_in_scope(m.employee_id)
      and (v_date_from is null or r.report_date >= v_date_from)
      and (v_date_to is null or r.report_date <= v_date_to)
      and (v_employee_no = '' or lower(coalesce(m.employee_no, '')) like '%' || v_employee_no || '%')
      and (v_employee_name = '' or lower(coalesce(m.employee_name, '')) like '%' || v_employee_name || '%')
      and (v_trainer = '' or lower(concat_ws(' ', r.author_name, r.author_employee_no, r.trainer_name, m.trainer_name)) like '%' || v_trainer || '%')
      and (v_team = '' or lower(btrim(coalesce(m.team_name, ''))) = v_team)
      and (v_group = '' or lower(btrim(coalesce(m.group_name, ''))) = v_group)
      and (v_position = '' or lower(btrim(coalesce(m.position_name, ''))) = v_position)
      and (v_shift = '' or lower(btrim(coalesce(m.shift_name, ''))) = v_shift)
      and (v_platform = '' or lower(btrim(coalesce(m.platform, ''))) = v_platform)
      and (v_attendance = '' or lower(coalesce(m.attendance_status, '')) = v_attendance)
      and (
        v_keyword = ''
        or lower(concat_ws(' ', r.title, r.platform, r.course_type, r.report_summary,
          r.issues_summary, r.next_plan, m.status_note, m.work_details, m.performance,
          m.issues, m.follow_up, m.metrics::text)) like '%' || v_keyword || '%'
      )
    group by m.employee_id
  )
  select
    (select count(*)::integer from people),
    coalesce((
      select jsonb_agg(to_jsonb(p) order by p.last_report_date desc, p.employee_name)
      from (
        select * from people
        order by last_report_date desc, employee_name
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) p
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

revoke all on function public.online_training_context() from public;
revoke all on function public.online_training_roster_for_trainer(text) from public;
revoke all on function public.online_training_search_reports(jsonb, integer, integer) from public;
revoke all on function public.online_training_search_people(jsonb, integer, integer) from public;

grant execute on function public.online_training_context() to authenticated;
grant execute on function public.online_training_roster_for_trainer(text) to authenticated;
grant execute on function public.online_training_search_reports(jsonb, integer, integer) to authenticated;
grant execute on function public.online_training_search_people(jsonb, integer, integer) to authenticated;

commit;
