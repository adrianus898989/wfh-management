-- Keep the managed database's safe-delete protection enabled while clearing
-- stale portal IP attestations during an explicit enforcement change.
--
-- The original routines used an unqualified DELETE for intentional table
-- cleanup. Production correctly rejected those statements with
-- "DELETE requires a WHERE clause", rolling back the enforcement toggle.
-- Patch only those cleanup statements so the surrounding authorization,
-- session revocation and audit behavior remains unchanged.

do $migration$
declare
  v_signature regprocedure := to_regprocedure(
    'public.portal_ip_allowlist_mutate(uuid,uuid,text,text,jsonb)'
  );
  v_definition text;
begin
  if v_signature is null then
    raise exception 'portal_ip_allowlist_mutate_missing';
  end if;

  select pg_get_functiondef(v_signature)
  into v_definition;

  if strpos(
       v_definition,
       'delete from public.admin_ip_session_attestations attestation where attestation.session_id is not null;'
     ) > 0
     and strpos(
       v_definition,
       'delete from public.staff_ip_session_attestations attestation where attestation.session_id is not null;'
     ) > 0 then
    -- The emergency production migration may already have applied this exact
    -- patch under its server-generated version. Keep repository replay safe.
    null;
  elsif strpos(v_definition, 'delete from public.admin_ip_session_attestations;') > 0
     and strpos(v_definition, 'delete from public.staff_ip_session_attestations;') > 0 then
    v_definition := replace(
      v_definition,
      'delete from public.admin_ip_session_attestations;',
      'delete from public.admin_ip_session_attestations attestation where attestation.session_id is not null;'
    );
    v_definition := replace(
      v_definition,
      'delete from public.staff_ip_session_attestations;',
      'delete from public.staff_ip_session_attestations attestation where attestation.session_id is not null;'
    );

    execute v_definition;
  else
    raise exception 'portal_ip_allowlist_cleanup_shape_changed';
  end if;
end;
$migration$;

create or replace function session_private.founder_recover_staff_ip_allowlist(
  p_confirmation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_confirmation <> 'DISABLE STAFF IP ALLOWLIST' then
    raise exception using errcode = '22023', message = 'confirmation_required';
  end if;

  update public.admin_ip_allowlist_settings setting
  set staff_enforced = false,
      staff_updated_at = clock_timestamp(),
      staff_updated_by = null
  where setting.id = 1;

  delete from public.staff_ip_session_attestations attestation
  where attestation.session_id is not null;

  return jsonb_build_object(
    'ok', true,
    'staff_enforced', false,
    'reason', 'founder_break_glass_recovery'
  );
end;
$$;

revoke all on function session_private.founder_recover_staff_ip_allowlist(text)
  from public, anon, authenticated, service_role;

comment on function session_private.founder_recover_staff_ip_allowlist(text) is
  'Founder-only SQL break-glass routine for disabling staff IP enforcement without disabling managed safe-delete protection.';
