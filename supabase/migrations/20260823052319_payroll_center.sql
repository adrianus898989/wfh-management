-- Secure payroll batches and employee payslips.
-- All browser access goes through permission-checked RPC functions; the tables
-- themselves are not exposed to anon/authenticated roles.

create schema if not exists internal;

create table if not exists public.payroll_batches (
  id bigint generated always as identity primary key,
  period_start date not null,
  title text not null,
  currency text not null default 'USD',
  status text not null default 'draft',
  source_type text not null default 'upload',
  source_file_name text,
  source_project_ref text,
  source_batch_key text,
  notes text,
  row_count integer not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  created_by uuid,
  published_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint payroll_batches_period_first_day check (extract(day from period_start) = 1),
  constraint payroll_batches_status_check check (status in ('draft','published','archived')),
  constraint payroll_batches_source_check check (source_type in ('upload','friend_supabase','manual'))
);

create table if not exists public.payroll_payslips (
  id bigint generated always as identity primary key,
  batch_id bigint not null references public.payroll_batches(id) on delete cascade,
  period_start date not null,
  employee_id uuid references public.employees(id) on delete set null,
  employee_no_raw text,
  employee_no_key text,
  full_name text not null,
  platform text,
  position_name text,
  hire_date date,
  card_number text,
  payment_name text,
  payment_method text,
  base_salary numeric(16,2) not null default 0,
  attendance_salary numeric(16,2) not null default 0,
  leave_deduction numeric(16,2) not null default 0,
  late_deduction numeric(16,2) not null default 0,
  absence_deduction numeric(16,2) not null default 0,
  performance_adjustment numeric(16,2) not null default 0,
  deposit_adjustment numeric(16,2) not null default 0,
  overtime_bonus numeric(16,2) not null default 0,
  other_adjustment numeric(16,2) not null default 0,
  total_pay numeric(16,2) not null default 0,
  line_items jsonb not null default '[]'::jsonb,
  remark text,
  source_row integer not null,
  external_record_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_payslips_batch_row_unique unique (batch_id, source_row),
  constraint payroll_payslips_line_items_array check (jsonb_typeof(line_items) = 'array'),
  constraint payroll_payslips_raw_payload_object check (jsonb_typeof(raw_payload) = 'object')
);

