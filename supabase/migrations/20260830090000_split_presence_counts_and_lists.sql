begin;

set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $prerequisites$
begin
  if to_regclass('public.permissions') is null
     or to_regprocedure('public.admin_access_session_allowed()') is null
     or to_regprocedure('public.admin_online_presence_allowed()') is null then
    raise exception 'online_presence_split_prerequisites_missing';
  end if;
end;
$prerequisites$;

-- Counts are a low-detail signal shown to every valid backend account. The
-- existing sensitive permission now describes the separately requested list.
update public.permissions
set name = '查看后台与员工在线名单',
    category = 'account',
    sensitive = true
where code = 'account.online_presence.view';

create or replace function public.admin_online_presence_counts_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
  select public.admin_access_session_allowed();
$$;

revoke all on function public.admin_online_presence_counts_allowed()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_online_presence_counts_allowed()
  to authenticated, service_role;

comment on function public.admin_online_presence_counts_allowed() is
  'Lightweight count-only presence guard for any current, active backend session. It does not authorise online identity rows.';

comment on function public.admin_online_presence_allowed() is
  'Online identity-list guard requiring a current active backend session and the explicit account.online_presence.view permission.';

notify pgrst, 'reload schema';

commit;
