begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $prerequisites$
begin
  if to_regclass('public.permissions') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_access') is null then
    raise exception 'account_permission_prerequisites_missing';
  end if;
  if to_regprocedure('session_private.current_app_session_is_valid(text)') is null
     or to_regprocedure('public.has_permission(text)') is null then
    raise exception 'account_permission_guard_missing';
  end if;
  if to_regprocedure('public.admin_online_presence_allowed()') is null then
    raise exception 'admin_online_presence_guard_missing';
  end if;
end;
$prerequisites$;

-- Online counts reveal who is currently working.  Page visibility alone must
-- not grant that operational signal; Founder remains implicit and every other
-- role receives this only through an explicit role grant/override.
insert into public.permissions(code, name, category, sensitive)
values (
  'account.online_presence.view',
  '查看后台与员工在线人数',
  'account',
  true
)
on conflict(code) do update
set name = excluded.name,
    category = excluded.category,
    sensitive = excluded.sensitive;

create table if not exists public.backend_role_assignment_rules (
  grantor_role_id uuid not null references public.roles(id) on delete cascade,
  target_role_id uuid not null references public.roles(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(grantor_role_id, target_role_id),
  constraint backend_role_assignment_rules_no_self
    check(grantor_role_id <> target_role_id)
);

alter table public.backend_role_assignment_rules enable row level security;
revoke all on table public.backend_role_assignment_rules
  from public, anon, authenticated;
grant select on table public.backend_role_assignment_rules
  to service_role;

comment on table public.backend_role_assignment_rules is
  'Server-only role assignment allowlist. It permits provisioning a named lower role without granting the provisioner every operational permission held by that role; user-level permission elevations remain Founder-managed.';

-- Supervisors already hold account.create/edit/scope.manage.  The former
-- permission-subset algorithm nevertheless rejected every standard lower role
-- because each lower role currently owns at least one specialist permission
-- absent from supervisor.  Authorize only the four named standard lower roles;
-- custom roles and peer/higher roles remain unavailable.
insert into public.backend_role_assignment_rules(grantor_role_id, target_role_id, active)
select grantor.id, target.id, true
from public.roles grantor
join public.roles target
  on target.code in ('senior_team_leader', 'team_leader', 'trainer', 'assistant')
where grantor.code = 'supervisor'
on conflict(grantor_role_id, target_role_id) do update
set active = excluded.active;

create or replace function public.admin_online_presence_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $function$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  if not exists (
    select 1
    from public.user_access access
    join public.roles role on role.id = access.role_id
    where access.auth_user_id = v_user_id
      and access.active = true
      and access.backend_enabled = true
      and role.active = true
  ) then
    return false;
  end if;

  return public.has_permission('account.online_presence.view');
end;
$function$;

revoke all on function public.admin_online_presence_allowed()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_online_presence_allowed()
  to authenticated, service_role;

comment on function public.admin_online_presence_allowed() is
  'Lightweight admin-session guard requiring the explicit account.online_presence.view permission before any service-role presence read.';

notify pgrst, 'reload schema';

commit;
