-- Keep exam records and answer detail inside the caller's canonical employee scope.
-- Legacy sessions without an employee match are visible only to Founder/all-scope users.

create or replace function session_private.exam_employee_in_scope(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_scope text;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  if public.is_founder() then return true; end if;

  select ua.data_scope
  into v_scope
  from public.user_access ua
  where ua.auth_user_id=v_user_id
    and ua.active=true
    and ua.backend_enabled=true
  order by ua.updated_at desc
  limit 1;

  if v_scope='all' then return true; end if;
  if p_employee_id is null then return false; end if;
  return public.can_manage_employee(p_employee_id);
end;
$$;

revoke all on function session_private.exam_employee_in_scope(uuid)
  from public,anon,authenticated;

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
set search_path=''
as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
  v_result jsonb;
begin
  if not public.exam_is_admin('exam.view') then
    raise exception '没有考试查看权限';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  with current_rows as materialized (
    select s.id,s.employee_id,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,
      s.attempt_no,s.status,s.started_at,s.submitted_at,s.graded_at,s.earned_score,s.total_score,s.percentage,s.passed,
      coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
      count(ans.id) filter(where ans.grade_status='correct')::integer correct_count,
      count(ans.id) filter(where ans.grade_status='partial')::integer partial_count,
      count(ans.id) filter(where ans.grade_status='wrong')::integer wrong_count,
      count(ans.id) filter(where ans.grade_status is null)::integer pending_count,
      'current'::text source_system,'本系统'::text source_label,'matched'::text employee_match_status,false read_only
    from public.exam_sessions s
    join public.employees e on e.id=s.employee_id
    join public.exam_assignments a on a.id=s.assignment_id
    left join public.user_access ua on ua.auth_user_id=s.graded_by
    left join public.exam_answers ans on ans.session_id=s.id
    where session_private.exam_employee_in_scope(s.employee_id)
    group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,ua.login_username,ua.login_email
  ), legacy_rows as materialized (
    select l.id,l.employee_id,coalesce(e.employee_no,l.employee_no,'—') employee_no,
      coalesce(e.full_name,l.employee_name,'未匹配员工') employee_name,
      concat_ws(' · ',nullif(l.series_name,''),nullif(l.position_name,''))||' 考试' title,
      coalesce(t.name,'未匹配团队') team_name,coalesce(p.name,l.position_name,'—') position_name,
      l.attempt_no,l.status,l.started_at,l.submitted_at,l.graded_at,l.earned_score,l.total_score,l.percentage,l.passed,
      '旧系统'::text grader_name,
      coalesce(l.correct_count,0)::integer correct_count,0::integer partial_count,
      greatest(coalesce(l.total_questions,0)-coalesce(l.correct_count,0),0)::integer wrong_count,
      case when l.status in ('submitted','in_progress') then coalesce(l.total_questions,0) else 0 end::integer pending_count,
      'legacy'::text source_system,'旧考试'::text source_label,l.employee_match_status,true read_only
    from public.legacy_exam_sessions l
    left join public.employees e on e.id=l.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    where session_private.exam_employee_in_scope(l.employee_id)
  ), filtered as materialized (
    select * from (
      select * from current_rows union all select * from legacy_rows
    ) u
    where (btrim(coalesce(p_employee_no,''))='' or u.employee_no ilike '%'||btrim(p_employee_no)||'%')
      and (btrim(coalesce(p_employee_name,''))='' or u.employee_name ilike '%'||btrim(p_employee_name)||'%')
      and (btrim(coalesce(p_exam,''))='' or u.title ilike '%'||btrim(p_exam)||'%')
      and (btrim(coalesce(p_team,''))='' or public.exam_norm(u.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(u.position_name)=public.exam_norm(p_position))
      and (btrim(coalesce(p_status,''))='' or (p_status='pending' and u.status in ('submitted','grading')) or u.status=p_status)
      and (btrim(coalesce(p_grader,''))='' or u.grader_name ilike '%'||btrim(p_grader)||'%')
      and (btrim(coalesce(p_source,''))='' or p_source='all' or u.source_system=p_source)
      and (p_date_from is null or coalesce(u.submitted_at,u.started_at)::date>=p_date_from)
      and (p_date_to is null or coalesce(u.submitted_at,u.started_at)::date<=p_date_to)
  )
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_at desc) from (
      select f.*,coalesce(f.submitted_at,f.started_at) sort_at from filtered f
      order by coalesce(f.submitted_at,f.started_at) desc
      limit v_size offset (v_page-1)*v_size
    ) x),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'page',v_page,'page_size',v_size
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_exam_session_detail(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path='public','auth'
as $$
declare
  v_employee_id uuid;
begin
  if not public.exam_is_admin('exam.view') and not public.exam_is_admin('exam.grade') then
    raise exception '没有考试查看权限';
  end if;

  select s.employee_id into v_employee_id
  from public.exam_sessions s where s.id=p_session_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not session_private.exam_employee_in_scope(v_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select s.*,e.employee_no,e.full_name employee_name,a.title,a.team_name,a.position_name,a.pass_score,
             coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name,
             count(ans.id) filter(where ans.grade_status='correct') correct_count,
             count(ans.id) filter(where ans.grade_status='partial') partial_count,
             count(ans.id) filter(where ans.grade_status='wrong') wrong_count,
             count(ans.id) filter(where ans.grade_status is null) pending_count
      from public.exam_sessions s
      join public.employees e on e.id=s.employee_id
      join public.exam_assignments a on a.id=s.assignment_id
      left join public.user_access ua on ua.auth_user_id=s.graded_by
      left join public.exam_answers ans on ans.session_id=s.id
      where s.id=p_session_id
      group by s.id,e.employee_no,e.full_name,a.title,a.team_name,a.position_name,a.pass_score,ua.login_username,ua.login_email
    ) x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.ordinality),'[]'::jsonb) from (
      select j.ordinality,j.item->>'id' question_id,j.item->>'external_key' external_key,
        j.item->>'question_en' question_en,j.item->>'question_zh' question_zh,j.item->>'question_vi' question_vi,
        (j.item->>'points')::numeric points,coalesce(j.item->'image_urls','[]'::jsonb) image_urls,
        ans.id answer_id,coalesce(ans.answer_text,'') answer_text,coalesce(ans.attachments,'[]'::jsonb) attachments,
        ans.grade_status,ans.awarded_score,ans.grader_feedback,ans.graded_at,
        coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—') grader_name
      from public.exam_sessions s
      cross join lateral jsonb_array_elements(s.question_snapshot) with ordinality j(item,ordinality)
      left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(j.item->>'id')::uuid
      left join public.user_access ua on ua.auth_user_id=ans.graded_by
      where s.id=p_session_id
    ) x)
  );
