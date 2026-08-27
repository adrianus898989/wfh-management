-- Run only against a disposable database after every migration. All fixture
-- mutations are rolled back. This regression protects the server-side meaning
-- of an assigned backend scope:
--   selected current team AND (optional position OR selected in-team employee).

begin;

do $preconditions$
begin
  if not exists (
    select 1 from public.roles role
    where role.active and role.code not in ('founder', 'employee')
  ) then
    raise exception 'scope test requires one active non-Founder backend role';
  end if;
end
$preconditions$;

insert into public.teams (id, name, status) values
  ('00000000-0000-4000-8000-00000000a101', '__SCOPE_TEAM_A__', 'active'),
  ('00000000-0000-4000-8000-00000000a102', '__SCOPE_TEAM_B__', 'active');

insert into public.positions (id, name, status) values
  ('00000000-0000-4000-8000-00000000a201', '__SCOPE_SERVICE__', 'active'),
  ('00000000-0000-4000-8000-00000000a202', '__SCOPE_PAYOUT__', 'active'),
  -- Production contains duplicate active position labels. Authorization maps a
  -- label to one canonical ID, so the duplicate ID must never be selectable.
  ('00000000-0000-4000-8000-00000000a203', '__SCOPE_SERVICE__', 'active'),
  ('00000000-0000-4000-8000-00000000a204', '__SCOPE_ONLY_B__', 'active');

-- E1 deliberately has stale canonical organization columns. The current roster
-- below is authoritative and places E1 in Team A / Service.
insert into public.employees (
  id, employee_no, full_name, status, team_id, position_id,
  trainer_name, online_trainer, source_type, source_sheet
) values
  (
    '00000000-0000-4000-8000-00000000e101', 'SCOPE-E1', '__SCOPE_E1__', 'active',
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000a202',
    '__STALE_TRAINER_E1__', '__STALE_ONLINE_TRAINER_E1__', 'schedule_temp', 'test'
  ),
  (
    '00000000-0000-4000-8000-00000000e102', 'SCOPE-E2', '__SCOPE_E2__', 'active',
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a202',
    '__STALE_TRAINER_E2__', '__STALE_ONLINE_TRAINER_E2__', 'schedule_temp', 'test'
  ),
  (
    '00000000-0000-4000-8000-00000000e103', 'SCOPE-E3', '__SCOPE_E3__', 'active',
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000a201',
    null, null, 'schedule_temp', 'test'
  ),
  (
    '00000000-0000-4000-8000-00000000e104', 'SCOPE-E4', '__SCOPE_E4__', 'active',
    '00000000-0000-4000-8000-00000000a102',
    '00000000-0000-4000-8000-00000000a204',
    null, null, 'schedule_temp', 'test'
  ),
  (
    -- This employee still references the higher duplicate master ID. The
    -- roster label must map it to canonical Service without dropping the row.
    '00000000-0000-4000-8000-00000000e105', 'SCOPE-E5', '__SCOPE_E5__', 'active',
    '00000000-0000-4000-8000-00000000a101',
    '00000000-0000-4000-8000-00000000a203',
    null, null, 'schedule_temp', 'test'
  );

insert into public.report_employee_directory_cache (
  employee_no, source_row, full_name, team_name, position_name, online_trainer, source_kind
) values
  ('SCOPE-E1', 9101, '__SCOPE_E1__', '__SCOPE_TEAM_A__', '__SCOPE_SERVICE__', '__SCOPE_CURRENT_TEACHER__', 'roster'),
  ('SCOPE-E2', 9102, '__SCOPE_E2__', '__SCOPE_TEAM_A__', '__SCOPE_PAYOUT__', null, 'roster'),
  ('SCOPE-E3', 9103, '__SCOPE_E3__', '__SCOPE_TEAM_B__', '__SCOPE_SERVICE__', '__SCOPE_TEACHER_B__', 'roster'),
  ('SCOPE-E4', 9104, '__SCOPE_E4__', '__SCOPE_TEAM_B__', '__SCOPE_ONLY_B__', null, 'roster'),
  ('SCOPE-E5', 9105, '__SCOPE_E5__', '__SCOPE_TEAM_A__', '__SCOPE_SERVICE__', '__SCOPE_CURRENT_TEACHER__', 'roster');

