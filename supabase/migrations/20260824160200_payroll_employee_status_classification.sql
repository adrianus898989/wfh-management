-- Keep payroll records attached to the employee's real lifecycle state.
-- Only an explicit resignation (or an unmatched historical departure date)
-- belongs in the resigned bucket. Suspended/inactive employees remain a
-- separate operational state and probation/unknown active states stay active.

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
  if v_selected is null then
    select b.id into v_selected
    from public.payroll_batches b
    order by b.period_start desc,b.created_at desc
    limit 1;
  end if;

  select jsonb_build_object(
    'permissions',jsonb_build_object(
      'edit',public.has_permission('payroll.edit'),
      'approve',public.has_permission('payroll.approve'),
      'publish',public.has_permission('payroll.publish'),
      'export',public.has_permission('payroll.export')
    ),
    'batches',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.period_start desc,x.created_at desc)
      from (
        select b.id,b.period_start,b.title,b.currency,b.status,b.source_type,b.source_file_name,b.notes,
          b.row_count,b.matched_count,b.unmatched_count,b.created_at,b.published_at,
          coalesce(sum(p.total_pay),0)::numeric(16,2) total_amount,
          count(p.id) filter(
            where p.employee_id is not null
              and coalesce(e.status::text,'active') not in ('resigned','suspended','inactive')
          )::integer active_count,
          count(p.id) filter(
            where p.employee_id is not null
              and coalesce(e.status::text,'active') in ('suspended','inactive')
          )::integer suspended_count,
          count(p.id) filter(
            where (p.employee_id is not null and coalesce(e.status::text,'active')='resigned')
               or (p.employee_id is null and p.departure_date is not null)
          )::integer resigned_count,
          count(p.id) filter(where p.employee_id is null and p.departure_date is null)::integer unresolved_count
        from public.payroll_batches b
        left join public.payroll_payslips p on p.batch_id=b.id
        left join public.employees e on e.id=p.employee_id
        group by b.id
        order by b.period_start desc,b.created_at desc
        limit 36
      ) x
    ),'[]'::jsonb),
    'selected_batch',(
      select to_jsonb(x)
      from (
        select b.id,b.period_start,b.title,b.currency,b.status,b.source_type,b.source_file_name,b.notes,
          b.row_count,b.matched_count,
          coalesce(sum(p.total_pay),0)::numeric(16,2) total_amount,
          count(p.id) filter(where p.employee_id is null and p.departure_date is null)::integer unmatched_count,
          count(p.id) filter(where p.employee_id is null and p.departure_date is null)::integer unresolved_count,
          count(p.id) filter(
            where p.employee_id is not null
              and coalesce(e.status::text,'active') not in ('resigned','suspended','inactive')
          )::integer active_count,
          count(p.id) filter(
            where p.employee_id is not null
              and coalesce(e.status::text,'active') in ('suspended','inactive')
          )::integer suspended_count,
          count(p.id) filter(
            where (p.employee_id is not null and coalesce(e.status::text,'active')='resigned')
               or (p.employee_id is null and p.departure_date is not null)
          )::integer resigned_count,
          b.created_at,b.published_at
        from public.payroll_batches b
        left join public.payroll_payslips p on p.batch_id=b.id
        left join public.employees e on e.id=p.employee_id
        where b.id=v_selected
        group by b.id
      ) x
    ),
    'rows',coalesce((
      select jsonb_agg(jsonb_build_object(
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
        'source_row',p.source_row,'matched',p.employee_id is not null,
        'employee_status',e.status,
        'match_state',case
          when p.employee_id is not null and coalesce(e.status::text,'active')='resigned' then 'resigned'
          when p.employee_id is not null and coalesce(e.status::text,'active') in ('suspended','inactive') then 'suspended'
          when p.employee_id is not null then 'active'
          when p.departure_date is not null then 'resigned'
          else 'unmatched'
        end
      ) order by p.source_row)
      from public.payroll_payslips p
      left join public.employees e on e.id=p.employee_id
      where p.batch_id=v_selected
    ),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

-- The public session-enforcing wrapper is the only browser entry point.
revoke all on function payroll_private.admin_payroll_home(bigint)
  from public, anon, authenticated;

notify pgrst,'reload schema';