end;
$$;

create or replace function public.admin_legacy_exam_session_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_id uuid;
begin
  if not public.exam_is_admin('exam.view') then
    raise exception '没有考试查看权限';
  end if;

  select l.employee_id into v_employee_id
  from public.legacy_exam_sessions l where l.id=p_session_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not session_private.exam_employee_in_scope(v_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;

  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select * from public.admin_exam_combined_sessions_v
      where id=p_session_id and source_system='legacy'
    ) x),
    'answers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.answered_at,x.answer_id),'[]'::jsonb) from (
      select a.id answer_id,a.source_question_id question_id,
        coalesce(nullif(a.question_snapshot->>'question_zh',''),nullif(a.question_snapshot->>'question',''),
          '旧考试题目 · '||coalesce(a.source_question_id::text,'无题目ID')) question_zh,
        coalesce(a.question_snapshot->>'question_en','') question_en,
        coalesce(a.question_snapshot->>'question_vi','') question_vi,
        coalesce(a.question_points,0) points,a.answer_text,a.grade_status,a.awarded_score,
        a.feedback grader_feedback,
        coalesce(a.question_snapshot->'image_urls','[]'::jsonb)
          ||coalesce(a.attachments,'[]'::jsonb)
          ||coalesce(a.feedback_images,'[]'::jsonb) image_urls,
        a.answered_at,a.graded_at,'旧系统' grader_name,true read_only
      from public.legacy_exam_answers a
      where a.legacy_session_id=p_session_id
    ) x)
  );
end;
$$;

revoke all on function public.admin_exam_sessions_search_v3(
  text,text,text,text,text,text,text,text,date,date,integer,integer
) from public,anon,authenticated;
revoke all on function public.admin_exam_session_detail(uuid)
  from public,anon,authenticated;
revoke all on function public.admin_legacy_exam_session_detail(uuid)
  from public,anon,authenticated;

grant execute on function public.admin_exam_sessions_search_v3(
  text,text,text,text,text,text,text,text,date,date,integer,integer
) to authenticated;
grant execute on function public.admin_exam_session_detail(uuid) to authenticated;
grant execute on function public.admin_legacy_exam_session_detail(uuid) to authenticated;

notify pgrst,'reload schema';
