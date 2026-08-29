begin;

set local lock_timeout = '500ms';
set local statement_timeout = '10s';

create or replace function public.admin_access_session_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
  select session_private.current_app_session_is_valid('admin')
    and exists (
      select 1
      from public.user_access access
      join public.roles role on role.id = access.role_id
      where access.auth_user_id = (select auth.uid())
        and access.active = true
        and access.backend_enabled = true
        and role.active = true
    );
$$;

revoke all on function public.admin_access_session_allowed() from public;
revoke all on function public.admin_access_session_allowed() from anon;
grant execute on function public.admin_access_session_allowed() to authenticated;
grant execute on function public.admin_access_session_allowed() to service_role;

comment on function public.admin_access_session_allowed() is
  'Lightweight authenticated admin bootstrap gate: current release/session/IP attestation plus active backend account and role.';

commit;