insert into auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-4000-8000-00000000f101', 'authenticated', 'authenticated',
    'scope-assigned-test@example.invalid', '{}'::jsonb, '{}'::jsonb,
    clock_timestamp(), clock_timestamp()
  ),
  (
    '00000000-0000-4000-8000-00000000f102', 'authenticated', 'authenticated',
    'scope-own-team-test@example.invalid', '{}'::jsonb, '{}'::jsonb,
    clock_timestamp(), clock_timestamp()
  ),
  (
    '00000000-0000-4000-8000-00000000f103', 'authenticated', 'authenticated',
    'scope-inactive-test@example.invalid', '{}'::jsonb, '{}'::jsonb,
    clock_timestamp(), clock_timestamp()
  );

insert into public.user_access (
  auth_user_id, employee_id, role_id, backend_enabled,
  employee_portal_enabled, active, data_scope
)
select fixture.auth_user_id, fixture.employee_id, role.id, true, false, true, 'self'
from (
  values
    ('00000000-0000-4000-8000-00000000f101'::uuid,
     '00000000-0000-4000-8000-00000000e101'::uuid),
    ('00000000-0000-4000-8000-00000000f102'::uuid,
     '00000000-0000-4000-8000-00000000e102'::uuid),
    ('00000000-0000-4000-8000-00000000f103'::uuid,
     '00000000-0000-4000-8000-00000000e103'::uuid)
) fixture(auth_user_id, employee_id)
cross join lateral (
  select candidate.id
  from public.roles candidate
  where candidate.active and candidate.code not in ('founder', 'employee')
  order by candidate.created_at, candidate.id
  limit 1
) role;

update public.user_access
set active = false,
    data_scope = 'assigned_teams'
where auth_user_id = '00000000-0000-4000-8000-00000000f103';

-- Seed a legacy grant to prove the materializer always removes the old OR arm.
insert into public.user_scope_teams (auth_user_id, team_id) values (
  '00000000-0000-4000-8000-00000000f101',
  '00000000-0000-4000-8000-00000000a102'
), (
  '00000000-0000-4000-8000-00000000f103',
  '00000000-0000-4000-8000-00000000a102'
);

select public.admin_save_account_access_scope(
  '00000000-0000-4000-8000-00000000f101',
  '00000000-0000-4000-8000-00000000e101',
  (
    select role.id from public.roles role
    where role.active and role.code not in ('founder', 'employee')
    order by role.created_at, role.id limit 1
  ),
  'assigned_teams',
  array['00000000-0000-4000-8000-00000000a101'::uuid],
  array['00000000-0000-4000-8000-00000000a201'::uuid],
  array['00000000-0000-4000-8000-00000000e102'::uuid]
);

update public.user_access
set data_scope = 'own_team'
where auth_user_id = '00000000-0000-4000-8000-00000000f102';

do $scope_semantics$
declare
  v_assigned uuid[];
  v_own_team uuid[];
  v_current jsonb;
begin
  if (select access.data_scope from public.user_access access
      where access.auth_user_id = '00000000-0000-4000-8000-00000000f101')
       is distinct from 'assigned_teams' then
    raise exception 'atomic save did not preserve the requested assigned scope';
  end if;

  select array_agg(scope.employee_id order by scope.employee_id)
  into v_assigned
  from public.admin_scope_effective_employee_ids(
    '00000000-0000-4000-8000-00000000f101'
  ) scope;

  if v_assigned is distinct from array[
    '00000000-0000-4000-8000-00000000e101'::uuid,
    '00000000-0000-4000-8000-00000000e102'::uuid,
    '00000000-0000-4000-8000-00000000e105'::uuid
  ] then
    raise exception 'assigned scope is not Team A AND (Service OR in-team E2): %', v_assigned;
  end if;

  if exists (
    select 1 from public.user_scope_teams legacy
    where legacy.auth_user_id = '00000000-0000-4000-8000-00000000f101'
  ) then
    raise exception 'assigned materialization left a legacy team OR grant';
  end if;

  if (select count(*) from public.user_scope_team_filters filter
      where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101') <> 1
     or (select count(*) from public.user_scope_position_filters filter
         where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101') <> 1
     or (select count(*) from public.user_scope_employee_filters filter
         where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101') <> 1 then
    raise exception 'configured dimensions were not preserved separately';
  end if;

  select array_agg(scope.employee_id order by scope.employee_id)
  into v_own_team
  from public.admin_scope_effective_employee_ids(
    '00000000-0000-4000-8000-00000000f102'
  ) scope;
  if v_own_team is distinct from array[
    '00000000-0000-4000-8000-00000000e101'::uuid,
    '00000000-0000-4000-8000-00000000e102'::uuid,
    '00000000-0000-4000-8000-00000000e105'::uuid
  ] then
    raise exception 'own_team did not follow the current roster: %', v_own_team;
  end if;

  if (select array_agg(effective.employee_id order by effective.employee_id)
      from public.user_scope_employees effective
      where effective.auth_user_id = '00000000-0000-4000-8000-00000000f102')
       is distinct from v_own_team then
    raise exception 'own_team was not materialized into the central allow-list';
  end if;

  if exists (
    select 1 from public.user_scope_teams legacy
    where legacy.auth_user_id = '00000000-0000-4000-8000-00000000f102'
  ) then
    raise exception 'own_team left a legacy team OR grant';
  end if;

  v_current := public.admin_scope_current_employee_directory();
  if not exists (
    select 1
    from jsonb_array_elements(v_current->'employees') item
    where item->>'employee_id' = '00000000-0000-4000-8000-00000000e101'
      and item->>'team_id' = '00000000-0000-4000-8000-00000000a101'
      and item->>'position_id' = '00000000-0000-4000-8000-00000000a201'
      and item->>'online_trainer' = '__SCOPE_CURRENT_TEACHER__'
  ) then
    raise exception 'current roster did not override stale canonical E1 organization/teacher';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_current->'employees') item
    where item->>'employee_id' = '00000000-0000-4000-8000-00000000e102'
      and item->'online_trainer' = 'null'::jsonb
  ) then
    raise exception 'blank current roster teacher incorrectly fell back to employee history';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_current->'employees') item
    where item->>'employee_id' = '00000000-0000-4000-8000-00000000e105'
      and item->>'position_id' = '00000000-0000-4000-8000-00000000a201'
  ) or not (v_current->'ambiguous_position_names' ? lower('__SCOPE_SERVICE__')) then
    raise exception 'duplicate position label was not deterministically canonicalized and diagnosed';
  end if;
