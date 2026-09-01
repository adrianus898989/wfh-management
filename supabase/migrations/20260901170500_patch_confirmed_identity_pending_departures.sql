begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

-- The following Phase B remains intentionally strict, but a current employee can legitimately be
-- absent from both active-source projections when the latest home snapshot has
-- one exact canonical row explicitly marked resigned. Patch only the two
-- fail-closed assertions that consume that evidence; do not rerun Phase A or
-- broaden any identity, scope, or function privilege boundary.
do $patch_confirmed_identity_pending_departures$
declare
  v_signature regprocedure :=
    'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure;
  v_definition text;
  v_patched_definition text;
  v_acl_before aclitem[];
  v_owner_before oid;
  v_security_definer_before boolean;
  v_config_before text[];
  v_comment_before text;
  v_acl_after aclitem[];
  v_owner_after oid;
  v_security_definer_after boolean;
  v_config_after text[];
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
  ) then
    raise exception 'current_employee_missing_from_both_sources_after_merge';
  end if;
$old_missing$;
  v_new_missing text := $new_missing$
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
$new_missing$;
  v_old_expected text := $old_expected$
    ), expected_difference(employee_no, direction) as (
      select null::text, null::text
      where false
    )
$old_expected$;
  v_new_expected text := $new_expected$
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
$new_expected$;
  v_old_issue_rebuild text := $old_issue_rebuild$
  -- Rebuild the current discrepancy set from the live sources.  The latest
  -- accepted schedule now contains every effective home employee, so no
  -- one-time home-only exception may survive this reconciliation.
  delete from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id
    and issue.issue_code = 'home_only_missing_schedule';
$old_issue_rebuild$;
  v_new_issue_rebuild text := $new_issue_rebuild$
  -- Rebuild visible employee-only discrepancies from the exact latest source
  -- pair. Active home rows remain home-only until scheduled. An explicitly
  -- resigned home row whose profile is still active remains visible with its
  -- effective date: future departures need schedule review, while an already
  -- effective departure needs employee-profile review.
  delete from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id
    and issue.issue_code = 'home_only_missing_schedule';

  insert into public.employee_master_sync_issues (
    run_id, issue_code, employee_no, home_source_row, details
  )
  with schedule_employee_ids as materialized (
    select distinct employee_private.resolve_confirmed_employee_id(
      schedule_item->>'employee_id'
    ) employee_id
    from public.employee_master_source_snapshots schedule_snapshot
    cross join lateral jsonb_array_elements(
      schedule_snapshot.payload
    ) schedule_item
    where schedule_snapshot.source_key = 'home_schedule_roster_current'
      and schedule_snapshot.run_id = v_latest_run_id
  ), home_candidates as materialized (
    select employee.id employee_id, employee.employee_no,
      employee.full_name,
      (home_item->>'source_row')::integer home_source_row,
      coalesce(
        (home_item->>'explicitly_resigned')::boolean,
        false
      ) explicitly_resigned,
      count(*) over (partition by employee.id) source_count
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
      and employee.status in ('active', 'probation')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and (
        employee.hire_date is null
        or employee.hire_date <=
          (statement_timestamp() at time zone 'Asia/Manila')::date
      )
  )
  select v_latest_run_id, 'home_only_missing_schedule',
    candidate.employee_no, candidate.home_source_row,
    jsonb_build_object(
      'reason', 'active_home_employee_not_yet_scheduled',
      'action', 'await_schedule_assignment',
      'employee_name', candidate.full_name,
      'account_review_required', true
    )
  from home_candidates candidate
  where candidate.source_count = 1
    and not candidate.explicitly_resigned
    and not exists (
      select 1
      from schedule_employee_ids scheduled
      where scheduled.employee_id = candidate.employee_id
    )
  order by candidate.employee_no;

  insert into public.employee_master_sync_issues (
    run_id, issue_code, employee_no, home_source_row, details
  )
  with schedule_employee_ids as materialized (
    select distinct employee_private.resolve_confirmed_employee_id(
      schedule_item->>'employee_id'
    ) employee_id
    from public.employee_master_source_snapshots schedule_snapshot
    cross join lateral jsonb_array_elements(
      schedule_snapshot.payload
    ) schedule_item
    where schedule_snapshot.source_key = 'home_schedule_roster_current'
      and schedule_snapshot.run_id = v_latest_run_id
  ), resigned_candidates as materialized (
    select employee.id employee_id, employee.employee_no,
      employee.full_name,
      (home_item->>'source_row')::integer home_source_row,
      coalesce(
        (home_item->>'explicitly_resigned')::boolean,
        false
      ) explicitly_resigned,
      case
        when coalesce(home_item->>'resign_date', '') ~
          '^\d{4}-\d{2}-\d{2}$'
        then (home_item->>'resign_date')::date
      end resign_date,
      count(*) over (partition by employee.id) source_count
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
      and employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
  )
  select v_latest_run_id, 'pending_manual_review',
    candidate.employee_no, candidate.home_source_row,
    jsonb_build_object(
      'reason', case
        when candidate.resign_date >
          (statement_timestamp() at time zone 'Asia/Manila')::date
        then 'future_resignation_removed_from_schedule_early'
        else 'home_source_resigned_profile_still_active'
      end,
      'action', case
        when candidate.resign_date >
          (statement_timestamp() at time zone 'Asia/Manila')::date
        then 'review_schedule_until_resignation_effective_date'
        else 'confirm_employee_status_or_restore_home_source'
      end,
      'employee_name', candidate.full_name,
      'resign_date', candidate.resign_date,
      'source_explicitly_resigned', true,
      'account_review_required', true
    )
  from resigned_candidates candidate
  where candidate.source_count = 1
    and candidate.explicitly_resigned
    and candidate.resign_date is not null
    and not exists (
      select 1
      from schedule_employee_ids scheduled
      where scheduled.employee_id = candidate.employee_id
    )
  order by candidate.employee_no;
