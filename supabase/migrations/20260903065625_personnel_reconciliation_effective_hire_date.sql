begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $dependencies$
begin
  if to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.teams') is null
     or to_regclass('public.positions') is null
     or to_regclass('public.employee_master_sync_runs') is null
     or to_regclass('public.employee_master_source_snapshots') is null
     or to_regclass('public.employee_master_sync_issues') is null
     or to_regclass('public.report_employee_directory_cache') is null
     or to_regclass('public.report_sheet_snapshots') is null
     or to_regclass(
       'employee_private.employee_master_roster_overrides'
     ) is null
     or to_regprocedure('public.has_permission(text)') is null
     or to_regprocedure(
       'session_private.current_app_session_is_valid(text)'
     ) is null
     or to_regprocedure(
       'public.admin_scope_effective_employee_ids(uuid)'
     ) is null
     or to_regprocedure(
       'scope_private.current_employee_scope_directory()'
     ) is null
     or to_regprocedure(
       'employee_private.resolve_confirmed_employee_id(text)'
     ) is null
     or to_regprocedure('public.employee_master_normalize_id(text)') is null
  then
    raise exception 'personnel_reconciliation_dependency_missing';
  end if;
end
$dependencies$;

insert into public.permissions(code, name, category, sensitive)
values (
  'employee.reconciliation.view',
  '查看人员对账',
  'employee',
  true
)
on conflict(code) do update set
  name = excluded.name,
  category = excluded.category,
  sensitive = excluded.sensitive;

-- This is a new sensitive surface.  Seed it only to the highest system role;
-- all other access must be granted explicitly through the permission editor.
insert into public.role_permissions(role_id, permission_id)
select role.id, permission.id
from public.roles role
cross join public.permissions permission
where role.code = 'founder'
  and role.active = true
  and permission.code = 'employee.reconciliation.view'
on conflict(role_id, permission_id) do nothing;

