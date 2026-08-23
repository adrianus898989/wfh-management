-- Use the canonical Google Sheet snapshot for employee error history and expose
-- the already-mirrored legacy exam detail to the matching employee account.

create or replace view public.report_employee_errors_v
with (security_invoker=true)
as
select distinct on (x.record_key)
  x.record_key,
  x.source_row,
  x.employee_no,
  x.member_order,
  x.amount,
  x.error_note,
  x.correct_action,
  x.error_type,
  x.score,
  x.qc_person,
  x.qc_date,
  x.leader_review,
  x.qc_result,
  x.review_date,
  x.synced_at
from (
  select
    coalesce(nullif(item->>'record_key',''),concat_ws('|',upper(btrim(item->>'employee_id')),item->>'qc_date',item->>'source_row')) record_key,
    case when coalesce(item->>'source_row','')~'^\d+$' then (item->>'source_row')::integer end source_row,
    upper(btrim(item->>'employee_id')) employee_no,
    item->>'member_order' member_order,
    item->>'amount' amount,
    item->>'error_note' error_note,
    item->>'correct_action' correct_action,
    item->>'error_type' error_type,
    item->>'score' score,
    item->>'qc_person' qc_person,
    case when coalesce(item->>'qc_date','')~'^\d{4}-\d{2}-\d{2}$' then (item->>'qc_date')::date end qc_date,
    item->>'leader_review' leader_review,
    item->>'qc_result' qc_result,
    case when coalesce(item->>'review_date','')~'^\d{4}-\d{2}-\d{2}$' then (item->>'review_date')::date end review_date,
    c.synced_at
  from public.report_sheet_snapshot_chunks c
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(c.payload)='array' then c.payload else '[]'::jsonb end
  ) item
  where c.source='效率表/员工错误'
) x
where nullif(x.employee_no,'') is not null
order by x.record_key,x.synced_at desc,x.source_row desc nulls last;

revoke all on public.report_employee_errors_v from public,anon,authenticated;

create or replace function public.staff_portal_errors(p_page integer default 1,p_page_size integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  c record;
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),50);
  v_total bigint:=0;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select count(*) into v_total
  from public.report_employee_errors_v e
  where e.employee_no=upper(btrim(c.employee_no));

  return jsonb_build_object(
    'page',v_page,'page_size',v_size,'total',v_total,
    'pages',greatest(1,ceil(v_total::numeric/v_size)::integer),
    'rows',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last,x.source_row desc nulls last),'[]'::jsonb)
      from (
        select record_key,source_row,qc_date,error_type,error_note,correct_action,score,qc_person,
          leader_review,qc_result,review_date,member_order,amount,synced_at
        from public.report_employee_errors_v
        where employee_no=upper(btrim(c.employee_no))
        order by qc_date desc nulls last,source_row desc nulls last
        limit v_size offset (v_page-1)*v_size
      ) x)
  );
end;
$$;

revoke all on function public.staff_portal_errors(integer,integer) from public,anon;
grant execute on function public.staff_portal_errors(integer,integer) to authenticated;

create or replace function public.admin_employee_error_history(p_employee_id uuid,p_page integer default 1,p_page_size integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text;
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
  v_total bigint:=0;
begin
  if not (public.has_permission('employee.view') or public.has_permission('report.view') or public.exam_is_admin('exam.view')) then
    raise exception '没有员工档案查看权限';
  end if;
  select upper(btrim(e.employee_no)) into v_employee_no from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception '员工档案不存在'; end if;
  select count(*) into v_total from public.report_employee_errors_v e where e.employee_no=v_employee_no;
  return jsonb_build_object(
    'page',v_page,'page_size',v_size,'total',v_total,
    'pages',greatest(1,ceil(v_total::numeric/v_size)::integer),
    'rows',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last,x.source_row desc nulls last),'[]'::jsonb)
      from (
        select record_key,source_row,qc_date,error_type,error_note,correct_action,score,qc_person,
          leader_review,qc_result,review_date,member_order,amount,synced_at
        from public.report_employee_errors_v
        where employee_no=v_employee_no
        order by qc_date desc nulls last,source_row desc nulls last
        limit v_size offset (v_page-1)*v_size
      ) x)
  );
