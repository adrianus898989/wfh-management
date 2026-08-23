-- Let authenticated staff choose any complete exam pool while keeping each draw
-- scoped to the exact team/series/position combination selected by the user.

create or replace function public.staff_exam_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  c record;
  v_assignments jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;

  select * into c from public.exam_staff_context();
  if c.employee_id is null then
    raise exception '账号尚未关联在职员工档案';
  end if;

  select coalesce(
    jsonb_agg(
      to_jsonb(x)
      order by x.pool_ready desc, x.team_name, x.series_name, x.position_name
    ),
    '[]'::jsonb
  )
  into v_assignments
  from (
    select
      'open'::text as id,
      concat(q.team_name, ' · ', q.series_name, ' · ', q.position_name, ' 考试') as title,
      q.team_name,
      q.position_name,
      q.series_name,
      60 as duration_minutes,
      60 as pass_score,
      14 as question_count,
      100 as total_score,
      20 as max_attempts,
      coalesce((
        select count(*)
        from public.exam_sessions s
        join public.exam_assignments a on a.id = s.assignment_id
        where s.employee_id = c.employee_id
          and s.auth_user_id = auth.uid()
          and s.status <> 'expired'
          and public.exam_norm(a.team_name) = public.exam_norm(q.team_name)
          and public.exam_norm(a.position_name) = public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name) = public.exam_norm(q.series_name)
      ), 0) as attempts,
      (
        select s.id
        from public.exam_sessions s
        join public.exam_assignments a on a.id = s.assignment_id
        where s.employee_id = c.employee_id
          and s.auth_user_id = auth.uid()
          and s.status = 'in_progress'
          and s.expires_at > now()
          and public.exam_norm(a.team_name) = public.exam_norm(q.team_name)
          and public.exam_norm(a.position_name) = public.exam_norm(q.position_name)
          and public.exam_norm(a.series_name) = public.exam_norm(q.series_name)
        order by s.started_at desc
        limit 1
      ) as resume_session_id,
      (
        count(*) filter (where q.points = 5) >= 10
        and count(*) filter (where q.points = 10) >= 3
        and count(*) filter (where q.points = 20) >= 1
      ) as pool_ready,
      jsonb_build_object(
        '5', count(*) filter (where q.points = 5),
        '10', count(*) filter (where q.points = 10),
        '20', count(*) filter (where q.points = 20)
      ) as pool_counts
    from public.exam_questions q
    where q.active
      and nullif(btrim(q.team_name), '') is not null
      and nullif(btrim(q.position_name), '') is not null
      and nullif(btrim(q.series_name), '') is not null
    group by q.team_name, q.position_name, q.series_name
  ) x;

  return jsonb_build_object(
    'profile', to_jsonb(c),
    'assignments', v_assignments,
    'history', (
      select coalesce(
        jsonb_agg(to_jsonb(x) order by x.started_at desc),
        '[]'::jsonb
      )
      from (
        select
          id,
          title,
          attempt_no,
          status,
          started_at,
          submitted_at,
          graded_at,
          earned_score,
          total_score,
          percentage,
          passed,
          grader_name,
          correct_count,
          partial_count,
          wrong_count,
          pending_count,
          source_system,
          source_label,
          answer_detail_available,
          answer_detail_count,
          total_question_count,
          unanswered_count
        from public.admin_exam_combined_sessions_v
        where employee_id = c.employee_id
          and status <> 'in_progress'
        order by started_at desc
        limit 100
      ) x
    )
  );
end;
$$;

