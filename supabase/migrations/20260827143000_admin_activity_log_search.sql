begin;

-- Founder access remains implicit through public.has_permission(). Every other
-- backend role must receive this sensitive page permission explicitly.
insert into public.permissions(code,name,category,sensitive)
values('account.activity_log.view','后台账号 · 查看集中操作日志','account',true)
on conflict(code) do update
set name=excluded.name,category=excluded.category,sensitive=excluded.sensitive;

-- The search is date-first and then scope-filtered. These indexes avoid a full
-- sort of each audit source while keeping every source table private.
create index if not exists audit_logs_activity_created_idx
  on public.audit_logs(created_at desc,id desc);
create index if not exists audit_logs_activity_actor_created_idx
  on public.audit_logs(actor_user_id,created_at desc);
create index if not exists audit_logs_activity_employee_created_idx
  on public.audit_logs(employee_id,created_at desc);
create index if not exists employee_audit_logs_activity_created_idx
  on public.employee_audit_logs(created_at desc,id desc);
create index if not exists employee_audit_logs_activity_actor_created_idx
  on public.employee_audit_logs(actor_user_id,created_at desc);
create index if not exists payroll_audit_log_activity_created_idx
  on public.payroll_audit_log(created_at desc,id desc);

create or replace function public.admin_activity_log_search(
  p_date_from date default null,
  p_date_to date default null,
  p_actor text default null,
  p_module text default null,
  p_action text default null,
  p_object text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid:=(select auth.uid());
  v_actor text:=left(lower(btrim(coalesce(p_actor,''))),100);
  v_module text:=left(lower(btrim(coalesce(p_module,''))),100);
  v_action text:=left(lower(btrim(coalesce(p_action,''))),100);
  v_object text:=left(lower(btrim(coalesce(p_object,''))),100);
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=case when coalesce(p_page_size,20) in (20,50,100) then coalesce(p_page_size,20) else 20 end;
  v_all_scope boolean:=false;
  v_rows jsonb:='[]'::jsonb;
  v_total bigint:=0;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('account.activity_log.view') then
    raise exception 'permission_denied';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from>p_date_to then
    raise exception 'invalid_date_range';
  end if;

  select role.code='founder' or access.data_scope='all'
  into v_all_scope
  from public.user_access access
  join public.roles role on role.id=access.role_id
  where access.auth_user_id=v_user_id
    and access.active=true
    and access.backend_enabled=true
  order by access.updated_at desc
  limit 1;
  if not found then raise exception 'permission_denied'; end if;

  with entries as materialized (
    select
      'audit_logs:'||audit.id::text as id,
      audit.created_at,
      audit.actor_user_id,
      coalesce(audit.employee_id,training.author_employee_id) as employee_id,
      case
        when audit.module in ('access_control','backend_account','role_permissions','admin_ip_allowlist') then 'access_control'
        when audit.module in ('auth','authentication','admin_login') then 'auth'
        when audit.module='attendance_adjustment' then 'adjustment'
        when audit.module in ('attendance','attendance_entry','leave') or audit.module like 'attendance_%' then 'attendance'
        when audit.module='online_training' or audit.module like 'online_training_%' then 'online_training'
        when audit.module='exam' or audit.module like 'exam_%' then 'exam'
        when audit.module in ('alerts','alert','warning','warning_center') then 'alerts'
        when audit.module in ('connectivity','power_outage','internet_outage') then 'connectivity'
        when audit.module in ('user_account','staff_account','employee_account') then 'user_account'
        when audit.module='employee' or audit.module like 'employee_%' then 'employee'
        when audit.module='payroll' or audit.module like 'payroll_%' then 'payroll'
        else audit.module
      end as module,
      audit.action,
      coalesce(
        nullif(btrim(audit.record_id),''),
        employee.employee_no,
        coalesce(audit.employee_id,training.author_employee_id)::text
      ) as object_id,
      nullif(concat_ws(' · ',nullif(btrim(employee.employee_no),''),nullif(btrim(employee.full_name),'')),'') as object_name,
      null::text as actor_hint,
      null::bigint as payroll_batch_id,
      'audit_logs'::text as source
    from public.audit_logs audit
    left join public.online_training_reports training
      on audit.module='online_training' and training.id::text=audit.record_id
    left join public.employees employee
      on employee.id=coalesce(audit.employee_id,training.author_employee_id)
    where (p_date_from is null or audit.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or audit.created_at<(p_date_to+1)::timestamptz)

    union all

    select
      'employee_audit_logs:'||audit.id::text,
      audit.created_at,
      audit.actor_user_id,
      audit.employee_id,
      'employee',
      audit.action,
      coalesce(nullif(btrim(audit.employee_no),''),audit.employee_id::text),
      nullif(concat_ws(
        ' · ',
        coalesce(nullif(btrim(audit.employee_no),''),nullif(btrim(employee.employee_no),'')),
        coalesce(nullif(btrim(audit.full_name),''),nullif(btrim(employee.full_name),''))
      ),''),
      nullif(btrim(audit.actor_username),''),
      null::bigint,
      'employee_audit_logs'
    from public.employee_audit_logs audit
    left join public.employees employee on employee.id=audit.employee_id
    where (p_date_from is null or audit.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or audit.created_at<(p_date_to+1)::timestamptz)

    union all

    select
      'payroll_audit_log:'||audit.id::text,
      audit.created_at,
      audit.actor_user_id,
      payslip.employee_id,
      'payroll',
      audit.action,
      coalesce(audit.payslip_id::text,audit.batch_id::text),
      coalesce(
        nullif(concat_ws(' · ',nullif(btrim(payslip.employee_no_raw),''),nullif(btrim(payslip.full_name),'')),''),
        nullif(btrim(batch.title),''),
        case when audit.batch_id is not null then '工资批次 '||audit.batch_id::text end
      ),
      null::text,
      audit.batch_id,
      'payroll_audit_log'
    from public.payroll_audit_log audit
    left join public.payroll_batches batch on batch.id=audit.batch_id
    left join public.payroll_payslips payslip on payslip.id=audit.payslip_id
    where (p_date_from is null or audit.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or audit.created_at<(p_date_to+1)::timestamptz)

    union all

    -- Legacy/manual attendance and adjustment rows sometimes predate the
    -- common audit write. Include only rows with a recorded human actor and
    -- de-duplicate against the exact audit modules used by data-entry logs.
    select
      'employee_attendance_records:'||record.id::text,
      coalesce(record.updated_at,record.created_at),
      coalesce(record.updated_by,record.created_by),
      record.employee_id,
      case when record.kind='adjustment' then 'adjustment' else 'attendance' end,
      case
        when record.updated_by is not null
          and coalesce(record.updated_at,record.created_at)>record.created_at+interval '1 second'
          then 'manual_update'
        else 'manual_create'
      end,
      record.id::text,
      nullif(concat_ws(' · ',nullif(btrim(employee.employee_no),''),nullif(btrim(employee.full_name),'')),''),
      null::text,
      null::bigint,
      'employee_attendance_records'
    from public.employee_attendance_records record
    join public.employees employee on employee.id=record.employee_id
    where record.kind in ('attendance','adjustment')
      and coalesce(record.updated_by,record.created_by) is not null
      and (p_date_from is null or coalesce(record.updated_at,record.created_at)>=p_date_from::timestamptz)
      and (p_date_to is null or coalesce(record.updated_at,record.created_at)<(p_date_to+1)::timestamptz)
      and not exists(
        select 1
        from public.audit_logs audit
        where audit.record_id=record.id::text
          and audit.actor_user_id=coalesce(record.updated_by,record.created_by)
          and (
            (record.kind='adjustment' and audit.module='attendance_adjustment')
            or (record.kind='attendance' and audit.module in ('attendance','attendance_entry','leave'))
          )
          and (
            (
              record.updated_by is not null
              and coalesce(record.updated_at,record.created_at)>record.created_at+interval '1 second'
              and lower(coalesce(audit.action,'')) ~ '(update|edit|change|upsert)'
              and audit.created_at between coalesce(record.updated_at,record.created_at)-interval '10 minutes'
                and coalesce(record.updated_at,record.created_at)+interval '10 minutes'
            )
            or (
              (
                record.updated_by is null
                or coalesce(record.updated_at,record.created_at)<=record.created_at+interval '1 second'
              )
              and lower(coalesce(audit.action,'')) ~ '(create|insert|add)'
              and audit.created_at between record.created_at-interval '10 minutes'
                and record.created_at+interval '10 minutes'
            )
          )
      )
  ), scoped as materialized (
    select
      entry.*,
      coalesce(
        entry.actor_hint,
        nullif(btrim(actor.login_username),''),
        nullif(btrim(actor.login_email),''),
        nullif(btrim(actor_employee.full_name),''),
        '系统 / 外部同步'
      ) as actor_name
    from entries entry
    left join public.user_access actor on actor.auth_user_id=entry.actor_user_id
    left join public.employees actor_employee on actor_employee.id=actor.employee_id
    where v_all_scope
      or entry.actor_user_id=v_user_id
      or (
        entry.employee_id is not null
        and public.can_manage_employee(entry.employee_id)
      )
      or (
        entry.source='payroll_audit_log'
        and entry.employee_id is null
        and entry.payroll_batch_id is not null
        and exists(
          select 1
          from public.payroll_payslips scoped_payslip
          where scoped_payslip.batch_id=entry.payroll_batch_id
            and scoped_payslip.employee_id is not null
            and public.can_manage_employee(scoped_payslip.employee_id)
        )
      )
  ), categorized as materialized (
    select
      scoped.*,
      case
        when lower(coalesce(scoped.action,'')) ~ '(delete|archive|cancel|remove|void|revoke|close|deactivate)' then 'delete'
        when lower(coalesce(scoped.action,'')) ~ '(login|sign_in)' then 'auth'
        when lower(coalesce(scoped.action,'')) ~ '(create|import|register|generate|submit|insert|add)' then 'create'
        when lower(coalesce(scoped.action,'')) ~ '(update|edit|change|reset|set_|review|publish|approve|reject|resign|reactivate|repair|fulfill|grade|correction|sync)' then 'update'
        else 'other'
      end as action_category
    from scoped
  ), presented as materialized (
    select
      categorized.*,
      case categorized.source
        when 'employee_audit_logs' then '员工档案操作（仅显示审计标识，不含字段前后值）'
        when 'payroll_audit_log' then '工资操作（不含工资明细或审计 detail）'
        when 'employee_attendance_records' then
          case when categorized.module='adjustment'
            then '奖惩人工录入 / 修改记录（不含金额原始载荷）'
            else '考勤人工录入 / 修改记录（不含 raw_values）'
          end
        else '后台业务操作（仅显示脱敏摘要）'
      end as summary
    from categorized
  ), filtered as materialized (
    select presented.*
    from presented
    where (p_date_from is null or presented.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or presented.created_at<(p_date_to+1)::timestamptz)
      and (v_actor='' or lower(presented.actor_name) like '%'||v_actor||'%')
      and (v_module='' or lower(presented.module)=v_module)
      and (
        v_action=''
        or presented.action_category=v_action
        or lower(coalesce(presented.action,'')) like '%'||v_action||'%'
      )
      and (
        v_object=''
        or lower(coalesce(presented.object_id,'')) like '%'||v_object||'%'
        or lower(coalesce(presented.object_name,'')) like '%'||v_object||'%'
      )
  ), paged as (
    select filtered.*
    from filtered
    order by filtered.created_at desc,filtered.id desc
    limit v_size offset (v_page-1)*v_size
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',paged.id,
        'created_at',paged.created_at,
        'actor_name',paged.actor_name,
        'module',paged.module,
        'action',paged.action,
        'action_category',paged.action_category,
        'object_id',paged.object_id,
        'object_name',paged.object_name,
        'summary',paged.summary,
        'source',paged.source
      ) order by paged.created_at desc,paged.id desc)
      from paged
    ),'[]'::jsonb)
  into v_total,v_rows;

  return jsonb_build_object(
    'rows',v_rows,
    'total',v_total,
    'page',v_page,
    'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1),
    'sources',jsonb_build_array(
      'audit_logs','employee_audit_logs','payroll_audit_log','employee_attendance_records'
    )
  );
end;
$$;

comment on function public.admin_activity_log_search(date,date,text,text,text,text,integer,integer) is
  'Current-session, permission and employee-scope guarded search across three audit tables plus the de-duplicated attendance/adjustment legacy fallback. Returns identifiers and redacted summaries only.';

revoke all on function public.admin_activity_log_search(date,date,text,text,text,text,integer,integer)
  from public,anon,authenticated;
grant execute on function public.admin_activity_log_search(date,date,text,text,text,text,integer,integer)
  to authenticated;

notify pgrst,'reload schema';

commit;
