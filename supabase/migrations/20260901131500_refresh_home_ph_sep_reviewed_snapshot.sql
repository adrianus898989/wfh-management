-- Refresh the one-transition Home-PH September delete authorization after the
-- source was re-audited. This migration intentionally changes only the target
-- snapshot hash and exact read-row count. The source, previous production hash,
-- delete count, canonical count, and warning count remain pinned.

do $migration$
declare
  v_signature regprocedure :=
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure;
  v_definition text;
  v_old_snapshot_hash constant text :=
    'f6da820efa127e92d99bf0240380ef334e5007b093429d5ba1f30683ddf01126';
  v_new_snapshot_hash constant text :=
    '9390bd569f7eeaeb0f563d1598a05159db3f334d0af53c0944a6ff7a59bee651';
  v_old_hash_count integer;
  v_old_read_count integer;
begin
  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;

  v_old_hash_count :=
    (length(v_definition) - length(replace(v_definition, v_old_snapshot_hash, '')))
    / length(v_old_snapshot_hash);
  select count(*)::integer
  into v_old_read_count
  from regexp_matches(
    v_definition,
    'v_expected_read_row_count\s*=\s*720',
    'g'
  );

  if v_old_hash_count <> 1 then
    raise exception 'attendance_reviewed_snapshot_old_hash_marker_count_mismatch';
  end if;
  if v_old_read_count <> 1 then
    raise exception 'attendance_reviewed_snapshot_old_read_count_marker_mismatch';
  end if;
  if strpos(v_definition, v_new_snapshot_hash) > 0 then
    raise exception 'attendance_reviewed_snapshot_new_hash_already_present';
  end if;

  v_definition := replace(
    v_definition,
    v_old_snapshot_hash,
    v_new_snapshot_hash
  );
  v_definition := regexp_replace(
    v_definition,
    'v_expected_read_row_count\s*=\s*720',
    'v_expected_read_row_count = 721',
    'g'
  );
  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;
  if strpos(v_definition, v_old_snapshot_hash) > 0
    or strpos(v_definition, v_new_snapshot_hash) = 0
    or v_definition !~ 'v_expected_read_row_count\s*=\s*721'
    or v_definition !~ 'v_previous_hash\s*=\s*''527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071'''
    or v_definition !~ 'v_expected_delete_count\s*=\s*9'
    or v_definition !~ 'v_expected_canonical_record_count\s*=\s*295'
    or v_definition !~ 'v_expected_parse_warning_count\s*=\s*7'
  then
    raise exception 'attendance_reviewed_snapshot_refresh_failed';
  end if;
end;
$migration$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

comment on function attendance_private.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role-only annual attendance ingest; large deletes require the exact re-audited Home-PH Sep 2026 transition, hashes and counts.';

notify pgrst, 'reload schema';
