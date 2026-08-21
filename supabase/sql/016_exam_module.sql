-- Secure team + position exam workflow.

insert into public.permissions (code, name, category, sensitive)
values
  ('exam.view', '考试 · 查看', 'exam', false),
  ('exam.manage', '考试 · 题库与分配', 'exam', true),
  ('exam.grade', '考试 · 批改', 'exam', true)
on conflict (code) do update
set name = excluded.name, category = excluded.category, sensitive = excluded.sensitive;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r
join public.permissions p on p.code in ('exam.view','exam.manage','exam.grade')
where r.code in ('founder','supervisor')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r
join public.permissions p on p.code = 'exam.view'
where r.code in ('senior_team_leader','team_leader','trainer','employee')
on conflict do nothing;

create table if not exists public.exam_questions (
  id uuid primary key default gen_random_uuid(),
  external_key text not null unique,
  sheet_row integer,
  team_name text not null,
  position_name text not null,
  question_en text not null default '',
  question_zh text not null default '',
  question_vi text not null default '',
  points smallint not null check (points in (5,10,20)),
  difficulty smallint not null check (difficulty between 1 and 3),
  image_urls jsonb not null default '[]'::jsonb check (jsonb_typeof(image_urls)='array'),
  active boolean not null default true,
  source text not null default 'google_sheet' check (source in ('google_sheet','backend')),
  source_hash text not null default '',
  revision integer not null default 1,
  sheet_updated_at timestamptz,
  backend_updated_at timestamptz,
  synced_at timestamptz,
  sync_status text not null default 'synced' check (sync_status in ('synced','pending_sheet','conflict','error')),
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(btrim(team_name)) between 1 and 100),
  check (char_length(btrim(position_name)) between 1 and 100),
  check (coalesce(nullif(btrim(question_en),''),nullif(btrim(question_zh),''),nullif(btrim(question_vi),'')) is not null)
);

create index if not exists exam_questions_match_idx on public.exam_questions (team_name, position_name, active, difficulty);
create index if not exists exam_questions_sheet_row_idx on public.exam_questions (sheet_row) where sheet_row is not null;

create table if not exists public.exam_question_versions (
  id bigint generated always as identity primary key,
  question_id uuid not null references public.exam_questions(id) on delete cascade,
  revision integer not null,
  snapshot jsonb not null,
  changed_source text not null,
  changed_by uuid,
  created_at timestamptz not null default now(),
  unique(question_id, revision)
);

create table if not exists public.exam_assignments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  team_name text not null,
  position_name text not null,
  employee_id uuid references public.employees(id) on delete set null,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 240),
  pass_score numeric(6,2) not null default 60 check (pass_score between 0 and 100),
  question_rules jsonb not null default '{"5":10,"10":3,"20":1}'::jsonb,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  max_attempts integer not null default 1 check (max_attempts between 1 and 20),
  status text not null default 'published' check (status in ('draft','published','closed','archived')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at is null or end_at > start_at)
);

create index if not exists exam_assignments_match_idx on public.exam_assignments (team_name, position_name, status, start_at, end_at);

create table if not exists public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.exam_assignments(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null,
  attempt_no integer not null,
  question_snapshot jsonb not null check (jsonb_typeof(question_snapshot)='array'),
  status text not null default 'in_progress' check (status in ('in_progress','submitted','grading','graded','expired')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  submitted_at timestamptz,
  graded_at timestamptz,
  graded_by uuid,
  earned_score numeric(8,2),
  total_score numeric(8,2) not null default 0,
  percentage numeric(6,2),
  passed boolean,
  grader_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(assignment_id, employee_id, attempt_no)
);

create index if not exists exam_sessions_employee_idx on public.exam_sessions (employee_id, started_at desc);
create index if not exists exam_sessions_status_idx on public.exam_sessions (status, submitted_at desc);

create table if not exists public.exam_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.exam_sessions(id) on delete cascade,
  question_id uuid not null references public.exam_questions(id) on delete restrict,
  answer_text text not null default '',
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments)='array' and jsonb_array_length(attachments)<=6),
  awarded_score numeric(8,2),
  grade_status text check (grade_status is null or grade_status in ('correct','partial','wrong')),
  grader_feedback text not null default '',
  saved_at timestamptz not null default now(),
  graded_at timestamptz,
  graded_by uuid,
  unique(session_id, question_id)
);

