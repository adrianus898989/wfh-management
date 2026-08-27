-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_claim_definition text;
  v_heartbeat_definition text;
  v_validity_definition text;
  v_attest_definition text;
  v_attestation_validity_definition text;
  v_mutation_definition text;
  v_result jsonb;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in (
        'admin_ip_allowlist_settings',
        'admin_ip_allowlist_entries',
        'admin_ip_session_attestations'
      )
      and relation.relrowsecurity
    group by namespace.nspname
    having count(*) = 3
  ) then
    raise exception 'one or more admin IP tables are missing RLS';
  end if;

  if pg_catalog.has_table_privilege(
       'authenticated', 'public.admin_ip_allowlist_settings', 'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.admin_ip_allowlist_entries', 'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.admin_ip_session_attestations', 'select'
     ) then
    raise exception 'authenticated can read service-owned IP tables';
  end if;

  if not pg_catalog.has_table_privilege(
       'service_role', 'public.admin_ip_allowlist_entries', 'select'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.admin_ip_allowlist_entries', 'insert'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.admin_ip_allowlist_entries', 'update'
     )
     or not pg_catalog.has_table_privilege(
       'service_role', 'public.admin_ip_allowlist_entries', 'delete'
     ) then
    raise exception 'service_role cannot manage IP allowlist entries';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated', 'public.admin_ip_prelogin_check(text)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.admin_ip_session_attest(uuid,uuid,text,text)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.admin_ip_allowlist_mutate(uuid,uuid,text,text,jsonb)',
       'execute'
     ) then
    raise exception 'authenticated can call a service-only IP RPC';
  end if;

  if not pg_catalog.has_function_privilege(
       'service_role', 'public.admin_ip_prelogin_check(text)', 'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_ip_session_attest(uuid,uuid,text,text)',
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.admin_ip_allowlist_mutate(uuid,uuid,text,text,jsonb)',
       'execute'
     ) then
    raise exception 'service_role is missing an IP RPC grant';
  end if;

  if pg_catalog.has_function_privilege(
       'service_role',
       'session_private.founder_recover_admin_ip_allowlist(text)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'session_private.founder_recover_admin_ip_allowlist(text)',
       'execute'
     ) then
    raise exception 'break-glass recovery is exposed outside the SQL owner';
  end if;

  if not exists (
    select 1 from public.permissions permission
    where permission.code = 'account.ip_allowlist.manage'
      and permission.sensitive = true
  ) then
    raise exception 'dedicated sensitive allowlist permission is missing';
  end if;

  if (select setting.enforced from public.admin_ip_allowlist_settings setting where setting.id = 1) then
    raise exception 'allowlist migration did not default enforcement off';
  end if;

  select pg_catalog.pg_get_functiondef(
    'session_private.app_session_claim(text)'::regprocedure
  ) into v_claim_definition;
  select pg_catalog.pg_get_functiondef(
    'session_private.app_session_heartbeat()'::regprocedure
  ) into v_heartbeat_definition;
  select pg_catalog.pg_get_functiondef(
    'session_private.current_app_session_is_valid(text)'::regprocedure
  ) into v_validity_definition;
  select pg_catalog.pg_get_functiondef(
    'public.admin_ip_session_attest(uuid,uuid,text,text)'::regprocedure
  ) into v_attest_definition;
  select pg_catalog.pg_get_functiondef(
    'session_private.current_admin_ip_attestation_is_valid(uuid,uuid)'::regprocedure
  ) into v_attestation_validity_definition;
  select pg_catalog.pg_get_functiondef(
    'public.admin_ip_allowlist_mutate(uuid,uuid,text,text,jsonb)'::regprocedure
  ) into v_mutation_definition;

  if position('current_admin_ip_attestation_is_valid' in v_claim_definition) = 0
     or position('current_admin_ip_attestation_is_valid' in v_heartbeat_definition) = 0
     or position('current_admin_ip_attestation_is_valid' in v_validity_definition) = 0 then
    raise exception 'admin claim, heartbeat, or current-session validity lost its IP guard';
  end if;

  if position('staff_portal_account_exists' in v_claim_definition) = 0
     or position('staff_portal_account_exists' in v_heartbeat_definition) = 0
     or position('staff_portal_account_exists' in v_validity_definition) = 0 then
    raise exception 'staff session protections changed while adding the admin IP guard';
  end if;

  if position('interval ''5 minutes''' in v_claim_definition) = 0
     or position('interval ''5 minutes''' in v_heartbeat_definition) = 0
     or position('verified_until' in v_attest_definition) = 0
     or position('interval ''5 minutes''' in v_attest_definition) = 0
     or position('2 minutes' in v_attest_definition) > 0 then
    raise exception 'IP freshness no longer matches the normal five-minute lease';
  end if;

  if position(
       'verified_until > statement_timestamp()'
       in v_attestation_validity_definition
     ) = 0 then
    raise exception 'expired IP attestation can still pass current-session validity';
  end if;

  if position('attestation.verified_until > v_now' in v_mutation_definition) = 0 then
    raise exception 'allowlist mutation accepts an expired IP attestation';
  end if;

  if position('v_gate->>''reason'' = ''ip_not_allowed''' in v_attest_definition) = 0
     or position('session_revoked'', false' in v_attest_definition) = 0 then
    raise exception 'attestation no longer distinguishes explicit denial from proxy outage';
  end if;

  -- Default-off behavior is fail-open by explicit policy, not by an Edge
  -- fallback. Missing IP is allowed only while enforcement is ineffective.
  delete from public.admin_ip_allowlist_entries;
  update public.admin_ip_allowlist_settings set enforced = false where id = 1;
  v_result := public.admin_ip_prelogin_check(null);
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'enforcement_disabled' then
    raise exception 'default-off prelogin policy failed';
  end if;

  -- Even an out-of-band switch update cannot make an empty list lock every
  -- backend account out. The UI/RPC still refuses to create this state.
  update public.admin_ip_allowlist_settings set enforced = true where id = 1;
  v_result := public.admin_ip_prelogin_check(null);
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'bootstrap_no_entries' then
    raise exception 'zero-entry bootstrap safety rule failed';
  end if;

  insert into public.admin_ip_allowlist_entries(ip_network, label, enabled)
  values
    ('203.0.113.0/24', 'IPv4 test', true),
    ('2001:db8:1234::/64', 'IPv6 test', true);

  v_result := public.admin_ip_prelogin_check('203.0.113.42');
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'matched' then
    raise exception 'IPv4 CIDR match failed';
  end if;

  v_result := public.admin_ip_prelogin_check('2001:db8:1234::99');
  if not coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'matched' then
    raise exception 'IPv6 CIDR match failed';
  end if;

  v_result := public.admin_ip_prelogin_check('198.51.100.7');
  if coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'ip_not_allowed' then
    raise exception 'non-allowlisted address was accepted';
  end if;

  v_result := public.admin_ip_prelogin_check(null);
  if coalesce((v_result->>'ok')::boolean, false)
     or v_result->>'reason' <> 'client_ip_unavailable' then
    raise exception 'effective enforcement accepted missing proxy IP';
  end if;
end;
$$;

rollback;
