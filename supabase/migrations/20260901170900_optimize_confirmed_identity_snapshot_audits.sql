begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- The reconciliation assertions must remain exact, but the pending-departure
-- patch evaluated the identity resolver inside correlated scans of the full
-- home/schedule JSON snapshots.  Materialize each current snapshot mapping
-- once, then compare the grouped canonical UUID evidence.  This changes only
-- query shape: all fail-closed assertions, issue contents and privileges stay
-- unchanged.
do $optimize_confirmed_identity_snapshot_audits$
declare
  v_signature regprocedure :=
    'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure;
  v_definition text;
  v_patched_definition text;
  v_after_definition text;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_security_definer_before boolean;
  v_config_before text[];
  v_volatility_before "char";
  v_parallel_before "char";
  v_leakproof_before boolean;
  v_kind_before "char";
  v_return_type_before oid;
  v_comment_before text;
  v_acl_after aclitem[];
  v_owner_after oid;
  v_security_definer_after boolean;
  v_config_after text[];
  v_volatility_after "char";
  v_parallel_after "char";
  v_leakproof_after boolean;
  v_kind_after "char";
  v_return_type_after oid;
  v_comment_after text;
  v_old_missing text := $old_missing$
  if exists (
    select 1
    from public.employees employee
    where employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_source_presence presence
        where presence.employee_no =
          public.employee_master_normalize_id(employee.employee_no)
      )
      and not (
        select count(*) = 1
          and bool_and(coalesce(
            (home_item->>'explicitly_resigned')::boolean,
            false
          ))
          and bool_and(
            coalesce(home_item->>'resign_date', '') ~
              '^\d{4}-\d{2}-\d{2}$'
          )
        from public.employee_master_source_snapshots home_snapshot
        cross join lateral jsonb_array_elements(home_snapshot.payload) home_item
        where home_snapshot.source_key = 'home_employee_roster_current'
          and home_snapshot.run_id = v_latest_run_id
          and employee_private.resolve_confirmed_employee_id(
                home_item->>'employee_id'
              ) = employee.id
      )
  ) then
    raise exception 'current_employee_missing_from_both_sources_after_merge';
  end if;
$old_missing$;
  v_new_missing text := $new_missing$
  if exists (
    with resolved_home as materialized (
      select employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        ) employee_id,
        coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        ) explicitly_resigned,
        coalesce(home_item->>'resign_date', '') ~
          '^\d{4}-\d{2}-\d{2}$' valid_resign_date
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
    ), home_evidence as materialized (
      select resolved.employee_id,
        count(*) source_count,
        bool_and(resolved.explicitly_resigned) all_explicitly_resigned,
        bool_and(resolved.valid_resign_date) all_valid_resign_date
      from resolved_home resolved
      where resolved.employee_id is not null
      group by resolved.employee_id
    )
    select 1
    from public.employees employee
    left join home_evidence evidence
      on evidence.employee_id = employee.id
    where employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_source_presence presence
        where presence.employee_no =
          public.employee_master_normalize_id(employee.employee_no)
      )
      and not (
        coalesce(evidence.source_count, 0) = 1
        and coalesce(evidence.all_explicitly_resigned, false)
        and coalesce(evidence.all_valid_resign_date, false)
      )
  ) then
    raise exception 'current_employee_missing_from_both_sources_after_merge';
  end if;