create table if not exists public.exam_sync_runs (
  id bigint generated always as identity primary key,
  direction text not null check (direction in ('sheet_to_db','db_to_sheet','reconcile')),
  status text not null check (status in ('running','success','partial','failed')),
  read_count integer not null default 0,
  inserted_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.exam_questions enable row level security;
alter table public.exam_question_versions enable row level security;
alter table public.exam_assignments enable row level security;
alter table public.exam_sessions enable row level security;
alter table public.exam_answers enable row level security;
alter table public.exam_sync_runs enable row level security;

create or replace function public.exam_is_admin(p_permission text default 'exam.view')
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.user_access ua where ua.auth_user_id=(select auth.uid()) and ua.active and ua.backend_enabled)
    and (public.has_permission(p_permission) or (select auth.uid())='567e1c26-9ff7-4df2-a3bd-9b68e26d10c9'::uuid);
$$;

create or replace function public.exam_norm(p_value text)
returns text language sql immutable parallel safe set search_path=public as $$
  select lower(regexp_replace(coalesce(p_value,''),'[[:space:]]+','','g'));
$$;

create or replace function public.exam_staff_context()
returns table(auth_user_id uuid, employee_id uuid, employee_no text, employee_name text, team_name text, position_name text)
language sql stable security definer set search_path=public as $$
  select ua.auth_user_id,e.id,e.employee_no,e.full_name,t.name,p.name
  from public.user_access ua join public.employees e on e.id=ua.employee_id
  left join public.teams t on t.id=e.team_id left join public.positions p on p.id=e.position_id
  where ua.auth_user_id=(select auth.uid()) and ua.active and ua.employee_portal_enabled and e.status in ('active','probation') limit 1;
$$;

create policy exam_admin_questions on public.exam_questions for all to authenticated using (public.exam_is_admin('exam.view')) with check (public.exam_is_admin('exam.manage'));
create policy exam_admin_question_versions on public.exam_question_versions for select to authenticated using (public.exam_is_admin('exam.manage'));
create policy exam_admin_assignments on public.exam_assignments for all to authenticated using (public.exam_is_admin('exam.view')) with check (public.exam_is_admin('exam.manage'));
create policy exam_admin_sessions on public.exam_sessions for all to authenticated using (public.exam_is_admin('exam.view')) with check (public.exam_is_admin('exam.grade'));
create policy exam_admin_answers on public.exam_answers for all to authenticated using (public.exam_is_admin('exam.view')) with check (public.exam_is_admin('exam.grade'));
create policy exam_admin_sync on public.exam_sync_runs for select to authenticated using (public.exam_is_admin('exam.manage'));

create policy exam_staff_assignments on public.exam_assignments for select to authenticated using (
  status='published' and start_at<=now() and (end_at is null or end_at>=now()) and exists(
    select 1 from public.exam_staff_context() c where (employee_id is null or employee_id=c.employee_id)
      and public.exam_norm(team_name)=public.exam_norm(c.team_name) and public.exam_norm(position_name)=public.exam_norm(c.position_name)
  )
);
create policy exam_staff_sessions on public.exam_sessions for select to authenticated using (auth_user_id=(select auth.uid()));
create policy exam_staff_answers on public.exam_answers for select to authenticated using (exists(select 1 from public.exam_sessions s where s.id=session_id and s.auth_user_id=(select auth.uid())));

