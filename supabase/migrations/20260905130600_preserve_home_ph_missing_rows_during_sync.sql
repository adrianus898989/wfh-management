-- Keep the Home-PH September feed moving when an otherwise valid snapshot
-- omits existing rows. Incoming inserts and updates remain authoritative, but
-- an unreviewed omission is copied into the transaction stage and therefore
-- retained in canonical history instead of deleting data or rolling back the
-- whole snapshot. Other annual sources and empty snapshots keep their existing
-- fail-closed behavior. Explicit reviewed deletes and the existing bounded,
-- count-preserving move exception are unchanged.

do $migration$
declare
  v_signature regprocedure :=
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure;
  v_definition text;
  v_declaration_old text := $old$  v_expected_parse_warning_count integer;$old$;
  v_declaration_new text := $new$  v_expected_parse_warning_count integer;
  v_protected_delete_count integer := 0;$new$;
  v_guard_tail_old text := $old$      ) then
      raise exception 'large_delete_requires_manual_override';
    end if;$old$;
  v_guard_tail_new text := $new$      ) then
      if v_source_key <> 'home_ph_annual_2026_09' then
        raise exception 'large_delete_requires_manual_override';
      end if;

      -- Preserve only the existing rows that the incoming snapshot omitted.
      -- Adding them to this transaction's trusted stage makes the downstream
      -- insert/update/delete code apply every valid incoming row while the
      -- candidate removals remain untouched.
      v_protected_delete_count := v_deleted;
      insert into attendance_private.attendance_sheet_sync_stage (
        run_id, source_id, source_block, source_row, source_item_key,
        kind, event_date, event_kind, reason, note, amount, raw_amount,
        employee_no_raw, employee_name_raw, employee_status_raw,
        team_name_raw, position_name_raw, country_raw, platform_raw, manager_raw,
        raw_values, content_hash, is_mirror, source_updated_at
      )
      select
        v_run_id, r.source_id, r.source_block, r.source_row, r.source_item_key,
        r.kind, r.event_date, r.event_kind, r.reason, r.note, r.amount, r.raw_amount,
        r.employee_no_raw, r.employee_name_raw, r.employee_status_raw,
        r.team_name_raw, r.position_name_raw, r.country_raw, r.platform_raw, r.manager_raw,
        r.raw_values, r.content_hash, r.is_mirror, r.source_updated_at
      from public.employee_attendance_records r
      where r.source_id = v_source_id
        and not exists (
          select 1
          from attendance_private.attendance_sheet_sync_stage x
          where x.run_id = v_run_id
            and x.source_block = r.source_block
            and x.source_row = r.source_row
            and x.source_item_key = r.source_item_key
        );

      if (
        select count(*)
        from attendance_private.attendance_sheet_sync_stage x
        where x.run_id = v_run_id
      ) <> v_payload_row_count + v_protected_delete_count then
        raise exception 'protected_delete_stage_count_mismatch';
      end if;

      -- No canonical delete is applied for this unreviewed delta. The original
      -- candidate count is retained separately in the success diagnostics.
      v_deleted := 0;
    end if;$new$;
  v_metadata_old text := $old$        'raw_event_count',v_raw,'canonical_event_count',v_canonical,'mirror_count',v_mirrors,$old$;
  v_metadata_new text := $new$        'raw_event_count',v_raw,'canonical_event_count',v_canonical,'mirror_count',v_mirrors,
        'protected_delete_count',v_protected_delete_count,$new$;
  v_result_old text := $old$      'inserted',v_inserted,'updated',v_updated,'deleted',v_deleted,'unchanged',v_unchanged,$old$;
  v_result_new text := $new$      'inserted',v_inserted,'updated',v_updated,'deleted',v_deleted,
      'protected_deletes',v_protected_delete_count,'unchanged',v_unchanged,$new$;
begin
  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;

  if strpos(v_definition, v_declaration_old) = 0 then
    raise exception 'annual_attendance_protected_merge_declaration_marker_missing';
  end if;
  if (
    length(v_definition) - length(replace(v_definition, v_guard_tail_old, ''))
  ) / length(v_guard_tail_old) <> 1 then
    raise exception 'annual_attendance_protected_merge_guard_marker_mismatch';
  end if;
  if strpos(v_definition, v_metadata_old) = 0 then
    raise exception 'annual_attendance_protected_merge_metadata_marker_missing';
  end if;
  if strpos(v_definition, v_result_old) = 0 then
    raise exception 'annual_attendance_protected_merge_result_marker_missing';
  end if;

  v_definition := replace(v_definition, v_declaration_old, v_declaration_new);
  v_definition := replace(v_definition, v_guard_tail_old, v_guard_tail_new);
  v_definition := replace(v_definition, v_metadata_old, v_metadata_new);
  v_definition := replace(v_definition, v_result_old, v_result_new);
  execute v_definition;

  select pg_catalog.pg_get_functiondef(v_signature)
  into v_definition;
  if strpos(v_definition, 'v_protected_delete_count integer := 0') = 0
    or strpos(v_definition, 'v_source_key <> ''home_ph_annual_2026_09''') = 0
    or strpos(v_definition, 'v_payload_row_count + v_protected_delete_count') = 0
    or strpos(v_definition, 'v_deleted := 0') = 0
    or strpos(v_definition, '''protected_deletes'',v_protected_delete_count') = 0
    or strpos(v_definition, '''protected_delete_count'',v_protected_delete_count') = 0
    -- These markers prove the existing safety boundaries remain installed.
    or strpos(v_definition, 'empty_snapshot_requires_manual_override') = 0
    or strpos(v_definition, 'v_deleted <= 5') = 0
    or strpos(v_definition, 'annual_snapshot_deletes_are_count_preserving_moves') = 0
    or strpos(v_definition, 'v_expected_delete_count=v_deleted') = 0
  then
    raise exception 'annual_attendance_protected_merge_install_failed';
  end if;
end;
$migration$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

comment on function attendance_private.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role-only annual attendance ingest; Home-PH Sep valid rows merge while unreviewed omissions are retained and counted.';

notify pgrst, 'reload schema';
