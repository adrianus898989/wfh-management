begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- The private schedule's B/C/D columns contain display names while H contains the
-- durable employee number.  Names must never be used directly at an RLS/RPC
-- boundary.  This key is intentionally strict: normalize Unicode/case and
-- whitespace, but preserve punctuation so "Ana-Marie" cannot authorize
-- "Ana Marie".  Duplicate current-roster names remain unresolved.
create or replace function session_private.online_training_roster_name_key(
  p_value text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.lower(
    pg_catalog.regexp_replace(
      pg_catalog.btrim(
        pg_catalog.translate(
          normalize(coalesce(p_value, ''), NFKC),
          U&'\200B\200C\200D\2060\FEFF',
          ''
        )
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

revoke all on function
  session_private.online_training_roster_name_key(text)
  from public, anon, authenticated, service_role;

create index if not exists report_employee_directory_roster_training_name_idx
  on public.report_employee_directory_cache (
    session_private.online_training_roster_name_key(full_name),
    public.employee_master_normalize_id(employee_no)
  )
  where source_kind = 'roster'
    and nullif(btrim(full_name), '') is not null;

-- One stable relationship row per ID-backed learner in the latest accepted
-- A:M roster.  Raw A/B/C/D values are retained only for diagnostics; every access
-- decision uses the resolved employee UUID columns.
create table if not exists session_private.online_training_roster_relationships (
  learner_employee_id uuid primary key
    references public.employees(id) on delete cascade,
  learner_employee_no text not null,
  responsible_employee_id uuid
    references public.employees(id) on delete set null,
  onsite_trainer_employee_id uuid
    references public.employees(id) on delete set null,
  online_trainer_employee_id uuid
    references public.employees(id) on delete set null,
  online_leader_employee_id uuid
    references public.employees(id) on delete set null,
  responsible_raw text,
  onsite_trainer_raw text,
  online_trainer_raw text,
  online_leader_raw text,
  source_row integer,
  refreshed_at timestamptz not null default clock_timestamp()
);

-- Keep this migration safe if a development database already ran an earlier
-- draft that only materialized C/D.
alter table session_private.online_training_roster_relationships
  add column if not exists responsible_employee_id uuid
    references public.employees(id) on delete set null,
  add column if not exists responsible_raw text,
  add column if not exists onsite_trainer_employee_id uuid
    references public.employees(id) on delete set null,
  add column if not exists onsite_trainer_raw text;

alter table session_private.online_training_roster_relationships
  enable row level security;
revoke all on table session_private.online_training_roster_relationships
  from public, anon, authenticated, service_role;

create index if not exists online_training_roster_relationship_trainer_idx
  on session_private.online_training_roster_relationships (
    online_trainer_employee_id,
    learner_employee_id
  )
  where online_trainer_employee_id is not null;
create index if not exists online_training_roster_relationship_responsible_idx
  on session_private.online_training_roster_relationships (
    responsible_employee_id,
    learner_employee_id
  )
  where responsible_employee_id is not null;
create index if not exists online_training_roster_relationship_onsite_trainer_idx
  on session_private.online_training_roster_relationships (
    onsite_trainer_employee_id,
    learner_employee_id
  )
  where onsite_trainer_employee_id is not null;
create index if not exists online_training_roster_relationship_leader_idx
  on session_private.online_training_roster_relationships (
    online_leader_employee_id,
    online_trainer_employee_id
  )
  where online_leader_employee_id is not null;

create or replace function session_private.rebuild_online_training_roster_relationships(
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row_count integer := 0;
  v_source_named_count integer := 0;
  v_source_id_row_count integer := 0;
  v_source_unique_id_count integer := 0;
  v_existing_count integer := 0;
  v_loading_count integer := 0;
  v_responsible_count integer := 0;
  v_onsite_trainer_count integer := 0;
  v_trainer_count integer := 0;
  v_leader_count integer := 0;
  v_unresolved_onsite_trainer_count integer := 0;
  v_unresolved_responsible_count integer := 0;
  v_unresolved_trainer_count integer := 0;
  v_unresolved_leader_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_schedule_roster_rows';
  end if;

  -- This function replaces the complete relationship snapshot.  Validate the
  -- normalized input before the delete so an empty/partial/formula-loading
  -- payload cannot erase the last healthy hierarchy, even if a service caller
  -- accidentally bypasses the outer Google snapshot ingest wrapper.
  select
    count(*) filter (
      where nullif(session_private.online_training_roster_name_key(item->>'name'), '')
        is not null
    )::integer,
    count(*) filter (
      where nullif(public.employee_master_normalize_id(item->>'employee_id'), '')
        is not null
    )::integer,
    count(distinct public.employee_master_normalize_id(item->>'employee_id'))
      filter (
        where nullif(public.employee_master_normalize_id(item->>'employee_id'), '')
          is not null
      )::integer,
    count(*) filter (
      where lower(concat_ws(' ',
        item->>'name', item->>'employee_id', item->>'responsible',
        item->>'onsite_trainer', item->>'online_leader',
        item->>'online_trainer'
      )) ~
        '(正在加载|loading|#(ref!|n/a|value!|error!))'
    )::integer
  into
    v_source_named_count,
    v_source_id_row_count,
    v_source_unique_id_count,
    v_loading_count
  from jsonb_array_elements(p_rows) item;

  select count(*)::integer
  into v_existing_count
  from session_private.online_training_roster_relationships;

  if v_source_named_count < 1 or v_source_unique_id_count < 1 then
    raise exception using
      errcode = '22023',
      message = 'schedule_roster_relationship_snapshot_empty';
  end if;
  if v_source_id_row_count <> v_source_unique_id_count then
    raise exception using
      errcode = '22023',
      message = 'schedule_roster_relationship_duplicate_employee_ids';
  end if;
  if v_loading_count > 0 then
    raise exception using
      errcode = '22023',
      message = 'schedule_roster_relationship_formula_loading';
  end if;
  if v_source_named_count - v_source_id_row_count >
      greatest(5, floor(v_source_named_count * 0.01)::integer) then
    raise exception using
      errcode = '22023',
      message = 'schedule_roster_relationship_missing_ids_exceeded';
  end if;
  if v_existing_count >= 100
     and v_source_unique_id_count * 100 < v_existing_count * 95 then
    raise exception using
      errcode = '22023',
      message = 'schedule_roster_relationship_health_guard';
  end if;

  delete from session_private.online_training_roster_relationships relation
  where relation.learner_employee_id is not null;

  with source_rows as materialized (
    select distinct on (public.employee_master_normalize_id(item->>'employee_id'))
      item,
      public.employee_master_normalize_id(item->>'employee_id') employee_no,
      session_private.online_training_roster_name_key(item->>'name') name_key,
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end source_row
    from jsonb_array_elements(p_rows) item
    where nullif(public.employee_master_normalize_id(item->>'employee_id'), '')
      is not null
    order by public.employee_master_normalize_id(item->>'employee_id'),
      case when coalesce(item->>'source_row', '') ~ '^\d+$'
        then (item->>'source_row')::integer end desc nulls last
  ), canonical_employees as materialized (
    select
      public.employee_master_normalize_id(employee.employee_no) employee_no,
      min(employee.id::text)::uuid employee_id
    from public.employees employee
    where employee.status in ('active', 'probation')
      and nullif(public.employee_master_normalize_id(employee.employee_no), '')
        is not null
    group by public.employee_master_normalize_id(employee.employee_no)
    having count(*) = 1
  ), roster_people as materialized (
    select source.name_key, employee.employee_id
    from source_rows source
    join canonical_employees employee using (employee_no)
    where nullif(source.name_key, '') is not null
  ), unique_people as materialized (
    select
      person.name_key,
      min(person.employee_id::text)::uuid employee_id
    from roster_people person
    group by person.name_key
    having count(distinct person.employee_id) = 1
  )
  insert into session_private.online_training_roster_relationships (
    learner_employee_id,
    learner_employee_no,
    responsible_employee_id,
    onsite_trainer_employee_id,
    online_trainer_employee_id,
    online_leader_employee_id,
    responsible_raw,
    onsite_trainer_raw,
    online_trainer_raw,
    online_leader_raw,
    source_row,
    refreshed_at
  )
  select
    learner.employee_id,
    source.employee_no,
    responsible.employee_id,
    onsite_trainer.employee_id,
    trainer.employee_id,
    leader.employee_id,
    nullif(btrim(source.item->>'responsible'), ''),
    nullif(btrim(source.item->>'onsite_trainer'), ''),
    nullif(btrim(source.item->>'online_trainer'), ''),
    nullif(btrim(source.item->>'online_leader'), ''),
    source.source_row,
    clock_timestamp()
  from source_rows source
  join canonical_employees learner using (employee_no)
  left join unique_people responsible
    on responsible.name_key = session_private.online_training_roster_name_key(
      source.item->>'responsible'
    )
  left join unique_people onsite_trainer
    on onsite_trainer.name_key = session_private.online_training_roster_name_key(
      source.item->>'onsite_trainer'
    )
  left join unique_people trainer
    on trainer.name_key = session_private.online_training_roster_name_key(
      source.item->>'online_trainer'
    )
  left join unique_people leader
    on leader.name_key = session_private.online_training_roster_name_key(
      source.item->>'online_leader'
    );

  select
    count(*)::integer,
    count(*) filter (
      where relation.responsible_employee_id is not null
    )::integer,
    count(*) filter (
      where relation.onsite_trainer_employee_id is not null
    )::integer,
    count(*) filter (
      where relation.online_trainer_employee_id is not null
    )::integer,
    count(*) filter (
      where relation.responsible_raw is not null
        and relation.responsible_employee_id is null
    )::integer,
    count(*) filter (
      where relation.onsite_trainer_raw is not null
        and relation.onsite_trainer_employee_id is null
    )::integer,
    count(*) filter (
      where relation.online_leader_employee_id is not null
    )::integer,
    count(*) filter (
      where relation.online_trainer_raw is not null
        and relation.online_trainer_employee_id is null
    )::integer,
    count(*) filter (
      where relation.online_leader_raw is not null
        and relation.online_leader_employee_id is null
    )::integer
  into
    v_row_count,
    v_responsible_count,
    v_onsite_trainer_count,
    v_trainer_count,
    v_unresolved_responsible_count,
    v_unresolved_onsite_trainer_count,
    v_leader_count,
    v_unresolved_trainer_count,
    v_unresolved_leader_count
  from session_private.online_training_roster_relationships relation;

  return jsonb_build_object(
    'rows', v_row_count,
    'source_named_rows', v_source_named_count,
    'source_id_rows', v_source_id_row_count,
    'previous_relationship_rows', v_existing_count,
    'responsible_links', v_responsible_count,
    'onsite_trainer_links', v_onsite_trainer_count,
    'trainer_links', v_trainer_count,
    'leader_links', v_leader_count,
    'unresolved_responsible_rows', v_unresolved_responsible_count,
    'unresolved_onsite_trainer_rows', v_unresolved_onsite_trainer_count,
    'unresolved_trainer_rows', v_unresolved_trainer_count,
    'unresolved_leader_rows', v_unresolved_leader_count
  );
end;
$$;

revoke all on function
  session_private.rebuild_online_training_roster_relationships(jsonb)
  from public, anon, authenticated, service_role;

create or replace function session_private.online_training_relationship_allows(
  p_caller_employee_id uuid,
  p_target_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_caller_employee_id is not null
    and p_target_employee_id is not null
    and (
      p_caller_employee_id = p_target_employee_id
      or exists (
        select 1
        from session_private.online_training_roster_relationships relation
        where relation.learner_employee_id = p_target_employee_id
          and (
            relation.onsite_trainer_employee_id = p_caller_employee_id
            or relation.online_trainer_employee_id = p_caller_employee_id
            or (
              relation.online_leader_employee_id = p_caller_employee_id
              and relation.online_trainer_employee_id is not null
            )
          )
      )
      or exists (
        select 1
        from session_private.online_training_roster_relationships relation
        where relation.online_trainer_employee_id = p_target_employee_id
          and relation.online_leader_employee_id = p_caller_employee_id
      )
    );
$$;

create or replace function session_private.online_training_roster_person_id(
  p_name text
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  with candidates as materialized (
    select distinct employee.id employee_id
    from public.report_employee_directory_cache directory
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        public.employee_master_normalize_id(directory.employee_no)
    where directory.source_kind = 'roster'
      and employee.status in ('active', 'probation')
      and session_private.online_training_roster_name_key(directory.full_name) =
        session_private.online_training_roster_name_key(p_name)
      and nullif(session_private.online_training_roster_name_key(p_name), '')
        is not null
  )
  select case when count(*) = 1
    then min(candidate.employee_id::text)::uuid else null end
  from candidates candidate;
$$;

create or replace function session_private.online_training_roster_actor_label(
  p_name text,
  p_employee_no text default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with explicit_number as materialized (
    select min(public.employee_master_normalize_id(employee.employee_no))
      employee_no
    from public.employees employee
    where employee.status in ('active', 'probation')
      and nullif(public.employee_master_normalize_id(p_employee_no), '')
        is not null
      and public.employee_master_normalize_id(employee.employee_no) =
        public.employee_master_normalize_id(p_employee_no)
      and session_private.online_training_roster_name_key(employee.full_name) =
        session_private.online_training_roster_name_key(p_name)
    having count(distinct employee.id) = 1
  ), master_number as materialized (
    select min(public.employee_master_normalize_id(employee.employee_no))
      employee_no
    from public.employees employee
    where employee.status in ('active', 'probation')
      and nullif(session_private.online_training_roster_name_key(p_name), '')
        is not null
      and session_private.online_training_roster_name_key(employee.full_name) =
        session_private.online_training_roster_name_key(p_name)
    having count(distinct employee.id) = 1
  ), number_label as materialized (
    select min(nullif(btrim(directory.full_name), '')) actor_name
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
      and public.employee_master_normalize_id(directory.employee_no) =
        coalesce(
          (select employee_no from explicit_number),
          (select employee_no from master_number)
        )
    having count(distinct session_private.online_training_roster_name_key(
      directory.full_name
    )) = 1
  ), exact_roster_label as materialized (
    select min(nullif(btrim(directory.full_name), '')) actor_name
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
      and nullif(session_private.online_training_roster_name_key(p_name), '')
        is not null
      and session_private.online_training_roster_name_key(directory.full_name) =
        session_private.online_training_roster_name_key(p_name)
    having count(distinct public.employee_master_normalize_id(
      directory.employee_no
    )) = 1
  )
  select coalesce(
    (select actor_name from number_label),
    (select actor_name from exact_roster_label),
    nullif(btrim(p_name), '')
  );
$$;

revoke all on function
  session_private.online_training_relationship_allows(uuid,uuid),
  session_private.online_training_roster_person_id(text),
  session_private.online_training_roster_actor_label(text,text)
  from public, anon, authenticated, service_role;

-- Exact report subjects for one A/B/C/D roster actor. This is deliberately
-- narrower than online_training_relationship_allows(): a C leader may read
-- the learners below its resolved D trainers, but writes the guidance report
-- about each D trainer rather than selecting those learners as report subjects.
--   B (onsite trainer) -> G employee
--   D (online trainer) -> G learner
--   C (online leader)  -> its distinct D online trainers
-- A is resolved and retained for audit/sync completeness, but is deliberately
-- not an Online Training permission edge by itself.
create or replace function session_private.online_training_assignment_targets(
  p_actor_employee_id uuid
)
returns table(target_employee_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct assignment.target_employee_id
  from (
    select relation.learner_employee_id target_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.onsite_trainer_employee_id = p_actor_employee_id
       or relation.online_trainer_employee_id = p_actor_employee_id

    union all

    select relation.online_trainer_employee_id target_employee_id
    from session_private.online_training_roster_relationships relation
    where relation.online_leader_employee_id = p_actor_employee_id
      and relation.online_trainer_employee_id is not null
  ) assignment
  where p_actor_employee_id is not null
    and assignment.target_employee_id is not null;
$$;

revoke all on function
  session_private.online_training_assignment_targets(uuid)
  from public, anon, authenticated, service_role;

-- Rebuild the UUID relationship in the same transaction as the existing
-- directory/scope cache.  If relationship resolution fails, the complete
-- schedule refresh rolls back rather than publishing half-updated access.
alter function public.sync_report_employee_directory(jsonb)
  rename to sync_report_employee_directory_stable_relationship_inner_v1;
revoke all on function
  public.sync_report_employee_directory_stable_relationship_inner_v1(jsonb)
  from public, anon, authenticated, service_role;

create function public.sync_report_employee_directory(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_directory jsonb;
  v_relationships jsonb;
begin
  v_directory :=
    public.sync_report_employee_directory_stable_relationship_inner_v1(p_rows);
  v_relationships :=
    session_private.rebuild_online_training_roster_relationships(p_rows);
  return v_directory || jsonb_build_object(
    'online_training_relationships', v_relationships
  );
end;
$$;

revoke all on function public.sync_report_employee_directory(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_directory(jsonb)
  to service_role;

-- Backfill from an already accepted snapshot when one exists. A fresh/local
-- database may legitimately have no Google snapshot yet; in that case keep the
-- relationship table untouched and let the first accepted sync populate it.
-- Never turn a missing snapshot into [] because this table is a replacement
-- cache and empty input must fail closed rather than erase healthy edges.
do $online_training_relationship_backfill$
declare
  v_payload jsonb;
begin
  select snapshot.payload
  into v_payload
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表'
  order by snapshot.synced_at desc
  limit 1;

  if v_payload is not null then
    perform session_private.rebuild_online_training_roster_relationships(
      v_payload
    );
  end if;
end;
$online_training_relationship_backfill$;

create or replace function public.online_training_is_assigned_member(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  return v_caller_employee_id is not null
    and exists (
      select 1
      from session_private.online_training_assignment_targets(
        v_caller_employee_id
      ) assignment
      where assignment.target_employee_id = p_employee_id
    );
end;
$$;

comment on function public.online_training_is_assigned_member(uuid) is
  'Online-training report-subject helper only: stable B/D->G or C->D assignment for the linked caller; independent of generic backend data_scope and unused as authority outside training RPCs.';

-- This scope is intentionally local to the online-training/report RPCs.  A
-- training actor's stable A/B/C/D/G/H assignment is authoritative for this
-- module even when the account's generic backend data_scope is `self`; the
-- generic backend scope function and every other backend module stay
-- unchanged. Founder/explicit all-data accounts keep the pre-existing generic
-- ceiling. Every other account is limited to self, direct B/D learners, or
-- (for an online leader) its D trainers and only the learners attached to one
-- of those resolved D trainers.
create or replace function public.online_training_employee_in_scope(
  p_employee_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
  v_data_scope text;
  v_role_code text;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_data_scope, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return false; end if;
  if v_role_code = 'founder' or v_data_scope = 'all' then
    return public.backend_employee_in_scope(p_employee_id);
  end if;
  return session_private.online_training_relationship_allows(
    v_caller_employee_id,
    p_employee_id
  );
end;
$$;

create or replace function public.online_training_employee_history_in_scope(
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.online_training_employee_in_scope(p_employee_id);
$$;

create or replace function public.online_training_caller_is_report_trainer(
  p_report_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
begin
  if p_report_id is null
     or not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  return v_caller_employee_id is not null
    and session_private.online_training_report_trainer_employee_id(p_report_id)
      = v_caller_employee_id
    and exists (
      select 1
      from public.online_training_report_members member
      where member.report_id = p_report_id
        and member.employee_id is not null
    )
    and not exists (
      select 1
      from public.online_training_report_members member
      where member.report_id = p_report_id
        and not public.online_training_employee_in_scope(member.employee_id)
    );
end;
$$;

create or replace function public.online_training_can_view_report(
  p_report_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_status text;
  v_author_employee_id uuid;
  v_can_manage boolean;
begin
  if not session_private.current_app_session_is_valid('admin')
     or not public.online_training_can_view_module() then
    return false;
  end if;

  select report.created_by, report.status, report.author_employee_id
  into v_created_by, v_status, v_author_employee_id
  from public.online_training_reports report
  where report.id = p_report_id;
  if not found then return false; end if;
  if public.is_founder() then return true; end if;

  -- Summaries/attachments are report-wide, so one unrelated member makes the
  -- whole object unsafe for a limited account.
  if exists (
    select 1
    from public.online_training_report_members member
    where member.report_id = p_report_id
      and not public.online_training_employee_in_scope(member.employee_id)
  ) then return false; end if;

  v_can_manage := public.has_permission('online_training.report.manage');
  if v_status <> 'published'
     and v_created_by <> (select auth.uid())
     and not v_can_manage then
    return false;
  end if;

  return public.online_training_caller_is_report_trainer(p_report_id)
    or public.online_training_employee_in_scope(v_author_employee_id)
    or exists (
      select 1
      from public.online_training_report_members member
      where member.report_id = p_report_id
        and public.online_training_employee_in_scope(member.employee_id)
    );
end;
$$;

revoke all on function
  public.online_training_is_assigned_member(uuid),
  public.online_training_employee_in_scope(uuid),
  public.online_training_employee_history_in_scope(uuid),
  public.online_training_caller_is_report_trainer(uuid),
  public.online_training_can_view_report(uuid)
  from public, anon;
grant execute on function
  public.online_training_is_assigned_member(uuid),
  public.online_training_employee_in_scope(uuid),
  public.online_training_employee_history_in_scope(uuid),
  public.online_training_caller_is_report_trainer(uuid),
  public.online_training_can_view_report(uuid)
  to authenticated, service_role;

-- The retained report writer historically required every selected target's
-- own roster row to contain D. That is valid for D -> G reports but rejects
-- the two other intended report relationships: B -> G ordinary/onsite staff
-- and C -> D guidance reports. Keep the schedule-row requirement and accept a
-- blank target D only when the linked report author has an exact stable report
-- assignment (or holds the explicit report-management permission).
do $allow_all_stable_training_report_subjects$
declare
  v_signature constant regprocedure :=
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'::regprocedure;
  v_definition text;
  v_patched text;
  v_old_guard constant text := $old_guard$
    if v_schedule_row = '{}'::jsonb
       or nullif(btrim(v_schedule_row->>'online_trainer'), '') is null then
      raise exception '% 不在当前线上培训排班或未配置线上培训员',
        v_employee.employee_no;
    end if;
$old_guard$;
  v_new_guard constant text := $new_guard$
    if v_schedule_row = '{}'::jsonb then
      raise exception '% 不在当前培训排班', v_employee.employee_no;
    end if;
    if nullif(btrim(v_schedule_row->>'online_trainer'), '') is null
       and not public.has_permission('online_training.report.manage')
       and not exists (
         select 1
         from session_private.online_training_assignment_targets(
           v_author_employee_id
         ) assignment
         where assignment.target_employee_id = v_employee.id
       ) then
      raise exception '% 未配置当前账号可填报的培训关系',
        v_employee.employee_no;
    end if;
$new_guard$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(v_definition, v_old_guard, v_new_guard);
  if v_patched = v_definition then
    raise exception 'online_training_report_subject_guard_definition_changed';
  end if;
  execute v_patched;
end;
$allow_all_stable_training_report_subjects$;

-- The read relationship for a C leader intentionally includes both D and the
-- learners below D. Report subjects are narrower: B/D write G reports and C
-- writes D guidance reports. Enforce that distinction at the public mutation
-- boundary for every limited account, not merely in the UI selector. Only the
-- pre-existing Founder/explicit-all administration path may act for a selected
-- training actor outside the caller's own report-subject relationship.
alter function public.online_training_save_report(jsonb,jsonb)
  rename to online_training_save_report_stable_relationship_inner_v1;
alter function
  public.online_training_save_report_stable_relationship_inner_v1(jsonb,jsonb)
  set schema session_private;
revoke all on function
  session_private.online_training_save_report_stable_relationship_inner_v1(jsonb,jsonb)
  from public, anon, authenticated, service_role;

create function public.online_training_save_report(
  p_report jsonb,
  p_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_employee_id uuid;
  v_data_scope text;
  v_role_code text;
  v_member jsonb;
  v_employee_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if jsonb_typeof(p_report) is distinct from 'object'
     or jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '报告数据格式不正确';
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_data_scope, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found or v_caller_employee_id is null then
    raise exception 'permission_denied';
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    begin
      v_employee_id := nullif(btrim(v_member->>'employee_id'), '')::uuid;
    exception when invalid_text_representation then
      raise exception '报告成员缺少有效员工档案关联';
    end;
    if v_employee_id is null
       or not public.online_training_employee_in_scope(v_employee_id) then
      raise exception '报告中包含超出培训关系范围的员工';
    end if;
    if v_role_code <> 'founder'
       and v_data_scope is distinct from 'all'
       and not exists (
         select 1
         from session_private.online_training_assignment_targets(
           v_caller_employee_id
         ) assignment
         where assignment.target_employee_id = v_employee_id
       ) then
      raise exception '报告对象不属于当前账号的可填报培训关系';
    end if;
  end loop;

  return session_private.online_training_save_report_stable_relationship_inner_v1(
    p_report,
    p_members
  );
end;
$$;

revoke all on function public.online_training_save_report(jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.online_training_save_report(jsonb,jsonb)
  to authenticated, service_role;
comment on function public.online_training_save_report(jsonb,jsonb) is
  'Online-training mutation boundary: every member must be readable; limited B/D callers may submit only G targets and limited C callers only D guidance targets from the accepted stable roster relationship.';

-- Trainer summaries are grouped by the display text stored in A/B/C/D and in
-- historical reports. The canonical employee master may deliberately use a
-- different full name (for example the roster label "大龙" maps through H to
-- the master employee "VIN 大龙"). Keep the existing exact employee/lifecycle
-- resolver as a fallback, and first resolve an exact unique current-roster name
-- to H, then H to the employee master. This never borrows a learner's identity.
alter function public.online_training_resolve_trainer_identities(jsonb)
  rename to online_training_resolve_trainer_identities_employee_master_v1;
alter function
  public.online_training_resolve_trainer_identities_employee_master_v1(jsonb)
  set schema session_private;
revoke all on function
  session_private.online_training_resolve_trainer_identities_employee_master_v1(jsonb)
  from public, anon, authenticated, service_role;

create function public.online_training_resolve_trainer_identities(
  p_candidates jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_legacy jsonb;
  v_result jsonb;
begin
  -- The retained implementation owns the session, module-permission, payload
  -- type and 200-candidate guards. Call it before reading the JSON input.
  v_legacy :=
    session_private.online_training_resolve_trainer_identities_employee_master_v1(
      p_candidates
    );

  with requested as materialized (
    select distinct on (trainer_key)
      candidate.ordinality,
      trainer_key,
      btrim(coalesce(candidate.item->>'trainer_employee_no', ''))
        input_employee_no,
      btrim(coalesce(candidate.item->>'trainer_name', '')) input_name
    from jsonb_array_elements(p_candidates) with ordinality
      candidate(item, ordinality)
    cross join lateral (
      select btrim(coalesce(candidate.item->>'trainer_key', '')) trainer_key
    ) normalized
    where trainer_key <> ''
    order by trainer_key, candidate.ordinality
  ), roster_number as materialized (
    select
      requested.trainer_key,
      min(public.employee_master_normalize_id(directory.employee_no))
        employee_no
    from requested
    join public.report_employee_directory_cache directory
      on directory.source_kind = 'roster'
      and session_private.online_training_roster_name_key(directory.full_name) =
        session_private.online_training_roster_name_key(requested.input_name)
      and nullif(
        session_private.online_training_roster_name_key(requested.input_name),
        ''
      ) is not null
    where nullif(
      public.employee_master_normalize_id(directory.employee_no),
      ''
    ) is not null
    group by requested.trainer_key
    having count(distinct public.employee_master_normalize_id(
      directory.employee_no
    )) = 1
  ), roster_identity as materialized (
    select
      roster.trainer_key,
      min(employee.id::text)::uuid employee_id,
      min(nullif(btrim(employee.employee_no), '')) employee_no,
      min(nullif(btrim(employee.full_name), '')) full_name,
      coalesce(
        min(employee.hire_date),
        min(lifecycle.first_hire_date)
      ) hire_date
    from roster_number roster
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        roster.employee_no
      and employee.status in ('active', 'probation')
    left join lateral (
      select coalesce(
        min(case
          when coalesce(event.snapshot->>'hire_date', '') ~
            '^\d{4}-\d{2}-\d{2}$'
            then (event.snapshot->>'hire_date')::date
        end),
        min(event.effective_date) filter (where event.event_type = 'join')
      ) first_hire_date
      from public.employee_lifecycle_events event
      where event.employee_id = employee.id
    ) lifecycle on true
    group by roster.trainer_key
    having count(distinct employee.id) = 1
  ), scoped_roster_identity as materialized (
    select roster.*
    from roster_identity roster
    where public.online_training_employee_in_scope(roster.employee_id)
  ), legacy as materialized (
    select item
    from jsonb_array_elements(
      case when jsonb_typeof(v_legacy) = 'array'
        then v_legacy else '[]'::jsonb end
    ) entry(item)
  ), resolved as materialized (
    select
      requested.ordinality,
      requested.trainer_key,
      requested.input_employee_no,
      requested.input_name,
      roster.employee_no roster_employee_no,
      roster.full_name roster_full_name,
      roster.hire_date roster_hire_date,
      legacy.item legacy_item
    from requested
    left join scoped_roster_identity roster using (trainer_key)
    left join legacy
      on legacy.item->>'trainer_key' = requested.trainer_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'trainer_key', resolved.trainer_key,
    'input_employee_no', resolved.input_employee_no,
    'input_name', resolved.input_name,
    'employee_no', coalesce(
      resolved.roster_employee_no,
      nullif(resolved.legacy_item->>'employee_no', '')
    ),
    'full_name', coalesce(
      resolved.roster_full_name,
      nullif(resolved.legacy_item->>'full_name', '')
    ),
    'hire_date', coalesce(
      resolved.roster_hire_date::text,
      nullif(resolved.legacy_item->>'hire_date', '')
    )
  ) order by resolved.ordinality), '[]'::jsonb)
  into v_result
  from resolved
  where resolved.roster_employee_no is not null
     or resolved.legacy_item is not null;

  return v_result;
end;
$$;

revoke all on function
  public.online_training_resolve_trainer_identities(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.online_training_resolve_trainer_identities(jsonb)
  to authenticated;

comment on function public.online_training_resolve_trainer_identities(jsonb) is
  'Bounded scope-safe trainer identity lookup: exact unique roster display name -> H employee number -> authoritative employee/lifecycle hire date, with the pre-existing master resolver as fallback.';

-- Preserve the context response contract while replacing its name-based
-- personal roster with UUID-backed current relationships.
alter function public.online_training_context()
  rename to online_training_context_stable_relationship_inner_v1;
alter function public.online_training_context_stable_relationship_inner_v1()
  set schema session_private;
revoke all on function
  session_private.online_training_context_stable_relationship_inner_v1()
  from public, anon, authenticated, service_role;

create function public.online_training_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_context jsonb;
  v_caller_employee_id uuid;
  v_my_roster jsonb := '[]'::jsonb;
  v_manager_options jsonb := '[]'::jsonb;
  v_filter_options jsonb := '{}'::jsonb;
  v_actor_name text;
  v_actor_role text;
begin
  v_context :=
    session_private.online_training_context_stable_relationship_inner_v1();

  select access.employee_id
  into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if v_caller_employee_id is not null then
    select actor.actor_name, actor.actor_role
    into v_actor_name, v_actor_role
    from (
      select 1 priority, relation.online_trainer_raw actor_name,
        'online_trainer' actor_role
      from session_private.online_training_roster_relationships relation
      where relation.online_trainer_employee_id = v_caller_employee_id
      union all
      select 2, relation.onsite_trainer_raw, 'onsite_trainer'
      from session_private.online_training_roster_relationships relation
      where relation.onsite_trainer_employee_id = v_caller_employee_id
      union all
      select 3, relation.online_leader_raw, 'online_leader'
      from session_private.online_training_roster_relationships relation
      where relation.online_leader_employee_id = v_caller_employee_id
    ) actor
    where nullif(btrim(actor.actor_name), '') is not null
    order by actor.priority, actor.actor_name
    limit 1;
  end if;

  if v_caller_employee_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', employee.id,
      'employee_no', employee.employee_no,
      'full_name', coalesce(nullif(btrim(directory.full_name), ''), employee.full_name),
      'status', employee.status,
      'hire_date', employee.hire_date,
      'country', coalesce(nullif(btrim(directory.country_name), ''), employee.country, employee.nationality, ''),
      'position', coalesce(directory.position_name, ''),
      'team', coalesce(directory.team_name, ''),
      'group', coalesce(directory.group_name, ''),
      'shift', coalesce(directory.shift_name, ''),
      'platform', coalesce(directory.platform_name, ''),
      'work_content', coalesce(employee.work_content, ''),
      'responsible', coalesce(directory.responsible, employee.person_in_charge, employee.leader_name, ''),
      'onsite_trainer', coalesce(directory.onsite_trainer, employee.on_site_trainer, ''),
      'online_leader', coalesce(directory.online_leader, employee.online_leader, ''),
      'online_trainer', coalesce(directory.online_trainer, employee.online_trainer, employee.trainer_name, '')
    ) order by directory.team_name, directory.group_name,
      directory.position_name,
      coalesce(nullif(btrim(directory.full_name), ''), employee.full_name)), '[]'::jsonb)
    into v_my_roster
    from session_private.online_training_assignment_targets(
      v_caller_employee_id
    ) assignment
    join public.employees employee
      on employee.id = assignment.target_employee_id
    join public.report_employee_directory_cache directory
      on public.employee_master_normalize_id(directory.employee_no) =
        public.employee_master_normalize_id(employee.employee_no)
      and directory.source_kind = 'roster'
    where public.online_training_employee_in_scope(employee.id);
  end if;

  -- Keep the administrator selector and trainer filter aligned with every
  -- report-producing role. Values remain inside the same employee scope and
  -- use the schedule's display labels so the roster lookup can resolve B/C/D.
  with visible_actor_names as materialized (
    select actor.actor_name
    from (
      select relation.onsite_trainer_employee_id actor_employee_id,
        relation.onsite_trainer_raw actor_name
      from session_private.online_training_roster_relationships relation
      union all
      select relation.online_leader_employee_id,
        relation.online_leader_raw
      from session_private.online_training_roster_relationships relation
      union all
      select relation.online_trainer_employee_id,
        relation.online_trainer_raw
      from session_private.online_training_roster_relationships relation
    ) actor
    where actor.actor_employee_id is not null
      and nullif(btrim(actor.actor_name), '') is not null
      and public.online_training_employee_in_scope(actor.actor_employee_id)
  ), combined_options as materialized (
    select option.value
    from jsonb_array_elements_text(
      case when jsonb_typeof(v_context->'manager_options') = 'array'
        then v_context->'manager_options' else '[]'::jsonb end
    ) option(value)
    where nullif(btrim(option.value), '') is not null
    union
    select btrim(actor.actor_name)
    from visible_actor_names actor
  )
  select coalesce(jsonb_agg(option.value order by option.value), '[]'::jsonb)
  into v_manager_options
  from combined_options option;

  v_filter_options :=
    coalesce(v_context->'filter_options', '{}'::jsonb)
    || jsonb_build_object('trainer', v_manager_options);

  return v_context || jsonb_build_object(
    'my_roster', v_my_roster,
    'manager_options', v_manager_options,
    'filter_options', v_filter_options,
    'auto_assignment',
      coalesce(v_context->'auto_assignment', '{}'::jsonb)
      || jsonb_build_object(
        'linked', v_caller_employee_id is not null,
        'matched', jsonb_array_length(v_my_roster) > 0,
        'member_count', jsonb_array_length(v_my_roster),
        'identity_mode', 'stable_employee_uuid',
        'trainer_name', coalesce(nullif(btrim(v_actor_name), ''),
          v_context#>>'{auto_assignment,trainer_name}', ''),
        'reporter_role', coalesce(v_actor_role, '')
      )
  );
end;
$$;

revoke all on function public.online_training_context()
  from public, anon;
grant execute on function public.online_training_context()
  to authenticated;

create or replace function public.online_training_roster_for_trainer(
  p_trainer_name text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trainer_employee_id uuid :=
    session_private.online_training_roster_person_id(p_trainer_name);
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module()
     or not public.has_permission('online_training.report.manage') then
    raise exception 'permission_denied';
  end if;
  if v_trainer_employee_id is null
     or not public.online_training_employee_in_scope(v_trainer_employee_id) then
    return '[]'::jsonb;
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', employee.id,
      'employee_no', employee.employee_no,
      'full_name', coalesce(nullif(btrim(directory.full_name), ''), employee.full_name),
      'status', employee.status,
      'hire_date', employee.hire_date,
      'country', coalesce(nullif(btrim(directory.country_name), ''), employee.country, employee.nationality, ''),
      'position', coalesce(directory.position_name, ''),
      'team', coalesce(directory.team_name, ''),
      'group', coalesce(directory.group_name, ''),
      'shift', coalesce(directory.shift_name, ''),
      'platform', coalesce(directory.platform_name, ''),
      'work_content', coalesce(employee.work_content, ''),
      'responsible', coalesce(directory.responsible, employee.person_in_charge, employee.leader_name, ''),
      'onsite_trainer', coalesce(directory.onsite_trainer, employee.on_site_trainer, ''),
      'online_leader', coalesce(directory.online_leader, employee.online_leader, ''),
      'online_trainer', coalesce(directory.online_trainer, employee.online_trainer, employee.trainer_name, '')
    ) order by directory.team_name, directory.group_name,
      directory.position_name,
      coalesce(nullif(btrim(directory.full_name), ''), employee.full_name))
    from session_private.online_training_assignment_targets(
      v_trainer_employee_id
    ) assignment
    join public.employees employee
      on employee.id = assignment.target_employee_id
    join public.report_employee_directory_cache directory
      on public.employee_master_normalize_id(directory.employee_no) =
        public.employee_master_normalize_id(employee.employee_no)
      and directory.source_kind = 'roster'
    where public.online_training_employee_in_scope(employee.id)
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.online_training_roster_for_trainer(text)
  from public, anon;
grant execute on function public.online_training_roster_for_trainer(text)
  to authenticated;

-- Historical reports may contain the master name while the live D column uses
-- a shorter roster label. Canonicalize only the aggregation key through the
-- exact employee-number/name bridge so old and new reports stay on one trainer
-- row; keep the displayed label and all report data unchanged.
do $canonicalize_online_training_report_actor_key$
declare
  v_signature constant regprocedure :=
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure;
  v_definition text;
  v_patched text;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  v_patched := replace(
    v_definition,
    'public.online_training_identity_key(report.trainer_name) trainer_key,',
    'public.online_training_identity_key(' ||
      'session_private.online_training_roster_actor_label(' ||
        'report.trainer_name, report.author_employee_no' ||
      ')' ||
    ') trainer_key,'
  );
  if v_patched = v_definition then
    raise exception 'online_training_report_actor_key_definition_changed';
  end if;
  execute v_patched;
end;
$canonicalize_online_training_report_actor_key$;

-- The two server-paginated directories used a direct generic backend predicate
-- instead of the central online-training boundary.  Narrow exactly that
-- audited predicate; fail migration if a later definition changed shape.
do $narrow_online_training_directories$
declare
  v_signature regprocedure;
  v_definition text;
  v_narrowed text;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_narrowed := replace(
      v_definition,
      'public.backend_employee_in_scope(employee.id)',
      'public.online_training_employee_in_scope(employee.id)'
    );
    if v_narrowed = v_definition then
      raise exception 'online_training_directory_scope_definition_changed: %',
        v_signature;
    end if;
    execute v_narrowed;
  end loop;
end;
$narrow_online_training_directories$;

comment on table session_private.online_training_roster_relationships is
  'Server-only A/B/C/D/G/H roster hierarchy resolved to stable employee UUIDs; A is audit-only, B/D target G, C can read D plus each resolved D learner while report subjects remain D, and ambiguous names fail closed.';
comment on function public.online_training_employee_in_scope(uuid) is
  'Current-session online-training-only scope: self plus stable B/D->G and C->D->G UUID relationships; Founder/all-data retain the generic backend ceiling. Does not alter backend_employee_in_scope or any other module.';

notify pgrst, 'reload schema';
commit;