create or replace function public.admin_exam_dashboard(
  p_search text default '', p_team text default '', p_position text default '', p_page integer default 1, p_page_size integer default 30
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_rows jsonb; v_total bigint; v_page integer:=greatest(coalesce(p_page,1),1); v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
begin
  if not public.exam_is_admin('exam.view') then raise exception 'forbidden'; end if;
  select count(*) into v_total from exam_questions q where q.active
    and (btrim(p_team)='' or q.team_name=p_team) and (btrim(p_position)='' or q.position_name=p_position)
    and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%');
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into v_rows from (
    select q.id,q.external_key,q.sheet_row,q.team_name,q.position_name,q.question_en,q.question_zh,q.question_vi,q.points,q.difficulty,q.image_urls,q.active,q.sync_status,q.updated_at
    from exam_questions q where q.active
      and (btrim(p_team)='' or q.team_name=p_team) and (btrim(p_position)='' or q.position_name=p_position)
      and (btrim(p_search)='' or q.external_key ilike '%'||p_search||'%' or q.question_zh ilike '%'||p_search||'%' or q.question_en ilike '%'||p_search||'%' or q.question_vi ilike '%'||p_search||'%')
    order by q.team_name,q.position_name,q.sheet_row nulls last limit v_size offset (v_page-1)*v_size
  ) x;
  return jsonb_build_object(
    'counts',jsonb_build_object('questions',(select count(*) from exam_questions where active),'assignments',(select count(*) from exam_assignments where status='published'),'pending_grading',(select count(*) from exam_sessions where status in ('submitted','grading')),'completed',(select count(*) from exam_sessions where status='graded')),
    'teams',(select coalesce(jsonb_agg(name order by name),'[]') from (select distinct team_name name from exam_questions where active) a),
    'positions',(select coalesce(jsonb_agg(name order by name),'[]') from (select distinct position_name name from exam_questions where active) a),
    'questions',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc),'[]') from (select id,title,team_name,position_name,duration_minutes,pass_score,start_at,end_at,max_attempts,status,created_at from exam_assignments limit 100) a),
    'sessions',(select coalesce(jsonb_agg(to_jsonb(s) order by s.submitted_at desc nulls last),'[]') from (select s.id,e.employee_no,e.full_name employee_name,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed from exam_sessions s join employees e on e.id=s.employee_id join exam_assignments a on a.id=s.assignment_id limit 100) s),
    'last_sync',(select to_jsonb(r) from exam_sync_runs r order by started_at desc limit 1)
  );
end; $$;

create or replace function public.admin_exam_save_question(p_question jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v exam_questions; v_id uuid; v_snapshot jsonb;
begin
  if not public.exam_is_admin('exam.manage') then raise exception 'forbidden'; end if;
  v_id:=nullif(p_question->>'id','')::uuid;
  if v_id is null then
    insert into exam_questions(external_key,team_name,position_name,question_en,question_zh,question_vi,points,difficulty,image_urls,source,sync_status,backend_updated_at,created_by,updated_by)
    values(coalesce(nullif(p_question->>'external_key',''),'Q-'||replace(gen_random_uuid()::text,'-','')),btrim(p_question->>'team_name'),btrim(p_question->>'position_name'),coalesce(p_question->>'question_en',''),coalesce(p_question->>'question_zh',''),coalesce(p_question->>'question_vi',''),(p_question->>'points')::smallint,(p_question->>'difficulty')::smallint,coalesce(p_question->'image_urls','[]'), 'backend','pending_sheet',now(),auth.uid(),auth.uid()) returning * into v;
  else
    update exam_questions set team_name=btrim(p_question->>'team_name'),position_name=btrim(p_question->>'position_name'),question_en=coalesce(p_question->>'question_en',''),question_zh=coalesce(p_question->>'question_zh',''),question_vi=coalesce(p_question->>'question_vi',''),points=(p_question->>'points')::smallint,difficulty=(p_question->>'difficulty')::smallint,image_urls=coalesce(p_question->'image_urls','[]'),active=coalesce((p_question->>'active')::boolean,true),revision=revision+1,source='backend',sync_status='pending_sheet',backend_updated_at=now(),updated_at=now(),updated_by=auth.uid() where id=v_id returning * into v;
  end if;
  v_snapshot:=to_jsonb(v)-'created_by'-'updated_by';
  insert into exam_question_versions(question_id,revision,snapshot,changed_source,changed_by) values(v.id,v.revision,v_snapshot,'backend',auth.uid()) on conflict do nothing;
  return to_jsonb(v);
end; $$;

create or replace function public.admin_exam_create_assignment(p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v exam_assignments;
begin
  if not public.exam_is_admin('exam.manage') then raise exception 'forbidden'; end if;
  if not exists(select 1 from exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(p_data->>'team_name') and public.exam_norm(q.position_name)=public.exam_norm(p_data->>'position_name')) then raise exception '该团队与岗位没有可用题目'; end if;
  insert into exam_assignments(title,team_name,position_name,duration_minutes,pass_score,question_rules,start_at,end_at,max_attempts,status,created_by)
  values(btrim(p_data->>'title'),btrim(p_data->>'team_name'),btrim(p_data->>'position_name'),coalesce((p_data->>'duration_minutes')::int,60),coalesce((p_data->>'pass_score')::numeric,60),coalesce(p_data->'question_rules','{"5":10,"10":3,"20":1}'),coalesce((p_data->>'start_at')::timestamptz,now()),nullif(p_data->>'end_at','')::timestamptz,coalesce((p_data->>'max_attempts')::int,1),'published',auth.uid()) returning * into v;
  return to_jsonb(v);
end; $$;

create or replace function public.staff_exam_home()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare c record;
begin
  select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  return jsonb_build_object('profile',to_jsonb(c),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(x) order by x.start_at desc),'[]') from (select a.id,a.title,a.team_name,a.position_name,a.duration_minutes,a.pass_score,a.start_at,a.end_at,a.max_attempts,(select count(*) from exam_sessions s where s.assignment_id=a.id and s.employee_id=c.employee_id) attempts from exam_assignments a where a.status='published' and a.start_at<=now() and (a.end_at is null or a.end_at>=now()) and (a.employee_id is null or a.employee_id=c.employee_id) and public.exam_norm(a.team_name)=public.exam_norm(c.team_name) and public.exam_norm(a.position_name)=public.exam_norm(c.position_name)) x),
    'history',(select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc),'[]') from (select s.id,a.title,s.attempt_no,s.status,s.started_at,s.submitted_at,s.earned_score,s.total_score,s.percentage,s.passed from exam_sessions s join exam_assignments a on a.id=s.assignment_id where s.employee_id=c.employee_id limit 100) x));
