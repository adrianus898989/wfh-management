-- Keep salary records out of the exposed API schemas.  The public RPC names
-- remain stable for the web application, while the security-definer
-- implementations live in a schema that is not exposed by the Data API.

create index if not exists payroll_audit_payslip_idx
  on public.payroll_audit_log (payslip_id);

drop policy if exists payroll_batches_no_direct_access on public.payroll_batches;
create policy payroll_batches_no_direct_access
  on public.payroll_batches for all to anon, authenticated
  using (false) with check (false);

drop policy if exists payroll_payslips_no_direct_access on public.payroll_payslips;
create policy payroll_payslips_no_direct_access
  on public.payroll_payslips for all to anon, authenticated
  using (false) with check (false);

drop policy if exists payroll_audit_no_direct_access on public.payroll_audit_log;
create policy payroll_audit_no_direct_access
  on public.payroll_audit_log for all to anon, authenticated
  using (false) with check (false);

create schema if not exists payroll_private;
revoke all on schema payroll_private from public, anon, authenticated;

alter function public.admin_payroll_import(jsonb,jsonb) set schema payroll_private;
alter function public.admin_payroll_home(bigint) set schema payroll_private;
alter function public.admin_payroll_publish(bigint) set schema payroll_private;
alter function public.staff_payroll_home() set schema payroll_private;
alter function public.staff_payroll_detail(bigint) set schema payroll_private;

revoke all on function payroll_private.admin_payroll_import(jsonb,jsonb) from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_home(bigint) from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_publish(bigint) from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_home() from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_detail(bigint) from public, anon, authenticated;
grant usage on schema payroll_private to authenticated;
grant execute on function payroll_private.admin_payroll_import(jsonb,jsonb) to authenticated;
grant execute on function payroll_private.admin_payroll_home(bigint) to authenticated;
grant execute on function payroll_private.admin_payroll_publish(bigint) to authenticated;
grant execute on function payroll_private.staff_payroll_home() to authenticated;
grant execute on function payroll_private.staff_payroll_detail(bigint) to authenticated;

create function public.admin_payroll_import(p_batch jsonb, p_rows jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select payroll_private.admin_payroll_import(p_batch, p_rows);
$$;

create function public.admin_payroll_home(p_batch_id bigint default null)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select payroll_private.admin_payroll_home(p_batch_id);
$$;

create function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select payroll_private.admin_payroll_publish(p_batch_id);
$$;

create function public.staff_payroll_home()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select payroll_private.staff_payroll_home();
$$;

create function public.staff_payroll_detail(p_payslip_id bigint)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select payroll_private.staff_payroll_detail(p_payslip_id);
$$;

revoke all on function public.admin_payroll_import(jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.admin_payroll_home(bigint) from public, anon, authenticated;
revoke all on function public.admin_payroll_publish(bigint) from public, anon, authenticated;
revoke all on function public.staff_payroll_home() from public, anon, authenticated;
revoke all on function public.staff_payroll_detail(bigint) from public, anon, authenticated;
grant execute on function public.admin_payroll_import(jsonb,jsonb) to authenticated;
grant execute on function public.admin_payroll_home(bigint) to authenticated;
grant execute on function public.admin_payroll_publish(bigint) to authenticated;
grant execute on function public.staff_payroll_home() to authenticated;
grant execute on function public.staff_payroll_detail(bigint) to authenticated;