create table if not exists public.payroll_audit_log (
  id bigint generated always as identity primary key,
  batch_id bigint references public.payroll_batches(id) on delete set null,
  payslip_id bigint references public.payroll_payslips(id) on delete set null,
  actor_user_id uuid,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payroll_batches_period_status_idx
  on public.payroll_batches (period_start desc, status);
create index if not exists payroll_payslips_employee_period_idx
  on public.payroll_payslips (employee_id, period_start desc);
create index if not exists payroll_payslips_batch_employee_idx
  on public.payroll_payslips (batch_id, employee_id);
create index if not exists payroll_payslips_employee_no_key_idx
  on public.payroll_payslips (employee_no_key);
create index if not exists payroll_audit_batch_created_idx
  on public.payroll_audit_log (batch_id, created_at desc);

alter table public.payroll_batches enable row level security;
alter table public.payroll_payslips enable row level security;
alter table public.payroll_audit_log enable row level security;

revoke all on table public.payroll_batches from public, anon, authenticated;
revoke all on table public.payroll_payslips from public, anon, authenticated;
revoke all on table public.payroll_audit_log from public, anon, authenticated;

create or replace function internal.payroll_employee_no_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(coalesce(trim(p_value), ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

create or replace function internal.payroll_name_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(coalesce(trim(p_value), ''), '[[:space:][:punct:]]', '', 'g'));
$$;

create or replace function internal.payroll_number(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_clean text;
begin
  v_clean := nullif(regexp_replace(coalesce(p_value, ''), '[^0-9.\-]', '', 'g'), '');
  if v_clean is null or v_clean in ('-', '.', '-.') then return 0; end if;
  return v_clean::numeric;
exception when others then
  return 0;
end;
$$;

revoke all on function internal.payroll_employee_no_key(text) from public, anon, authenticated;
revoke all on function internal.payroll_name_key(text) from public, anon, authenticated;
revoke all on function internal.payroll_number(text) from public, anon, authenticated;

create or replace function public.admin_payroll_import(p_batch jsonb, p_rows jsonb)
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
  v_employee_key text;
  v_name_key text;
  v_name_match_count integer;
  v_row_count integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_source_row integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.edit') then raise exception 'permission_denied'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'empty_rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows'; end if;

  v_period := date_trunc('month', coalesce(nullif(p_batch->>'period_start','')::date, current_date))::date;
  v_batch_id := nullif(p_batch->>'id','')::bigint;

  if v_batch_id is not null then
    perform 1 from public.payroll_batches b where b.id=v_batch_id and b.status='draft' for update;
    if not found then raise exception 'batch_not_editable'; end if;
    update public.payroll_batches set
      period_start=v_period,
      title=coalesce(nullif(trim(p_batch->>'title'),''), to_char(v_period,'YYYY-MM')),
      currency=upper(coalesce(nullif(trim(p_batch->>'currency'),''),'USD')),
      source_type=coalesce(nullif(trim(p_batch->>'source_type'),''),'upload'),
      source_file_name=nullif(trim(p_batch->>'source_file_name'),''),
      source_project_ref=nullif(trim(p_batch->>'source_project_ref'),''),
      source_batch_key=nullif(trim(p_batch->>'source_batch_key'),''),
      notes=nullif(trim(p_batch->>'notes'),''),
      updated_at=now()
    where id=v_batch_id;
    delete from public.payroll_payslips where batch_id=v_batch_id;
  else
    insert into public.payroll_batches (
      period_start,title,currency,source_type,source_file_name,source_project_ref,source_batch_key,notes,created_by
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

    if v_employee_key <> '' then
      select e.id into v_employee_id
      from public.employees e
      where internal.payroll_employee_no_key(e.employee_no)=v_employee_key
      order by case when e.status='active' then 0 else 1 end, e.updated_at desc
      limit 1;
    end if;

    if v_employee_id is null and v_name_key <> '' then
      select count(*), (array_agg(e.id))[1] into v_name_match_count, v_employee_id
      from public.employees e
      where internal.payroll_name_key(e.full_name)=v_name_key;
      if v_name_match_count <> 1 then v_employee_id := null; end if;
    end if;

    if v_employee_id is null then v_unmatched := v_unmatched + 1; else v_matched := v_matched + 1; end if;

    insert into public.payroll_payslips (
      batch_id,period_start,employee_id,employee_no_raw,employee_no_key,full_name,platform,position_name,hire_date,
      card_number,payment_name,payment_method,base_salary,attendance_salary,leave_deduction,late_deduction,
      absence_deduction,performance_adjustment,deposit_adjustment,overtime_bonus,other_adjustment,total_pay,
      line_items,remark,source_row,external_record_id,raw_payload
    ) values (
      v_batch_id,v_period,v_employee_id,nullif(trim(v_row->>'employee_no'),''),nullif(v_employee_key,''),
      coalesce(nullif(trim(v_row->>'full_name'),''),'未填写姓名'),nullif(trim(v_row->>'platform'),''),
      nullif(trim(v_row->>'position_name'),''),nullif(v_row->>'hire_date','')::date,
      nullif(trim(v_row->>'card_number'),''),nullif(trim(v_row->>'payment_name'),''),nullif(trim(v_row->>'payment_method'),''),
      internal.payroll_number(v_row->>'base_salary'),internal.payroll_number(v_row->>'attendance_salary'),
      internal.payroll_number(v_row->>'leave_deduction'),internal.payroll_number(v_row->>'late_deduction'),
      internal.payroll_number(v_row->>'absence_deduction'),internal.payroll_number(v_row->>'performance_adjustment'),
      internal.payroll_number(v_row->>'deposit_adjustment'),internal.payroll_number(v_row->>'overtime_bonus'),
      internal.payroll_number(v_row->>'other_adjustment'),internal.payroll_number(v_row->>'total_pay'),
      case when jsonb_typeof(v_row->'line_items')='array' then v_row->'line_items' else '[]'::jsonb end,
      nullif(trim(v_row->>'remark'),''),v_source_row,nullif(trim(v_row->>'external_record_id'),''),
      case when jsonb_typeof(v_row->'raw_payload')='object' then v_row->'raw_payload' else '{}'::jsonb end
    );
  end loop;

  update public.payroll_batches set
    row_count=v_row_count, matched_count=v_matched, unmatched_count=v_unmatched, updated_at=now()
  where id=v_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(v_batch_id,v_user,'import',jsonb_build_object('rows',v_row_count,'matched',v_matched,'unmatched',v_unmatched));

  return jsonb_build_object('batch_id',v_batch_id,'rows',v_row_count,'matched',v_matched,'unmatched',v_unmatched);
end;
$$;

create or replace function public.admin_payroll_home(p_batch_id bigint default null)
returns jsonb
language plpgsql
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
    select b.id into v_selected from public.payroll_batches b order by b.period_start desc,b.created_at desc limit 1;
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
        select b.id,b.period_start,b.title,b.currency,b.status,b.source_type,b.source_file_name,
               b.row_count,b.matched_count,b.unmatched_count,b.created_at,b.published_at
        from public.payroll_batches b order by b.period_start desc,b.created_at desc limit 36
      ) x
    ),'[]'::jsonb),
    'selected_batch',(select to_jsonb(b) from public.payroll_batches b where b.id=v_selected),
    'rows',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'employee_id',p.employee_id,'employee_no',p.employee_no_raw,'full_name',p.full_name,
        'platform',p.platform,'position_name',p.position_name,'hire_date',p.hire_date,'payment_method',p.payment_method,
        'base_salary',p.base_salary,'attendance_salary',p.attendance_salary,'total_pay',p.total_pay,
        'remark',p.remark,'source_row',p.source_row,'matched',p.employee_id is not null
      ) order by p.source_row)
      from public.payroll_payslips p where p.batch_id=v_selected
    ),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_period date;
  v_rows integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('payroll.publish') then raise exception 'permission_denied'; end if;

  select b.period_start,b.row_count into v_period,v_rows
  from public.payroll_batches b where b.id=p_batch_id and b.status='draft' for update;
  if not found then raise exception 'batch_not_publishable'; end if;
  if coalesce(v_rows,0)=0 then raise exception 'empty_batch'; end if;

  update public.payroll_batches
  set status='archived',updated_at=now()
  where period_start=v_period and status='published' and id<>p_batch_id;

  update public.payroll_batches
  set status='published',published_by=v_user,published_at=now(),updated_at=now()
  where id=p_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(p_batch_id,v_user,'publish',jsonb_build_object('rows',v_rows,'period_start',v_period));
  return jsonb_build_object('batch_id',p_batch_id,'status','published','rows',v_rows);
