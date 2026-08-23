-- Employee connectivity incidents and payroll administration controls.
-- Sensitive HR/payroll tables stay closed to direct Data API access; the app
-- uses narrowly scoped authenticated RPC wrappers.

create table if not exists public.employee_connectivity_incidents (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id) on delete cascade,
  incident_date date not null default current_date,
  incident_type text not null,
  started_at time,
  ended_at time,
  duration_minutes integer,
  work_impact text not null default 'interrupted',
  details text,
  evidence_url text,
  status text not null default 'reported',
  recorded_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_connectivity_incident_type_check
    check (incident_type in ('power_outage','internet_outage','both','other')),
  constraint employee_connectivity_status_check
    check (status in ('reported','verified','resolved','rejected')),
  constraint employee_connectivity_impact_check
    check (work_impact in ('none','late','interrupted','absent','other')),
  constraint employee_connectivity_duration_check
    check (duration_minutes is null or duration_minutes between 0 and 10080),
  constraint employee_connectivity_details_length_check
    check (details is null or char_length(details) <= 3000),
  constraint employee_connectivity_evidence_length_check
    check (evidence_url is null or char_length(evidence_url) <= 2000)
);

create index if not exists employee_connectivity_employee_date_idx
  on public.employee_connectivity_incidents (employee_id, incident_date desc, id desc);
create index if not exists employee_connectivity_type_date_idx
  on public.employee_connectivity_incidents (incident_type, incident_date desc);
create index if not exists employee_connectivity_status_date_idx
  on public.employee_connectivity_incidents (status, incident_date desc);

alter table public.employee_connectivity_incidents enable row level security;
revoke all on table public.employee_connectivity_incidents from public, anon, authenticated;
drop policy if exists employee_connectivity_no_direct_access on public.employee_connectivity_incidents;
create policy employee_connectivity_no_direct_access
  on public.employee_connectivity_incidents for all to anon, authenticated
  using (false) with check (false);

create schema if not exists employee_ops_private;
revoke all on schema employee_ops_private from public, anon, authenticated;

create or replace function employee_ops_private.admin_connectivity_home(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1);
  v_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size','')::integer,30),1),100);
  v_q text := lower(btrim(coalesce(p_filters->>'q','')));
  v_type text := btrim(coalesce(p_filters->>'incident_type',''));
  v_status text := btrim(coalesce(p_filters->>'status',''));
  v_from date := nullif(p_filters->>'date_from','')::date;
  v_to date := nullif(p_filters->>'date_to','')::date;
  v_total bigint;
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if v_from is not null and v_to is not null and v_from > v_to then
    select v_to,v_from into v_from,v_to;
  end if;

  with filtered as materialized (
    select c.id,c.employee_id,c.incident_date,c.incident_type,c.started_at,c.ended_at,
      c.duration_minutes,c.work_impact,c.details,c.evidence_url,c.status,c.created_at,
      e.employee_no,e.full_name,e.status employee_status,t.name team_name,p.name position_name,
      coalesce(u.email,u.id::text) recorded_by_name
    from public.employee_connectivity_incidents c
    join public.employees e on e.id=c.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    left join auth.users u on u.id=c.recorded_by
    where (v_q='' or lower(e.employee_no) like '%'||v_q||'%' or lower(e.full_name) like '%'||v_q||'%')
      and (v_type='' or c.incident_type=v_type)
      and (v_status='' or c.status=v_status)
      and (v_from is null or c.incident_date>=v_from)
      and (v_to is null or c.incident_date<=v_to)
  )
  select count(*) into v_total from filtered;

  with filtered as materialized (
    select c.id,c.employee_id,c.incident_date,c.incident_type,c.started_at,c.ended_at,
      c.duration_minutes,c.work_impact,c.details,c.evidence_url,c.status,c.created_at,
      e.employee_no,e.full_name,e.status employee_status,t.name team_name,p.name position_name,
      coalesce(u.email,u.id::text) recorded_by_name
    from public.employee_connectivity_incidents c
    join public.employees e on e.id=c.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    left join auth.users u on u.id=c.recorded_by
    where (v_q='' or lower(e.employee_no) like '%'||v_q||'%' or lower(e.full_name) like '%'||v_q||'%')
      and (v_type='' or c.incident_type=v_type)
      and (v_status='' or c.status=v_status)
      and (v_from is null or c.incident_date>=v_from)
      and (v_to is null or c.incident_date<=v_to)
  )
  select jsonb_build_object(
    'permissions',jsonb_build_object('create',public.has_permission('employee.edit')),
    'page',v_page,'page_size',v_size,'total',v_total,
    'pages',greatest(1,ceil(v_total::numeric/v_size)::integer),
    'summary',jsonb_build_object(
      'total',v_total,
      'power',count(*) filter(where incident_type='power_outage'),
      'internet',count(*) filter(where incident_type='internet_outage'),
      'both',count(*) filter(where incident_type='both'),
      'affected_employees',count(distinct employee_id)
    ),
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc)
      from (select * from filtered order by incident_date desc,id desc limit v_size offset (v_page-1)*v_size) x),'[]'::jsonb)
  ) into v_result from filtered;
  return v_result;
