-- Read-only mirror of the legacy exam project. Secrets are stored in Supabase
-- Vault and are intentionally not included in source control.

create table if not exists public.legacy_exam_sessions(
  id uuid primary key default gen_random_uuid(),
  source_project_ref text not null,
  source_session_id uuid not null,
  source_user_id uuid,
  employee_id uuid references public.employees(id) on delete set null,
  employee_no text,
  employee_name text,
  employee_match_status text not null default 'unmatched' check(employee_match_status in('matched','unmatched','ambiguous')),
  status text not null check(status in('in_progress','submitted','graded')),
  series_name text,
  position_name text,
  attempt_no integer not null default 1,
  started_at timestamptz,
  submitted_at timestamptz,
  graded_at timestamptz,
  duration_minutes integer,
  earned_score numeric,
  total_score numeric not null default 100,
  percentage numeric,
  passed boolean,
  total_questions integer,
  correct_count integer,
  submission_count integer,
  question_ids jsonb not null default '[]'::jsonb,
  source_changed_at timestamptz,
  source_payload jsonb not null default '{}'::jsonb,
  first_synced_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  unique(source_project_ref,source_session_id)
);

create table if not exists public.legacy_exam_answers(
  id uuid primary key default gen_random_uuid(),
  legacy_session_id uuid not null references public.legacy_exam_sessions(id) on delete cascade,
  source_project_ref text not null,
  source_submission_id uuid not null,
  source_session_id uuid not null,
  source_question_id uuid,
  question_snapshot jsonb not null default '{}'::jsonb,
  answer_text text,
  is_correct boolean,
  awarded_score numeric,
  question_points numeric,
  grade_status text check(grade_status in('correct','partial','wrong','pending')),
  attachments jsonb not null default '[]'::jsonb,
  feedback text,
  feedback_images jsonb not null default '[]'::jsonb,
  answered_at timestamptz,
  graded_at timestamptz,
  source_payload jsonb not null default '{}'::jsonb,
  first_synced_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  unique(source_project_ref,source_submission_id)
);

create table if not exists public.legacy_exam_sync_state(
  source_project_ref text primary key,
  exporter_url text not null,
  full_sync_started_at timestamptz,
  full_sync_completed boolean not null default false,
  full_sync_offset integer not null default 0,
  incremental_cursor timestamptz not null default '1970-01-01',
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  status text not null default 'idle',
  total_sessions_synced integer not null default 0,
  total_answers_synced integer not null default 0,
  last_batch_sessions integer not null default 0,
  last_batch_answers integer not null default 0,
  updated_at timestamptz not null default now()
);

create index if not exists legacy_exam_sessions_employee_idx on public.legacy_exam_sessions(employee_id,started_at desc);
create index if not exists legacy_exam_sessions_employee_no_idx on public.legacy_exam_sessions(lower(employee_no),started_at desc);
create index if not exists legacy_exam_sessions_status_idx on public.legacy_exam_sessions(status,started_at desc);
create index if not exists legacy_exam_sessions_changed_idx on public.legacy_exam_sessions(source_changed_at desc);
create index if not exists legacy_exam_answers_session_idx on public.legacy_exam_answers(legacy_session_id,answered_at);

alter table public.legacy_exam_sessions enable row level security;
alter table public.legacy_exam_answers enable row level security;
alter table public.legacy_exam_sync_state enable row level security;

drop policy if exists legacy_exam_sessions_admin_read on public.legacy_exam_sessions;
create policy legacy_exam_sessions_admin_read on public.legacy_exam_sessions for select to authenticated using(public.exam_is_admin('exam.view'));
drop policy if exists legacy_exam_answers_admin_read on public.legacy_exam_answers;
create policy legacy_exam_answers_admin_read on public.legacy_exam_answers for select to authenticated using(public.exam_is_admin('exam.view'));
drop policy if exists legacy_exam_sync_state_admin_read on public.legacy_exam_sync_state;
create policy legacy_exam_sync_state_admin_read on public.legacy_exam_sync_state for select to authenticated using(public.exam_is_admin('exam.manage'));

revoke all on public.legacy_exam_sessions,public.legacy_exam_answers,public.legacy_exam_sync_state from public,anon;
grant select on public.legacy_exam_sessions,public.legacy_exam_answers to authenticated;
grant select on public.legacy_exam_sync_state to authenticated;
grant all on public.legacy_exam_sessions,public.legacy_exam_answers,public.legacy_exam_sync_state to service_role;