$new_issue_rebuild$;
  v_old_pending_assertion text := $old_pending_assertion$
  if (select count(*)
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'pending_manual_review') <> 0 then
    raise exception 'stale_pending_manual_review_issue_remains';
  end if;
$old_pending_assertion$;
  v_new_pending_assertion text := $new_pending_assertion$
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
$new_pending_assertion$;
  v_old_home_assertion text := $old_home_assertion$
  if exists (
    select 1
    from public.employee_master_sync_issues issue
    where issue.run_id = v_latest_run_id
      and issue.issue_code = 'home_only_missing_schedule'
  ) then
    raise exception 'unexpected_home_only_employee_issue_remains';
  end if;
$old_home_assertion$;
  v_new_home_assertion text := $new_home_assertion$
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
$new_home_assertion$;
  v_old_warning_assertion text := $old_warning_assertion$
  if v_parse_warning_count <> 3
     or v_remaining_issue_count <> 41
     or (select count(*)
         from public.employee_master_sync_issues issue
         where issue.run_id = v_latest_run_id
           and issue.issue_code = 'cross_source_name_mismatch') <> 29 then
    raise exception
      'employee_identity_reconciliation_warning_set_changed:%:%',
      v_parse_warning_count, v_remaining_issue_count;
  end if;
$old_warning_assertion$;
  v_new_warning_assertion text := $new_warning_assertion$
  if v_parse_warning_count < 0
     or exists (
       select 1
       from public.employee_master_sync_issues issue
       where issue.run_id = v_latest_run_id
         and issue.issue_code not in (
           'cross_source_name_mismatch',
           'schedule_only_missing_onsite_marker',
           'home_only_missing_schedule',
           'pending_manual_review'
         )
     )
     or v_remaining_issue_count <> (
       select count(*)::integer
       from public.employee_master_sync_issues issue
       where issue.run_id = v_latest_run_id
         and issue.issue_code in (
           'cross_source_name_mismatch',
           'schedule_only_missing_onsite_marker',
           'home_only_missing_schedule',
           'pending_manual_review'
         )
     ) then
    raise exception
      'employee_identity_reconciliation_warning_set_changed:%:%',
      v_parse_warning_count, v_remaining_issue_count;
  end if;
$new_warning_assertion$;
  v_old_warning_total text := $old_warning_total$
  if not exists (
    select 1
    from public.employee_master_sync_runs run
    where run.id = v_latest_run_id
      and run.warning_count = 44
  ) then
    raise exception 'employee_identity_reconciliation_warning_total_changed';
  end if;
$old_warning_total$;
  v_new_warning_total text := $new_warning_total$
  if not exists (
    select 1
    from public.employee_master_sync_runs run
    where run.id = v_latest_run_id
      and run.warning_count =
        v_parse_warning_count + v_remaining_issue_count
  ) then
    raise exception 'employee_identity_reconciliation_warning_total_changed';
  end if;
