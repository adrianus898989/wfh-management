begin;

set local lock_timeout = '2s';
set local statement_timeout = '10s';

do $guard$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth_users_missing';
  end if;
  if to_regprocedure('public.admin_recovery_find_backend_auth_identity(text,text)') is null then
    raise exception 'two_argument_recovery_identity_lookup_missing';
  end if;
  if to_regprocedure('public.admin_recovery_finalize_backend_account(uuid,uuid,uuid,text,text,boolean,text,uuid)') is null then
    raise exception 'recovery_account_finalizer_missing';
  end if;
end
$guard$;

-- The two-argument helper accepted any recovery-marked identity for the same
-- username.  That is insufficient while Auth creation and database
-- finalization are split across services: a concurrent, different request
-- could otherwise reuse the first request's unfinished identity.
revoke all on function public.admin_recovery_find_backend_auth_identity(text, text)
  from public, anon, authenticated, service_role;
drop function public.admin_recovery_find_backend_auth_identity(text, text);

-- The Edge function supplies a server-keyed HMAC over the complete normalized
-- provisioning request.  Only the exact same request can recover the Auth
-- identity after a lost response; a different actor, role, employee, scope,
-- OTP choice or password receives no identity.
create function public.admin_recovery_find_backend_auth_identity(
  p_email text,
  p_username text,
  p_fingerprint text
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
  v_fingerprint text := lower(btrim(coalesce(p_fingerprint, '')));
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
  if v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_recovery_fingerprint';
  end if;

  select auth_user.id
  into v_auth_user_id
  from auth.users auth_user
  where lower(auth_user.email) = v_expected_email
    and coalesce(auth_user.raw_app_meta_data ->> 'wfh_provisioning', '') = 'wfh_backend_recovery_v1'
    and lower(coalesce(auth_user.raw_app_meta_data ->> 'wfh_login_username', '')) = v_username
    and lower(coalesce(auth_user.raw_app_meta_data ->> 'wfh_provisioning_fingerprint', '')) = v_fingerprint
  limit 1;

  return v_auth_user_id;
end;
$$;

revoke all on function public.admin_recovery_find_backend_auth_identity(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_recovery_find_backend_auth_identity(text, text, text)
  to service_role;

comment on function public.admin_recovery_find_backend_auth_identity(text, text, text) is
  'Service-role-only exact recovery identity lookup. The caller must present the server-HMACed complete provisioning request fingerprint stored in Auth app_metadata.';

notify pgrst, 'reload schema';

commit;
