begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regprocedure('security_private.login_admin_permission_allowed(uuid,text)') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null then
    raise exception 'login_lockout_permission_precedence_dependency_missing';
  end if;
end
$guard$;

-- Keep the same permission semantics as recovery.ts and the role editor:
-- exact account override > exact role grant > wildcard account override >
-- wildcard role grant. In particular, denying `*` must not cancel a concrete
-- permission explicitly granted by the role.
create or replace function security_private.login_admin_permission_allowed(
  p_actor_user_id uuid,
  p_permission_code text
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
set statement_timeout = '1500ms'
as $function$
declare
  v_role_id uuid;
  v_role_code text;
  v_override boolean;
begin
  if p_actor_user_id is null
     or nullif(btrim(coalesce(p_permission_code, '')), '') is null then
    return false;
  end if;

  select access.role_id, role.code
  into v_role_id, v_role_code
  from public.user_access access
  join public.roles role
    on role.id = access.role_id
   and role.active = true
  where access.auth_user_id = p_actor_user_id
    and access.active = true
    and access.backend_enabled = true
  limit 1;
  if not found then return false; end if;
  if v_role_code = 'founder' then return true; end if;

  select permission_override.allowed
  into v_override
  from public.user_permission_overrides permission_override
  join public.permissions permission
    on permission.id = permission_override.permission_id
   and permission.code = p_permission_code
  where permission_override.auth_user_id = p_actor_user_id
  limit 1;
  if found then return v_override; end if;

  if exists (
    select 1
    from public.role_permissions role_permission
    join public.permissions permission
      on permission.id = role_permission.permission_id
    where role_permission.role_id = v_role_id
      and permission.code = p_permission_code
  ) then return true; end if;

  select permission_override.allowed
  into v_override
  from public.user_permission_overrides permission_override
  join public.permissions permission
    on permission.id = permission_override.permission_id
   and permission.code = '*'
  where permission_override.auth_user_id = p_actor_user_id
  limit 1;
  if found then return v_override; end if;

  return exists (
    select 1
    from public.role_permissions role_permission
    join public.permissions permission
      on permission.id = role_permission.permission_id
    where role_permission.role_id = v_role_id
      and permission.code = '*'
  );
end;
$function$;

revoke all on function security_private.login_admin_permission_allowed(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.login_admin_permission_allowed(uuid, text)
  to service_role;

comment on function security_private.login_admin_permission_allowed(uuid, text) is
  'Service-only exact action permission resolver: exact user override, exact role grant, wildcard user override, then wildcard role grant.';

notify pgrst, 'reload schema';

commit;