$new_missing$;
  v_old_unapproved text := $old_unapproved$
  if exists (
    select 1
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    where snapshot.source_key = 'home_schedule_roster_current'
      and not coalesce((item->>'onsite_marker')::boolean, false)
      and not exists (
        select 1
        from public.employee_master_source_snapshots home_snapshot
        cross join lateral jsonb_array_elements(
          home_snapshot.payload
          ) home_item
        where home_snapshot.source_key = 'home_employee_roster_current'
          and employee_private.resolve_confirmed_employee_id(
                home_item->>'employee_id'
              ) = employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              )
          and employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              ) is not null
          and not coalesce(
            (home_item->>'explicitly_resigned')::boolean,
            false
          )
      )
      and not exists (
        select 1
        from public.employees employee
        where employee.id = employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              )
          and employee.status in ('active', 'probation', 'suspended')
          and coalesce(employee.source_type, '') <> 'google_deleted'
          and lower(regexp_replace(
                btrim(employee.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              )) = btrim(item->>'name_key')
      )
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_actual_name_mismatch mismatch
        where mismatch.employee_no =
          public.employee_master_normalize_id(item->>'employee_id')
          and mismatch.schedule_name_key = btrim(item->>'name_key')
      )
  ) then
    raise exception 'unapproved_schedule_only_identity_remains';
  end if;
$old_unapproved$;
  v_new_unapproved text := $new_unapproved$
  if exists (
    with resolved_home as materialized (
      select employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        ) employee_id
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
        and not coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        )
    ), home_employee_ids as materialized (
      select distinct resolved.employee_id
      from resolved_home resolved
      where resolved.employee_id is not null
    ), resolved_schedule as materialized (
      select employee_private.resolve_confirmed_employee_id(
          schedule_item->>'employee_id'
        ) employee_id,
        public.employee_master_normalize_id(
          schedule_item->>'employee_id'
        ) employee_no,
        btrim(schedule_item->>'name_key') schedule_name_key,
        coalesce(
          (schedule_item->>'onsite_marker')::boolean,
          false
        ) onsite_marker
      from public.employee_master_source_snapshots schedule_snapshot
      cross join lateral jsonb_array_elements(
        schedule_snapshot.payload
      ) schedule_item
      where schedule_snapshot.source_key = 'home_schedule_roster_current'
        and schedule_snapshot.run_id = v_latest_run_id
    )
    select 1
    from resolved_schedule schedule
    where not schedule.onsite_marker
      and not exists (
        select 1
        from home_employee_ids home
        where home.employee_id = schedule.employee_id
      )
      and not exists (
        select 1
        from public.employees employee
        where employee.id = schedule.employee_id
          and employee.status in ('active', 'probation', 'suspended')
          and coalesce(employee.source_type, '') <> 'google_deleted'
          and lower(regexp_replace(
                btrim(employee.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              )) = schedule.schedule_name_key
      )
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_actual_name_mismatch mismatch
        where mismatch.employee_no = schedule.employee_no
          and mismatch.schedule_name_key = schedule.schedule_name_key
      )
  ) then
    raise exception 'unapproved_schedule_only_identity_remains';
  end if;
$new_unapproved$;
  v_old_expected text := $old_expected$
    ), expected_difference(employee_no, direction) as (
      select effective.employee_no, 'employee_only'::text
      from effective_active effective
      join public.employees employee
        on public.employee_master_normalize_id(employee.employee_no) =
          effective.employee_no
      where (
        select count(*) = 1
        from public.employee_master_source_snapshots home_snapshot
        cross join lateral jsonb_array_elements(home_snapshot.payload) home_item
        where home_snapshot.source_key = 'home_employee_roster_current'
          and home_snapshot.run_id = v_latest_run_id
          and employee_private.resolve_confirmed_employee_id(
                home_item->>'employee_id'
              ) = employee.id
      )
        and not exists (
          select 1
          from schedule
          where schedule.employee_no = effective.employee_no
        )
    )
$old_expected$;
  v_new_expected text := $new_expected$
    ), resolved_current_home as materialized (
      select employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        ) employee_id
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
    ), current_home_evidence as materialized (
      select resolved.employee_id, count(*) source_count
      from resolved_current_home resolved
      where resolved.employee_id is not null
      group by resolved.employee_id
    ), expected_difference(employee_no, direction) as (
      select effective.employee_no, 'employee_only'::text
      from effective_active effective
      join public.employees employee
        on public.employee_master_normalize_id(employee.employee_no) =
          effective.employee_no
      join current_home_evidence home
        on home.employee_id = employee.id
       and home.source_count = 1
      where not exists (
        select 1
        from schedule
        where schedule.employee_no = effective.employee_no
      )
    )
