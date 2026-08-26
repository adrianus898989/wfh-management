begin;

-- Data scope is an explicit authorization decision. Linking a backend account
-- to an employee supplies the identity needed by `self` and `own_team`; it must
-- not silently replace a Founder-approved `all` or `assigned_teams` scope.
drop trigger if exists enforce_linked_backend_own_team_trigger
  on public.user_access;
drop function if exists public.enforce_linked_backend_own_team();

-- Keep the database/RLS interpretation identical to the admin Edge Function:
--   all            -> every employee;
--   self           -> only the linked employee;
--   own_team       -> employees in the linked employee's current team;
--   assigned_teams -> only explicit employee/team assignments.
-- Unknown or incomplete scopes fail closed. Founder remains unrestricted.
create or replace function public.backend_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_role_code text;
  v_caller_team_id uuid;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  select access.employee_id,
         access.data_scope,
         role.code,
         employee.team_id
  into v_caller_employee_id,
       v_scope,
       v_role_code,
       v_caller_team_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  left join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return false; end if;
  if v_role_code = 'founder' then return true; end if;

  -- Organization-wide scope is explicit and does not depend on linkage.
  if v_scope = 'all' then return true; end if;

  if v_scope = 'self' then
    return v_caller_employee_id is not null
      and p_employee_id = v_caller_employee_id;
  end if;

  if v_scope = 'own_team' then
    if v_caller_employee_id is null or v_caller_team_id is null then
      return false;
    end if;
    return exists (
      select 1
      from public.employees target
      where target.id = p_employee_id
        and target.team_id = v_caller_team_id
    );
  end if;

  if v_scope = 'assigned_teams' then
    return exists (
      select 1
      from public.employees target
      where target.id = p_employee_id
        and (
          exists (
            select 1
            from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = target.id
          )
          or exists (
            select 1
            from public.user_scope_teams scoped_team
            where scoped_team.auth_user_id = v_user_id
              and scoped_team.team_id = target.team_id
          )
        )
    );
  end if;

  return false;
end;
$$;

comment on function public.backend_employee_in_scope(uuid) is
  'Current admin lease scope using the explicitly stored all, self, own_team, or assigned_teams mode; invalid/incomplete scopes fail closed.';

revoke all on function public.backend_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.backend_employee_in_scope(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
