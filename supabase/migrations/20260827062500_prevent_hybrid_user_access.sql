begin;

-- Backend and employee-portal access are separate login identities.  A row
-- may be disabled for both portals, but it must never grant both portals at
-- the same time; this prevents permissions and session leases crossing over.
alter table public.user_access
  drop constraint if exists user_access_single_portal_check;

alter table public.user_access
  add constraint user_access_single_portal_check
  check (not (backend_enabled = true and employee_portal_enabled = true));

commit;