end;
$$;

revoke all on function public.admin_employee_error_history(uuid,integer,integer) from public,anon;
grant execute on function public.admin_employee_error_history(uuid,integer,integer) to authenticated;

create or replace function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_employee_no text;
  v_result jsonb;
begin
  if not (public.has_permission('employee.view') or public.exam_is_admin('exam.view')) then raise exception '没有员工档案查看权限'; end if;
  select e.employee_no into v_employee_no from public.employees e where e.id=p_employee_id;
  if v_employee_no is null then raise exception '员工档案不存在'; end if;

  with history as materialized (
    select u.*
    from public.admin_exam_combined_sessions_v u
    where u.employee_id=p_employee_id
       or (u.source_system='legacy' and public.exam_employee_no_key(u.employee_no)=public.exam_employee_no_key(v_employee_no))
  )
  select jsonb_build_object(
    'employee',(select to_jsonb(x) from(
      select e.id,e.employee_no,e.full_name,t.name team_name,p.name position_name
      from public.employees e left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id
      where e.id=p_employee_id
    )x),
    'summary',jsonb_build_object(
      'attempts',count(*),'graded',count(*) filter(where status='graded'),
      'passed',count(*) filter(where status='graded' and passed),
      'average',round(avg(percentage) filter(where status='graded'),1),
      'current_attempts',count(*) filter(where source_system='current'),
      'legacy_attempts',count(*) filter(where source_system='legacy'),
      'pending',count(*) filter(where status in('submitted','grading','in_progress'))
    ),
    'history',coalesce((select jsonb_agg(to_jsonb(x) order by x.started_at desc) from(
      select id,title,attempt_no,status,started_at,submitted_at,graded_at,earned_score,total_score,percentage,passed,
        grader_name,correct_count,partial_count,wrong_count,pending_count,source_system,source_label,read_only,
        team_name,position_name,series_name,answer_detail_available,answer_detail_count,scored_answer_count,
        zero_score_answer_count,total_question_count,unanswered_count
      from history order by started_at desc limit 200
    )x),'[]'::jsonb)
  ) into v_result
  from history;

  return coalesce(v_result,jsonb_build_object(
    'summary',jsonb_build_object('attempts',0,'graded',0,'passed',0,'average',null,'current_attempts',0,'legacy_attempts',0,'pending',0),
    'history','[]'::jsonb
  ));
end;
$$;

revoke all on function public.admin_employee_exam_history(uuid) from public,anon;
grant execute on function public.admin_employee_exam_history(uuid) to authenticated;

