begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $$
begin
  if to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.app_session_leases') is null then
    raise exception 'recovery_backend_account_control_dependency_missing';
  end if;
end;
$$;

create or replace function public.admin_recovery_founder_backend_accounts_page(
  p_actor_user_id uuid,
  p_username_query text default '',
  p_employee_query text default '',
  p_context_query text default '',
  p_status text default 'all',
  p_page integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size constant integer := 20;
  v_username text := lower(btrim(coalesce(p_username_query, '')));
  v_employee text := lower(btrim(coalesce(p_employee_query, '')));
  v_context text := lower(btrim(coalesce(p_context_query, '')));
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_result jsonb;
begin
  if p_actor_user_id is null or not exists (
    select 1
    from public.user_access actor
    join public.roles actor_role on actor_role.id = actor.role_id
    where actor.auth_user_id = p_actor_user_id
      and actor.active = true
      and actor.backend_enabled = true
      and actor_role.active = true
      and actor_role.code = 'founder'
  ) then
    raise exception using errcode = '42501', message = 'founder_required';
  end if;

  if length(v_username) > 64 or length(v_employee) > 64 or length(v_context) > 64 then
    raise exception using errcode = '22023', message = 'search_query_too_long';
  end if;
  if v_status not in ('all', 'active', 'inactive') then
    raise exception using errcode = '22023', message = 'invalid_account_status';
  end if;

  with visible as materialized (
    select
      access.auth_user_id,
      access.employee_id,
      access.role_id,
      access.login_username,
      access.otp_required,
      access.data_scope,
      access.active,
      access.created_at,
      access.account_created_by,
      role.code role_code,
      role.name role_name,
      employee.employee_no,
      employee.full_name,
      creator.auth_user_id creator_auth_user_id,
      creator.login_username creator_username
    from public.user_access access
    join public.roles role on role.id = access.role_id and role.active = true
    left join public.employees employee on employee.id = access.employee_id
    left join public.user_access creator on creator.auth_user_id = access.account_created_by
    where access.backend_enabled = true
      and (v_status = 'all' or (v_status = 'active' and access.active) or (v_status = 'inactive' and not access.active))
      and (v_username = '' or lower(coalesce(access.login_username, '')) like '%' || v_username || '%')
      and (
        v_employee = ''
        or lower(coalesce(employee.employee_no, '')) like '%' || v_employee || '%'
        or lower(coalesce(employee.full_name, '')) like '%' || v_employee || '%'
      )
      and (
        v_context = ''
        or lower(role.name) like '%' || v_context || '%'
        or lower(role.code) like '%' || v_context || '%'
        or lower(coalesce(access.data_scope, '')) like '%' || v_context || '%'
        or lower(coalesce(creator.login_username, '')) like '%' || v_context || '%'
      )
  ), page_rows as (
    select *
    from visible
    order by created_at desc, auth_user_id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from visible),
    'status', v_status,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'auth_user_id', page_row.auth_user_id,
        'employee_id', page_row.employee_id,
        'role_id', page_row.role_id,
        'login_username', page_row.login_username,
        'otp_required', page_row.otp_required,
        'data_scope', page_row.data_scope,
        'active', page_row.active,
        'created_at', page_row.created_at,
        'roles', jsonb_build_object(
          'id', page_row.role_id,
          'code', page_row.role_code,
          'name', page_row.role_name,
          'active', true
        ),
        'employee', case when page_row.employee_id is null then null else jsonb_build_object(
          'id', page_row.employee_id,
          'employee_no', page_row.employee_no,
          'full_name', page_row.full_name
        ) end,
        'account_created_by_label', case
          when page_row.account_created_by is null then '系统 / 历史导入'
          when page_row.creator_auth_user_id is null then '已删除账号'
          else coalesce(nullif(btrim(page_row.creator_username), ''), '后台账号')
        end
      ) order by page_row.created_at desc, page_row.auth_user_id desc)
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_recovery_set_backend_account_control(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_control text,
  p_value boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1200ms'
as $$
declare
  v_actor_employee_id uuid;
  v_target_role_code text;
  v_old_active boolean;
  v_old_otp boolean;
  v_new_active boolean;
  v_new_otp boolean;
begin
  if p_actor_user_id is null or p_target_user_id is null or p_value is null then
    raise exception using errcode = '22023', message = 'invalid_account_control';
  end if;
  if p_control not in ('active', 'otp_required') then
    raise exception using errcode = '22023', message = 'unsupported_account_control';
  end if;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
    and actor_role.active = true
    and actor_role.code = 'founder'
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'founder_required';
  end if;

  select role.code, target.active, target.otp_required
  into v_target_role_code, v_old_active, v_old_otp
  from public.user_access target
  join public.roles role on role.id = target.role_id and role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;
  if v_target_role_code = 'founder' then
    raise exception using errcode = '42501', message = 'founder_target_protected';
  end if;
  if p_control = 'active' and not p_value and p_target_user_id = p_actor_user_id then
    raise exception using errcode = '22023', message = 'cannot_disable_current_account';
  end if;

  update public.user_access target
  set active = case when p_control = 'active' then p_value else target.active end,
      otp_required = case when p_control = 'otp_required' then p_value else target.otp_required end,
      updated_at = now()
  where target.auth_user_id = p_target_user_id
  returning target.active, target.otp_required into v_new_active, v_new_otp;

  if (p_control = 'active' and not p_value) or p_control = 'otp_required' then
    delete from public.app_session_leases lease
    where lease.user_id = p_target_user_id;
  end if;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, old_data, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    case when p_control = 'active' then 'account_active_toggle' else 'otp_toggle' end,
    p_target_user_id::text,
    jsonb_build_object('active', v_old_active, 'otp_required', v_old_otp),
    jsonb_build_object('active', v_new_active, 'otp_required', v_new_otp),
    case when p_control = 'active'
      then format('稳定恢复模式设置后台账号 active=%s', p_value)
      else format('稳定恢复模式设置后台账号 otp_required=%s', p_value)
    end
  );

  return jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'active', v_new_active,
    'otp_required', v_new_otp
  );
