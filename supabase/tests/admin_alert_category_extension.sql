-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_constraint text;
  v_center text;
begin
  select pg_catalog.pg_get_constraintdef(constraint_row.oid)
  into v_constraint
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.admin_alert_events'::regclass
    and constraint_row.conname = 'admin_alert_events_type_check';

  if strpos(v_constraint, 'exam_failed') = 0
     or strpos(v_constraint, 'resigned_account_active') = 0 then
    raise exception 'extended alert types are missing from the table constraint';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated', 'alerts_private.refresh_extended_alerts()', 'execute'
     ) then
    raise exception 'authenticated role can execute the private extended refresh';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.admin_alert_center(jsonb,integer,integer)'::regprocedure
  ) into v_center;
  if strpos(v_center, 'invalid_alert_group') = 0
     or strpos(v_center, '''exam_failed''') = 0
     or strpos(v_center, '''resigned_account_active''') = 0
     or strpos(v_center, '''exam.view''') = 0
     or strpos(v_center, '''daily_work.manage''') = 0
     or strpos(v_center, '''account.view''') = 0 then
    raise exception 'extended RPC filter or permission guard is missing';
  end if;
end;
$$;

insert into public.employees(id, employee_no, full_name, status)
values
  ('00000000-0000-4000-8000-000000000411', 'ALERT-EXT-EXAM', '__ALERT_EXT_EXAM__', 'active'),
  ('00000000-0000-4000-8000-000000000412', 'ALERT-EXT-ACCESS', '__ALERT_EXT_ACCESS__', 'resigned');

insert into public.legacy_exam_sessions(
  id, source_project_ref, source_session_id, employee_id, employee_no,
  employee_name, employee_match_status, status, series_name, position_name,
  started_at, submitted_at, graded_at, earned_score, total_score, percentage,
  passed, source_changed_at
) values (
  '00000000-0000-4000-8000-000000000413',
  '__alert_extension_test__',
  '00000000-0000-4000-8000-000000000414',
  '00000000-0000-4000-8000-000000000411',
  'ALERT-EXT-EXAM',
  '__ALERT_EXT_EXAM__',
  'matched',
  'graded',
  '__ALERT_EXT_SERIES__',
  '__ALERT_EXT_POSITION__',
  clock_timestamp() - interval '40 minutes',
  clock_timestamp() - interval '30 minutes',
  clock_timestamp() - interval '20 minutes',
  50,
  100,
  50,
  false,
  clock_timestamp()
);

select alerts_private.refresh_extended_alerts();

do $$
begin
  if not exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'exam_failed:00000000-0000-4000-8000-000000000411'
      and event.alert_type = 'exam_failed'
      and event.is_active
      and event.source_ref = 'legacy:00000000-0000-4000-8000-000000000413'
  ) then raise exception 'latest failed exam did not create an active alert'; end if;
end;
$$;

update public.legacy_exam_sessions
set earned_score = 80,
    percentage = 80,
    passed = true,
    graded_at = clock_timestamp(),
    source_changed_at = clock_timestamp()
where id = '00000000-0000-4000-8000-000000000413';

select alerts_private.refresh_extended_alerts();

do $$
begin
  if exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'exam_failed:00000000-0000-4000-8000-000000000411'
      and event.is_active
  ) then raise exception 'a later passing result did not resolve the exam alert'; end if;
end;
$$;

insert into auth.users(
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-4000-8000-000000000415',
  'authenticated',
  'authenticated',
  'alert-extension-test@example.invalid',
  '{}'::jsonb,
  '{}'::jsonb,
  clock_timestamp(),
  clock_timestamp()
);

insert into public.user_access(
  auth_user_id, employee_id, role_id, backend_enabled,
  employee_portal_enabled, active, data_scope
)
select
  '00000000-0000-4000-8000-000000000415',
  '00000000-0000-4000-8000-000000000412',
  role.id,
  true,
  false,
  true,
  'self'
from public.roles role
order by role.is_system desc, role.created_at
limit 1;

select alerts_private.refresh_extended_alerts();

do $$
begin
  if not exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'resigned_account_active:00000000-0000-4000-8000-000000000412'
      and event.alert_type = 'resigned_account_active'
      and event.is_active
      and event.payload->>'automatic_disable' = 'false'
  ) then raise exception 'enabled access for a resigned employee did not create an alert'; end if;
end;
$$;

update public.user_access
set active = false,
    backend_enabled = false,
    employee_portal_enabled = false
where auth_user_id = '00000000-0000-4000-8000-000000000415';

select alerts_private.refresh_extended_alerts();

do $$
begin
  if exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'resigned_account_active:00000000-0000-4000-8000-000000000412'
      and event.is_active
  ) then raise exception 'fully recovered resigned access did not resolve its alert'; end if;
end;
$$;

rollback;
