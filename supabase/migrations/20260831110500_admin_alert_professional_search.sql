begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Keep the existing session, permission and employee-scope wrapper intact.
-- Extend only the private, bounded page reader so identity fields are searched
-- independently and the team filter uses the same strict current-roster truth
-- that enriches returned warning rows.
do $patch_admin_alert_professional_search$
declare
  v_private_signature regprocedure :=
    'alerts_private.admin_alert_center_page_fast(uuid,jsonb,integer,integer)'::regprocedure;
  v_public_signature regprocedure :=
    'public.admin_alert_center(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_catalog.pg_get_functiondef(v_private_signature) into v_definition;

  if pg_catalog.strpos(v_definition, 'v_employee_no_search text :=') > 0 then
    if pg_catalog.strpos(v_definition, 'v_employee_name_search text :=') = 0
       or pg_catalog.strpos(v_definition, 'v_team_search text :=') = 0
       or pg_catalog.strpos(v_definition, 'current_directory as materialized') = 0
       or pg_catalog.strpos(v_definition, 'current_directory.employee_id = alert.employee_id') = 0 then
      raise exception 'admin_alert_professional_search_partial_patch';
    end if;
    return;
  end if;

  v_patched := pg_catalog.replace(
    v_definition,
    $needle$  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));$needle$,
    $replacement$  v_employee_no_search text := left(lower(btrim(coalesce(p_filters->>'employee_no', ''))), 120);
  v_employee_name_search text := left(lower(btrim(coalesce(p_filters->>'employee_name', ''))), 120);
  v_team_search text := left(lower(btrim(coalesce(p_filters->>'team', ''))), 120);
  v_search text := left(lower(btrim(coalesce(p_filters->>'search', ''))), 200);$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_professional_search_declaration_shape_changed';
  end if;

  v_definition := v_patched;
  v_patched := pg_catalog.replace(
    v_definition,
    $needle$  ), visible as materialized ($needle$,
    $replacement$  ), current_directory as materialized (
    select directory.*
    from scope_private.current_employee_scope_directory() directory
  ), visible as materialized ($replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_professional_search_directory_shape_changed';
  end if;

  -- Resolve today's roster once. Both the filter and returned team display use
  -- this same materialized directory, so a renamed or moved employee cannot
  -- be selected by stale warning payload data.
  v_definition := v_patched;
  v_patched := pg_catalog.replace(
    v_definition,
    $needle$      and (not v_unread_only or alert.unread)$needle$,
    $replacement$      and (
        v_employee_no_search = ''
        or pg_catalog.strpos(
          pg_catalog.lower(coalesce(alert.employee_no, '')), v_employee_no_search
        ) > 0
      )
      and (
        v_employee_name_search = ''
        or pg_catalog.strpos(
          pg_catalog.lower(coalesce(alert.employee_name, '')), v_employee_name_search
        ) > 0
      )
      and (
        v_team_search = ''
        or exists (
          select 1
          from current_directory
          join public.teams current_team
            on current_team.id = current_directory.current_team_id
          where current_directory.employee_id = alert.employee_id
            and pg_catalog.strpos(
              pg_catalog.lower(coalesce(current_team.name, '')), v_team_search
            ) > 0
        )
      )
      and (not v_unread_only or alert.unread)$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_professional_search_filter_shape_changed';
  end if;

  -- The general keyword box now describes warning content only. Employee ID,
  -- name and current team have their own explicit server-side filters.
  v_definition := v_patched;
  v_patched := pg_catalog.replace(
    v_definition,
    $needle$lower(concat_ws(' ', alert.employee_no, alert.employee_name,
          alert.title$needle$,
    $replacement$lower(concat_ws(' ', alert.title$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_professional_search_keyword_shape_changed';
  end if;

  v_definition := v_patched;
  v_patched := pg_catalog.replace(
    v_definition,
    $needle$      left join scope_private.current_employee_scope_directory() directory
        on directory.employee_id = alert.employee_id$needle$,
    $replacement$      left join current_directory directory
        on directory.employee_id = alert.employee_id$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_professional_search_display_directory_shape_changed';
  end if;

  execute v_patched;

  select pg_catalog.pg_get_functiondef(v_private_signature) into v_definition;
  if pg_catalog.strpos(v_definition, 'v_employee_no_search text :=') = 0
     or pg_catalog.strpos(v_definition, 'v_employee_name_search text :=') = 0
     or pg_catalog.strpos(v_definition, 'v_team_search text :=') = 0
     or pg_catalog.strpos(v_definition, 'current_directory as materialized') = 0
     or pg_catalog.strpos(v_definition, 'current_directory.employee_id = alert.employee_id') = 0
     or pg_catalog.strpos(v_definition, 'alert.employee_no, alert.employee_name') > 0 then
    raise exception 'admin_alert_professional_search_patch_incomplete';
  end if;

  select pg_catalog.pg_get_functiondef(v_public_signature) into v_definition;
  if pg_catalog.strpos(
    v_definition, 'alerts_private.admin_alert_center_page_fast'
  ) = 0 then
    raise exception 'admin_alert_public_scope_wrapper_changed';
  end if;
end;
$patch_admin_alert_professional_search$;

alter function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) set statement_timeout = '3s';
alter function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) set lock_timeout = '500ms';

revoke all on function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) from public, anon, authenticated, service_role;

comment on function alerts_private.admin_alert_center_page_fast(
  uuid, jsonb, integer, integer
) is 'Private bounded warning reader with independent employee ID, employee name, strict current-roster team, warning keyword and date filters before pagination.';

notify pgrst, 'reload schema';

commit;