end;
$$;

create or replace function employee_ops_private.admin_connectivity_create(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text := regexp_replace(upper(coalesce(btrim(p_record->>'employee_no'),'')),'[^A-Z0-9]','','g');
  v_date date := coalesce(nullif(p_record->>'incident_date','')::date,current_date);
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'internet_outage');
  v_status text := coalesce(nullif(btrim(p_record->>'status'),''),'reported');
  v_impact text := coalesce(nullif(btrim(p_record->>'work_impact'),''),'interrupted');
  v_start time := nullif(p_record->>'started_at','')::time;
  v_end time := nullif(p_record->>'ended_at','')::time;
  v_duration integer := nullif(p_record->>'duration_minutes','')::integer;
  v_id bigint;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.edit') then raise exception 'permission_denied'; end if;
  if v_employee_no='' then raise exception 'employee_id_required'; end if;
  if v_type not in ('power_outage','internet_outage','both','other') then raise exception 'invalid_incident_type'; end if;
  if v_status not in ('reported','verified','resolved','rejected') then raise exception 'invalid_status'; end if;
  if v_impact not in ('none','late','interrupted','absent','other') then raise exception 'invalid_work_impact'; end if;
  if v_duration is null and v_start is not null and v_end is not null then
    v_duration := greatest(0,extract(epoch from (v_end-v_start))/60)::integer;
  end if;
  select e.id into v_employee_id from public.employees e
    where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g')=v_employee_no
    order by case when e.status='active' then 0 else 1 end,e.updated_at desc limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;
  insert into public.employee_connectivity_incidents(
    employee_id,incident_date,incident_type,started_at,ended_at,duration_minutes,
    work_impact,details,evidence_url,status,recorded_by
  ) values (
    v_employee_id,v_date,v_type,v_start,v_end,v_duration,v_impact,
    nullif(btrim(p_record->>'details'),''),nullif(btrim(p_record->>'evidence_url'),''),v_status,v_user
  ) returning id into v_id;
  return jsonb_build_object('id',v_id,'employee_id',v_employee_id,'employee_no',v_employee_no);
end;
$$;

create or replace function employee_ops_private.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.employees e where e.id=p_employee_id) then raise exception 'employee_not_found'; end if;
  return jsonb_build_object(
    'total',(select count(*) from public.employee_connectivity_incidents c where c.employee_id=p_employee_id),
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc) from(
      select c.id,c.incident_date,c.incident_type,c.started_at,c.ended_at,c.duration_minutes,
        c.work_impact,c.details,c.evidence_url,c.status,c.created_at,coalesce(u.email,u.id::text) recorded_by_name
      from public.employee_connectivity_incidents c left join auth.users u on u.id=c.recorded_by
      where c.employee_id=p_employee_id order by c.incident_date desc,c.id desc limit 300
    )x),'[]'::jsonb)
  );
end;
$$;

