-- Cover the foreign-key columns introduced by the admin alert follow-up and
-- admin IP allowlist workflows. These indexes keep actor/entry cleanup and
-- audit joins predictable as the tables grow.

create index if not exists admin_alert_follow_ups_confirmed_by_idx
  on public.admin_alert_follow_ups (confirmed_by);

create index if not exists admin_alert_follow_ups_handled_by_idx
  on public.admin_alert_follow_ups (handled_by);

create index if not exists admin_ip_allowlist_entries_updated_by_idx
  on public.admin_ip_allowlist_entries (updated_by);

create index if not exists admin_ip_session_attestations_matched_entry_idx
  on public.admin_ip_session_attestations (matched_entry_id);
