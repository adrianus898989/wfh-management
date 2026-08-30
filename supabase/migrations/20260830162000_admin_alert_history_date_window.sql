begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Employee warning history is served by the same fast, precomputed alert
-- reader as the alert center.  Add bounded date-window overlap filtering to
-- that private reader so pagination totals remain correct and the employee
-- drawer never downloads every warning just to filter in the browser.
do $patch_alert_history_date_window$
declare
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(
    'alerts_private.admin_alert_center_page_fast(uuid,jsonb,integer,integer)'::regprocedure
  ) into v_definition;

  if position('v_date_from date :=' in v_definition) > 0 then
    if position('coalesce(alert.window_end, alert.last_seen_at::date, alert.first_seen_at::date) >= v_date_from' in v_definition) = 0
       or position('coalesce(alert.window_start, alert.first_seen_at::date, alert.last_seen_at::date) <= v_date_to' in v_definition) = 0 then
      raise exception 'admin_alert_history_partial_date_patch';
    end if;
    return;
  end if;

  v_patched := replace(
    v_definition,
    $needle$  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_employee_id_text text := btrim(coalesce(p_filters->>'employee_id', ''));$needle$,
    $replacement$  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_date_from date := nullif(btrim(coalesce(p_filters->>'date_from', '')), '')::date;
  v_date_to date := nullif(btrim(coalesce(p_filters->>'date_to', '')), '')::date;
  v_employee_id_text text := btrim(coalesce(p_filters->>'employee_id', ''));$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_history_date_declaration_shape_changed';
  end if;

  v_definition := v_patched;
  v_patched := replace(
    v_definition,
    $needle$      and (v_severity = '' or alert.severity = v_severity)
      and (not v_unread_only or alert.unread)$needle$,
    $replacement$      and (v_severity = '' or alert.severity = v_severity)
      and (
        v_date_from is null
        or coalesce(alert.window_end, alert.last_seen_at::date, alert.first_seen_at::date) >= v_date_from
      )
      and (
        v_date_to is null
        or coalesce(alert.window_start, alert.first_seen_at::date, alert.last_seen_at::date) <= v_date_to
      )
      and (not v_unread_only or alert.unread)$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_history_date_filter_shape_changed';
  end if;

  v_definition := v_patched;
  v_patched := replace(
    v_definition,
    $needle$          alert.title, alert.message)) like '%' || v_search || '%'$needle$,
    $replacement$          alert.title, alert.message, alert.window_start::text,
          alert.window_end::text, alert.first_seen_at::date::text,
          alert.last_seen_at::date::text)) like '%' || v_search || '%'$replacement$
  );
  if v_patched = v_definition then
    raise exception 'admin_alert_history_search_shape_changed';
  end if;

  execute v_patched;
end;
$patch_alert_history_date_window$;

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
) is 'Private scoped alert reader with employee, text and overlapping date-window filters applied before pagination.';

notify pgrst, 'reload schema';

commit;
