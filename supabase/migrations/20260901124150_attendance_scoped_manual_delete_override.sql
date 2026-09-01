-- Replace the broad manual-delete switch with a one-transition authorization.
-- The approved transition is pinned to the audited Home-PH September source,
-- previous and target snapshot hashes, exact read/canonical/warning counts, and
-- the exact nine-row delete delta. Any later sheet or database change fails
-- closed and requires a new review.

do $migration$
declare
  v_signature regprocedure :=
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure;
  v_definition text;
  v_declaration_old text := $old$  v_allow_large_delete boolean := false;$old$;
  v_declaration_new text := $new$  v_allow_large_delete boolean := false;
  v_expected_delete_count integer;
  v_expected_previous_snapshot_hash text;
  v_expected_snapshot_hash text;
  v_expected_read_row_count integer;
  v_expected_canonical_record_count integer;
  v_expected_parse_warning_count integer;$new$;
  v_parse_old text := $old$  v_allow_large_delete := coalesce((p_payload->>'allow_large_delete')::boolean, false);$old$;
  v_parse_new text := $new$  v_allow_large_delete := coalesce((p_payload->>'allow_large_delete')::boolean, false);
  v_expected_delete_count := nullif(p_payload->>'expected_delete_count', '')::integer;
  v_expected_previous_snapshot_hash := lower(btrim(coalesce(p_payload->>'expected_previous_snapshot_hash', '')));
  v_expected_snapshot_hash := lower(btrim(coalesce(p_payload->>'expected_snapshot_hash', '')));
  v_expected_read_row_count := nullif(p_payload->>'expected_read_row_count', '')::integer;
  v_expected_canonical_record_count := nullif(p_payload->>'expected_canonical_record_count', '')::integer;
  v_expected_parse_warning_count := nullif(p_payload->>'expected_parse_warning_count', '')::integer;$new$;
  v_empty_old text := $old$    if v_existing_record_count>0 and v_payload_row_count=0 and v_read_row_count=0
      and not (v_trigger_kind='manual' and v_allow_large_delete) then
      raise exception 'empty_snapshot_requires_manual_override';
    end if;$old$;
  v_empty_new text := $new$    -- Empty snapshots are never eligible for a delete override.
    if v_existing_record_count>0 and v_payload_row_count=0 and v_read_row_count=0 then
      raise exception 'empty_snapshot_requires_manual_override';
    end if;$new$;
  v_guard_old text := $old$    -- Automatic snapshots still fail closed on real removals. Permit only a
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
    end if;$old$;
  v_guard_new text := $new$    -- Automatic snapshots still fail closed on real removals. The only large
    -- delete authorization is the audited Home-PH September transition below.
    -- The old/new hashes make this transition one-shot; actual counts are
    -- recomputed inside this transaction before the delete executes.
    if v_deleted>0
      and not (
        v_trigger_kind='manual'
        and v_allow_large_delete
        and v_source_key='home_ph_annual_2026_09'
        and v_previous_hash='527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071'
        and v_snapshot_hash='f6da820efa127e92d99bf0240380ef334e5007b093429d5ba1f30683ddf01126'
        and v_expected_previous_snapshot_hash=v_previous_hash
        and v_expected_snapshot_hash=v_snapshot_hash
        and v_expected_delete_count=9
        and v_expected_delete_count=v_deleted
        and v_expected_read_row_count=720
        and v_expected_read_row_count=v_read_row_count
        and v_expected_canonical_record_count=295
        and v_expected_canonical_record_count=v_payload_row_count
        and v_expected_parse_warning_count=7
        and v_expected_parse_warning_count=coalesce((p_payload->>'parse_warning_count')::integer, 0)
        and v_payload_row_count>0
        and v_read_row_count>0
      )
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
begin
  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;

  if strpos(v_definition, v_declaration_old) = 0 then
    raise exception 'annual_attendance_override_declaration_marker_missing';
  end if;
  if strpos(v_definition, v_parse_old) = 0 then
    raise exception 'annual_attendance_override_parse_marker_missing';
  end if;
  if strpos(v_definition, v_empty_old) = 0 then
    raise exception 'annual_attendance_empty_guard_marker_missing';
  end if;
  if strpos(v_definition, v_guard_old) = 0 then
    raise exception 'annual_attendance_delete_guard_marker_missing';
  end if;

  v_definition := replace(v_definition, v_declaration_old, v_declaration_new);
  v_definition := replace(v_definition, v_parse_old, v_parse_new);
  v_definition := replace(v_definition, v_empty_old, v_empty_new);
  v_definition := replace(v_definition, v_guard_old, v_guard_new);
  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;
  if strpos(v_definition, 'v_source_key=''home_ph_annual_2026_09''') = 0
    or strpos(v_definition, 'v_expected_delete_count=v_deleted') = 0
    or strpos(v_definition, 'v_expected_previous_snapshot_hash=v_previous_hash') = 0
    or strpos(v_definition, 'v_expected_snapshot_hash=v_snapshot_hash') = 0
    or strpos(v_definition, 'v_expected_read_row_count=v_read_row_count') = 0
    or strpos(v_definition, 'v_expected_canonical_record_count=v_payload_row_count') = 0
    or strpos(v_definition, 'v_expected_parse_warning_count=coalesce') = 0
    or strpos(v_definition, 'v_payload_row_count>0') = 0
    or strpos(v_definition, 'v_read_row_count>0') = 0
    or strpos(v_definition, 'and not (v_trigger_kind=''manual'' and v_allow_large_delete)') > 0 then
    raise exception 'annual_attendance_scoped_override_install_failed';
  end if;
end;
$migration$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

comment on function attendance_private.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role-only annual attendance ingest; large deletes require the exact reviewed Home-PH Sep 2026 transition, hashes and counts.';

notify pgrst, 'reload schema';
