begin;

create or replace function public.admin_recovery_backend_accounts_page_v2(
  p_actor_user_id uuid,
  p_username_query text default '',
  p_employee_query text default '',
  p_context_query text default '',
  p_status text default 'all',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size integer := coalesce(p_page_size, 20);
  v_username text := lower(btrim(coalesce(p_username_query, '')));
  v_employee text := lower(btrim(coalesce(p_employee_query, '')));
  v_context text := lower(btrim(coalesce(p_context_query, '')));
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_actor_role_code text;
  v_actor_role_id uuid;
  v_actor_scope text;
  v_is_founder boolean := false;
  v_result jsonb;
begin
  if v_page_size not in (20, 30, 50, 100, 200) then
    raise exception using errcode = '22023', message = 'invalid_account_page_size';
  end if;

  select actor.role_id, actor_role.code, actor.data_scope
  into v_actor_role_id, v_actor_role_code, v_actor_scope
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  v_is_founder := v_actor_role_code = 'founder';

  if not v_is_founder and v_actor_scope is distinct from 'all' then
    raise exception using errcode = '42501', message = 'recovery_scope_not_supported';
  end if;
  if not v_is_founder and not exists (
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
    where permission.code in ('*', 'backend_account.view')
  ) then
    raise exception using errcode = '42501', message = 'permission_denied';
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
      and (
        (v_is_founder and access.auth_user_id = p_actor_user_id)
        or scope_private.recovery_backend_action_allowed(
          p_actor_user_id,
          access.auth_user_id,
          'backend_account.view'
        )
      )
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
          when v_is_founder or page_row.creator_auth_user_id = p_actor_user_id then
            coalesce(nullif(btrim(page_row.creator_username), ''), '后台账号')
          else '其他授权管理员'
        end
      ) order by page_row.created_at desc, page_row.auth_user_id desc)
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_recovery_backend_accounts_page_v2(uuid, text, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_backend_accounts_page_v2(uuid, text, text, text, text, integer, integer)
  to service_role;

comment on function public.admin_recovery_backend_accounts_page_v2(uuid, text, text, text, text, integer, integer) is
  'Recovery-safe backend account list with exact bounded page sizes 20, 30, 50, 100, or 200.';

notify pgrst, 'reload schema';

commit;