create or replace function public.admin_personnel_reconciliation(
  p_view text,
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '6s'
set lock_timeout = '500ms'
set jit = 'off'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_view text := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_view, ''))
  );
  v_filter_object jsonb := coalesce(p_filters, '{}'::jsonb);
  v_search text;
  v_issue_filter text;
  v_reason_filter text;
  v_status_filter text;
  v_classification_filter text;
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(
    greatest(coalesce(p_page_size, 30), 1),
    50
  );
  v_role_code text;
  v_data_scope text;
  v_all_scope boolean := false;
  v_today date := (pg_catalog.statement_timestamp()
    at time zone 'Asia/Manila')::date;
  v_run_id bigint;
  v_run_captured_at timestamptz;
  v_run_finished_at timestamptz;
  v_home_row_count integer;
  v_schedule_row_count integer;
  v_home_payload jsonb;
  v_schedule_payload jsonb;
  v_report_payload jsonb;
  v_report_row_count integer;
  v_report_synced_at timestamptz;
  v_summary jsonb := '{}'::jsonb;
  v_freshness jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_total bigint := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;

  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;

  if not public.has_permission('employee.reconciliation.view') then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if pg_catalog.jsonb_typeof(v_filter_object) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_filters';
  end if;

  if v_view not in ('summary', 'headcount', 'issues', 'onsite') then
    raise exception using errcode = '22023',
      message = 'invalid_reconciliation_view';
  end if;

  v_search := pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(
    coalesce(v_filter_object->>'search', '')
  )), 120);
  v_issue_filter := pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(
    coalesce(v_filter_object->>'issue_code', '')
  )), 100);
  v_reason_filter := pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(
    coalesce(v_filter_object->>'reason_code', '')
  )), 100);
  v_status_filter := pg_catalog.left(pg_catalog.lower(pg_catalog.btrim(
    coalesce(v_filter_object->>'status', '')
  )), 40);
  v_classification_filter := pg_catalog.left(
    pg_catalog.lower(pg_catalog.btrim(
      coalesce(v_filter_object->>'classification', '')
    )),
    40
  );

  select role.code, access.data_scope
  into v_role_code, v_data_scope
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
    and role.active = true
  order by access.updated_at desc
  limit 1;

  if v_role_code is null then
    raise exception using errcode = '42501',
      message = 'backend_access_required';
  end if;

  v_all_scope := v_role_code = 'founder' or v_data_scope = 'all';

  -- Capture both payloads in one statement and keep them in local variables.
  -- Subsequent queries therefore cannot mix pages from two sync commits.
  select
    run.id,
    run.captured_at,
    run.finished_at,
    home_snapshot.row_count,
    schedule_snapshot.row_count,
    home_snapshot.payload,
    schedule_snapshot.payload
  into
    v_run_id,
    v_run_captured_at,
    v_run_finished_at,
    v_home_row_count,
    v_schedule_row_count,
    v_home_payload,
    v_schedule_payload
  from public.employee_master_source_snapshots home_snapshot
  join public.employee_master_source_snapshots schedule_snapshot
    on schedule_snapshot.run_id = home_snapshot.run_id
   and schedule_snapshot.source_key = 'home_schedule_roster_current'
  join public.employee_master_sync_runs run
    on run.id = home_snapshot.run_id
   and run.status = 'success'
   and home_snapshot.captured_at = run.captured_at
   and schedule_snapshot.captured_at = run.captured_at
   and home_snapshot.row_count = run.home_roster_row_count
   and schedule_snapshot.row_count = run.schedule_roster_row_count
  where home_snapshot.source_key = 'home_employee_roster_current'
  order by run.finished_at desc nulls last,
    run.captured_at desc,
    run.id desc
  limit 1;

  if v_run_id is null
     or pg_catalog.jsonb_typeof(v_home_payload) <> 'array'
     or pg_catalog.jsonb_typeof(v_schedule_payload) <> 'array'
  then
    raise exception using errcode = '55000',
      message = 'source_snapshot_inconsistent';
  end if;

  select snapshot.payload, snapshot.row_count, snapshot.synced_at
  into v_report_payload, v_report_row_count, v_report_synced_at
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表'
  order by snapshot.synced_at desc
  limit 1;

  if v_report_synced_at is null
     or pg_catalog.jsonb_typeof(v_report_payload) <> 'array'
     or pg_catalog.jsonb_array_length(v_report_payload) = 0
  then
    raise exception using errcode = '55000',
      message = 'report_snapshot_inconsistent';
  end if;

  v_freshness := pg_catalog.jsonb_build_object(
    'run_id', v_run_id,
    'captured_at', v_run_captured_at,
    'finished_at', v_run_finished_at,
    'home_rows', v_home_row_count,
    'schedule_rows', v_schedule_row_count,
    'age_seconds', greatest(
      0,
      pg_catalog.floor(extract(
        epoch from pg_catalog.statement_timestamp() - v_run_captured_at
      ))::bigint
    ),
    'report_source', '居家排班表/填表',
    'report_synced_at', v_report_synced_at,
    'report_rows', v_report_row_count,
    'report_age_seconds', greatest(
      0,
      pg_catalog.floor(extract(
        epoch from pg_catalog.statement_timestamp() - v_report_synced_at
      ))::bigint
    ),
    'report_is_stale', v_report_synced_at <
      pg_catalog.statement_timestamp() - interval '36 hours',
    'is_stale', v_run_captured_at <
      pg_catalog.statement_timestamp() - interval '36 hours'
      or v_report_synced_at <
        pg_catalog.statement_timestamp() - interval '36 hours'
  );

  with
  scope_ids as materialized (
    select scoped.employee_id
    from public.admin_scope_effective_employee_ids(v_user_id) scoped
  ),
  scoped_employees as materialized (
    select employee.id, employee.employee_no, employee.full_name,
      employee.status, employee.hire_date, employee.resign_date,
      employee.source_type, employee.employment_type
    from scope_ids scope
    join public.employees employee on employee.id = scope.employee_id
    where nullif(
        public.employee_master_normalize_id(employee.employee_no),
        ''
      ) is not null
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and public.employee_master_normalize_id(employee.employee_no)
        not like 'TEST%'
      and coalesce(employee.source_type, '') <> 'google_deleted'
  ),
  scope_report_employee_keys as materialized (
    select distinct pg_catalog.upper(pg_catalog.btrim(employee.employee_no))
      employee_key
    from scope_ids scope
    join public.employees employee on employee.id = scope.employee_id
    where nullif(pg_catalog.btrim(employee.employee_no), '') is not null
  ),
  schedule_raw as materialized (
    select
      public.employee_master_normalize_id(entry.item->>'employee_id')
        employee_key,
      nullif(pg_catalog.btrim(entry.item->>'name_key'), '') name_key,
      case
        when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
          then (entry.item->>'source_row')::integer
        else null::integer
      end source_row,
      pg_catalog.lower(coalesce(entry.item->>'onsite_marker', 'false'))
        in ('true', '1', 'yes') source_onsite_marker,
      employee_private.resolve_confirmed_employee_id(
        entry.item->>'employee_id'
      ) employee_id
    from pg_catalog.jsonb_array_elements(v_schedule_payload)
      entry(item)
  ),
  schedule_visible as materialized (
    select source.*,
      coalesce(source.employee_id::text, 'raw:' || source.employee_key)
        identity_key
    from schedule_raw source
    left join scope_ids scope on scope.employee_id = source.employee_id
    where nullif(source.employee_key, '') is not null
      and (
        (source.employee_id is not null and scope.employee_id is not null)
        or (source.employee_id is null and v_all_scope)
      )
  ),
  schedule_unique as materialized (
    select distinct on (source.identity_key) source.*
    from schedule_visible source
    order by source.identity_key, source.source_row nulls last
  ),
  schedule_identity_rollup as materialized (
    select
      source.employee_id,
      pg_catalog.bool_or(
        source.source_onsite_marker
        or coalesce(
          override.override_kind in (
            'confirmed_onsite',
            'managed_external'
          ),
          false
        )
      ) accepted_onsite
    from schedule_raw source
    join scoped_employees employee on employee.id = source.employee_id
    left join employee_private.employee_master_roster_overrides override
      on override.active = true
     and override.employee_no = source.employee_key
     and override.expected_name_key = source.name_key
    group by source.employee_id
  ),
  accepted_schedule_keys as materialized (
    select distinct source.employee_key
    from schedule_raw source
    left join employee_private.employee_master_roster_overrides override
      on override.active = true
     and override.employee_no = source.employee_key
     and override.expected_name_key = source.name_key
    where source.source_onsite_marker
       or override.override_kind in ('confirmed_onsite', 'managed_external')
  ),
  report_raw as materialized (
    select
      pg_catalog.upper(pg_catalog.btrim(coalesce(
        entry.item->>'employee_id',
        ''
      ))) report_scope_key,
      public.employee_master_normalize_id(
        coalesce(entry.item->>'employee_id', entry.item->>'employee_no')
      ) employee_key,
      pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
        pg_catalog.translate(
          normalize(pg_catalog.btrim(coalesce(
            entry.item->>'name',
            entry.item->>'full_name',
            ''
          )), NFKC),
          U&'\200B\200C\200D\2060\FEFF',
          ''
        ),
        '[[:space:]]+',
        ' ',
        'g'
      ))) name_key,
      nullif(pg_catalog.btrim(coalesce(
        entry.item->>'name',
        entry.item->>'full_name'
      )), '') source_name,
      case
        when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
          then (entry.item->>'source_row')::integer
        else null::integer
      end source_row,
      employee_private.resolve_confirmed_employee_id(
        coalesce(entry.item->>'employee_id', entry.item->>'employee_no')
      ) employee_id
    from pg_catalog.jsonb_array_elements(v_report_payload) entry(item)
  ),
  report_visible as materialized (
    select report.*,
      case
        when nullif(report.employee_key, '') is not null
          then 'id:' || report.employee_key
        when nullif(report.name_key, '') is not null
          then 'name:' || report.name_key
        else null::text
      end person_key,
      case
        when report.employee_id is not null then report.employee_id::text
        when nullif(report.employee_key, '') is not null
          then 'raw:' || report.employee_key
        when nullif(report.name_key, '') is not null
          then 'report-name:' || report.name_key
        else null::text
      end identity_key
    from report_raw report
    where v_all_scope
       or exists (
         select 1
         from scope_report_employee_keys scoped_key
         where scoped_key.employee_key = report.report_scope_key
       )
  ),
  report_person_set as materialized (
    select distinct on (report.person_key) report.*
    from report_visible report
    where report.person_key is not null
    order by report.person_key, report.source_row nulls last
  ),
  report_set as materialized (
    select distinct on (report.identity_key) report.*
    from report_visible report
    where report.identity_key is not null
    order by report.identity_key, report.source_row nulls last
  ),
  report_alias_duplicates as materialized (
    select report.identity_key
    from report_visible report
    where report.employee_id is not null
      and report.person_key is not null
    group by report.identity_key
    having pg_catalog.count(distinct report.person_key) > 1
  ),
  directory_raw as materialized (
    select
      public.employee_master_normalize_id(directory.employee_no)
        employee_key,
      employee_private.resolve_confirmed_employee_id(directory.employee_no)
        employee_id,
      directory.source_row
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
  ),
  directory_visible as materialized (
    select directory.*,
      coalesce(directory.employee_id::text, 'raw:' || directory.employee_key)
        identity_key
    from directory_raw directory
    left join scope_ids scope on scope.employee_id = directory.employee_id
    where nullif(directory.employee_key, '') is not null
      and (
        (directory.employee_id is not null and scope.employee_id is not null)
        or (directory.employee_id is null and v_all_scope)
      )
  ),
  directory_unique as materialized (
    select distinct on (directory.identity_key) directory.*
    from directory_visible directory
    order by directory.identity_key, directory.source_row nulls last
  ),
  strict_directory as materialized (
    select directory.employee_id
    from scope_private.current_employee_scope_directory() directory
    join scope_ids scope on scope.employee_id = directory.employee_id
  ),
  effective_active as materialized (
    select employee.id employee_id, employee.id::text identity_key
    from scoped_employees employee
    where pg_catalog.lower(pg_catalog.btrim(coalesce(employee.status, '')))
        in ('active', 'probation', '在职', '试用')
      and (employee.hire_date is null or employee.hire_date <= v_today)
  ),
  employee_page_effective as materialized (
    select effective.employee_id, effective.identity_key
    from strict_directory directory
    join effective_active effective
      on effective.employee_id = directory.employee_id
  ),
  headcount_identities as materialized (
    select effective.identity_key from effective_active effective
    union
    select employee_page.identity_key
    from employee_page_effective employee_page
    union
    select directory.identity_key from directory_unique directory
    union
    select report.identity_key from report_set report
  ),
  headcount_membership as materialized (
    select identity.identity_key,
      effective.identity_key is not null in_effective,
      employee_page.identity_key is not null in_employee_page,
      directory.identity_key is not null in_directory,
      report.identity_key is not null in_report
    from headcount_identities identity
    left join effective_active effective
      on effective.identity_key = identity.identity_key
    left join employee_page_effective employee_page
      on employee_page.identity_key = identity.identity_key
    left join directory_unique directory
      on directory.identity_key = identity.identity_key
    left join report_set report
      on report.identity_key = identity.identity_key
  ),
  visible_issues as materialized (
    select issue.id
    from public.employee_master_sync_issues issue
    left join lateral (
      select employee_private.resolve_confirmed_employee_id(
        issue.employee_no
      ) employee_id
    ) resolved on true
    left join scope_ids scope on scope.employee_id = resolved.employee_id
    where issue.run_id = v_run_id
      and (
        (resolved.employee_id is not null and scope.employee_id is not null)
        or (resolved.employee_id is null and v_all_scope)
      )
      and not (
        issue.issue_code = 'schedule_only_missing_onsite_marker'
        and (
          exists (
            select 1
            from schedule_identity_rollup rollup
            where rollup.employee_id = resolved.employee_id
              and rollup.accepted_onsite
          )
          or exists (
            select 1
            from accepted_schedule_keys accepted
            where accepted.employee_key =
              public.employee_master_normalize_id(issue.employee_no)
          )
        )
      )
  ),
  schedule_backfill_issues as materialized (
    select rollup.employee_id
    from schedule_identity_rollup rollup
    join scoped_employees employee on employee.id = rollup.employee_id
    where employee.source_type = 'schedule_only'
      and employee.employment_type = '排班补录'
      and not rollup.accepted_onsite
  ),
  onsite_ranked as materialized (
    select source.identity_key,
      pg_catalog.row_number() over (
        partition by source.identity_key
        order by
          case override.override_kind
            when 'confirmed_onsite' then 1
            when 'managed_external' then 2
            else 3
          end,
          source.source_row nulls last
      ) onsite_rank
    from schedule_visible source
    left join employee_private.employee_master_roster_overrides override
      on override.active = true
     and override.employee_no = source.employee_key
     and override.expected_name_key = source.name_key
    where source.source_onsite_marker
       or override.override_kind in ('confirmed_onsite', 'managed_external')
  ),
  headcount_issue_keys as materialized (
    select membership.identity_key
    from headcount_membership membership
    where not (
        membership.in_effective
        and membership.in_employee_page
        and membership.in_directory
        and membership.in_report
      )
      and not exists (
        select 1
        from onsite_ranked onsite
        where onsite.identity_key = membership.identity_key
          and onsite.onsite_rank = 1
      )
      -- A future hire may already be preloaded into the current directory and
      -- report source. That is preparation, not a difference in today's
      -- effective headcount.
      and not exists (
        select 1
        from scoped_employees employee
        where employee.id::text = membership.identity_key
          and employee.hire_date is not null
          and employee.hire_date > v_today
      )
    union
    select duplicate.identity_key
    from report_alias_duplicates duplicate
    where not exists (
      select 1
      from onsite_ranked onsite
      where onsite.identity_key = duplicate.identity_key
        and onsite.onsite_rank = 1
    )
      and not exists (
        select 1
        from scoped_employees employee
        where employee.id::text = duplicate.identity_key
          and employee.hire_date is not null
          and employee.hire_date > v_today
      )
  )
  select pg_catalog.jsonb_build_object(
    'dashboard_active', (
      select pg_catalog.count(*) from effective_active
    ),
    'effective_active', (
      select pg_catalog.count(*) from effective_active
    ),
    'dashboard_effective_active', (
      select pg_catalog.count(*) from effective_active
    ),
    'directory_effective_active', (
      select pg_catalog.count(*) from employee_page_effective
    ),
    'directory_total', (
      select pg_catalog.count(*) from directory_unique
    ),
    'schedule_unique_total', (
      select pg_catalog.count(*) from schedule_unique
    ),
    'report_total', (
      select pg_catalog.count(*) from report_person_set
    ),
    'report_alias_duplicate_total', (
      select pg_catalog.count(*)
      from report_alias_duplicates duplicate
      where not exists (
        select 1
        from onsite_ranked onsite
        where onsite.identity_key = duplicate.identity_key
          and onsite.onsite_rank = 1
      )
    ),
    'headcount_total', (
      select pg_catalog.count(*) from headcount_issue_keys
    ),
    'issue_total',
      (select pg_catalog.count(*) from visible_issues)
      + (select pg_catalog.count(*) from schedule_backfill_issues),
    'onsite_total', (
      select pg_catalog.count(*)
      from onsite_ranked onsite
      where onsite.onsite_rank = 1
    )
  )
  into v_summary;

  if v_view = 'summary' then
    v_total := 0;
    v_page := 1;
    v_rows := '[]'::jsonb;

  elsif v_view = 'issues' then
    with
    scope_ids as materialized (
      select scoped.employee_id
      from public.admin_scope_effective_employee_ids(v_user_id) scoped
    ),
    scoped_employees as materialized (
      select employee.id, employee.employee_no, employee.full_name,
        employee.status, employee.source_type, employee.employment_type
      from scope_ids scope
      join public.employees employee on employee.id = scope.employee_id
      where nullif(
          public.employee_master_normalize_id(employee.employee_no),
          ''
        ) is not null
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and public.employee_master_normalize_id(employee.employee_no)
          not like 'TEST%'
        and coalesce(employee.source_type, '') <> 'google_deleted'
    ),
    schedule_raw as materialized (
      select
        public.employee_master_normalize_id(entry.item->>'employee_id')
          employee_key,
        nullif(pg_catalog.btrim(entry.item->>'name_key'), '') name_key,
        nullif(pg_catalog.btrim(entry.item->>'name'), '') source_name,
        case
          when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
            then (entry.item->>'source_row')::integer
          else null::integer
        end source_row,
        pg_catalog.lower(coalesce(entry.item->>'onsite_marker', 'false'))
          in ('true', '1', 'yes') source_onsite_marker,
        employee_private.resolve_confirmed_employee_id(
          entry.item->>'employee_id'
        ) employee_id
      from pg_catalog.jsonb_array_elements(v_schedule_payload)
        entry(item)
    ),
    schedule_identity_rollup as materialized (
      select
        source.employee_id,
        pg_catalog.min(source.source_row) schedule_source_row,
        pg_catalog.min(source.source_name) schedule_name,
        pg_catalog.bool_or(
          source.source_onsite_marker
          or coalesce(
            override.override_kind in (
              'confirmed_onsite',
              'managed_external'
            ),
            false
          )
        ) accepted_onsite
      from schedule_raw source
      join scoped_employees employee on employee.id = source.employee_id
      left join employee_private.employee_master_roster_overrides override
        on override.active = true
       and override.employee_no = source.employee_key
       and override.expected_name_key = source.name_key
      group by source.employee_id
    ),
    accepted_schedule_keys as materialized (
      select distinct source.employee_key
      from schedule_raw source
      left join employee_private.employee_master_roster_overrides override
        on override.active = true
       and override.employee_no = source.employee_key
       and override.expected_name_key = source.name_key
      where source.source_onsite_marker
         or override.override_kind in ('confirmed_onsite', 'managed_external')
    ),
    persisted as materialized (
      select
        'issue:' || issue.id::text row_key,
        issue.id::text issue_id,
        issue.issue_code,
        coalesce(
          nullif(pg_catalog.btrim(issue.details->>'reason'), ''),
          issue.issue_code
        ) reason_code,
        resolved.employee_id,
        coalesce(employee.employee_no, issue.employee_no) employee_no,
        coalesce(
          employee.full_name,
          nullif(pg_catalog.btrim(issue.details->>'schedule_name'), ''),
          nullif(pg_catalog.btrim(issue.details->>'home_name'), '')
        ) full_name,
        employee.status,
        issue.home_source_row,
        issue.schedule_source_row,
        nullif(pg_catalog.btrim(issue.details->>'home_name'), '') home_name,
        nullif(pg_catalog.btrim(issue.details->>'schedule_name'), '')
          schedule_name,
        nullif(pg_catalog.btrim(issue.details->>'action'), '') action,
        case
          when coalesce(issue.details->>'missing_streak', '') ~ '^[0-9]+$'
            then (issue.details->>'missing_streak')::integer
          else null::integer
        end missing_streak,
        'needs_review'::text diagnostic_status,
        issue.created_at detected_at
      from public.employee_master_sync_issues issue
      left join lateral (
        select employee_private.resolve_confirmed_employee_id(
          issue.employee_no
        ) employee_id
      ) resolved on true
      left join public.employees employee on employee.id = resolved.employee_id
      left join scope_ids scope on scope.employee_id = resolved.employee_id
      where issue.run_id = v_run_id
        and (
          (resolved.employee_id is not null and scope.employee_id is not null)
          or (resolved.employee_id is null and v_all_scope)
        )
        and not (
          issue.issue_code = 'schedule_only_missing_onsite_marker'
          and (
            exists (
              select 1
              from schedule_identity_rollup rollup
              where rollup.employee_id = resolved.employee_id
                and rollup.accepted_onsite
            )
            or exists (
              select 1
              from accepted_schedule_keys accepted
              where accepted.employee_key =
                public.employee_master_normalize_id(issue.employee_no)
            )
          )
        )
    ),
    synthetic_backfill as materialized (
      select
        'backfill:' || rollup.employee_id::text row_key,
        null::text issue_id,
        'schedule_backfill_requires_review'::text issue_code,
        'schedule_backfill_requires_review'::text reason_code,
        rollup.employee_id,
        employee.employee_no,
        employee.full_name,
        employee.status,
        null::integer home_source_row,
        rollup.schedule_source_row,
        null::text home_name,
        rollup.schedule_name,
        'confirm_onsite_or_add_to_home_master'::text action,
        null::integer missing_streak,
        'needs_review'::text diagnostic_status,
        v_run_finished_at detected_at
      from schedule_identity_rollup rollup
      join scoped_employees employee on employee.id = rollup.employee_id
      where employee.source_type = 'schedule_only'
        and employee.employment_type = '排班补录'
        and not rollup.accepted_onsite
    ),
    combined as materialized (
      select * from persisted
      union all
      select * from synthetic_backfill
    ),
    filtered as materialized (
      select issue.*
      from combined issue
      where (v_issue_filter = ''
          or pg_catalog.lower(issue.issue_code) = v_issue_filter)
        and (v_reason_filter = ''
          or pg_catalog.lower(issue.reason_code) = v_reason_filter)
        and (v_status_filter = ''
          or pg_catalog.lower(coalesce(issue.status, '')) = v_status_filter)
        and (v_search = '' or pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.concat_ws(' ',
            issue.employee_no,
            issue.full_name,
            issue.issue_code,
            issue.reason_code,
            issue.home_name,
            issue.schedule_name,
            issue.action
          )),
          v_search
        ) > 0)
    ),
    totals as materialized (
      select pg_catalog.count(*)::bigint total from filtered
    ),
    page_control as materialized (
      select least(
        v_page,
        greatest(
          1,
          pg_catalog.ceil(total::numeric / v_page_size)::integer
        )
      ) page
      from totals
    ),
    paged as materialized (
      select issue.*
      from filtered issue
      order by issue.detected_at desc nulls last,
        issue.issue_code,
        issue.employee_no nulls last,
        issue.row_key
      limit v_page_size
      offset ((select page from page_control) - 1) * v_page_size
    )
    select
      totals.total,
      page_control.page,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'row_key', issue.row_key,
            'issue_id', issue.issue_id,
            'issue_code', issue.issue_code,
            'reason_code', issue.reason_code,
            'employee_id', issue.employee_id,
            'employee_no', issue.employee_no,
            'full_name', issue.full_name,
            'status', issue.status,
            'home_source_row', issue.home_source_row,
            'schedule_source_row', issue.schedule_source_row,
            'home_name', issue.home_name,
            'schedule_name', issue.schedule_name,
            'action', issue.action,
            'missing_streak', issue.missing_streak,
            'diagnostic_status', issue.diagnostic_status,
            'detected_at', issue.detected_at
          )
          order by issue.detected_at desc nulls last,
            issue.issue_code,
            issue.employee_no nulls last,
            issue.row_key
        )
        from paged issue
      ), '[]'::jsonb)
    into v_total, v_page, v_rows
    from totals
    cross join page_control;

  elsif v_view = 'headcount' then
    with
    scope_ids as materialized (
      select scoped.employee_id
      from public.admin_scope_effective_employee_ids(v_user_id) scoped
    ),
    scoped_employees as materialized (
      select
        employee.id,
        employee.employee_no,
        employee.full_name,
        employee.status,
        employee.hire_date,
        employee.resign_date,
        employee.source_type,
        employee.employment_type
      from scope_ids scope
      join public.employees employee on employee.id = scope.employee_id
      where nullif(public.employee_master_normalize_id(
          employee.employee_no
        ), '') is not null
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
        and public.employee_master_normalize_id(employee.employee_no)
          not like 'TEST%'
        and coalesce(employee.source_type, '') <> 'google_deleted'
    ),
    scope_report_employee_keys as materialized (
      select distinct pg_catalog.upper(pg_catalog.btrim(employee.employee_no))
        employee_key
      from scope_ids scope
      join public.employees employee on employee.id = scope.employee_id
      where nullif(pg_catalog.btrim(employee.employee_no), '') is not null
    ),
    schedule_raw as materialized (
      select
        public.employee_master_normalize_id(entry.item->>'employee_id')
          employee_key,
        nullif(pg_catalog.btrim(entry.item->>'name_key'), '') name_key,
        nullif(pg_catalog.btrim(entry.item->>'name'), '') source_name,
        case
          when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
            then (entry.item->>'source_row')::integer
          else null::integer
        end source_row,
        pg_catalog.lower(coalesce(entry.item->>'onsite_marker', 'false'))
          in ('true', '1', 'yes') source_onsite_marker,
        employee_private.resolve_confirmed_employee_id(
          entry.item->>'employee_id'
        ) employee_id
      from pg_catalog.jsonb_array_elements(v_schedule_payload)
        entry(item)
    ),
    schedule_visible as materialized (
      select source.*,
        coalesce(source.employee_id::text, 'raw:' || source.employee_key)
          identity_key
      from schedule_raw source
      left join scope_ids scope on scope.employee_id = source.employee_id
      where nullif(source.employee_key, '') is not null
        and (
          (source.employee_id is not null and scope.employee_id is not null)
          or (source.employee_id is null and v_all_scope)
        )
    ),
    schedule_set as materialized (
      select distinct on (source.identity_key) source.*
      from schedule_visible source
      order by source.identity_key, source.source_row nulls last
    ),
    accepted_onsite_keys as materialized (
      select distinct source.identity_key
      from schedule_visible source
      left join employee_private.employee_master_roster_overrides override
        on override.active = true
       and override.employee_no = source.employee_key
       and override.expected_name_key = source.name_key
      where source.source_onsite_marker
         or override.override_kind in (
           'confirmed_onsite',
           'managed_external'
         )
    ),
    report_raw as materialized (
      select
        pg_catalog.upper(pg_catalog.btrim(coalesce(
          entry.item->>'employee_id',
          ''
        ))) report_scope_key,
        public.employee_master_normalize_id(
          coalesce(entry.item->>'employee_id', entry.item->>'employee_no')
        ) employee_key,
        pg_catalog.lower(pg_catalog.btrim(pg_catalog.regexp_replace(
          pg_catalog.translate(
            normalize(pg_catalog.btrim(coalesce(
              entry.item->>'name',
              entry.item->>'full_name',
              ''
            )), NFKC),
            U&'\200B\200C\200D\2060\FEFF',
            ''
          ),
          '[[:space:]]+',
          ' ',
          'g'
        ))) name_key,
        nullif(pg_catalog.btrim(coalesce(
          entry.item->>'name',
          entry.item->>'full_name'
        )), '') source_name,
        case
          when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
            then (entry.item->>'source_row')::integer
          else null::integer
        end source_row,
        employee_private.resolve_confirmed_employee_id(
          coalesce(entry.item->>'employee_id', entry.item->>'employee_no')
        ) employee_id
      from pg_catalog.jsonb_array_elements(v_report_payload) entry(item)
    ),
    report_visible as materialized (
      select report.*,
        case
          when nullif(report.employee_key, '') is not null
            then 'id:' || report.employee_key
          when nullif(report.name_key, '') is not null
            then 'name:' || report.name_key
          else null::text
        end person_key,
        case
          when report.employee_id is not null then report.employee_id::text
          when nullif(report.employee_key, '') is not null
            then 'raw:' || report.employee_key
          when nullif(report.name_key, '') is not null
            then 'report-name:' || report.name_key
          else null::text
        end identity_key
      from report_raw report
      where v_all_scope
         or exists (
           select 1
           from scope_report_employee_keys scoped_key
           where scoped_key.employee_key = report.report_scope_key
         )
    ),
    report_set as materialized (
      select distinct on (report.identity_key) report.*
      from report_visible report
      where report.identity_key is not null
      order by report.identity_key, report.source_row nulls last
    ),
    report_alias_duplicates as materialized (
      select
        report.identity_key,
        report.identity_key::uuid employee_id,
        pg_catalog.count(distinct report.person_key)::integer
          report_identity_count,
        pg_catalog.jsonb_agg(
          distinct pg_catalog.substr(report.person_key, 4)
          order by pg_catalog.substr(report.person_key, 4)
        ) report_person_keys,
        pg_catalog.min(report.source_row) source_row
      from report_visible report
      where report.employee_id is not null
        and report.person_key is not null
      group by report.identity_key
      having pg_catalog.count(distinct report.person_key) > 1
    ),
    home_raw as materialized (
      select
        public.employee_master_normalize_id(entry.item->>'employee_id')
          employee_key,
        nullif(pg_catalog.btrim(entry.item->>'name'), '') source_name,
        case
          when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
            then (entry.item->>'source_row')::integer
          else null::integer
        end source_row,
        employee_private.resolve_confirmed_employee_id(
          entry.item->>'employee_id'
        ) employee_id
      from pg_catalog.jsonb_array_elements(v_home_payload) entry(item)
      where pg_catalog.lower(coalesce(
        entry.item->>'explicitly_resigned',
        'false'
      )) not in ('true', '1', 'yes')
    ),
    home_visible as materialized (
      select source.*,
        coalesce(source.employee_id::text, 'raw:' || source.employee_key)
          identity_key
      from home_raw source
      left join scope_ids scope on scope.employee_id = source.employee_id
      where nullif(source.employee_key, '') is not null
        and (
          (source.employee_id is not null and scope.employee_id is not null)
          or (source.employee_id is null and v_all_scope)
        )
    ),
    home_set as materialized (
      select distinct on (source.identity_key) source.*
      from home_visible source
      order by source.identity_key, source.source_row nulls last
    ),
    directory_raw as materialized (
      select
        public.employee_master_normalize_id(directory.employee_no)
          employee_key,
        nullif(pg_catalog.btrim(directory.full_name), '') source_name,
        directory.source_row,
        employee_private.resolve_confirmed_employee_id(
          directory.employee_no
        ) employee_id
      from public.report_employee_directory_cache directory
      where directory.source_kind = 'roster'
    ),
    directory_visible as materialized (
      select directory.*,
        coalesce(directory.employee_id::text, 'raw:' || directory.employee_key)
          identity_key
      from directory_raw directory
      left join scope_ids scope on scope.employee_id = directory.employee_id
      where nullif(directory.employee_key, '') is not null
        and (
          (directory.employee_id is not null and scope.employee_id is not null)
          or (directory.employee_id is null and v_all_scope)
        )
    ),
    directory_set as materialized (
      select distinct on (directory.identity_key) directory.*
      from directory_visible directory
      order by directory.identity_key, directory.source_row nulls last
    ),
    effective_set as materialized (
      select employee.id employee_id, employee.id::text identity_key
      from scoped_employees employee
      where pg_catalog.lower(pg_catalog.btrim(coalesce(employee.status, '')))
          in ('active', 'probation', '在职', '试用')
        and (employee.hire_date is null or employee.hire_date <= v_today)
    ),
    strict_directory as materialized (
      select directory.employee_id
      from scope_private.current_employee_scope_directory() directory
      join scope_ids scope on scope.employee_id = directory.employee_id
    ),
    employee_page_set as materialized (
      select effective.employee_id, effective.identity_key
      from strict_directory directory
      join effective_set effective
        on effective.employee_id = directory.employee_id
    ),
    identities as materialized (
      select effective.identity_key from effective_set effective
      union
      select employee_page.identity_key
      from employee_page_set employee_page
      union
      select directory.identity_key from directory_set directory
      union
      select report.identity_key from report_set report
    ),
    membership as materialized (
      select
        identity.identity_key,
        coalesce(
          effective.employee_id,
          employee_page.employee_id,
          directory.employee_id,
          report.employee_id,
          schedule.employee_id
        ) employee_id,
        effective.identity_key is not null in_effective_active,
        employee_page.identity_key is not null in_employee_page,
        directory.identity_key is not null in_directory,
        report.identity_key is not null in_report,
        schedule.identity_key is not null in_schedule_source,
        home.identity_key is not null in_home_source,
        coalesce(
          directory.source_row,
          report.source_row,
          schedule.source_row
        ) source_row,
        coalesce(
          directory.source_name,
          report.source_name,
          schedule.source_name,
          home.source_name
        ) source_name
      from identities identity
      left join effective_set effective
        on effective.identity_key = identity.identity_key
      left join employee_page_set employee_page
        on employee_page.identity_key = identity.identity_key
      left join directory_set directory
        on directory.identity_key = identity.identity_key
      left join report_set report
        on report.identity_key = identity.identity_key
      left join schedule_set schedule
        on schedule.identity_key = identity.identity_key
      left join home_set home
        on home.identity_key = identity.identity_key
    ),
    membership_differences as materialized (
      select
        member.identity_key,
        'headcount:' || member.identity_key row_key,
        member.employee_id,
        coalesce(
          employee.employee_no,
          directory.employee_key,
          report.employee_key,
          schedule.employee_key
        ) employee_no,
        coalesce(employee.full_name, member.source_name) full_name,
        employee.status,
        employee.hire_date,
        employee.resign_date,
        case
          when member.in_effective_active
            and not member.in_directory
            and not member.in_report
            then 'effective_active_missing_directory_report'
          when not member.in_effective_active
            and member.in_directory
            and member.in_report
            and employee.hire_date > v_today
            then 'future_hire_in_directory_report'
          when not member.in_effective_active
            and member.in_directory
            and member.in_report
            and pg_catalog.lower(pg_catalog.btrim(
              coalesce(employee.status, '')
            )) in ('resigned', '离职')
            then 'resigned_in_directory_report'
          when member.in_effective_active <> member.in_employee_page
            then 'employee_page_effective_membership_mismatch'
          when member.in_directory <> member.in_report
            then 'directory_report_membership_mismatch'
          else 'page_headcount_membership_mismatch'
        end reason_code,
        case
          when member.in_effective_active
            and not member.in_directory
            and not member.in_report
            then '今日有效在职，但员工页、当前目录和汇总表都没有'
          when not member.in_effective_active
            and member.in_directory
            and member.in_report
            and employee.hire_date > v_today
            then '当前目录和汇总表已有，但入职日期尚未生效'
          when not member.in_effective_active
            and member.in_directory
            and member.in_report
            and pg_catalog.lower(pg_catalog.btrim(
              coalesce(employee.status, '')
            )) in ('resigned', '离职')
            then '员工主档已离职，但当前目录和汇总表仍存在'
          when member.in_effective_active <> member.in_employee_page
            then '今日有效在职与员工档案页当前组织目录不一致'
          when member.in_directory <> member.in_report
            then '当前排班目录与汇总表的人员集合不一致'
          else '四个人数页面的人员集合不一致'
        end reason_label,
        member.in_effective_active,
        member.in_employee_page,
        member.in_home_source,
        member.in_report,
        member.in_schedule_source,
        member.in_directory,
        member.source_row,
        employee.source_type,
        employee.employment_type,
        null::integer report_identity_count,
        '[]'::jsonb report_person_keys
      from membership member
      left join scoped_employees employee on employee.id = member.employee_id
      left join directory_set directory
        on directory.identity_key = member.identity_key
      left join report_set report
        on report.identity_key = member.identity_key
      left join schedule_set schedule
        on schedule.identity_key = member.identity_key
      where not (
        member.in_effective_active
        and member.in_employee_page
        and member.in_directory
        and member.in_report
      )
        and not exists (
          select 1
          from accepted_onsite_keys onsite
          where onsite.identity_key = member.identity_key
        )
        -- Preloaded future hires are intentionally visible in source totals,
        -- but do not belong in today's actionable personnel differences.
        and not (
          employee.hire_date is not null
          and employee.hire_date > v_today
        )
    ),
    alias_duplicate_rows as materialized (
      select
        duplicate.identity_key,
        'headcount:' || duplicate.identity_key row_key,
        duplicate.employee_id,
        employee.employee_no,
        employee.full_name,
        employee.status,
        employee.hire_date,
        employee.resign_date,
        'report_alias_duplicate_collapsed'::text reason_code,
        '汇总表同时含旧/新ID，页面原始口径重复计数'::text
          reason_label,
        member.in_effective_active,
        member.in_employee_page,
        member.in_home_source,
        member.in_report,
        member.in_schedule_source,
        member.in_directory,
        coalesce(duplicate.source_row, member.source_row) source_row,
        employee.source_type,
        employee.employment_type,
        duplicate.report_identity_count,
        duplicate.report_person_keys
      from report_alias_duplicates duplicate
      join membership member
        on member.identity_key = duplicate.identity_key
      join scoped_employees employee
        on employee.id = duplicate.employee_id
      where not exists (
        select 1
        from accepted_onsite_keys onsite
        where onsite.identity_key = duplicate.identity_key
      )
        and not (
          employee.hire_date is not null
          and employee.hire_date > v_today
        )
    ),
    combined_differences as materialized (
      select 1::integer priority, duplicate.*
      from alias_duplicate_rows duplicate
      union all
      select 2::integer priority, membership.*
      from membership_differences membership
    ),
    differences as materialized (
      select distinct on (candidate.identity_key) candidate.*
      from combined_differences candidate
      order by candidate.identity_key, candidate.priority
    ),
    filtered as materialized (
      select difference.*
      from differences difference
      where (v_reason_filter = ''
          or pg_catalog.lower(difference.reason_code) = v_reason_filter)
        and (v_status_filter = ''
          or pg_catalog.lower(coalesce(difference.status, '')) =
            v_status_filter)
        and (v_search = '' or pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.concat_ws(' ',
            difference.employee_no,
            difference.full_name,
            difference.reason_code,
            difference.reason_label,
            difference.status,
            difference.source_type,
            difference.employment_type,
            difference.report_person_keys::text
          )),
          v_search
        ) > 0)
    ),
    totals as materialized (
      select pg_catalog.count(*)::bigint total from filtered
    ),
    page_control as materialized (
      select least(
        v_page,
        greatest(
          1,
          pg_catalog.ceil(total::numeric / v_page_size)::integer
        )
      ) page
      from totals
    ),
    paged as materialized (
      select difference.*
      from filtered difference
      order by difference.reason_code,
        difference.employee_no nulls last,
        difference.row_key
      limit v_page_size
      offset ((select page from page_control) - 1) * v_page_size
    )
    select
      totals.total,
      page_control.page,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'row_key', difference.row_key,
            'employee_id', difference.employee_id,
            'employee_no', difference.employee_no,
            'full_name', difference.full_name,
            'status', difference.status,
            'hire_date', difference.hire_date,
            'resign_date', difference.resign_date,
            'reason_code', difference.reason_code,
            'reason_label', difference.reason_label,
            'in_effective_active', difference.in_effective_active,
            'in_dashboard', difference.in_effective_active,
            'in_employee_page', difference.in_employee_page,
            'in_report', difference.in_report,
            'in_home_source', difference.in_home_source,
            'in_schedule_source', difference.in_schedule_source,
            'in_directory', difference.in_directory,
            'source_row', difference.source_row,
            'source_type', difference.source_type,
            'employment_type', difference.employment_type,
            'report_identity_count', difference.report_identity_count,
            'report_person_keys', difference.report_person_keys
          )
          order by difference.reason_code,
            difference.employee_no nulls last,
            difference.row_key
        )
        from paged difference
      ), '[]'::jsonb)
    into v_total, v_page, v_rows
    from totals
    cross join page_control;

  else
    with
    scope_ids as materialized (
      select scoped.employee_id
      from public.admin_scope_effective_employee_ids(v_user_id) scoped
    ),
    schedule_raw as materialized (
      select
        public.employee_master_normalize_id(entry.item->>'employee_id')
          employee_key,
        nullif(pg_catalog.btrim(entry.item->>'name_key'), '') name_key,
        nullif(pg_catalog.btrim(entry.item->>'name'), '') source_name,
        nullif(pg_catalog.btrim(entry.item->>'team'), '') source_team,
        nullif(pg_catalog.btrim(entry.item->>'position'), '') source_position,
        nullif(pg_catalog.btrim(entry.item->>'shift'), '') source_shift,
        case
          when coalesce(entry.item->>'source_row', '') ~ '^[0-9]+$'
            then (entry.item->>'source_row')::integer
          else null::integer
        end source_row,
        pg_catalog.lower(coalesce(entry.item->>'onsite_marker', 'false'))
          in ('true', '1', 'yes') source_onsite_marker,
        employee_private.resolve_confirmed_employee_id(
          entry.item->>'employee_id'
        ) employee_id
      from pg_catalog.jsonb_array_elements(v_schedule_payload)
        entry(item)
    ),
    candidates as materialized (
      select
        coalesce(source.employee_id::text, 'raw:' || source.employee_key)
          identity_key,
        source.employee_id,
        coalesce(employee.employee_no, source.employee_key) employee_no,
        coalesce(employee.full_name, source.source_name) full_name,
        coalesce(source.source_team, team.name) team,
        coalesce(source.source_position, position.name) position,
        coalesce(source.source_shift, employee.shift_name) shift,
        case
          when override.override_kind = 'confirmed_onsite'
            then 'confirmed_onsite'
          when override.override_kind = 'managed_external'
            then 'managed_external'
          else 'onsite_marker'
        end classification,
        source.source_row,
        case
          when override.override_kind = 'confirmed_onsite'
            then 'manual_confirmation'
          when override.override_kind = 'managed_external'
            then 'managed_external_approval'
          else 'source_sheet_marker'
        end confirmation,
        source.source_onsite_marker,
        override.override_kind = 'confirmed_onsite' confirmed_onsite,
        override.override_kind = 'managed_external' managed_external,
        false schedule_backfill,
        employee.status,
        pg_catalog.row_number() over (
          partition by coalesce(
            source.employee_id::text,
            'raw:' || source.employee_key
          )
          order by
            case override.override_kind
              when 'confirmed_onsite' then 1
              when 'managed_external' then 2
              else 3
            end,
            source.source_row nulls last
        ) candidate_rank
      from schedule_raw source
      left join public.employees employee on employee.id = source.employee_id
      left join public.teams team on team.id = employee.team_id
      left join public.positions position on position.id = employee.position_id
      left join scope_ids scope on scope.employee_id = source.employee_id
      left join employee_private.employee_master_roster_overrides override
        on override.active = true
       and override.employee_no = source.employee_key
       and override.expected_name_key = source.name_key
      where nullif(source.employee_key, '') is not null
        and (
          source.source_onsite_marker
          or override.override_kind in (
            'confirmed_onsite',
            'managed_external'
          )
        )
        and (
          (source.employee_id is not null and scope.employee_id is not null)
          or (source.employee_id is null and v_all_scope)
        )
    ),
    filtered as materialized (
      select candidate.*
      from candidates candidate
      where candidate.candidate_rank = 1
        and (v_classification_filter = ''
          or pg_catalog.lower(candidate.classification) =
            v_classification_filter)
        and (v_status_filter = ''
          or pg_catalog.lower(coalesce(candidate.status, '')) =
            v_status_filter)
        and (v_search = '' or pg_catalog.strpos(
          pg_catalog.lower(pg_catalog.concat_ws(' ',
            candidate.employee_no,
            candidate.full_name,
            candidate.team,
            candidate.position,
            candidate.shift,
            candidate.classification,
            candidate.confirmation
          )),
          v_search
        ) > 0)
    ),
    totals as materialized (
      select pg_catalog.count(*)::bigint total from filtered
    ),
    page_control as materialized (
      select least(
        v_page,
        greatest(
          1,
          pg_catalog.ceil(total::numeric / v_page_size)::integer
        )
      ) page
      from totals
    ),
    paged as materialized (
      select candidate.*
      from filtered candidate
      order by candidate.classification,
        candidate.employee_no,
        candidate.identity_key
      limit v_page_size
      offset ((select page from page_control) - 1) * v_page_size
    )
    select
      totals.total,
      page_control.page,
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'row_key', 'onsite:' || candidate.identity_key,
            'employee_id', candidate.employee_id,
            'employee_no', candidate.employee_no,
            'full_name', candidate.full_name,
            'team', candidate.team,
            'position', candidate.position,
            'shift', candidate.shift,
            'classification', candidate.classification,
            'source_row', candidate.source_row,
            'confirmation', candidate.confirmation,
            'source_onsite_marker', candidate.source_onsite_marker,
            'confirmed_onsite', candidate.confirmed_onsite,
            'managed_external', candidate.managed_external,
            'schedule_backfill', candidate.schedule_backfill,
            'status', candidate.status
          )
          order by candidate.classification,
            candidate.employee_no,
            candidate.identity_key
        )
        from paged candidate
      ), '[]'::jsonb)
    into v_total, v_page, v_rows
    from totals
    cross join page_control;
  end if;

  return pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'view', v_view,
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'pages', greatest(
      1,
      pg_catalog.ceil(v_total::numeric / v_page_size)::integer
    ),
    'page_size', v_page_size,
    'summary', v_summary,
    'freshness', v_freshness
  );
end;
$function$;

revoke all on function public.admin_personnel_reconciliation(
  text,
  jsonb,
  integer,
  integer
) from public, anon, authenticated, service_role;

grant execute on function public.admin_personnel_reconciliation(
  text,
  jsonb,
  integer,
  integer
) to authenticated;

comment on function public.admin_personnel_reconciliation(
  text,
  jsonb,
  integer,
  integer
) is
  'Current-admin-session, permission and employee-scope guarded reconciliation of the latest complete employee-master snapshot. Returns bounded headcount differences, persisted/synthetic review issues, or accepted onsite classifications without exposing raw snapshot JSON.';

notify pgrst, 'reload schema';

commit;
