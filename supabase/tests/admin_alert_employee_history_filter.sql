-- Local regression query. Run only against a disposable database after all
-- migrations. It verifies the employee-history filter remains behind the same
-- session, employee-scope, alert-type permission, and execute boundaries.

begin;

set local search_path = pg_catalog;

do $$
declare
  v_function regprocedure :=
    'public.admin_alert_center(jsonb,integer,integer)'::regprocedure;
  v_definition text := pg_get_functiondef(v_function);
begin
  if position('v_employee_id_text text' in v_definition) = 0
     or position('alert.employee_id = v_employee_id' in v_definition) = 0
     or position('invalid_employee_id' in v_definition) = 0 then
    raise exception 'exact employee warning-history filter is missing';
  end if;

  if position('session_private.current_app_session_is_valid(''admin'')' in v_definition) = 0
     or position('alerts_private.caller_can_view_alert_type(event.alert_type)' in v_definition) = 0
     or position('public.backend_employee_in_scope(event.employee_id)' in v_definition) = 0 then
    raise exception 'warning history session, type permission, or employee scope guard changed';
  end if;

  if position('v_status = ''all''' in v_definition) = 0 then
    raise exception 'resolved warning history is no longer queryable';
  end if;

  if not has_function_privilege('authenticated', v_function, 'execute')
     or has_function_privilege('anon', v_function, 'execute') then
    raise exception 'warning history execute boundary changed';
  end if;
end;
$$;

rollback;
