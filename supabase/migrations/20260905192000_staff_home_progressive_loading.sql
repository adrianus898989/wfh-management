begin;

set local lock_timeout = '1s';
set local statement_timeout = '15s';

-- Keep the legacy no-argument payload for older clients, and add a compact
-- overload for the workspace. The error list is already loaded by its own
-- paged RPC, while exam history is needed only when the exam tab is opened.
do $install_compact_staff_portal_home$
declare
  v_source_signature regprocedure := 'public.staff_portal_home()'::regprocedure;
  v_source text := pg_catalog.pg_get_functiondef(v_source_signature);
  v_compact text;
  v_signature_old text := 'FUNCTION public.staff_portal_home()';
  v_signature_new text :=
    'FUNCTION public.staff_portal_home(p_include_exam_history boolean)';
  v_recent_old text := $old$    'recent_errors', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last, x.source_row desc nulls last),
        '[]'::jsonb
      )
      from (
        select
          record_key,
          source_row,
          qc_date,
          error_type,
          error_note,
          correct_action,
          score,
          qc_person,
          leader_review,
          qc_result,
          review_date
        from attendance_private.staff_recent_error_rows(c.employee_no)
        where employee_no = upper(btrim(c.employee_no))
        order by qc_date desc nulls last, source_row desc nulls last
        limit 12
      ) x
    ),$old$;
  v_recent_legacy text;
  v_recent_new text := $new$    'recent_errors', '[]'::jsonb,$new$;
  v_exam_old text := $old$    'exam_history', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.started_at desc),
        '[]'::jsonb
      )
      from (
        select
          id,
          title,
          attempt_no,
          status,
          started_at,
          submitted_at,
          graded_at,
          earned_score,
          total_score,
          percentage,
          passed,
          grader_name,
          correct_count,
          partial_count,
          wrong_count,
          pending_count,
          source_system,
          source_label,
          answer_detail_available,
          answer_detail_count,
          total_question_count,
          unanswered_count
        from public.admin_exam_combined_sessions_v
        where employee_id = c.employee_id
          and status <> 'in_progress'
        order by started_at desc
        limit 100
      ) x
    )$old$;
  v_exam_new text := $new$    'payload_scope', jsonb_build_object(
      'recent_errors', false,
      'exam_history', coalesce(p_include_exam_history, false)
    ),
    'exam_history', case when coalesce(p_include_exam_history, false) then (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.started_at desc),
        '[]'::jsonb
      )
      from (
        select
          id,
          title,
          attempt_no,
          status,
          started_at,
          submitted_at,
          graded_at,
          earned_score,
          total_score,
          percentage,
          passed,
          grader_name,
          correct_count,
          partial_count,
          wrong_count,
          pending_count,
          source_system,
          source_label,
          answer_detail_available,
          answer_detail_count,
          total_question_count,
          unanswered_count
        from public.admin_exam_combined_sessions_v
        where employee_id = c.employee_id
          and status <> 'in_progress'
        order by started_at desc
        limit 100
      ) x
    ) else '[]'::jsonb end$new$;