$new_expected$;
  v_old_pending_assertion text := $old_pending_assertion$
  if exists (
    with expected as (
      select public.employee_master_normalize_id(employee.employee_no)
          employee_no,
        (home_item->>'source_row')::integer home_source_row,
        employee.full_name employee_name,
        case
          when (home_item->>'resign_date')::date >
            (statement_timestamp() at time zone 'Asia/Manila')::date
          then 'future_resignation_removed_from_schedule_early'
          else 'home_source_resigned_profile_still_active'
        end reason,
        case
          when (home_item->>'resign_date')::date >
            (statement_timestamp() at time zone 'Asia/Manila')::date
          then 'review_schedule_until_resignation_effective_date'
          else 'confirm_employee_status_or_restore_home_source'
        end action,
        (home_item->>'resign_date')::date::text resign_date,
        'true'::text source_explicitly_resigned,
        'true'::text account_review_required
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      join public.employees employee
        on employee.id = employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        )
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
        and coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        )
        and coalesce(home_item->>'resign_date', '') ~
          '^\d{4}-\d{2}-\d{2}$'
        and employee.status in ('active', 'probation', 'suspended')
        and coalesce(employee.source_type, '') <> 'google_deleted'
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and (
          select count(*)
          from public.employee_master_source_snapshots exact_home_snapshot
          cross join lateral jsonb_array_elements(
            exact_home_snapshot.payload
          ) exact_home_item
          where exact_home_snapshot.source_key =
              'home_employee_roster_current'
            and exact_home_snapshot.run_id = v_latest_run_id
            and employee_private.resolve_confirmed_employee_id(
                  exact_home_item->>'employee_id'
                ) = employee.id
        ) = 1
        and not exists (
          select 1
          from public.employee_master_source_snapshots schedule_snapshot
          cross join lateral jsonb_array_elements(
            schedule_snapshot.payload
          ) schedule_item
          where schedule_snapshot.source_key =
              'home_schedule_roster_current'
            and schedule_snapshot.run_id = v_latest_run_id
            and employee_private.resolve_confirmed_employee_id(
                  schedule_item->>'employee_id'
                ) = employee.id
        )
    ), actual as (
      select public.employee_master_normalize_id(issue.employee_no)
          employee_no,
        issue.home_source_row,
        issue.details->>'employee_name' employee_name,
        issue.details->>'reason' reason,
        issue.details->>'action' action,
        issue.details->>'resign_date' resign_date,
        issue.details->>'source_explicitly_resigned'
          source_explicitly_resigned,
        issue.details->>'account_review_required'
          account_review_required
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'pending_manual_review'
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  ) then
    raise exception 'resigned_home_active_profile_issue_set_changed';
  end if;