end; $$;

create or replace function public.staff_exam_start(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c record; a exam_assignments; v_attempt int; v_questions jsonb; v_total numeric; s exam_sessions; v_count int;
begin
  select * into c from public.exam_staff_context(); if c.employee_id is null then raise exception '账号尚未关联员工档案'; end if;
  select * into a from exam_assignments where id=p_assignment_id and status='published' and start_at<=now() and (end_at is null or end_at>=now()) and (employee_id is null or employee_id=c.employee_id) and public.exam_norm(team_name)=public.exam_norm(c.team_name) and public.exam_norm(position_name)=public.exam_norm(c.position_name); if a.id is null then raise exception '考试不可用或不属于你的团队岗位'; end if;
  select count(*)+1 into v_attempt from exam_sessions where assignment_id=a.id and employee_id=c.employee_id; if v_attempt>a.max_attempts then raise exception '已达到考试次数上限'; end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.points,q.external_key),'[]'),coalesce(sum(q.points),0),count(*) into v_questions,v_total,v_count from (
    select id,external_key,question_en,question_zh,question_vi,points,difficulty,image_urls from (
      select q.*,row_number() over(partition by q.points order by random()) rn from exam_questions q where q.active and public.exam_norm(q.team_name)=public.exam_norm(c.team_name) and public.exam_norm(q.position_name)=public.exam_norm(c.position_name)
    ) z where (points=5 and rn<=coalesce((a.question_rules->>'5')::int,10)) or (points=10 and rn<=coalesce((a.question_rules->>'10')::int,3)) or (points=20 and rn<=coalesce((a.question_rules->>'20')::int,1))
  ) q;
  if v_count=0 then raise exception '该团队岗位暂无题目'; end if;
  insert into exam_sessions(assignment_id,employee_id,auth_user_id,attempt_no,question_snapshot,expires_at,total_score) values(a.id,c.employee_id,auth.uid(),v_attempt,v_questions,now()+make_interval(mins=>a.duration_minutes),v_total) returning * into s;
  return to_jsonb(s);
end; $$;

create or replace function public.staff_exam_save_answer(p_session_id uuid,p_question_id uuid,p_answer text,p_attachments jsonb default '[]')
returns jsonb language plpgsql security definer set search_path=public as $$
declare s exam_sessions; v exam_answers;
begin
  select * into s from exam_sessions where id=p_session_id and auth_user_id=auth.uid() and status='in_progress' and expires_at>now(); if s.id is null then raise exception '考试已结束或无权操作'; end if;
  if not exists(select 1 from jsonb_array_elements(s.question_snapshot) q where (q->>'id')::uuid=p_question_id) then raise exception '题目不属于本次考试'; end if;
  insert into exam_answers(session_id,question_id,answer_text,attachments,saved_at) values(s.id,p_question_id,coalesce(p_answer,''),coalesce(p_attachments,'[]'),now()) on conflict(session_id,question_id) do update set answer_text=excluded.answer_text,attachments=excluded.attachments,saved_at=now() returning * into v;
  return to_jsonb(v);
