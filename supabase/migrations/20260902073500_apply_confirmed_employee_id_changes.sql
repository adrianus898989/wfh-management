begin;

set local lock_timeout = '5s';
set local statement_timeout = '240s';

-- WD000460/ZJ00195 and WD000783/ZJ00196 are two confirmed same-person
-- employee-number changes. Keep this migration deliberately narrower than
-- the historical one-time reconciliation: it reuses its private merge ledger,
-- alias guards, work table and complete employee-FK inventory, but it does not
-- rerun stale global roster assertions from that earlier migration.
do $apply_confirmed_employee_id_changes_20260902$
declare
  v_latest_run_id bigint;
  v_pair record;
  v_ref record;
  v_source_employee record;
  v_target_employee record;
  v_home_old_count integer;
  v_home_new_count integer;
  v_schedule_old_count integer;
  v_schedule_new_count integer;
  v_home_name_key text;
  v_schedule_name_key text;
  v_source_name_key text;
  v_target_name_key text;
  v_source_tg_key text;
  v_target_tg_key text;
  v_reference_key text;
  v_source_before bigint;
  v_target_before bigint;
  v_target_after bigint;
  v_cache_source_before bigint;
  v_cache_target_before bigint;
  v_cache_target_after bigint;
  v_expected_merge integer;
  v_merged integer;
  v_issue_count_before integer;
  v_issue_count_after integer;
  v_parse_warning_count integer;
  v_pending_departure_count integer;
  v_pending_issue_count integer;
  v_run_rekeyed_count integer;
  v_removed_issue_count integer;
  v_schedule_count integer;
  v_directory_nonblank_count integer;
  v_directory_distinct_count integer;
  v_directory_rows jsonb := '[]'::jsonb;
  v_directory_result jsonb;
  v_directory_writer_definition text;
  v_left bigint;