$old_pending_assertion$;
  v_new_pending_assertion text := $new_pending_assertion$
  if exists (
    with resolved_home as materialized (
      select employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        ) employee_id,
        (home_item->>'source_row')::integer home_source_row,
        coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        ) explicitly_resigned,
        case
          when coalesce(home_item->>'resign_date', '') ~
            '^\d{4}-\d{2}-\d{2}$'
          then (home_item->>'resign_date')::date
        end resign_date
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
    ), home_evidence as materialized (
      select resolved.employee_id, count(*) source_count
      from resolved_home resolved
      where resolved.employee_id is not null
      group by resolved.employee_id
    ), schedule_employee_ids as materialized (
      select distinct employee_private.resolve_confirmed_employee_id(
        schedule_item->>'employee_id'
      ) employee_id
      from public.employee_master_source_snapshots schedule_snapshot
      cross join lateral jsonb_array_elements(
        schedule_snapshot.payload
      ) schedule_item
      where schedule_snapshot.source_key = 'home_schedule_roster_current'
        and schedule_snapshot.run_id = v_latest_run_id
    ), expected as (
      select public.employee_master_normalize_id(employee.employee_no)
          employee_no,
        home.home_source_row,
        employee.full_name employee_name,
        case
          when home.resign_date >
            (statement_timestamp() at time zone 'Asia/Manila')::date
          then 'future_resignation_removed_from_schedule_early'
          else 'home_source_resigned_profile_still_active'
        end reason,
        case
          when home.resign_date >
            (statement_timestamp() at time zone 'Asia/Manila')::date
          then 'review_schedule_until_resignation_effective_date'
          else 'confirm_employee_status_or_restore_home_source'
        end action,
        home.resign_date::text resign_date,
        'true'::text source_explicitly_resigned,
        'true'::text account_review_required
      from resolved_home home
      join home_evidence evidence
        on evidence.employee_id = home.employee_id
       and evidence.source_count = 1
      join public.employees employee
        on employee.id = home.employee_id
      where home.explicitly_resigned
        and home.resign_date is not null
        and employee.status in ('active', 'probation', 'suspended')
        and coalesce(employee.source_type, '') <> 'google_deleted'
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and not exists (
          select 1
          from schedule_employee_ids scheduled
          where scheduled.employee_id = home.employee_id
        )
    ), actual as (
      select public.employee_master_normalize_id(issue.employee_no)
          employee_no,
        issue.home_source_row,
        issue.details->>'employee_name' employee_name,
        issue.details->>'reason' reason,
        issue.details->>'action' action,
        issue.details->>'resign_date' resign_date,
        issue.details->>'source_explicitly_resigned'
          source_explicitly_resigned,
        issue.details->>'account_review_required'
          account_review_required
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'pending_manual_review'
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  ) then
    raise exception 'resigned_home_active_profile_issue_set_changed';
  end if;
$new_pending_assertion$;
  v_old_home_assertion text := $old_home_assertion$
  if exists (
    with expected as (
      select public.employee_master_normalize_id(employee.employee_no)
          employee_no,
        (home_item->>'source_row')::integer home_source_row,
        employee.full_name employee_name,
        'active_home_employee_not_yet_scheduled'::text reason,
        'await_schedule_assignment'::text action,
        'true'::text account_review_required
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      join public.employees employee
        on employee.id = employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        )
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
        and not coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        )
        and employee.status in ('active', 'probation')
        and coalesce(employee.source_type, '') <> 'google_deleted'
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and (
          employee.hire_date is null
          or employee.hire_date <=
            (statement_timestamp() at time zone 'Asia/Manila')::date
        )
        and (
          select count(*)
          from public.employee_master_source_snapshots exact_home_snapshot
          cross join lateral jsonb_array_elements(
            exact_home_snapshot.payload
          ) exact_home_item
          where exact_home_snapshot.source_key =
              'home_employee_roster_current'
            and exact_home_snapshot.run_id = v_latest_run_id
            and employee_private.resolve_confirmed_employee_id(
                  exact_home_item->>'employee_id'
                ) = employee.id
        ) = 1
        and not exists (
          select 1
          from public.employee_master_source_snapshots schedule_snapshot
          cross join lateral jsonb_array_elements(
            schedule_snapshot.payload
          ) schedule_item
          where schedule_snapshot.source_key =
              'home_schedule_roster_current'
            and schedule_snapshot.run_id = v_latest_run_id
            and employee_private.resolve_confirmed_employee_id(
                  schedule_item->>'employee_id'
                ) = employee.id
        )
    ), actual as (
      select public.employee_master_normalize_id(issue.employee_no)
          employee_no,
        issue.home_source_row,
        issue.details->>'employee_name' employee_name,
        issue.details->>'reason' reason,
        issue.details->>'action' action,
        issue.details->>'account_review_required'
          account_review_required
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'home_only_missing_schedule'
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  ) then
    raise exception 'home_only_employee_issue_set_changed';
  end if;
