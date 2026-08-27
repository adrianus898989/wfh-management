-- Keep the original mutation implementation private and put an additional
-- database-enforced freshness check in front of it. The allowlist Edge
-- Function refreshes this attestation immediately before every mutation.

alter function public.admin_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  rename to admin_ip_allowlist_mutate_internal;

revoke all on function public.admin_ip_allowlist_mutate_internal(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.admin_ip_allowlist_mutate(
  p_actor_id uuid,
  p_session_id uuid,
  p_client_ip text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_client_ip inet;
  v_now timestamptz := clock_timestamp();
begin
  begin
    v_client_ip := nullif(btrim(coalesce(p_client_ip, '')), '')::inet;
  exception when invalid_text_representation then
    v_client_ip := null;
  end;

  if session_private.admin_ip_enforcement_effective() then
    if v_client_ip is null
       or not exists (
         select 1
         from public.admin_ip_session_attestations attestation
         join public.admin_ip_allowlist_entries entry
           on entry.id = attestation.matched_entry_id
          and entry.enabled = true
          and attestation.ip_address <<= entry.ip_network
         where attestation.user_id = p_actor_id
           and attestation.session_id = p_session_id
           and attestation.ip_address = v_client_ip
           and attestation.verified_until > v_now
       ) then
      raise exception using errcode = '28000', message = 'ip_session_not_verified';
    end if;
  end if;

  return public.admin_ip_allowlist_mutate_internal(
    p_actor_id,
    p_session_id,
    p_client_ip,
    p_action,
    coalesce(p_payload, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.admin_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_ip_allowlist_mutate(uuid, uuid, text, text, jsonb)
  to service_role;
