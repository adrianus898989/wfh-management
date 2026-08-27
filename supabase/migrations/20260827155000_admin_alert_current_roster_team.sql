begin;

-- The alert rows are already permission- and employee-scope filtered by the
-- private page reader.  Replace only the display enrichment so transferred
-- employees show today's roster team instead of employees.team_id history.
do $alert_current_roster_team$
declare
  v_signature regprocedure :=
    'public.admin_alert_center(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_old_join constant text := $old$
  left join public.employees employee
    on employee.id::text = nullif(item.row_data->>'employee_id', '')
  left join public.teams team
    on team.id = employee.team_id;$old$;
  v_new_join constant text := $new$
  left join scope_private.current_employee_scope_directory() directory
    on directory.employee_id::text = nullif(item.row_data->>'employee_id', '')
  left join public.teams team
    on team.id = directory.current_team_id;$new$;
  v_old_value constant text := $old$
        'team_name', coalesce(
          nullif(btrim(team.name), ''),
          nullif(btrim(employee.group_name), ''),
          ''
        )$old$;
  v_new_value constant text := $new$
        'team_name', coalesce(nullif(btrim(team.name), ''), '')$new$;
begin
  select pg_get_functiondef(v_signature) into v_definition;

  if position(v_new_join in v_definition) = 0 then
    if position(v_old_join in v_definition) = 0
       or position(v_old_value in v_definition) = 0 then
      raise exception 'admin_alert_team_enrichment_definition_changed';
    end if;
    v_definition := replace(v_definition, v_old_join, v_new_join);
    v_definition := replace(v_definition, v_old_value, v_new_value);
    execute v_definition;
  end if;

  select pg_get_functiondef(v_signature) into v_definition;
  if position('scope_private.current_employee_scope_directory()' in v_definition) = 0
     or position('employee.team_id' in v_definition) > 0
     or position('employee.group_name' in v_definition) > 0 then
    raise exception 'admin_alert_current_roster_team_patch_incomplete';
  end if;
end;
$alert_current_roster_team$;

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns granularly authorized alert rows enriched with the strict current-roster team; unmatched current organization fails closed to blank.';

notify pgrst, 'reload schema';

commit;
