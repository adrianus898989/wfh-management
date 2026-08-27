-- Run against a disposable database after all migrations. The centralized
-- log endpoint must fail closed and expose redacted presentation fields only.
begin;

set local search_path=pg_catalog;

do $$
declare
  v_function regprocedure:=
    'public.admin_activity_log_search(date,date,text,text,text,text,integer,integer)'::regprocedure;
  v_definition text:=pg_get_functiondef(v_function);
begin
  if position('session_private.current_app_session_is_valid(''admin'')' in v_definition)=0
     or position('public.has_permission(''account.activity_log.view'')' in v_definition)=0
     or position('public.can_manage_employee(entry.employee_id)' in v_definition)=0
     or position('entry.actor_user_id=v_user_id' in replace(v_definition,' ',''))=0
     or position('public.payroll_payslips scoped_payslip' in v_definition)=0 then
    raise exception 'activity log lost a session, permission, actor, employee, or payroll scope guard';
  end if;

  if position('public.audit_logs' in v_definition)=0
     or position('public.employee_audit_logs' in v_definition)=0
     or position('public.payroll_audit_log' in v_definition)=0
     or position('public.employee_attendance_records' in v_definition)=0
     or position('not exists' in lower(v_definition))=0 then
    raise exception 'activity log source or attendance/adjustment de-duplication was removed';
  end if;

  if (length(v_definition)-length(replace(v_definition,'p_date_from is null','')))
       / length('p_date_from is null') < 5
     or (length(v_definition)-length(replace(v_definition,'p_date_to is null','')))
       / length('p_date_to is null') < 5 then
    raise exception 'activity log date bounds are no longer pushed into every source';
  end if;

  if position('audit.module like ''exam_%''' in v_definition)=0
     or position('then ''exam''' in v_definition)=0
     or position('then ''alerts''' in v_definition)=0
     or position('void|revoke|close|deactivate' in v_definition)=0 then
    raise exception 'activity log module-family or destructive-action mapping regressed';
  end if;

  if position('''old_data'',paged.' in v_definition)>0
     or position('''new_data'',paged.' in v_definition)>0
     or position('''changes'',paged.' in v_definition)>0
     or position('''metadata'',paged.' in v_definition)>0
     or position('''detail'',paged.' in v_definition)>0
     or position('''raw_values'',paged.' in v_definition)>0 then
    raise exception 'activity log exposes a sensitive raw payload';
  end if;

  if not has_function_privilege('authenticated',v_function,'execute')
     or has_function_privilege('anon',v_function,'execute') then
    raise exception 'activity log execute boundary changed';
  end if;

  if not exists(
    select 1 from pg_proc procedure
    where procedure.oid=v_function and procedure.prosecdef and procedure.provolatile='s'
  ) then
    raise exception 'activity log must remain a stable guarded security-definer RPC';
  end if;
end;
$$;

do $$
begin
  if not exists(
    select 1 from public.permissions permission
    where permission.code='account.activity_log.view' and permission.sensitive
  ) then
    raise exception 'activity log permission is missing or not sensitive';
  end if;

  if exists(
    select 1
    from public.role_permissions role_permission
    join public.permissions permission on permission.id=role_permission.permission_id
    where permission.code='account.activity_log.view'
  ) then
    raise exception 'activity log was granted to a non-Founder role by default';
  end if;
end;
$$;

rollback;
