begin;

-- Synchronization diagnostics are generated from the small, persisted import
-- ledgers.  This endpoint never calls Google and never compares full sheets at
-- page-read time, so opening the warning centre cannot compete with login or
-- employee-directory traffic.
insert into public.permissions(code,name,category,sensitive)
values ('alert.sync_diagnostics.view','查看同步差异与原因','alert',true)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

create or replace function public.admin_sync_diagnostics(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
set lock_timeout = '500ms'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_role_code text;
  v_scope text;
  v_caller_employee_id uuid;
  v_latest_run_id bigint;
  v_kind text := pg_catalog.left(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_filters->>'kind','all'))),
    32
  );
  v_issue_code text := pg_catalog.left(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_filters->>'issue_code',''))),
    100
  );
  v_search text := pg_catalog.left(
    pg_catalog.lower(pg_catalog.btrim(coalesce(p_filters->>'search',''))),
    160
  );
  v_page integer := least(greatest(coalesce(p_page,1),1),1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size,20),1),50);
  v_total bigint := 0;
  v_summary jsonb := '{}'::jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('alert.view')
     or not public.has_permission('alert.sync_diagnostics.view') then
    raise exception 'permission_denied';
  end if;
  if v_kind not in ('all','employee_master','attendance') then
    raise exception 'invalid_diagnostic_kind';
  end if;

  select role.code, access.data_scope, access.employee_id
  into v_role_code, v_scope, v_caller_employee_id
  from public.user_access access
  join public.roles role on role.id=access.role_id
  where access.auth_user_id=v_user_id
    and access.active=true
    and access.backend_enabled=true
  order by access.updated_at desc
  limit 1;
  if v_role_code is null then raise exception 'permission_denied'; end if;

  -- A successful run owns the current issue snapshot.  An unchanged run does
  -- not duplicate issues, so selecting max(success) avoids a false empty page.
  select pg_catalog.max(run.id) into v_latest_run_id
  from public.employee_master_sync_runs run
  where run.status='success';

  with master_visible as materialized (
    select
      'employee_master'::text diagnostic_kind,
      issue.id::text diagnostic_id,
      issue.issue_code,
      employee.id employee_id,
      coalesce(employee.employee_no,issue.employee_no) employee_no,
      employee.full_name employee_name,
      null::text source_name,
      null::text source_month,
      issue.home_source_row,
      issue.schedule_source_row,
      jsonb_strip_nulls(jsonb_build_object(
        'home_name',issue.details->>'home_name',
        'schedule_name',issue.details->>'schedule_name',
        'reason',issue.details->>'reason',
        'action',issue.details->>'action',
        'missing_streak',issue.details->'missing_streak',
        'source_rows',case
          when jsonb_typeof(issue.details->'source_rows')='array' then
            jsonb_path_query_array(
              issue.details->'source_rows',
              '$[*] ? (@.type() == "number")'
            )
          else null
        end,
        'row_count',issue.details->'row_count',
        'status_source',issue.details->>'status_source'
      )) details,
      issue.created_at detected_at
    from public.employee_master_sync_issues issue
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)
       = public.employee_master_normalize_id(issue.employee_no)
    left join public.user_scope_employees scoped
      on scoped.auth_user_id=v_user_id and scoped.employee_id=employee.id
    where issue.run_id=v_latest_run_id
      and (
        v_role_code='founder' or v_scope='all'
        or (v_scope='self' and employee.id=v_caller_employee_id)
        or (v_scope in ('own_team','assigned_teams') and scoped.employee_id is not null)
      )
  ), source_visible as materialized (
    select
      'attendance'::text diagnostic_kind,
      source.id::text diagnostic_id,
      case
        when source.status='failed' then 'source_sync_failed'
        when source.status='partial' then 'source_sync_partial'
        when source.error_count>0 then 'source_error_rows'
        when source.ambiguous_count>0 then 'source_ambiguous_identity'
        when source.unmatched_count>0 then 'source_unmatched_identity'
        else 'source_parse_warning'
      end issue_code,
      null::uuid employee_id,
      null::text employee_no,
      null::text employee_name,
      source.source_name,
      source.source_month,
      null::integer home_source_row,
      null::integer schedule_source_row,
      jsonb_strip_nulls(jsonb_build_object(
        'status',source.status,
        'row_count',source.row_count,
        'matched_count',source.matched_count,
        'unmatched_count',source.unmatched_count,
        'ambiguous_count',source.ambiguous_count,
        'skipped_count',source.skipped_count,
        'error_count',source.error_count,
        'parse_warning_count',
          case when coalesce(source.metadata->>'parse_warning_count','') ~ '^[0-9]+$'
            then (source.metadata->>'parse_warning_count')::integer else 0 end,
        'error_message',nullif(pg_catalog.left(coalesce(source.error_message,''),300),''),
        'source_group',source.source_group,
        'synced_at',source.synced_at
      )) details,
      coalesce(source.synced_at,source.updated_at) detected_at
    from public.attendance_sheet_sources source
    where source.is_active=true
      and (v_role_code='founder' or v_scope='all')
      and (source.source_month is null
        or source.source_month <= pg_catalog.to_char(current_date,'YYYY-MM'))
      and (
        source.status in ('failed','partial')
        or source.error_count>0
        or source.ambiguous_count>0
        or source.unmatched_count>0
        or (coalesce(source.metadata->>'parse_warning_count','') ~ '^[0-9]+$'
          and (source.metadata->>'parse_warning_count')::integer>0)
      )
  ), combined as materialized (
    select * from master_visible
    union all
    select * from source_visible
  ), filtered as materialized (
    select * from combined diagnostic
    where (v_kind='all' or diagnostic.diagnostic_kind=v_kind)
      and (v_issue_code='' or diagnostic.issue_code=v_issue_code)
      and (v_search='' or pg_catalog.lower(pg_catalog.concat_ws(' ',
        diagnostic.employee_no,diagnostic.employee_name,diagnostic.issue_code,
        diagnostic.source_name,diagnostic.source_month,diagnostic.details::text
      )) like '%'||v_search||'%')
  )
  select pg_catalog.count(*) into v_total from filtered;

  with master_visible as materialized (
    select issue.issue_code, employee.id employee_id
    from public.employee_master_sync_issues issue
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)
       = public.employee_master_normalize_id(issue.employee_no)
    left join public.user_scope_employees scoped
      on scoped.auth_user_id=v_user_id and scoped.employee_id=employee.id
    where issue.run_id=v_latest_run_id and (
      v_role_code='founder' or v_scope='all'
      or (v_scope='self' and employee.id=v_caller_employee_id)
      or (v_scope in ('own_team','assigned_teams') and scoped.employee_id is not null)
    )
  ), issue_counts as (
    select issue_code,pg_catalog.count(*) count from master_visible group by issue_code
  ), source_counts as (
    select
      pg_catalog.count(*) filter (where source.status in ('failed','partial')) problem_sources,
      coalesce(pg_catalog.sum(source.unmatched_count),0) unmatched_count,
      coalesce(pg_catalog.sum(source.ambiguous_count),0) ambiguous_count,
      coalesce(pg_catalog.sum(source.error_count),0) error_count,
      pg_catalog.max(source.synced_at) latest_synced_at
    from public.attendance_sheet_sources source
    where source.is_active=true
      and (v_role_code='founder' or v_scope='all')
      and (source.source_month is null
        or source.source_month <= pg_catalog.to_char(current_date,'YYYY-MM'))
  )
  select jsonb_build_object(
    'latest_employee_master_run',(
      select jsonb_strip_nulls(jsonb_build_object(
        'id',run.id,'status',run.status,'captured_at',run.captured_at,
        'finished_at',run.finished_at,'home_rows',run.home_roster_row_count,
        'schedule_rows',run.schedule_roster_row_count,'inserted',run.inserted_count,
        'updated',run.updated_count,'rekeyed',run.rekeyed_count,
        'warning_count',run.warning_count
      )) from public.employee_master_sync_runs run where run.id=v_latest_run_id
    ),
    'employee_issue_total',(select pg_catalog.count(*) from master_visible),
    'employee_issue_counts',coalesce((
      select jsonb_object_agg(issue_code,count order by issue_code) from issue_counts
    ),'{}'::jsonb),
    'attendance',(select to_jsonb(source_counts) from source_counts)
  ) into v_summary;

  with master_visible as materialized (
    select
      'employee_master'::text diagnostic_kind,issue.id::text diagnostic_id,
      issue.issue_code,employee.id employee_id,
      coalesce(employee.employee_no,issue.employee_no) employee_no,
      employee.full_name employee_name,null::text source_name,null::text source_month,
      issue.home_source_row,issue.schedule_source_row,
      jsonb_strip_nulls(jsonb_build_object(
        'home_name',issue.details->>'home_name','schedule_name',issue.details->>'schedule_name',
        'reason',issue.details->>'reason','action',issue.details->>'action',
        'missing_streak',issue.details->'missing_streak',
        'source_rows',case
          when jsonb_typeof(issue.details->'source_rows')='array' then
            jsonb_path_query_array(
              issue.details->'source_rows',
              '$[*] ? (@.type() == "number")'
            )
          else null
        end,
        'row_count',issue.details->'row_count','status_source',issue.details->>'status_source'
      )) details,issue.created_at detected_at
    from public.employee_master_sync_issues issue
    left join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no)
       = public.employee_master_normalize_id(issue.employee_no)
    left join public.user_scope_employees scoped
      on scoped.auth_user_id=v_user_id and scoped.employee_id=employee.id
    where issue.run_id=v_latest_run_id and (
      v_role_code='founder' or v_scope='all'
      or (v_scope='self' and employee.id=v_caller_employee_id)
      or (v_scope in ('own_team','assigned_teams') and scoped.employee_id is not null)
    )
  ), source_visible as materialized (
    select 'attendance'::text diagnostic_kind,source.id::text diagnostic_id,
      case when source.status='failed' then 'source_sync_failed'
        when source.status='partial' then 'source_sync_partial'
        when source.error_count>0 then 'source_error_rows'
        when source.ambiguous_count>0 then 'source_ambiguous_identity'
        when source.unmatched_count>0 then 'source_unmatched_identity'
        else 'source_parse_warning' end issue_code,
      null::uuid employee_id,null::text employee_no,null::text employee_name,
      source.source_name,source.source_month,null::integer home_source_row,
      null::integer schedule_source_row,
      jsonb_strip_nulls(jsonb_build_object(
        'status',source.status,'row_count',source.row_count,'matched_count',source.matched_count,
        'unmatched_count',source.unmatched_count,'ambiguous_count',source.ambiguous_count,
        'skipped_count',source.skipped_count,'error_count',source.error_count,
        'parse_warning_count',case when coalesce(source.metadata->>'parse_warning_count','') ~ '^[0-9]+$'
          then (source.metadata->>'parse_warning_count')::integer else 0 end,
        'error_message',nullif(pg_catalog.left(coalesce(source.error_message,''),300),''),
        'source_group',source.source_group,'synced_at',source.synced_at
      )) details,coalesce(source.synced_at,source.updated_at) detected_at
    from public.attendance_sheet_sources source
    where source.is_active=true and (v_role_code='founder' or v_scope='all')
      and (source.source_month is null or source.source_month<=pg_catalog.to_char(current_date,'YYYY-MM'))
      and (source.status in ('failed','partial') or source.error_count>0 or source.ambiguous_count>0
        or source.unmatched_count>0 or (coalesce(source.metadata->>'parse_warning_count','') ~ '^[0-9]+$'
          and (source.metadata->>'parse_warning_count')::integer>0))
  ), combined as materialized (
    select * from master_visible union all select * from source_visible
  ), filtered as materialized (
    select * from combined diagnostic where (v_kind='all' or diagnostic.diagnostic_kind=v_kind)
      and (v_issue_code='' or diagnostic.issue_code=v_issue_code)
      and (v_search='' or pg_catalog.lower(pg_catalog.concat_ws(' ',diagnostic.employee_no,
        diagnostic.employee_name,diagnostic.issue_code,diagnostic.source_name,
        diagnostic.source_month,diagnostic.details::text)) like '%'||v_search||'%')
  ), paged as (
    select diagnostic.diagnostic_kind,diagnostic.diagnostic_id,
      diagnostic.issue_code,diagnostic.employee_no,diagnostic.employee_name,
      diagnostic.source_name,diagnostic.source_month,
      diagnostic.home_source_row,diagnostic.schedule_source_row,
      diagnostic.details,diagnostic.detected_at
    from filtered diagnostic
    order by diagnostic.detected_at desc nulls last,
      diagnostic.diagnostic_kind,diagnostic.diagnostic_id
    limit v_page_size offset (v_page-1)*v_page_size
  )
  select coalesce(jsonb_agg(to_jsonb(paged)),'[]'::jsonb) into v_rows from paged;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_page_size,
    'pages',greatest(1,pg_catalog.ceil(v_total::numeric/v_page_size)::integer),
    'summary',v_summary
  );
end;
$$;

revoke all on function public.admin_sync_diagnostics(jsonb,integer,integer)
  from public,anon;
grant execute on function public.admin_sync_diagnostics(jsonb,integer,integer)
  to authenticated,service_role;

comment on function public.admin_sync_diagnostics(jsonb,integer,integer) is
  'Permission- and employee-scope checked, bounded view of persisted employee-master and attendance import discrepancies. Never reads Google or performs full-sheet comparison.';

commit;
