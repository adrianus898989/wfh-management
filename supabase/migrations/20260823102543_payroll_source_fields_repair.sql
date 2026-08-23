-- Preserve every business column in the uploaded payroll workbook and repair the
-- August PHP batch from its immutable raw payload.

alter table public.payroll_payslips
  add column if not exists source_group text,
  add column if not exists departure_date date,
  add column if not exists increment_adjustment numeric not null default 0,
  add column if not exists attendance_bonus numeric not null default 0,
  add column if not exists extra_adjustment numeric not null default 0,
  add column if not exists next_deduction numeric not null default 0,
  add column if not exists overpayment_deduction numeric not null default 0;

create or replace function payroll_private.fill_payroll_source_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_departure text := coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,departure_date}',''),
    nullif(new.raw_payload->>'离职日期','')
  );
begin
  new.source_group := coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,source_group}',''),
    nullif(new.raw_payload->>'分组',''),
    new.source_group
  );
  if v_departure ~ '^\d{4}-\d{2}-\d{2}$' then new.departure_date := v_departure::date; end if;
  new.attendance_salary := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,attendance_salary}',''),
    nullif(new.raw_payload->>'出勤工资',''),new.attendance_salary::text
  ));
  new.leave_deduction := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,leave_deduction}',''),
    nullif(new.raw_payload->>'休假扣除',''),new.leave_deduction::text
  ));
  new.increment_adjustment := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,increment_adjustment}',''),
    nullif(new.raw_payload->>'递增',''),new.increment_adjustment::text
  ));
  new.attendance_bonus := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,attendance_bonus}',''),
    nullif(new.raw_payload->>'满勤',''),new.attendance_bonus::text
  ));
  new.performance_adjustment := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,performance_adjustment}',''),
    nullif(new.raw_payload->>'绩效',''),new.performance_adjustment::text
  ));
  new.deposit_adjustment := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,deposit_adjustment}',''),
    nullif(new.raw_payload->>'押金',''),new.deposit_adjustment::text
  ));
  new.extra_adjustment := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,extra_adjustment}',''),
    nullif(new.raw_payload->>'额外加扣',''),new.extra_adjustment::text
  ));
  new.next_deduction := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,next_deduction}',''),
    nullif(new.raw_payload->>'下次要扣除',''),new.next_deduction::text
  ));
  new.overpayment_deduction := internal.payroll_number(coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,overpayment_deduction}',''),
    nullif(new.raw_payload->>'多转扣除',''),new.overpayment_deduction::text
  ));
  return new;
end;
$$;

drop trigger if exists payroll_source_fields_fill on public.payroll_payslips;
create trigger payroll_source_fields_fill
before insert or update of raw_payload on public.payroll_payslips
for each row execute function payroll_private.fill_payroll_source_fields();

-- The target is resolved by stable business identifiers rather than a generated ID.
update public.payroll_payslips p
set raw_payload = p.raw_payload,
    updated_at = now()
from public.payroll_batches b
where b.id=p.batch_id
  and b.period_start=date '2026-08-01'
  and b.title='2026-08 工资'
  and b.source_file_name='小菲居家8月1-15工资.xlsx';

update public.payroll_payslips p
set line_items = coalesce((
  select jsonb_agg(jsonb_build_object('code',x.code,'label',x.label,'type',x.kind,'amount',x.amount) order by x.ord)
  from (values
    (1,'attendance_salary','出勤工资','earn',p.attendance_salary),
    (2,'leave_deduction','休假扣除','deduct',p.leave_deduction),
    (3,'increment_adjustment','递增','earn',p.increment_adjustment),
    (4,'attendance_bonus','满勤','earn',p.attendance_bonus),
    (5,'performance_adjustment','绩效','adjust',p.performance_adjustment),
    (6,'deposit_adjustment','押金','adjust',p.deposit_adjustment),
    (7,'overtime_bonus','额外加班','earn',p.overtime_bonus),
    (8,'extra_adjustment','额外加扣','adjust',p.extra_adjustment),
    (9,'next_deduction','下次要扣除','deduct',p.next_deduction),
    (10,'overpayment_deduction','多转扣除','deduct',p.overpayment_deduction),
    (11,'other_adjustment','其他调整','adjust',p.other_adjustment)
  ) x(ord,code,label,kind,amount)
  where x.amount <> 0
),'[]'::jsonb), updated_at=now()
from public.payroll_batches b
where b.id=p.batch_id
  and b.period_start=date '2026-08-01'
  and b.title='2026-08 工资'
  and b.source_file_name='小菲居家8月1-15工资.xlsx';

