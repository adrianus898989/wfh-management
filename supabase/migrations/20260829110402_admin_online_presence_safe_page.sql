begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Presence counts stay on the cheap head-only Edge path.  This RPC is called
-- only when an authorised operator opens one of the two presence lists.  It
-- keeps the former recovery circuit breaker intact while providing a bounded,
-- scope-aware detail path that never enumerates an operator's entire scope.
do $prerequisites$
begin
  if to_regprocedure('public.admin_online_presence_allowed()') is null then
    raise exception 'admin_online_presence_guard_missing';
  end if;
  if to_regclass('public.app_session_leases') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.user_scope_employees') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.teams') is null
     or to_regclass('public.positions') is null then
    raise exception 'admin_online_presence_relation_missing';
  end if;
end;
$prerequisites$;

create or replace function public.admin_online_presence_page_v1(
  p_portal text,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_portal text := lower(btrim(coalesce(p_portal, '')));
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 20);
  v_offset integer;
  v_caller_employee_id uuid;
  v_caller_scope text;
  v_caller_role text;
  v_is_founder boolean := false;
  v_now timestamptz := statement_timestamp();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if v_portal not in ('admin', 'staff') then
    raise exception using errcode = '22023', message = 'invalid_presence_portal';
  end if;
  if v_page < 1 or v_page > 500 then
    raise exception using errcode = '22023', message = 'invalid_presence_page';
  end if;
  if v_page_size < 1 or v_page_size > 50 then
    raise exception using errcode = '22023', message = 'invalid_presence_page_size';
  end if;
  if not public.admin_online_presence_allowed() then
    raise exception using errcode = '42501', message = 'presence_permission_denied';
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
  v_offset := (v_page - 1) * v_page_size;

  with visible_presence as materialized (
    select
      lease.user_id,
      lease.portal,
      lease.claimed_at,
      lease.last_seen_at,
      access.employee_id,
      coalesce(nullif(btrim(employee.full_name), ''),
               nullif(btrim(access.login_username), ''),
               nullif(btrim(access.login_email), ''),
               case when lease.portal = 'admin' then '后台账号' else '员工账号' end) as display_name,
      coalesce(nullif(btrim(access.login_username), ''),
               nullif(btrim(access.login_email), ''), '') as username,
      coalesce(nullif(btrim(employee.employee_no), ''), '') as employee_no,
      coalesce(nullif(btrim(team.name), ''), '') as team,
      coalesce(nullif(btrim(position.name), ''), '') as position
    from public.app_session_leases lease
    join public.user_access access
      on access.auth_user_id = lease.user_id
     and access.active = true
    join public.roles target_role
      on target_role.id = access.role_id
     and target_role.active = true
    left join public.employees employee on employee.id = access.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where lease.portal = v_portal
      and lease.lease_expires_at > v_now
      and (
        (v_portal = 'admin' and access.backend_enabled = true)
        or (v_portal = 'staff' and access.employee_portal_enabled = true)
      )
      and (
        v_is_founder
        or v_caller_scope = 'all'
        or lease.user_id = v_user_id
        or (
          v_caller_scope = 'self'
          and access.employee_id = v_caller_employee_id
        )
        or (
          v_caller_scope in ('own_team', 'assigned_teams')
          and access.employee_id is not null
          and exists (
            select 1
            from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = access.employee_id
          )
        )
      )
  ), page_rows as materialized (
    select visible.*
    from visible_presence visible
    order by visible.last_seen_at desc, visible.user_id
    offset v_offset
    limit v_page_size
  )
  select jsonb_build_object(
    'portal', v_portal,
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from visible_presence),
    'pages', greatest(
      1,
      ceil((select count(*) from visible_presence)::numeric / v_page_size)::integer
    ),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'portal', page_row.portal,
          'name', page_row.display_name,
          'username', page_row.username,
          'employee_no', page_row.employee_no,
          'team', page_row.team,
          'position', page_row.position,
          'last_seen_at', page_row.last_seen_at,
          'claimed_at', page_row.claimed_at,
          'current', page_row.user_id = v_user_id
        )
        order by page_row.last_seen_at desc, page_row.user_id
      )
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.admin_online_presence_page_v1(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_online_presence_page_v1(text, integer, integer)
  to authenticated;

comment on function public.admin_online_presence_page_v1(text, integer, integer) is
  'JWT/session/permission-checked, data-scope-aware and hard-bounded online presence list. Counts remain on the separate head-only Edge path.';

notify pgrst, 'reload schema';

commit;
