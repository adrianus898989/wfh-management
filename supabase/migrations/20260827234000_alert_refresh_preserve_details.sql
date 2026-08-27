begin;

-- Preserve the evidence rows consumed by the alert UI and avoid rewriting all
-- unchanged exam alerts every ten minutes. Patch only the reviewed function
-- shape and reuse the legacy refresh lock so manual and scheduled paths cannot
-- overlap.
do $preserve_alert_details$
declare
  v_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_definition text;
  v_old_conflict_tail text := $old$
    is_active = true,
    last_seen_at = pg_catalog.clock_timestamp(),
    resolved_at = null;
  get diagnostics v_upserted = row_count;$old$;
  v_new_conflict_tail text := $new$
    is_active = true,
    last_seen_at = pg_catalog.clock_timestamp(),
    resolved_at = null
  where v_group <> 'access_exam'
    or (
      public.admin_alert_events.alert_type,
      public.admin_alert_events.severity,
      public.admin_alert_events.employee_id,
      public.admin_alert_events.employee_no,
      public.admin_alert_events.employee_name,
      public.admin_alert_events.title,
      public.admin_alert_events.message,
      public.admin_alert_events.window_start,
      public.admin_alert_events.window_end,
      public.admin_alert_events.occurrence_count,
      public.admin_alert_events.payload,
      public.admin_alert_events.source_ref
    ) is distinct from (
      excluded.alert_type,
      excluded.severity,
      excluded.employee_id,
      excluded.employee_no,
      excluded.employee_name,
      excluded.title,
      excluded.message,
      excluded.window_start,
      excluded.window_end,
      excluded.occurrence_count,
      excluded.payload,
      excluded.source_ref
    );
  get diagnostics v_upserted = row_count;$new$;
  v_old_resolution_tail text := $old$
  get diagnostics v_resolved = row_count;

  return pg_catalog.jsonb_build_object($old$;
  v_new_resolution_tail text := $new$
  get diagnostics v_resolved = row_count;

  if v_group = 'attendance' then
    perform alerts_private.enrich_attendance_alert_details();
  end if;

  return pg_catalog.jsonb_build_object($new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;

  v_definition:=replace(
    v_definition,
    'pg_catalog.hashtextextended(''alerts_private.refresh_alert_group'', 0)',
    'pg_catalog.hashtextextended(''alerts_private.refresh_alerts'', 0)'
  );

  if position(v_new_conflict_tail in v_definition)=0 then
    if position(v_old_conflict_tail in v_definition)=0 then
      raise exception 'alert_group_conflict_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old_conflict_tail,v_new_conflict_tail);
  end if;

  if position(v_new_resolution_tail in v_definition)=0 then
    if position(v_old_resolution_tail in v_definition)=0 then
      raise exception 'alert_group_resolution_shape_changed';
    end if;
    v_definition:=replace(v_definition,v_old_resolution_tail,v_new_resolution_tail);
  end if;

  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
  if position('alerts_private.enrich_attendance_alert_details()' in v_definition)=0
     or position('where v_group <> ''access_exam''' in v_definition)=0
     or position('hashtextextended(''alerts_private.refresh_alerts'', 0)' in v_definition)=0
     or position('hashtextextended(''alerts_private.refresh_alert_group'', 0)' in v_definition)>0 then
    raise exception 'alert_group_detail_preservation_incomplete';
  end if;
end;
$preserve_alert_details$;

comment on function alerts_private.refresh_alert_group(text) is
  'Bounded stable-alert refresh. Attendance evidence is enriched in the same transaction, access/exam no-op updates are suppressed, and all refresh paths share the legacy advisory lock. Experimental 1/3/7-day detector is absent.';

commit;
