-- Allow a small, count-preserving date correction to move through the annual
-- attendance sync without weakening the mass-delete guard. A real removal,
-- identity change, event-kind change, or correction batch above five records
-- still requires the existing reviewed manual override.

create or replace function attendance_private.annual_snapshot_deletes_are_count_preserving_moves(
  p_source_id uuid,
  p_run_id uuid
)
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $$
  with existing_counts as (
    select
      record.source_block,
      record.event_kind,
      case
        when nullif(regexp_replace(coalesce(record.employee_no_raw, ''), '[[:space:]]+', '', 'g'), '')
          is not null
          then 'id:' || upper(regexp_replace(record.employee_no_raw, '[[:space:]]+', '', 'g'))
        else 'name:' || lower(regexp_replace(btrim(coalesce(record.employee_name_raw, '')), '[[:space:]]+', ' ', 'g'))
      end as employee_key,
      count(*) as record_count
    from public.employee_attendance_records record
    where record.source_id = p_source_id
    group by record.source_block, record.event_kind, employee_key
  ),
  staged_counts as (
    select
      staged.source_block,
      staged.event_kind,
      case
        when nullif(regexp_replace(coalesce(staged.employee_no_raw, ''), '[[:space:]]+', '', 'g'), '')
          is not null
          then 'id:' || upper(regexp_replace(staged.employee_no_raw, '[[:space:]]+', '', 'g'))
        else 'name:' || lower(regexp_replace(btrim(coalesce(staged.employee_name_raw, '')), '[[:space:]]+', ' ', 'g'))
      end as employee_key,
      count(*) as record_count
    from attendance_private.attendance_sheet_sync_stage staged
    where staged.source_id = p_source_id
      and staged.run_id = p_run_id
    group by staged.source_block, staged.event_kind, employee_key
  )
  select not exists (
    select 1
    from existing_counts existing
    left join staged_counts staged
      on staged.source_block = existing.source_block
      and staged.event_kind = existing.event_kind
      and staged.employee_key = existing.employee_key
    where coalesce(staged.record_count, 0) < existing.record_count
  );
$$;

revoke all on function attendance_private.annual_snapshot_deletes_are_count_preserving_moves(uuid, uuid)
  from public, anon, authenticated;

comment on function attendance_private.annual_snapshot_deletes_are_count_preserving_moves(uuid, uuid) is
  'True only when the current transaction staging rows preserve every employee/source-block/event-kind count; VOLATILE so rows inserted earlier in the ingest are visible.';

do $migration$
declare
  v_signature regprocedure :=
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure;
  v_definition text;
  v_old text := $old$    -- Automatic snapshots may insert and update, but never remove canonical
    -- attendance or adjustment history. Any deletion requires an explicit
    -- reviewed manual run, even when only one row would disappear.
    if v_deleted>0 and not (v_trigger_kind='manual' and v_allow_large_delete) then
      raise exception 'large_delete_requires_manual_override';
    end if;$old$;
  v_new text := $new$    -- Automatic snapshots still fail closed on real removals. Permit only a
    -- small date correction when every employee/source-block/event-kind count
    -- is preserved and the complete snapshot does not shrink.
    if v_deleted>0
      and not (v_trigger_kind='manual' and v_allow_large_delete)
      and not (
        v_deleted <= 5
        and v_payload_row_count >= v_existing_record_count
        and attendance_private.annual_snapshot_deletes_are_count_preserving_moves(
          v_source_id,
          v_run_id
        )
      ) then
      raise exception 'large_delete_requires_manual_override';
    end if;$new$;
  v_failure_old text := $old$    update public.attendance_sheet_sync_runs
    set status='failed',error_message=v_error,result=v_result,completed_at=now()
    where id=v_run_id;$old$;
  v_failure_new text := $new$    update public.attendance_sheet_sync_runs
    set status='failed',
      raw_record_count=v_payload_row_count,
      canonical_record_count=v_payload_row_count,
      deleted_count=v_deleted,
      error_message=v_error,
      result=v_result,
      completed_at=now()
    where id=v_run_id;$new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;

  if strpos(v_definition, v_old) = 0 then
    raise exception 'annual_attendance_delete_guard_marker_missing';
  end if;
  if strpos(v_definition, v_failure_old) = 0 then
    raise exception 'annual_attendance_failure_diagnostics_marker_missing';
  end if;

  v_definition := replace(v_definition, v_old, v_new);
  v_definition := replace(v_definition, v_failure_old, v_failure_new);
  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;
  if strpos(v_definition, 'v_deleted <= 5') = 0
    or strpos(
      v_definition,
      'attendance_private.annual_snapshot_deletes_are_count_preserving_moves'
    ) = 0
    or strpos(v_definition, 'raw_record_count=v_payload_row_count') = 0
    or strpos(v_definition, 'deleted_count=v_deleted') = 0 then
    raise exception 'annual_attendance_count_preserving_guard_install_failed';
  end if;
end;
$migration$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

notify pgrst, 'reload schema';
