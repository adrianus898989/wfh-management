\set ON_ERROR_STOP on

begin;

do $defaults$
declare
  v_staff_enforced boolean;
  v_default text;
begin
  select setting.staff_enforced
  into strict v_staff_enforced
  from public.admin_ip_allowlist_settings setting
  where setting.id = 1;
  if v_staff_enforced then
    raise exception 'staff IP enforcement must remain off after migration';
  end if;

  select pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
  into strict v_default
  from pg_catalog.pg_attribute attribute
  join pg_catalog.pg_attrdef attribute_default
    on attribute_default.adrelid = attribute.attrelid
   and attribute_default.adnum = attribute.attnum
  where attribute.attrelid = 'public.admin_ip_allowlist_entries'::regclass
    and attribute.attname = 'portal_scope';
  if v_default not like '%admin%' then
    raise exception 'existing/new entries must default to admin-only scope: %', v_default;
  end if;

  if pg_catalog.has_table_privilege(
    'authenticated',
    'public.staff_ip_session_attestations',
    'select'
  ) then
    raise exception 'authenticated must not read staff IP attestations';
  end if;
  if pg_catalog.has_function_privilege(
    'authenticated',
    'public.staff_ip_session_attest(uuid,uuid,text,text)',
    'execute'
  ) then
    raise exception 'authenticated must not create staff IP attestations';
  end if;
  if pg_catalog.has_function_privilege(
    'anon',
    'public.portal_ip_prelogin_check(text,text)',
    'execute'
  ) then
    raise exception 'anonymous callers must not bypass Edge to query the privileged prelogin RPC';
  end if;
  if not pg_catalog.has_function_privilege(
    'service_role',
    'public.portal_ip_prelogin_check(text,text)',
    'execute'
  ) then
    raise exception 'Edge service role must retain prelogin RPC execute privilege';
  end if;
end
$defaults$;

insert into public.admin_ip_allowlist_entries (
  ip_network, label, notes, enabled, portal_scope
) values (
  '2001:db8:ffff:feed::/64',
  'staff allowlist test network',
  'rolled back by test',
  true,
  'staff'
)
on conflict (ip_network) do update
set enabled = true,
    portal_scope = 'staff',
    label = excluded.label,
    notes = excluded.notes;

do $disabled_gate$
declare
  v_gate jsonb;
begin
  v_gate := public.portal_ip_prelogin_check('staff', '2001:db8:ffff:feed::42');
  if coalesce((v_gate->>'ok')::boolean, false) is not true
     or coalesce((v_gate->>'enforced')::boolean, true) is not false
     or v_gate->>'reason' <> 'enforcement_disabled' then
    raise exception 'default-off staff gate changed unexpectedly: %', v_gate;
  end if;

  v_gate := public.portal_ip_prelogin_check('admin', '2001:db8:ffff:feed::42');
  if v_gate->>'matched_entry_id' is not null then
    raise exception 'staff-only entry leaked into admin coverage: %', v_gate;
  end if;
end
$disabled_gate$;

update public.admin_ip_allowlist_settings
set staff_enforced = true
where id = 1;

do $enforced_gate$
declare
  v_gate jsonb;
begin
  v_gate := public.portal_ip_prelogin_check('staff', '2001:db8:ffff:feed::42');
  if coalesce((v_gate->>'ok')::boolean, false) is not true
     or v_gate->>'reason' <> 'matched' then
    raise exception 'allowed staff network was rejected: %', v_gate;
  end if;

  v_gate := public.portal_ip_prelogin_check('staff', '2001:db8:ffff:beef::42');
  if coalesce((v_gate->>'ok')::boolean, true) is not false
     or v_gate->>'reason' <> 'ip_not_allowed' then
    raise exception 'unlisted staff network was not rejected: %', v_gate;
  end if;
end
$enforced_gate$;

update public.admin_ip_allowlist_entries
set enabled = false
where portal_scope in ('staff', 'both');

do $enabled_empty_is_deny_all$
declare
  v_gate jsonb;
begin
  v_gate := public.portal_ip_prelogin_check('staff', '2001:db8:ffff:feed::42');
  if coalesce((v_gate->>'ok')::boolean, true) is not false
     or coalesce((v_gate->>'effective')::boolean, false) is not true
     or v_gate->>'reason' <> 'ip_not_allowed' then
    raise exception 'explicitly enabled empty list must fail closed: %', v_gate;
  end if;
end
$enabled_empty_is_deny_all$;

rollback;
