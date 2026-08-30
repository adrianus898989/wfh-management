begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regprocedure('scope_private.current_employee_scope_directory()') is null then
    raise exception 'current_scope_directory_missing';
  end if;
  if to_regprocedure('scope_private.recovery_backend_action_allowed(uuid,uuid,text)') is null then
    raise exception 'recovery_backend_action_allowed_missing';
  end if;
  if to_regprocedure('public.admin_recovery_update_backend_account(uuid,uuid,uuid,uuid,text)') is null then
    raise exception 'recovery_backend_account_editor_missing';
  end if;
  if to_regprocedure('public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])') is null then
    raise exception 'atomic_account_scope_writer_missing';
  end if;
end
$guard$;

-- This reader is intentionally separate from the Google-sheet online-training
-- relationship columns. Account-management candidates come from the strict,
-- current roster organization directory used by every backend scope check.
create or replace function public.admin_recovery_account_scope_directory(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_team_ids uuid[] default '{}'::uuid[],
  p_employee_query text default '',
  p_include_selection boolean default true
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $$
declare
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_target_scope text;
  v_query text := lower(btrim(coalesce(p_employee_query, '')));
  v_requested_team_ids uuid[] := array(
    select distinct selected.value
    from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null
    order by selected.value
  );
  v_current_team_ids uuid[] := '{}'::uuid[];
  v_current_position_ids uuid[] := '{}'::uuid[];
  v_current_employee_ids uuid[] := '{}'::uuid[];
  v_effective_team_ids uuid[] := '{}'::uuid[];
  v_has_account_edit boolean := false;
  v_has_scope_manage boolean := false;
  v_result jsonb;
begin
  if p_actor_user_id is null or p_target_user_id is null then
    raise exception using errcode = '22023', message = 'invalid_account_id';
  end if;
  if length(v_query) > 64 then
    raise exception using errcode = '22023', message = 'search_query_too_long';
  end if;
  if cardinality(v_requested_team_ids) > 100 then
    raise exception using errcode = '22023', message = 'scope_team_limit_exceeded';
  end if;

  select actor.role_id, role.code, actor.data_scope
  into v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles role on role.id = actor.role_id and role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  select target.data_scope
  into v_target_scope
  from public.user_access target
  join public.roles role on role.id = target.role_id and role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
    and role.code <> 'founder'
  limit 1;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;

  if v_actor_role_code = 'founder' then
    v_has_account_edit := true;
    v_has_scope_manage := true;
  else
    select
      exists (
        select 1
        from (
          select role_permission.permission_id
          from public.role_permissions role_permission
          where role_permission.role_id = v_actor_role_id
          union
          select override.permission_id
          from public.user_permission_overrides override
          where override.auth_user_id = p_actor_user_id and override.allowed = true
          except
          select override.permission_id
          from public.user_permission_overrides override
          where override.auth_user_id = p_actor_user_id and override.allowed = false
        ) effective
        join public.permissions permission on permission.id = effective.permission_id
        where permission.code in ('*', 'account.edit')
      ),
      exists (
        select 1
        from (
          select role_permission.permission_id
          from public.role_permissions role_permission
          where role_permission.role_id = v_actor_role_id
          union
          select override.permission_id
          from public.user_permission_overrides override
          where override.auth_user_id = p_actor_user_id and override.allowed = true
          except
          select override.permission_id
          from public.user_permission_overrides override
          where override.auth_user_id = p_actor_user_id and override.allowed = false
        ) effective
        join public.permissions permission on permission.id = effective.permission_id
        where permission.code in ('*', 'scope.manage')
      )
    into v_has_account_edit, v_has_scope_manage;
  end if;

  if not v_has_account_edit or not v_has_scope_manage
     or (v_actor_role_code <> 'founder' and v_actor_scope is distinct from 'all')
     or not scope_private.recovery_backend_action_allowed(
       p_actor_user_id, p_target_user_id, 'account.edit'
     ) then
    raise exception using errcode = '42501', message = 'permission_or_scope_denied';
  end if;

  select
    coalesce(array_agg(filter.team_id order by filter.team_id), '{}'::uuid[])
  into v_current_team_ids
  from public.user_scope_team_filters filter
  where filter.auth_user_id = p_target_user_id;
  select
    coalesce(array_agg(filter.position_id order by filter.position_id), '{}'::uuid[])
  into v_current_position_ids
  from public.user_scope_position_filters filter
  where filter.auth_user_id = p_target_user_id;
  select
    coalesce(array_agg(filter.employee_id order by filter.employee_id), '{}'::uuid[])
  into v_current_employee_ids
  from public.user_scope_employee_filters filter
  where filter.auth_user_id = p_target_user_id;

  if cardinality(v_current_team_ids) > 100
     or cardinality(v_current_position_ids) > 200
     or cardinality(v_current_employee_ids) > 100 then
    raise exception using errcode = '22023', message = 'existing_scope_limit_exceeded';
  end if;

  v_effective_team_ids := case
    when coalesce(p_include_selection, true) and v_target_scope = 'assigned_teams'
      then v_current_team_ids
    else v_requested_team_ids
  end;

  with directory as materialized (
    select
      current.employee_id,
      current.employee_no,
      current.current_team_id team_id,
      current.current_position_id position_id,
      employee.full_name,
      team.name team_name,
      position.name position_name
    from scope_private.current_employee_scope_directory() current
    join public.employees employee
      on employee.id = current.employee_id
     and employee.status = 'active'
    join public.teams team
      on team.id = current.current_team_id
     and team.status = 'active'
    join public.positions position
      on position.id = current.current_position_id
     and position.status = 'active'
  ), team_rows as materialized (
    select directory.team_id id, min(directory.team_name) name, count(*) member_count
    from directory
    group by directory.team_id
    order by min(directory.team_name), directory.team_id
    limit 100
  ), position_rows as materialized (
    select directory.position_id id, min(directory.position_name) name, count(*) member_count,
      array_agg(distinct directory.team_id order by directory.team_id) team_ids
    from directory
    where directory.team_id = any(v_effective_team_ids)
    group by directory.position_id
    order by min(directory.position_name), directory.position_id
    limit 200
  ), employee_rows as materialized (
    select directory.*
    from directory
    where directory.team_id = any(v_effective_team_ids)
      and (
        v_query = ''
        or lower(coalesce(directory.employee_no, '')) like '%' || v_query || '%'
        or lower(coalesce(directory.full_name, '')) like '%' || v_query || '%'
      )
    order by
      case when directory.employee_id = any(v_current_employee_ids) then 0 else 1 end,
      case when lower(coalesce(directory.employee_no, '')) = v_query then 0 else 1 end,
      directory.employee_no,
      directory.employee_id
    limit 100
  )
  select jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.id,
        'name', row.name,
        'member_count', row.member_count
      ) order by row.name, row.id)
      from team_rows row
    ), '[]'::jsonb),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.id,
        'name', row.name,
        'member_count', row.member_count,
        'team_ids', row.team_ids
      ) order by row.name, row.id)
      from position_rows row
    ), '[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.employee_id,
        'employee_no', row.employee_no,
        'full_name', row.full_name,
        'current_team_id', row.team_id,
        'current_position_id', row.position_id,
        'teams', jsonb_build_object('id', row.team_id, 'name', row.team_name),
        'positions', jsonb_build_object('id', row.position_id, 'name', row.position_name)
      ) order by row.employee_no, row.employee_id)
      from employee_rows row
    ), '[]'::jsonb),
    'selection', jsonb_build_object(
      'team_ids', case when coalesce(p_include_selection, true) then v_current_team_ids else '{}'::uuid[] end,
      'position_ids', case when coalesce(p_include_selection, true) then v_current_position_ids else '{}'::uuid[] end,
      'employee_ids', case when coalesce(p_include_selection, true) then v_current_employee_ids else '{}'::uuid[] end,
      'stale_team_ids', case when coalesce(p_include_selection, true) then array(
        select selected.team_id
        from unnest(v_current_team_ids) selected(team_id)
        where not exists (select 1 from directory where directory.team_id = selected.team_id)
        order by selected.team_id
      ) else '{}'::uuid[] end
    ),
    'limits', jsonb_build_object('teams', 100, 'positions', 200, 'employees', 100),
    'truncated', jsonb_build_object(
      'teams', (select count(distinct directory.team_id) from directory) > 100,
      'positions', (select count(distinct directory.position_id) from directory where directory.team_id = any(v_effective_team_ids)) > 200,
      'employees', (select count(*) from directory where directory.team_id = any(v_effective_team_ids) and (
        v_query = ''
        or lower(coalesce(directory.employee_no, '')) like '%' || v_query || '%'
        or lower(coalesce(directory.full_name, '')) like '%' || v_query || '%'
      )) > 100
    )
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_recovery_account_scope_directory(
  uuid, uuid, uuid[], text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_account_scope_directory(
  uuid, uuid, uuid[], text, boolean
) to service_role;

comment on function public.admin_recovery_account_scope_directory(
  uuid, uuid, uuid[], text, boolean
) is
  'Service-only bounded recovery account scope editor directory. Uses strict current-roster organization teams, positions and employees; requires account.edit plus scope.manage and never reads Google online-training relationship columns.';

create or replace function public.admin_recovery_update_backend_account_v2(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_employee_id uuid,
  p_role_id uuid,
  p_data_scope text,
  p_team_ids uuid[] default '{}'::uuid[],
  p_position_ids uuid[] default '{}'::uuid[],
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '4500ms'
set lock_timeout = '1500ms'
as $$
declare
  v_actor_employee_id uuid;
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_scope text;
  v_current_scope text;
  v_team_ids uuid[] := array(
    select distinct selected.value from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null order by selected.value
  );
  v_position_ids uuid[] := array(
    select distinct selected.value from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null order by selected.value
  );
  v_employee_ids uuid[] := array(
    select distinct selected.value from unnest(coalesce(p_employee_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null order by selected.value
  );
  v_current_team_ids uuid[] := '{}'::uuid[];
  v_current_position_ids uuid[] := '{}'::uuid[];
  v_current_employee_ids uuid[] := '{}'::uuid[];
  v_has_scope_manage boolean := false;
  v_base_saved jsonb;
  v_scope_saved jsonb;
begin
  if p_data_scope is distinct from 'assigned_teams' then
    if cardinality(v_team_ids) > 0 or cardinality(v_position_ids) > 0
       or cardinality(v_employee_ids) > 0 then
      raise exception using errcode = '22023', message = 'filters_require_assigned_scope';
    end if;
    return public.admin_recovery_update_backend_account(
      p_actor_user_id, p_target_user_id, p_employee_id, p_role_id, p_data_scope
    );
  end if;

  if cardinality(v_team_ids) = 0 then
    raise exception using errcode = '22023', message = 'assigned_scope_requires_team';
  end if;
  if cardinality(v_team_ids) > 100 or cardinality(v_position_ids) > 200
     or cardinality(v_employee_ids) > 100 then
    raise exception using errcode = '22023', message = 'assigned_scope_limit_exceeded';
  end if;

  -- Match the legacy editor's global lock order before reading current scope
  -- or filters. Re-locking these rows inside the delegated legacy call is
  -- transaction-local and prevents stale-comparison/lost-update races.
  perform 1
  from public.user_access access
  where access.auth_user_id in (p_actor_user_id, p_target_user_id)
  order by access.auth_user_id
  for update;

  select actor.employee_id, actor.role_id, role.code, actor.data_scope
  into v_actor_employee_id, v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles role on role.id = actor.role_id and role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  select target.data_scope
  into v_current_scope
  from public.user_access target
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;

  if v_actor_role_code = 'founder' then
    v_has_scope_manage := true;
  else
    select exists (
      select 1
      from (
        select role_permission.permission_id
        from public.role_permissions role_permission
        where role_permission.role_id = v_actor_role_id
        union
        select override.permission_id
        from public.user_permission_overrides override
        where override.auth_user_id = p_actor_user_id and override.allowed = true
        except
        select override.permission_id
        from public.user_permission_overrides override
        where override.auth_user_id = p_actor_user_id and override.allowed = false
      ) effective
      join public.permissions permission on permission.id = effective.permission_id
      where permission.code in ('*', 'scope.manage')
    ) into v_has_scope_manage;
  end if;
  if not v_has_scope_manage
     or (v_actor_role_code <> 'founder' and v_actor_scope is distinct from 'all') then
    raise exception using errcode = '42501', message = 'scope_manage_required';
  end if;

  if exists (
    select 1 from unnest(v_team_ids) selected(team_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
      where directory.current_team_id = selected.team_id
    )
  ) then
    raise exception using errcode = '22023', message = 'team_filter_not_in_current_roster';
  end if;
  if exists (
    select 1 from unnest(v_position_ids) selected(position_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
      where directory.current_position_id = selected.position_id
        and directory.current_team_id = any(v_team_ids)
    )
  ) then
    raise exception using errcode = '22023', message = 'position_filter_not_in_selected_current_team';
  end if;
  if exists (
    select 1 from unnest(v_employee_ids) selected(employee_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
      where directory.employee_id = selected.employee_id
        and directory.current_team_id = any(v_team_ids)
    )
  ) then
    raise exception using errcode = '22023', message = 'employee_filter_not_in_selected_current_team';
  end if;

  if v_current_scope = 'assigned_teams' then
    select coalesce(array_agg(filter.team_id order by filter.team_id), '{}'::uuid[])
    into v_current_team_ids
    from public.user_scope_team_filters filter
    where filter.auth_user_id = p_target_user_id;
    select coalesce(array_agg(filter.position_id order by filter.position_id), '{}'::uuid[])
    into v_current_position_ids
    from public.user_scope_position_filters filter
    where filter.auth_user_id = p_target_user_id;
    select coalesce(array_agg(filter.employee_id order by filter.employee_id), '{}'::uuid[])
    into v_current_employee_ids
    from public.user_scope_employee_filters filter
    where filter.auth_user_id = p_target_user_id;
  end if;

  if v_current_scope = 'assigned_teams'
     and v_current_team_ids = v_team_ids
     and v_current_position_ids = v_position_ids
     and v_current_employee_ids = v_employee_ids then
    return public.admin_recovery_update_backend_account(
      p_actor_user_id, p_target_user_id, p_employee_id, p_role_id, p_data_scope
    );
  end if;

  -- The legacy atomic editor remains the single role-delegation authority.
  -- Calling it inside this function is still one database transaction: any
  -- later boundary or audit failure rolls its role update back as well.
  v_base_saved := public.admin_recovery_update_backend_account(
    p_actor_user_id, p_target_user_id, p_employee_id, p_role_id, v_current_scope
  );
  v_scope_saved := public.admin_save_account_access_scope(
    p_target_user_id,
    p_employee_id,
    p_role_id,
    'assigned_teams',
    v_team_ids,
    v_position_ids,
    v_employee_ids
  );

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'backend_account_scope_update',
    p_target_user_id::text,
    jsonb_build_object(
      'data_scope', v_current_scope,
      'team_ids', v_current_team_ids,
      'position_ids', v_current_position_ids,
      'employee_ids', v_current_employee_ids
    ),
    jsonb_build_object(
      'data_scope', 'assigned_teams',
      'team_ids', v_team_ids,
      'position_ids', v_position_ids,
      'employee_ids', v_employee_ids,
      'session_revoked', true,
      'recovery_mode', true
    ),
    format(
      '稳定恢复模式更新指定范围 teams=%s positions=%s employees=%s',
      cardinality(v_team_ids), cardinality(v_position_ids), cardinality(v_employee_ids)
    )
  );

  return coalesce(v_base_saved, '{}'::jsonb)
    || coalesce(v_scope_saved, '{}'::jsonb)
    || jsonb_build_object(
      'data_scope', 'assigned_teams',
      'team_ids', v_team_ids,
      'position_ids', v_position_ids,
      'employee_ids', v_employee_ids,
      'session_revoked', true
    );
end;
$$;

revoke all on function public.admin_recovery_update_backend_account_v2(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_update_backend_account_v2(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) to service_role;

comment on function public.admin_recovery_update_backend_account_v2(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) is
  'Service-only recovery backend editor with bounded assigned-team filters. Reuses the legacy atomic role/delegation authority, validates teams/positions/employees against the strict current roster, atomically materializes the exact scope, audits and revokes the target session.';

notify pgrst, 'reload schema';

commit;
