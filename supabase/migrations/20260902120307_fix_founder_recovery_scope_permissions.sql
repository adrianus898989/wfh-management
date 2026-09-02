begin;

set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $guard$
begin
  if to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null then
    raise exception 'founder_recovery_permission_relation_missing';
  end if;
end
$guard$;

-- Founder is treated as an implicit wildcard everywhere in the recovery Edge
-- authorization layer.  The legacy atomic editor predates that convention and
-- still requires these two explicit rows before it can persist a role/scope
-- edit.  Keep the compatibility grant narrow instead of broadening any other
-- role or adding a global wildcard permission.
insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.roles role
cross join public.permissions permission
where role.code = 'founder'
  and role.active = true
  and permission.code in ('account.edit', 'scope.manage')
on conflict (role_id, permission_id) do nothing;

do $verify$
begin
  if (
    select count(*)
    from public.role_permissions role_permission
    join public.roles role on role.id = role_permission.role_id
    join public.permissions permission on permission.id = role_permission.permission_id
    where role.code = 'founder'
      and permission.code in ('account.edit', 'scope.manage')
  ) <> 2 then
    raise exception 'founder_recovery_permission_install_incomplete';
  end if;
end
$verify$;

commit;
