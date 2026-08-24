-- The combined view already derives legacy answer counts from the retained
-- legacy_exam_answers rows.  Keep the paged search RPC on that same source of
-- truth so the list does not incorrectly label every old result as summary-only.

create or replace function public.admin_exam_sessions_search_v3(
  p_employee_no text default '',
  p_employee_name text default '',
  p_exam text default '',
  p_team text default '',
  p_position text default '',
  p_status text default '',
  p_grader text default '',
  p_source text default '',
  p_date_from date default null,
  p_date_to date default null,
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
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if not public.exam_is_admin('exam.view') then
    raise exception '没有考试查看权限';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  with filtered as materialized (
    select u.*
    from public.admin_exam_combined_sessions_v u
    where session_private.exam_employee_in_scope(u.employee_id)
      and (btrim(coalesce(p_employee_no, '')) = ''
        or u.employee_no ilike '%' || btrim(p_employee_no) || '%')
      and (btrim(coalesce(p_employee_name, '')) = ''
        or u.employee_name ilike '%' || btrim(p_employee_name) || '%')
      and (btrim(coalesce(p_exam, '')) = ''
        or u.title ilike '%' || btrim(p_exam) || '%')
      and (btrim(coalesce(p_team, '')) = ''
        or public.exam_norm(u.team_name) = public.exam_norm(p_team))
      and (btrim(coalesce(p_position, '')) = ''
        or public.exam_norm(u.position_name) = public.exam_norm(p_position))
      and (
        btrim(coalesce(p_status, '')) = ''
        or (p_status = 'pending' and u.status in ('submitted', 'grading'))
        or u.status = p_status
      )
      and (btrim(coalesce(p_grader, '')) = ''
        or u.grader_name ilike '%' || btrim(p_grader) || '%')
      and (
        btrim(coalesce(p_source, '')) = ''
        or p_source = 'all'
        or u.source_system = p_source
      )
      and (p_date_from is null
        or coalesce(u.submitted_at, u.started_at)::date >= p_date_from)
      and (p_date_to is null
        or coalesce(u.submitted_at, u.started_at)::date <= p_date_to)
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(to_jsonb(x) - 'sort_at' order by x.sort_at desc)
      from (
        select f.*, coalesce(f.submitted_at, f.started_at) sort_at
        from filtered f
        order by coalesce(f.submitted_at, f.started_at) desc
        limit v_size offset (v_page - 1) * v_size
      ) x
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', v_page,
    'page_size', v_size
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_exam_sessions_search_v3(
  text, text, text, text, text, text, text, text, date, date, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_exam_sessions_search_v3(
  text, text, text, text, text, text, text, text, date, date, integer, integer
) to authenticated;

notify pgrst, 'reload schema';
