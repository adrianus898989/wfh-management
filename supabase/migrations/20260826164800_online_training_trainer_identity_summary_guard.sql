-- Resolve trainer identities in one bounded database call.  The online
-- training people RPC is trainee-centred, so trainee employee numbers must
-- never be reused as the trainer's identity.  Exact employee number wins;
-- exact, unique normalized name is the fallback.  Removed employees remain
-- resolvable through lifecycle history without recreating a live employee.

create index if not exists employee_lifecycle_online_training_employee_no_idx
  on public.employee_lifecycle_events (
    public.online_training_identity_key(employee_no)
  )
  where nullif(btrim(employee_no), '') is not null;

create index if not exists employee_lifecycle_online_training_full_name_idx
  on public.employee_lifecycle_events (
    public.online_training_identity_key(full_name)
  )
  where nullif(btrim(full_name), '') is not null;

create or replace function public.online_training_resolve_trainer_identities(
  p_candidates jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '无权查看线上培训模块';
  end if;
  if jsonb_typeof(p_candidates) is distinct from 'array' then
    raise exception using
      errcode = '22023',
      message = 'online_training_trainer_candidates_invalid';
  end if;
  if jsonb_array_length(p_candidates) > 200 then
    raise exception using
      errcode = '22023',
      message = 'online_training_trainer_candidates_too_many';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_candidates) candidate(item)
    where jsonb_typeof(candidate.item) is distinct from 'object'
  ) then
    raise exception using
      errcode = '22023',
      message = 'online_training_trainer_candidates_invalid';
  end if;

  with requested as materialized (
    select distinct on (trainer_key)
      candidate.ordinality,
      trainer_key,
      btrim(coalesce(candidate.item->>'trainer_employee_no', ''))
        input_employee_no,
      btrim(coalesce(candidate.item->>'trainer_name', '')) input_name,
      public.online_training_identity_key(
        candidate.item->>'trainer_employee_no'
      ) employee_no_key,
      public.online_training_identity_key(
        candidate.item->>'trainer_name'
      ) name_key
    from jsonb_array_elements(p_candidates) with ordinality
      candidate(item, ordinality)
    cross join lateral (
      select btrim(coalesce(candidate.item->>'trainer_key', '')) trainer_key
    ) normalized
    where trainer_key <> ''
    order by trainer_key, candidate.ordinality
  ), matches as materialized (
    select
      requested.*,
      current_number.employee_id current_number_employee_id,
      historical_number.employee_id historical_number_employee_id,
      historical_number.employee_no historical_number_employee_no,
      historical_number.full_name historical_number_full_name,
      historical_number.hire_date historical_number_hire_date,
      current_name.employee_id current_name_employee_id,
      historical_name.employee_id historical_name_employee_id,
      historical_name.employee_no historical_name_employee_no,
      historical_name.full_name historical_name_full_name,
      historical_name.hire_date historical_name_hire_date
    from requested
    left join lateral (
      select min(employee.id::text)::uuid employee_id
      from public.employees employee
      where requested.employee_no_key <> ''
        and public.online_training_identity_key(employee.employee_no)
          = requested.employee_no_key
      having count(*) = 1
    ) current_number on true
    left join lateral (
      select
        min(lifecycle.employee_id::text)::uuid employee_id,
        (array_agg(
          nullif(btrim(lifecycle.employee_no), '')
          order by lifecycle.effective_date desc nulls last,
            lifecycle.created_at desc
        ) filter (
          where nullif(btrim(lifecycle.employee_no), '') is not null
        ))[1] employee_no,
        (array_agg(
          nullif(btrim(lifecycle.full_name), '')
          order by lifecycle.effective_date desc nulls last,
            lifecycle.created_at desc
        ) filter (
          where nullif(btrim(lifecycle.full_name), '') is not null
        ))[1] full_name,
        coalesce(
          (array_agg(
            case
              when coalesce(lifecycle.snapshot->>'hire_date', '')
                ~ '^\d{4}-\d{2}-\d{2}$'
                then (lifecycle.snapshot->>'hire_date')::date
            end
            order by lifecycle.effective_date desc nulls last,
              lifecycle.created_at desc
          ) filter (
            where coalesce(lifecycle.snapshot->>'hire_date', '')
              ~ '^\d{4}-\d{2}-\d{2}$'
          ))[1],
          min(lifecycle.effective_date)
            filter (where lifecycle.event_type = 'join')
        ) hire_date
      from public.employee_lifecycle_events lifecycle
      where current_number.employee_id is null
        and requested.employee_no_key <> ''
        and public.online_training_identity_key(lifecycle.employee_no)
          = requested.employee_no_key
      having count(distinct lifecycle.employee_id) = 1
        and count(distinct public.online_training_identity_key(
          lifecycle.employee_no
        )) = 1
    ) historical_number on current_number.employee_id is null
    left join lateral (
      select min(employee.id::text)::uuid employee_id
      from public.employees employee
      where current_number.employee_id is null
        and historical_number.employee_no is null
        and requested.name_key <> ''
        and public.online_training_identity_key(employee.full_name)
          = requested.name_key
      having count(*) = 1
    ) current_name on true
    left join lateral (
      select
        min(lifecycle.employee_id::text)::uuid employee_id,
        (array_agg(
          nullif(btrim(lifecycle.employee_no), '')
          order by lifecycle.effective_date desc nulls last,
            lifecycle.created_at desc
        ) filter (
          where nullif(btrim(lifecycle.employee_no), '') is not null
        ))[1] employee_no,
        (array_agg(
          nullif(btrim(lifecycle.full_name), '')
          order by lifecycle.effective_date desc nulls last,
            lifecycle.created_at desc
        ) filter (
          where nullif(btrim(lifecycle.full_name), '') is not null
        ))[1] full_name,
        coalesce(
          (array_agg(
            case
              when coalesce(lifecycle.snapshot->>'hire_date', '')
                ~ '^\d{4}-\d{2}-\d{2}$'
                then (lifecycle.snapshot->>'hire_date')::date
            end
            order by lifecycle.effective_date desc nulls last,
              lifecycle.created_at desc
          ) filter (
            where coalesce(lifecycle.snapshot->>'hire_date', '')
              ~ '^\d{4}-\d{2}-\d{2}$'
          ))[1],
          min(lifecycle.effective_date)
            filter (where lifecycle.event_type = 'join')
        ) hire_date
      from public.employee_lifecycle_events lifecycle
      where current_number.employee_id is null
        and historical_number.employee_no is null
        and current_name.employee_id is null
        and requested.name_key <> ''
        and public.online_training_identity_key(lifecycle.full_name)
          = requested.name_key
      having count(distinct lifecycle.employee_id) = 1
        and count(distinct public.online_training_identity_key(
          lifecycle.employee_no
        )) = 1
    ) historical_name on current_number.employee_id is null
      and historical_number.employee_no is null
      and current_name.employee_id is null
  ), directory as materialized (
    select
      matches.ordinality,
      matches.trainer_key,
      matches.input_employee_no,
      matches.input_name,
      coalesce(
        nullif(btrim(current_employee.employee_no), ''),
        matches.historical_number_employee_no,
        matches.historical_name_employee_no
      ) employee_no,
      coalesce(
        nullif(btrim(current_employee.full_name), ''),
        matches.historical_number_full_name,
        matches.historical_name_full_name
      ) full_name,
      coalesce(
        current_employee.hire_date,
        matches.historical_number_hire_date,
        matches.historical_name_hire_date
      ) hire_date
    from matches
    left join public.employees current_employee
      on current_employee.id = coalesce(
        matches.current_number_employee_id,
        matches.historical_number_employee_id,
        matches.current_name_employee_id,
        matches.historical_name_employee_id
      )
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'trainer_key', directory.trainer_key,
        'input_employee_no', directory.input_employee_no,
        'input_name', directory.input_name,
        'employee_no', directory.employee_no,
        'full_name', directory.full_name,
        'hire_date', directory.hire_date
      )
      order by directory.ordinality
    ),
    '[]'::jsonb
  )
  into v_result
  from directory;

  return v_result;
