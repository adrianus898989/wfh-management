-- Keep the error report summary below the PostgREST statement timeout.
-- The previous SQL function materialized every wide error column and planned
-- optional filters generically, while its filter options repeatedly expanded
-- report_employee_error_admin_v.

create or replace function public.report_error_query_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date_from date := nullif(btrim(p_filters->>'date_from'), '')::date;
  v_date_to date := nullif(btrim(p_filters->>'date_to'), '')::date;
  v_date_column text := case
    when p_filters->>'date_basis' = 'review' then 'review_basis_date'
    else 'qc_date'
  end;
  v_employee_id text := nullif(upper(btrim(p_filters->>'employee_id')), '');
  v_employee_name text := nullif(lower(btrim(p_filters->>'employee_name')), '');
  v_employee_status text := nullif(btrim(p_filters->>'employee_status'), '');
  v_risk_level text := nullif(btrim(p_filters->>'risk_level'), '');
  v_error_type text := nullif(btrim(p_filters->>'error_type'), '');
  v_qc_person text := nullif(btrim(p_filters->>'qc_person'), '');
  v_shift_name text := nullif(btrim(p_filters->>'shift'), '');
  v_team_name text := nullif(btrim(p_filters->>'team'), '');
  v_group_name text := nullif(btrim(p_filters->>'group'), '');
  v_position_name text := nullif(btrim(p_filters->>'position'), '');
  v_country_name text := nullif(btrim(p_filters->>'country'), '');
  v_manager_name text := nullif(lower(btrim(p_filters->>'manager')), '');
  v_platform_name text := nullif(btrim(p_filters->>'platform'), '');
  v_where text := 'where true';
  v_filtered jsonb;
  v_source jsonb;
  v_directory jsonb;
