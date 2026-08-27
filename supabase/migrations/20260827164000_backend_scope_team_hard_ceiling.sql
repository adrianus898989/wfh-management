begin;

-- A manually assigned account always has a selected current team as its hard
-- authorization ceiling. Positions narrow those teams. Explicit employees can
-- supplement a position filter, but only while their current roster team is
-- still selected; they are never a team-external exception.
comment on table public.user_scope_employee_filters is
  'Service-only selected employee supplements for assigned backend scopes. Every selected employee must belong to a selected current-roster team; this table never grants a team-external exception.';
comment on table public.user_scope_employees is
  'Materialized effective employee allow-list for own-team and assigned backend scopes. Assigned scope is selected current team AND (optional position OR selected in-team employee supplement). Do not write selections here.';

create or replace function scope_private.rebuild_account_employee_scope(
  p_auth_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_linked_employee_id uuid;
  v_active boolean;
  v_backend_enabled boolean;
  v_access_found boolean := false;
  v_inserted integer := 0;
  v_has_team boolean;
  v_has_position boolean;
begin
  if p_auth_user_id is null then return 0; end if;

  select access.data_scope, access.employee_id, access.active, access.backend_enabled
  into v_scope, v_linked_employee_id, v_active, v_backend_enabled
  from public.user_access access
  where access.auth_user_id = p_auth_user_id
  order by access.updated_at desc
  limit 1
  for update;
  v_access_found := found;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  delete from public.user_scope_teams legacy
  where legacy.auth_user_id = p_auth_user_id;
  delete from public.user_scope_employees effective
  where effective.auth_user_id = p_auth_user_id;

  if not v_access_found or not coalesce(v_active, false)
     or not coalesce(v_backend_enabled, false) then
    return 0;
  end if;

  if v_scope = 'own_team' then
    insert into public.user_scope_employees (auth_user_id, employee_id)
    select p_auth_user_id, target.employee_id
    from scope_private.current_employee_scope_directory() caller
    join scope_private.current_employee_scope_directory() target
      on target.current_team_id = caller.current_team_id
    where caller.employee_id = v_linked_employee_id
      and caller.current_team_id is not null
    on conflict (auth_user_id, employee_id) do nothing;
    get diagnostics v_inserted = row_count;
    return v_inserted;
  end if;

  if v_scope is distinct from 'assigned_teams' then return 0; end if;

  select exists (
      select 1 from public.user_scope_team_filters filter
      where filter.auth_user_id = p_auth_user_id
    ), exists (
      select 1 from public.user_scope_position_filters filter
      where filter.auth_user_id = p_auth_user_id
    )
  into v_has_team, v_has_position;

  -- An assigned scope without a current selected team always fails closed.
  if not v_has_team then return 0; end if;

  insert into public.user_scope_employees (auth_user_id, employee_id)
  select p_auth_user_id, directory.employee_id
  from scope_private.current_employee_scope_directory() directory
  where exists (
      select 1
      from public.user_scope_team_filters team_filter
      where team_filter.auth_user_id = p_auth_user_id
        and team_filter.team_id = directory.current_team_id
    )
    and (
      not v_has_position
      or exists (
        select 1
        from public.user_scope_position_filters position_filter
        where position_filter.auth_user_id = p_auth_user_id
          and position_filter.position_id = directory.current_position_id
      )
      or exists (
        select 1
        from public.user_scope_employee_filters employee_filter
        where employee_filter.auth_user_id = p_auth_user_id
          and employee_filter.employee_id = directory.employee_id
      )
    )
  on conflict (auth_user_id, employee_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function scope_private.rebuild_account_employee_scope(uuid)
  from public, anon, authenticated;

create or replace function public.admin_save_account_scope_filters(
  p_auth_user_id uuid,
  p_team_ids uuid[] default '{}'::uuid[],
  p_position_ids uuid[] default '{}'::uuid[],
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data_scope text;
  v_team_ids uuid[] := array(
    select distinct value
    from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
    where value is not null
  );
  v_position_ids uuid[] := array(
    select distinct value
    from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(value)
    where value is not null
  );
  v_employee_ids uuid[] := array(
    select distinct value
    from unnest(coalesce(p_employee_ids, '{}'::uuid[])) selected(value)
    where value is not null
  );
  v_effective_count integer;
begin
  if p_auth_user_id is null then
    raise exception 'account_not_found';
  end if;

  select access.data_scope
  into v_data_scope
  from public.user_access access
  where access.auth_user_id = p_auth_user_id
  for update;
  if not found then raise exception 'account_not_found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  if v_data_scope = 'assigned_teams' then
    if cardinality(v_team_ids) = 0 then
      if cardinality(v_position_ids) > 0 then
        raise exception 'position_filter_requires_team';
      end if;
      raise exception 'assigned_scope_requires_team';
    end if;
  elsif cardinality(v_team_ids) > 0
     or cardinality(v_position_ids) > 0
     or cardinality(v_employee_ids) > 0 then
    raise exception 'filters_require_assigned_scope';
  end if;

  if exists (
    select 1
    from unnest(v_team_ids) selected(team_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      where directory.current_team_id = selected.team_id
    )
  ) then
    raise exception 'team_filter_not_in_current_roster';
  end if;

  if exists (
    select 1
    from unnest(v_position_ids) selected(position_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      where directory.current_position_id = selected.position_id
        and directory.current_team_id = any(v_team_ids)
    )
  ) then
    raise exception 'position_filter_not_in_selected_current_team';
  end if;

  if exists (
    select 1
    from unnest(v_employee_ids) selected(employee_id)
    where not exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      where directory.employee_id = selected.employee_id
        and directory.current_team_id = any(v_team_ids)
    )
  ) then
    raise exception 'employee_filter_not_in_selected_current_team';
  end if;

  delete from public.user_scope_team_filters filter
  where filter.auth_user_id = p_auth_user_id;
  delete from public.user_scope_position_filters filter
  where filter.auth_user_id = p_auth_user_id;
  delete from public.user_scope_employee_filters filter
  where filter.auth_user_id = p_auth_user_id;

  insert into public.user_scope_team_filters (auth_user_id, team_id)
  select p_auth_user_id, value from unnest(v_team_ids) selected(value);

  insert into public.user_scope_position_filters (auth_user_id, position_id)
  select p_auth_user_id, value from unnest(v_position_ids) selected(value);

  insert into public.user_scope_employee_filters (auth_user_id, employee_id)
  select p_auth_user_id, value from unnest(v_employee_ids) selected(value);

  v_effective_count := scope_private.rebuild_account_employee_scope(p_auth_user_id);
  return jsonb_build_object('effective_employee_count', v_effective_count);
end;
$$;

revoke all on function public.admin_save_account_scope_filters(uuid, uuid[], uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.admin_save_account_scope_filters(uuid, uuid[], uuid[], uuid[])
  to service_role;

create or replace function public.admin_save_account_access_scope(
  p_auth_user_id uuid,
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
as $$
declare
  v_result jsonb;
  v_previous_skip text := coalesce(
    pg_catalog.current_setting('scope_private.skip_rebuild', true),
    'off'
  );
begin
  if p_auth_user_id is null or p_role_id is null
     or p_data_scope not in ('all', 'own_team', 'assigned_teams', 'self') then
    raise exception 'invalid_account_scope';
  end if;
  if p_data_scope in ('own_team', 'self') and p_employee_id is null then
    raise exception 'employee_required';
  end if;
  if p_data_scope = 'assigned_teams' then
    if cardinality(array(
      select value from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
      where value is not null
    )) = 0 then
      if cardinality(array(
        select value from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(value)
        where value is not null
      )) > 0 then
        raise exception 'position_filter_requires_team';
      end if;
      raise exception 'assigned_scope_requires_team';
    end if;
  elsif cardinality(coalesce(p_team_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_employee_ids, '{}'::uuid[])) > 0 then
    raise exception 'filters_require_assigned_scope';
  end if;

  perform 1
  from public.user_access access
  where access.auth_user_id = p_auth_user_id
  for update;
  if not found then raise exception 'account_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  perform pg_catalog.set_config('scope_private.skip_rebuild', 'on', true);
  update public.user_access access
  set employee_id = p_employee_id,
      role_id = p_role_id,
      data_scope = p_data_scope,
      updated_at = now()
  where access.auth_user_id = p_auth_user_id;

  v_result := public.admin_save_account_scope_filters(
    p_auth_user_id,
    case when p_data_scope = 'assigned_teams' then p_team_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then p_position_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then p_employee_ids else '{}'::uuid[] end
  );
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild',
    case when v_previous_skip = 'on' then 'on' else 'off' end,
    true
  );
  return v_result || jsonb_build_object('data_scope', p_data_scope);
end;
$$;

revoke all on function public.admin_save_account_access_scope(
  uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.admin_save_account_access_scope(
  uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) to service_role;

-- Remove only grants that are provably outside their selected current teams.
-- Invalid position selections are retained so the rebuilt scope remains empty
-- instead of broadening from "team + missing position" to the whole team.
delete from public.user_scope_employee_filters employee_filter
where not exists (
  select 1
  from scope_private.current_employee_scope_directory() directory
  join public.user_scope_team_filters team_filter
    on team_filter.auth_user_id = employee_filter.auth_user_id
   and team_filter.team_id = directory.current_team_id
  where directory.employee_id = employee_filter.employee_id
);

select scope_private.rebuild_all_assigned_employee_scopes();

commit;
