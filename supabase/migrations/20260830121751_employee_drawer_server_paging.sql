begin;

-- These readers replace the drawer's historical 120/300-row payloads with
-- exact-employee, bounded pages.  Keep deployment fail-fast so a read-only UI
-- improvement cannot queue behind payroll or employee writes.
set local lock_timeout = '500ms';
set local statement_timeout = '10s';

create or replace function public.admin_employee_connectivity_history_page(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_page integer := greatest(coalesce(p_page,1),1);
  v_page_size integer := case
    when p_page_size in (20,30,50,100) then p_page_size
    else 20
  end;
  v_search text := left(lower(btrim(coalesce(p_search,''))),100);
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if p_employee_id is null then
    raise exception 'employee_required';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from>p_date_to then
    raise exception 'invalid_date_range';
  end if;
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('connectivity.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if not exists(select 1 from public.employees employee where employee.id=p_employee_id) then
    raise exception 'employee_not_found';
  end if;

  select count(*)::integer
  into v_total
  from public.employee_connectivity_incidents incident
  where incident.employee_id=p_employee_id
    and (p_date_from is null or incident.incident_date>=p_date_from)
    and (p_date_to is null or incident.incident_date<=p_date_to)
    and (
      v_search=''
      or lower(concat_ws(' ',
        incident.incident_date::text,
        incident.incident_type,
        case incident.incident_type
          when 'power_outage' then '停电'
          when 'internet_outage' then '断网'
          else ''
        end,
        incident.status,
        case incident.status
          when 'reported' then '进行中'
          when 'verified' then '已核实'
          when 'resolved' then '已恢复'
          when 'rejected' then '不成立'
          else ''
        end,
        incident.details
      )) like '%'||v_search||'%'
    );

  select coalesce(
    jsonb_agg(to_jsonb(page_row) order by page_row.incident_date desc,page_row.id desc),
    '[]'::jsonb
  )
  into v_rows
  from (
    select
      incident.id,
      incident.incident_date,
      incident.incident_type,
      incident.started_at,
      incident.ended_at,
      incident.duration_minutes,
      incident.details,
      incident.evidence_url,
      incident.attachments,
      incident.status,
      incident.created_at,
      coalesce(
        nullif(btrim(access.login_username),''),
        nullif(btrim(auth_user.raw_user_meta_data->>'username'),''),
        nullif(btrim(auth_user.raw_user_meta_data->>'full_name'),''),
        nullif(split_part(coalesce(auth_user.email,''),'@',1),''),
        auth_user.id::text
      ) recorded_by_name
    from public.employee_connectivity_incidents incident
    left join public.user_access access
      on access.auth_user_id=incident.recorded_by
     and access.active
    left join auth.users auth_user on auth_user.id=incident.recorded_by
    where incident.employee_id=p_employee_id
      and (p_date_from is null or incident.incident_date>=p_date_from)
      and (p_date_to is null or incident.incident_date<=p_date_to)
      and (
        v_search=''
        or lower(concat_ws(' ',
          incident.incident_date::text,
          incident.incident_type,
          case incident.incident_type
            when 'power_outage' then '停电'
            when 'internet_outage' then '断网'
            else ''
          end,
          incident.status,
          case incident.status
            when 'reported' then '进行中'
            when 'verified' then '已核实'
            when 'resolved' then '已恢复'
            when 'rejected' then '不成立'
            else ''
          end,
          incident.details
        )) like '%'||v_search||'%'
      )
    order by incident.incident_date desc,incident.id desc
    offset (v_page-1)*v_page_size
    limit v_page_size
  ) page_row;

  return jsonb_build_object(
    'employee_id',p_employee_id,
    'server_paging',true,
    'total',v_total,
    'page',v_page,
    'page_size',v_page_size,
    'pages',greatest(1,ceil(v_total::numeric/v_page_size)::integer),
    'rows',v_rows
  );
end;
$$;

create or replace function public.admin_employee_payroll_history_page(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_search text default '',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_page integer := greatest(coalesce(p_page,1),1);
  v_page_size integer := case
    when p_page_size in (20,30,50,100) then p_page_size
    else 20
  end;
  v_search text := left(lower(btrim(coalesce(p_search,''))),100);
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if p_employee_id is null then
    raise exception 'employee_required';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from>p_date_to then
    raise exception 'invalid_date_range';
  end if;
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('employee.directory.payroll_records.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if not exists(select 1 from public.employees employee where employee.id=p_employee_id) then
    raise exception 'employee_not_found';
  end if;

  select count(*)::integer
  into v_total
  from public.payroll_payslips payslip
  join public.payroll_batches batch on batch.id=payslip.batch_id
  where payslip.employee_id=p_employee_id
    and batch.status='published'
    and batch.voided_at is null
    and (p_date_from is null or payslip.period_start>=p_date_from)
    and (p_date_to is null or payslip.period_start<=p_date_to)
    and (
      v_search=''
      or lower(concat_ws(' ',
        payslip.period_start::text,
        batch.title,
        batch.currency,
        payslip.remark,
        payslip.base_salary,
        payslip.attendance_salary,
        payslip.total_pay
      )) like '%'||v_search||'%'
    );

  select coalesce(
    jsonb_agg(to_jsonb(page_row) order by page_row.period_start desc,page_row.id desc),
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
      and (p_date_from is null or payslip.period_start>=p_date_from)
      and (p_date_to is null or payslip.period_start<=p_date_to)
      and (
        v_search=''
        or lower(concat_ws(' ',
          payslip.period_start::text,
          batch.title,
          batch.currency,
          payslip.remark,
          payslip.base_salary,
          payslip.attendance_salary,
          payslip.total_pay
        )) like '%'||v_search||'%'
      )
    order by payslip.period_start desc,payslip.id desc
    offset (v_page-1)*v_page_size
    limit v_page_size
  ) page_row;

  return jsonb_build_object(
    'employee_id',p_employee_id,
    'server_paging',true,
    'total',v_total,
    'page',v_page,
    'page_size',v_page_size,
    'pages',greatest(1,ceil(v_total::numeric/v_page_size)::integer),
    'rows',v_rows
  );
end;
$$;

-- Keep the existing drawer callers compatible, but make their first response
-- bounded. The returned employee_id lets the panel issue subsequent filtered
-- page requests without changing the employee drawer component.
create or replace function public.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  return public.admin_employee_connectivity_history_page(
    p_employee_id,null,null,'',1,20
  );
end;
$$;

create or replace function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  return public.admin_employee_payroll_history_page(
    p_employee_id,null,null,'',1,20
  );
end;
$$;

revoke all on function public.admin_employee_connectivity_history_page(uuid,date,date,text,integer,integer),
  public.admin_employee_payroll_history_page(uuid,date,date,text,integer,integer),
  public.admin_employee_connectivity_history(uuid),
  public.admin_employee_payroll_history(uuid)
from public,anon,authenticated,service_role;

grant execute on function public.admin_employee_connectivity_history_page(uuid,date,date,text,integer,integer),
  public.admin_employee_payroll_history_page(uuid,date,date,text,integer,integer),
  public.admin_employee_connectivity_history(uuid),
  public.admin_employee_payroll_history(uuid)
to authenticated;

comment on function public.admin_employee_connectivity_history_page(uuid,date,date,text,integer,integer) is
  'Bounded employee drawer connectivity reader with server-side date/search filters and exact current employee scope.';
comment on function public.admin_employee_payroll_history_page(uuid,date,date,text,integer,integer) is
  'Bounded sensitive employee payroll drawer reader; returns only published, non-voided payslips after exact permission and employee-scope checks.';

notify pgrst,'reload schema';

commit;
