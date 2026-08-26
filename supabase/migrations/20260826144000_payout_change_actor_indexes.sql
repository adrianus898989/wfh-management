-- Keep payout-change history filters fast as approval records accumulate.
-- These indexes also cover the auth.users foreign keys reported by the
-- Supabase performance advisor.

create index if not exists payout_change_requests_requested_by_idx
  on public.payout_change_requests(requested_by)
  where requested_by is not null;

create index if not exists payout_change_requests_reviewed_by_idx
  on public.payout_change_requests(reviewed_by)
  where reviewed_by is not null;

create index if not exists payout_change_requests_fulfilled_by_idx
  on public.payout_change_requests(fulfilled_by)
  where fulfilled_by is not null;