end; $$;

create or replace function public.staff_exam_submit(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s exam_sessions;
begin
  update exam_sessions set status='submitted',submitted_at=now(),updated_at=now() where id=p_session_id and auth_user_id=auth.uid() and status='in_progress' returning * into s; if s.id is null then raise exception '考试无法提交'; end if; return to_jsonb(s);
end; $$;

create or replace function public.admin_exam_grade_answer(p_answer_id uuid,p_status text,p_score numeric,p_feedback text default '')
returns jsonb language plpgsql security definer set search_path=public as $$
declare v exam_answers; v_session uuid; v_total numeric; v_earned numeric; v_pass numeric;
begin
  if not public.exam_is_admin('exam.grade') then raise exception 'forbidden'; end if;
  update exam_answers set grade_status=p_status,awarded_score=p_score,grader_feedback=coalesce(p_feedback,''),graded_at=now(),graded_by=auth.uid() where id=p_answer_id returning * into v;
  if v.id is null then raise exception '答题记录不存在'; end if;
  v_session:=v.session_id;
  select s.total_score,coalesce(sum(a.awarded_score),0),x.pass_score into v_total,v_earned,v_pass from exam_sessions s join exam_assignments x on x.id=s.assignment_id left join exam_answers a on a.session_id=s.id where s.id=v_session group by s.total_score,x.pass_score;
  if not exists(select 1 from exam_answers a where a.session_id=v_session and a.grade_status is null) then update exam_sessions set status='graded',earned_score=v_earned,percentage=case when v_total>0 then round(v_earned/v_total*100,2) else 0 end,passed=case when v_total>0 then v_earned/v_total*100>=v_pass else false end,graded_at=now(),graded_by=auth.uid(),updated_at=now() where id=v_session; else update exam_sessions set status='grading',updated_at=now() where id=v_session; end if;
  return to_jsonb(v);
end; $$;

create or replace function public.admin_exam_session_detail(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
begin
  if not public.exam_is_admin('exam.grade') then raise exception 'forbidden'; end if;
  return jsonb_build_object('session',(select to_jsonb(x) from (select s.*,e.employee_no,e.full_name employee_name,a.title,a.pass_score from exam_sessions s join employees e on e.id=s.employee_id join exam_assignments a on a.id=s.assignment_id where s.id=p_session_id) x),'answers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.points,x.external_key),'[]') from (select q.id question_id,q.external_key,q.question_en,q.question_zh,q.question_vi,q.points,q.image_urls,ans.id answer_id,coalesce(ans.answer_text,'') answer_text,coalesce(ans.attachments,'[]') attachments,ans.grade_status,ans.awarded_score,ans.grader_feedback from exam_sessions s cross join lateral jsonb_array_elements(s.question_snapshot) j join exam_questions q on q.id=(j->>'id')::uuid left join exam_answers ans on ans.session_id=s.id and ans.question_id=q.id where s.id=p_session_id) x));
end; $$;

revoke all on function public.exam_is_admin(text),public.exam_staff_context(),public.admin_exam_dashboard(text,text,text,integer,integer),public.admin_exam_save_question(jsonb),public.admin_exam_create_assignment(jsonb),public.staff_exam_home(),public.staff_exam_start(uuid),public.staff_exam_save_answer(uuid,uuid,text,jsonb),public.staff_exam_submit(uuid),public.admin_exam_grade_answer(uuid,text,numeric,text),public.admin_exam_session_detail(uuid) from public;
grant execute on function public.admin_exam_dashboard(text,text,text,integer,integer),public.admin_exam_save_question(jsonb),public.admin_exam_create_assignment(jsonb),public.admin_exam_grade_answer(uuid,text,numeric,text),public.admin_exam_session_detail(uuid) to authenticated;
grant execute on function public.staff_exam_home(),public.staff_exam_start(uuid),public.staff_exam_save_answer(uuid,uuid,text,jsonb),public.staff_exam_submit(uuid) to authenticated;