create or replace function employee_ops_private.admin_employee_profile_summary(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_employee_no text;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  select upper(btrim(e.employee_no)) into v_employee_no from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception 'employee_not_found'; end if;
  return jsonb_build_object(
    'month_records',(select count(*) from public.report_employee_errors_v r where r.employee_no=v_employee_no and r.qc_date>=date_trunc('month',current_date)::date),
    'total_errors',(select count(*) from public.report_employee_errors_v r where r.employee_no=v_employee_no),
    'exam_attempts',(select count(*) from public.admin_exam_combined_sessions_v s where s.employee_id=p_employee_id or (s.source_system='legacy' and public.exam_employee_no_key(s.employee_no)=public.exam_employee_no_key(v_employee_no))),
    'exam_average',(select round(avg(s.percentage) filter(where s.status='graded'),1) from public.admin_exam_combined_sessions_v s where s.employee_id=p_employee_id or (s.source_system='legacy' and public.exam_employee_no_key(s.employee_no)=public.exam_employee_no_key(v_employee_no)))
  );
end;
$$;

revoke all on function employee_ops_private.admin_connectivity_home(jsonb) from public, anon, authenticated;
revoke all on function employee_ops_private.admin_connectivity_create(jsonb) from public, anon, authenticated;
revoke all on function employee_ops_private.admin_employee_connectivity_history(uuid) from public, anon, authenticated;
revoke all on function employee_ops_private.admin_employee_profile_summary(uuid) from public, anon, authenticated;
grant usage on schema employee_ops_private to authenticated;
grant execute on function employee_ops_private.admin_connectivity_home(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_connectivity_create(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_employee_connectivity_history(uuid) to authenticated;
grant execute on function employee_ops_private.admin_employee_profile_summary(uuid) to authenticated;

create or replace function public.admin_connectivity_home(p_filters jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select employee_ops_private.admin_connectivity_home(p_filters);
$$;
create or replace function public.admin_connectivity_create(p_record jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select employee_ops_private.admin_connectivity_create(p_record);
$$;
create or replace function public.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select employee_ops_private.admin_employee_connectivity_history(p_employee_id);
$$;
create or replace function public.admin_employee_profile_summary(p_employee_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select employee_ops_private.admin_employee_profile_summary(p_employee_id);
$$;

revoke all on function public.admin_connectivity_home(jsonb) from public, anon, authenticated;
revoke all on function public.admin_connectivity_create(jsonb) from public, anon, authenticated;
revoke all on function public.admin_employee_connectivity_history(uuid) from public, anon, authenticated;
revoke all on function public.admin_employee_profile_summary(uuid) from public, anon, authenticated;
grant execute on function public.admin_connectivity_home(jsonb) to authenticated;
grant execute on function public.admin_connectivity_create(jsonb) to authenticated;
grant execute on function public.admin_employee_connectivity_history(uuid) to authenticated;
grant execute on function public.admin_employee_profile_summary(uuid) to authenticated;

-- Payroll admin extensions remain inside the non-exposed payroll_private schema.
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
      'platform',p.platform,'position_name',p.position_name,'hire_date',p.hire_date,
      'card_number',p.card_number,'payment_name',p.payment_name,'payment_method',p.payment_method,
      'base_salary',p.base_salary,'attendance_salary',p.attendance_salary,
      'leave_deduction',p.leave_deduction,'late_deduction',p.late_deduction,
      'absence_deduction',p.absence_deduction,'performance_adjustment',p.performance_adjustment,
      'deposit_adjustment',p.deposit_adjustment,'overtime_bonus',p.overtime_bonus,
      'other_adjustment',p.other_adjustment,'total_pay',p.total_pay,'line_items',p.line_items,
      'remark',p.remark,'source_row',p.source_row,'matched',p.employee_id is not null
    ) order by p.source_row) from public.payroll_payslips p where p.batch_id=v_selected),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function payroll_private.admin_payroll_delete(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_batch public.payroll_batches%rowtype;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.edit') then raise exception 'permission_denied'; end if;
  select * into v_batch from public.payroll_batches where id=p_batch_id for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.status='published' and not public.has_permission('payroll.publish') then raise exception 'permission_denied'; end if;
  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
    values(p_batch_id,v_user,'delete',jsonb_build_object('title',v_batch.title,'period_start',v_batch.period_start,'currency',v_batch.currency,'rows',v_batch.row_count));
  delete from public.payroll_batches where id=p_batch_id;
  return jsonb_build_object('batch_id',p_batch_id,'deleted',true,'rows',v_batch.row_count);
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
      select p.id,p.period_start,b.title,b.currency,b.status,b.published_at,p.platform,p.position_name,
        p.base_salary,p.attendance_salary,p.leave_deduction,p.late_deduction,p.absence_deduction,
        p.performance_adjustment,p.deposit_adjustment,p.overtime_bonus,p.other_adjustment,p.total_pay,
        p.line_items,p.remark,p.payment_method,p.payment_name
      from public.payroll_payslips p join public.payroll_batches b on b.id=p.batch_id
      where p.employee_id=p_employee_id order by p.period_start desc,p.id desc limit 120
    )x),'[]'::jsonb)
  );
end;
$$;

revoke all on function payroll_private.admin_payroll_home(bigint) from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_delete(bigint) from public, anon, authenticated;
revoke all on function payroll_private.admin_employee_payroll_history(uuid) from public, anon, authenticated;
grant execute on function payroll_private.admin_payroll_home(bigint) to authenticated;
grant execute on function payroll_private.admin_payroll_delete(bigint) to authenticated;
grant execute on function payroll_private.admin_employee_payroll_history(uuid) to authenticated;

create or replace function public.admin_payroll_delete(p_batch_id bigint)
returns jsonb language sql security invoker set search_path='' as $$
  select payroll_private.admin_payroll_delete(p_batch_id);
$$;
create or replace function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
  select payroll_private.admin_employee_payroll_history(p_employee_id);
$$;
revoke all on function public.admin_payroll_delete(bigint) from public, anon, authenticated;
revoke all on function public.admin_employee_payroll_history(uuid) from public, anon, authenticated;
grant execute on function public.admin_payroll_delete(bigint) to authenticated;
grant execute on function public.admin_employee_payroll_history(uuid) to authenticated;

-- The uploaded source is explicitly identified by the operator as PHP.
update public.payroll_batches
set currency='PHP',updated_at=now()
where period_start=date '2026-08-01'
  and title='2026-08 工资'
  and source_file_name='小菲居家8月1-15工资.xlsx'
  and currency='USD';