create or replace function payroll_private.admin_payroll_home(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_selected bigint := p_batch_id;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.view') then raise exception 'permission_denied'; end if;
  if v_selected is null then select b.id into v_selected from public.payroll_batches b order by b.period_start desc,b.created_at desc limit 1; end if;
  select jsonb_build_object(
    'permissions',jsonb_build_object('edit',public.has_permission('payroll.edit'),'approve',public.has_permission('payroll.approve'),'publish',public.has_permission('payroll.publish'),'export',public.has_permission('payroll.export')),
    'batches',coalesce((select jsonb_agg(to_jsonb(x) order by x.period_start desc,x.created_at desc) from(
      select b.id,b.period_start,b.title,b.currency,b.status,b.source_type,b.source_file_name,b.notes,
        b.row_count,b.matched_count,b.unmatched_count,b.created_at,b.published_at
      from public.payroll_batches b order by b.period_start desc,b.created_at desc limit 36
    )x),'[]'::jsonb),
    'selected_batch',(select to_jsonb(b) from public.payroll_batches b where b.id=v_selected),
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'employee_id',p.employee_id,'employee_no',p.employee_no_raw,'full_name',p.full_name,
      'platform',p.platform,'source_group',p.source_group,'position_name',p.position_name,
      'hire_date',p.hire_date,'departure_date',p.departure_date,
      'card_number',p.card_number,'payment_name',p.payment_name,'payment_method',p.payment_method,
      'base_salary',p.base_salary,'attendance_salary',p.attendance_salary,
      'leave_deduction',p.leave_deduction,'late_deduction',p.late_deduction,
      'absence_deduction',p.absence_deduction,'increment_adjustment',p.increment_adjustment,
      'attendance_bonus',p.attendance_bonus,'performance_adjustment',p.performance_adjustment,
      'deposit_adjustment',p.deposit_adjustment,'overtime_bonus',p.overtime_bonus,
      'extra_adjustment',p.extra_adjustment,'next_deduction',p.next_deduction,
      'overpayment_deduction',p.overpayment_deduction,'other_adjustment',p.other_adjustment,
      'total_pay',p.total_pay,'line_items',p.line_items,'remark',p.remark,
      'source_row',p.source_row,'matched',p.employee_id is not null
    ) order by p.source_row) from public.payroll_payslips p where p.batch_id=v_selected),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function payroll_private.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.view') then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.employees e where e.id=p_employee_id) then raise exception 'employee_not_found'; end if;
  return jsonb_build_object(
    'total',(select count(*) from public.payroll_payslips p where p.employee_id=p_employee_id),
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.period_start desc,x.id desc) from(
      select p.id,p.period_start,b.title,b.currency,b.status,b.published_at,p.platform,p.source_group,p.position_name,
        p.base_salary,p.attendance_salary,p.leave_deduction,p.late_deduction,p.absence_deduction,
        p.increment_adjustment,p.attendance_bonus,p.performance_adjustment,p.deposit_adjustment,p.overtime_bonus,
        p.extra_adjustment,p.next_deduction,p.overpayment_deduction,p.other_adjustment,p.total_pay,
        p.line_items,p.remark,p.payment_method,p.payment_name
      from public.payroll_payslips p join public.payroll_batches b on b.id=p.batch_id
      where p.employee_id=p_employee_id order by p.period_start desc,p.id desc limit 120
    )x),'[]'::jsonb)
  );
end;
$$;

revoke all on function payroll_private.fill_payroll_source_fields() from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_home(bigint) from public, anon, authenticated;
revoke all on function payroll_private.admin_employee_payroll_history(uuid) from public, anon, authenticated;
grant execute on function payroll_private.admin_payroll_home(bigint) to authenticated;
grant execute on function payroll_private.admin_employee_payroll_history(uuid) to authenticated;
