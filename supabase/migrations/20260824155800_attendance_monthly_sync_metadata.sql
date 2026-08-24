-- Return the selected month's Google -> Supabase status with the monthly grid,
-- while keeping the underlying private reader inaccessible to direct callers.

create or replace function public.admin_attendance_monthly(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_month text;
begin
  -- This function performs current-session, permission and data-scope checks.
  v_result := attendance_private.admin_attendance_monthly(p_filters);
  v_month := coalesce(v_result->>'month', btrim(p_filters->>'month'));

  return v_result || jsonb_build_object(
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'source_key',s.source_key,
        'source_name',s.source_name,
        'source_group',s.source_group,
        'source_month',s.source_month,
        'status',s.status,
        'row_count',s.row_count,
        'matched_count',s.matched_count,
        'unmatched_count',s.unmatched_count,
        'synced_at',s.synced_at,
        'error_message',s.error_message
      ) order by s.source_group,s.source_name),'[]'::jsonb)
      from public.attendance_sheet_sources s
      where s.scope in ('attendance','mixed') and s.source_month=v_month
    ),
    'latest_sync', (
      select jsonb_build_object(
        'source_key',s.source_key,
        'source_name',s.source_name,
        'source_group',s.source_group,
        'source_month',s.source_month,
        'status',s.status,
        'row_count',s.row_count,
        'matched_count',s.matched_count,
        'unmatched_count',s.unmatched_count,
        'synced_at',s.synced_at,
        'error_message',s.error_message
      )
      from public.attendance_sheet_sources s
      where s.scope in ('attendance','mixed') and s.source_month=v_month
        and s.synced_at is not null
      order by s.synced_at desc,s.id desc
      limit 1
    )
  );
end;
$$;

revoke all on function attendance_private.admin_attendance_monthly(jsonb)
  from public,anon,authenticated;
revoke all on function public.admin_attendance_monthly(jsonb)
  from public,anon,authenticated;
grant execute on function public.admin_attendance_monthly(jsonb)
  to authenticated;

comment on function public.admin_attendance_monthly(jsonb) is
  'Scoped monthly attendance grid with selected-month private sheet sync status.';

notify pgrst,'reload schema';