create or replace function public.staff_exam_start_open(
  p_team text,
  p_series text,
  p_position text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  c record;
  a public.exam_assignments;
  s public.exam_sessions;
  v_questions jsonb;
  v_saved jsonb;
  v_total numeric := 0;
  v_count integer := 0;
  v_five integer := 0;
  v_ten integer := 0;
  v_twenty integer := 0;
  v_attempt integer := 0;
  v_title text;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  if nullif(btrim(p_team), '') is null
    or nullif(btrim(p_series), '') is null
    or nullif(btrim(p_position), '') is null then
    raise exception '请选择完整的考试题库';
  end if;

  select * into c from public.exam_staff_context();
  if c.employee_id is null then
    raise exception '账号尚未关联在职员工档案';
  end if;

  select
    count(*) filter (where q.points = 5),
    count(*) filter (where q.points = 10),
    count(*) filter (where q.points = 20)
  into v_five, v_ten, v_twenty
  from public.exam_questions q
  where q.active
    and public.exam_norm(q.team_name) = public.exam_norm(p_team)
    and public.exam_norm(q.position_name) = public.exam_norm(p_position)
    and public.exam_norm(q.series_name) = public.exam_norm(p_series);

  if v_five < 10 or v_ten < 3 or v_twenty < 1 then
    raise exception '该题库不足14题/100分：5分题 %/10，10分题 %/3，20分题 %/1',
      v_five, v_ten, v_twenty;
  end if;

  perform pg_advisory_xact_lock(hashtext(concat(
    'open-exam:',
    c.employee_id::text,
    ':', public.exam_norm(p_team),
    ':', public.exam_norm(p_position),
    ':', public.exam_norm(p_series)
  )));

  select ses.*
  into s
  from public.exam_sessions ses
  join public.exam_assignments x on x.id = ses.assignment_id
  where ses.employee_id = c.employee_id
    and ses.auth_user_id = auth.uid()
    and ses.status = 'in_progress'
    and ses.expires_at > now()
    and public.exam_norm(x.team_name) = public.exam_norm(p_team)
    and public.exam_norm(x.position_name) = public.exam_norm(p_position)
    and public.exam_norm(x.series_name) = public.exam_norm(p_series)
  order by ses.started_at desc
  limit 1;

  if s.id is not null then
    select coalesce(
      jsonb_object_agg(question_id::text, answer_text),
      '{}'::jsonb
    )
    into v_saved
    from public.exam_answers
    where session_id = s.id;

    select * into a
    from public.exam_assignments
    where id = s.assignment_id;

    return to_jsonb(s) || jsonb_build_object(
      'saved_answers', coalesce(v_saved, '{}'::jsonb),
      'resumed', true,
      'title', a.title
    );
  end if;

  update public.exam_sessions s0
  set status = 'expired', updated_at = now()
  where s0.employee_id = c.employee_id
    and s0.auth_user_id = auth.uid()
    and s0.status = 'in_progress'
    and s0.expires_at <= now();

  v_title := concat(btrim(p_team), ' · ', btrim(p_series), ' · ', btrim(p_position), ' 考试');

  select *
  into a
  from public.exam_assignments x
  where x.employee_id is null
    and x.status = 'published'
    and public.exam_norm(x.team_name) = public.exam_norm(p_team)
    and public.exam_norm(x.position_name) = public.exam_norm(p_position)
    and public.exam_norm(x.series_name) = public.exam_norm(p_series)
    and x.duration_minutes = 60
    and x.question_rules = '{"5":10,"10":3,"20":1}'::jsonb
  order by x.created_at desc
  limit 1;

  if a.id is null then
    insert into public.exam_assignments(
      title,
      team_name,
      position_name,
      series_name,
      employee_id,
      duration_minutes,
      pass_score,
      question_rules,
      start_at,
      end_at,
      max_attempts,
      status,
      created_by,
      updated_by
    )
    values (
      v_title,
      btrim(p_team),
      btrim(p_position),
      btrim(p_series),
      null,
      60,
      60,
      '{"5":10,"10":3,"20":1}'::jsonb,
      now(),
      null,
      20,
      'published',
      auth.uid(),
      auth.uid()
    )
    returning * into a;
  end if;

  select count(*) + 1
  into v_attempt
  from public.exam_sessions s0
  where s0.assignment_id = a.id
    and s0.employee_id = c.employee_id
    and s0.status <> 'expired';

  if v_attempt > a.max_attempts then
    raise exception '已达到考试次数上限';
  end if;

  with ranked as (
    select
      q.*,
      row_number() over (partition by q.points order by random()) as rn
    from public.exam_questions q
    where q.active
      and public.exam_norm(q.team_name) = public.exam_norm(p_team)
      and public.exam_norm(q.position_name) = public.exam_norm(p_position)
      and public.exam_norm(q.series_name) = public.exam_norm(p_series)
  ), selected as (
    select *, random() as sort_key
    from ranked
    where (points = 5 and rn <= 10)
      or (points = 10 and rn <= 3)
      or (points = 20 and rn <= 1)
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'external_key', external_key,
          'series_name', series_name,
          'team_name', team_name,
          'position_name', position_name,
          'question_en', question_en,
          'question_zh', question_zh,
          'question_vi', question_vi,
          'points', points,
          'difficulty', difficulty,
          'image_urls', image_urls
        )
        order by sort_key
      ),
      '[]'::jsonb
    ),
    coalesce(sum(points), 0),
    count(*)
  into v_questions, v_total, v_count
  from selected;

  if v_count <> 14 or v_total <> 100 then
    raise exception '生成试卷失败：必须为14题、100分，当前为%题、%分', v_count, v_total;
  end if;

  insert into public.exam_sessions(
    assignment_id,
    employee_id,
    auth_user_id,
    attempt_no,
    question_snapshot,
    expires_at,
    total_score
  )
  values (
    a.id,
    c.employee_id,
    auth.uid(),
    v_attempt,
    v_questions,
    now() + interval '60 minutes',
    100
  )
  returning * into s;

  return to_jsonb(s) || jsonb_build_object(
    'saved_answers', '{}'::jsonb,
    'resumed', false,
    'title', v_title
  );
end;
$$;

-- Preserve the previous RPC for older deployed clients while keeping its former
-- team-only behavior. New clients call staff_exam_start_open directly.
create or replace function public.staff_exam_start_adaptive(
  p_series text,
  p_position text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  c record;
begin
  if auth.uid() is null then
    raise exception '请先登录';
  end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then
    raise exception '账号尚未关联在职员工档案';
  end if;
  return public.staff_exam_start_open(c.team_name, p_series, p_position);
end;
$$;

revoke all on function public.staff_exam_home() from public, anon;
revoke all on function public.staff_exam_start_open(text, text, text) from public, anon;
revoke all on function public.staff_exam_start_adaptive(text, text) from public, anon;
grant execute on function public.staff_exam_home() to authenticated;
grant execute on function public.staff_exam_start_open(text, text, text) to authenticated;
grant execute on function public.staff_exam_start_adaptive(text, text) to authenticated;

notify pgrst, 'reload schema';
