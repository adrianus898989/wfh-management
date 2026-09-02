begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regprocedure('session_private.current_app_session_is_valid(text)') is null then
    raise exception 'current_admin_session_guard_missing';
  end if;
  if to_regprocedure('public.has_permission(text)') is null then
    raise exception 'permission_guard_missing';
  end if;
  if to_regclass('public.user_scope_employees') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.teams') is null
     or to_regclass('public.positions') is null then
    raise exception 'staff_account_recovery_relation_missing';
  end if;
end
$guard$;

create index if not exists user_access_staff_employee_created_page_idx
  on public.user_access (employee_id, created_at desc, auth_user_id desc)
  where employee_portal_enabled = true;

create or replace function public.admin_staff_accounts_page_v1(
  p_email_query text default '',
  p_employee_query text default '',
  p_context_query text default '',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce(p_email_query, '')));
  v_employee text := lower(btrim(coalesce(p_employee_query, '')));
  v_context text := lower(btrim(coalesce(p_context_query, '')));
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size integer := coalesce(p_page_size, 20);
  v_caller_employee_id uuid;
  v_caller_scope text;
  v_caller_role text;
  v_is_founder boolean := false;
  v_result jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if length(v_email) > 64 or length(v_employee) > 64 or length(v_context) > 64 then
    raise exception using errcode = '22023', message = 'search_query_too_long';
  end if;
  if v_page_size not in (20, 30, 50, 100, 200) then
    raise exception using errcode = '22023', message = 'invalid_staff_account_page_size';
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_caller_scope, v_caller_role
  from public.user_access access
  join public.roles role on role.id = access.role_id and role.active = true
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  v_is_founder := v_caller_role = 'founder';
  if not v_is_founder and not public.has_permission('staff_account.view') then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  with visible as materialized (
    select
      access.auth_user_id,
      access.employee_id,
      access.login_email,
      access.active,
      access.created_at,
      employee.employee_no,
      employee.full_name,
      team.id team_id,
      team.name team_name,
      position.id position_id,
      position.name position_name
    from public.user_access access
    join public.employees employee on employee.id = access.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where access.employee_portal_enabled = true
      and (
        v_is_founder
        or v_caller_scope = 'all'
        or (v_caller_scope = 'self' and access.employee_id = v_caller_employee_id)
        or (
          v_caller_scope in ('own_team', 'assigned_teams')
          and exists (
            select 1
            from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = access.employee_id
          )
        )
      )
      and (v_email = '' or lower(coalesce(access.login_email, '')) like '%' || v_email || '%')
      and (
        v_employee = ''
        or lower(coalesce(employee.employee_no, '')) like '%' || v_employee || '%'
        or lower(coalesce(employee.full_name, '')) like '%' || v_employee || '%'
      )
      and (
        v_context = ''
        or lower(coalesce(team.name, '')) like '%' || v_context || '%'
        or lower(coalesce(position.name, '')) like '%' || v_context || '%'
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
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'auth_user_id', page_row.auth_user_id,
        'employee_id', page_row.employee_id,
        'login_email', page_row.login_email,
        'active', page_row.active,
        'created_at', page_row.created_at,
        'employee', jsonb_build_object(
          'id', page_row.employee_id,
          'employee_no', page_row.employee_no,
          'full_name', page_row.full_name,
          'teams', case when page_row.team_id is null then null else jsonb_build_object(
            'id', page_row.team_id,
            'name', page_row.team_name
          ) end,
          'positions', case when page_row.position_id is null then null else jsonb_build_object(
            'id', page_row.position_id,
            'name', page_row.position_name
          ) end
        )
      ) order by page_row.created_at desc, page_row.auth_user_id desc)
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_staff_accounts_page_v1(text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_staff_accounts_page_v1(text, text, text, integer, integer)
  to authenticated;

comment on function public.admin_staff_accounts_page_v1(text, text, text, integer, integer) is
  'Recovery-safe staff portal account reader: authenticated admin session, explicit staff-account permission, effective employee scope, bounded search and pagination.';

notify pgrst, 'reload schema';

commit;