create or replace function public.staff_portal_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare c record;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  return jsonb_build_object(
    'profile',(select to_jsonb(x) from (
      select e.employee_no,e.full_name,e.country,e.nationality,e.employment_type,e.status,
        e.hire_date,e.group_name,e.platform_scope,e.work_content,e.shift_name,e.work_tg,e.work_account,
        e.leader_name,e.trainer_name,e.person_in_charge,e.online_leader,e.online_trainer,
        t.name team_name,p.name position_name
      from public.employees e left join public.teams t on t.id=e.team_id
      left join public.positions p on p.id=e.position_id where e.id=c.employee_id
    ) x),
    'payment',coalesce((select jsonb_build_object(
      'payment_mode',pp.payment_mode,'transfer_using',pp.transfer_using,'account_name',pp.gcash_name,
      'bank_account_masked',case when nullif(btrim(pp.gcash_account),'') is null then null when length(btrim(pp.gcash_account))<=6 then left(btrim(pp.gcash_account),1)||'****'||right(btrim(pp.gcash_account),1) else left(btrim(pp.gcash_account),4)||'****'||right(btrim(pp.gcash_account),4) end,
      'usdt_address_masked',case when nullif(btrim(pp.usdt_address),'') is null then null when length(btrim(pp.usdt_address))<=6 then left(btrim(pp.usdt_address),1)||'****'||right(btrim(pp.usdt_address),1) else left(btrim(pp.usdt_address),4)||'****'||right(btrim(pp.usdt_address),4) end,
      'contact_phone',pp.contact_phone,'whatsapp_number',pp.whatsapp_number,'facebook',pp.facebook,'employee_address',pp.employee_address
    ) from public.employee_payment_profiles pp where pp.employee_id=c.employee_id),'{}'::jsonb),
    'error_summary',coalesce((select to_jsonb(x) from (
      select month_error_count,last_30d_error_count,total_error_count,total_deduct,last_error_date,main_error_type,risk_level
      from public.employee_error_summary where upper(btrim(employee_no))=upper(btrim(c.employee_no)) order by updated_at desc limit 1
    ) x),'{}'::jsonb),
    'recent_errors',(select coalesce(jsonb_agg(to_jsonb(x) order by x.qc_date desc nulls last,x.source_row desc nulls last),'[]'::jsonb) from (
      select record_key,source_row,qc_date,error_type,error_note,correct_action,score,qc_person,leader_review,qc_result,review_date
      from public.report_employee_errors_v where employee_no=upper(btrim(c.employee_no))
      order by qc_date desc nulls last,source_row desc nulls last limit 12
    ) x),
    'exam_summary',(select jsonb_build_object(
      'total',count(*),'completed',count(*) filter(where status='graded'),
      'passed',count(*) filter(where status='graded' and passed),
      'average',coalesce(round(avg(percentage) filter(where status='graded'),1),0),
      'current',count(*) filter(where source_system='current'),
      'legacy',count(*) filter(where source_system='legacy'),
      'pending',count(*) filter(where status in('submitted','grading','in_progress'))
    ) from public.admin_exam_combined_sessions_v where employee_id=c.employee_id),
    'exam_history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select id,title,attempt_no,status,started_at,submitted_at,graded_at,earned_score,total_score,percentage,passed,
        grader_name,correct_count,partial_count,wrong_count,pending_count,source_system,source_label,
        answer_detail_available,answer_detail_count,total_question_count,unanswered_count
      from public.admin_exam_combined_sessions_v
      where employee_id=c.employee_id and status<>'in_progress'
      order by started_at desc limit 100
    ) x)
  );
end;
$$;

revoke all on function public.staff_portal_home() from public,anon;
grant execute on function public.staff_portal_home() to authenticated;

create or replace function public.staff_exam_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare c record; v_assignments jsonb:='[]'::jsonb;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联在职员工档案'; end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.pool_ready desc,x.position_name,x.series_name),'[]'::jsonb) into v_assignments
  from (
    select 'adaptive' id,concat(q.series_name,' · ',q.position_name,' 考试') title,
      c.team_name team_name,q.position_name,q.series_name,60 duration_minutes,60 pass_score,14 question_count,100 total_score,20 max_attempts,
      coalesce((select count(*) from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status<>'expired'
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)),0) attempts,
      (select s.id from public.exam_sessions s join public.exam_assignments a on a.id=s.assignment_id
        where s.employee_id=c.employee_id and s.auth_user_id=auth.uid() and s.status='in_progress' and s.expires_at>now()
          and public.exam_norm(a.team_name)=public.exam_norm(c.team_name)
          and public.exam_norm(a.position_name)=public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name)=public.exam_norm(q.series_name)
        order by s.started_at desc limit 1) resume_session_id,
      (count(*) filter(where q.points=5)>=10 and count(*) filter(where q.points=10)>=3 and count(*) filter(where q.points=20)>=1) pool_ready,
      jsonb_build_object('5',count(*) filter(where q.points=5),'10',count(*) filter(where q.points=10),'20',count(*) filter(where q.points=20)) pool_counts
    from public.exam_questions q
    where q.active and nullif(btrim(q.series_name),'') is not null
      and public.exam_norm(q.team_name)=public.exam_norm(c.team_name)
    group by q.position_name,q.series_name
  ) x;

  return jsonb_build_object(
    'profile',to_jsonb(c),'assignments',v_assignments,
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]'::jsonb) from (
      select id,title,attempt_no,status,started_at,submitted_at,graded_at,earned_score,total_score,percentage,passed,
        grader_name,correct_count,partial_count,wrong_count,pending_count,source_system,source_label,
        answer_detail_available,answer_detail_count,total_question_count,unanswered_count
      from public.admin_exam_combined_sessions_v
      where employee_id=c.employee_id and status<>'in_progress'
      order by started_at desc limit 100
    ) x)
  );
