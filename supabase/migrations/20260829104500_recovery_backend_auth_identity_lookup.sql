begin;

set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $guard$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth_users_missing';
  end if;
  if to_regclass('public.user_access') is null then
    raise exception 'user_access_missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_access'
      and column_name = 'account_created_by'
      and udt_name = 'uuid'
  ) then
    raise exception 'account_created_by_column_missing';
  end if;
  if to_regclass('public.user_access_login_username_unique') is null then
    raise exception 'backend_username_unique_index_missing';
  end if;
  if to_regprocedure('public.admin_recovery_finalize_backend_account(uuid,uuid,uuid,text,text,boolean,text,uuid)') is null then
    raise exception 'recovery_account_finalizer_missing';
  end if;
end
$guard$;

-- Recovery provisioning uses a deterministic email, but service code must not
-- gain a general-purpose auth.users lookup.  This helper returns only an
-- identity whose email and two server-owned app-metadata values all agree.
create or replace function public.admin_recovery_find_backend_auth_identity(
  p_email text,
  p_username text
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
declare
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_expected_email text;
  v_auth_user_id uuid;
begin
  if v_username !~ '^[a-z0-9._-]{3,32}$' then
    raise exception using errcode = '22023', message = 'invalid_recovery_username';
  end if;
  v_expected_email := v_username || '@admin.wfh.invalid';
  if v_email <> v_expected_email then
    raise exception using errcode = '22023', message = 'invalid_recovery_email';
  end if;

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(auth_user.email) = v_expected_email
    and coalesce(auth_user.raw_app_meta_data ->> 'wfh_provisioning', '') = 'wfh_backend_recovery_v1'
    and lower(coalesce(auth_user.raw_app_meta_data ->> 'wfh_login_username', '')) = v_username
  limit 1;

  return v_auth_user_id;
end;
$$;

revoke all on function public.admin_recovery_find_backend_auth_identity(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_find_backend_auth_identity(text, text)
  to service_role;

comment on function public.admin_recovery_find_backend_auth_identity(text, text) is
  'Service-role-only, recovery-specific deterministic Auth identity lookup. It returns only identities carrying the exact backend provisioning marker and normalized username.';

notify pgrst, 'reload schema';

commit;