end;
$$;

revoke all on function
  public.online_training_resolve_trainer_identities(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.online_training_resolve_trainer_identities(jsonb)
  to authenticated;

comment on function public.online_training_resolve_trainer_identities(jsonb) is
  'Bounded exact/unique trainer directory lookup across current employee master and lifecycle history; never derives trainer identity from trainees.';

-- Keep the existing report writer and scope enforcement, and add the required
-- team-summary invariant at the public database boundary.  Existing historical
-- rows are untouched; only new saves/updates through the RPC are rejected.
create or replace function public.online_training_save_report(
  p_report jsonb,
  p_members jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
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
  if nullif(btrim(coalesce(p_report->>'report_summary', '')), '') is null then
    raise exception using
      errcode = '22023',
      message = 'online_training_report_summary_required',
      detail = '团队总体工作情况不能为空';
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
      raise exception '报告中包含超出管理范围的员工';
    end if;
  end loop;

  return session_private.online_training_save_report_scope_legacy(
    p_report,
    p_members
  );
end;
$$;

revoke all on function public.online_training_save_report(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.online_training_save_report(jsonb, jsonb)
  to authenticated;

comment on function public.online_training_save_report(jsonb, jsonb) is
  'Scope-enforcing writer: requires a nonblank team report summary and every member to remain inside the caller live employee scope.';
