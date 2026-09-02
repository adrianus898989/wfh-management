begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure(
    'public.admin_recovery_update_backend_account_v2(uuid,uuid,uuid,uuid,text,uuid[],uuid[],uuid[])'
  ) is null then
    raise exception 'admin_recovery_update_backend_account_v2_missing';
  end if;
  if to_regprocedure(
    'public.admin_save_account_scope_filters(uuid,uuid[],uuid[],uuid[])'
  ) is null then
    raise exception 'admin_save_account_scope_filters_missing';
  end if;
end;
$$;

-- Preserve the fully validated v2 editor as the final authorization boundary.
-- The public wrapper below only changes the order for an assigned-to-assigned
-- filter replacement: validated new filters are staged transactionally before
-- the preserved editor delegates the role update to the legacy authority.
alter function public.admin_recovery_update_backend_account_v2(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) set schema scope_private;

alter function scope_private.admin_recovery_update_backend_account_v2(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) rename to admin_recovery_update_backend_account_v2_ordering_base;

revoke all on function scope_private.admin_recovery_update_backend_account_v2_ordering_base(
  uuid, uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) from public, anon, authenticated, service_role;

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
  v_current_scope text;
  v_team_ids uuid[] := array(
    select distinct selected.value
    from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null
    order by selected.value
  );
  v_position_ids uuid[] := array(
    select distinct selected.value
    from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null
    order by selected.value
  );
  v_employee_ids uuid[] := array(
    select distinct selected.value
    from unnest(coalesce(p_employee_ids, '{}'::uuid[])) selected(value)
    where selected.value is not null
    order by selected.value
  );
  v_current_team_ids uuid[] := '{}'::uuid[];
  v_current_position_ids uuid[] := '{}'::uuid[];
  v_current_employee_ids uuid[] := '{}'::uuid[];
  v_filters_changed boolean := false;
  v_staged_scope jsonb := '{}'::jsonb;
  v_saved jsonb;
begin
  -- Keep the same deterministic lock order as both recovery editors. This
  -- prevents a competing save from changing the old filters between the
  -- comparison, staging write and authoritative delegated update.
  perform 1
  from public.user_access access
  where access.auth_user_id in (p_actor_user_id, p_target_user_id)
  order by access.auth_user_id
  for update;

  select target.data_scope
  into v_current_scope
  from public.user_access target
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true;

  if found and p_data_scope = 'assigned_teams'
     and v_current_scope = 'assigned_teams' then
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

    v_filters_changed := v_current_team_ids is distinct from v_team_ids
      or v_current_position_ids is distinct from v_position_ids
      or v_current_employee_ids is distinct from v_employee_ids;
  end if;

  if v_filters_changed then
    -- This existing hard-boundary function validates teams, positions and
    -- employees against the strict current roster before replacing anything.
    -- The subsequent preserved v2 editor revalidates the same inputs and then
    -- invokes the legacy role-delegation authority. Any later denial/error
    -- rolls this staging write back because everything is one transaction.
    v_staged_scope := public.admin_save_account_scope_filters(
      p_target_user_id,
      v_team_ids,
      v_position_ids,
      v_employee_ids
    );
  end if;

  v_saved := scope_private.admin_recovery_update_backend_account_v2_ordering_base(
    p_actor_user_id,
    p_target_user_id,
    p_employee_id,
    p_role_id,
    p_data_scope,
    v_team_ids,
    v_position_ids,
    v_employee_ids
  );

  if not v_filters_changed then
    return v_saved;
  end if;

  -- Staging makes the preserved editor observe an exact no-op filter set, so
  -- retain its original changed-filter side effects here: revoke sessions and
  -- write the dedicated old/new scope audit after all authority checks pass.
  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;
  delete from auth.sessions auth_session
  where auth_session.user_id = p_target_user_id;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  where actor.auth_user_id = p_actor_user_id;

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

  -- Prefer the preserved editor's final post-role result over the preliminary
  -- staging result if both contain the same summary key.
  return coalesce(v_staged_scope, '{}'::jsonb)
    || coalesce(v_saved, '{}'::jsonb)
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
  'Service-only recovery backend editor. For assigned-scope replacements it stages strict-current-roster filters before the preserved v2 editor rechecks every boundary and delegates role authority, then audits and revokes sessions atomically.';

notify pgrst, 'reload schema';

commit;
