begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- The recovery UI may save permissions for one existing role at a time.  Keep
-- the writer separate from the former account bootstrap: it does not inspect
-- employees, teams or the scope directory, and the role row is the only row
-- locked before the small role_permissions diff is applied.
do $guard$
begin
  if to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.audit_logs') is null then
    raise exception 'recovery_role_permission_relation_missing';
  end if;
end
$guard$;

create or replace function public.admin_recovery_save_role_permissions(
  p_actor_user_id uuid,
  p_role_id uuid,
  p_permission_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1500ms'
as $function$
declare
  v_input_ids uuid[] := coalesce(p_permission_ids, '{}'::uuid[]);
  v_visible_ids uuid[] := '{}'::uuid[];
  v_visible_codes text[] := '{}'::text[];
  v_dependency_codes text[] := '{}'::text[];
  v_dependency_ids uuid[] := '{}'::uuid[];
  v_desired_ids uuid[] := '{}'::uuid[];
  v_current_ids uuid[] := '{}'::uuid[];
  v_actor_employee_id uuid;
  v_actor_role_code text;
  v_target_role_code text;
  v_target_system_locked boolean;
  v_target_active boolean;
  v_added integer := 0;
  v_removed integer := 0;
  v_hidden_legacy_codes constant text[] := array[
    'employee.view','employee.resign','employee.reactivate','audit.view',
    'schedule.view','attendance.view','attendance.edit','leave.approve',
    'report.view','report.edit','export.general',
    'online_training.view','online_training.submit','online_training.review','online_training.manage',
    'exam.view','exam.manage','exam.grade','exam.delete',
    'adjustment.view','adjustment.create','adjustment.approve','adjustment.page.approve',
    'daily_work.submit','daily_work.manage',
    'payroll.view','payroll.edit','payroll.approve','payroll.publish','payroll.export',
    'payroll.rule.edit','payroll.payout_change.view','payroll.payout_change.review',
    'employee.directory.payroll_history.view',
    'user.view','account.view','account.mfa_reset','role.manage'
  ]::text[];
begin
  if p_actor_user_id is null or p_role_id is null then
    raise exception using errcode = '22023', message = 'missing_role_permission_identity';
  end if;
  if cardinality(v_input_ids) > 500 then
    raise exception using errcode = '22023', message = 'role_permission_limit_exceeded';
  end if;
  if array_position(v_input_ids, null) is not null then
    raise exception using errcode = '22023', message = 'invalid_permission_id';
  end if;
  if cardinality(v_input_ids) <> (
    select count(distinct requested.permission_id)
    from unnest(v_input_ids) requested(permission_id)
  ) then
    raise exception using errcode = '22023', message = 'duplicate_permission_id';
  end if;

  -- The service-role Edge caller supplies the authenticated actor id.  Recheck
  -- the canonical active backend role in this transaction so a stale or
  -- crafted request can never turn a non-Founder into a permission writer.
  select actor.employee_id, actor_role.code
  into v_actor_employee_id, v_actor_role_code
  from public.user_access actor
  join public.roles actor_role
    on actor_role.id = actor.role_id
   and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true;

  if not found or v_actor_role_code <> 'founder' then
    raise exception using errcode = '42501', message = 'founder_required';
  end if;

  select role.code, role.system_locked, role.active
  into v_target_role_code, v_target_system_locked, v_target_active
  from public.roles role
  where role.id = p_role_id
  for no key update;

  if not found then
    raise exception using errcode = 'P0002', message = 'target_role_missing';
  end if;
  if v_target_role_code = 'founder'
     or v_target_system_locked
     or not v_target_active then
    raise exception using errcode = '22023', message = 'role_permissions_fixed';
  end if;

  if cardinality(v_input_ids) <> (
    select count(*)
    from public.permissions permission
    where permission.id = any(v_input_ids)
  ) then
    raise exception using errcode = '22023', message = 'unknown_permission_id';
  end if;

  -- Hidden legacy implementation grants are never accepted from the browser.
  -- Rebuild only the dependencies required by selected current-page grants.
  select
    coalesce(array_agg(permission.id order by permission.id), '{}'::uuid[]),
    coalesce(array_agg(permission.code order by permission.id), '{}'::text[])
  into v_visible_ids, v_visible_codes
  from public.permissions permission
  where permission.id = any(v_input_ids)
    and not (permission.code = any(v_hidden_legacy_codes));

  select coalesce(array_agg(distinct dependency.code order by dependency.code), '{}'::text[])
  into v_dependency_codes
  from (
    select case
      when selected.code like 'work.event.%' and right(selected.code, 7) = '.submit' then 'daily_work.submit'
      when selected.code like 'work.event.%' and right(selected.code, 7) = '.manage' then 'daily_work.manage'
      when selected.code like 'work.event.%' and right(selected.code, 5) = '.edit' then 'report.edit'
      when selected.code like 'work.event.%' then 'report.view'
      when selected.code like 'work.daily_inspection.%' and right(selected.code, 5) = '.edit' then 'report.edit'
      when selected.code like 'work.daily_inspection.%' then 'daily_work.manage'
      when selected.code like 'work.quality_inspection.%' then 'report.edit'
      when selected.code in ('asset.view', 'staff_account.view') then 'user.view'
      when selected.code = 'backend_account.view' then 'account.view'
      when right(selected.code, length('_account.mfa_reset')) = '_account.mfa_reset' then 'account.mfa_reset'
      when selected.code = 'role.audit.view' then 'audit.view'
      else null
    end as code
    from unnest(v_visible_codes) selected(code)
  ) dependency
  where dependency.code is not null;

  select coalesce(array_agg(permission.id order by permission.id), '{}'::uuid[])
  into v_dependency_ids
  from public.permissions permission
  where permission.code = any(v_dependency_codes);

  if cardinality(v_dependency_ids) <> cardinality(v_dependency_codes) then
    raise exception using errcode = '55000', message = 'role_permission_dependency_missing';
  end if;

  select coalesce(array_agg(distinct desired.permission_id order by desired.permission_id), '{}'::uuid[])
  into v_desired_ids
  from unnest(v_visible_ids || v_dependency_ids) desired(permission_id);

  if cardinality(v_desired_ids) > 500 then
    raise exception using errcode = '22023', message = 'role_permission_limit_exceeded';
  end if;

  select coalesce(array_agg(current.permission_id order by current.permission_id), '{}'::uuid[])
  into v_current_ids
  from public.role_permissions current
  where current.role_id = p_role_id;

  if v_current_ids = v_desired_ids then
    return jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_target_role_code,
      'changed', false,
      'added', 0,
      'removed', 0,
      'permission_ids', to_jsonb(v_desired_ids)
    );
  end if;

  insert into public.role_permissions(role_id, permission_id)
  select p_role_id, desired.permission_id
  from unnest(v_desired_ids) desired(permission_id)
  on conflict(role_id, permission_id) do nothing;
  get diagnostics v_added = row_count;

  delete from public.role_permissions current
  where current.role_id = p_role_id
    and not (current.permission_id = any(v_desired_ids));
  get diagnostics v_removed = row_count;

  insert into public.audit_logs(
    actor_user_id, employee_id, module, action, record_id,
    old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'role_permissions_update',
    p_role_id::text,
    jsonb_build_object(
      'role_code', v_target_role_code,
      'permission_count', cardinality(v_current_ids),
      'permission_ids', to_jsonb(v_current_ids)
    ),
    jsonb_build_object(
      'role_code', v_target_role_code,
      'permission_count', cardinality(v_desired_ids),
      'permission_ids', to_jsonb(v_desired_ids),
      'added', v_added,
      'removed', v_removed
    ),
    format(
      '稳定恢复模式修改角色权限 role=%s added=%s removed=%s',
      v_target_role_code,
      v_added,
      v_removed
    )
  );

  return jsonb_build_object(
    'role_id', p_role_id,
    'role_code', v_target_role_code,
    'changed', true,
    'added', v_added,
    'removed', v_removed,
    'permission_ids', to_jsonb(v_desired_ids)
  );
end;
$function$;

revoke all on function public.admin_recovery_save_role_permissions(uuid, uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_save_role_permissions(uuid, uuid, uuid[])
  to service_role;

comment on function public.admin_recovery_save_role_permissions(uuid, uuid, uuid[]) is
  'Service-only, Founder-rechecked recovery writer for one existing non-Founder role. Applies a bounded role_permissions diff and its audit row in one short transaction; it never reads employee/team/scope directories.';

notify pgrst, 'reload schema';

commit;
