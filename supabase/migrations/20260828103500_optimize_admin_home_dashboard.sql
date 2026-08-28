-- Keep the management home page bounded.  The previous Edge action loaded the
-- complete employee directory, team directory and current roster, serialized
-- every employee to the browser, then let each browser calculate aggregates.
-- At 100 admin sessions that multiplies both database work and response size.

create or replace function public.admin_home_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set jit = 'off'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_today date := (statement_timestamp() at time zone 'Asia/Manila')::date;
  v_role_id uuid;
  v_role_code text;
  v_data_scope text;
  v_permissions text[] := '{}'::text[];
  v_is_founder boolean := false;
  v_all_scope boolean := false;
  v_can_employees boolean := false;
  v_can_staff_accounts boolean := false;
  v_can_backend_accounts boolean := false;
  v_result jsonb;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'ADMIN_SESSION_REQUIRED';
  end if;
  select access.role_id, role.code, access.data_scope
  into v_role_id, v_role_code, v_data_scope
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
    and role.active = true
  order by access.updated_at desc
  limit 1;

  if v_role_code is null then
    raise exception using errcode = '42501', message = 'BACKEND_ACCESS_REQUIRED';
  end if;

  v_is_founder := v_role_code = 'founder';
  v_all_scope := v_is_founder or v_data_scope = 'all';
  if v_is_founder then
    v_permissions := array['*']::text[];
  else
    with effective_permissions as (
      select permission.code
      from public.role_permissions role_permission
      join public.permissions permission on permission.id = role_permission.permission_id
      where role_permission.role_id = v_role_id
        and not exists (
          select 1
          from public.user_permission_overrides denied
          where denied.auth_user_id = v_user_id
            and denied.permission_id = role_permission.permission_id
            and denied.allowed = false
        )
      union
      select permission.code
      from public.user_permission_overrides allowed
      join public.permissions permission on permission.id = allowed.permission_id
      where allowed.auth_user_id = v_user_id
        and allowed.allowed = true
    )
    select coalesce(array_agg(permission.code order by permission.code), '{}'::text[])
    into v_permissions
    from effective_permissions permission;
  end if;

  if not (v_is_founder or 'dashboard.view' = any(v_permissions)) then
    raise exception using errcode = '42501', message = 'DASHBOARD_PERMISSION_REQUIRED';
  end if;

  v_can_employees := v_is_founder or 'employee.directory.view' = any(v_permissions);
  v_can_staff_accounts := v_is_founder
    or 'staff_account.view' = any(v_permissions)
    or 'backend_account.view' = any(v_permissions)
    or 'user.activation.generate' = any(v_permissions)
    or 'user.account.create' = any(v_permissions);
  v_can_backend_accounts := v_is_founder
    or 'backend_account.view' = any(v_permissions)
    or 'account.create' = any(v_permissions)
    or 'account.edit' = any(v_permissions);

  with
  scope_ids as materialized (
    select scope.employee_id
    from public.admin_scope_effective_employee_ids(v_user_id) scope
  ),
  scoped_employees as materialized (
    select
      employee.id,
      employee.employee_no,
      employee.full_name,
      employee.status,
      employee.hire_date,
      employee.resign_date,
      employee.country,
      employee.nationality,
      employee.employment_type,
      employee.team_id,
      employee.position_id,
      team.name as team_name,
      position.name as position_name
    from scope_ids scope
    join public.employees employee on employee.id = scope.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where nullif(public.employee_master_normalize_id(employee.employee_no), '') is not null
      and public.employee_master_normalize_id(employee.employee_no) not in ('SYSTEM', 'ADMIN')
      and public.employee_master_normalize_id(employee.employee_no) not like 'TEST%'
      and coalesce(employee.source_type, '') <> 'google_deleted'
  ),
  active_employees as materialized (
    select employee.*
    from scoped_employees employee
    where lower(btrim(coalesce(employee.status, ''))) in ('active', 'probation', '在职', '试用')
  ),
  global_alias_candidates as materialized (
    select employee.id as employee_id,
      public.employee_master_normalize_id(employee.employee_no) as employee_key
    from public.employees employee
    union
    select rekey.employee_id,
      public.employee_master_normalize_id(rekey.previous_employee_no) as employee_key
    from public.employee_identity_rekeys rekey
    union
    select rekey.employee_id,
      public.employee_master_normalize_id(rekey.official_employee_no) as employee_key
    from public.employee_identity_rekeys rekey
  ),
  global_aliases as materialized (
    select candidate.employee_key,
      min(candidate.employee_id::text)::uuid as employee_id
    from global_alias_candidates candidate
    where nullif(candidate.employee_key, '') is not null
    group by candidate.employee_key
    having count(distinct candidate.employee_id) = 1
  ),
  scope_aliases as materialized (
    select alias.employee_key, alias.employee_id
    from global_aliases alias
    join scope_ids scope on scope.employee_id = alias.employee_id
  ),
  lifecycle_base as materialized (
    select
      coalesce(
        direct_scope.employee_id,
        alias.employee_id,
        case when v_all_scope then event.employee_id end
      ) as resolved_employee_id,
      coalesce(
        direct_scope.employee_id::text,
        alias.employee_id::text,
        case when v_all_scope then event.employee_id::text end,
        'legacy:' || public.employee_master_normalize_id(event.employee_no)
      ) as identity_key,
      event.event_type,
      event.effective_date,
      event.source,
      event.source_key,
      event.created_at,
      event.id,
      coalesce(
        nullif(btrim(event.snapshot->>'入职日期 hiredate Y/M/D'), ''),
        nullif(btrim(event.snapshot->>'入职时间'), '')
      ) as snapshot_hire,
      coalesce(
        nullif(btrim(event.snapshot->>'离职日期'), ''),
        nullif(btrim(event.snapshot->>'离职时间'), '')
      ) as snapshot_resign,
      lower(coalesce(nullif(btrim(event.snapshot->>'后台账号'), ''), ''))
        as snapshot_backend,
      lower(coalesce(event.snapshot->>'auto_reconciled', '')) in
        ('true', '1', 'yes') as auto_reconciled
    from public.employee_lifecycle_events event
    left join scope_ids direct_scope on direct_scope.employee_id = event.employee_id
    left join scope_aliases alias
      on alias.employee_key = public.employee_master_normalize_id(event.employee_no)
    where event.effective_date >=
        (date_trunc('month', v_today)::date - interval '5 months')::date
      and event.effective_date <
        (date_trunc('month', v_today)::date + interval '1 month')::date
      and event.effective_date <= v_today
      and event.event_type in ('join', 'resign')
      and event.note is distinct from '__VOIDED__'
      and nullif(public.employee_master_normalize_id(event.employee_no), '') is not null
      and public.employee_master_normalize_id(event.employee_no) not in ('SYSTEM', 'ADMIN')
      and public.employee_master_normalize_id(event.employee_no) not like 'TEST%'
      and (v_all_scope or direct_scope.employee_id is not null or alias.employee_id is not null)
  ),
  canonical_resign_events as materialized (
    select event.identity_key, event.resolved_employee_id, event.effective_date
    from (
      select base.*,
        row_number() over (
          partition by base.identity_key, base.effective_date
          order by case base.source
              when 'backend' then 1
              when 'employee_master_sync' then 2
              when 'google_sheet_live' then 3
              when 'google_sheet_history' then 4
              else 9
            end,
            base.created_at desc,
            base.id desc
        ) as duplicate_rank
      from lifecycle_base base
      where base.event_type = 'resign'
        and (
          base.source in ('backend', 'employee_master_sync')
          or base.source_key like 'attendance-resignation:%'
          or (
            base.source in ('google_sheet_live', 'google_sheet_history')
            and (
              base.snapshot_resign is not null
              or base.snapshot_backend in ('辞职', '离职', 'resigned', 'resign')
              or base.auto_reconciled
            )
          )
        )
    ) event
    where event.duplicate_rank = 1
  ),
  current_hires as materialized (
    select employee.id::text as identity_key, employee.hire_date as effective_date
    from scoped_employees employee
    where employee.hire_date >=
        (date_trunc('month', v_today)::date - interval '5 months')::date
      and employee.hire_date <
        (date_trunc('month', v_today)::date + interval '1 month')::date
      and employee.hire_date <= v_today
  ),
  historical_join_ranked as materialized (
    select event.*
    from (
      select base.*,
        row_number() over (
          partition by base.identity_key, base.effective_date
          order by case base.source
              when 'backend' then 1
              when 'employee_master' then 2
              when 'google_sheet_live' then 3
              when 'google_sheet_history' then 4
              else 9
            end,
            base.created_at desc,
            base.id desc
        ) as duplicate_rank
      from lifecycle_base base
      where base.event_type = 'join'
        and not exists (
          select 1 from scoped_employees employee
          where employee.id = base.resolved_employee_id
        )
        and (
          base.source in ('backend', 'employee_master')
          or (
            base.source in ('google_sheet_live', 'google_sheet_history')
            and base.snapshot_hire is not null
          )
        )
    ) event
    where event.duplicate_rank = 1
  ),
  historical_hires as materialized (
    select event.identity_key, event.effective_date
    from historical_join_ranked event
    where not exists (
        select 1 from canonical_resign_events resignation
        where resignation.identity_key = event.identity_key
          and resignation.effective_date = event.effective_date
      )
      and not (
        event.snapshot_hire is not null
        and event.snapshot_resign is not null
        and event.snapshot_hire = event.snapshot_resign
      )
      and not (
        event.snapshot_resign is null
        and event.snapshot_backend in ('辞职', '离职', 'resigned', 'resign')
      )
  ),
  canonical_hires as materialized (
    select * from current_hires
    union all
    select * from historical_hires
  ),
  current_resign_fallback as materialized (
    select employee.id::text as identity_key,
      employee.resign_date as effective_date
    from scoped_employees employee
    where employee.resign_date >=
        (date_trunc('month', v_today)::date - interval '5 months')::date
      and employee.resign_date <
        (date_trunc('month', v_today)::date + interval '1 month')::date
      and employee.resign_date <= v_today
      and not exists (
        select 1 from canonical_resign_events resignation
        where resignation.identity_key = employee.id::text
          and resignation.effective_date = employee.resign_date
      )
  ),
  canonical_resigns as materialized (
    select event.identity_key, event.effective_date
    from canonical_resign_events event
    union all
    select * from current_resign_fallback
  ),
  movement_events as materialized (
    select event.identity_key, 'hire'::text as event_kind,
      event.effective_date
    from canonical_hires event
    union all
    select event.identity_key, 'resign'::text, event.effective_date
    from canonical_resigns event
  ),
  movement_months as materialized (
    select month_start::date,
      to_char(month_start, 'YYYY-MM') as month_key,
      extract(month from month_start)::integer as month_number
    from generate_series(
      date_trunc('month', v_today)::date - interval '5 months',
      date_trunc('month', v_today)::date,
      interval '1 month'
    ) month_start
  ),
  movement as materialized (
    select month.month_key,
      month.month_number,
      count(event.identity_key) filter (where event.event_kind = 'hire')::integer as hires,
      count(event.identity_key) filter (where event.event_kind = 'resign')::integer as resignations
    from movement_months month
    left join movement_events event
      on event.effective_date >= month.month_start
     and event.effective_date < (month.month_start + interval '1 month')::date
    group by month.month_start, month.month_key, month.month_number
    order by month.month_start
  ),
  team_distribution as materialized (
    select coalesce(nullif(btrim(employee.team_name), ''), '未设置') as name,
      count(*)::integer as count
    from active_employees employee
    group by 1
    order by count(*) desc, 1
    limit 8
  ),
  position_distribution as materialized (
    select coalesce(nullif(btrim(employee.position_name), ''), '未设置') as name,
      count(*)::integer as count
    from active_employees employee
    group by 1
    order by count(*) desc, 1
    limit 8
  ),
  type_distribution as materialized (
    select coalesce(nullif(btrim(employee.employment_type), ''), '未设置') as name,
      count(*)::integer as count
    from active_employees employee
    group by 1
    order by count(*) desc, 1
    limit 8
  ),
  country_distribution as materialized (
    select coalesce(
        nullif(btrim(employee.country), ''),
        nullif(btrim(employee.nationality), ''),
        '未设置'
      ) as name,
      count(*)::integer as count
    from active_employees employee
    group by 1
    order by count(*) desc, 1
    limit 8
  ),
  recent_hires as materialized (
    select employee.id, employee.employee_no, employee.full_name,
      employee.team_name, employee.hire_date
    from active_employees employee
    where employee.hire_date is not null
    order by employee.hire_date desc, employee.employee_no, employee.id
    limit 6
  ),
  visible_accounts as materialized (
    select access.auth_user_id, access.employee_id, access.backend_enabled,
      access.employee_portal_enabled, access.active
    from public.user_access access
    left join scope_ids scope on scope.employee_id = access.employee_id
    where v_is_founder or (access.employee_id is not null and scope.employee_id is not null)
  ),
  latest_attempt as materialized (
    select run.id, run.status, run.captured_at, run.started_at, run.finished_at,
      run.updated_count, run.inserted_count, run.rekeyed_count,
      run.archived_count, run.restored_count, run.warning_count, run.error_code
    from public.employee_master_sync_runs run
    order by run.started_at desc, run.id desc
    limit 1
  ),
  latest_success as materialized (
    select run.id, run.status, run.captured_at, run.started_at, run.finished_at
    from public.employee_master_sync_runs run
    where run.status in ('success', 'unchanged')
    order by run.finished_at desc nulls last, run.id desc
    limit 1
  ),
  source_freshness as materialized (
    select snapshot.source_key, snapshot.captured_at, snapshot.updated_at,
      snapshot.row_count, snapshot.run_id
    from public.employee_master_source_snapshots snapshot
    where snapshot.source_key in ('home_employee_roster_current', 'home_schedule_roster_current')
  )
  select jsonb_build_object(
    'ok', true,
    'schema_version', 2,
    'summary', case when v_can_employees then jsonb_build_object(
      'total', (select count(*)::integer from scoped_employees),
      'active', (select count(*)::integer from active_employees),
      'inactive', (select count(*)::integer from scoped_employees) -
        (select count(*)::integer from active_employees),
      'inactive_breakdown', jsonb_build_object(
        'resigned', (select count(*)::integer from scoped_employees employee
          where lower(btrim(coalesce(employee.status, ''))) in ('resigned', '离职')),
        'disabled', (select count(*)::integer from scoped_employees employee
          where lower(btrim(coalesce(employee.status, ''))) in ('disabled', 'inactive', '停用', '禁用')),
        'unverified', (select count(*)::integer from scoped_employees employee
          where lower(btrim(coalesce(employee.status, ''))) not in
            ('active', 'probation', '在职', '试用', 'resigned', '离职', 'disabled', 'inactive', '停用', '禁用'))
      ),
      'team_count', (select count(distinct employee.team_id)::integer
        from active_employees employee where employee.team_id is not null),
      'position_count', (select count(distinct employee.position_id)::integer
        from active_employees employee where employee.position_id is not null),
      'hires_30_days', (select count(*)::integer from canonical_hires event
        where event.effective_date >= v_today - 29),
      'resignations_30_days', (select count(*)::integer from canonical_resigns event
        where event.effective_date >= v_today - 29),
      'profile_completion', coalesce((select round(
        count(*) filter (where employee.hire_date is not null
          and nullif(btrim(coalesce(employee.country, employee.nationality, '')), '') is not null
          and nullif(btrim(coalesce(employee.employment_type, '')), '') is not null
          and nullif(btrim(coalesce(employee.team_name, '')), '') is not null
          and nullif(btrim(coalesce(employee.position_name, '')), '') is not null)::numeric
        * 100 / nullif(count(*), 0)
      )::integer from active_employees employee), 0)
    ) else null end,
    'movement', case when v_can_employees then coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', movement.month_key,
        'label', movement.month_number::text || '月',
        'hires', movement.hires,
        'resignations', movement.resignations
      ) order by movement.month_key)
      from movement
    ), '[]'::jsonb) else '[]'::jsonb end,
    'movement_quality', case when v_can_employees then jsonb_build_object(
      'mode', 'current_hire_plus_canonical_resignation',
      'bounded_lifecycle_rows', (select count(*)::integer from lifecycle_base),
      'current_master_hires', (select count(*)::integer from current_hires),
      'historical_hires', (select count(*)::integer from historical_hires),
      'canonical_resigns', (select count(*)::integer from canonical_resigns),
      'ambiguous_hires_excluded', (select count(*)::integer from historical_join_ranked) -
        (select count(*)::integer from historical_hires),
      'resign_rows_not_counted_including_duplicates', (select count(*)::integer
        from lifecycle_base event where event.event_type = 'resign') -
        (select count(*)::integer from canonical_resign_events),
      'counts_raw_rows', false
    ) else null end,
    'distributions', case when v_can_employees then jsonb_build_object(
      'teams', coalesce((select jsonb_agg(to_jsonb(item) order by item.count desc, item.name)
        from team_distribution item), '[]'::jsonb),
      'positions', coalesce((select jsonb_agg(to_jsonb(item) order by item.count desc, item.name)
        from position_distribution item), '[]'::jsonb),
      'types', coalesce((select jsonb_agg(to_jsonb(item) order by item.count desc, item.name)
        from type_distribution item), '[]'::jsonb),
      'countries', coalesce((select jsonb_agg(to_jsonb(item) order by item.count desc, item.name)
        from country_distribution item), '[]'::jsonb)
    ) else jsonb_build_object('teams', '[]'::jsonb, 'positions', '[]'::jsonb,
      'types', '[]'::jsonb, 'countries', '[]'::jsonb) end,
    'recent_hires', case when v_can_employees then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'employee_no', employee.employee_no,
        'full_name', employee.full_name,
        'team_name', coalesce(nullif(btrim(employee.team_name), ''), '未匹配团队'),
        'hire_date', employee.hire_date
      ) order by employee.hire_date desc, employee.employee_no, employee.id)
      from recent_hires employee
    ), '[]'::jsonb) else '[]'::jsonb end,
    'account_summary', case when v_can_staff_accounts or v_can_backend_accounts then jsonb_build_object(
      'can_view_staff_accounts', case when v_can_staff_accounts then 1 else 0 end,
      'active_staff_scope', case when v_can_staff_accounts
        then (select count(*)::integer from active_employees) else 0 end,
      'staff_accounts', case when v_can_staff_accounts then (
        select count(distinct access.employee_id)::integer
        from visible_accounts access
        join active_employees employee on employee.id = access.employee_id
        where access.employee_portal_enabled = true and access.active is distinct from false
      ) else 0 end,
      'pending_staff_accounts', case when v_can_staff_accounts then (
        select count(*)::integer
        from active_employees employee
        where not exists (
          select 1 from visible_accounts access
          where access.employee_id = employee.id
            and access.employee_portal_enabled = true
            and access.active is distinct from false
        )
      ) else 0 end,
      'backend_accounts', case when v_can_backend_accounts then (
        select count(*)::integer from visible_accounts access
        where access.backend_enabled = true and access.active is distinct from false
      ) else 0 end
    ) else null end,
    'dashboard_access', jsonb_build_object(
      'employee_metrics', v_can_employees,
      'staff_account_metrics', v_can_staff_accounts,
      'backend_account_metrics', v_can_backend_accounts
    ),
    'freshness', jsonb_build_object(
      'generated_at', statement_timestamp(),
      'last_attempt', (select to_jsonb(attempt) from latest_attempt attempt),
      'last_success', (select to_jsonb(success) from latest_success success),
      'home', (select to_jsonb(source) from source_freshness source
        where source.source_key = 'home_employee_roster_current'),
      'schedule', (select to_jsonb(source) from source_freshness source
        where source.source_key = 'home_schedule_roster_current'),
      'stale', coalesce((select source.captured_at < statement_timestamp() - interval '15 minutes'
        from source_freshness source
        where source.source_key = 'home_employee_roster_current'), true)
    )
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.admin_home_dashboard()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_home_dashboard()
  to authenticated, service_role;

comment on function public.admin_home_dashboard() is
  'Session-, permission- and scope-checked bounded management-home aggregate. Movement uses current employee hire dates plus canonical historical resignations, excludes legacy same-day join projections and reactivation reversals, and returns no raw employee directory.';

create or replace function public.admin_online_presence_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  if not exists (
    select 1
    from public.user_access access
    join public.roles role on role.id = access.role_id
    where access.auth_user_id = v_user_id
      and access.active = true
      and access.backend_enabled = true
      and role.active = true
  ) then
    return false;
  end if;

  return public.has_permission('backend_account.view')
    or public.has_permission('staff_account.view')
    or public.has_permission('employee.directory.view');
end;
$function$;

revoke all on function public.admin_online_presence_allowed()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_online_presence_allowed()
  to authenticated, service_role;

comment on function public.admin_online_presence_allowed() is
  'Lightweight user-JWT guard for online presence. Revalidates the admin lease, release epoch, IP attestation, MFA, active role and one of the presence-view permissions before service-role reads.';

notify pgrst, 'reload schema';
