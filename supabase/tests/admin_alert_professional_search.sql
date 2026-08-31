-- Local regression query. Run only against a disposable database after all
-- migrations. It verifies that professional warning filters remain inside the
-- private scoped reader and do not widen the public execute boundary.

begin;

set local search_path = pg_catalog;

do $$
declare
  v_private regprocedure :=
    'alerts_private.admin_alert_center_page_fast(uuid,jsonb,integer,integer)'::regprocedure;
  v_public regprocedure :=
    'public.admin_alert_center(jsonb,integer,integer)'::regprocedure;
  v_private_definition text := pg_get_functiondef(v_private);
  v_public_definition text := pg_get_functiondef(v_public);
begin
  if strpos(v_private_definition, 'v_employee_no_search text :=') = 0
     or strpos(v_private_definition, 'v_employee_name_search text :=') = 0
     or strpos(v_private_definition, 'v_team_search text :=') = 0 then
    raise exception 'independent warning identity filters are missing';
  end if;

  if strpos(v_private_definition, 'current_directory as materialized') = 0
     or strpos(v_private_definition, 'current_directory.employee_id = alert.employee_id') = 0
     or strpos(v_private_definition, 'current_team.id = current_directory.current_team_id') = 0 then
    raise exception 'warning team filter is not using strict current-roster truth';
  end if;

  if strpos(v_private_definition, 'alert.employee_no, alert.employee_name') > 0 then
    raise exception 'warning keyword still conflates employee identity fields';
  end if;

  if strpos(v_private_definition, 'left join current_directory directory') = 0 then
    raise exception 'warning result rows are not using the same current roster directory';
  end if;

  if strpos(v_public_definition, 'session_private.current_app_session_is_valid(''admin'')') = 0
     or strpos(v_public_definition, 'alerts_private.admin_alert_center_page_fast') = 0 then
    raise exception 'warning public session or private-reader boundary changed';
  end if;

  if has_function_privilege('authenticated', v_private, 'execute')
     or has_function_privilege('service_role', v_private, 'execute')
     or has_function_privilege('anon', v_public, 'execute')
     or not has_function_privilege('authenticated', v_public, 'execute') then
    raise exception 'warning reader execute boundary changed';
  end if;

  if not exists (
    select 1
    from pg_proc procedure
    where procedure.oid = v_private
      and 'statement_timeout=3s' = any(coalesce(procedure.proconfig, array[]::text[]))
      and 'lock_timeout=500ms' = any(coalesce(procedure.proconfig, array[]::text[]))
  ) then
    raise exception 'warning private reader timeout bounds changed';
  end if;
end;
$$;

rollback;
