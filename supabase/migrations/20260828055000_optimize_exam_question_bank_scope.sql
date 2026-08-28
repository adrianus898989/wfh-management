-- Resolve the caller's exam question scope once per dashboard request.
--
-- The prior reader called exam_team_position_in_scope once for every question
-- and again for every team / series / position option.  That helper validates
-- the lease and rebuilds current roster scope on each invocation, so a 2k-row
-- question bank could turn one page load into thousands of directory scans.
-- Keep the same authorization semantics and response contract, but materialize
-- the allowed team / team-position keys once and reuse one scoped question set.

create or replace function public.admin_exam_question_bank_dashboard(
  p_search text default '',
  p_team text default '',
  p_position text default '',
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
  v_user_id uuid := (select auth.uid());
  v_scope text;
  v_role_code text;
  v_employee_id uuid;
  v_full_scope boolean := false;
  v_selected_team_ids uuid[] := array[]::uuid[];
  v_selected_position_ids uuid[] := array[]::uuid[];
  v_allowed_team_keys text[] := array[]::text[];
  v_allowed_pair_keys text[] := array[]::text[];
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_search text := btrim(coalesce(p_search, ''));
  v_team_requested boolean := btrim(coalesce(p_team, '')) <> '';
  v_position_requested boolean := btrim(coalesce(p_position, '')) <> '';
  v_result jsonb;
begin
  -- has_permission is also the single admin lease / IP / AAL boundary for this
  -- public SECURITY DEFINER RPC.  No private scope helper is exposed.
  if not public.has_permission('exam.question_bank.view') then
    raise exception 'permission_denied';
  end if;

  select access.data_scope, role.code, access.employee_id
  into v_scope, v_role_code, v_employee_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if found then
    v_full_scope := v_role_code = 'founder' or v_scope = 'all';
  end if;

  if not v_full_scope and v_scope = 'assigned_teams' then
    select
      coalesce((
        select array_agg(filter.team_id order by filter.team_id)
        from public.user_scope_team_filters filter
        where filter.auth_user_id = v_user_id
      ), array[]::uuid[]),
      coalesce((
        select array_agg(filter.position_id order by filter.position_id)
        from public.user_scope_position_filters filter
        where filter.auth_user_id = v_user_id
      ), array[]::uuid[])
    into v_selected_team_ids, v_selected_position_ids;
  end if;

  -- own_team remains team-wide (the current production rule).  assigned_teams
  -- is team-wide when no position filter exists, otherwise the same current
  -- roster row must satisfy both a selected team and a selected position.
  if not v_full_scope
     and (
       (v_scope = 'own_team' and v_employee_id is not null)
       or (
         v_scope = 'assigned_teams'
         and cardinality(v_selected_team_ids) > 0
       )
     ) then
    with directory_scope as materialized (
      select
        directory.employee_id,
        directory.current_team_id,
        directory.current_position_id,
        public.exam_norm(team.name) as team_key,
        case
          when position.id is null then null
          else public.exam_norm(position.name)
        end as position_key,
        position.id as resolved_position_id
      from scope_private.current_employee_scope_directory() directory
      join public.teams team on team.id = directory.current_team_id
      left join public.positions position on position.id = directory.current_position_id
      where
        (
          v_scope = 'own_team'
          and directory.employee_id = v_employee_id
        )
        or (
          v_scope = 'assigned_teams'
          and directory.current_team_id = any(v_selected_team_ids)
          and position.id is not null
          and (
            cardinality(v_selected_position_ids) = 0
            or directory.current_position_id = any(v_selected_position_ids)
          )
        )
    )
    select
      coalesce(
        array_agg(distinct scoped.team_key) filter (
          where scoped.team_key is not null
            and (
              v_scope = 'own_team'
              or (
                v_scope = 'assigned_teams'
                and cardinality(v_selected_position_ids) = 0
                and scoped.resolved_position_id is not null
              )
            )
        ),
        array[]::text[]
      ),
      coalesce(
        array_agg(
          distinct jsonb_build_array(scoped.team_key, scoped.position_key)::text
        ) filter (
          where v_scope = 'assigned_teams'
            and cardinality(v_selected_position_ids) > 0
            and scoped.team_key is not null
            and scoped.position_key is not null
            and scoped.resolved_position_id is not null
        ),
        array[]::text[]
      )
    into v_allowed_team_keys, v_allowed_pair_keys
    from directory_scope scoped;
  end if;

  with scoped_questions as materialized (
    select
      question.id,
      question.external_key,
      question.series_name,
      question.team_name,
      question.position_name,
      question.question_en,
      question.question_zh,
      question.question_vi,
      question.points,
      question.difficulty,
      question.image_urls,
      question.active,
      question.revision,
      question.source,
      question.sync_status,
      question.backend_updated_at
    from public.exam_questions question
    where question.active
      and (
        v_full_scope
        or public.exam_norm(question.team_name) = any(v_allowed_team_keys)
        or (
          nullif(btrim(coalesce(question.position_name, '')), '') is not null
          and jsonb_build_array(
            public.exam_norm(question.team_name),
            public.exam_norm(question.position_name)
          )::text = any(v_allowed_pair_keys)
        )
      )
  ),
  filtered as materialized (
    select question.*
    from scoped_questions question
    where (
        v_search = ''
        or question.external_key ilike '%' || v_search || '%'
        or question.question_en ilike '%' || v_search || '%'
        or question.question_zh ilike '%' || v_search || '%'
        or question.question_vi ilike '%' || v_search || '%'
      )
      and (
        not v_team_requested
        or public.exam_norm(question.team_name) = public.exam_norm(p_team)
      )
      and (
        not v_position_requested
        or public.exam_norm(question.position_name) = public.exam_norm(p_position)
      )
  )
  select jsonb_build_object(
    'questions', coalesce((
      select jsonb_agg(to_jsonb(page_row) order by page_row.external_key)
      from (
        select *
        from filtered
        order by external_key
        limit v_size
        offset (v_page - 1) * v_size
      ) page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'page', v_page,
    'page_size', v_size,
    'teams', coalesce((
      select jsonb_agg(name.value order by name.value)
      from (
        select distinct btrim(question.team_name) as value
        from scoped_questions question
        where nullif(btrim(question.team_name), '') is not null
      ) name
    ), '[]'::jsonb),
    'series', coalesce((
      select jsonb_agg(name.value order by name.value)
      from (
        select distinct btrim(question.series_name) as value
        from scoped_questions question
        where nullif(btrim(question.series_name), '') is not null
      ) name
    ), '[]'::jsonb),
    'positions', coalesce((
      select jsonb_agg(name.value order by name.value)
      from (
        select distinct btrim(question.position_name) as value
        from scoped_questions question
        where nullif(btrim(question.position_name), '') is not null
      ) name
    ), '[]'::jsonb),
    'last_sync', coalesce((
      select jsonb_build_object('status', sync_run.status)
      from public.exam_sync_runs sync_run
      order by sync_run.started_at desc
      limit 1
    ), '{}'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_exam_question_bank_dashboard(
  text, text, text, integer, integer
) from public, anon;
grant execute on function public.admin_exam_question_bank_dashboard(
  text, text, text, integer, integer
) to authenticated, service_role;