$old_home_assertion$;
  v_new_home_assertion text := $new_home_assertion$
  if exists (
    with resolved_home as materialized (
      select employee_private.resolve_confirmed_employee_id(
          home_item->>'employee_id'
        ) employee_id,
        (home_item->>'source_row')::integer home_source_row,
        coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        ) explicitly_resigned
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(
        home_snapshot.payload
      ) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and home_snapshot.run_id = v_latest_run_id
    ), home_evidence as materialized (
      select resolved.employee_id, count(*) source_count
      from resolved_home resolved
      where resolved.employee_id is not null
      group by resolved.employee_id
    ), schedule_employee_ids as materialized (
      select distinct employee_private.resolve_confirmed_employee_id(
        schedule_item->>'employee_id'
      ) employee_id
      from public.employee_master_source_snapshots schedule_snapshot
      cross join lateral jsonb_array_elements(
        schedule_snapshot.payload
      ) schedule_item
      where schedule_snapshot.source_key = 'home_schedule_roster_current'
        and schedule_snapshot.run_id = v_latest_run_id
    ), expected as (
      select public.employee_master_normalize_id(employee.employee_no)
          employee_no,
        home.home_source_row,
        employee.full_name employee_name,
        'active_home_employee_not_yet_scheduled'::text reason,
        'await_schedule_assignment'::text action,
        'true'::text account_review_required
      from resolved_home home
      join home_evidence evidence
        on evidence.employee_id = home.employee_id
       and evidence.source_count = 1
      join public.employees employee
        on employee.id = home.employee_id
      where not home.explicitly_resigned
        and employee.status in ('active', 'probation')
        and coalesce(employee.source_type, '') <> 'google_deleted'
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and (
          employee.hire_date is null
          or employee.hire_date <=
            (statement_timestamp() at time zone 'Asia/Manila')::date
        )
        and not exists (
          select 1
          from schedule_employee_ids scheduled
          where scheduled.employee_id = home.employee_id
        )
    ), actual as (
      select public.employee_master_normalize_id(issue.employee_no)
          employee_no,
        issue.home_source_row,
        issue.details->>'employee_name' employee_name,
        issue.details->>'reason' reason,
        issue.details->>'action' action,
        issue.details->>'account_review_required'
          account_review_required
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'home_only_missing_schedule'
    )
    (select * from actual except select * from expected)
    union all
    (select * from expected except select * from actual)
  ) then
    raise exception 'home_only_employee_issue_set_changed';
  end if;
