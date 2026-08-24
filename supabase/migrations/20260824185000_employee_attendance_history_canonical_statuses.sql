-- Keep employee-profile attendance history aligned with the six canonical
-- attendance statuses used by the monthly/admin and staff attendance views.
-- Legacy `absent` rows remain readable as canonical `absence`; parser-only
-- `other` rows stay available for import diagnostics but are not business
-- attendance records and therefore are not returned or counted here.

create or replace function attendance_private.admin_employee_attendance_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('attendance.view')
    or public.has_permission('employee.view')
  ) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_scope_denied';
  end if;

  with normalized as materialized (
    select
      x.*,
      case
        when x.kind = 'resignation'
          or lower(coalesce(x.event_kind, '')) = 'resignation'
          then 'resignation'
        when lower(coalesce(x.event_kind, '')) = 'absent'
          then 'absence'
        else lower(coalesce(x.event_kind, ''))
      end normalized_event_kind
    from attendance_private.attendance_enriched_records x
    where x.employee_id = p_employee_id
      and x.kind in ('attendance', 'resignation')
      and not x.is_mirror
      and (
        x.kind = 'resignation'
        or lower(coalesce(x.event_kind, '')) in (
          'public_holiday',
          'home_leave',
          'leave',
          'half_day',
          'absence',
          'absent',
          'resignation'
        )
      )
  ), history as materialized (
    select
      n.id,
      n.event_date,
      n.kind,
      n.normalized_event_kind event_kind,
      (
        (to_jsonb(n) - 'normalized_event_kind')
        || jsonb_build_object('event_kind', n.normalized_event_kind)
        || case
          when n.normalized_event_kind = 'resignation'
            and nullif(btrim(coalesce(n.reason, '')), '') is null
            then jsonb_build_object(
              'reason_code', 'attendance.synthetic.resignation'
            )
          else '{}'::jsonb
        end
        || case
          when n.normalized_event_kind = 'resignation'
            and nullif(btrim(coalesce(n.note, '')), '') is null
            then jsonb_build_object(
              'note_code', 'attendance.synthetic.resignationFromDate'
            )
          else '{}'::jsonb
        end
      ) row_json
    from normalized n
  ), paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last, h.id desc
    limit v_page_size
    offset ((v_page::bigint - 1) * v_page_size)
  )
  select jsonb_build_object(
    'employee', (
      select to_jsonb(e)
      from (
        select
          e.id,
          e.employee_no,
          e.full_name,
          e.hire_date,
          e.employment_type,
          e.employment_type employee_type,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name
        from public.employees e
        left join public.teams t on t.id = e.team_id
        left join public.positions pos on pos.id = e.position_id
        where e.id = p_employee_id
      ) e
    ),
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from history),
    'pages', greatest(
      1,
      ceil((select count(*) from history)::numeric / v_page_size)::integer
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'first_event_date', min(event_date),
        'last_event_date', max(event_date),
        'public_holiday', count(*) filter (
          where event_kind = 'public_holiday'
        ),
        'home_leave', count(*) filter (where event_kind = 'home_leave'),
        'leave', count(*) filter (where event_kind = 'leave'),
        'half_day', count(*) filter (where event_kind = 'half_day'),
        'absence', count(*) filter (where event_kind = 'absence'),
        'resignation', count(*) filter (where event_kind = 'resignation')
      )
      from history
    ),
    'rows', coalesce(
      (
        select jsonb_agg(
          p.row_json
          order by p.event_date desc nulls last, p.id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function attendance_private.admin_employee_attendance_history(
  uuid,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function attendance_private.admin_employee_attendance_history(
  uuid,
  integer,
  integer
) to authenticated;

notify pgrst, 'reload schema';
