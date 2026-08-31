begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regprocedure('scope_private.current_employee_scope_directory()') is null then
    raise exception 'current_scope_directory_missing';
  end if;
  if to_regprocedure('public.admin_recovery_finalize_backend_account(uuid,uuid,uuid,text,text,boolean,text,uuid)') is null then
    raise exception 'recovery_account_finalizer_missing';
  end if;
  if to_regprocedure('public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])') is null then
    raise exception 'atomic_account_scope_writer_missing';
  end if;
end
$guard$;

-- New accounts do not yet have an auth_user_id, so they need a separate
-- service-only reader. It deliberately uses the same current-roster directory
-- and limits as the existing recovery edit selector.
create or replace function public.admin_recovery_new_backend_scope_directory(
  p_actor_user_id uuid,
  p_team_ids uuid[] default '{}'::uuid[],
  p_employee_query text default ''
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
  v_query text := lower(btrim(coalesce(p_employee_query, '')));
  v_requested_team_ids uuid[] := array(
    select distinct selected.value
    from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null
    order by selected.value
  );
  v_has_account_create boolean := false;
  v_has_scope_manage boolean := false;
  v_result jsonb;
begin
  if p_actor_user_id is null then
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

  if v_actor_role_code = 'founder' then
    v_has_account_create := true;
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
        where permission.code in ('*', 'account.create')
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
    into v_has_account_create, v_has_scope_manage;
  end if;

  if not v_has_account_create or not v_has_scope_manage
     or (v_actor_role_code <> 'founder' and v_actor_scope is distinct from 'all') then
    raise exception using errcode = '42501', message = 'permission_or_scope_denied';
  end if;

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
      on employee.id = current.employee_id and employee.status = 'active'
    join public.teams team
      on team.id = current.current_team_id and team.status = 'active'
    join public.positions position
      on position.id = current.current_position_id and position.status = 'active'
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
    where directory.team_id = any(v_requested_team_ids)
    group by directory.position_id
    order by min(directory.position_name), directory.position_id
    limit 200
  ), employee_rows as materialized (
    select directory.*
    from directory
    where directory.team_id = any(v_requested_team_ids)
      and (
        v_query = ''
        or lower(coalesce(directory.employee_no, '')) like '%' || v_query || '%'
        or lower(coalesce(directory.full_name, '')) like '%' || v_query || '%'
      )
    order by
      case when lower(coalesce(directory.employee_no, '')) = v_query then 0 else 1 end,
      directory.employee_no,
      directory.employee_id
    limit 100
  )
  select jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', row.id, 'name', row.name, 'member_count', row.member_count) order by row.name, row.id)
      from team_rows row
    ), '[]'::jsonb),
    'positions', coalesce((
      select jsonb_agg(jsonb_build_object('id', row.id, 'name', row.name, 'member_count', row.member_count, 'team_ids', row.team_ids) order by row.name, row.id)
      from position_rows row
    ), '[]'::jsonb),
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row.employee_id, 'employee_no', row.employee_no, 'full_name', row.full_name,
        'current_team_id', row.team_id, 'current_position_id', row.position_id,
        'teams', jsonb_build_object('id', row.team_id, 'name', row.team_name),
        'positions', jsonb_build_object('id', row.position_id, 'name', row.position_name)
      ) order by row.employee_no, row.employee_id)
      from employee_rows row
    ), '[]'::jsonb),
    'selection', jsonb_build_object('team_ids', '{}'::uuid[], 'position_ids', '{}'::uuid[], 'employee_ids', '{}'::uuid[], 'stale_team_ids', '{}'::uuid[]),
    'limits', jsonb_build_object('teams', 100, 'positions', 200, 'employees', 100),
    'truncated', jsonb_build_object(
      'teams', (select count(distinct directory.team_id) from directory) > 100,
      'positions', (select count(distinct directory.position_id) from directory where directory.team_id = any(v_requested_team_ids)) > 200,
      'employees', (select count(*) from directory where directory.team_id = any(v_requested_team_ids) and (
        v_query = '' or lower(coalesce(directory.employee_no, '')) like '%' || v_query || '%'
        or lower(coalesce(directory.full_name, '')) like '%' || v_query || '%'
      )) > 100
    )
  ) into v_result;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.admin_recovery_new_backend_scope_directory(uuid, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_new_backend_scope_directory(uuid, uuid[], text)
  to service_role;

-- Clone the proven recovery finalizer rather than creating a second, weaker
-- authorization path. The added arguments are bound before Auth is provisioned
-- and are materialized in the same DB transaction as access and audit rows.
do $patch_recovery_create_assigned_scope$
declare
  v_source text;
  v_patched text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.admin_recovery_finalize_backend_account(uuid,uuid,uuid,text,text,boolean,text,uuid)'::regprocedure
  ) into v_source;

  if to_regprocedure('public.admin_recovery_finalize_backend_account_v2(uuid,uuid,uuid,text,text,boolean,text,uuid,uuid[],uuid[],uuid[])') is not null then
    return;
  end if;

  v_patched := pg_catalog.replace(
    v_source,
    $needle$FUNCTION public.admin_recovery_finalize_backend_account(p_auth_user_id uuid, p_employee_id uuid, p_role_id uuid, p_login_username text, p_login_email text, p_otp_required boolean, p_data_scope text, p_actor_user_id uuid)$needle$,
    $replacement$FUNCTION public.admin_recovery_finalize_backend_account_v2(p_auth_user_id uuid, p_employee_id uuid, p_role_id uuid, p_login_username text, p_login_email text, p_otp_required boolean, p_data_scope text, p_actor_user_id uuid, p_team_ids uuid[], p_position_ids uuid[], p_employee_ids uuid[])$replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_signature_shape_changed'; end if;

  v_source := v_patched;
  v_patched := pg_catalog.replace(
    v_source,
    $needle$  v_role_code text;
begin$needle$,
    $replacement$  v_role_code text;
  v_team_ids uuid[] := array(select distinct selected.value from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value) where selected.value is not null order by selected.value);
  v_position_ids uuid[] := array(select distinct selected.value from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(value) where selected.value is not null order by selected.value);
  v_employee_ids uuid[] := array(select distinct selected.value from unnest(coalesce(p_employee_ids, '{}'::uuid[])) selected(value) where selected.value is not null order by selected.value);
  v_has_scope_manage boolean := false;
begin$replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_declaration_shape_changed'; end if;

  v_source := v_patched;
  v_patched := pg_catalog.replace(
    v_source,
    $needle$if p_data_scope not in ('all', 'self', 'own_team') then$needle$,
    $replacement$if p_data_scope not in ('all', 'self', 'own_team', 'assigned_teams') then$replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_scope_shape_changed'; end if;

  v_source := v_patched;
  v_patched := pg_catalog.replace(
    v_source,
    $needle$if v_actor_role_code <> 'founder' and p_employee_id is null then$needle$,
    $replacement$if v_actor_role_code <> 'founder' and p_employee_id is null and p_data_scope <> 'assigned_teams' then$replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_employee_shape_changed'; end if;

  v_source := v_patched;
  v_patched := pg_catalog.replace(
    v_source,
    $needle$  if p_data_scope = 'own_team'
     and v_actor_role_code <> 'founder'
     and v_actor_scope <> 'all' then
    raise exception using errcode = '42501', message = 'own_team_not_delegable';
  end if;

  insert into public.user_access ($needle$,
    $replacement$  if p_data_scope = 'own_team'
     and v_actor_role_code <> 'founder'
     and v_actor_scope <> 'all' then
    raise exception using errcode = '42501', message = 'own_team_not_delegable';
  end if;
  if p_data_scope = 'assigned_teams' then
    if cardinality(v_team_ids) = 0 then
      raise exception using errcode = '22023', message = 'assigned_scope_requires_team';
    end if;
    if cardinality(v_team_ids) > 100 or cardinality(v_position_ids) > 200 or cardinality(v_employee_ids) > 100 then
      raise exception using errcode = '22023', message = 'assigned_scope_limit_exceeded';
    end if;
    if v_actor_role_code <> 'founder' then
      if v_actor_scope is distinct from 'all' then
        raise exception using errcode = '42501', message = 'recovery_scope_not_delegable';
      end if;
      select exists (
        select 1 from unnest(v_actor_permission_ids) item(permission_id)
        join public.permissions permission on permission.id = item.permission_id
        where permission.code in ('*', 'scope.manage')
      ) into v_has_scope_manage;
      if not v_actor_has_wildcard and not v_has_scope_manage then
        raise exception using errcode = '42501', message = 'scope_manage_required';
      end if;
    end if;
    if exists (
      select 1 from unnest(v_team_ids) selected(team_id)
      where not exists (
        select 1 from scope_private.current_employee_scope_directory() directory
        join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
        where directory.current_team_id = selected.team_id
      )
    ) then raise exception using errcode = '22023', message = 'team_filter_not_in_current_roster'; end if;
    if exists (
      select 1 from unnest(v_position_ids) selected(position_id)
      where not exists (
        select 1 from scope_private.current_employee_scope_directory() directory
        join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
        where directory.current_position_id = selected.position_id and directory.current_team_id = any(v_team_ids)
      )
    ) then raise exception using errcode = '22023', message = 'position_filter_not_in_selected_current_team'; end if;
    if exists (
      select 1 from unnest(v_employee_ids) selected(employee_id)
      where not exists (
        select 1 from scope_private.current_employee_scope_directory() directory
        join public.employees employee on employee.id = directory.employee_id and employee.status = 'active'
        where directory.employee_id = selected.employee_id and directory.current_team_id = any(v_team_ids)
      )
    ) then raise exception using errcode = '22023', message = 'employee_filter_not_in_selected_current_team'; end if;
  elsif cardinality(v_team_ids) > 0 or cardinality(v_position_ids) > 0 or cardinality(v_employee_ids) > 0 then
    raise exception using errcode = '22023', message = 'filters_require_assigned_scope';
  end if;

  insert into public.user_access ($replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_boundary_shape_changed'; end if;

  v_source := v_patched;
  v_patched := pg_catalog.replace(
    v_source,
    $needle$    p_data_scope,
    '{}'::uuid[],
    '{}'::uuid[],
    '{}'::uuid[]$needle$,
    $replacement$    p_data_scope,
    case when p_data_scope = 'assigned_teams' then v_team_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then v_position_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then v_employee_ids else '{}'::uuid[] end$replacement$
  );
  if v_patched = v_source then raise exception 'recovery_create_v2_scope_writer_shape_changed'; end if;

  execute v_patched;
end;
$patch_recovery_create_assigned_scope$;

revoke all on function public.admin_recovery_finalize_backend_account_v2(
  uuid, uuid, uuid, text, text, boolean, text, uuid, uuid[], uuid[], uuid[]
) from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_backend_account_v2(
  uuid, uuid, uuid, text, text, boolean, text, uuid, uuid[], uuid[], uuid[]
) to service_role;

comment on function public.admin_recovery_new_backend_scope_directory(uuid, uuid[], text) is
  'Service-only bounded current-roster directory for new recovery backend accounts with assigned-team scope.';
comment on function public.admin_recovery_finalize_backend_account_v2(uuid, uuid, uuid, text, text, boolean, text, uuid, uuid[], uuid[], uuid[]) is
  'Service-only atomic recovery backend finalizer with strict assigned-team filters, role delegation, scope materialization and audit.';

notify pgrst, 'reload schema';

commit;