end;
$$;

create or replace function public.staff_payroll_home()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select ua.employee_id into v_employee_id
  from public.user_access ua
  where ua.auth_user_id=v_user and ua.active=true and ua.employee_portal_enabled=true
  limit 1;
  if v_employee_id is null then raise exception 'employee_portal_disabled'; end if;

  select jsonb_build_object(
    'employee',jsonb_build_object(
      'id',e.id,'employee_no',e.employee_no,'full_name',e.full_name,'platform',e.platform_scope,
      'position_name',coalesce(pos.name,e.schedule_position),'team_name',t.name,'hire_date',e.hire_date,
      'payment_method',coalesce(pp.payment_mode,pp.transfer_using),
      'payment_name',coalesce(pp.gcash_name,e.full_name)
    ),
    'history',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',p.id,'period_start',p.period_start,'title',b.title,'currency',b.currency,'published_at',b.published_at,
        'base_salary',p.base_salary,'attendance_salary',p.attendance_salary,'leave_deduction',p.leave_deduction,
        'late_deduction',p.late_deduction,'absence_deduction',p.absence_deduction,
        'performance_adjustment',p.performance_adjustment,'deposit_adjustment',p.deposit_adjustment,
        'overtime_bonus',p.overtime_bonus,'other_adjustment',p.other_adjustment,'total_pay',p.total_pay,
        'remark',p.remark,'source_type',b.source_type
      ) order by p.period_start desc,p.id desc)
      from public.payroll_payslips p
      join public.payroll_batches b on b.id=p.batch_id and b.status='published'
      where p.employee_id=v_employee_id
    ),'[]'::jsonb)
  ) into v_result
  from public.employees e
  left join public.teams t on t.id=e.team_id
  left join public.positions pos on pos.id=e.position_id
  left join public.employee_payment_profiles pp on pp.employee_id=e.id
  where e.id=v_employee_id;
  return coalesce(v_result,jsonb_build_object('employee',null,'history','[]'::jsonb));
end;
$$;

create or replace function public.staff_payroll_detail(p_payslip_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select ua.employee_id into v_employee_id
  from public.user_access ua
  where ua.auth_user_id=v_user and ua.active=true and ua.employee_portal_enabled=true
  limit 1;
  if v_employee_id is null then raise exception 'employee_portal_disabled'; end if;

  select jsonb_build_object(
    'id',p.id,'period_start',p.period_start,'title',b.title,'currency',b.currency,'published_at',b.published_at,
    'employee',jsonb_build_object('employee_no',p.employee_no_raw,'full_name',p.full_name,'platform',p.platform,
      'position_name',p.position_name,'hire_date',p.hire_date,'card_number',p.card_number,
      'payment_name',p.payment_name,'payment_method',p.payment_method),
    'base_salary',p.base_salary,'attendance_salary',p.attendance_salary,'leave_deduction',p.leave_deduction,
    'late_deduction',p.late_deduction,'absence_deduction',p.absence_deduction,
    'performance_adjustment',p.performance_adjustment,'deposit_adjustment',p.deposit_adjustment,
    'overtime_bonus',p.overtime_bonus,'other_adjustment',p.other_adjustment,'total_pay',p.total_pay,
    'line_items',p.line_items,'remark',p.remark,'source_type',b.source_type
  ) into v_result
  from public.payroll_payslips p
  join public.payroll_batches b on b.id=p.batch_id and b.status='published'
  where p.id=p_payslip_id and p.employee_id=v_employee_id;
  if v_result is null then raise exception 'payslip_not_found'; end if;
  return v_result;
end;
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
