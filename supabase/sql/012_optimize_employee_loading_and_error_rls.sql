create index if not exists idx_employee_lifecycle_events_employee_type
  on public.employee_lifecycle_events (employee_id, event_type);

create index if not exists idx_employee_lifecycle_events_no_type_date_created
  on public.employee_lifecycle_events (employee_no, event_type, effective_date, created_at desc);

create index if not exists idx_employees_direct_leader_id
  on public.employees (direct_leader_id);

create index if not exists idx_employees_position_id
  on public.employees (position_id);

create index if not exists idx_employees_shift_id
  on public.employees (shift_id);

create index if not exists idx_employees_trainer_id
  on public.employees (trainer_id);

drop policy if exists backend_read_employee_error_summary
  on public.employee_error_summary;

create policy backend_read_employee_error_summary
  on public.employee_error_summary
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_access ua
      where ua.auth_user_id = (select auth.uid())
        and ua.active = true
        and ua.backend_enabled = true
    )
  );

drop policy if exists backend_read_employee_error_audit
  on public.employee_error_audit;

create policy backend_read_employee_error_audit
  on public.employee_error_audit
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_access ua
      where ua.auth_user_id = (select auth.uid())
        and ua.active = true
        and ua.backend_enabled = true
    )
  );
