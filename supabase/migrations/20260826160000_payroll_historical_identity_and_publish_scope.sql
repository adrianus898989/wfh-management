-- Make payroll identity and staff-publication state explicit.
-- Historical employees stay detached from public.employees: exact lifecycle IDs
-- are classified for audit, but are never made visible in the staff portal.

alter table public.payroll_payslips
  add column if not exists identity_match_state text not null default 'unmatched',
  add column if not exists identity_match_source text,
  add column if not exists published_to_staff boolean not null default false,
  add column if not exists publish_exclusion_reason text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'payroll_payslips_identity_match_state_check'
      and conrelid = 'public.payroll_payslips'::regclass
  ) then
    alter table public.payroll_payslips
      add constraint payroll_payslips_identity_match_state_check
      check (identity_match_state in ('employee','historical_resigned','unmatched'));
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'payroll_payslips_publish_exclusion_reason_check'
      and conrelid = 'public.payroll_payslips'::regclass
  ) then
    alter table public.payroll_payslips
      add constraint payroll_payslips_publish_exclusion_reason_check
      check (publish_exclusion_reason is null or publish_exclusion_reason in (
        'resigned','suspended','inactive','unmatched'
      ));
  end if;
end;
$$;

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
    select batch.id into v_selected
    from public.payroll_batches batch
    order by batch.period_start desc, batch.created_at desc, batch.id desc
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
      select jsonb_agg(to_jsonb(row_data) order by row_data.period_start desc,row_data.created_at desc,row_data.id desc)
      from (
        select batch.id,batch.period_start,batch.title,batch.currency,batch.status,
          batch.source_type,batch.source_file_name,batch.notes,batch.created_at,batch.published_at,
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
               or (
                 payslip.identity_match_state = 'employee'
                 and coalesce(lower(btrim(employee.status::text)),'') = 'resigned'
               )
          )::integer resigned_count,
          count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unresolved_count
        from public.payroll_batches batch
        left join public.payroll_payslips payslip on payslip.batch_id = batch.id
        left join public.employees employee on employee.id = payslip.employee_id
        group by batch.id
        order by batch.period_start desc,batch.created_at desc,batch.id desc
        limit 36
      ) row_data
    ),'[]'::jsonb),
    'selected_batch',(
      select to_jsonb(row_data)
      from (
        select batch.id,batch.period_start,batch.title,batch.currency,batch.status,
          batch.source_type,batch.source_file_name,batch.notes,batch.created_at,batch.published_at,
          count(payslip.id)::integer row_count,
          count(payslip.id) filter(where payslip.identity_match_state <> 'unmatched')::integer matched_count,
          count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unmatched_count,
          count(payslip.id) filter(where payslip.identity_match_state = 'unmatched')::integer unresolved_count,
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
               or (
                 payslip.identity_match_state = 'employee'
                 and coalesce(lower(btrim(employee.status::text)),'') = 'resigned'
               )
          )::integer resigned_count
        from public.payroll_batches batch
        left join public.payroll_payslips payslip on payslip.batch_id = batch.id
        left join public.employees employee on employee.id = payslip.employee_id
        where batch.id = v_selected
        group by batch.id
      ) row_data
    ),
    'rows',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',payslip.id,'employee_id',payslip.employee_id,
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
        'line_items',payslip.line_items,'remark',payslip.remark,
        'source_row',payslip.source_row,
        'matched',payslip.identity_match_state <> 'unmatched',
        'identity_match_state',payslip.identity_match_state,
        'identity_match_source',payslip.identity_match_source,
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
      ) order by payslip.source_row)
      from public.payroll_payslips payslip
      left join public.employees employee on employee.id = payslip.employee_id
      where payslip.batch_id = v_selected
    ),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function payroll_private.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_period date;
  v_total integer;
  v_publishable integer;
  v_excluded integer;
  v_resigned integer;
  v_unmatched integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.publish') then raise exception 'permission_denied'; end if;

  select batch.period_start into v_period
  from public.payroll_batches batch
  where batch.id = p_batch_id and batch.status = 'draft'
  for update;
  if not found then raise exception 'batch_not_publishable'; end if;

  update public.payroll_payslips payslip
  set published_to_staff = (
        payslip.identity_match_state = 'employee'
        and payslip.employee_id is not null
        and coalesce(lower(btrim(employee.status::text)),'') in ('active','probation')
      ),
      publish_exclusion_reason = case
        when payslip.identity_match_state = 'unmatched' then 'unmatched'
        when payslip.identity_match_state = 'historical_resigned'
          or coalesce(lower(btrim(employee.status::text)),'') = 'resigned' then 'resigned'
        when coalesce(lower(btrim(employee.status::text)),'') = 'suspended' then 'suspended'
        when coalesce(lower(btrim(employee.status::text)),'') = 'inactive' then 'inactive'
        when coalesce(lower(btrim(employee.status::text)),'') not in ('active','probation') then 'inactive'
        else null
      end,
      updated_at = clock_timestamp()
  from public.employees employee
  where payslip.batch_id = p_batch_id
    and employee.id = payslip.employee_id;

  -- Null employee IDs do not participate in the UPDATE ... FROM above.
  update public.payroll_payslips payslip
  set published_to_staff = false,
      publish_exclusion_reason = case
        when payslip.identity_match_state = 'historical_resigned' then 'resigned'
        else 'unmatched'
      end,
      updated_at = clock_timestamp()
  where payslip.batch_id = p_batch_id
    and payslip.employee_id is null;

  select count(*)::integer,
    count(*) filter(where payslip.published_to_staff)::integer,
    count(*) filter(where not payslip.published_to_staff)::integer,
    count(*) filter(where payslip.publish_exclusion_reason = 'resigned')::integer,
    count(*) filter(where payslip.publish_exclusion_reason = 'unmatched')::integer
  into v_total,v_publishable,v_excluded,v_resigned,v_unmatched
  from public.payroll_payslips payslip
  where payslip.batch_id = p_batch_id;

  if coalesce(v_total,0) = 0 then raise exception 'empty_batch'; end if;
  if coalesce(v_publishable,0) = 0 then raise exception 'no_publishable_payslips'; end if;

  update public.payroll_batches
  set status = 'archived', updated_at = clock_timestamp()
  where period_start = v_period and status = 'published' and id <> p_batch_id;

  update public.payroll_batches
  set status = 'published', published_by = v_user,
      published_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = p_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'publish',jsonb_build_object(
    'rows',v_publishable,'excluded_rows',v_excluded,'resigned',v_resigned,
    'unmatched',v_unmatched,'period_start',v_period
  ));

  return jsonb_build_object(
    'batch_id',p_batch_id,'status','published','rows',v_publishable,
    'excluded_rows',v_excluded,'resigned',v_resigned,'unmatched',v_unmatched
  );
