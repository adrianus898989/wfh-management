begin;

-- An automatic annual snapshot is allowed to retain rows that disappeared
-- from Home-PH September so a malformed/truncated sheet cannot erase history.
-- Retained rows are not evidence that the event is still present in the latest
-- Google snapshot, however. Mark that distinction explicitly and keep such
-- rows out of current attendance alerts until the source row reappears.
do $install_protected_missing_attendance$
declare
  v_ingest_signature regprocedure :=
    'attendance_private.ingest_annual_attendance_snapshot(jsonb)'::regprocedure;
  v_refresh_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_enrich_signature regprocedure :=
    'alerts_private.enrich_attendance_alert_details()'::regprocedure;
  v_ingest text;
  v_refresh text;
  v_enrich text;
  v_marker text;
  v_old_hits integer;
  v_declaration_old text := $old$  v_protected_delete_count integer := 0;$old$;
  v_declaration_new text := $new$  v_protected_delete_count integer := 0;
  v_protected_tagged_hash text;$new$;
  v_source_read_old text := $old$  select
    case when lower(s.content_hash) ~ '^[0-9a-f]{64}$' then lower(s.content_hash) end,
    nullif(s.metadata#>>'{live_sync,last_captured_at}', '')::timestamptz
  into v_previous_hash, v_last_captured_at
  from public.attendance_sheet_sources s
  where s.id = v_source_id;$old$;
  v_source_read_new text := $new$  select
    case when lower(s.content_hash) ~ '^[0-9a-f]{64}$' then lower(s.content_hash) end,
    nullif(s.metadata#>>'{live_sync,last_captured_at}', '')::timestamptz,
    nullif(s.metadata->>'protected_missing_tagged_hash', '')
  into v_previous_hash, v_last_captured_at, v_protected_tagged_hash
  from public.attendance_sheet_sources s
  where s.id = v_source_id;$new$;
  v_fast_path_old text := $old$  if v_previous_hash = v_snapshot_hash then
    return jsonb_build_object($old$;
  v_fast_path_new text := $new$  if v_previous_hash = v_snapshot_hash
    and not (
      v_source_key = 'home_ph_annual_2026_09'
      and v_protected_tagged_hash is distinct from v_snapshot_hash
    ) then
    return jsonb_build_object($new$;
  v_protected_row_old text := $old$        r.raw_values, r.content_hash, r.is_mirror, r.source_updated_at
      from public.employee_attendance_records r$old$;
  v_protected_row_new text := $new$        r.raw_values || pg_catalog.jsonb_build_object(
          'sync_presence', 'protected_missing',
          'sync_protected_missing_snapshot_hash', v_snapshot_hash,
          'sync_protected_missing_at', v_captured_at
        ),
        pg_catalog.md5(
          'protected_missing:v1:a:' || v_source_id::text || ':' ||
          r.source_block || ':' || r.source_row::text || ':' ||
          r.source_item_key || ':' || v_snapshot_hash
        ) || pg_catalog.md5(
          'protected_missing:v1:b:' || v_source_id::text || ':' ||
          r.source_block || ':' || r.source_row::text || ':' ||
          r.source_item_key || ':' || v_snapshot_hash
        ),
        r.is_mirror, r.source_updated_at
      from public.employee_attendance_records r$new$;
  v_metadata_old text := $old$        'protected_delete_count',v_protected_delete_count,
        'live_sync',$old$;
  v_metadata_new text := $new$        'protected_delete_count',v_protected_delete_count,
        'protected_missing_tagged_hash',v_snapshot_hash,
        'live_sync',$new$;
  v_refresh_days_old text := $old$    where record.employee_id is not null
      and record.kind = 'attendance'
      and record.event_date >= least($old$;
  v_refresh_days_new text := $new$    where record.employee_id is not null
      and record.kind = 'attendance'
      and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
      and record.event_date >= least($new$;
  v_source_evidence_old text := $old$       and record.kind = 'attendance'
       and not record.is_mirror
       and pg_catalog.lower(record.event_kind) in ($old$;
  v_source_evidence_new text := $new$       and record.kind = 'attendance'
       and not record.is_mirror
       and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
       and pg_catalog.lower(record.event_kind) in ($new$;
  v_enrich_old text := $old$     and record.kind = 'attendance'
     and record.event_date between alert.window_start and alert.window_end
    where ($old$;
  v_enrich_new text := $new$     and record.kind = 'attendance'
     and record.event_date between alert.window_start and alert.window_end
     and record.raw_values->>'sync_presence' is distinct from 'protected_missing'
    where ($new$;
begin
  select pg_catalog.pg_get_functiondef(v_ingest_signature) into v_ingest;
  select pg_catalog.pg_get_functiondef(v_refresh_signature) into v_refresh;
  select pg_catalog.pg_get_functiondef(v_enrich_signature) into v_enrich;

  -- Refuse to rewrite an unexpected production function shape. These exact
  -- markers were installed by the reviewed protected-merge migration.
  if position('v_source_key <> ''home_ph_annual_2026_09''' in v_ingest) = 0
     or position('v_deleted := 0' in v_ingest) = 0
     or position('empty_snapshot_requires_manual_override' in v_ingest) = 0
     or position('annual_snapshot_deletes_are_count_preserving_moves' in v_ingest) = 0
     or position('statement_timeout=6s' in array_to_string(
       coalesce((select proconfig from pg_catalog.pg_proc where oid = v_refresh_signature), array[]::text[]),
       ','
     )) = 0 then
    raise exception 'protected_missing_attendance_precondition_failed';
  end if;

  foreach v_marker in array array[v_declaration_old, v_source_read_old,
    v_fast_path_old, v_protected_row_old, v_metadata_old]
  loop
    v_old_hits := (
      pg_catalog.length(pg_catalog.pg_get_functiondef(v_ingest_signature))
      - pg_catalog.length(pg_catalog.replace(
        pg_catalog.pg_get_functiondef(v_ingest_signature), v_marker, ''
      ))
    ) / pg_catalog.length(v_marker);
    if v_old_hits <> 1 then
      raise exception 'protected_missing_ingest_marker_mismatch:%', v_old_hits;
    end if;
  end loop;

  select pg_catalog.pg_get_functiondef(v_ingest_signature) into v_ingest;
  v_ingest := pg_catalog.replace(v_ingest, v_declaration_old, v_declaration_new);
  v_ingest := pg_catalog.replace(v_ingest, v_source_read_old, v_source_read_new);
  v_ingest := pg_catalog.replace(v_ingest, v_fast_path_old, v_fast_path_new);
  v_ingest := pg_catalog.replace(v_ingest, v_protected_row_old, v_protected_row_new);
  v_ingest := pg_catalog.replace(v_ingest, v_metadata_old, v_metadata_new);
  execute v_ingest;

  v_old_hits := (
    pg_catalog.length(v_refresh)
    - pg_catalog.length(pg_catalog.replace(v_refresh, v_refresh_days_old, ''))
  ) / pg_catalog.length(v_refresh_days_old);
  if v_old_hits <> 1 then
    raise exception 'protected_missing_refresh_days_marker_mismatch:%', v_old_hits;
  end if;
  v_refresh := pg_catalog.replace(v_refresh, v_refresh_days_old, v_refresh_days_new);

  v_old_hits := (
    pg_catalog.length(v_refresh)
    - pg_catalog.length(pg_catalog.replace(v_refresh, v_source_evidence_old, ''))
  ) / pg_catalog.length(v_source_evidence_old);
  if v_old_hits <> 1 then
    raise exception 'protected_missing_source_evidence_marker_mismatch:%', v_old_hits;
  end if;
  v_refresh := pg_catalog.replace(v_refresh, v_source_evidence_old, v_source_evidence_new);
  execute v_refresh;

  v_old_hits := (
    pg_catalog.length(v_enrich)
    - pg_catalog.length(pg_catalog.replace(v_enrich, v_enrich_old, ''))
  ) / pg_catalog.length(v_enrich_old);
  if v_old_hits <> 1 then
    raise exception 'protected_missing_enrichment_marker_mismatch:%', v_old_hits;
  end if;
  v_enrich := pg_catalog.replace(v_enrich, v_enrich_old, v_enrich_new);
  execute v_enrich;

  select pg_catalog.pg_get_functiondef(v_ingest_signature) into v_ingest;
  select pg_catalog.pg_get_functiondef(v_refresh_signature) into v_refresh;
  select pg_catalog.pg_get_functiondef(v_enrich_signature) into v_enrich;
  if position('protected_missing_tagged_hash' in v_ingest) = 0
     or position('sync_protected_missing_snapshot_hash' in v_ingest) = 0
     or position('sync_presence'', ''protected_missing' in v_ingest) = 0
     or position('record.raw_values->>''sync_presence'' is distinct from ''protected_missing''' in v_refresh) = 0
     or position('record.raw_values->>''sync_presence'' is distinct from ''protected_missing''' in v_enrich) = 0
     or position('where v_group <> ''access_exam''' in v_refresh) = 0
     or position('alerts_private.enrich_attendance_alert_details()' in v_refresh) = 0
     or position('v_source_key <> ''home_ph_annual_2026_09''' in v_ingest) = 0
     or position('empty_snapshot_requires_manual_override' in v_ingest) = 0 then
    raise exception 'protected_missing_attendance_install_failed';
  end if;
end;
$install_protected_missing_attendance$;

-- Production evidence was cross-checked against both current Google tabs:
-- CS000673 has only 2026-09-05 now. Preserve the old 09-06 row for audit, but
-- backfill the same marker immediately so the already-stored omission does not
-- have to wait for another sheet edit before the warning can resolve. Every
-- source/employee/date predicate is pinned to the observed row. The migration
-- requires exactly one previously unmarked row, so a duplicate or unexpected
-- production shape fails closed without depending on mutable sync timestamps
-- or hashes.
do $backfill_cs000673_protected_missing$
declare
  v_updated integer := 0;
begin
  update public.employee_attendance_records record
  set raw_values = record.raw_values || pg_catalog.jsonb_build_object(
        'sync_presence', 'protected_missing',
        'sync_protected_missing_snapshot_hash',
          '0344870946dea701eb8196ac06403c200b3b452a20caf622e67e0f63c30c77d4',
        'sync_protected_missing_at', pg_catalog.clock_timestamp()
      ),
      content_hash = pg_catalog.md5(
        'protected_missing:v1:a:' || record.source_id::text || ':' ||
        record.source_block || ':' || record.source_row::text || ':' ||
        record.source_item_key || ':' ||
        '0344870946dea701eb8196ac06403c200b3b452a20caf622e67e0f63c30c77d4'
      ) || pg_catalog.md5(
        'protected_missing:v1:b:' || record.source_id::text || ':' ||
        record.source_block || ':' || record.source_row::text || ':' ||
        record.source_item_key || ':' ||
        '0344870946dea701eb8196ac06403c200b3b452a20caf622e67e0f63c30c77d4'
      ),
      updated_at = pg_catalog.clock_timestamp()
  from public.attendance_sheet_sources source,
       public.employees employee
  where record.source_id = source.id
    and record.employee_id = employee.id
    and source.source_key = 'home_ph_annual_2026_09'
    and employee.employee_no = 'CS000673'
    and record.source_block = 'attendance'
    and record.kind = 'attendance'
    and record.event_date = date '2026-09-06'
    and record.event_kind = 'public_holiday'
    and record.raw_values->>'sync_presence' is distinct from 'protected_missing';
  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'cs000673_protected_missing_backfill_expected_one:%', v_updated;
  end if;
end;
$backfill_cs000673_protected_missing$;

-- Resolve only the confirmed stale incident in this transaction. Running the
-- whole attendance detector here would make a one-row correction contend with
-- login traffic and can exceed its bounded statement timeout under load. The
-- next scheduled detector still reconciles every other attendance alert.
update public.admin_alert_events alert
set is_active = false,
    last_seen_at = pg_catalog.clock_timestamp(),
    resolved_at = coalesce(alert.resolved_at, pg_catalog.clock_timestamp())
from public.employees employee
where alert.employee_id = employee.id
  and employee.employee_no = 'CS000673'
  and alert.alert_type = 'consecutive_rest'
  and alert.window_start = date '2026-09-05'
  and alert.window_end = date '2026-09-06'
  and alert.is_active;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;
revoke all on function alerts_private.refresh_alert_group(text)
  from public, anon, authenticated;
revoke all on function alerts_private.enrich_attendance_alert_details()
  from public, anon, authenticated;

comment on function attendance_private.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role annual ingest; protected missing rows remain historical but are marked as absent from the latest Google snapshot.';
comment on function alerts_private.refresh_alert_group(text) is
  'Bounded stable-alert refresh; attendance rules use only records present in the latest source snapshot.';
comment on function alerts_private.enrich_attendance_alert_details() is
  'Enriches active attendance alerts without protected missing source evidence.';

notify pgrst, 'reload schema';

commit;