end;
$$;

create or replace function public.admin_recovery_finalize_backend_auth_control(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3500ms'
set lock_timeout = '1200ms'
as $$
declare
  v_actor_employee_id uuid;
  v_target_role_code text;
begin
  if p_actor_user_id is null or p_target_user_id is null
     or p_action not in ('password_reset', 'mfa_reset') then
    raise exception using errcode = '22023', message = 'invalid_backend_auth_control';
  end if;

  select actor.employee_id
  into v_actor_employee_id
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
    and actor_role.active = true
    and actor_role.code = 'founder'
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'founder_required';
  end if;

  select role.code
  into v_target_role_code
  from public.user_access target
  join public.roles role on role.id = target.role_id and role.active = true
  where target.auth_user_id = p_target_user_id
    and target.backend_enabled = true
  for update of target;
  if not found then
    raise exception using errcode = 'P0002', message = 'backend_account_not_found';
  end if;
  if v_target_role_code = 'founder' then
    raise exception using errcode = '42501', message = 'founder_target_protected';
  end if;

  if p_action = 'password_reset' then
    update public.user_access target
    set must_change_password = true,
        password_reset_at = now(),
        updated_at = now()
    where target.auth_user_id = p_target_user_id;
  end if;

  delete from public.app_session_leases lease
  where lease.user_id = p_target_user_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    p_action,
    p_target_user_id::text,
    jsonb_build_object('recovery_mode', true),
    case when p_action = 'password_reset'
      then '稳定恢复模式重置后台账号密码并要求下次登录改密'
      else '稳定恢复模式重置后台账号 OTP/MFA'
    end
  );

  return jsonb_build_object(
    'auth_user_id', p_target_user_id,
    'action', p_action,
    'finalized', true
  );
end;
$$;

revoke all on function public.admin_recovery_founder_backend_accounts_page(uuid, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_founder_backend_accounts_page(uuid, text, text, text, text, integer)
  to service_role;

revoke all on function public.admin_recovery_set_backend_account_control(uuid, uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_set_backend_account_control(uuid, uuid, text, boolean)
  to service_role;

revoke all on function public.admin_recovery_finalize_backend_auth_control(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_finalize_backend_auth_control(uuid, uuid, text)
  to service_role;

comment on function public.admin_recovery_founder_backend_accounts_page(uuid, text, text, text, text, integer) is
  'Founder-only recovery list with complete server-side username, employee, role/context, status and fixed 20-row paging.';
comment on function public.admin_recovery_set_backend_account_control(uuid, uuid, text, boolean) is
  'Founder-only short transaction for backend active/OTP changes, lease revocation and audit.';
comment on function public.admin_recovery_finalize_backend_auth_control(uuid, uuid, text) is
  'Founder-only short transaction finalizing password/MFA recovery actions with lease revocation and audit.';

notify pgrst, 'reload schema';

commit;