begin
  if to_regprocedure(
       'employee_private.resolve_confirmed_employee_id(text)'
     ) is null
     or to_regclass(
       'employee_private.employee_identity_merge_ledger'
     ) is null
     or to_regclass(
       'employee_private.employee_identity_reconcile_merge_plan'
     ) is null
     or to_regclass(
       'attendance_private.historical_employee_directory_cache'
     ) is null
     or to_regprocedure(
       'scope_private.rebuild_all_assigned_employee_scopes()'
     ) is null
     or to_regprocedure(
       'public.sync_report_employee_directory_scope_inner_v1(jsonb)'
     ) is null then
    raise exception 'confirmed_employee_id_merge_prerequisite_missing';
  end if;

  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_directory_writer_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid =
    'public.sync_report_employee_directory_scope_inner_v1(jsonb)'::regprocedure;
  if pg_catalog.strpos(
       v_directory_writer_definition,
       'delete from public.report_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_directory_writer_definition,
       'insert into public.report_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_directory_writer_definition,
       'from public.employees e'
     ) = 0
     or pg_catalog.strpos(
       v_directory_writer_definition,
       'from public.employee_lifecycle_events l'
     ) = 0
     or pg_catalog.strpos(
       v_directory_writer_definition,
       'rebuild_all_assigned_employee_scopes'
     ) > 0
     or pg_catalog.strpos(
       v_directory_writer_definition,
       'rebuild_online_training_roster_relationships'
     ) > 0 then
    raise exception 'confirmed_employee_id_directory_writer_shape_changed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-master-reconciliation', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'employee-master-dual-source-sync', 20260825
    )
  );

  -- Coalesce employee delete/access relink rebuild requests, then rebuild once
  -- after both canonical UUIDs are final.
  perform pg_catalog.set_config(
    'scope_private.defer_assigned_scope_rebuild', 'on', true
  );
  perform pg_catalog.set_config(
    'scope_private.assigned_scope_rebuild_dirty', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild', 'on', true
  );

  delete from employee_private.employee_identity_reconcile_merge_plan;
  insert into employee_private.employee_identity_reconcile_merge_plan (
    previous_employee_no, official_employee_no
  ) values
    ('WD000460', 'ZJ00195'),
    ('WD000783', 'ZJ00196');

  select run.id
  into v_latest_run_id
  from public.employee_master_sync_runs run
  where run.status = 'success'
  order by run.id desc
  limit 1;

  if v_latest_run_id is null
     or (
       select count(*)
       from public.employee_master_source_snapshots snapshot
       where snapshot.run_id = v_latest_run_id
         and snapshot.source_key in (
           'home_employee_roster_current',
           'home_schedule_roster_current'
         )
         and jsonb_typeof(snapshot.payload) = 'array'
         and snapshot.row_count = jsonb_array_length(snapshot.payload)
         and snapshot.row_count > 100
     ) <> 2 then
    raise exception 'confirmed_employee_id_latest_source_pair_invalid:%',
      coalesce(v_latest_run_id::text, 'null');
  end if;

  select count(*)::integer
  into v_issue_count_before
  from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id;

  select run.warning_count - v_issue_count_before
  into v_parse_warning_count
  from public.employee_master_sync_runs run
  where run.id = v_latest_run_id;
  if v_parse_warning_count < 0 then
    raise exception 'confirmed_employee_id_warning_count_below_issue_count';
  end if;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set target_employee_id = target_employee.id
  from public.employees target_employee
  where public.employee_master_normalize_id(target_employee.employee_no) =
    plan.official_employee_no;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_employee_id = source_employee.id,
      source_present = true
  from public.employees source_employee
  where public.employee_master_normalize_id(source_employee.employee_no) =
    plan.previous_employee_no;

  -- An idempotent retry recovers the retired UUID only from the exact immutable
  -- ledger tuple. It never guesses a source UUID by name.
  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_employee_id = ledger.source_employee_id
  from employee_private.employee_identity_merge_ledger ledger
  where plan.source_employee_id is null
    and ledger.migration_key =
          '2026-09-02:' || plan.previous_employee_no
    and public.employee_master_normalize_id(
          ledger.previous_employee_no
        ) = plan.previous_employee_no
    and public.employee_master_normalize_id(
          ledger.official_employee_no
        ) = plan.official_employee_no
    and ledger.target_employee_id = plan.target_employee_id;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      where plan.source_employee_id is not null
        and plan.target_employee_id is not null
        and plan.source_employee_id <> plan.target_employee_id) <> 2 then
    raise exception 'confirmed_employee_id_pair_missing_or_ambiguous';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_merge_ledger ledger
    join employee_private.employee_identity_reconcile_merge_plan plan
      on ledger.migration_key =
           '2026-09-02:' || plan.previous_employee_no
        or employee_private.employee_identity_key(
             ledger.previous_employee_no
           ) = employee_private.employee_identity_key(
             plan.previous_employee_no
           )
        or employee_private.employee_identity_key(
             ledger.official_employee_no
           ) = employee_private.employee_identity_key(
             plan.official_employee_no
           )
    where ledger.migration_key <>
            '2026-09-02:' || plan.previous_employee_no
       or public.employee_master_normalize_id(
            ledger.previous_employee_no
          ) <> plan.previous_employee_no
       or public.employee_master_normalize_id(
            ledger.official_employee_no
          ) <> plan.official_employee_no
       or ledger.source_employee_id <> plan.source_employee_id
       or ledger.target_employee_id <> plan.target_employee_id
  ) then
    raise exception 'confirmed_employee_id_ledger_conflict';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    join employee_private.employee_identity_merge_ledger ledger
      on ledger.migration_key =
           '2026-09-02:' || plan.previous_employee_no
     and ledger.source_employee_id = plan.source_employee_id
     and ledger.target_employee_id = plan.target_employee_id
    where plan.source_present
  ) then
    raise exception 'confirmed_employee_id_retry_source_row_reappeared';
  end if;

  -- The two retired rows are visible in the latest run only as exact
  -- missing-from-both/manual-review issues. A fresh merge requires one exact
  -- issue per source UUID; an idempotent retry requires none. This prevents a
  -- similarly numbered but semantically different warning from being hidden.
  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    left join public.employee_master_sync_issues issue
      on issue.run_id = v_latest_run_id
     and public.employee_master_normalize_id(issue.employee_no) =
           plan.previous_employee_no
    group by plan.previous_employee_no, plan.source_employee_id,
      plan.source_present
    having count(issue.id) <>
             case when plan.source_present then 1 else 0 end
       or count(issue.id) filter (
            where issue.issue_code = 'pending_manual_review'
              and issue.home_source_row is null
              and issue.schedule_source_row is null
              and issue.details->>'action' =
                    'manual_review_no_status_or_access_change'
              and issue.details->>'reason' =
                    'missing_from_both_complete_sources'
              and issue.details->>'employee_id' =
                    plan.source_employee_id::text
          ) <> case when plan.source_present then 1 else 0 end
  ) then
    raise exception 'confirmed_employee_id_pending_issue_shape_changed';
  end if;

  -- Retry is intentionally bounded to the same accepted run that owns the
  -- immutable rekey records. If a newer success run has arrived, fail closed
  -- and let that run's own counters/issues remain untouched.
  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    left join public.employee_identity_rekeys rekey
      on rekey.employee_id = plan.target_employee_id
     and public.employee_master_normalize_id(rekey.previous_employee_no) =
           plan.previous_employee_no
     and public.employee_master_normalize_id(rekey.official_employee_no) =
           plan.official_employee_no
    where not plan.source_present
      and rekey.run_id is distinct from v_latest_run_id
  ) then
    raise exception 'confirmed_employee_id_retry_latest_run_changed';
  end if;

  -- Fresh merges require three independent exact anchors and unique source
  -- evidence: same normalized name, nonblank Work TG and hire date; old number
  -- absent from both sources; official number present exactly once in both.
  for v_pair in
    select *
    from employee_private.employee_identity_reconcile_merge_plan plan
    where plan.source_present
    order by plan.previous_employee_no
  loop
    select source_employee.*
    into strict v_source_employee
    from public.employees source_employee
    where source_employee.id = v_pair.source_employee_id;

    select target_employee.*
    into strict v_target_employee
    from public.employees target_employee
    where target_employee.id = v_pair.target_employee_id;

    v_source_name_key := lower(regexp_replace(
      btrim(v_source_employee.full_name),
      '[[:space:][:punct:]]+', '', 'g'
    ));
    v_target_name_key := lower(regexp_replace(
      btrim(v_target_employee.full_name),
      '[[:space:][:punct:]]+', '', 'g'
    ));
    v_source_tg_key := regexp_replace(
      lower(btrim(coalesce(v_source_employee.work_tg, ''))),
      '[^a-z0-9]+', '', 'g'
    );
    v_target_tg_key := regexp_replace(
      lower(btrim(coalesce(v_target_employee.work_tg, ''))),
      '[^a-z0-9]+', '', 'g'
    );

    if nullif(v_source_name_key, '') is null
       or v_source_name_key <> v_target_name_key
       or nullif(v_source_tg_key, '') is null
       or v_source_tg_key <> v_target_tg_key
       or v_source_employee.hire_date is null
       or v_source_employee.hire_date is distinct from
            v_target_employee.hire_date
       or v_source_employee.status not in (
            'active', 'probation', 'suspended'
          )
       or v_source_employee.status is distinct from v_target_employee.status
       or coalesce(v_source_employee.source_type, '') = 'google_deleted'
       or coalesce(v_target_employee.source_type, '') = 'google_deleted' then
      raise exception 'confirmed_employee_id_identity_evidence_mismatch:%',
        v_pair.previous_employee_no;
    end if;

    select
      count(*) filter (
        where snapshot.source_key = 'home_employee_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.previous_employee_no
      )::integer,
      count(*) filter (
        where snapshot.source_key = 'home_employee_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.official_employee_no
      )::integer,
      count(*) filter (
        where snapshot.source_key = 'home_schedule_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.previous_employee_no
      )::integer,
      count(*) filter (
        where snapshot.source_key = 'home_schedule_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.official_employee_no
      )::integer,
      min(coalesce(
        nullif(btrim(item->>'name_key'), ''),
        lower(regexp_replace(
          btrim(coalesce(item->>'name', '')),
          '[[:space:][:punct:]]+', '', 'g'
        ))
      )) filter (
        where snapshot.source_key = 'home_employee_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.official_employee_no
      ),
      min(coalesce(
        nullif(btrim(item->>'name_key'), ''),
        lower(regexp_replace(
          btrim(coalesce(item->>'name', '')),
          '[[:space:][:punct:]]+', '', 'g'
        ))
      )) filter (
        where snapshot.source_key = 'home_schedule_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                v_pair.official_employee_no
      )
    into v_home_old_count, v_home_new_count,
      v_schedule_old_count, v_schedule_new_count,
      v_home_name_key, v_schedule_name_key
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    where snapshot.run_id = v_latest_run_id
      and snapshot.source_key in (
        'home_employee_roster_current',
        'home_schedule_roster_current'
      );

    if v_home_old_count <> 0
       or v_schedule_old_count <> 0
       or v_home_new_count <> 1
       or v_schedule_new_count <> 1
       or nullif(v_home_name_key, '') is null
       or v_home_name_key <> v_target_name_key
       or v_schedule_name_key <> v_target_name_key then
      raise exception
        'confirmed_employee_id_source_evidence_mismatch:%:%:%:%:%',
        v_pair.previous_employee_no,
        v_home_old_count, v_home_new_count,
        v_schedule_old_count, v_schedule_new_count;
    end if;
  end loop;

  -- Use the exact employee-FK inventory from the mature nine-person merge. A
  -- newly added or removed FK aborts rather than being silently skipped.
  if exists (
    with actual as (
      select namespace.nspname schema_name,
        relation.relname table_name,
        attribute.attname column_name
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation
        on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      cross join lateral unnest(constraint_row.conkey) key_column(attnum)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
      where constraint_row.contype = 'f'
        and constraint_row.confrelid = 'public.employees'::regclass
    ), expected(schema_name, table_name, column_name) as (
      values
        ('attendance_private', 'employee_resignation_sync_state', 'employee_id'),
        ('employee_private', 'employee_identity_merge_ledger', 'target_employee_id'),
        ('employee_private', 'employee_note_revisions', 'employee_id'),
        ('employee_private', 'employee_notes', 'employee_id'),
        ('payroll_private', 'employee_identity_aliases', 'employee_id'),
        ('public', 'admin_alert_events', 'employee_id'),
        ('public', 'audit_logs', 'employee_id'),
        ('public', 'employee_activation_codes', 'employee_id'),
        ('public', 'employee_attendance_records', 'employee_id'),
        ('public', 'employee_audit_logs', 'employee_id'),
        ('public', 'employee_compensation_legacy', 'employee_id'),
        ('public', 'employee_compensation_settings', 'employee_id'),
        ('public', 'employee_connectivity_incidents', 'employee_id'),
        ('public', 'employee_contact_profiles', 'employee_id'),
        ('public', 'employee_identity_rekeys', 'employee_id'),
        ('public', 'employee_lifecycle_events', 'employee_id'),
        ('public', 'employee_master_presence_state', 'employee_id'),
        ('public', 'employee_payment_profiles', 'employee_id'),
        ('public', 'employees', 'direct_leader_id'),
        ('public', 'employees', 'trainer_id'),
        ('public', 'exam_assignments', 'employee_id'),
        ('public', 'exam_sessions', 'employee_id'),
        ('public', 'legacy_exam_sessions', 'employee_id'),
        ('public', 'online_training_report_members', 'employee_id'),
        ('public', 'online_training_reports', 'author_employee_id'),
        ('public', 'payout_accounts', 'employee_id'),
        ('public', 'payout_change_requests', 'employee_id'),
        ('public', 'payroll_payslips', 'employee_id'),
        ('public', 'user_access', 'employee_id'),
        ('public', 'user_scope_employee_filters', 'employee_id'),
        ('public', 'user_scope_employees', 'employee_id'),
        ('session_private', 'online_training_roster_relationships', 'learner_employee_id'),
        ('session_private', 'online_training_roster_relationships', 'online_leader_employee_id'),
        ('session_private', 'online_training_roster_relationships', 'online_trainer_employee_id'),
        ('session_private', 'online_training_roster_relationships', 'onsite_trainer_employee_id'),
        ('session_private', 'online_training_roster_relationships', 'responsible_employee_id')
    )
    select 1
    from (
      (select * from actual except select * from expected)
      union all
      (select * from expected except select * from actual)
    ) difference
  ) then
    raise exception 'confirmed_employee_id_fk_inventory_changed';
  end if;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_kind = 'home_roster',
      source_row = (
        select min((item->>'source_row')::integer)
        from public.employee_master_source_snapshots snapshot
        cross join lateral jsonb_array_elements(snapshot.payload) item
        where snapshot.run_id = v_latest_run_id
          and snapshot.source_key = 'home_employee_roster_current'
          and public.employee_master_normalize_id(item->>'employee_id') =
                plan.official_employee_no
      );

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    where plan.source_row is null
  ) then
    raise exception 'confirmed_employee_id_source_row_missing';
  end if;

  if exists (
    select 1
    from public.employee_identity_rekeys rekey
    join employee_private.employee_identity_reconcile_merge_plan plan
      on public.employee_master_normalize_id(rekey.official_employee_no) =
           plan.official_employee_no
        or public.employee_master_normalize_id(rekey.previous_employee_no) =
           plan.previous_employee_no
    where rekey.employee_id <> plan.target_employee_id
       or public.employee_master_normalize_id(rekey.official_employee_no) <>
            plan.official_employee_no
       or public.employee_master_normalize_id(rekey.previous_employee_no) <>
            plan.previous_employee_no
  ) then
    raise exception 'confirmed_employee_id_rekey_conflict';
  end if;

  if exists (
    select 1
    from payroll_private.employee_identity_aliases alias
    join employee_private.employee_identity_reconcile_merge_plan plan
      on alias.old_employee_no_key =
           employee_private.employee_identity_key(
             plan.previous_employee_no
           )
    join public.employees target_employee
      on target_employee.id = plan.target_employee_id
    where alias.employee_id <> plan.target_employee_id
       or alias.employee_no_at_match <> target_employee.employee_no
       or alias.match_source <> 'confirmed_employee_id_alias'
  ) then
    raise exception 'confirmed_employee_id_payroll_alias_conflict';
  end if;

  -- Snapshot every reference count before movement. These counts are persisted
  -- in the private recovery ledger and checked immediately after each update.
  for v_ref in
    select namespace.nspname schema_name,
      relation.relname table_name,
      attribute.attname column_name
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral unnest(constraint_row.conkey) key_column(attnum)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = key_column.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.employees'::regclass
    order by 1, 2, 3
  loop
    v_reference_key := v_ref.schema_name || '.' || v_ref.table_name ||
      '.' || v_ref.column_name;
    execute format(
      'update employee_private.employee_identity_reconcile_merge_plan plan '
      || 'set moved_reference_counts = plan.moved_reference_counts '
      || '|| jsonb_build_object(%L, ('
      || 'select count(*) from %I.%I referenced '
      || 'where referenced.%I = plan.source_employee_id), %L, ('
      || 'select count(*) from %I.%I referenced '
      || 'where referenced.%I = plan.target_employee_id))',
      v_reference_key,
      v_ref.schema_name, v_ref.table_name, v_ref.column_name,
      v_reference_key || ':target_before',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name
    );
  end loop;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set moved_reference_counts = plan.moved_reference_counts ||
    jsonb_build_object(
      'attendance_private.historical_employee_directory_cache.current_employee_id',
      (
        select count(*)
        from attendance_private.historical_employee_directory_cache cache
        where cache.current_employee_id = plan.source_employee_id
      ),
      'attendance_private.historical_employee_directory_cache.current_employee_id:target_before',
      (
        select count(*)
        from attendance_private.historical_employee_directory_cache cache
        where cache.current_employee_id = plan.target_employee_id
      )
    );

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    where plan.source_present
      and (
        coalesce((plan.moved_reference_counts->>
          'public.employee_master_presence_state.employee_id')::bigint, 0) <> 1
        or coalesce((plan.moved_reference_counts->>
          'public.employee_master_presence_state.employee_id:target_before')::bigint, 0) <> 1
      )
  ) then
    raise exception 'confirmed_employee_id_presence_preflight_changed';
  end if;

  insert into employee_private.employee_identity_merge_ledger (
    migration_key, source_employee_id, target_employee_id,
    previous_employee_no, official_employee_no, full_name,
    previous_employee_snapshot, moved_reference_counts,
    reason, approved_by, merged_at
  )
  select
    '2026-09-02:' || plan.previous_employee_no,
    plan.source_employee_id, plan.target_employee_id,
    plan.previous_employee_no, plan.official_employee_no,
    target_employee.full_name, to_jsonb(source_employee),
    plan.moved_reference_counts,
    'User confirmed old and official IDs represent the same person.',
    'user-confirmed-2026-09-02', clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join public.employees source_employee
    on source_employee.id = plan.source_employee_id
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  where plan.source_present
  on conflict (migration_key) do nothing;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      join employee_private.employee_identity_merge_ledger ledger
        on ledger.migration_key =
             '2026-09-02:' || plan.previous_employee_no
       and ledger.source_employee_id = plan.source_employee_id
       and ledger.target_employee_id = plan.target_employee_id
       and public.employee_master_normalize_id(
             ledger.previous_employee_no
           ) = plan.previous_employee_no
       and public.employee_master_normalize_id(
             ledger.official_employee_no
           ) = plan.official_employee_no) <> 2 then
    raise exception 'confirmed_employee_id_ledger_write_failed';
  end if;

  update attendance_private.historical_employee_directory_cache cache
  set current_employee_id = plan.target_employee_id
  from employee_private.employee_identity_reconcile_merge_plan plan
  where cache.current_employee_id = plan.source_employee_id;

  for v_pair in
    select *
    from employee_private.employee_identity_reconcile_merge_plan plan
    order by plan.previous_employee_no
  loop
    v_cache_source_before := coalesce((
      v_pair.moved_reference_counts->>
      'attendance_private.historical_employee_directory_cache.current_employee_id'
    )::bigint, 0);
    v_cache_target_before := coalesce((
      v_pair.moved_reference_counts->>
      'attendance_private.historical_employee_directory_cache.current_employee_id:target_before'
    )::bigint, 0);
    select count(*)
    into v_cache_target_after
    from attendance_private.historical_employee_directory_cache cache
    where cache.current_employee_id = v_pair.target_employee_id;
    if exists (
         select 1
         from attendance_private.historical_employee_directory_cache cache
         where cache.current_employee_id = v_pair.source_employee_id
       )
       or v_cache_target_after <>
            v_cache_source_before + v_cache_target_before then
      raise exception
        'confirmed_employee_id_historical_cache_reference_changed:%',
        v_pair.previous_employee_no;
    end if;
  end loop;

  -- Presence is derived and both UUIDs already have a row. Keep the official
  -- row and remove only the retired duplicate.
  delete from public.employee_master_presence_state presence
  using employee_private.employee_identity_reconcile_merge_plan plan
  where presence.employee_id = plan.source_employee_id;

  -- Move every other FK through the mature trigger-guarded path. PostgreSQL
  -- uniqueness checks make any unexpected collision abort the transaction.
  for v_ref in
    select namespace.nspname schema_name,
      relation.relname table_name,
      attribute.attname column_name
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral unnest(constraint_row.conkey) key_column(attnum)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = key_column.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.employees'::regclass
      and not (
        namespace.nspname = 'public'
        and relation.relname = 'employee_master_presence_state'
        and attribute.attname = 'employee_id'
      )
      and not (
        namespace.nspname = 'employee_private'
        and relation.relname = 'employee_identity_merge_ledger'
        and attribute.attname = 'target_employee_id'
      )
    order by 1, 2, 3
  loop
    execute format(
      'update %I.%I referenced set %I = plan.target_employee_id '
      || 'from employee_private.employee_identity_reconcile_merge_plan plan '
      || 'where referenced.%I = plan.source_employee_id',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name,
      v_ref.column_name
    );
  end loop;

  -- Verify preservation before adding this migration's own rekey/audit rows.
  for v_ref in
    select namespace.nspname schema_name,
      relation.relname table_name,
      attribute.attname column_name
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral unnest(constraint_row.conkey) key_column(attnum)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = key_column.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.employees'::regclass
    order by 1, 2, 3
  loop
    v_reference_key := v_ref.schema_name || '.' || v_ref.table_name ||
      '.' || v_ref.column_name;
    for v_pair in
      select *
      from employee_private.employee_identity_reconcile_merge_plan plan
      order by plan.previous_employee_no
    loop
      execute format(
        'select count(*) from %I.%I where %I = $1',
        v_ref.schema_name, v_ref.table_name, v_ref.column_name
      ) into v_left using v_pair.source_employee_id;
      if v_left <> 0 then
        raise exception 'confirmed_employee_id_source_reference_remains:%.%.%:%',
          v_ref.schema_name, v_ref.table_name, v_ref.column_name,
          v_pair.previous_employee_no;
      end if;

      if v_ref.schema_name = 'employee_private'
         and v_ref.table_name = 'employee_identity_merge_ledger'
         and v_ref.column_name = 'target_employee_id' then
        continue;
      end if;

      v_source_before := coalesce((
        v_pair.moved_reference_counts->>v_reference_key
      )::bigint, 0);
      v_target_before := coalesce((
        v_pair.moved_reference_counts->>(v_reference_key || ':target_before')
      )::bigint, 0);
      execute format(
        'select count(*) from %I.%I where %I = $1',
        v_ref.schema_name, v_ref.table_name, v_ref.column_name
      ) into v_target_after using v_pair.target_employee_id;

      if v_ref.schema_name = 'public'
         and v_ref.table_name = 'employee_master_presence_state'
         and v_ref.column_name = 'employee_id' then
        if v_target_after <> v_target_before then
          raise exception 'confirmed_employee_id_presence_target_changed:%',
            v_pair.previous_employee_no;
        end if;
      elsif v_target_after <> v_source_before + v_target_before then
        raise exception 'confirmed_employee_id_target_reference_changed:%.%.%:%',
          v_ref.schema_name, v_ref.table_name, v_ref.column_name,
          v_pair.previous_employee_no;
      end if;
    end loop;
  end loop;

  select count(*)::integer
  into v_expected_merge
  from employee_private.employee_identity_reconcile_merge_plan plan
  where plan.source_present;

  delete from public.employees employee
  using employee_private.employee_identity_reconcile_merge_plan plan
  where plan.source_present
    and employee.id = plan.source_employee_id;
  get diagnostics v_merged = row_count;
  if v_merged <> v_expected_merge then
    raise exception 'confirmed_employee_id_duplicate_delete_count:%:%',
      v_merged, v_expected_merge;
  end if;

  insert into public.employee_identity_rekeys (
    employee_id, previous_employee_no, official_employee_no,
    source_kind, source_row, run_id, created_at
  )
  select plan.target_employee_id, plan.previous_employee_no,
    plan.official_employee_no, plan.source_kind, plan.source_row,
    v_latest_run_id, clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  on conflict (official_employee_no) do nothing;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      join public.employee_identity_rekeys rekey
        on rekey.employee_id = plan.target_employee_id
       and public.employee_master_normalize_id(
             rekey.previous_employee_no
           ) = plan.previous_employee_no
       and public.employee_master_normalize_id(
             rekey.official_employee_no
           ) = plan.official_employee_no) <> 2 then
    raise exception 'confirmed_employee_id_rekey_write_failed';
  end if;

  insert into payroll_private.employee_identity_aliases (
    old_employee_no_key, old_employee_no_raw, employee_id,
    employee_no_at_match, full_name_key, hire_date, match_source,
    first_batch_id, first_source_row, last_batch_id, last_source_row,
    created_by, updated_at
  )
  select
    employee_private.employee_identity_key(plan.previous_employee_no),
    plan.previous_employee_no,
    plan.target_employee_id,
    target_employee.employee_no,
    internal.payroll_name_key(ledger.full_name),
    target_employee.hire_date,
    'confirmed_employee_id_alias',
    null, null, null, null, null, clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join employee_private.employee_identity_merge_ledger ledger
    on ledger.migration_key =
         '2026-09-02:' || plan.previous_employee_no
   and ledger.target_employee_id = plan.target_employee_id
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  on conflict (old_employee_no_key) do nothing;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      join employee_private.employee_identity_merge_ledger ledger
        on ledger.migration_key =
             '2026-09-02:' || plan.previous_employee_no
       and ledger.target_employee_id = plan.target_employee_id
      join public.employees target_employee
        on target_employee.id = plan.target_employee_id
      join payroll_private.employee_identity_aliases alias
        on alias.old_employee_no_key =
             employee_private.employee_identity_key(
               plan.previous_employee_no
             )
       and alias.employee_id = plan.target_employee_id
       and alias.employee_no_at_match = target_employee.employee_no
       and alias.full_name_key =
             internal.payroll_name_key(ledger.full_name)
       and alias.hire_date is not distinct from target_employee.hire_date
       and alias.match_source = 'confirmed_employee_id_alias') <> 2 then
    raise exception 'confirmed_employee_id_payroll_alias_write_failed';
  end if;

  insert into public.employee_audit_logs (
    employee_id, employee_no, full_name, action, source,
    actor_username, changes, metadata, created_at
  )
  select target_employee.id, target_employee.employee_no,
    target_employee.full_name, 'identity_merge_confirmed',
    'employee_master_reconciliation', 'system',
    jsonb_build_object(
      'employee_no', jsonb_build_object(
        'from', plan.previous_employee_no,
        'to', plan.official_employee_no
      )
    ),
    jsonb_build_object(
      'previous_employee_id', plan.source_employee_id,
      'canonical_employee_id', plan.target_employee_id,
      'history_preserved', true,
      'approval', 'user-confirmed-2026-09-02'
    ), clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  where not exists (
    select 1
    from public.employee_audit_logs existing_audit
    where existing_audit.employee_id = plan.target_employee_id
      and existing_audit.action = 'identity_merge_confirmed'
      and existing_audit.source = 'employee_master_reconciliation'
      and existing_audit.metadata->>'previous_employee_id' =
            plan.source_employee_id::text
      and existing_audit.metadata->>'canonical_employee_id' =
            plan.target_employee_id::text
  );

  -- These exact latest-run warnings described the retired duplicate UUIDs,
  -- not real departures. Remove only the two approved shapes and recompute the
  -- run counters while preserving the parser-warning component.
  delete from public.employee_master_sync_issues issue
  using employee_private.employee_identity_reconcile_merge_plan plan
  where plan.source_present
    and issue.run_id = v_latest_run_id
    and issue.issue_code = 'pending_manual_review'
    and public.employee_master_normalize_id(issue.employee_no) =
          plan.previous_employee_no
    and issue.home_source_row is null
    and issue.schedule_source_row is null
    and issue.details->>'action' =
          'manual_review_no_status_or_access_change'
    and issue.details->>'reason' =
          'missing_from_both_complete_sources'
    and issue.details->>'employee_id' = plan.source_employee_id::text;
  get diagnostics v_removed_issue_count = row_count;
  if v_removed_issue_count <> v_expected_merge then
    raise exception 'confirmed_employee_id_pending_issue_delete_count:%:%',
      v_removed_issue_count, v_expected_merge;
  end if;

  select count(*)::integer,
    count(*) filter (
      where issue.issue_code = 'pending_manual_review'
    )::integer
  into v_issue_count_after, v_pending_issue_count
  from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id;

  -- This is the authoritative pending-departure definition used by employee
  -- master ingestion. The visible pending issue set must agree exactly after
  -- the two retired presence rows have been removed.
  select count(*)::integer
  into v_pending_departure_count
  from public.employee_master_presence_state state
  where state.last_run_id = v_latest_run_id
    and state.missing_streak >= 1;

  select count(*)::integer
  into v_run_rekeyed_count
  from public.employee_identity_rekeys rekey
  where rekey.run_id = v_latest_run_id;

  if v_issue_count_after <> v_issue_count_before - v_removed_issue_count
     or v_pending_issue_count <> v_pending_departure_count
     or v_run_rekeyed_count < 2 then
    raise exception 'confirmed_employee_id_latest_run_counter_basis_changed';
  end if;

  update public.employee_master_sync_runs run
  set rekeyed_count = v_run_rekeyed_count,
      pending_departure_count = v_pending_departure_count,
      warning_count = v_parse_warning_count + v_issue_count_after
  where run.id = v_latest_run_id;
  if not found then
    raise exception 'confirmed_employee_id_latest_run_missing';
  end if;

  if not exists (
    select 1
    from public.employee_master_sync_runs run
    where run.id = v_latest_run_id
      and run.rekeyed_count = v_run_rekeyed_count
      and run.pending_departure_count = v_pending_departure_count
      and run.warning_count =
            v_parse_warning_count + v_issue_count_after
  ) then
    raise exception 'confirmed_employee_id_latest_run_counter_write_failed';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    where (select count(*)
           from public.employees employee
           where public.employee_master_normalize_id(employee.employee_no) =
                 plan.previous_employee_no) <> 0
       or (select count(*)
           from public.employees employee
           where public.employee_master_normalize_id(employee.employee_no) =
                 plan.official_employee_no
             and employee.id = plan.target_employee_id) <> 1
       or employee_private.resolve_confirmed_employee_id(
            plan.previous_employee_no
          ) is distinct from plan.target_employee_id
       or employee_private.resolve_confirmed_employee_id(
            plan.official_employee_no
          ) is distinct from plan.target_employee_id
  ) then
    raise exception 'confirmed_employee_id_final_identity_verification_failed';
  end if;

  -- The latest accepted report payload already uses both official IDs, but
  -- the current directory cache also contains employee-source rows for the
  -- duplicate UUIDs that were just removed. Canonicalize any older approved
  -- aliases in the full schedule payload, then call the deepest existing
  -- directory writer directly. This refreshes only the derived directory and
  -- avoids the public wrapper's nested scope/relationship side effects.
  select snapshot.row_count
  into v_schedule_count
  from public.employee_master_source_snapshots snapshot
  where snapshot.run_id = v_latest_run_id
    and snapshot.source_key = 'home_schedule_roster_current';

  if exists (
    select 1
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = employee_private.employee_identity_key(item->>'employee_id')
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where snapshot.run_id = v_latest_run_id
      and snapshot.source_key = 'home_schedule_roster_current'
      and coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) not in (
            lower(regexp_replace(
              btrim(ledger.full_name),
              '[[:space:][:punct:]]+', '', 'g'
            )),
            lower(regexp_replace(
              btrim(canonical.full_name),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          )
  ) then
    raise exception 'confirmed_employee_id_directory_alias_name_mismatch';
  end if;

  select coalesce(jsonb_agg(
    case
      when ledger.target_employee_id is not null then
        jsonb_set(
          item,
          '{employee_id}',
          to_jsonb(public.employee_master_normalize_id(
            canonical.employee_no
          )),
          true
        )
      else item
    end
    order by case
      when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer
    end
  ), '[]'::jsonb)
  into v_directory_rows
  from public.employee_master_source_snapshots snapshot
  cross join lateral jsonb_array_elements(snapshot.payload) item
  left join employee_private.employee_identity_merge_ledger ledger
    on employee_private.employee_identity_key(
         ledger.previous_employee_no
       ) = employee_private.employee_identity_key(item->>'employee_id')
  left join public.employees canonical
    on canonical.id = ledger.target_employee_id
  where snapshot.run_id = v_latest_run_id
    and snapshot.source_key = 'home_schedule_roster_current';

  select count(*) filter (
      where nullif(
        public.employee_master_normalize_id(item->>'employee_id'), ''
      ) is not null
    )::integer,
    count(distinct public.employee_master_normalize_id(
      item->>'employee_id'
    )) filter (
      where nullif(
        public.employee_master_normalize_id(item->>'employee_id'), ''
      ) is not null
    )::integer
  into v_directory_nonblank_count, v_directory_distinct_count
  from jsonb_array_elements(v_directory_rows) item;

  if v_schedule_count is null
     or jsonb_array_length(v_directory_rows) <> v_schedule_count
     or v_directory_nonblank_count <> v_schedule_count
     or v_directory_distinct_count <> v_schedule_count then
    raise exception
      'confirmed_employee_id_directory_payload_identity_shape_changed:%:%:%:%',
      coalesce(v_schedule_count, -1),
      jsonb_array_length(v_directory_rows),
      v_directory_nonblank_count,
      v_directory_distinct_count;
  end if;

  v_directory_result :=
    public.sync_report_employee_directory_scope_inner_v1(v_directory_rows);
  if v_directory_result is null
     or coalesce((v_directory_result->>'rows')::integer, 0) <
          v_schedule_count then
    raise exception 'confirmed_employee_id_directory_writer_failed';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    where exists (
      select 1
      from public.report_employee_directory_cache directory
      where public.employee_master_normalize_id(directory.employee_no) =
            plan.previous_employee_no
        and directory.source_kind in ('employee', 'roster')
    )
       or (select count(*)
           from public.report_employee_directory_cache directory
           where public.employee_master_normalize_id(directory.employee_no) =
                 plan.official_employee_no) <> 1
       or (select count(*)
           from public.report_employee_directory_cache directory
           where public.employee_master_normalize_id(directory.employee_no) =
                 plan.official_employee_no
             and directory.source_kind = 'roster') <> 1
  ) then
    raise exception 'confirmed_employee_id_directory_identity_verification_failed';
  end if;

  perform pg_catalog.set_config(
    'scope_private.assigned_scope_rebuild_dirty', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.defer_assigned_scope_rebuild', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild', 'off', true
  );
  perform scope_private.rebuild_all_assigned_employee_scopes();

  -- Final dynamic check after scope rebuilding: no historical or permission
  -- relation may still point at either retired UUID.
  for v_ref in
    select namespace.nspname schema_name,
      relation.relname table_name,
      attribute.attname column_name
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation
      on relation.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    cross join lateral unnest(constraint_row.conkey) key_column(attnum)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = constraint_row.conrelid
     and attribute.attnum = key_column.attnum
    where constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.employees'::regclass
    order by 1, 2, 3
  loop
    execute format(
      'select count(*) from %I.%I referenced '
      || 'join employee_private.employee_identity_reconcile_merge_plan plan '
      || 'on referenced.%I = plan.source_employee_id',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name
    ) into v_left;
    if v_left <> 0 then
      raise exception 'confirmed_employee_id_source_reference_reappeared:%.%.%:%',
        v_ref.schema_name, v_ref.table_name, v_ref.column_name, v_left;
    end if;
  end loop;

  if exists (
    select 1
    from attendance_private.historical_employee_directory_cache cache
    join employee_private.employee_identity_reconcile_merge_plan plan
      on cache.current_employee_id = plan.source_employee_id
  ) then
    raise exception 'confirmed_employee_id_historical_cache_source_reappeared';
  end if;

  delete from employee_private.employee_identity_reconcile_merge_plan;
  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan
  ) then
    raise exception 'confirmed_employee_id_work_state_not_empty';
  end if;
end;
$apply_confirmed_employee_id_changes_20260902$;

commit;
