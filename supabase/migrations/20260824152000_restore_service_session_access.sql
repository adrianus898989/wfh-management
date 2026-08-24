-- Edge Functions authenticate users with the service-role client before they
-- perform scoped business reads. Keep the lease table private from browsers,
-- while restoring the CRUD privileges needed by trusted server functions.
revoke all on table public.app_session_leases from public, anon, authenticated;
grant select, insert, update, delete on table public.app_session_leases to service_role;