begin
  -- Build only predicates that are active. Literal quoting keeps the dynamic
  -- statement injection-safe and gives PostgreSQL a filter-specific plan.
  if v_date_from is not null then
    v_where := v_where || format(' and v.%I >= %L::date', v_date_column, v_date_from);
  end if;
  if v_date_to is not null then
    v_where := v_where || format(' and v.%I <= %L::date', v_date_column, v_date_to);
  end if;
  if v_employee_id is not null then
    v_where := v_where || format(' and v.employee_id like %L', '%' || v_employee_id || '%');
  end if;
  if v_employee_name is not null then
    v_where := v_where || format(' and lower(v.name) like %L', '%' || v_employee_name || '%');
  end if;
  if v_employee_status is not null then
    v_where := v_where || format(' and v.employee_status = %L', v_employee_status);
  end if;
  if v_risk_level is not null then
    v_where := v_where || format(' and v.risk_level = %L', v_risk_level);
  end if;
  if v_error_type is not null then
    v_where := v_where || format(' and v.error_type = %L', v_error_type);
  end if;
  if v_qc_person is not null then
    v_where := v_where || format(' and v.qc_person = %L', v_qc_person);
  end if;
  if v_shift_name is not null then
    v_where := v_where || format(' and v.shift = %L', v_shift_name);
  end if;
  if v_team_name is not null then
    v_where := v_where || format(' and v.team = %L', v_team_name);
  end if;
  if v_group_name is not null then
    v_where := v_where || format(' and v.group_name = %L', v_group_name);
  end if;
  if v_position_name is not null then
    v_where := v_where || format(' and v.position = %L', v_position_name);
  end if;
  if v_country_name is not null then
    v_where := v_where || format(' and v.country = %L', v_country_name);
  end if;
  if v_manager_name is not null then
    v_where := v_where || format(' and lower(v.manager_search) like %L', '%' || v_manager_name || '%');
  end if;
  if v_platform_name is not null then
    v_where := v_where || format(' and v.platform = %L', v_platform_name);
  end if;

  execute format($query$
    select jsonb_build_object(
      'total', count(*),
      'period_counts', jsonb_build_object(
        'month', count(*) filter (
          where qc_date >= date_trunc('month', current_date)::date
            and qc_date <= current_date
        ),
        'last_3d', count(*) filter (where qc_date between current_date - 2 and current_date),
        'last_7d', count(*) filter (where qc_date between current_date - 6 and current_date),
        'last_30d', count(*) filter (where qc_date between current_date - 29 and current_date),
        'total', count(*),
        'as_of', current_date
      )
    )
    from (
      -- The summary needs only qc_date. Never materialize the wide notes/actions.
      select v.qc_date
      from public.report_employee_error_admin_v v
      %s
    ) filtered
  $query$, v_where)
  into v_filtered;

  -- Source metadata and source-backed filter values share one table scan.
  select jsonb_build_object(
    'source_raw_count', count(*),
    'source_normalized_count', count(distinct record_key),
    'source_synced_at', max(synced_at),
    'available_from', min(qc_date),
    'available_to', max(qc_date),
    'error_types', coalesce(
      jsonb_agg(distinct error_type order by error_type)
        filter (where error_type is not null),
      '[]'::jsonb
    ),
    'qc_people', coalesce(
      jsonb_agg(distinct qc_person order by qc_person)
        filter (where qc_person is not null),
      '[]'::jsonb
    )
  )
  into v_source
  from public.report_employee_error_rows;

  -- Organizational options come from one cached-directory materialization,
  -- rather than repeatedly expanding the deduplicated error view.
  with directory_rows as materialized (
    select
      d.shift_name,
      d.team_name,
      d.group_name,
      d.position_name,
      d.country_name,
      d.platform_name,
      d.responsible,
      d.onsite_trainer,
      d.online_leader,
      d.online_trainer,
      exists (
        select 1
        from public.report_employee_error_rows e
        where e.employee_no = d.employee_no
      ) has_error
    from public.report_employee_directory_cache d
  ), directory_options as (
    select
      coalesce(
        jsonb_agg(distinct shift_name order by shift_name)
          filter (where has_error and nullif(btrim(shift_name), '') is not null),
        '[]'::jsonb
      ) shifts,
      coalesce(
        jsonb_agg(distinct team_name order by team_name)
          filter (where has_error and nullif(btrim(team_name), '') is not null),
        '[]'::jsonb
      ) teams,
      coalesce(
        jsonb_agg(distinct group_name order by group_name)
          filter (where has_error and nullif(btrim(group_name), '') is not null),
        '[]'::jsonb
      ) groups,
      coalesce(
        jsonb_agg(distinct position_name order by position_name)
          filter (where has_error and nullif(btrim(position_name), '') is not null),
        '[]'::jsonb
      ) positions,
      coalesce(
        jsonb_agg(distinct country_name order by country_name)
          filter (where has_error and nullif(btrim(country_name), '') is not null),
        '[]'::jsonb
      ) countries,
      coalesce(
        jsonb_agg(distinct platform_name order by platform_name)
          filter (where has_error and nullif(btrim(platform_name), '') is not null),
        '[]'::jsonb
      ) platforms
    from directory_rows
  ), manager_options as (
    select coalesce(jsonb_agg(value order by value), '[]'::jsonb) managers
    from (
      select distinct unnest(array_remove(array[
        d.responsible,
        d.onsite_trainer,
        d.online_leader,
        d.online_trainer
      ], null)) value
      from directory_rows d
    ) values_from_directory
    where nullif(btrim(value), '') is not null
  )
  select jsonb_build_object(
    'shifts', d.shifts,
    'teams', d.teams,
    'groups', d.groups,
    'positions', d.positions,
    'countries', d.countries,
    'managers', m.managers,
    'platforms', d.platforms
  )
  into v_directory
  from directory_options d
  cross join manager_options m;

  return jsonb_build_object(
    'total', v_filtered->'total',
    'period_counts', v_filtered->'period_counts',
    'source_raw_count', v_source->'source_raw_count',
    'source_normalized_count', v_source->'source_normalized_count',
    'source_synced_at', v_source->'source_synced_at',
    'available_from', v_source->'available_from',
    'available_to', v_source->'available_to',
    'options', jsonb_build_object(
      'error_types', v_source->'error_types',
      'qc_people', v_source->'qc_people',
      'shifts', v_directory->'shifts',
      'teams', v_directory->'teams',
      'groups', v_directory->'groups',
      'positions', v_directory->'positions',
      'countries', v_directory->'countries',
      'managers', v_directory->'managers',
      'platforms', v_directory->'platforms'
    )
  );
end;
$$;

revoke all on function public.report_error_query_stats(jsonb)
  from public, anon, authenticated;
grant execute on function public.report_error_query_stats(jsonb)
  to service_role;

comment on function public.report_error_query_stats(jsonb) is
  'Returns error-report counts, source metadata and filter options with filter-specific plans and narrow aggregates.';