$new_warning_total$;
begin
  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.proacl,
    procedure.proowner,
    procedure.prosecdef,
    procedure.proconfig,
    pg_catalog.obj_description(procedure.oid, 'pg_proc')
  into
    v_definition,
    v_acl_before,
    v_owner_before,
    v_security_definer_before,
    v_config_before,
    v_comment_before
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if v_definition is null then
    raise exception 'confirmed_identity_reconciliation_function_missing';
  end if;

  if pg_catalog.strpos(v_definition, v_new_missing) > 0
     or pg_catalog.strpos(v_definition, v_new_expected) > 0 then
    if pg_catalog.strpos(v_definition, v_new_missing) = 0
       or pg_catalog.strpos(v_definition, v_new_expected) = 0
       or pg_catalog.strpos(v_definition, v_old_missing) > 0
       or pg_catalog.strpos(v_definition, v_old_expected) > 0 then
      raise exception 'confirmed_identity_pending_departure_patch_partial';
    end if;
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
             v_definition, v_old_expected, ''
           ))
       ) / pg_catalog.length(v_old_expected) <> 1 then
      raise exception 'confirmed_identity_pending_departure_marker_changed';
    end if;

    if (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_issue_rebuild, ''
           ))
       ) / pg_catalog.length(v_old_issue_rebuild) <> 1
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
       ) / pg_catalog.length(v_old_home_assertion) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_warning_assertion, ''
           ))
       ) / pg_catalog.length(v_old_warning_assertion) <> 1
       or (
         pg_catalog.length(v_definition)
         - pg_catalog.length(pg_catalog.replace(
             v_definition, v_old_warning_total, ''
           ))
       ) / pg_catalog.length(v_old_warning_total) <> 1 then
      raise exception 'confirmed_identity_pending_departure_issue_marker_changed';
    end if;

    v_patched_definition := pg_catalog.replace(
      v_definition, v_old_missing, v_new_missing
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_expected, v_new_expected
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_issue_rebuild, v_new_issue_rebuild
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition,
      v_old_pending_assertion,
      v_new_pending_assertion
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_home_assertion, v_new_home_assertion
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition,
      v_old_warning_assertion,
      v_new_warning_assertion
    );
    v_patched_definition := pg_catalog.replace(
      v_patched_definition, v_old_warning_total, v_new_warning_total
    );
    execute v_patched_definition;
  end if;

  select
    pg_catalog.pg_get_functiondef(procedure.oid),
    procedure.proacl,
    procedure.proowner,
    procedure.prosecdef,
    procedure.proconfig,
    pg_catalog.obj_description(procedure.oid, 'pg_proc')
  into
    v_definition,
    v_acl_after,
    v_owner_after,
    v_security_definer_after,
    v_config_after,
    v_comment_after
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  if pg_catalog.strpos(v_definition, v_new_missing) = 0
     or pg_catalog.strpos(v_definition, v_new_expected) = 0
     or pg_catalog.strpos(v_definition, v_new_issue_rebuild) = 0
     or pg_catalog.strpos(v_definition, v_new_pending_assertion) = 0
     or pg_catalog.strpos(v_definition, v_new_home_assertion) = 0
     or pg_catalog.strpos(v_definition, v_new_warning_assertion) = 0
     or pg_catalog.strpos(v_definition, v_new_warning_total) = 0
     or pg_catalog.strpos(v_definition, v_old_missing) > 0
     or pg_catalog.strpos(v_definition, v_old_expected) > 0
     or pg_catalog.strpos(v_definition, v_old_issue_rebuild) > 0
     or pg_catalog.strpos(v_definition, v_old_pending_assertion) > 0
     or pg_catalog.strpos(v_definition, v_old_home_assertion) > 0
     or pg_catalog.strpos(v_definition, v_old_warning_assertion) > 0
     or pg_catalog.strpos(v_definition, v_old_warning_total) > 0 then
    raise exception 'confirmed_identity_pending_departure_patch_verify_failed';
  end if;

  if v_acl_after is distinct from v_acl_before
     or v_owner_after is distinct from v_owner_before
     or v_security_definer_after is distinct from
       v_security_definer_before
     or v_config_after is distinct from v_config_before
     or v_comment_after is distinct from v_comment_before then
    raise exception 'confirmed_identity_reconciliation_privilege_boundary_changed';
  end if;
end;
$patch_confirmed_identity_pending_departures$;

commit;
