-- Apply the split employee/platform/manager search fields before the roster
-- JSON crosses the API boundary.  The scoped implementation remains the sole
-- source of rows; this wrapper only narrows its already-authorized result.

alter function public.admin_attendance_schedule(jsonb)
  rename to admin_attendance_schedule_scoped_internal;

revoke all on function public.admin_attendance_schedule_scoped_internal(jsonb)
  from public, anon, authenticated;

create or replace function public.admin_attendance_schedule(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(
    p_filters->>'employee_name', p_filters->>'full_name', '')));
  v_platform text := btrim(coalesce(p_filters->>'platform', ''));
  v_manager text := lower(btrim(coalesce(
    p_filters->>'manager', p_filters->>'responsible', '')));
  v_base jsonb;
  v_rows jsonb := '[]'::jsonb;
begin
  -- This internal call performs current-session, permission and data-scope
  -- checks before returning any row to this filter layer.
  v_base := public.admin_attendance_schedule_scoped_internal(p_filters);

  select coalesce(jsonb_agg(source.item order by source.ordinal), '[]'::jsonb)
  into v_rows
  from jsonb_array_elements(coalesce(v_base->'rows', '[]'::jsonb))
    with ordinality source(item, ordinal)
  where (v_employee_no = '' or lower(coalesce(source.item->>'employee_no', ''))
      like '%' || v_employee_no || '%')
    and (v_employee_name = '' or lower(coalesce(source.item->>'full_name', ''))
      like '%' || v_employee_name || '%')
    and (v_platform = '' or public.exam_norm(source.item->>'platform_name')
      = public.exam_norm(v_platform))
    and (v_manager = '' or lower(concat_ws(' ',
      source.item->>'responsible',
      source.item->>'onsite_trainer',
      source.item->>'online_leader',
      source.item->>'online_trainer'
    )) like '%' || v_manager || '%');

  return v_base || jsonb_build_object(
    'total', jsonb_array_length(v_rows),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'day', count(*) filter(where item->>'shift_bucket'='day'),
        'mid', count(*) filter(where item->>'shift_bucket'='mid'),
        'night', count(*) filter(where item->>'shift_bucket'='night'),
        'other', count(*) filter(where coalesce(item->>'shift_bucket','other')='other'),
        'teams', count(distinct item->>'team_name')
          filter(where nullif(btrim(item->>'team_name'),'') is not null),
        'matched', count(*) filter(where coalesce((item->>'employee_matched')::boolean,false)),
        'unmatched', count(*) filter(where not coalesce((item->>'employee_matched')::boolean,false)),
        'active', count(*) filter(where lower(item->>'employee_status')='active'),
        'resigned', count(*) filter(where lower(item->>'employee_status')='resigned')
      )
      from jsonb_array_elements(v_rows) item
    ),
    'rows', v_rows
  );
end;
$$;

revoke all on function public.admin_attendance_schedule(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_attendance_schedule(jsonb)
  to authenticated;

comment on function public.admin_attendance_schedule(jsonb) is
  'Current-session/data-scope checked schedule roster with split detailed filters applied server-side.';

notify pgrst,'reload schema';