begin
  v_recent_legacy := pg_catalog.replace(
    v_recent_old,
    'from attendance_private.staff_recent_error_rows(c.employee_no)',
    'from public.report_employee_errors_v'
  );

  if not coalesce((
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where procedure.oid = v_source_signature
  ), false)
     or pg_catalog.strpos(v_source, 'public.exam_staff_context()') = 0
     or pg_catalog.strpos(v_source, 'c.employee_id') = 0
     or pg_catalog.strpos(v_source, 'public.online_training_identity_key(') = 0
     or pg_catalog.strpos(v_source, v_signature_old) = 0
     or (
       pg_catalog.strpos(v_source, v_recent_old) = 0
       and pg_catalog.strpos(v_source, v_recent_legacy) = 0
     )
     or pg_catalog.strpos(v_source, v_exam_old) = 0 then
    raise exception 'compact_staff_portal_home_source_shape_changed';
  end if;

  v_compact := pg_catalog.replace(v_source, v_signature_old, v_signature_new);
  if pg_catalog.strpos(v_compact, v_recent_old) > 0 then
    v_compact := pg_catalog.replace(v_compact, v_recent_old, v_recent_new);
  else
    v_compact := pg_catalog.replace(v_compact, v_recent_legacy, v_recent_new);
  end if;
  v_compact := pg_catalog.replace(v_compact, v_exam_old, v_exam_new);
  execute v_compact;

  v_compact := pg_catalog.pg_get_functiondef(
    'public.staff_portal_home(boolean)'::regprocedure
  );
  if pg_catalog.strpos(v_compact, '''recent_errors'', ''[]''::jsonb') = 0
     or pg_catalog.strpos(v_compact, 'coalesce(p_include_exam_history, false)') = 0
     or pg_catalog.strpos(v_compact, 'attendance_private.staff_recent_error_rows') > 0
     or pg_catalog.strpos(v_compact, 'public.report_employee_errors_v') > 0
     or pg_catalog.strpos(v_compact, 'public.online_training_identity_key(') = 0
     or pg_catalog.strpos(v_compact, 'public.exam_staff_context()') = 0 then
    raise exception 'compact_staff_portal_home_install_failed';
  end if;
end;
$install_compact_staff_portal_home$;

revoke all on function public.staff_portal_home(boolean)
  from public, anon, authenticated;
grant execute on function public.staff_portal_home(boolean)
  to authenticated;

-- Dashboard connectivity counters do not need the latest 120 incident rows.
create or replace function public.staff_activity_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '1500ms'
set jit = 'off'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_total integer := 0;
  v_power integer := 0;
  v_internet integer := 0;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;

  select employee.id, employee.employee_no
  into v_employee_id, v_employee_no
  from public.user_access access
  join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active
    and access.employee_portal_enabled
  order by access.updated_at desc
  limit 1;

  if v_employee_id is null then
    raise exception 'staff_profile_not_linked';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where incident.incident_type = 'power_outage'
    )::integer,
    pg_catalog.count(*) filter (
      where incident.incident_type = 'internet_outage'
    )::integer
  into v_total, v_power, v_internet
  from public.employee_connectivity_incidents incident
  where incident.employee_id = v_employee_id;

  return pg_catalog.jsonb_build_object(
    'employee_no', v_employee_no,
    'detail_level', 'summary',
    'attendance', null,
    'connectivity', pg_catalog.jsonb_build_object(
      'total', v_total,
      'power', v_power,
      'internet', v_internet,
      'rows', '[]'::jsonb
    )
  );
end;
$function$;

revoke all on function public.staff_activity_summary()
  from public, anon, authenticated;
grant execute on function public.staff_activity_summary()
  to authenticated;

-- Dashboard attendance needs only this month's counters. Keep the candidate
-- read bounded to one employee and one month; the complete calendar and
-- cumulative history stay on the dedicated attendance tab RPC.
create or replace function public.staff_attendance_summary(
  p_month text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
set jit = 'off'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_full_name text;
  v_hire_date date;
  v_month text := coalesce(
    nullif(pg_catalog.btrim(p_month), ''),
    pg_catalog.to_char(
      (pg_catalog.now() at time zone 'Asia/Manila')::date,
      'YYYY-MM'
    )
  );
  v_month_start date;
  v_month_end date;
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

  select employee.id, employee.employee_no, employee.full_name,
    employee.hire_date
  into v_employee_id, v_employee_no, v_full_name, v_hire_date
  from public.user_access access
  join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active
    and access.employee_portal_enabled
  order by access.updated_at desc
  limit 1;

  if v_employee_id is null then
    raise exception 'staff_profile_not_linked';
  end if;

  v_month_start := (v_month || '-01')::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  with target_employee_numbers as materialized (
    select pg_catalog.upper(pg_catalog.btrim(v_employee_no)) employee_no_key
    where nullif(pg_catalog.btrim(v_employee_no), '') is not null
    union
    select pg_catalog.upper(pg_catalog.btrim(identity_event.employee_no))
    from public.employee_lifecycle_events identity_event
    where identity_event.employee_id = v_employee_id
      and nullif(pg_catalog.btrim(identity_event.employee_no), '') is not null
  ), target_unique_names as materialized (
    select identity_alias.name_key
    from attendance_private.historical_employee_aliases_cache identity_alias
    join target_employee_numbers target_number
      on target_number.employee_no_key = identity_alias.employee_no_key
    where identity_alias.identity_count = 1
  ), candidate_ids as materialized (
    select candidate.id
    from public.employee_attendance_records candidate
    where candidate.kind = 'attendance'
      and not candidate.is_mirror
      and candidate.raw_values->>'sync_presence' is distinct from 'protected_missing'
      and candidate.event_date >= v_month_start
      and candidate.event_date < v_month_end
      and candidate.employee_id = v_employee_id
    union
    select candidate.id
    from public.employee_attendance_records candidate
    join target_employee_numbers target_number
      on pg_catalog.upper(pg_catalog.btrim(candidate.employee_no_raw)) =
        target_number.employee_no_key
    where candidate.kind = 'attendance'
      and not candidate.is_mirror
      and candidate.raw_values->>'sync_presence' is distinct from 'protected_missing'
      and candidate.event_date >= v_month_start
      and candidate.event_date < v_month_end
      and candidate.employee_id is null
      and nullif(pg_catalog.btrim(candidate.employee_no_raw), '') is not null
    union
    select candidate.id
    from public.employee_attendance_records candidate
    join target_unique_names target_name
      on public.exam_norm(candidate.employee_name_raw) = target_name.name_key
    where candidate.kind = 'attendance'
      and not candidate.is_mirror
      and candidate.raw_values->>'sync_presence' is distinct from 'protected_missing'
      and candidate.event_date >= v_month_start
      and candidate.event_date < v_month_end
      and candidate.employee_id is null
      and candidate.match_status = 'unmatched'
      and nullif(public.exam_norm(candidate.employee_name_raw), '') is not null
      and not exists (
        select 1
        from public.employee_lifecycle_events direct_identity
        where nullif(pg_catalog.btrim(candidate.employee_no_raw), '') is not null
          and pg_catalog.upper(pg_catalog.btrim(direct_identity.employee_no)) =
            pg_catalog.upper(pg_catalog.btrim(candidate.employee_no_raw))
      )
  ), current_events as materialized (
    select enriched.event_date,
      case
        when pg_catalog.lower(coalesce(enriched.event_kind, '')) = 'absent'
          then 'absence'
        when pg_catalog.lower(coalesce(enriched.event_kind, '')) in (
          'public_holiday', 'home_leave', 'leave', 'half_day', 'absence'
        ) then pg_catalog.lower(enriched.event_kind)
      end event_kind
    from attendance_private.enrich_attendance_record_ids(
      array(select candidate.id from candidate_ids candidate)
    ) enriched
    where enriched.employee_id = v_employee_id
      or (
        enriched.employee_id is null
        and nullif(pg_catalog.btrim(v_employee_no), '') is not null
        and pg_catalog.upper(pg_catalog.btrim(enriched.employee_no)) =
          pg_catalog.upper(pg_catalog.btrim(v_employee_no))
      )
  ), primary_events as materialized (
    select distinct on (event.event_date)
      event.event_date,
      event.event_kind
    from current_events event
    where event.event_kind is not null
    order by event.event_date,
      case event.event_kind
        when 'absence' then 1
        when 'leave' then 2
        when 'home_leave' then 3
        when 'public_holiday' then 4
        when 'half_day' then 5
        else 9
      end
  ), summary as (
    select
      pg_catalog.count(*) filter (
        where event_kind = 'public_holiday'
      )::integer public_holiday,
      pg_catalog.count(*) filter (
        where event_kind = 'home_leave'
      )::integer home_leave,
      pg_catalog.count(*) filter (
        where event_kind = 'leave'
      )::integer leave_days,
      pg_catalog.count(*) filter (
        where event_kind = 'half_day'
      )::integer half_day,
      pg_catalog.count(*) filter (
        where event_kind = 'absence'
      )::integer absence,
      coalesce(pg_catalog.sum(
        case when event_kind = 'half_day' then 0.5 else 1 end
      ), 0)::numeric total_days
    from primary_events
  )
  select pg_catalog.jsonb_build_object(
    'detail_level', 'summary',
    'employee', pg_catalog.jsonb_build_object(
      'id', v_employee_id,
      'employee_no', v_employee_no,
      'full_name', v_full_name,
      'hire_date', v_hire_date
    ),
    'month', v_month,
    'month_start', v_month_start,
    'month_end_exclusive', v_month_end,
    'days_in_month', extract(day from (v_month_end - 1))::integer,
    'days', '{}'::jsonb,
    'month_summary', pg_catalog.jsonb_build_object(
      'public_holiday', coalesce(summary.public_holiday, 0),
      'home_leave', coalesce(summary.home_leave, 0),
      'leave', coalesce(summary.leave_days, 0),
      'half_day', coalesce(summary.half_day, 0),
      'absence', coalesce(summary.absence, 0),
      'resignation', 0,
      'total_days', coalesce(summary.total_days, 0)
    ),
    'summary', pg_catalog.jsonb_build_object(
      'rest', coalesce(summary.public_holiday, 0),
      'leave', coalesce(summary.leave_days, 0)
        + coalesce(summary.home_leave, 0),
      'absent', coalesce(summary.absence, 0),
      'month_absent', coalesce(summary.absence, 0),
      'month_leave', coalesce(summary.public_holiday, 0)
        + coalesce(summary.home_leave, 0)
        + coalesce(summary.leave_days, 0)
        + coalesce(summary.half_day, 0)
    )
  )
  into v_result
  from summary;

  return v_result;
end;
$function$;

revoke all on function public.staff_attendance_summary(text)
  from public, anon, authenticated;
grant execute on function public.staff_attendance_summary(text)
  to authenticated;

do $verify_progressive_staff_home_security$
declare
  v_portal oid := 'public.staff_portal_home(boolean)'::regprocedure;
  v_activity oid := 'public.staff_activity_summary()'::regprocedure;
  v_attendance oid := 'public.staff_attendance_summary(text)'::regprocedure;
begin
  if not (select procedure.prosecdef and procedure.provolatile = 's'
          from pg_catalog.pg_proc procedure where procedure.oid = v_portal)
     or not (select procedure.proconfig @> array['search_path=""']::text[]
             from pg_catalog.pg_proc procedure where procedure.oid = v_portal)
     or not (select procedure.prosecdef and procedure.provolatile = 's'
             from pg_catalog.pg_proc procedure where procedure.oid = v_activity)
     or not (select procedure.proconfig @> array['search_path=""']::text[]
             from pg_catalog.pg_proc procedure where procedure.oid = v_activity)
     or not (select procedure.prosecdef and procedure.provolatile = 's'
             from pg_catalog.pg_proc procedure where procedure.oid = v_attendance)
     or not (select procedure.proconfig @> array['search_path=""']::text[]
             from pg_catalog.pg_proc procedure where procedure.oid = v_attendance)
     or pg_catalog.has_function_privilege(
       'anon', 'public.staff_portal_home(boolean)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.staff_activity_summary()', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.staff_attendance_summary(text)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.staff_portal_home(boolean)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.staff_activity_summary()', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.staff_attendance_summary(text)', 'execute'
     ) then
    raise exception 'progressive_staff_home_security_verification_failed';
  end if;
end;
$verify_progressive_staff_home_security$;

comment on function public.staff_portal_home(boolean) is
  'Compact staff workspace payload; exam history is queried only when explicitly requested and recent errors remain paged separately.';
comment on function public.staff_activity_summary() is
  'Current-session staff-only connectivity counters without incident detail rows.';
comment on function public.staff_attendance_summary(text) is
  'Current-session staff-only monthly attendance counters without calendar or cumulative history.';

notify pgrst, 'reload schema';

commit;
