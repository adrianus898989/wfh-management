begin;

-- These service-owned tables are intentionally unreachable from browser roles.
-- Keep explicit deny policies in addition to revoked grants so the security
-- boundary is visible to auditors and database linting tools.
drop policy if exists admin_ip_allowlist_settings_no_direct_access
  on public.admin_ip_allowlist_settings;
create policy admin_ip_allowlist_settings_no_direct_access
on public.admin_ip_allowlist_settings
for all to anon, authenticated
using (false)
with check (false);

drop policy if exists admin_ip_allowlist_entries_no_direct_access
  on public.admin_ip_allowlist_entries;
create policy admin_ip_allowlist_entries_no_direct_access
on public.admin_ip_allowlist_entries
for all to anon, authenticated
using (false)
with check (false);

drop policy if exists admin_ip_session_attestations_no_direct_access
  on public.admin_ip_session_attestations;
create policy admin_ip_session_attestations_no_direct_access
on public.admin_ip_session_attestations
for all to anon, authenticated
using (false)
with check (false);

commit;
