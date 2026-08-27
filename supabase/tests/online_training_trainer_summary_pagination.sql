-- Run against a disposable database after all migrations. The RPC must fail
-- closed without a current backend session and must never be callable by anon.
begin;

set local search_path = pg_catalog;

do $$
declare
  v_function regprocedure :=
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure;
  v_definition text := pg_get_functiondef(v_function);
  v_view_gate text := pg_get_functiondef(
    'public.online_training_can_view_module()'::regprocedure
  );
begin
  if position('session_private.current_app_session_is_valid(''admin'')' in v_definition) = 0
     or position('public.online_training_can_view_module()' in v_definition) = 0
     or position('public.backend_employee_in_scope(employee.id)' in v_definition) = 0
     or position('trainer_assignment_ids' in v_definition) = 0
     or position('public.online_training_can_view_report(report.id)' in v_definition) = 0
     or position('public.online_training_resolve_trainer_identities(v_candidates)' in v_definition) = 0
     or position('row_number() over' in v_definition) = 0 then
    raise exception 'trainer summary lost a session, view, scope, identity, or pagination guard';
  end if;
  if position('online_training.report.view' in v_view_gate) = 0 then
    raise exception 'trainer summary module helper no longer enforces its page view permission';
  end if;

  if not has_function_privilege('authenticated', v_function, 'execute')
     or not has_function_privilege('service_role', v_function, 'execute')
     or has_function_privilege('anon', v_function, 'execute') then
    raise exception 'trainer summary execute boundary changed';
  end if;
end;
$$;

do $$
begin
  begin
    perform public.online_training_search_trainers('{}'::jsonb, 1, 12);
    raise exception 'trainer summary unexpectedly allowed a missing app session';
  exception
    when others then
      if sqlerrm <> 'session_not_current' then
        raise;
      end if;
  end;
end;
$$;

rollback;
