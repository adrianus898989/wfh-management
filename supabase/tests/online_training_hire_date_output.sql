-- Local regression query. Run only against a disposable database after all
-- migrations. It verifies the employee list exposes the real hire date while
-- retaining the existing session, scope and execution boundary.

begin;

set local search_path = pg_catalog;

do $$
declare
  v_function regprocedure :=
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure;
  v_definition text := pg_get_functiondef(v_function);
begin
  if position(
    E'candidate.trainer_name,\n      candidate.hire_date,\n      candidate.is_current_roster'
    in v_definition
  ) = 0 then
    raise exception 'employee search does not expose candidate.hire_date';
  end if;

  if position('session_private.current_app_session_is_valid(''admin'')' in v_definition) = 0
     or position('public.backend_employee_in_scope(employee.id)' in v_definition) = 0
     or position('trainer_assignment_ids' in v_definition) = 0 then
    raise exception 'employee search session or scope guard changed';
  end if;

  if not has_function_privilege('authenticated', v_function, 'execute')
     or has_function_privilege('anon', v_function, 'execute') then
    raise exception 'employee search execute boundary changed';
  end if;
end;
$$;

rollback;