end
$scope_semantics$;

-- Disabled/deleted backend access must not leave a dormant legacy team OR arm.
-- It is harmless while inactive, but becomes a future bypass if a compatibility
-- reader or reactivation path observes the stale row before a rebuild.
select public.admin_rebuild_account_employee_scope(
  '00000000-0000-4000-8000-00000000f103'
);

do $inactive_legacy_cleanup$
begin
  if exists (
    select 1 from public.user_scope_teams legacy
    where legacy.auth_user_id = '00000000-0000-4000-8000-00000000f103'
  ) or exists (
    select 1 from public.user_scope_employees effective
    where effective.auth_user_id = '00000000-0000-4000-8000-00000000f103'
  ) then
    raise exception 'inactive backend account retained legacy/effective authorization rows';
  end if;
end
$inactive_legacy_cleanup$;

do $position_without_team_rejected$
begin
  begin
    perform public.admin_save_account_scope_filters(
      '00000000-0000-4000-8000-00000000f101',
      '{}'::uuid[],
      array['00000000-0000-4000-8000-00000000a201'::uuid],
      '{}'::uuid[]
    );
    raise exception 'position-only assigned scope was accepted';
  exception
    when others then
      if sqlerrm = 'position-only assigned scope was accepted'
         or position('position_filter_requires_team' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$position_without_team_rejected$;

do $position_outside_selected_team_rejected$
begin
  begin
    perform public.admin_save_account_scope_filters(
      '00000000-0000-4000-8000-00000000f101',
      array['00000000-0000-4000-8000-00000000a101'::uuid],
      array['00000000-0000-4000-8000-00000000a204'::uuid],
      '{}'::uuid[]
    );
    raise exception 'position outside selected current team was accepted';
  exception
    when others then
      if sqlerrm = 'position outside selected current team was accepted'
         or position('position_filter_not_in_selected_current_team' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$position_outside_selected_team_rejected$;

do $employee_outside_selected_team_rejected$
begin
  begin
    perform public.admin_save_account_scope_filters(
      '00000000-0000-4000-8000-00000000f101',
      array['00000000-0000-4000-8000-00000000a101'::uuid],
      array['00000000-0000-4000-8000-00000000a201'::uuid],
      array['00000000-0000-4000-8000-00000000e104'::uuid]
    );
    raise exception 'employee outside selected current team was accepted';
  exception
    when others then
      if sqlerrm = 'employee outside selected current team was accepted'
         or position('employee_filter_not_in_selected_current_team' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$employee_outside_selected_team_rejected$;

do $noncanonical_duplicate_position_rejected$
begin
  begin
    perform public.admin_save_account_scope_filters(
      '00000000-0000-4000-8000-00000000f101',
      array['00000000-0000-4000-8000-00000000a101'::uuid],
      array['00000000-0000-4000-8000-00000000a203'::uuid],
      '{}'::uuid[]
    );
    raise exception 'noncanonical duplicate position ID was accepted';
  exception
    when others then
      if sqlerrm = 'noncanonical duplicate position ID was accepted'
         or position('position_filter_not_in_selected_current_team' in sqlerrm) = 0 then
        raise;
      end if;
  end;
end
$noncanonical_duplicate_position_rejected$;

-- A single database call changes identity/role/data_scope and clears all
-- assigned dimensions. No intermediate state can become visible at commit.
select public.admin_save_account_access_scope(
  '00000000-0000-4000-8000-00000000f101',
  '00000000-0000-4000-8000-00000000e101',
  (
    select role.id from public.roles role
    where role.active and role.code not in ('founder', 'employee')
    order by role.created_at, role.id limit 1
  ),
  'self', '{}'::uuid[], '{}'::uuid[], '{}'::uuid[]
);

do $atomic_scope_save$
declare
  v_definition text := pg_get_functiondef(
    'public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])'::regprocedure
  );
begin
  if (select access.data_scope from public.user_access access
      where access.auth_user_id = '00000000-0000-4000-8000-00000000f101') <> 'self'
     or exists (select 1 from public.user_scope_team_filters filter
                where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101')
     or exists (select 1 from public.user_scope_position_filters filter
                where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101')
     or exists (select 1 from public.user_scope_employee_filters filter
                where filter.auth_user_id = '00000000-0000-4000-8000-00000000f101')
     or exists (select 1 from public.user_scope_employees effective
                where effective.auth_user_id = '00000000-0000-4000-8000-00000000f101') then
    raise exception 'atomic scope save committed inconsistent account/filter/output state';
  end if;

  if position('pg_advisory_xact_lock' in v_definition) = 0
     or position('for update' in lower(v_definition)) = 0
     or position('update public.user_access' in v_definition) = 0
     or position('public.admin_save_account_scope_filters' in v_definition) = 0 then
    raise exception 'atomic account scope function lost its lock/update/filter transaction';
  end if;
end
$atomic_scope_save$;

do $module_guards$
declare
  v_backend text := pg_get_functiondef('public.backend_employee_in_scope(uuid)'::regprocedure);
  v_rebuild text := lower(pg_get_functiondef(
    'scope_private.rebuild_account_employee_scope(uuid)'::regprocedure
  ));
  v_attendance_home text := pg_get_functiondef(
    'attendance_private.admin_attendance_home(jsonb)'::regprocedure
  );
  v_attendance_monthly text := pg_get_functiondef(
    'attendance_private.admin_attendance_monthly(jsonb)'::regprocedure
  );
  v_exam_target text := pg_get_functiondef(
    'session_private.exam_assignment_target_in_scope(text,text,uuid)'::regprocedure
  );
  v_assigned_resource text := pg_get_functiondef(
    'scope_private.assigned_team_position_in_scope(uuid,text,text)'::regprocedure
  );
  v_exam_team text := pg_get_functiondef(
    'session_private.exam_team_in_scope(text)'::regprocedure
  );
  v_training_employee text := pg_get_functiondef(
    'public.online_training_employee_in_scope(uuid)'::regprocedure
  );
  v_training_report text := pg_get_functiondef(
    'public.online_training_can_view_report(uuid)'::regprocedure
  );
  v_training_edit text := pg_get_functiondef(
    'public.online_training_can_edit_report(uuid)'::regprocedure
  );
begin
  if position('public.user_scope_employees' in v_backend) = 0
     or position('public.user_scope_teams' in v_backend) > 0 then
    raise exception 'central employee guard no longer uses materialized IDs only';
  end if;

  if position('scope_private.current_employee_scope_directory' in v_rebuild) = 0
     or position('if v_scope = ''own_team''' in v_rebuild) = 0
     or position('public.user_scope_employee_filters' in v_rebuild) = 0 then
    raise exception 'materializer lost current-roster own-team/assigned semantics';
  end if;

  if position('public.backend_employee_in_scope(x.employee_id)' in v_attendance_home) = 0
     or position('public.backend_employee_in_scope(x.employee_id)' in v_attendance_monthly) = 0
     or position('public.backend_employee_in_scope(e.id)' in v_attendance_monthly) = 0 then
    raise exception 'attendance retained a canonical-team or unmatched-name own_team bypass';
  end if;

  -- Employee-targeted exam assignments must validate the employee's current
  -- roster team and position too; checking only the employee UUID lets a named
  -- exception be attached to an arbitrary question-bank dimension.
  if position('scope_private.current_employee_scope_directory' in v_exam_target) = 0
     or position('p_team_name' in v_exam_target) = 0
     or position('p_position_name' in v_exam_target) = 0 then
    raise exception 'exam employee assignment does not bind payload organization to current roster';
  end if;

  if position('scope_private.current_employee_scope_directory' in v_assigned_resource) = 0
     or position('directory.current_team_id' in v_assigned_resource) = 0
     or position('directory.current_position_id' in v_assigned_resource) = 0
     or position('scope_private.current_employee_scope_directory' in v_exam_team) = 0 then
    raise exception 'stale team/position filters can still grant exam resources';
  end if;

  if position('public.backend_employee_in_scope(p_employee_id)' in v_training_employee) = 0
     or position('not public.backend_employee_in_scope(member.employee_id)' in v_training_report) = 0
     or position('public.online_training_can_view_report(p_report_id)' in v_training_edit) = 0 then
    raise exception 'online training can expand above the generic employee scope ceiling';
  end if;
end
$module_guards$;

do $obsolete_trigger_and_lock_order$
declare
  v_rebuild text := lower(pg_get_functiondef(
    'scope_private.rebuild_account_employee_scope(uuid)'::regprocedure
  ));
  v_filter_save text := lower(pg_get_functiondef(
    'public.admin_save_account_scope_filters(uuid,uuid[],uuid[],uuid[])'::regprocedure
  ));
  v_atomic_save text := lower(pg_get_functiondef(
    'public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])'::regprocedure
  ));
  v_rebuild_all text := lower(pg_get_functiondef(
    'scope_private.rebuild_all_assigned_employee_scopes()'::regprocedure
  ));
begin
  if exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_access'::regclass
      and trigger_row.tgname = 'enforce_linked_backend_own_team_trigger'
      and not trigger_row.tgisinternal
  ) or to_regprocedure('public.enforce_linked_backend_own_team()') is not null then
    raise exception 'obsolete linked-account own_team coercion is still installed';
  end if;

  -- Every concurrent path must acquire locks in the same row -> advisory order.
  -- Otherwise an ordinary user_access UPDATE (row first, AFTER trigger second)
  -- can deadlock an atomic save that holds advisory first and waits for the row.
  if position('for update' in v_rebuild) = 0
     or position('pg_advisory_xact_lock' in v_rebuild) = 0
     or position('for update' in v_rebuild) > position('pg_advisory_xact_lock' in v_rebuild)
     or position('for update' in v_filter_save) = 0
     or position('pg_advisory_xact_lock' in v_filter_save) = 0
     or position('for update' in v_filter_save) > position('pg_advisory_xact_lock' in v_filter_save)
     or position('for update' in v_atomic_save) = 0
     or position('pg_advisory_xact_lock' in v_atomic_save) = 0
     or position('for update' in v_atomic_save) > position('pg_advisory_xact_lock' in v_atomic_save) then
    raise exception 'account scope writers do not share row-then-advisory lock order';
  end if;

  if position('order by access.auth_user_id' in v_rebuild_all) = 0 then
    raise exception 'global scope rebuild does not lock accounts deterministically';
  end if;
end
$obsolete_trigger_and_lock_order$;

do $authorization_outputs_are_read_only$
begin
  if has_table_privilege('service_role', 'public.user_scope_teams', 'INSERT')
     or has_table_privilege('service_role', 'public.user_scope_teams', 'UPDATE')
     or has_table_privilege('service_role', 'public.user_scope_teams', 'DELETE')
     or has_table_privilege('service_role', 'public.user_scope_employees', 'INSERT')
     or has_table_privilege('service_role', 'public.user_scope_employees', 'UPDATE')
     or has_table_privilege('service_role', 'public.user_scope_employees', 'DELETE') then
    raise exception 'service role can bypass the materializer and write authorization outputs';
  end if;

  if not has_table_privilege('service_role', 'public.user_scope_team_filters', 'SELECT')
     or has_table_privilege('service_role', 'public.user_scope_team_filters', 'INSERT')
     or has_table_privilege('service_role', 'public.user_scope_position_filters', 'UPDATE')
     or has_table_privilege('service_role', 'public.user_scope_employee_filters', 'DELETE') then
    raise exception 'scope configuration ACL no longer enforces RPC-only writes';
  end if;
end
$authorization_outputs_are_read_only$;

rollback;
