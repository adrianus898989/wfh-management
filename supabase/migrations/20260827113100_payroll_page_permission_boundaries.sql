begin;

-- The payout-change workspace is another payroll child page. Move its two
-- existing public RPC guards to the new page-owned codes before old grants are
-- retired by the final boundary migration.
do $payout_change_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_payout_change_requests(text,text,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'''payroll.payout_change.view''')=0 or strpos(v_definition,'''payroll.payout_change.review''')=0 then
    raise exception 'admin_payout_change_requests_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,'''payroll.payout_change.view''','''payroll.change_history.view'''),'''payroll.payout_change.review''','''payroll.change_history.review''');

  select pg_get_functiondef('public.admin_review_payout_change_request(uuid,text,text)'::regprocedure) into v_definition;
  if strpos(v_definition,'''payroll.payout_change.review''')=0 then
    raise exception 'admin_review_payout_change_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,'''payroll.payout_change.review''','''payroll.change_history.review''');

  -- Storage RLS calls this helper when the admin opens proof images. Leaving
  -- its old codes in place would make the new page permission show the row but
  -- deny the corresponding evidence object after legacy grants are retired.
  select pg_get_functiondef('public.payment_change_admin_can_read_object(text)'::regprocedure) into v_definition;
  if strpos(v_definition,'''payroll.payout_change.view''')=0 or strpos(v_definition,'''payroll.payout_change.review''')=0 then
    raise exception 'payment_change_admin_object_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,
    '''payroll.payout_change.view''','''payroll.change_history.view'''),
    '''payroll.payout_change.review''','''payroll.change_history.review''');
end
$payout_change_permission_bridge$;

-- Retire the broad legacy reader. Page readers query their exact status
-- directly, so a mixed-status LIMIT can never hide a valid batch.
alter function public.admin_payroll_home(bigint) rename to admin_payroll_home_granular_v1;
revoke all on function public.admin_payroll_home_granular_v1(bigint) from public,anon,authenticated;

-- Payroll rows are employee-scoped, but imported rows without a canonical
-- employee cannot be assigned safely to a limited viewer. Only Founder or an
-- explicitly all-scoped backend account may see those rows or mutate a whole
-- batch. Keep this helper private so it cannot become a browser-facing scope
-- oracle.
create function payroll_private.admin_payroll_has_full_scope()
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_scope text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if public.is_founder() then return true; end if;

  select access.data_scope into v_scope
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  return coalesce(v_scope = 'all',false);
end;
$$;
revoke all on function payroll_private.admin_payroll_has_full_scope()
  from public,anon,authenticated;

create function payroll_private.admin_payroll_granular_page(
  p_status text,
  p_batch_id bigint,
  p_include_rows boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_selected bigint;
  v_batches jsonb := '[]'::jsonb;
  v_selected_batch jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_full_scope boolean;
begin
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  if p_status is not null and p_status not in ('draft','published','archived') then
    raise exception 'invalid_payroll_page_status';
  end if;

  if p_batch_id is null then
    select batch.id into v_selected
    from public.payroll_batches batch
    where (p_status is null or batch.status = p_status)
      and (
        v_full_scope
        or exists (
          select 1
          from public.payroll_payslips visible_payslip
          where visible_payslip.batch_id = batch.id
            and visible_payslip.identity_match_state <> 'unmatched'
            and visible_payslip.employee_id is not null
            and public.can_manage_employee(visible_payslip.employee_id)
        )
      )
    order by batch.period_start desc,batch.created_at desc,batch.id desc
    limit 1;
  elsif p_batch_id > 0 then
    select batch.id into v_selected
    from public.payroll_batches batch
    where batch.id = p_batch_id
      and (p_status is null or batch.status = p_status)
      and (
        v_full_scope
        or exists (
          select 1
          from public.payroll_payslips visible_payslip
          where visible_payslip.batch_id = batch.id
            and visible_payslip.identity_match_state <> 'unmatched'
            and visible_payslip.employee_id is not null
            and public.can_manage_employee(visible_payslip.employee_id)
        )
      );
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(batch_data)
      order by batch_data.period_start desc,batch_data.created_at desc,batch_data.id desc),
    '[]'::jsonb
  ) into v_batches
  from (
    select batch.id,batch.period_start,batch.title,batch.currency,batch.status,
      batch.source_type,batch.source_file_name,batch.created_at,batch.published_at,
      count(payslip.id)::integer row_count,
      count(payslip.id) filter(where payslip.identity_match_state <> 'unmatched')::integer matched_count,
      count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unmatched_count,
      coalesce(sum(payslip.total_pay),0)::numeric(16,2) total_amount,
      count(payslip.id) filter(
        where payslip.identity_match_state = 'employee'
          and payslip.employee_id is not null
          and coalesce(lower(btrim(employee.status::text)),'') in ('active','probation')
      )::integer active_count,
      count(payslip.id) filter(
        where payslip.identity_match_state = 'employee'
          and payslip.employee_id is not null
          and coalesce(lower(btrim(employee.status::text)),'') not in ('active','probation','resigned')
      )::integer suspended_count,
      count(payslip.id) filter(
        where payslip.identity_match_state = 'historical_resigned'
          or (payslip.identity_match_state = 'employee'
            and coalesce(lower(btrim(employee.status::text)),'') = 'resigned')
      )::integer resigned_count,
      count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unresolved_count
    from public.payroll_batches batch
    left join public.payroll_payslips payslip
      on payslip.batch_id = batch.id
     and (
       v_full_scope
       or (
         payslip.identity_match_state <> 'unmatched'
         and payslip.employee_id is not null
         and public.can_manage_employee(payslip.employee_id)
       )
     )
    left join public.employees employee on employee.id = payslip.employee_id
    where (p_status is null or batch.status = p_status)
      and (v_full_scope or payslip.id is not null)
    group by batch.id
    order by batch.period_start desc,batch.created_at desc,batch.id desc
    limit 36
  ) batch_data;

  if v_selected is not null then
    select to_jsonb(batch_data) into v_selected_batch
    from (
      select batch.id,batch.period_start,batch.title,batch.currency,batch.status,
        batch.source_type,batch.source_file_name,batch.created_at,batch.published_at,
        count(payslip.id)::integer row_count,
        count(payslip.id) filter(where payslip.identity_match_state <> 'unmatched')::integer matched_count,
        count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unmatched_count,
        coalesce(sum(payslip.total_pay),0)::numeric(16,2) total_amount,
        count(payslip.id) filter(
          where payslip.identity_match_state = 'employee'
            and payslip.employee_id is not null
            and coalesce(lower(btrim(employee.status::text)),'') in ('active','probation')
        )::integer active_count,
        count(payslip.id) filter(
          where payslip.identity_match_state = 'employee'
            and payslip.employee_id is not null
            and coalesce(lower(btrim(employee.status::text)),'') not in ('active','probation','resigned')
        )::integer suspended_count,
        count(payslip.id) filter(
          where payslip.identity_match_state = 'historical_resigned'
            or (payslip.identity_match_state = 'employee'
              and coalesce(lower(btrim(employee.status::text)),'') = 'resigned')
        )::integer resigned_count,
        count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unresolved_count
      from public.payroll_batches batch
      left join public.payroll_payslips payslip
        on payslip.batch_id = batch.id
       and (
         v_full_scope
         or (
           payslip.identity_match_state <> 'unmatched'
           and payslip.employee_id is not null
           and public.can_manage_employee(payslip.employee_id)
         )
       )
      left join public.employees employee on employee.id = payslip.employee_id
      where batch.id = v_selected
        and (p_status is null or batch.status = p_status)
      group by batch.id
    ) batch_data;
  end if;

  if p_include_rows and v_selected is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',payslip.id,'source_row',payslip.source_row,
      'employee_id',payslip.employee_id,
      'employee_no',payslip.employee_no_raw,'full_name',payslip.full_name,
      'platform',payslip.platform,'source_group',payslip.source_group,
      'position_name',payslip.position_name,'hire_date',payslip.hire_date,
      'departure_date',payslip.departure_date,'card_number',payslip.card_number,
      'payment_name',payslip.payment_name,'payment_method',payslip.payment_method,
      'base_salary',payslip.base_salary,'attendance_salary',payslip.attendance_salary,
      'leave_deduction',payslip.leave_deduction,'late_deduction',payslip.late_deduction,
      'absence_deduction',payslip.absence_deduction,
      'increment_adjustment',payslip.increment_adjustment,
      'attendance_bonus',payslip.attendance_bonus,
      'performance_adjustment',payslip.performance_adjustment,
      'deposit_adjustment',payslip.deposit_adjustment,
      'overtime_bonus',payslip.overtime_bonus,'extra_adjustment',payslip.extra_adjustment,
      'next_deduction',payslip.next_deduction,
      'overpayment_deduction',payslip.overpayment_deduction,
      'other_adjustment',payslip.other_adjustment,'total_pay',payslip.total_pay,
      'remark',payslip.remark,
      'matched',payslip.identity_match_state <> 'unmatched',
      'identity_match_state',payslip.identity_match_state,
      'published_to_staff',payslip.published_to_staff,
      'publish_exclusion_reason',payslip.publish_exclusion_reason,
      'employee_status',employee.status,
      'match_state',case
        when payslip.identity_match_state = 'historical_resigned' then 'historical_resigned'
        when payslip.identity_match_state = 'unmatched' then 'unmatched'
        when coalesce(lower(btrim(employee.status::text)),'') = 'resigned' then 'resigned'
        when coalesce(lower(btrim(employee.status::text)),'') in ('active','probation') then 'active'
        else 'suspended'
      end
    ) order by payslip.source_row),'[]'::jsonb) into v_rows
    from public.payroll_payslips payslip
    left join public.employees employee on employee.id = payslip.employee_id
    where payslip.batch_id = v_selected
      and (
        v_full_scope
        or (
          payslip.identity_match_state <> 'unmatched'
          and payslip.employee_id is not null
          and public.can_manage_employee(payslip.employee_id)
        )
      );
  end if;

  return jsonb_build_object(
    'batches',v_batches,
    'selected_batch',v_selected_batch,
    'rows',v_rows
  );
end;
$$;
revoke all on function payroll_private.admin_payroll_granular_page(text,bigint,boolean)
  from public,anon,authenticated;

create function public.admin_payroll_pending_page(p_batch_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb; v_full_scope boolean;
begin
  if not public.has_permission('payroll.pending.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v := payroll_private.admin_payroll_granular_page('draft',p_batch_id,true);
  return v || jsonb_build_object('permissions',jsonb_build_object(
    'edit',v_full_scope and public.has_permission('payroll.pending.edit'),
    'approve',v_full_scope and public.has_permission('payroll.pending.approve'),
    'publish',v_full_scope and public.has_permission('payroll.pending.publish'),
    'export',false
  ));
end $$;

create function public.admin_payroll_published_page(p_batch_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb;
begin
  if not public.has_permission('payroll.published.view') then raise exception 'permission_denied'; end if;
  v := payroll_private.admin_payroll_granular_page('published',p_batch_id,true);
  return v || jsonb_build_object('permissions',jsonb_build_object(
    'edit',false,'approve',false,'publish',false,
    'export',public.has_permission('payroll.published.export')
  ));
end $$;

create function public.admin_payroll_import_history_page(p_batch_id bigint default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v jsonb; v_full_scope boolean;
begin
  if not public.has_permission('payroll.import_history.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v := payroll_private.admin_payroll_granular_page(
    null,p_batch_id,p_batch_id is not null and p_batch_id > 0
  );
  return v || jsonb_build_object('permissions',jsonb_build_object(
    'edit',v_full_scope and public.has_permission('payroll.import_history.edit'),
    'approve',false,'publish',false,'export',false
  ));
end $$;

revoke all on function public.admin_payroll_pending_page(bigint),public.admin_payroll_published_page(bigint),public.admin_payroll_import_history_page(bigint) from public,anon,authenticated;
grant execute on function public.admin_payroll_pending_page(bigint),public.admin_payroll_published_page(bigint),public.admin_payroll_import_history_page(bigint) to authenticated,service_role;

-- The legacy transaction implementations remain private, but their original
-- permission guards must recognize the new page-owned action too. Otherwise a
-- user override or a direct SQL role edit can make the visible granular grant
-- say "allowed" while the transaction still fails on a hidden legacy code.
do $permission_bridge$
declare
  v_definition text;
  v_old text;
begin
  select pg_get_functiondef('payroll_private.admin_payroll_import(jsonb,jsonb)'::regprocedure)
    into v_definition;
  v_old := 'if not public.has_permission(''payroll.edit'') then raise exception ''permission_denied''; end if;';
  if strpos(v_definition,v_old) = 0 then
    raise exception 'payroll_import_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,v_old,
    'if not (public.has_permission(''payroll.edit'') or public.has_permission(''payroll.import_history.edit'')) then raise exception ''permission_denied''; end if;');

  select pg_get_functiondef('payroll_private.admin_payroll_publish(bigint)'::regprocedure)
    into v_definition;
  v_old := 'if not public.has_permission(''payroll.publish'') then raise exception ''permission_denied''; end if;';
  if strpos(v_definition,v_old) = 0 then
    raise exception 'payroll_publish_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,v_old,
    'if not (public.has_permission(''payroll.publish'') or public.has_permission(''payroll.pending.publish'')) then raise exception ''permission_denied''; end if;');

  select pg_get_functiondef('payroll_private.admin_payroll_delete(bigint)'::regprocedure)
    into v_definition;
  v_old := 'if not public.has_permission(''payroll.edit'') then raise exception ''permission_denied''; end if;';
  if strpos(v_definition,v_old) = 0 then
    raise exception 'payroll_delete_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,v_old,
    'if not (public.has_permission(''payroll.edit'') or public.has_permission(''payroll.pending.edit'')) then raise exception ''permission_denied''; end if;');
end;
$permission_bridge$;
revoke all on function payroll_private.admin_payroll_import(jsonb,jsonb),
  payroll_private.admin_payroll_publish(bigint),
  payroll_private.admin_payroll_delete(bigint)
  from public,anon,authenticated;

alter function public.admin_payroll_import(jsonb,jsonb) rename to admin_payroll_import_granular_v1;
revoke all on function public.admin_payroll_import_granular_v1(jsonb,jsonb) from public,anon,authenticated;
create function public.admin_payroll_import(p_batch jsonb,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_safe_batch jsonb;
  v_result jsonb;
begin
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  if jsonb_typeof(p_batch) <> 'object' then raise exception 'invalid_batch'; end if;
  if nullif(btrim(coalesce(p_batch->>'id','')),'') is not null then
    raise exception 'import_batch_id_not_allowed';
  end if;
  v_safe_batch := jsonb_build_object(
    'period_start',p_batch->'period_start',
    'title',p_batch->'title',
    'currency',p_batch->'currency',
    'source_type','upload',
    'source_file_name',p_batch->'source_file_name',
    'notes',p_batch->'notes'
  );
  v_result := public.admin_payroll_import_granular_v1(v_safe_batch,p_rows);
  return jsonb_build_object(
    'batch_id',v_result->'batch_id','rows',v_result->'rows',
    'matched',v_result->'matched','unmatched',v_result->'unmatched',
    'resigned',v_result->'resigned'
  );
end $$;

alter function public.admin_payroll_publish(bigint) rename to admin_payroll_publish_granular_v1;
revoke all on function public.admin_payroll_publish_granular_v1(bigint) from public,anon,authenticated;
create function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  if not public.has_permission('payroll.pending.publish') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  v_result := public.admin_payroll_publish_granular_v1(p_batch_id);
  return jsonb_build_object(
    'batch_id',v_result->'batch_id','status',v_result->'status',
    'rows',v_result->'rows','excluded_rows',v_result->'excluded_rows',
    'resigned',v_result->'resigned','unmatched',v_result->'unmatched'
  );
end $$;

alter function public.admin_payroll_delete(bigint) rename to admin_payroll_delete_granular_v1;
revoke all on function public.admin_payroll_delete_granular_v1(bigint) from public,anon,authenticated;
create function public.admin_payroll_delete(p_batch_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_status text;
  v_result jsonb;
begin
  if not public.has_permission('payroll.pending.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  select batch.status into v_status
  from public.payroll_batches batch
  where batch.id = p_batch_id
  for update;
  if not found or v_status <> 'draft' then raise exception 'only_draft_batch_can_be_deleted'; end if;
  v_result := public.admin_payroll_delete_granular_v1(p_batch_id);
  return jsonb_build_object(
    'batch_id',v_result->'batch_id','deleted',v_result->'deleted','rows',v_result->'rows'
  );
end $$;

revoke all on function public.admin_payroll_import(jsonb,jsonb),public.admin_payroll_publish(bigint),public.admin_payroll_delete(bigint) from public,anon,authenticated;
grant execute on function public.admin_payroll_import(jsonb,jsonb),public.admin_payroll_publish(bigint),public.admin_payroll_delete(bigint) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
