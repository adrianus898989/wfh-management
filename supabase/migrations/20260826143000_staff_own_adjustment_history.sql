-- Staff reward/deduction history is exposed through a dedicated self-only RPC.
-- It never accepts an employee id from the browser; identity comes from the
-- current authenticated staff session.

create or replace function public.staff_own_adjustment_history(
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_context record;
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_total bigint := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;

  select * into v_context from public.exam_staff_context();
  if v_context.employee_id is null then raise exception 'staff_profile_unavailable'; end if;

  select count(*)
  into v_total
  from public.employee_attendance_records record
  where record.employee_id = v_context.employee_id
    and record.kind = 'adjustment'
    and not record.is_mirror;

  select coalesce(jsonb_agg(to_jsonb(row_data)
    order by row_data.event_date desc nulls last, row_data.id desc), '[]'::jsonb)
  into v_rows
  from (
    select
      record.id,
      record.event_date,
      record.event_kind,
      record.amount,
      record.currency,
      record.reason,
      record.note,
      source.source_name,
      record.synced_at
    from public.employee_attendance_records record
    join public.attendance_sheet_sources source on source.id = record.source_id
    where record.employee_id = v_context.employee_id
      and record.kind = 'adjustment'
      and not record.is_mirror
    order by record.event_date desc nulls last, record.id desc
    limit v_page_size offset (v_page - 1) * v_page_size
  ) row_data;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

revoke all on function public.staff_own_adjustment_history(integer, integer)
  from public, anon;
grant execute on function public.staff_own_adjustment_history(integer, integer)
  to authenticated, service_role;

comment on function public.staff_own_adjustment_history(integer, integer) is
  'Returns only the current staff member own canonical bonus and deduction history.';

notify pgrst, 'reload schema';
