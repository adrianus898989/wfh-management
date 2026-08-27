-- The trainer identity resolver is SECURITY DEFINER because it must inspect the
-- canonical employee and lifecycle directories.  Keep that lookup bounded, but
-- apply the same employee scope as the rest of Online Training before any
-- identity fields leave the database.  Founder/all-data callers remain
-- unrestricted through online_training_employee_in_scope(); self, own-team and
-- assigned-team callers fail closed for every other employee.

begin;

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
        matches.current_number_employee_id,
        matches.historical_number_employee_id,
        matches.current_name_employee_id,
        matches.historical_name_employee_id
      ) employee_id,
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
  from directory
  where public.online_training_employee_in_scope(directory.employee_id);

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
  'Bounded exact/unique trainer directory lookup across current employee master and lifecycle history; returns identity details only for employees in the caller online-training scope.';

notify pgrst, 'reload schema';

commit;
