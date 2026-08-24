-- Employee self-service attendance calendar.
--
-- The public RPC accepts only a month. The employee identity is always resolved
-- from the authenticated, current staff session; callers cannot supply an
-- employee id/no and therefore cannot use this endpoint to read another member.

create or replace function attendance_private.staff_attendance_home(
  p_month text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_full_name text;
  v_hire_date date;
  v_resign_date date;
  v_return_date date;
  v_month text := coalesce(
    nullif(btrim(p_month), ''),
    to_char((now() at time zone 'Asia/Manila')::date, 'YYYY-MM')
  );
  v_month_start date;
  v_month_end date;
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid_month';
  end if;

  select
    e.id,
    e.employee_no,
    e.full_name,
    e.hire_date,
    e.resign_date,
    e.return_date
  into
    v_employee_id,
    v_employee_no,
    v_full_name,
    v_hire_date,
    v_resign_date,
    v_return_date
  from public.user_access ua
  join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.employee_portal_enabled = true
  order by ua.updated_at desc
  limit 1;

  if v_employee_id is null then
    raise exception 'staff_profile_not_linked';
  end if;

  v_month_start := (v_month || '-01')::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  with raw_events as materialized (
    select
      x.id,
      x.event_date,
      case
        when x.kind = 'resignation'
          or lower(coalesce(x.event_kind, '')) = 'resignation'
          then 'resignation'
        when lower(coalesce(x.event_kind, '')) in (
          'public_holiday', 'home_leave', 'leave', 'half_day', 'absence'
        ) then lower(x.event_kind)
        else null
      end event_kind,
      x.kind,
      x.reason,
      x.note,
      x.employee_status,
      x.effective_match_status
    from attendance_private.attendance_enriched_records x
    where x.kind in ('attendance', 'resignation')
      and not x.is_mirror
      and (
        x.employee_id = v_employee_id
        or (
          x.employee_id is null
          and nullif(btrim(v_employee_no), '') is not null
          and upper(btrim(x.employee_no)) = upper(btrim(v_employee_no))
        )
      )
  ), actual_events as materialized (
    select * from raw_events where event_kind is not null
  ), lifecycle as materialized (
    select
      coalesce(
        v_resign_date,
        min(event_date) filter (where event_kind = 'resignation')
      ) resign_date,
      v_return_date return_date
    from actual_events
  ), month_actual as materialized (
    select
      e.event_date,
      e.event_kind,
      jsonb_build_object(
        'id', e.id,
        'event_kind', e.event_kind,
        'kind', e.kind,
        'reason', e.reason,
        'note', e.note,
        'status', e.employee_status,
        'effective_match_status', e.effective_match_status,
        'synthetic', false
      ) event
    from actual_events e
    where e.event_date >= v_month_start
      and e.event_date < v_month_end
  ), month_resignation_fill as materialized (
    select
      d::date event_date,
      'resignation'::text event_kind,
      jsonb_build_object(
        'event_kind', 'resignation',
        'kind', 'resignation',
        'reason', '离职',
        'note', '离职日期起自动标记',
        'status', 'resigned',
        'effective_match_status', 'matched',
        'synthetic', true
      ) event
    from lifecycle l
    cross join lateral generate_series(
      greatest(v_month_start, l.resign_date),
      least(v_month_end - 1, coalesce(l.return_date - 1, v_month_end - 1)),
      interval '1 day'
    ) d
    where l.resign_date is not null
      and l.resign_date < v_month_end
      and (l.return_date is null or l.return_date > l.resign_date)
      and not exists (
        select 1
        from month_actual a
        where a.event_date = d::date
          and a.event_kind = 'resignation'
      )
  ), month_combined as materialized (
    select * from month_actual
    union all
    select * from month_resignation_fill
  ), month_event_lists as materialized (
    select
      event_date,
      jsonb_agg(
        event
        order by case event_kind
          when 'resignation' then 1
          when 'absence' then 2
          when 'leave' then 3
          when 'home_leave' then 4
          when 'public_holiday' then 5
          when 'half_day' then 6
          else 9
        end
      ) events
    from month_combined
    group by event_date
  ), month_days as materialized (
    select coalesce(
      jsonb_object_agg(extract(day from event_date)::integer::text, events order by event_date),
      '{}'::jsonb
    ) days
    from month_event_lists
  ), month_primary as materialized (
    select distinct on (event_date)
      event_date,
      event_kind
    from month_combined
    order by
      event_date,
      case event_kind
        when 'resignation' then 1
        when 'absence' then 2
        when 'leave' then 3
        when 'home_leave' then 4
        when 'public_holiday' then 5
        when 'half_day' then 6
        else 9
      end
  ), cumulative_resignation_fill as materialized (
    select
      d::date event_date,
      'resignation'::text event_kind
    from lifecycle l
    cross join lateral generate_series(
      l.resign_date,
      least(v_today, coalesce(l.return_date - 1, v_today)),
      interval '1 day'
    ) d
    where l.resign_date is not null
      and l.resign_date <= v_today
      and (l.return_date is null or l.return_date > l.resign_date)
  ), cumulative_combined as materialized (
    select event_date, event_kind from actual_events
    union all
    select event_date, event_kind from cumulative_resignation_fill
  ), cumulative_primary as materialized (
    select distinct on (event_date)
      event_date,
      event_kind
    from cumulative_combined
    where event_date <= v_today
    order by
      event_date,
      case event_kind
        when 'resignation' then 1
        when 'absence' then 2
        when 'leave' then 3
        when 'home_leave' then 4
        when 'public_holiday' then 5
        when 'half_day' then 6
        else 9
      end
  ), month_stats as materialized (
    select
      count(*) filter (where event_kind = 'public_holiday')::integer public_holiday,
      count(*) filter (where event_kind = 'home_leave')::integer home_leave,
      count(*) filter (where event_kind = 'leave')::integer leave_days,
      count(*) filter (where event_kind = 'half_day')::integer half_day,
      count(*) filter (where event_kind = 'absence')::integer absence,
      count(*) filter (where event_kind = 'resignation')::integer resignation,
      coalesce(sum(case when event_kind = 'half_day' then 0.5 else 1 end), 0)::numeric total_days
    from month_primary
  ), cumulative_stats as materialized (
    select
      count(*) filter (where event_kind = 'public_holiday')::integer public_holiday,
      count(*) filter (where event_kind = 'home_leave')::integer home_leave,
      count(*) filter (where event_kind = 'leave')::integer leave_days,
      count(*) filter (where event_kind = 'half_day')::integer half_day,
      count(*) filter (where event_kind = 'absence')::integer absence,
      count(*) filter (where event_kind = 'resignation')::integer resignation,
      coalesce(sum(case when event_kind = 'half_day' then 0.5 else 1 end), 0)::numeric total_days
    from cumulative_primary
  )
  select jsonb_build_object(
    'employee', jsonb_build_object(
      'id', v_employee_id,
      'employee_no', v_employee_no,
      'full_name', v_full_name,
      'hire_date', v_hire_date
    ),
    'month', v_month,
    'month_start', v_month_start,
    'month_end_exclusive', v_month_end,
    'days_in_month', extract(day from (v_month_end - 1))::integer,
    'days', (select days from month_days),
    'month_summary', jsonb_build_object(
      'public_holiday', coalesce(ms.public_holiday, 0),
      'home_leave', coalesce(ms.home_leave, 0),
      'leave', coalesce(ms.leave_days, 0),
      'half_day', coalesce(ms.half_day, 0),
      'absence', coalesce(ms.absence, 0),
      'resignation', coalesce(ms.resignation, 0),
      'total_days', coalesce(ms.total_days, 0)
    ),
    'all_time_summary', jsonb_build_object(
      'public_holiday', coalesce(cs.public_holiday, 0),
      'home_leave', coalesce(cs.home_leave, 0),
      'leave', coalesce(cs.leave_days, 0),
      'half_day', coalesce(cs.half_day, 0),
      'absence', coalesce(cs.absence, 0),
      'resignation', coalesce(cs.resignation, 0),
      'total_days', coalesce(cs.total_days, 0)
    ),
    -- Backward-compatible summary names used by the dashboard metrics.
    'summary', jsonb_build_object(
      'rest', coalesce(ms.public_holiday, 0),
      'leave', coalesce(ms.leave_days, 0) + coalesce(ms.home_leave, 0),
      'absent', coalesce(ms.absence, 0),
      'month_absent', coalesce(ms.absence, 0),
      'month_leave', coalesce(ms.public_holiday, 0)
        + coalesce(ms.home_leave, 0)
        + coalesce(ms.leave_days, 0)
        + coalesce(ms.half_day, 0)
    ),
    'total', (select count(*) from actual_events),
    'selected_month_total', (select count(*) from month_primary),
    'first_record_date', (select min(event_date) from actual_events),
    'last_record_date', (select max(event_date) from actual_events)
  )
  into v_result
  from month_stats ms
  cross join cumulative_stats cs;

  return v_result;
end;
$$;

revoke all on function attendance_private.staff_attendance_home(text)
  from public, anon, authenticated;
grant execute on function attendance_private.staff_attendance_home(text)
  to service_role;

create or replace function public.staff_attendance_home(
  p_month text default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select attendance_private.staff_attendance_home(p_month);
$$;

revoke all on function public.staff_attendance_home(text)
  from public, anon, authenticated;
grant execute on function public.staff_attendance_home(text)
  to authenticated;

comment on function public.staff_attendance_home(text) is
  'Returns only the current authenticated staff member own monthly attendance grid and cumulative totals.';