end;
$$;

create or replace function payroll_private.staff_payroll_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select access.employee_id into v_employee_id
  from public.user_access access
  join public.employees employee on employee.id = access.employee_id
    and lower(btrim(employee.status::text)) in ('active','probation')
  where access.auth_user_id = v_user
    and access.active = true
    and access.employee_portal_enabled = true
  limit 1;
  if v_employee_id is null then raise exception 'employee_portal_disabled'; end if;

  select jsonb_build_object(
    'employee',jsonb_build_object(
      'id',employee.id,'employee_no',employee.employee_no,'full_name',employee.full_name,
      'platform',employee.platform_scope,
      'position_name',coalesce(position.name,employee.schedule_position),
      'team_name',team.name,'hire_date',employee.hire_date,
      'payment_method',coalesce(profile.payment_mode,profile.transfer_using),
      'payment_name',coalesce(profile.gcash_name,employee.full_name)
    ),
    'history',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',payslip.id,'period_start',payslip.period_start,'title',batch.title,
        'currency',batch.currency,'published_at',batch.published_at,
        'base_salary',payslip.base_salary,'attendance_salary',payslip.attendance_salary,
        'leave_deduction',payslip.leave_deduction,'late_deduction',payslip.late_deduction,
        'absence_deduction',payslip.absence_deduction,
        'performance_adjustment',payslip.performance_adjustment,
        'deposit_adjustment',payslip.deposit_adjustment,
        'overtime_bonus',payslip.overtime_bonus,'other_adjustment',payslip.other_adjustment,
        'total_pay',payslip.total_pay,'remark',payslip.remark,'source_type',batch.source_type
      ) order by payslip.period_start desc,payslip.id desc)
      from public.payroll_payslips payslip
      join public.payroll_batches batch on batch.id = payslip.batch_id and batch.status = 'published'
      where payslip.employee_id = v_employee_id
        and payslip.identity_match_state = 'employee'
        and payslip.published_to_staff
    ),'[]'::jsonb)
  ) into v_result
  from public.employees employee
  left join public.teams team on team.id = employee.team_id
  left join public.positions position on position.id = employee.position_id
  left join public.employee_payment_profiles profile on profile.employee_id = employee.id
  where employee.id = v_employee_id;
  return coalesce(v_result,jsonb_build_object('employee',null,'history','[]'::jsonb));