end;
$$;

revoke all on function public.staff_exam_home() from public,anon;
grant execute on function public.staff_exam_home() to authenticated;

create or replace function public.staff_exam_result_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare c record; v_source text;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select u.source_system into v_source
  from public.admin_exam_combined_sessions_v u
  where u.id=p_session_id and u.employee_id=c.employee_id and u.status<>'in_progress'
  order by case when u.source_system='current' then 0 else 1 end limit 1;
  if v_source is null then raise exception '无权查看该考试结果'; end if;

  if v_source='legacy' then
    return jsonb_build_object(
      'session',(select to_jsonb(x) from (
        select * from public.admin_exam_combined_sessions_v
        where id=p_session_id and employee_id=c.employee_id and source_system='legacy'
      ) x),
      'answers',(select coalesce(jsonb_agg(jsonb_build_object(
        'question',jsonb_build_object(
          'id',a.source_question_id,'question_zh',coalesce(nullif(a.question_snapshot->>'question_zh',''),nullif(a.question_snapshot->>'question','')),
          'question_en',a.question_snapshot->>'question_en','question_vi',a.question_snapshot->>'question_vi',
          'points',coalesce(a.question_points,0),
          'image_urls',coalesce(a.question_snapshot->'image_urls','[]'::jsonb)||coalesce(a.attachments,'[]'::jsonb)||coalesce(a.feedback_images,'[]'::jsonb)
        ),
        'answer_text',coalesce(a.answer_text,''),'awarded_score',a.awarded_score,'grade_status',a.grade_status,
        'grader_feedback',a.feedback,'graded_at',a.graded_at,'grader_name','旧系统'
      ) order by a.answered_at,a.id),'[]'::jsonb)
      from public.legacy_exam_answers a where a.legacy_session_id=p_session_id)
    );
  end if;

  return jsonb_build_object(
    'session',(select to_jsonb(x) from (
      select * from public.admin_exam_combined_sessions_v
      where id=p_session_id and employee_id=c.employee_id and source_system='current'
    ) x),
    'answers',(select coalesce(jsonb_agg(jsonb_build_object(
      'question',q.item,'answer_text',coalesce(ans.answer_text,''),'awarded_score',ans.awarded_score,
      'grade_status',ans.grade_status,'grader_feedback',ans.grader_feedback,
      'graded_at',ans.graded_at,'grader_name',coalesce(nullif(ua.login_username,''),nullif(ua.login_email,''),'—')
    ) order by q.ord),'[]'::jsonb)
    from public.exam_sessions s
    cross join lateral jsonb_array_elements(s.question_snapshot) with ordinality q(item,ord)
    left join public.exam_answers ans on ans.session_id=s.id and ans.question_id=(q.item->>'id')::uuid
    left join public.user_access ua on ua.auth_user_id=ans.graded_by
    where s.id=p_session_id and s.employee_id=c.employee_id)
  );
end;
$$;

revoke all on function public.staff_exam_result_detail(uuid) from public,anon;
grant execute on function public.staff_exam_result_detail(uuid) to authenticated;

notify pgrst,'reload schema';