create or replace function public.legacy_exam_refresh_employee_matches()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  with employee_no_keys as materialized(
    select public.exam_norm(e.employee_no) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e where nullif(public.exam_norm(e.employee_no),'') is not null group by 1
  ),employee_name_keys as materialized(
    select public.exam_norm(e.full_name) match_key,count(distinct e.id) match_count,
      case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
    from public.employees e where nullif(public.exam_norm(e.full_name),'') is not null group by 1
  ),name_candidates as(
    select l.id,n.match_count,n.employee_id from public.legacy_exam_sessions l
    join employee_name_keys n on n.match_key=public.exam_norm(l.employee_name)
    where nullif(public.exam_norm(l.employee_name),'') is not null
    union all
    select l.id,n.match_count,n.employee_id from public.legacy_exam_sessions l
    join employee_name_keys n on n.match_key=public.exam_norm(l.employee_no)
    where nullif(public.exam_norm(l.employee_no),'') is not null
  ),name_matches as(
    select id,case when bool_or(match_count>1) then 2 else count(distinct employee_id) end match_count,
      case when not bool_or(match_count>1) and count(distinct employee_id)=1 then min(employee_id::text)::uuid end employee_id
    from name_candidates group by id
  ),matched as(
    select l.id,
      case when id_match.match_count=1 then id_match.employee_id
        when coalesce(id_match.match_count,0)=0 and name_match.match_count=1 then name_match.employee_id end employee_id,
      case when id_match.match_count=1 then 'matched' when id_match.match_count>1 then 'ambiguous'
        when name_match.match_count=1 then 'matched' when name_match.match_count>1 then 'ambiguous' else 'unmatched' end match_status
    from public.legacy_exam_sessions l
    left join employee_no_keys id_match on id_match.match_key=public.exam_norm(l.employee_no)
    left join name_matches name_match on name_match.id=l.id
  )
  update public.legacy_exam_sessions l set employee_id=m.employee_id,employee_match_status=m.match_status,
    synced_at=case when l.employee_id is distinct from m.employee_id or l.employee_match_status is distinct from m.match_status then now() else l.synced_at end
  from matched m where m.id=l.id;
  get diagnostics v_count=row_count;return v_count;
end $$;

create or replace function public.legacy_exam_recalculate_attempts()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  with ranked as(
    select id,row_number() over(partition by source_project_ref,source_user_id,coalesce(series_name,''),coalesce(position_name,'') order by started_at,id)::integer n
    from public.legacy_exam_sessions
  )
  update public.legacy_exam_sessions l set attempt_no=r.n from ranked r where r.id=l.id and l.attempt_no is distinct from r.n;
  get diagnostics v_count=row_count;return v_count;
end $$;

revoke all on function public.legacy_exam_refresh_employee_matches(),public.legacy_exam_recalculate_attempts() from public,anon,authenticated;
grant execute on function public.legacy_exam_refresh_employee_matches(),public.legacy_exam_recalculate_attempts() to service_role;

create or replace function public.legacy_exam_match_employee_row()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_count integer;v_employee_id uuid;
begin
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where nullif(public.exam_norm(new.employee_no),'') is not null
    and public.exam_norm(e.employee_no)=public.exam_norm(new.employee_no);
  if v_count=1 then new.employee_id:=v_employee_id;new.employee_match_status:='matched';return new;end if;
  if v_count>1 then new.employee_id:=null;new.employee_match_status:='ambiguous';return new;end if;
  select count(distinct e.id),case when count(distinct e.id)=1 then min(e.id::text)::uuid end
  into v_count,v_employee_id from public.employees e
  where public.exam_norm(e.full_name) in(nullif(public.exam_norm(new.employee_name),''),nullif(public.exam_norm(new.employee_no),''));
  new.employee_id:=case when v_count=1 then v_employee_id end;
  new.employee_match_status:=case when v_count=1 then 'matched' when v_count>1 then 'ambiguous' else 'unmatched' end;
  return new;
end $$;
revoke all on function public.legacy_exam_match_employee_row() from public,anon,authenticated;
drop trigger if exists legacy_exam_match_employee_before_write on public.legacy_exam_sessions;
create trigger legacy_exam_match_employee_before_write before insert or update of employee_no,employee_name,employee_id,employee_match_status
on public.legacy_exam_sessions for each row execute function public.legacy_exam_match_employee_row();

-- Deployment setup (one time):
-- 1. Store the exporter and cron tokens in Vault as legacy_exam_source_token
--    and legacy_exam_cron_token.
-- 2. Deploy supabase/functions/legacy-exam-sync with custom token auth.
-- 3. Schedule that function every minute with pg_cron + pg_net. The request
--    reads both tokens from vault.decrypted_secrets; raw secrets never enter SQL.
