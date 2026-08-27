begin;

-- The atomic account writer suppresses its own AFTER trigger while it replaces
-- all scope dimensions. Restore the previous flag before returning so another
-- account mutation in the same service transaction cannot skip its rebuild.
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
    if cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
       and cardinality(coalesce(p_team_ids, '{}'::uuid[])) = 0 then
      raise exception 'position_filter_requires_team';
    end if;
    if cardinality(coalesce(p_team_ids, '{}'::uuid[])) = 0
       and cardinality(coalesce(p_employee_ids, '{}'::uuid[])) = 0 then
      raise exception 'assigned_scope_requires_team_or_employee';
    end if;
  elsif cardinality(coalesce(p_team_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_employee_ids, '{}'::uuid[])) > 0 then
    raise exception 'filters_require_assigned_scope';
  end if;

  perform 1 from public.user_access access
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

notify pgrst, 'reload schema';

commit;
