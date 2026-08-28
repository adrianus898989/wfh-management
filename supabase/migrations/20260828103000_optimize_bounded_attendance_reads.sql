begin;

-- The existing security-barrier view remains unchanged.  These changes only
-- replace its two known bounded callers with an internal batch enricher that
-- receives an already-bounded candidate ID set.  Caller scope/self checks are
-- deliberately retained after enrichment. A short DDL lock deadline
-- fails closed instead of waiting behind an active API request.
set local lock_timeout = '500ms';
set local statement_timeout = '10s';

do $verify_attendance_read_preconditions$
declare
  v_options text[];
  v_admin text := pg_catalog.pg_get_functiondef(
    'attendance_private.admin_attendance_monthly(jsonb)'::regprocedure
  );
  v_staff text := pg_catalog.pg_get_functiondef(
    'attendance_private.staff_attendance_home(text)'::regprocedure
  );
  v_source text := 'from attendance_private.attendance_enriched_records x';
begin
  select relation.reloptions
  into v_options
  from pg_catalog.pg_class relation
  where relation.oid = 'attendance_private.attendance_enriched_records'::regclass;

  if not ('security_invoker=true' = any(coalesce(v_options, array[]::text[])))
     or not ('security_barrier=true' = any(coalesce(v_options, array[]::text[]))) then
    raise exception 'attendance_enriched_security_boundary_changed';
  end if;

  if pg_catalog.strpos(v_admin, v_source) = 0
     and pg_catalog.strpos(
       v_admin,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0 then
    raise exception 'admin_attendance_monthly_source_shape_changed';
  end if;
  if pg_catalog.strpos(v_admin, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or pg_catalog.strpos(v_admin, 'public.has_permission(''attendance.monthly.view'')') = 0
     or (
       (
         pg_catalog.strpos(v_admin, 'public.backend_employee_in_scope(x.employee_id)') = 0
         or pg_catalog.strpos(v_admin, 'public.backend_employee_in_scope(e.id)') = 0
       )
       and pg_catalog.strpos(
         v_admin,
         'authorized_employee_scope as materialized'
       ) = 0
     ) then
    raise exception 'admin_attendance_monthly_security_shape_changed';
  end if;

  if pg_catalog.strpos(v_staff, v_source) = 0
     and pg_catalog.strpos(
       v_staff,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0 then
    raise exception 'staff_attendance_home_source_shape_changed';
  end if;
  if pg_catalog.strpos(v_staff, 'session_private.current_app_session_is_valid(''staff'')') = 0
     or pg_catalog.strpos(v_staff, 'ua.employee_portal_enabled = true') = 0
     or pg_catalog.strpos(v_staff, 'x.employee_id = v_employee_id') = 0 then
    raise exception 'staff_attendance_home_security_shape_changed';
  end if;
end;
$verify_attendance_read_preconditions$;

-- Resolve only the requested source rows.  Historical identity lookups are
-- correlated and capped at one row, so PostgreSQL can use the existing
-- lifecycle expression indexes and Memoize repeated employee numbers/names.
-- The returned columns are exactly the subset consumed by the admin monthly
-- and staff self-service readers; neither public JSON protocol changes.
create or replace function attendance_private.enrich_attendance_record_ids(
  p_record_ids uuid[]
)
returns table (
  id uuid,
  employee_id uuid,
  historical_employee_no text,
  effective_match_status text,
  employee_no_raw text,
  employee_name_raw text,
  employee_no text,
  full_name text,
  hire_date date,
  employee_status text,
  employment_type text,
  country text,
  platform text,
  position_name text,
  team_name text,
  manager text,
  kind text,
  event_date date,
  event_kind text,
  reason text,
  note text,
  is_mirror boolean,
  source_key text,
  source_group text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce(pg_catalog.cardinality(p_record_ids), 0) = 0 then
    return;
  end if;
  return query
  with requested_ids as materialized (
    select distinct requested.record_id
    from pg_catalog.unnest(p_record_ids) requested(record_id)
    where requested.record_id is not null
  ), candidate_records as materialized (
    select record.*
    from requested_ids requested
    join public.employee_attendance_records record
      on record.id = requested.record_id
  )
  select
    record.id,
    coalesce(
      record.employee_id,
      case when employee.id is not null then coalesce(
        direct_history.current_employee_id,
        name_history.current_employee_id
      ) end
    ) employee_id,
    coalesce(direct_history.employee_no, name_history.employee_no)
      historical_employee_no,
    case
      when coalesce(
        record.employee_id,
        case when employee.id is not null then coalesce(
          direct_history.current_employee_id,
          name_history.current_employee_id
        ) end
      ) is not null then 'matched'
      when record.match_status = 'ambiguous' then 'ambiguous'
      when coalesce(
        direct_history.employee_no_key,
        name_history.employee_no_key
      ) is not null
       and coalesce(
         direct_history.employee_status,
         name_history.employee_status
       ) = 'resigned' then 'historical_resigned'
      when coalesce(
        direct_history.employee_no_key,
        name_history.employee_no_key
      ) is not null then 'historical_matched'
      when record.kind = 'resignation'
        or record.event_kind = 'resignation' then 'resignation_unlinked'
      else 'unmatched'
    end effective_match_status,
    record.employee_no_raw,
    record.employee_name_raw,
    coalesce(
      nullif(pg_catalog.btrim(employee.employee_no), ''),
      direct_history.employee_no,
      name_history.employee_no,
      record.employee_no_raw
    ) employee_no,
    coalesce(
      nullif(pg_catalog.btrim(employee.full_name), ''),
      direct_history.full_name,
      name_history.full_name,
      record.employee_name_raw
    ) full_name,
    coalesce(
      employee.hire_date,
      direct_history.hire_date,
      name_history.hire_date
    ) hire_date,
    coalesce(
      nullif(pg_catalog.btrim(employee.status), ''),
      case
        when record.kind = 'resignation'
          or record.event_kind = 'resignation' then 'resigned'
        else coalesce(
          direct_history.employee_status,
          name_history.employee_status
        )
      end,
      record.employee_status_raw
    ) employee_status,
    coalesce(
      nullif(pg_catalog.btrim(employee.employment_type), ''),
      direct_history.employment_type,
      name_history.employment_type
    ) employment_type,
    coalesce(
      nullif(pg_catalog.btrim(employee.country), ''),
      nullif(pg_catalog.btrim(employee.nationality), ''),
      direct_history.country,
      name_history.country,
      record.country_raw
    ) country,
    coalesce(
      nullif(pg_catalog.btrim(employee.platform_scope), ''),
      direct_history.platform,
      name_history.platform,
      record.platform_raw
    ) platform,
    coalesce(
      nullif(pg_catalog.btrim(position.name), ''),
      direct_history.position_name,
      name_history.position_name,
      record.position_name_raw
    ) position_name,
    coalesce(
      nullif(pg_catalog.btrim(team.name), ''),
      direct_history.team_name,
      name_history.team_name,
      record.team_name_raw
    ) team_name,
    coalesce(
      nullif(pg_catalog.btrim(pg_catalog.concat_ws(
        ' / ',
        nullif(pg_catalog.btrim(employee.person_in_charge), ''),
        nullif(pg_catalog.btrim(employee.leader_name), ''),
        nullif(pg_catalog.btrim(employee.online_leader), ''),
        nullif(pg_catalog.btrim(employee.online_trainer), ''),
        nullif(pg_catalog.btrim(employee.on_site_trainer), ''),
        nullif(pg_catalog.btrim(employee.trainer_name), '')
      )), ''),
      direct_history.manager,
      name_history.manager,
      record.manager_raw
    ) manager,
    record.kind,
    record.event_date,
    record.event_kind,
    record.reason,
    record.note,
    record.is_mirror,
    source.source_key,
    source.source_group
  from candidate_records record
  join public.attendance_sheet_sources source on source.id = record.source_id
  left join lateral (
    select history.*
    from attendance_private.historical_employee_directory history
    where record.employee_id is null
      and record.match_status = 'unmatched'
      and nullif(pg_catalog.btrim(record.employee_no_raw), '') is not null
      and history.employee_no_key = pg_catalog.upper(
        pg_catalog.btrim(record.employee_no_raw)
      )
    limit 1
  ) direct_history on true
  left join lateral (
    select alias.employee_no_key
    from attendance_private.historical_employee_aliases alias
    where record.employee_id is null
      and record.match_status = 'unmatched'
      and direct_history.employee_no_key is null
      and alias.name_key = public.exam_norm(record.employee_name_raw)
      and alias.identity_count = 1
    limit 1
  ) name_alias on true
  left join lateral (
    select history.*
    from attendance_private.historical_employee_directory history
    where history.employee_no_key = name_alias.employee_no_key
    limit 1
  ) name_history on true
  left join public.employees employee on employee.id = coalesce(
    record.employee_id,
    direct_history.current_employee_id,
    name_history.current_employee_id
  )
  left join public.teams team on team.id = employee.team_id
  left join public.positions position on position.id = employee.position_id;
end;
$$;

revoke all on function attendance_private.enrich_attendance_record_ids(uuid[])
  from public, anon, authenticated, service_role;

do $install_bounded_attendance_sources$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
  v_old text := 'from attendance_private.attendance_enriched_records x';
  v_admin_scope_cte_old text := 'with scoped_events as materialized (';
  v_admin_scope_cte_new text := $admin_scope$with authorized_employee_scope as materialized (
    select effective.employee_id
    from public.user_scope_employees effective
    where effective.auth_user_id = v_user_id
      and v_access_scope in ('own_team', 'assigned_teams')
  ), scoped_events as materialized ($admin_scope$;
  v_admin_event_scope_old text :=
    'public.backend_employee_in_scope(x.employee_id)';
  v_admin_event_scope_new text := $event_scope$exists (
          select 1
          from authorized_employee_scope authorized
          where authorized.employee_id = x.employee_id
        )$event_scope$;
  v_admin_roster_scope_old text := 'public.backend_employee_in_scope(e.id)';
  v_admin_roster_scope_new text := $roster_scope$exists (
          select 1
          from authorized_employee_scope authorized
          where authorized.employee_id = e.id
        )$roster_scope$;
  v_admin_new text := $admin_source$from attendance_private.enrich_attendance_record_ids(
      array(
        select candidate.id
        from public.employee_attendance_records candidate
        where candidate.kind in ('attendance', 'resignation')
          and not candidate.is_mirror
          and candidate.event_date < v_month_end
          and (
            candidate.event_date >= v_month_start
            or candidate.kind = 'resignation'
            or pg_catalog.lower(coalesce(candidate.event_kind, '')) = 'resignation'
          )
      )
    ) x$admin_source$;
  v_staff_new text := $staff_source$from attendance_private.enrich_attendance_record_ids(
      array(
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
          from attendance_private.historical_employee_aliases identity_alias
          join target_employee_numbers target_number
            on target_number.employee_no_key = identity_alias.employee_no_key
          where identity_alias.identity_count = 1
        ), candidate_ids as (
          select candidate.id
          from public.employee_attendance_records candidate
          where candidate.kind in ('attendance', 'resignation')
            and not candidate.is_mirror
            and candidate.employee_id = v_employee_id
          union
          select candidate.id
          from public.employee_attendance_records candidate
          join target_employee_numbers target_number
            on pg_catalog.upper(pg_catalog.btrim(candidate.employee_no_raw)) =
              target_number.employee_no_key
          where candidate.kind in ('attendance', 'resignation')
            and not candidate.is_mirror
            and candidate.employee_id is null
            and nullif(pg_catalog.btrim(candidate.employee_no_raw), '') is not null
          union
          select candidate.id
          from public.employee_attendance_records candidate
          join target_unique_names target_name
            on public.exam_norm(candidate.employee_name_raw) = target_name.name_key
          where candidate.kind in ('attendance', 'resignation')
            and not candidate.is_mirror
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
        )
        select candidate.id from candidate_ids candidate
      )
    ) x$staff_source$;
begin
  v_signature := 'attendance_private.admin_attendance_monthly(jsonb)'::regprocedure;
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  v_patched := v_definition;
  if pg_catalog.strpos(
       v_patched,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0 then
    if pg_catalog.strpos(v_patched, v_old) = 0 then
      raise exception 'admin_attendance_monthly_source_shape_changed';
    end if;
    v_patched := pg_catalog.replace(v_patched, v_old, v_admin_new);
  end if;
  if pg_catalog.strpos(
       v_patched,
       'authorized_employee_scope as materialized'
     ) = 0 then
    if pg_catalog.strpos(v_patched, v_admin_scope_cte_old) = 0
       or pg_catalog.strpos(v_patched, v_admin_event_scope_old) = 0
       or pg_catalog.strpos(v_patched, v_admin_roster_scope_old) = 0 then
      raise exception 'admin_attendance_monthly_scope_shape_changed';
    end if;
    v_patched := pg_catalog.replace(
      v_patched,
      v_admin_scope_cte_old,
      v_admin_scope_cte_new
    );
    v_patched := pg_catalog.replace(
      v_patched,
      v_admin_event_scope_old,
      v_admin_event_scope_new
    );
    v_patched := pg_catalog.replace(
      v_patched,
      v_admin_roster_scope_old,
      v_admin_roster_scope_new
    );
  end if;
  if v_patched = v_definition then
    if pg_catalog.strpos(
         v_definition,
         'attendance_private.enrich_attendance_record_ids('
       ) = 0
       or pg_catalog.strpos(
         v_definition,
         'authorized_employee_scope as materialized'
       ) = 0 then
      raise exception 'admin_attendance_monthly_patch_failed';
    end if;
  else
    execute v_patched;
  end if;

  v_signature := 'attendance_private.staff_attendance_home(text)'::regprocedure;
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if pg_catalog.strpos(
       v_definition,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0 then
    if pg_catalog.strpos(v_definition, v_old) = 0 then
      raise exception 'staff_attendance_home_source_shape_changed';
    end if;
    v_patched := pg_catalog.replace(v_definition, v_old, v_staff_new);
    if v_patched = v_definition then
      raise exception 'staff_attendance_home_source_patch_failed';
    end if;
    execute v_patched;
  end if;
end;
$install_bounded_attendance_sources$;

do $verify_bounded_attendance_sources$
declare
  v_admin_oid oid := 'attendance_private.admin_attendance_monthly(jsonb)'::regprocedure;
  v_staff_oid oid := 'attendance_private.staff_attendance_home(text)'::regprocedure;
  v_admin text := pg_catalog.pg_get_functiondef(v_admin_oid);
  v_staff text := pg_catalog.pg_get_functiondef(v_staff_oid);
  v_old text := 'from attendance_private.attendance_enriched_records x';
  v_helper_marker text := 'attendance_private.enrich_attendance_record_ids(';
begin
  if pg_catalog.length(v_admin) - pg_catalog.length(
       pg_catalog.replace(v_admin, v_helper_marker, '')
     ) <> pg_catalog.length(v_helper_marker)
     or pg_catalog.length(v_staff) - pg_catalog.length(
       pg_catalog.replace(v_staff, v_helper_marker, '')
     ) <> pg_catalog.length(v_helper_marker) then
    raise exception 'bounded_attendance_helper_call_count_changed';
  end if;

  if pg_catalog.strpos(v_admin, v_old) > 0
     or pg_catalog.strpos(v_staff, v_old) > 0
     or pg_catalog.strpos(
       v_admin,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0
     or pg_catalog.strpos(
       v_staff,
       'attendance_private.enrich_attendance_record_ids('
     ) = 0
     or pg_catalog.strpos(
       v_admin,
       'authorized_employee_scope as materialized'
     ) = 0
     or pg_catalog.strpos(v_admin, 'authorized.employee_id = x.employee_id') = 0
     or pg_catalog.strpos(v_admin, 'authorized.employee_id = e.id') = 0
     or pg_catalog.strpos(v_admin, 'public.backend_employee_in_scope(x.employee_id)') > 0
     or pg_catalog.strpos(v_admin, 'public.backend_employee_in_scope(e.id)') > 0
     or pg_catalog.strpos(v_admin, 'candidate.event_date < v_month_end') = 0
     or pg_catalog.strpos(v_admin, 'candidate.event_date >= v_month_start') = 0
     or pg_catalog.strpos(v_admin, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or pg_catalog.strpos(v_admin, 'public.has_permission(''attendance.monthly.view'')') = 0
     or pg_catalog.strpos(v_staff, 'candidate.employee_id = v_employee_id') = 0
     or pg_catalog.strpos(v_staff, 'target_employee_numbers as materialized') = 0
     or pg_catalog.strpos(v_staff, 'target_unique_names as materialized') = 0
     or pg_catalog.strpos(v_staff, 'identity_alias.employee_no_key') = 0
     or pg_catalog.strpos(v_staff, 'public.employee_lifecycle_events direct_identity') = 0
     or pg_catalog.strpos(v_staff, 'x.employee_id = v_employee_id') = 0
     or pg_catalog.strpos(v_staff, 'session_private.current_app_session_is_valid(''staff'')') = 0
     or pg_catalog.strpos(v_staff, 'ua.employee_portal_enabled = true') = 0 then
    raise exception 'bounded_attendance_source_verification_failed';
  end if;

  if not (select procedure.prosecdef and procedure.provolatile = 's'
          from pg_catalog.pg_proc procedure where procedure.oid = v_admin_oid)
     or not (select procedure.prosecdef and procedure.provolatile = 's'
             from pg_catalog.pg_proc procedure where procedure.oid = v_staff_oid)
     or pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.enrich_attendance_record_ids(uuid[])',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'attendance_private.enrich_attendance_record_ids(uuid[])',
       'execute'
     ) then
    raise exception 'bounded_attendance_security_verification_failed';
  end if;
end;
$verify_bounded_attendance_sources$;

comment on function attendance_private.enrich_attendance_record_ids(uuid[]) is
  'Private bounded enricher for attendance readers. Candidate IDs reduce work before the existing caller scope/self checks; historical identity resolution uses indexed lateral lookups. Not callable by app roles.';

commit;
