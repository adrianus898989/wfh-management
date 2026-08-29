begin;

-- This release touches only metadata and SECURITY DEFINER readers. Never wait
-- behind an active payroll request or turn a privacy hardening change into a
-- production stall; a missed lock rolls the entire migration back cleanly.
set local lock_timeout = '500ms';
set local statement_timeout = '10s';

-- Employee data scope and salary access are separate decisions. This new
-- permission deliberately receives no role grant and inherits nothing from
-- the legacy payroll.view / payroll_history permissions. Founder continues to
-- pass through public.has_permission(), while every other role must be opted
-- in explicitly in the role editor.
insert into public.permissions(code,name,category,sensitive)
values(
  'employee.directory.payroll_records.view',
  '查看员工档案内工资记录（敏感）',
  'employee',
  true
)
on conflict(code) do update
set name=excluded.name,
    category=excluded.category,
    sensitive=excluded.sensitive;

-- Reassert the direct-table boundary in the same release as the new drawer
-- permission.  Browser roles must not bypass the RPC by querying raw payslips
-- or compensation tables through PostgREST; service-role writers and the
-- guarded SECURITY DEFINER readers keep their existing access.
alter table public.payroll_batches enable row level security;
alter table public.payroll_payslips enable row level security;
alter table public.employee_compensation_settings enable row level security;
alter table public.employee_compensation_legacy enable row level security;

revoke all on table public.payroll_batches,
  public.payroll_payslips,
  public.employee_compensation_settings,
  public.employee_compensation_legacy
from public,anon,authenticated;

-- Do not delegate to the legacy payroll-history bridge: that bridge inherited
-- payroll.view grants during the granular-permission migration. The public RPC
-- is now the sole browser entrypoint and enforces all three independent gates:
-- page access, explicit salary access, and the target employee's current scope.
-- Its projection is intentionally limited to fields rendered by the drawer.
create or replace function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_rows jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;

  if not public.has_permission('employee.directory.view')
     or not public.has_permission('employee.directory.payroll_records.view') then
    raise exception 'permission_denied';
  end if;

  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  select count(*)::integer
  into v_total
  from public.payroll_payslips payslip
  join public.payroll_batches batch on batch.id=payslip.batch_id
  where payslip.employee_id=p_employee_id
    and batch.status='published'
    and batch.voided_at is null;

  select coalesce(
    jsonb_agg(to_jsonb(visible_row) order by visible_row.period_start desc,visible_row.id desc),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      payslip.id,
      payslip.period_start,
      batch.title,
      batch.currency,
      batch.status,
      batch.published_at,
      payslip.base_salary,
      payslip.attendance_salary,
      payslip.leave_deduction,
      payslip.late_deduction,
      payslip.absence_deduction,
      payslip.performance_adjustment,
      payslip.deposit_adjustment,
      payslip.total_pay,
      payslip.remark
    from public.payroll_payslips payslip
    join public.payroll_batches batch on batch.id=payslip.batch_id
    where payslip.employee_id=p_employee_id
      and batch.status='published'
      and batch.voided_at is null
    order by payslip.period_start desc,payslip.id desc
    limit 120
  ) visible_row;

  return jsonb_build_object('total',v_total,'rows',v_rows);
end;
$$;

revoke all on function public.admin_employee_payroll_history(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_employee_payroll_history(uuid)
  to authenticated,service_role;

-- Keep legacy implementations unavailable even if a stale client knows their
-- names. Their old permission code remains only as inert compatibility data.
revoke all on function public.admin_employee_payroll_history_page_v1(uuid)
  from public,anon,authenticated,service_role;
revoke all on function payroll_private.admin_employee_payroll_history(uuid)
  from public,anon,authenticated,service_role;

comment on function public.admin_employee_payroll_history(uuid) is
  'Fail-closed employee payroll drawer reader: requires employee.directory.view, explicit employee.directory.payroll_records.view, and current employee scope; returns active published rows only.';

notify pgrst,'reload schema';

commit;
