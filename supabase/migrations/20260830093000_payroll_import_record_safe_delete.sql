begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Deleting an import record is intentionally independent from editing it.
-- Do not copy this grant from legacy payroll.edit roles: Founder is implicit
-- and every other account must be granted this sensitive action explicitly.
insert into public.permissions(code,name,category,sensitive)
values('payroll.import_history.delete','删除工资导入记录','payroll',true)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

-- A published batch can be withdrawn as a recoverable business deletion.
-- Its prior lifecycle state must therefore remain representable for restore.
alter table public.payroll_batches
  drop constraint if exists payroll_batches_voided_prior_status_check;
alter table public.payroll_batches
  add constraint payroll_batches_voided_prior_status_check
  check (voided_prior_status is null or voided_prior_status in ('draft','published','archived'));

-- The history endpoint is deliberately bounded to 200 summaries.  These
-- partial indexes make its active/recycle-bin split selective before the
-- existing batch_id indexes aggregate payslips.
create index if not exists payroll_batches_active_history_idx
  on public.payroll_batches(period_start desc,created_at desc,id desc)
  where voided_at is null;
create index if not exists payroll_batches_deleted_history_idx
  on public.payroll_batches(period_start desc,created_at desc,id desc)
  where voided_at is not null;

-- The original page helper mixed voided rows into normal readers.  Keep a
-- single scoped implementation with an explicit deleted/active boundary so
-- pending, published and import-history defaults cannot leak recycle-bin rows.
create or replace function payroll_private.admin_payroll_granular_page_filtered(
  p_status text,
  p_batch_id bigint,
  p_include_rows boolean,
  p_deleted_only boolean
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
      and ((batch.voided_at is not null) = p_deleted_only)
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
      and ((batch.voided_at is not null) = p_deleted_only)
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
      and ((batch.voided_at is not null) = p_deleted_only)
      and (v_full_scope or payslip.id is not null)
    group by batch.id
    order by batch.period_start desc,batch.created_at desc,batch.id desc
    limit 200
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
        and ((batch.voided_at is not null) = p_deleted_only)
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

revoke all on function payroll_private.admin_payroll_granular_page_filtered(text,bigint,boolean,boolean)
  from public,anon,authenticated;

-- Compatibility readers remain active-only.  This is the safety boundary
-- used by pending and published pages as well as any older clients.
create or replace function payroll_private.admin_payroll_granular_page(
  p_status text,
  p_batch_id bigint,
  p_include_rows boolean
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select payroll_private.admin_payroll_granular_page_filtered(
    p_status,p_batch_id,p_include_rows,false
  );
$$;

revoke all on function payroll_private.admin_payroll_granular_page(text,bigint,boolean)
  from public,anon,authenticated;

create or replace function public.admin_payroll_pending_page(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare v_result jsonb; v_full_scope boolean; v_delete boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.pending.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v_delete := v_full_scope and (
    public.is_founder() or public.has_permission('payroll.import_history.delete')
  );
  v_result := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page('draft',p_batch_id,true)
  );
  return v_result || jsonb_build_object('permissions',jsonb_build_object(
    'edit',v_full_scope and public.has_permission('payroll.pending.edit'),
    'delete',v_delete,
    'approve',v_full_scope and public.has_permission('payroll.pending.approve'),
    'publish',v_full_scope and public.has_permission('payroll.pending.publish'),
    'export',false
  ));
end;
$$;

-- Import history returns active and recycle-bin summaries separately.  The
-- normal `batches` array therefore never contains a deleted record, while a
-- caller can deliberately select `deleted_batches` without another endpoint.
create or replace function public.admin_payroll_import_history_page(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_active jsonb;
  v_deleted jsonb;
  v_selected jsonb := 'null'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_full_scope boolean;
  v_edit boolean;
  v_delete boolean;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.view') then raise exception 'permission_denied'; end if;
  v_full_scope := payroll_private.admin_payroll_has_full_scope();
  v_edit := v_full_scope and public.has_permission('payroll.import_history.edit');
  v_delete := v_full_scope and (
    public.is_founder() or public.has_permission('payroll.import_history.delete')
  );

  v_active := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page_filtered(
      null,p_batch_id,p_batch_id is not null and p_batch_id > 0,false
    )
  );
  v_deleted := payroll_private.admin_payroll_enrich_page(
    payroll_private.admin_payroll_granular_page_filtered(
      null,p_batch_id,p_batch_id is not null and p_batch_id > 0,true
    )
  );

  if jsonb_typeof(v_active->'selected_batch') = 'object' then
    v_selected := v_active->'selected_batch';
    v_rows := coalesce(v_active->'rows','[]'::jsonb);
  elsif jsonb_typeof(v_deleted->'selected_batch') = 'object' then
    v_selected := v_deleted->'selected_batch';
    v_rows := coalesce(v_deleted->'rows','[]'::jsonb);
  end if;

  return jsonb_build_object(
    'batches',coalesce(v_active->'batches','[]'::jsonb),
    'deleted_batches',coalesce(v_deleted->'batches','[]'::jsonb),
    'selected_batch',v_selected,
    'rows',v_rows,
    'permissions',jsonb_build_object(
      'edit',v_edit,
      'delete',v_delete,
      'void',v_delete,
      'restore',v_delete,
      'clone_correction',v_edit,
      'approve',false,'publish',false,'export',false
    )
  );
end;
$$;

-- Internal mutation used only by permission-checking public wrappers.  The
-- batch and every payslip remain in place; status/void metadata implement the
-- recycle bin and the audit row preserves actor, time, reason and prior state.
create or replace function payroll_private.admin_payroll_soft_delete_record(
  p_batch_id bigint,
  p_reason text,
  p_confirmation text,
  p_expected_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_now timestamptz := clock_timestamp();
  v_expected_confirmation text;
begin
  if p_batch_id is null or p_batch_id <= 0 then raise exception 'invalid_batch_id'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'delete_reason_required'; end if;
  if length(btrim(p_reason)) > 1000 then raise exception 'delete_reason_too_long'; end if;

  select * into v_batch
  from public.payroll_batches batch
  where batch.id = p_batch_id
  for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.voided_at is not null then raise exception 'batch_already_deleted'; end if;
  if v_batch.status not in ('draft','published','archived') then raise exception 'unsupported_batch_status'; end if;
  if p_expected_status is not null and v_batch.status <> p_expected_status then
    raise exception 'unexpected_batch_status';
  end if;

  v_expected_confirmation := case
    when v_batch.status = 'published' then 'DELETE PUBLISHED #' || p_batch_id::text
    else 'DELETE #' || p_batch_id::text
  end;
  if coalesce(p_confirmation,'') <> v_expected_confirmation then
    raise exception 'delete_confirmation_mismatch';
  end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set status = 'archived',
      archived_at = case when v_batch.status = 'archived' then coalesce(batch.archived_at,v_now) else v_now end,
      archived_by = case when v_batch.status = 'archived' then batch.archived_by else v_user end,
      archived_by_name = case when v_batch.status = 'archived' then batch.archived_by_name else v_actor_name end,
      archive_reason = case when v_batch.status = 'archived' then batch.archive_reason else '业务删除（可恢复）' end,
      voided_at = v_now,
      voided_by = v_user,
      voided_by_name = v_actor_name,
      void_reason = btrim(p_reason),
      voided_prior_status = v_batch.status,
      updated_by = v_user,
      updated_by_name = v_actor_name,
      updated_at = v_now
  where batch.id = p_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'delete_import_record',jsonb_build_object(
    'actor_name',v_actor_name,
    'acted_at',v_now,
    'prior_status',v_batch.status,
    'reason',btrim(p_reason),
    'title',v_batch.title,
    'rows',v_batch.row_count,
    'recoverable',true,
    'physical_delete',false,
    'published_withdrawal',v_batch.status = 'published'
  ));

  return jsonb_build_object(
    'ok',true,
    'batch_id',p_batch_id,
    'deleted',true,
    'soft_deleted',true,
    'recoverable',true,
    'prior_status',v_batch.status,
    'status','archived',
    'rows',v_batch.row_count,
    'voided_at',v_now,
    'voided_by_name',v_actor_name,
    'void_reason',btrim(p_reason)
  );
end;
$$;

revoke all on function payroll_private.admin_payroll_soft_delete_record(bigint,text,text,text)
  from public,anon,authenticated;

create or replace function public.admin_payroll_delete_record(
  p_batch_id bigint,
  p_reason text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (
    public.is_founder() or public.has_permission('payroll.import_history.delete')
  ) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;

  return payroll_private.admin_payroll_soft_delete_record(
    p_batch_id,p_reason,p_confirmation,null
  );
end;
$$;

-- Retain legacy RPC names for an older deployed client, but route them through
-- the same database permission and soft-delete boundary.  Neither wrapper can
-- delete an unexpected lifecycle state.
create or replace function public.admin_payroll_delete(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (
    public.is_founder() or public.has_permission('payroll.import_history.delete')
  ) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  return payroll_private.admin_payroll_soft_delete_record(
    p_batch_id,'后台移除工资导入草稿','DELETE #' || p_batch_id::text,'draft'
  );
end;
$$;

create or replace function public.admin_payroll_void_batch(
  p_batch_id bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (
    public.is_founder() or public.has_permission('payroll.import_history.delete')
  ) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  return payroll_private.admin_payroll_soft_delete_record(
    p_batch_id,p_reason,'DELETE #' || p_batch_id::text,'archived'
  );
end;
$$;

create or replace function public.admin_payroll_restore_batch(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_restore_status text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not (
    public.is_founder()
    or public.has_permission('payroll.import_history.delete')
  ) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;

  select * into v_batch
  from public.payroll_batches batch
  where batch.id = p_batch_id
  for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.voided_at is null then raise exception 'batch_not_deleted'; end if;

  v_restore_status := case
    when v_batch.voided_prior_status in ('draft','published','archived')
      then v_batch.voided_prior_status
    else 'archived'
  end;
  if v_restore_status = 'published' and exists (
    select 1
    from public.payroll_batches conflict_batch
    where conflict_batch.id <> v_batch.id
      and conflict_batch.period_start = v_batch.period_start
      and conflict_batch.status = 'published'
      and conflict_batch.voided_at is null
  ) then
    raise exception 'published_restore_conflict';
  end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set status = v_restore_status,
      archived_at = case when v_restore_status = 'archived' then batch.archived_at else null end,
      archived_by = case when v_restore_status = 'archived' then batch.archived_by else null end,
      archived_by_name = case when v_restore_status = 'archived' then batch.archived_by_name else null end,
      archive_reason = case when v_restore_status = 'archived' then batch.archive_reason else null end,
      voided_at = null,
      voided_by = null,
      voided_by_name = null,
      void_reason = null,
      voided_prior_status = null,
      updated_by = v_user,
      updated_by_name = v_actor_name,
      updated_at = clock_timestamp()
  where batch.id = p_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'restore_deleted_import_record',jsonb_build_object(
    'actor_name',v_actor_name,
    'restored_status',v_restore_status,
    'previous_delete_reason',v_batch.void_reason,
    'deleted_by_name',v_batch.voided_by_name,
    'deleted_at',v_batch.voided_at
  ));

  return jsonb_build_object(
    'batch_id',p_batch_id,
    'restored',true,
    'status',v_restore_status,
    'updated_by_name',v_actor_name
  );
end;
$$;

revoke all on function public.admin_payroll_pending_page(bigint),
  public.admin_payroll_import_history_page(bigint),
  public.admin_payroll_delete_record(bigint,text,text),
  public.admin_payroll_delete(bigint),
  public.admin_payroll_void_batch(bigint,text),
  public.admin_payroll_restore_batch(bigint)
  from public,anon,authenticated;

grant execute on function public.admin_payroll_pending_page(bigint),
  public.admin_payroll_import_history_page(bigint),
  public.admin_payroll_delete_record(bigint,text,text),
  public.admin_payroll_delete(bigint),
  public.admin_payroll_void_batch(bigint,text),
  public.admin_payroll_restore_batch(bigint)
  to authenticated,service_role;

comment on function public.admin_payroll_delete_record(bigint,text,text) is
  'Permission-checked recoverable business deletion for draft, published or archived payroll imports; never removes batch, payslip or audit rows.';
comment on function public.admin_payroll_restore_batch(bigint) is
  'Restores a recoverably deleted payroll import to its prior lifecycle status, rejecting conflicting published restores.';

notify pgrst,'reload schema';
commit;
