create or replace function public.report_error_query_stats(p_filters jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with params as (
  select
    nullif(btrim(p_filters->>'date_from'), '')::date date_from,
    nullif(btrim(p_filters->>'date_to'), '')::date date_to,
    case when p_filters->>'date_basis' = 'review' then 'review' else 'qc' end date_basis,
    nullif(upper(btrim(p_filters->>'employee_id')), '') employee_id,
    nullif(lower(btrim(p_filters->>'employee_name')), '') employee_name,
    nullif(btrim(p_filters->>'employee_status'), '') employee_status,
    nullif(btrim(p_filters->>'risk_level'), '') risk_level,
    nullif(btrim(p_filters->>'error_type'), '') error_type,
    nullif(btrim(p_filters->>'qc_person'), '') qc_person,
    nullif(btrim(p_filters->>'shift'), '') shift_name,
    nullif(btrim(p_filters->>'team'), '') team_name,
    nullif(btrim(p_filters->>'group'), '') group_name,
    nullif(btrim(p_filters->>'position'), '') position_name,
    nullif(btrim(p_filters->>'country'), '') country_name,
    nullif(lower(btrim(p_filters->>'manager')), '') manager_name,
    nullif(btrim(p_filters->>'platform'), '') platform_name
), filtered as materialized (
  select v.*
  from public.report_employee_error_admin_v v
  cross join params p
  where (p.date_from is null or (case when p.date_basis = 'review' then v.review_basis_date else v.qc_date end) >= p.date_from)
    and (p.date_to is null or (case when p.date_basis = 'review' then v.review_basis_date else v.qc_date end) <= p.date_to)
    and (p.employee_id is null or v.employee_id like '%' || p.employee_id || '%')
    and (p.employee_name is null or lower(v.name) like '%' || p.employee_name || '%')
    and (p.employee_status is null or v.employee_status = p.employee_status)
    and (p.risk_level is null or v.risk_level = p.risk_level)
    and (p.error_type is null or v.error_type = p.error_type)
    and (p.qc_person is null or v.qc_person = p.qc_person)
    and (p.shift_name is null or v.shift = p.shift_name)
    and (p.team_name is null or v.team = p.team_name)
    and (p.group_name is null or v.group_name = p.group_name)
    and (p.position_name is null or v.position = p.position_name)
    and (p.country_name is null or v.country = p.country_name)
    and (p.manager_name is null or lower(v.manager_search) like '%' || p.manager_name || '%')
    and (p.platform_name is null or v.platform = p.platform_name)
), options as (
  select jsonb_build_object(
    'error_types', coalesce((select jsonb_agg(value order by value) from (select distinct error_type value from public.report_employee_error_rows where error_type is not null) x), '[]'::jsonb),
    'qc_people', coalesce((select jsonb_agg(value order by value) from (select distinct qc_person value from public.report_employee_error_rows where qc_person is not null) x), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(value order by value) from (select distinct shift value from public.report_employee_error_admin_v where shift <> '-') x), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(value order by value) from (select distinct team value from public.report_employee_error_admin_v where team <> '-') x), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(value order by value) from (select distinct group_name value from public.report_employee_error_admin_v where group_name <> '-') x), '[]'::jsonb),
    'positions', coalesce((select jsonb_agg(value order by value) from (select distinct position value from public.report_employee_error_admin_v where position <> '-') x), '[]'::jsonb),
    'countries', coalesce((select jsonb_agg(value order by value) from (select distinct country value from public.report_employee_error_admin_v where country <> '-') x), '[]'::jsonb),
    'managers', coalesce((select jsonb_agg(value order by value) from (
      select distinct unnest(array_remove(array[d.responsible,d.onsite_trainer,d.online_leader,d.online_trainer], null)) value
      from public.report_employee_directory_cache d
    ) x where nullif(btrim(value), '') is not null), '[]'::jsonb),
    'platforms', coalesce((select jsonb_agg(value order by value) from (select distinct platform value from public.report_employee_error_admin_v where platform <> '-') x), '[]'::jsonb)
  ) value
)
select jsonb_build_object(
  'total', count(*),
  'period_counts', jsonb_build_object(
    'month', count(*) filter (where qc_date >= date_trunc('month', current_date)::date and qc_date <= current_date),
    'last_3d', count(*) filter (where qc_date between current_date - 2 and current_date),
    'last_7d', count(*) filter (where qc_date between current_date - 6 and current_date),
    'last_30d', count(*) filter (where qc_date between current_date - 29 and current_date),
    'total', count(*),
    'as_of', current_date
  ),
  'source_raw_count', (select count(*) from public.report_employee_error_rows),
  'source_normalized_count', (select count(distinct record_key) from public.report_employee_error_rows),
  'source_synced_at', (select max(synced_at) from public.report_employee_error_rows),
  'available_from', (select min(qc_date) from public.report_employee_error_rows),
  'available_to', (select max(qc_date) from public.report_employee_error_rows),
  'options', (select value from options)
)
from filtered;
$$;

revoke all on function public.report_error_query_stats(jsonb) from public, anon, authenticated;
grant execute on function public.report_error_query_stats(jsonb) to service_role;
