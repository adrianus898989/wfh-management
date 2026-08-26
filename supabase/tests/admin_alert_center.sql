-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

do $$
declare
  v_refresh_definition text;
  v_wrapper_definition text;
  v_pre_detail_definition text;
  v_extended_definition text;
  v_detail_definition text;
begin
  if not exists (
    select 1 from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'admin_alert_events'
      and relation.relrowsecurity
  ) then raise exception 'admin_alert_events RLS is not enabled'; end if;

  if pg_catalog.has_table_privilege('authenticated', 'public.admin_alert_events', 'select')
     or pg_catalog.has_table_privilege('authenticated', 'public.admin_alert_read_receipts', 'select') then
    raise exception 'authenticated role has direct alert-table read access';
  end if;

  if pg_catalog.has_function_privilege(
    'authenticated', 'alerts_private.refresh_alerts()', 'execute'
  ) then raise exception 'authenticated role can execute the private refresh'; end if;

  if to_regprocedure('public.admin_alert_center(jsonb,integer,integer)') is null
     or to_regprocedure('public.admin_alert_mark_read(uuid)') is null then
    raise exception 'public alert RPC is missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_core_alerts()'::regprocedure
  ) into v_refresh_definition;
  if strpos(v_refresh_definition, 'count(distinct error.record_key) >= 6') = 0
     or strpos(v_refresh_definition, 'having count(*) >= 4') = 0
     or strpos(v_refresh_definition, 'home_leave_excluded') = 0
     or strpos(v_refresh_definition, 'payout_change') > 0 then
    raise exception 'one or more warning thresholds are missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_alerts()'::regprocedure
  ) into v_wrapper_definition;
  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_alerts_without_attendance_details()'::regprocedure
  ) into v_pre_detail_definition;
  select pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_extended_alerts()'::regprocedure
  ) into v_extended_definition;
  select pg_catalog.pg_get_functiondef(
    'alerts_private.enrich_attendance_alert_details()'::regprocedure
  ) into v_detail_definition;
  if strpos(v_wrapper_definition, 'refresh_alerts_without_attendance_details') = 0
     or strpos(v_wrapper_definition, 'enrich_attendance_alert_details') = 0
     or strpos(v_pre_detail_definition, 'refresh_core_alerts') = 0
     or strpos(v_pre_detail_definition, 'refresh_extended_alerts') = 0
     or strpos(v_extended_definition, 'latest_graded_attempt_failed') = 0
     or strpos(v_extended_definition, 'resigned_account_active') = 0
     or strpos(v_detail_definition, '''events''') = 0
     or strpos(v_detail_definition, 'record.reason') = 0
     or strpos(v_detail_definition, 'record.note') = 0
     or strpos(v_detail_definition, '''home_leave''') = 0
     or strpos(v_detail_definition, 'ranked.event_kind = ''home_leave''') = 0
     or strpos(v_detail_definition, 'pg_try_advisory_xact_lock') = 0 then
    raise exception 'extended alert refresh composition is missing';
  end if;

  if pg_catalog.has_function_privilege(
    'authenticated', 'alerts_private.enrich_attendance_alert_details()', 'execute'
  ) or pg_catalog.has_function_privilege(
    'authenticated', 'alerts_private.refresh_alerts_without_attendance_details()', 'execute'
  ) then raise exception 'authenticated role can execute private alert refresh helpers'; end if;

  if not exists (
    select 1
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class relation on relation.oid = index_row.indrelid
    join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'admin_alert_events'
      and index_row.indisunique
      and strpos(pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid), 'is_active') > 0
      and pg_catalog.pg_get_indexdef(index_row.indexrelid) like '%(condition_key)%'
  ) then raise exception 'one-active-incident condition index is missing'; end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.payout_change_requests'::regclass
      and trigger_row.tgname = 'payout_change_admin_alert_delete_trigger'
      and not trigger_row.tgisinternal
  ) then raise exception 'payout delete reconciliation trigger is missing'; end if;

  if not exists (
    select 1 from cron.job where jobname = 'admin-alert-refresh'
      and schedule = '*/5 * * * *'
  ) then raise exception 'five-minute alert refresh cron is missing'; end if;

  if lower('related to phone') ~ '(^|[^[:alnum:]_])late([^[:alnum:]_]|$)'
     or lower('calculated deduction') ~ '(^|[^[:alnum:]_])late([^[:alnum:]_]|$)'
     or not lower('late 8 minutes') ~ '(^|[^[:alnum:]_])late([^[:alnum:]_]|$)'
     or not lower('woke up late') ~ '(^|[^[:alnum:]_])late([^[:alnum:]_]|$)' then
    raise exception 'late-word boundary regression';
  end if;
end;
$$;

insert into public.employees(id, employee_no, full_name, status)
values (
  '00000000-0000-4000-8000-000000000301',
  'ALERT-TEST-01',
  '__ALERT_TEST_EMPLOYEE__',
  'active'
);

insert into public.payout_change_requests(
  id, employee_id, new_data, reason, payment_kind, status
) values (
  '00000000-0000-4000-8000-000000000302',
  '00000000-0000-4000-8000-000000000301',
  '{"masked":"test"}'::jsonb,
  '__ALERT_TEST_REASON__',
  'bank_wallet',
  'pending'
);

do $$
begin
  if not exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.alert_type = 'payout_change'
      and event.is_active
      and event.payload ? 'request_id'
      and not (event.payload ? 'new_data')
  ) then raise exception 'pending payout trigger did not create a redacted alert'; end if;
end;
$$;

update public.payout_change_requests
set reason = '__ALERT_TEST_REASON_UPDATED__'
where id = '00000000-0000-4000-8000-000000000302';

do $$
begin
  if (
    select count(*) from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
  ) <> 1 or not exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.is_active
      and event.payload->>'reason' = '__ALERT_TEST_REASON_UPDATED__'
  ) then raise exception 'pending payout update did not reuse and refresh its active incident'; end if;
end;
$$;

update public.payout_change_requests
set status = 'approved'
where id = '00000000-0000-4000-8000-000000000302';

do $$
begin
  if exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.is_active
  ) then raise exception 'reviewed payout alert remained active'; end if;
end;
$$;

update public.payout_change_requests
set status = 'pending'
where id = '00000000-0000-4000-8000-000000000302';

do $$
begin
  if (
    select count(*) from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
  ) <> 2 or (
    select count(*) from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.is_active
  ) <> 1 then
    raise exception 'reopened payout did not preserve the resolved incident history';
  end if;
end;
$$;

delete from public.employees
where id = '00000000-0000-4000-8000-000000000301';

do $$
begin
  if exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.is_active
  ) then raise exception 'employee cascade-delete left a payout alert active'; end if;

  if not exists (
    select 1 from public.admin_alert_events event
    where event.condition_key = 'payout_change:00000000-0000-4000-8000-000000000302'
      and event.employee_id is null
      and event.employee_no = 'ALERT-TEST-01'
      and event.employee_name = '__ALERT_TEST_EMPLOYEE__'
  ) then raise exception 'employee deletion did not preserve the alert identity snapshot'; end if;
end;
$$;

rollback;