end;
$$;

create or replace function payroll_private.staff_payroll_detail(p_payslip_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select access.employee_id into v_employee_id
  from public.user_access access
  join public.employees employee on employee.id = access.employee_id
    and lower(btrim(employee.status::text)) in ('active','probation')
  where access.auth_user_id = v_user
    and access.active = true
    and access.employee_portal_enabled = true
  limit 1;
  if v_employee_id is null then raise exception 'employee_portal_disabled'; end if;

  select jsonb_build_object(
    'id',payslip.id,'period_start',payslip.period_start,'title',batch.title,
    'currency',batch.currency,'published_at',batch.published_at,
    'employee',jsonb_build_object(
      'employee_no',payslip.employee_no_raw,'full_name',payslip.full_name,
      'platform',payslip.platform,'position_name',payslip.position_name,
      'hire_date',payslip.hire_date,'card_number',payslip.card_number,
      'payment_name',payslip.payment_name,'payment_method',payslip.payment_method
    ),
    'base_salary',payslip.base_salary,'attendance_salary',payslip.attendance_salary,
    'leave_deduction',payslip.leave_deduction,'late_deduction',payslip.late_deduction,
    'absence_deduction',payslip.absence_deduction,
    'performance_adjustment',payslip.performance_adjustment,
    'deposit_adjustment',payslip.deposit_adjustment,
    'overtime_bonus',payslip.overtime_bonus,'other_adjustment',payslip.other_adjustment,
    'total_pay',payslip.total_pay,'line_items',payslip.line_items,
    'remark',payslip.remark,'source_type',batch.source_type
  ) into v_result
  from public.payroll_payslips payslip
  join public.payroll_batches batch on batch.id = payslip.batch_id and batch.status = 'published'
  where payslip.id = p_payslip_id
    and payslip.employee_id = v_employee_id
    and payslip.identity_match_state = 'employee'
    and payslip.published_to_staff;
  if v_result is null then raise exception 'payslip_not_found'; end if;
  return v_result;
end;
$$;

revoke all on function payroll_private.admin_payroll_import(jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_home(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_publish(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_home()
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_detail(bigint)
  from public, anon, authenticated;

comment on column public.payroll_payslips.identity_match_state is
  'Import-time identity result: current employee, exact historical resignation, or unresolved.';
comment on column public.payroll_payslips.published_to_staff is
  'Frozen publication decision. Backend history is retained even when a row is excluded from staff.';

notify pgrst,'reload schema';

create index if not exists payroll_payslips_batch_identity_state_idx
  on public.payroll_payslips (batch_id, identity_match_state, source_row);
create index if not exists payroll_payslips_staff_published_idx
  on public.payroll_payslips (employee_id, period_start desc)
  where published_to_staff;

create or replace function payroll_private.resolve_historical_resigned_identity(
  p_employee_no text
)
returns table(match_source text, resignation_date date)
language sql
stable
security definer
set search_path = ''
as $$
  with latest as (
    select lifecycle.event_type, lifecycle.effective_date
    from public.employee_lifecycle_events lifecycle
    where internal.payroll_employee_no_key(lifecycle.employee_no)
          = internal.payroll_employee_no_key(p_employee_no)
      and internal.payroll_employee_no_key(p_employee_no) <> ''
      and lifecycle.note is distinct from '__VOIDED__'
      and lifecycle.event_type in ('join','resign','reactivate')
    order by
      coalesce(lifecycle.effective_date, lifecycle.created_at::date) desc,
      case lifecycle.event_type
        when 'reactivate' then 3
        when 'resign' then 2
        when 'join' then 1
        else 0
      end desc,
      lifecycle.created_at desc,
      lifecycle.id desc
    limit 1
  )
  select 'employee_lifecycle'::text, latest.effective_date
  from latest
  where latest.event_type = 'resign';
$$;

revoke all on function payroll_private.resolve_historical_resigned_identity(text)
  from public, anon, authenticated;

create or replace function payroll_private.classify_payroll_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history record;
  v_raw_departure text := coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,departure_date}', ''),
    nullif(new.raw_payload->>'离职日期', '')
  );
begin
  if new.departure_date is null and v_raw_departure ~ '^\d{4}-\d{2}-\d{2}$' then
    new.departure_date := v_raw_departure::date;
  end if;

  if new.employee_id is not null then
    new.identity_match_state := 'employee';
    new.identity_match_source := 'employees';
  else
    select history.match_source, history.resignation_date
    into v_history
    from payroll_private.resolve_historical_resigned_identity(new.employee_no_raw) history
    limit 1;

    if found then
      new.identity_match_state := 'historical_resigned';
      new.identity_match_source := v_history.match_source;
      new.departure_date := coalesce(new.departure_date, v_history.resignation_date);
    elsif new.departure_date is not null then
      new.identity_match_state := 'historical_resigned';
      new.identity_match_source := 'uploaded_departure';
    else
      new.identity_match_state := 'unmatched';
      new.identity_match_source := null;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function payroll_private.classify_payroll_identity()
  from public, anon, authenticated;

drop trigger if exists payroll_identity_state_fill on public.payroll_payslips;
create trigger payroll_identity_state_fill
before insert or update of employee_id, employee_no_raw, departure_date, raw_payload
on public.payroll_payslips
for each row execute function payroll_private.classify_payroll_identity();

-- Backfill without fabricating employee UUIDs for deleted historical people.
update public.payroll_payslips payslip
set identity_match_state = 'employee',
    identity_match_source = 'employees'
where payslip.employee_id is not null;

update public.payroll_payslips payslip
set identity_match_state = 'historical_resigned',
    identity_match_source = coalesce((
      select history.match_source
      from payroll_private.resolve_historical_resigned_identity(payslip.employee_no_raw) history
      limit 1
    ), 'uploaded_departure'),
    departure_date = coalesce(payslip.departure_date, (
      select history.resignation_date
      from payroll_private.resolve_historical_resigned_identity(payslip.employee_no_raw) history
      limit 1
    ))
where payslip.employee_id is null
  and (
    payslip.departure_date is not null
    or exists (
      select 1
      from payroll_private.resolve_historical_resigned_identity(payslip.employee_no_raw)
    )
  );

update public.payroll_payslips payslip
set identity_match_state = 'unmatched',
    identity_match_source = null
where payslip.employee_id is null
  and payslip.departure_date is null
  and not exists (
    select 1
    from payroll_private.resolve_historical_resigned_identity(payslip.employee_no_raw)
  );

-- Preserve batches that were already published before this policy existed.
-- Future publications freeze an explicit per-payslip eligibility decision.
update public.payroll_payslips payslip
set published_to_staff = (payslip.employee_id is not null),
    publish_exclusion_reason = case
      when payslip.employee_id is null then
        case when payslip.identity_match_state = 'historical_resigned'
          then 'resigned' else 'unmatched' end
      else null
    end
from public.payroll_batches batch
where batch.id = payslip.batch_id
  and batch.status = 'published';

update public.payroll_batches batch
set row_count = counts.row_count,
    matched_count = counts.matched_count,
    unmatched_count = counts.unmatched_count,
    updated_at = clock_timestamp()
from (
  select payslip.batch_id,
    count(*)::integer row_count,
    count(*) filter(where payslip.identity_match_state <> 'unmatched')::integer matched_count,
    count(*) filter(where payslip.identity_match_state = 'unmatched')::integer unmatched_count
  from public.payroll_payslips payslip
  group by payslip.batch_id
) counts
where batch.id = counts.batch_id;

create or replace function payroll_private.admin_payroll_import(
  p_batch jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_batch_id bigint;
  v_period date;
  v_row jsonb;
  v_employee_id uuid;
  v_employee_status text;
  v_employee_resign_date date;
  v_employee_key text;
  v_name_key text;
  v_name_match_count integer;
  v_row_count integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_resigned integer := 0;
  v_source_row integer;
  v_identity_state text;
  v_identity_source text;
  v_resignation_date date;
  v_raw_departure text;
  v_history record;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.edit') then raise exception 'permission_denied'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'empty_rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows'; end if;

  v_period := date_trunc('month', coalesce(nullif(p_batch->>'period_start','')::date, current_date))::date;
  v_batch_id := nullif(p_batch->>'id','')::bigint;

  if v_batch_id is not null then
    perform 1 from public.payroll_batches batch
    where batch.id = v_batch_id and batch.status = 'draft'
    for update;
    if not found then raise exception 'batch_not_editable'; end if;
    update public.payroll_batches set
      period_start = v_period,
      title = coalesce(nullif(trim(p_batch->>'title'),''), to_char(v_period,'YYYY-MM')),
      currency = upper(coalesce(nullif(trim(p_batch->>'currency'),''),'USD')),
      source_type = coalesce(nullif(trim(p_batch->>'source_type'),''),'upload'),
      source_file_name = nullif(trim(p_batch->>'source_file_name'),''),
      source_project_ref = nullif(trim(p_batch->>'source_project_ref'),''),
      source_batch_key = nullif(trim(p_batch->>'source_batch_key'),''),
      notes = nullif(trim(p_batch->>'notes'),''),
      updated_at = clock_timestamp()
    where id = v_batch_id;
    delete from public.payroll_payslips where batch_id = v_batch_id;
  else
    insert into public.payroll_batches (
      period_start,title,currency,source_type,source_file_name,
      source_project_ref,source_batch_key,notes,created_by
    ) values (
      v_period,
      coalesce(nullif(trim(p_batch->>'title'),''), to_char(v_period,'YYYY-MM')),
      upper(coalesce(nullif(trim(p_batch->>'currency'),''),'USD')),
      coalesce(nullif(trim(p_batch->>'source_type'),''),'upload'),
      nullif(trim(p_batch->>'source_file_name'),''),
      nullif(trim(p_batch->>'source_project_ref'),''),
      nullif(trim(p_batch->>'source_batch_key'),''),
      nullif(trim(p_batch->>'notes'),''),
      v_user
    ) returning id into v_batch_id;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_count := v_row_count + 1;
    v_source_row := coalesce(nullif(v_row->>'source_row','')::integer, v_row_count + 1);
    v_employee_key := internal.payroll_employee_no_key(v_row->>'employee_no');
    v_name_key := internal.payroll_name_key(v_row->>'full_name');
    v_employee_id := null;
    v_employee_status := null;
    v_employee_resign_date := null;
    v_identity_state := 'unmatched';
    v_identity_source := null;
    v_resignation_date := null;
    v_raw_departure := coalesce(
      nullif(v_row->>'departure_date',''),
      nullif(v_row#>>'{raw_payload,__payroll_fields,departure_date}',''),
      nullif(v_row#>>'{raw_payload,离职日期}','')
    );
    if v_raw_departure ~ '^\d{4}-\d{2}-\d{2}$' then
      v_resignation_date := v_raw_departure::date;
    end if;

    if v_employee_key <> '' then
      select employee.id, lower(btrim(employee.status::text)), employee.resign_date
      into v_employee_id, v_employee_status, v_employee_resign_date
      from public.employees employee
      where internal.payroll_employee_no_key(employee.employee_no) = v_employee_key
      order by case when lower(btrim(employee.status::text)) in ('active','probation') then 0 else 1 end,
        employee.updated_at desc
      limit 1;
    end if;

    -- Keep the legacy unique-name fallback only when the workbook did not
    -- provide an employee number. An unknown non-empty ID must stay unresolved.
    if v_employee_id is null and v_employee_key = '' and v_name_key <> '' then
      select count(*), (array_agg(employee.id order by employee.updated_at desc))[1]
      into v_name_match_count, v_employee_id
      from public.employees employee
      where internal.payroll_name_key(employee.full_name) = v_name_key;
      if v_name_match_count = 1 then
        select lower(btrim(employee.status::text)), employee.resign_date
        into v_employee_status, v_employee_resign_date
        from public.employees employee where employee.id = v_employee_id;
      else
        v_employee_id := null;
      end if;
    end if;

    if v_employee_id is not null then
      v_identity_state := 'employee';
      v_identity_source := 'employees';
      v_resignation_date := coalesce(v_resignation_date, v_employee_resign_date);
      v_matched := v_matched + 1;
      if v_employee_status = 'resigned' then v_resigned := v_resigned + 1; end if;
    else
      select history.match_source, history.resignation_date
      into v_history
      from payroll_private.resolve_historical_resigned_identity(v_row->>'employee_no') history
      limit 1;
      if found then
        v_identity_state := 'historical_resigned';
        v_identity_source := v_history.match_source;
        v_resignation_date := coalesce(v_resignation_date, v_history.resignation_date);
        v_matched := v_matched + 1;
        v_resigned := v_resigned + 1;
      elsif v_resignation_date is not null then
        v_identity_state := 'historical_resigned';
        v_identity_source := 'uploaded_departure';
        v_matched := v_matched + 1;
        v_resigned := v_resigned + 1;
      else
        v_unmatched := v_unmatched + 1;
      end if;
    end if;

    insert into public.payroll_payslips (
      batch_id,period_start,employee_id,employee_no_raw,employee_no_key,full_name,
      platform,position_name,hire_date,departure_date,card_number,payment_name,
      payment_method,base_salary,attendance_salary,leave_deduction,late_deduction,
      absence_deduction,performance_adjustment,deposit_adjustment,overtime_bonus,
      other_adjustment,total_pay,line_items,remark,source_row,external_record_id,
      raw_payload,identity_match_state,identity_match_source,
      published_to_staff,publish_exclusion_reason
    ) values (
      v_batch_id,v_period,v_employee_id,nullif(trim(v_row->>'employee_no'),''),nullif(v_employee_key,''),
      coalesce(nullif(trim(v_row->>'full_name'),''),'未填写姓名'),nullif(trim(v_row->>'platform'),''),
      nullif(trim(v_row->>'position_name'),''),nullif(v_row->>'hire_date','')::date,
      v_resignation_date,nullif(trim(v_row->>'card_number'),''),nullif(trim(v_row->>'payment_name'),''),
      nullif(trim(v_row->>'payment_method'),''),internal.payroll_number(v_row->>'base_salary'),
      internal.payroll_number(v_row->>'attendance_salary'),internal.payroll_number(v_row->>'leave_deduction'),
      internal.payroll_number(v_row->>'late_deduction'),internal.payroll_number(v_row->>'absence_deduction'),
      internal.payroll_number(v_row->>'performance_adjustment'),internal.payroll_number(v_row->>'deposit_adjustment'),
      internal.payroll_number(v_row->>'overtime_bonus'),internal.payroll_number(v_row->>'other_adjustment'),
      internal.payroll_number(v_row->>'total_pay'),
      case when jsonb_typeof(v_row->'line_items')='array' then v_row->'line_items' else '[]'::jsonb end,
      nullif(trim(v_row->>'remark'),''),v_source_row,nullif(trim(v_row->>'external_record_id'),''),
      case when jsonb_typeof(v_row->'raw_payload')='object' then v_row->'raw_payload' else '{}'::jsonb end,
      v_identity_state,v_identity_source,false,null
    );
  end loop;

  update public.payroll_batches set
    row_count = v_row_count,
    matched_count = v_matched,
    unmatched_count = v_unmatched,
    updated_at = clock_timestamp()
  where id = v_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(v_batch_id,v_user,'import',jsonb_build_object(
    'rows',v_row_count,'matched',v_matched,'unmatched',v_unmatched,'resigned',v_resigned
  ));

  return jsonb_build_object(
    'batch_id',v_batch_id,'rows',v_row_count,'matched',v_matched,
    'unmatched',v_unmatched,'resigned',v_resigned
  );
end;
$$;

comment on function payroll_private.resolve_historical_resigned_identity(text) is
  'Exact normalized employee-number lookup against the latest non-voided lifecycle event; never recreates an employee FK.';

-- Reassert the private execution boundary after all CREATE OR REPLACE statements.
revoke all on function payroll_private.admin_payroll_import(jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_home(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_publish(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_home()
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_detail(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.resolve_historical_resigned_identity(text)
  from public, anon, authenticated;
revoke all on function payroll_private.classify_payroll_identity()
  from public, anon, authenticated;

notify pgrst,'reload schema';
