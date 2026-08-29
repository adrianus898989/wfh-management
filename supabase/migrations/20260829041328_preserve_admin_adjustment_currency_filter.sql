-- The granular attendance/adjustment wrapper intentionally whitelists client
-- filters before it reaches attendance_private.admin_attendance_home(). Keep
-- the existing scope override, while preserving the already-supported search
-- and adjustment currency keys so the UI and currency summaries use the same
-- filtered row set.
create or replace function public.admin_attendance_page_filters(
  p_filters jsonb,
  p_forced jsonb
)
returns jsonb
language sql
immutable
set search_path=''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'search',p_filters->'search',
    'employee_no',p_filters->'employee_no',
    'employee_name',p_filters->'employee_name',
    'full_name',p_filters->'full_name',
    'status',p_filters->'status',
    'employee_status',p_filters->'employee_status',
    'source_group',p_filters->'source_group',
    'team',p_filters->'team',
    'position',p_filters->'position',
    'country',p_filters->'country',
    'platform',p_filters->'platform',
    'manager',p_filters->'manager',
    'event_kind',p_filters->'event_kind',
    'currency',p_filters->'currency',
    'match_status',p_filters->'match_status',
    'date_from',p_filters->'date_from',
    'date_to',p_filters->'date_to',
    'page',p_filters->'page',
    'page_size',p_filters->'page_size'
  )) || coalesce(p_forced,'{}'::jsonb)
     || jsonb_build_object('include_mirrors',false);
$$;

revoke all on function public.admin_attendance_page_filters(jsonb,jsonb)
  from public,anon,authenticated;

comment on function public.admin_attendance_page_filters(jsonb,jsonb) is
  'Whitelists admin attendance filters; forced page scope wins and adjustment currency/search are preserved.';
