-- Local contract test. Run only against a disposable database after all
-- migrations. It verifies that bonus/deduction visibility is enforced before
-- either admin reader aggregates or paginates adjustment rows.

begin;

do $$
declare
  v_home text;
  v_employee text;
  v_page text;
  v_employee_page text;
  v_has_permission text;
begin
  if not exists (
    select 1 from public.permissions
    where code='adjustment.bonus.view' and category='adjustment' and sensitive
  ) or not exists (
    select 1 from public.permissions
    where code='adjustment.deduction.view' and category='adjustment' and sensitive
  ) then
    raise exception 'adjustment category permissions are missing or not sensitive';
  end if;

  if exists (
    select 1
    from public.role_permissions page_grant
    join public.permissions page_permission
      on page_permission.id=page_grant.permission_id
     and page_permission.code='adjustment.page.view'
    where not exists (
      select 1
      from public.role_permissions category_grant
      join public.permissions category_permission
        on category_permission.id=category_grant.permission_id
       and category_permission.code='adjustment.bonus.view'
      where category_grant.role_id=page_grant.role_id
    ) or not exists (
      select 1
      from public.role_permissions category_grant
      join public.permissions category_permission
        on category_permission.id=category_grant.permission_id
       and category_permission.code='adjustment.deduction.view'
      where category_grant.role_id=page_grant.role_id
    )
  ) then
    raise exception 'an existing adjustment page role grant lost category access';
  end if;

  if exists (
    select 1
    from public.user_permission_overrides page_override
    join public.permissions page_permission
      on page_permission.id=page_override.permission_id
     and page_permission.code='adjustment.page.view'
    where not exists (
      select 1
      from public.user_permission_overrides category_override
      join public.permissions category_permission
        on category_permission.id=category_override.permission_id
       and category_permission.code='adjustment.bonus.view'
      where category_override.auth_user_id=page_override.auth_user_id
        and category_override.allowed=page_override.allowed
    ) or not exists (
      select 1
      from public.user_permission_overrides category_override
      join public.permissions category_permission
        on category_permission.id=category_override.permission_id
       and category_permission.code='adjustment.deduction.view'
      where category_override.auth_user_id=page_override.auth_user_id
        and category_override.allowed=page_override.allowed
    )
  ) then
    raise exception 'an existing adjustment page user override was not copied exactly';
  end if;

  if attendance_private.adjustment_visibility_kind('bonus',-5)<>'bonus'
     or attendance_private.adjustment_visibility_kind('deduction',5)<>'deduction'
     or attendance_private.adjustment_visibility_kind('reward',5)<>'bonus'
     or attendance_private.adjustment_visibility_kind('penalty',-5)<>'deduction'
     or attendance_private.adjustment_visibility_kind(null,5)<>'unclassified'
     or attendance_private.adjustment_visibility_kind('other',0)<>'unclassified'
     or attendance_private.adjustment_visibility_kind('other',null)<>'unclassified' then
    raise exception 'adjustment visibility classification no longer matches reader semantics';
  end if;

  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_attendance_home(jsonb)'::regprocedure
  ) into v_home;
  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_employee_adjustment_history(uuid,integer,integer)'::regprocedure
  ) into v_employee;
  select pg_catalog.pg_get_functiondef(
    'public.admin_adjustment_page(jsonb)'::regprocedure
  ) into v_page;
  select pg_catalog.pg_get_functiondef(
    'public.admin_employee_adjustment_history(uuid,integer,integer)'::regprocedure
  ) into v_employee_page;
  select pg_catalog.pg_get_functiondef(
    'public.has_permission(text)'::regprocedure
  ) into v_has_permission;

  if position('''adjustment.bonus.view''' in v_home)=0
     or position('''adjustment.deduction.view''' in v_home)=0
     or position('adjustment_visibility_kind(x.event_kind,x.amount)' in v_home)=0
     or position('adjustment_visibility_kind(x.event_kind,x.amount)' in v_home)
        > position('filtered as materialized' in lower(v_home)) then
    raise exception 'main adjustment reader does not filter categories in its base CTE';
  end if;

  if position('''adjustment.bonus.view''' in v_employee)=0
     or position('''adjustment.deduction.view''' in v_employee)=0
     or (
       position('adjustment_visibility_kind(x.event_kind,x.amount)' in v_employee)=0
       and position('adjustment_visibility_kind(enriched.event_kind,enriched.amount)' in v_employee)=0
     )
     or greatest(
       position('adjustment_visibility_kind(x.event_kind,x.amount)' in v_employee),
       position('adjustment_visibility_kind(enriched.event_kind,enriched.amount)' in v_employee)
     ) > position('currency_stats as materialized' in lower(v_employee)) then
    raise exception 'employee adjustment reader does not filter before aggregation';
  end if;

  if position('''adjustment.page.view''' in v_page)=0
     or position('''adjustment.bonus.view''' in v_page)=0
     or position('''adjustment.deduction.view''' in v_page)=0
     or position('''employee.directory.view''' in v_employee_page)=0
     or position('''adjustment.page.view''' in v_employee_page)=0
     or position('''adjustment.bonus.view''' in v_employee_page)=0
     or position('''adjustment.deduction.view''' in v_employee_page)=0
     or position('public.can_manage_employee(p_employee_id)' in v_employee_page)=0 then
    raise exception 'public adjustment wrapper permission or scope guard is missing';
  end if;

  if position('public.is_founder()' in v_has_permission)=0
     or position('return true' in lower(v_has_permission))=0 then
    raise exception 'Founder must retain implicit access to both adjustment categories';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where namespace.nspname='public'
      and relation.relname='employee_attendance_records'
      and relation.relrowsecurity
  ) then
    raise exception 'employee_attendance_records RLS is not enabled';
  end if;

  if pg_catalog.has_table_privilege(
       'authenticated','public.employee_attendance_records','select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated','attendance_private.attendance_enriched_records','select'
     )
     or pg_catalog.has_function_privilege(
       'authenticated','attendance_private.adjustment_visibility_kind(text,numeric)','execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated','attendance_private.admin_attendance_home(jsonb)','execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated','attendance_private.admin_employee_adjustment_history(uuid,integer,integer)','execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role','attendance_private.adjustment_visibility_kind(text,numeric)','execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role','attendance_private.admin_attendance_home(jsonb)','execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role','attendance_private.admin_employee_adjustment_history(uuid,integer,integer)','execute'
     ) then
    raise exception 'an application role can bypass a private adjustment read boundary';
  end if;

  if pg_catalog.has_function_privilege(
       'anon','public.admin_adjustment_page(jsonb)','execute'
     )
     or pg_catalog.has_function_privilege(
       'anon','public.admin_employee_adjustment_history(uuid,integer,integer)','execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated','public.admin_adjustment_page(jsonb)','execute'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated','public.admin_employee_adjustment_history(uuid,integer,integer)','execute'
     ) then
    raise exception 'public adjustment RPC execution boundary is incorrect';
  end if;
end;
$$;

rollback;