$new_home_assertion$;
begin
  select procedure.proacl, procedure.proowner, procedure.prosecdef,
    procedure.proconfig, procedure.provolatile, procedure.proparallel,
    procedure.proleakproof, procedure.prokind, procedure.prorettype,
    pg_catalog.obj_description(procedure.oid, 'pg_proc'),
    pg_catalog.pg_get_functiondef(procedure.oid)
  into v_acl_before, v_owner_before, v_security_definer_before,
    v_config_before, v_volatility_before, v_parallel_before,
    v_leakproof_before, v_kind_before, v_return_type_before,
    v_comment_before, v_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if v_definition is null
     or v_kind_before <> 'f'
     or v_return_type_before <> 'void'::regtype then
    raise exception 'confirmed_identity_snapshot_audit_function_changed';
  end if;

  if pg_catalog.strpos(v_definition, v_new_missing) > 0
     or pg_catalog.strpos(v_definition, v_new_unapproved) > 0
     or pg_catalog.strpos(v_definition, v_new_expected) > 0
     or pg_catalog.strpos(v_definition, v_new_pending_assertion) > 0
     or pg_catalog.strpos(v_definition, v_new_home_assertion) > 0 then
    if pg_catalog.strpos(v_definition, v_new_missing) = 0
       or pg_catalog.strpos(v_definition, v_new_unapproved) = 0
       or pg_catalog.strpos(v_definition, v_new_expected) = 0
       or pg_catalog.strpos(v_definition, v_new_pending_assertion) = 0
       or pg_catalog.strpos(v_definition, v_new_home_assertion) = 0
       or pg_catalog.strpos(v_definition, v_old_missing) > 0
       or pg_catalog.strpos(v_definition, v_old_unapproved) > 0
       or pg_catalog.strpos(v_definition, v_old_expected) > 0
       or pg_catalog.strpos(v_definition, v_old_pending_assertion) > 0
       or pg_catalog.strpos(v_definition, v_old_home_assertion) > 0 then
      raise exception 'confirmed_identity_snapshot_audit_patch_partial';
    end if;
    v_patched_definition := v_definition;
  else
    if (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_missing, ''
           ))
       ) / pg_catalog.length(v_old_missing) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_unapproved, ''
           ))
       ) / pg_catalog.length(v_old_unapproved) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_expected, ''
           ))
       ) / pg_catalog.length(v_old_expected) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_pending_assertion, ''
           ))
       ) / pg_catalog.length(v_old_pending_assertion) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_home_assertion, ''
           ))
       ) / pg_catalog.length(v_old_home_assertion) <> 1 then
      raise exception 'confirmed_identity_snapshot_audit_marker_changed';
    end if;

    v_patched_definition := pg_catalog.replace(
      v_definition, v_old_missing, v_new_missing
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_unapproved, v_new_unapproved
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_expected, v_new_expected
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition,
      v_old_pending_assertion,
      v_new_pending_assertion
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_home_assertion, v_new_home_assertion
    );

    if v_patched_definition = v_definition then
      raise exception 'confirmed_identity_snapshot_audit_patch_empty';
    end if;

    execute v_patched_definition;
  end if;

  select procedure.proacl, procedure.proowner, procedure.prosecdef,
    procedure.proconfig, procedure.provolatile, procedure.proparallel,
    procedure.proleakproof, procedure.prokind, procedure.prorettype,
    pg_catalog.obj_description(procedure.oid, 'pg_proc'),
    pg_catalog.pg_get_functiondef(procedure.oid)
  into v_acl_after, v_owner_after, v_security_definer_after,
    v_config_after, v_volatility_after, v_parallel_after,
    v_leakproof_after, v_kind_after, v_return_type_after,
    v_comment_after, v_after_definition
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if pg_catalog.strpos(v_after_definition, v_new_missing) = 0
     or pg_catalog.strpos(v_after_definition, v_new_unapproved) = 0
     or pg_catalog.strpos(v_after_definition, v_new_expected) = 0
     or pg_catalog.strpos(v_after_definition, v_new_pending_assertion) = 0
     or pg_catalog.strpos(v_after_definition, v_new_home_assertion) = 0
     or pg_catalog.strpos(v_after_definition, v_old_missing) > 0
     or pg_catalog.strpos(v_after_definition, v_old_unapproved) > 0
     or pg_catalog.strpos(v_after_definition, v_old_expected) > 0
     or pg_catalog.strpos(v_after_definition, v_old_pending_assertion) > 0
     or pg_catalog.strpos(v_after_definition, v_old_home_assertion) > 0 then
    raise exception 'confirmed_identity_snapshot_audit_patch_verify_failed';
  end if;

  if v_acl_after is distinct from v_acl_before
     or v_owner_after is distinct from v_owner_before
     or v_security_definer_after is distinct from
          v_security_definer_before
     or v_config_after is distinct from v_config_before
     or v_volatility_after is distinct from v_volatility_before
     or v_parallel_after is distinct from v_parallel_before
     or v_leakproof_after is distinct from v_leakproof_before
     or v_kind_after is distinct from v_kind_before
     or v_return_type_after is distinct from v_return_type_before
     or v_comment_after is distinct from v_comment_before then
    raise exception
      'confirmed_identity_snapshot_audit_privilege_boundary_changed';
  end if;
end;
$optimize_confirmed_identity_snapshot_audits$;

commit;
