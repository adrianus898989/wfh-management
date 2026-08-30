-- Disposable-database contract test for employee drawer server filtering.
begin;

do $$
declare
  v_attendance text;
  v_adjustment text;
  v_attendance_public text;
  v_adjustment_public text;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_employee_attendance_history_filtered(uuid,date,date,text,integer,integer)'::regprocedure
  ) into v_attendance;
  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_employee_adjustment_history_filtered(uuid,date,date,text,integer,integer)'::regprocedure
  ) into v_adjustment;
  select pg_catalog.pg_get_functiondef(
    'public.admin_employee_attendance_history_filtered(uuid,date,date,text,integer,integer)'::regprocedure
  ) into v_attendance_public;
  select pg_catalog.pg_get_functiondef(
    'public.admin_employee_adjustment_history_filtered(uuid,date,date,text,integer,integer)'::regprocedure
  ) into v_adjustment_public;

  if position('x.employee_id=p_employee_id' in lower(v_attendance))=0
     or position('p_date_from is null' in lower(v_attendance))=0
     or position('v_search is null' in lower(v_attendance))=0
     or position('p_date_from is null' in lower(v_attendance))
        > position('paged as materialized' in lower(v_attendance)) then
    raise exception 'attendance filters are missing or run after pagination';
  end if;

  if position('''adjustment.bonus.view''' in lower(v_adjustment))=0
     or position('''adjustment.deduction.view''' in lower(v_adjustment))=0
     or position('adjustment_visibility_kind(' in lower(v_adjustment))=0
     or position('adjustment_visibility_kind(' in lower(v_adjustment))
        > position('currency_stats as materialized' in lower(v_adjustment))
     or position('currency_stats as materialized' in lower(v_adjustment))
        > position('paged as materialized' in lower(v_adjustment)) then
    raise exception 'adjustment visibility must precede summaries and paging';
  end if;

  if position('public.can_manage_employee(p_employee_id)' in lower(v_attendance_public))=0
     or position('public.can_manage_employee(p_employee_id)' in lower(v_adjustment_public))=0
     or position('''attendance.records.view''' in lower(v_attendance_public))=0
     or position('''adjustment.bonus.view''' in lower(v_adjustment_public))=0
     or position('''adjustment.deduction.view''' in lower(v_adjustment_public))=0 then
    raise exception 'public wrappers lost permission or scope guards';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.admin_employee_attendance_history_filtered(uuid,date,date,text,integer,integer)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.admin_employee_adjustment_history_filtered(uuid,date,date,text,integer,integer)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.admin_employee_attendance_history_filtered(uuid,date,date,text,integer,integer)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.admin_employee_adjustment_history_filtered(uuid,date,date,text,integer,integer)',
       'execute'
     ) then
    raise exception 'history RPC execution boundary is too broad';
  end if;
end
$$;

rollback;
