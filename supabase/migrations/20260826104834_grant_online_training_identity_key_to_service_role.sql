begin;

-- Linked account creation inserts into public.user_access.  The partial
-- expression index user_access_online_training_login_identity_idx evaluates
-- this normalizer for every linked row, including writes made by the
-- admin-accounts Edge Function through its service-role client.
--
-- Keep the helper unavailable to anonymous callers while granting only the
-- two application roles that execute it directly or as an index dependency.
revoke all on function public.online_training_identity_key(text)
  from public, anon;
grant execute on function public.online_training_identity_key(text)
  to authenticated, service_role;

commit;
