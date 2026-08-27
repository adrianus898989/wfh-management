begin;

-- An employee can legitimately have two different identities:
-- 1. a backend/admin account used for management work; and
-- 2. a staff portal account used for the employee self-service portal.
--
-- The old table-wide UNIQUE(employee_id) constraint made the second identity
-- impossible to create.  Keep duplicate protection per account type instead.
alter table public.user_access
  drop constraint if exists user_access_employee_id_key;

create unique index if not exists user_access_one_backend_account_per_employee_idx
  on public.user_access (employee_id)
  where employee_id is not null and backend_enabled = true;

create unique index if not exists user_access_one_staff_account_per_employee_idx
  on public.user_access (employee_id)
  where employee_id is not null and employee_portal_enabled = true;

comment on index public.user_access_one_backend_account_per_employee_idx is
  'Allows a separate staff identity while limiting each employee to one backend identity.';

comment on index public.user_access_one_staff_account_per_employee_idx is
  'Allows a separate backend identity while limiting each employee to one staff portal identity.';

commit;
