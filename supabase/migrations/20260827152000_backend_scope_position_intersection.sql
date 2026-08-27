begin;

-- The selected team / position / employee dimensions are authorization
-- configuration, while user_scope_employees is the materialized, effective
-- employee allow-list consumed by every existing SQL and Edge reader.  Keeping
-- user_scope_teams empty prevents legacy "team OR employee" readers from
-- widening a combined scope.
create schema if not exists scope_private;
revoke all on schema scope_private from public, anon, authenticated;

create table if not exists public.user_scope_team_filters (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, team_id)
);

create table if not exists public.user_scope_position_filters (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid not null references public.positions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, position_id)
);

create table if not exists public.user_scope_employee_filters (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, employee_id)
);

-- The composite primary keys serve account lookups. These reverse indexes
-- protect team/position/employee deletes and cascades from scanning every
-- account's filter rows.
create index if not exists user_scope_team_filters_team_id_idx
  on public.user_scope_team_filters (team_id);
create index if not exists user_scope_position_filters_position_id_idx
  on public.user_scope_position_filters (position_id);
create index if not exists user_scope_employee_filters_employee_id_idx
  on public.user_scope_employee_filters (employee_id);
create index if not exists user_scope_employees_employee_id_idx
  on public.user_scope_employees (employee_id);

alter table public.user_scope_team_filters enable row level security;
alter table public.user_scope_position_filters enable row level security;
alter table public.user_scope_employee_filters enable row level security;

revoke all on table public.user_scope_team_filters from public, anon, authenticated, service_role;
revoke all on table public.user_scope_position_filters from public, anon, authenticated, service_role;
revoke all on table public.user_scope_employee_filters from public, anon, authenticated, service_role;
grant select on table public.user_scope_team_filters to service_role;
grant select on table public.user_scope_position_filters to service_role;
grant select on table public.user_scope_employee_filters to service_role;

comment on table public.user_scope_team_filters is
  'Service-only selected team dimensions for assigned backend account scopes.';
comment on table public.user_scope_position_filters is
  'Service-only optional position dimensions for assigned backend account scopes.';
comment on table public.user_scope_employee_filters is
  'Service-only selected employee dimensions for assigned backend account scopes. This is configuration, not the effective allow-list.';
comment on table public.user_scope_employees is
  'Materialized effective employee allow-list for own-team and assigned backend scopes. Assigned team and position filters intersect; explicitly selected employees are additive exceptions. Do not write selections here.';
comment on table public.user_scope_teams is
  'Legacy effective team table retained for compatibility. Assigned scopes are materialized into user_scope_employees and this table remains empty to prevent OR-based scope widening.';

-- These two legacy tables are authorization outputs, not writable inputs.
-- Only owner-run SECURITY DEFINER rebuild functions may mutate them.
revoke all on table public.user_scope_teams, public.user_scope_employees
  from public, anon, authenticated, service_role;
grant select on table public.user_scope_teams, public.user_scope_employees
  to service_role;

-- Defense in depth for clean installs and partially replayed environments. An
-- older compatibility trigger rewrote every linked non-Founder backend account
-- to own_team, which would silently defeat an intentional assigned team/position
-- scope. Account linkage is identity context only; data_scope is explicit.
drop trigger if exists enforce_linked_backend_own_team_trigger
  on public.user_access;
drop function if exists public.enforce_linked_backend_own_team();

-- Capture which assigned accounts still use the pre-intersection storage.  On
-- migration replay, effective employee rows must never be mistaken for newly
-- selected individual employees.
create temporary table scope_accounts_to_migrate on commit drop as
select access.auth_user_id
from public.user_access access
where access.data_scope = 'assigned_teams'
  and not exists (
    select 1 from public.user_scope_team_filters filter
    where filter.auth_user_id = access.auth_user_id
  )
  and not exists (
    select 1 from public.user_scope_position_filters filter
    where filter.auth_user_id = access.auth_user_id
  )
  and not exists (
    select 1 from public.user_scope_employee_filters filter
    where filter.auth_user_id = access.auth_user_id
  );

insert into public.user_scope_team_filters (auth_user_id, team_id, created_at)
select legacy.auth_user_id, legacy.team_id, legacy.created_at
from public.user_scope_teams legacy
join scope_accounts_to_migrate account using (auth_user_id)
on conflict (auth_user_id, team_id) do nothing;

insert into public.user_scope_employee_filters (auth_user_id, employee_id, created_at)
select legacy.auth_user_id, legacy.employee_id, legacy.created_at
from public.user_scope_employees legacy
join scope_accounts_to_migrate account using (auth_user_id)
on conflict (auth_user_id, employee_id) do nothing;

-- Current organization truth for authorization. Only the latest current-roster
-- cache may contribute base team/position membership. Employee, team and
-- position must all map to active canonical IDs; any unmatched field fails
-- closed. Duplicate active position names are normalized to the lowest stable
-- UUID because live data still contains hundreds of employees under those
-- duplicate dimension rows; only that canonical ID is selectable/savable.
-- Explicit employee exceptions are added separately by the rebuild.
create or replace function scope_private.current_employee_scope_directory()
returns table (
  employee_id uuid,
  employee_no text,
  current_team_id uuid,
  current_position_id uuid,
  online_trainer text,
  roster_position_unmatched boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with roster_row as materialized (
    select distinct on (public.employee_master_normalize_id(directory.employee_no))
      public.employee_master_normalize_id(directory.employee_no) employee_no,
      nullif(lower(btrim(directory.team_name)), '') team_key,
      nullif(lower(btrim(directory.position_name)), '') position_key,
      nullif(btrim(directory.online_trainer), '') online_trainer
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
      and nullif(public.employee_master_normalize_id(directory.employee_no), '') is not null
    order by public.employee_master_normalize_id(directory.employee_no),
      directory.source_row desc nulls last
  ), canonical_team as materialized (
    select
      lower(btrim(team.name)) team_key,
      (array_agg(team.id order by team.id))[1] team_id
    from public.teams team
    where team.status = 'active'
      and nullif(btrim(team.name), '') is not null
    group by lower(btrim(team.name))
    having count(*) = 1
  ), canonical_position as materialized (
    select
      lower(btrim(position.name)) position_key,
      (array_agg(position.id order by position.id))[1] position_id
    from public.positions position
    where position.status = 'active'
      and nullif(btrim(position.name), '') is not null
    group by lower(btrim(position.name))
  ), canonical_employee as materialized (
    select
      public.employee_master_normalize_id(employee.employee_no) employee_no,
      (array_agg(employee.id order by employee.id))[1] employee_id
    from public.employees employee
    where nullif(public.employee_master_normalize_id(employee.employee_no), '') is not null
    group by public.employee_master_normalize_id(employee.employee_no)
    having count(*) = 1
  )
  select
    employee.employee_id,
    employee.employee_no,
    canonical_team.team_id,
    canonical_position.position_id,
    roster.online_trainer,
    false
  from roster_row roster
  join canonical_employee employee on employee.employee_no = roster.employee_no
  join canonical_team on canonical_team.team_key = roster.team_key
  join canonical_position on canonical_position.position_key = roster.position_key;
$$;

revoke all on function scope_private.current_employee_scope_directory()
  from public, anon, authenticated;

create or replace function public.admin_scope_current_employee_directory()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with roster_row as materialized (
    select distinct on (public.employee_master_normalize_id(directory.employee_no))
      public.employee_master_normalize_id(directory.employee_no) employee_no,
      nullif(lower(btrim(directory.team_name)), '') team_key,
      nullif(lower(btrim(directory.position_name)), '') position_key,
      nullif(btrim(directory.online_trainer), '') online_trainer
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
      and nullif(public.employee_master_normalize_id(directory.employee_no), '') is not null
    order by public.employee_master_normalize_id(directory.employee_no),
      directory.source_row desc nulls last
  ), canonical_employee as materialized (
    select public.employee_master_normalize_id(employee.employee_no) employee_no
    from public.employees employee
    where nullif(public.employee_master_normalize_id(employee.employee_no), '') is not null
    group by public.employee_master_normalize_id(employee.employee_no)
    having count(*) = 1
  ), ambiguous_employee as materialized (
    select public.employee_master_normalize_id(employee.employee_no) employee_no
    from public.employees employee
    where nullif(public.employee_master_normalize_id(employee.employee_no), '') is not null
    group by public.employee_master_normalize_id(employee.employee_no)
    having count(*) > 1
  ), canonical_team as materialized (
    select lower(btrim(team.name)) team_key
    from public.teams team
    where team.status = 'active' and nullif(btrim(team.name), '') is not null
    group by lower(btrim(team.name))
    having count(*) = 1
  ), ambiguous_team as materialized (
    select lower(btrim(team.name)) team_key
    from public.teams team
    where team.status = 'active' and nullif(btrim(team.name), '') is not null
    group by lower(btrim(team.name))
    having count(*) > 1
  ), canonical_position as materialized (
    select lower(btrim(position.name)) position_key
    from public.positions position
    where position.status = 'active' and nullif(btrim(position.name), '') is not null
    group by lower(btrim(position.name))
  ), ambiguous_position as materialized (
    select lower(btrim(position.name)) position_key
    from public.positions position
    where position.status = 'active' and nullif(btrim(position.name), '') is not null
    group by lower(btrim(position.name))
    having count(*) > 1
  ), scope_rows as materialized (
    select * from scope_private.current_employee_scope_directory()
  )
  select jsonb_build_object(
    'employees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employee_id', scope_row.employee_id,
        'employee_no', scope_row.employee_no,
        'team_id', scope_row.current_team_id,
        'position_id', scope_row.current_position_id,
        'online_trainer', scope_row.online_trainer,
        'position_unmatched', false
      ) order by scope_row.employee_no, scope_row.employee_id)
      from scope_rows scope_row
    ), '[]'::jsonb),
    'unmatched_employee_nos', coalesce((
      select jsonb_agg(roster.employee_no order by roster.employee_no)
      from roster_row roster
      where not exists (select 1 from canonical_employee employee where employee.employee_no = roster.employee_no)
    ), '[]'::jsonb),
    'unmatched_team_employee_nos', coalesce((
      select jsonb_agg(roster.employee_no order by roster.employee_no)
      from roster_row roster
      where exists (select 1 from canonical_employee employee where employee.employee_no = roster.employee_no)
        and not exists (select 1 from canonical_team team where team.team_key = roster.team_key)
    ), '[]'::jsonb),
    'unmatched_position_employee_nos', coalesce((
      select jsonb_agg(roster.employee_no order by roster.employee_no)
      from roster_row roster
      where exists (select 1 from canonical_employee employee where employee.employee_no = roster.employee_no)
        and not exists (select 1 from canonical_position position where position.position_key = roster.position_key)
    ), '[]'::jsonb),
    'ambiguous_employee_nos', coalesce((
      select jsonb_agg(employee.employee_no order by employee.employee_no)
      from ambiguous_employee employee
    ), '[]'::jsonb),
    'ambiguous_team_names', coalesce((
      select jsonb_agg(team.team_key order by team.team_key)
      from ambiguous_team team
    ), '[]'::jsonb),
    'ambiguous_position_names', coalesce((
      select jsonb_agg(position.position_key order by position.position_key)
      from ambiguous_position position
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.admin_scope_current_employee_directory()
  from public, anon, authenticated;
grant execute on function public.admin_scope_current_employee_directory()
  to service_role;
comment on function public.admin_scope_current_employee_directory() is
  'Service-only strict current-roster employee/team/position/online-trainer projection plus fail-closed unmatched diagnostics for backend account scopes.';

create or replace function scope_private.rebuild_account_employee_scope(
  p_auth_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_linked_employee_id uuid;
  v_active boolean;
  v_backend_enabled boolean;
  v_access_found boolean := false;
  v_inserted integer := 0;
  v_has_team boolean;
  v_has_position boolean;
  v_has_employee boolean;
begin
  if p_auth_user_id is null then return 0; end if;

  -- Lock order is always user_access row, then the account advisory lock.
  -- This matches ordinary UPDATE -> AFTER-trigger rebuilds and prevents an
  -- atomic save from deadlocking with an active/disabled account toggle.
  select access.data_scope, access.employee_id, access.active, access.backend_enabled
  into v_scope, v_linked_employee_id, v_active, v_backend_enabled
  from public.user_access access
  where access.auth_user_id = p_auth_user_id
  order by access.updated_at desc
  limit 1
  for update;
  v_access_found := found;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  -- Legacy readers combine this table with employees using OR.  Team choices
  -- therefore live only in the configuration table above.
  delete from public.user_scope_teams legacy
  where legacy.auth_user_id = p_auth_user_id;
  delete from public.user_scope_employees effective
  where effective.auth_user_id = p_auth_user_id;

  -- Disabled/deleted accounts must not leave an old compatibility/effective
  -- allow-list behind. The DELETE-trigger path reaches this point with no
  -- user_access row and still clears both outputs.
  if not v_access_found or not coalesce(v_active, false)
     or not coalesce(v_backend_enabled, false) then
    return 0;
  end if;

  if v_scope = 'own_team' then
    insert into public.user_scope_employees (auth_user_id, employee_id)
    select p_auth_user_id, target.employee_id
    from scope_private.current_employee_scope_directory() caller
    join scope_private.current_employee_scope_directory() target
      on target.current_team_id = caller.current_team_id
    where caller.employee_id = v_linked_employee_id
      and caller.current_team_id is not null
    on conflict (auth_user_id, employee_id) do nothing;
    get diagnostics v_inserted = row_count;
    return v_inserted;
  end if;

  if v_scope is distinct from 'assigned_teams' then return 0; end if;

  select exists (
      select 1 from public.user_scope_team_filters filter
      where filter.auth_user_id = p_auth_user_id
    ), exists (
      select 1 from public.user_scope_position_filters filter
      where filter.auth_user_id = p_auth_user_id
    ), exists (
      select 1 from public.user_scope_employee_filters filter
      where filter.auth_user_id = p_auth_user_id
    )
  into v_has_team, v_has_position, v_has_employee;

  -- An empty assigned scope always fails closed.  Team and position are the
  -- base intersection (for example AR India + Customer Service). Explicit
  -- employees are additive exceptions, preserving the legacy "team OR named
  -- employees" behavior without letting either base dimension widen the other.
  if v_has_position and not v_has_team then return 0; end if;
  if not (v_has_team or v_has_employee) then return 0; end if;

  insert into public.user_scope_employees (auth_user_id, employee_id)
  select p_auth_user_id, scoped.employee_id
  from (
    select employee.employee_id
    from scope_private.current_employee_scope_directory() employee
    where v_has_team
      and exists (
        select 1 from public.user_scope_team_filters filter
        where filter.auth_user_id = p_auth_user_id
          and filter.team_id = employee.current_team_id
      )
      and (
        not v_has_position
        or exists (
          select 1 from public.user_scope_position_filters filter
          where filter.auth_user_id = p_auth_user_id
            and filter.position_id = employee.current_position_id
        )
      )
    union
    select filter.employee_id
    from public.user_scope_employee_filters filter
    join public.employees employee on employee.id = filter.employee_id
    where filter.auth_user_id = p_auth_user_id
      and v_has_employee
  ) scoped
  on conflict (auth_user_id, employee_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function scope_private.rebuild_account_employee_scope(uuid)
  from public, anon, authenticated;

create or replace function public.admin_scope_effective_employee_ids(
  p_auth_user_id uuid
)
returns table (employee_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with caller_access as materialized (
    select access.employee_id, access.data_scope, role.code role_code
    from public.user_access access
    join public.roles role on role.id = access.role_id
    where access.auth_user_id = p_auth_user_id
      and access.active = true
      and access.backend_enabled = true
    order by access.updated_at desc
    limit 1
  )
  select employee.id
  from public.employees employee
  cross join caller_access access
  where access.role_code = 'founder'
     or access.data_scope = 'all'
     or (
       access.data_scope = 'self'
       and employee.id = access.employee_id
     )
     or (
       access.data_scope in ('own_team', 'assigned_teams')
       and exists (
         select 1 from public.user_scope_employees effective
         where effective.auth_user_id = p_auth_user_id
           and effective.employee_id = employee.id
       )
     )
  order by employee.id;
$$;

revoke all on function public.admin_scope_effective_employee_ids(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_scope_effective_employee_ids(uuid)
  to service_role;
comment on function public.admin_scope_effective_employee_ids(uuid) is
  'Service-only canonical employee allow-list for Edge functions. own-team and assigned scopes use indexed materialized current-roster results.';

create or replace function public.admin_rebuild_account_employee_scope(
  p_auth_user_id uuid
)
returns integer
language sql
security definer
set search_path = ''
as $$
  select scope_private.rebuild_account_employee_scope(p_auth_user_id);
$$;

revoke all on function public.admin_rebuild_account_employee_scope(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_rebuild_account_employee_scope(uuid)
  to service_role;
comment on function public.admin_rebuild_account_employee_scope(uuid) is
  'Service-only rebuild of the effective assigned-scope employee allow-list.';

create or replace function public.admin_save_account_scope_filters(
  p_auth_user_id uuid,
  p_team_ids uuid[] default '{}'::uuid[],
  p_position_ids uuid[] default '{}'::uuid[],
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective_count integer;
begin
  if p_auth_user_id is null then
    raise exception 'account_not_found';
  end if;

  -- One account's replacement is one serialization unit. Without this lock,
  -- concurrent delete/insert sequences can merge two administrators' choices.
  perform 1
  from public.user_access access
  where access.auth_user_id = p_auth_user_id
  for update;
  if not found then raise exception 'account_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  if cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
     and cardinality(coalesce(p_team_ids, '{}'::uuid[])) = 0 then
    raise exception 'position_filter_requires_team';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_team_ids, '{}'::uuid[])) selected(team_id)
    where selected.team_id is not null
      and not exists (
        select 1
        from scope_private.current_employee_scope_directory() directory
        where directory.current_team_id = selected.team_id
      )
  ) then
    raise exception 'team_filter_not_in_current_roster';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_position_ids, '{}'::uuid[])) selected(position_id)
    where selected.position_id is not null
      and not exists (
        select 1
        from scope_private.current_employee_scope_directory() directory
        where directory.current_position_id = selected.position_id
      )
  ) then
    raise exception 'position_filter_not_in_current_roster';
  end if;

  delete from public.user_scope_team_filters filter
  where filter.auth_user_id = p_auth_user_id;
  delete from public.user_scope_position_filters filter
  where filter.auth_user_id = p_auth_user_id;
  delete from public.user_scope_employee_filters filter
  where filter.auth_user_id = p_auth_user_id;

  insert into public.user_scope_team_filters (auth_user_id, team_id)
  select p_auth_user_id, value
  from (
    select distinct unnest(coalesce(p_team_ids, '{}'::uuid[])) value
  ) selected
  where value is not null;

  insert into public.user_scope_position_filters (auth_user_id, position_id)
  select p_auth_user_id, value
  from (
    select distinct unnest(coalesce(p_position_ids, '{}'::uuid[])) value
  ) selected
  where value is not null;

  insert into public.user_scope_employee_filters (auth_user_id, employee_id)
  select p_auth_user_id, value
  from (
    select distinct unnest(coalesce(p_employee_ids, '{}'::uuid[])) value
  ) selected
  where value is not null;

  v_effective_count := scope_private.rebuild_account_employee_scope(p_auth_user_id);
  return jsonb_build_object('effective_employee_count', v_effective_count);
end;
$$;

revoke all on function public.admin_save_account_scope_filters(uuid, uuid[], uuid[], uuid[])
  from public, anon, authenticated;
grant execute on function public.admin_save_account_scope_filters(uuid, uuid[], uuid[], uuid[])
  to service_role;
comment on function public.admin_save_account_scope_filters(uuid, uuid[], uuid[], uuid[]) is
  'Compatibility boundary for transactional scope-filter replacement. New account writes use admin_save_account_access_scope so data_scope and filters commit together.';

create or replace function public.admin_save_account_access_scope(
  p_auth_user_id uuid,
  p_employee_id uuid,
  p_role_id uuid,
  p_data_scope text,
  p_team_ids uuid[] default '{}'::uuid[],
  p_position_ids uuid[] default '{}'::uuid[],
  p_employee_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_previous_skip text := coalesce(
    pg_catalog.current_setting('scope_private.skip_rebuild', true),
    'off'
  );
begin
  if p_auth_user_id is null or p_role_id is null
     or p_data_scope not in ('all', 'own_team', 'assigned_teams', 'self') then
    raise exception 'invalid_account_scope';
  end if;
  if p_data_scope in ('own_team', 'self') and p_employee_id is null then
    raise exception 'employee_required';
  end if;
  if p_data_scope = 'assigned_teams' then
    if cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
       and cardinality(coalesce(p_team_ids, '{}'::uuid[])) = 0 then
      raise exception 'position_filter_requires_team';
    end if;
    if cardinality(coalesce(p_team_ids, '{}'::uuid[])) = 0
       and cardinality(coalesce(p_employee_ids, '{}'::uuid[])) = 0 then
      raise exception 'assigned_scope_requires_team_or_employee';
    end if;
  elsif cardinality(coalesce(p_team_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_position_ids, '{}'::uuid[])) > 0
     or cardinality(coalesce(p_employee_ids, '{}'::uuid[])) > 0 then
    raise exception 'filters_require_assigned_scope';
  end if;

  perform 1 from public.user_access access
  where access.auth_user_id = p_auth_user_id
  for update;
  if not found then raise exception 'account_not_found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('backend-scope:' || p_auth_user_id::text, 0)
  );

  -- Suppress the ordinary data_scope trigger only inside this transaction;
  -- the filter replacement below performs the single final rebuild.
  perform pg_catalog.set_config('scope_private.skip_rebuild', 'on', true);
  update public.user_access access
  set employee_id = p_employee_id,
      role_id = p_role_id,
      data_scope = p_data_scope,
      updated_at = now()
  where access.auth_user_id = p_auth_user_id;

  v_result := public.admin_save_account_scope_filters(
    p_auth_user_id,
    case when p_data_scope = 'assigned_teams' then p_team_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then p_position_ids else '{}'::uuid[] end,
    case when p_data_scope = 'assigned_teams' then p_employee_ids else '{}'::uuid[] end
  );
  -- Do not leak trigger suppression into another account mutation performed by
  -- the same service transaction. Restore a surrounding caller's value when
  -- this boundary is nested.
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild',
    case when v_previous_skip = 'on' then 'on' else 'off' end,
    true
  );
  return v_result || jsonb_build_object('data_scope', p_data_scope);
end;
$$;

revoke all on function public.admin_save_account_access_scope(
  uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.admin_save_account_access_scope(
  uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) to service_role;
comment on function public.admin_save_account_access_scope(
  uuid, uuid, uuid, text, uuid[], uuid[], uuid[]
) is 'Service-only atomic account identity/role/data_scope and combined-scope replacement with one final effective-list rebuild.';

create or replace function scope_private.refresh_scope_filter_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('scope_private.skip_rebuild', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  perform scope_private.rebuild_account_employee_scope(
    case when tg_op = 'DELETE' then old.auth_user_id else new.auth_user_id end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists refresh_scope_team_filter_change
  on public.user_scope_team_filters;

drop trigger if exists refresh_scope_position_filter_change
  on public.user_scope_position_filters;

drop trigger if exists refresh_scope_employee_filter_change
  on public.user_scope_employee_filters;
-- Do not create per-row filter triggers. The preferred service boundary is
-- admin_save_account_access_scope(), which replaces access + all three
-- dimensions and rebuilds exactly once while holding the account lock.

create or replace function scope_private.refresh_scope_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting('scope_private.skip_rebuild', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  perform scope_private.rebuild_account_employee_scope(
    case when tg_op = 'DELETE' then old.auth_user_id else new.auth_user_id end
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists refresh_effective_scope_after_access_change
  on public.user_access;
create trigger refresh_effective_scope_after_access_change
after insert or delete or update of employee_id, data_scope, active, backend_enabled on public.user_access
for each row execute function scope_private.refresh_scope_access_change();

-- Roster rows supply both current team and current position. Rebuild after a
-- canonical identity mapping changes so a newly matched/unmatched ID cannot
-- retain yesterday's effective access.
create or replace function scope_private.rebuild_all_assigned_employee_scopes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  account record;
  v_count integer := 0;
begin
  for account in
    select access.auth_user_id
    from public.user_access access
    where access.data_scope in ('own_team', 'assigned_teams')
    order by access.auth_user_id
  loop
    perform scope_private.rebuild_account_employee_scope(account.auth_user_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function scope_private.rebuild_all_assigned_employee_scopes()
  from public, anon, authenticated;

create or replace function scope_private.refresh_all_assigned_employee_scopes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform scope_private.rebuild_all_assigned_employee_scopes();
  return null;
end;
$$;

drop trigger if exists refresh_effective_scope_after_employee_change
  on public.employees;
drop trigger if exists refresh_effective_scope_after_employee_insert_delete
  on public.employees;
create trigger refresh_effective_scope_after_employee_insert_delete
after insert or delete on public.employees
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();

drop trigger if exists refresh_effective_scope_after_employee_team_position_update
  on public.employees;
create trigger refresh_effective_scope_after_employee_team_position_update
after update of employee_no on public.employees
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();

drop trigger if exists refresh_effective_scope_after_team_insert_delete
  on public.teams;
create trigger refresh_effective_scope_after_team_insert_delete
after insert or delete on public.teams
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();
drop trigger if exists refresh_effective_scope_after_team_identity_update
  on public.teams;
create trigger refresh_effective_scope_after_team_identity_update
after update of name, status on public.teams
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();

drop trigger if exists refresh_effective_scope_after_position_insert_delete
  on public.positions;
create trigger refresh_effective_scope_after_position_insert_delete
after insert or delete on public.positions
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();
drop trigger if exists refresh_effective_scope_after_position_identity_update
  on public.positions;
create trigger refresh_effective_scope_after_position_identity_update
after update of name, status on public.positions
for each statement execute function scope_private.refresh_all_assigned_employee_scopes();

drop trigger if exists refresh_effective_scope_after_roster_directory_change
  on public.report_employee_directory_cache;

-- The cache synchronizer performs several delete/insert statements. A table
-- trigger would rebuild every account after each intermediate statement. Wrap
-- the atomic synchronizer instead and rebuild once after its final cache state.
alter function public.sync_report_employee_directory(jsonb)
  rename to sync_report_employee_directory_scope_inner_v1;
revoke all on function public.sync_report_employee_directory_scope_inner_v1(jsonb)
  from public, anon, authenticated, service_role;
create function public.sync_report_employee_directory(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.sync_report_employee_directory_scope_inner_v1(p_rows);
  perform scope_private.rebuild_all_assigned_employee_scopes();
  return v_result;
end;
$$;
revoke all on function public.sync_report_employee_directory(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_directory(jsonb)
  to service_role;

-- The public boolean helpers are the browser/RPC authorization boundary.  The
-- effective table makes every older reader inherit position intersections.
create or replace function public.backend_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_role_code text;
begin
  if p_employee_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_scope, v_role_code
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then return false; end if;
  if v_role_code = 'founder' or v_scope = 'all' then return true; end if;
  if v_scope = 'self' then
    return v_caller_employee_id is not null
      and p_employee_id = v_caller_employee_id;
  end if;
  if v_scope in ('own_team', 'assigned_teams') then
    return exists (
      select 1 from public.user_scope_employees effective
      where effective.auth_user_id = v_user_id
        and effective.employee_id = p_employee_id
    );
  end if;
  return false;
end;
$$;

revoke all on function public.backend_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.backend_employee_in_scope(uuid)
  to authenticated, service_role;

create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.backend_employee_in_scope(p_employee_id);
$$;

revoke all on function public.can_manage_employee(uuid)
  from public, anon;
grant execute on function public.can_manage_employee(uuid)
  to authenticated, service_role;

-- Attendance readers predate the current-roster scope boundary and used the
-- canonical employees.team_id (plus a raw team-name fallback) for own-team
-- access. Replace only that widening branch with the central employee guard;
-- unmatched rows now fail closed. Assigned readers remain compatible because
-- user_scope_teams is empty and user_scope_employees contains the exact
-- materialized intersection.
do $harden_attendance_own_team_scope$
declare
  v_signature regprocedure;
  v_definition text;
  v_hardened text;
  v_old text;
  v_new text;
begin
  v_signature := 'public.admin_attendance_schedule_scoped_internal(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $needle$
      or (v_access_scope='own_team' and (
        i.team_id=v_current_team
        or (i.employee_id is null
          and public.exam_norm(i.team_name)=public.exam_norm(v_current_team_name))
      ))$needle$;
  v_new := E'\n      or public.backend_employee_in_scope(i.employee_id)';
  v_hardened := replace(v_definition, v_old, v_new);
  if v_hardened = v_definition then
    raise exception 'attendance_scope_definition_changed: %', v_signature;
  end if;
  execute v_hardened;

  v_signature := 'public.admin_attendance_schedule_page_v1(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $needle$
      or (v_access_scope = 'own_team' and (
        presented.employee_team_id = v_current_team
        or (presented.employee_id is null
          and public.exam_norm(presented.team_name) = public.exam_norm(v_current_team_name))
      ))$needle$;
  v_new := E'\n      or public.backend_employee_in_scope(presented.employee_id)';
  v_hardened := replace(v_definition, v_old, v_new);
  if v_hardened = v_definition then
    raise exception 'attendance_scope_definition_changed: %', v_signature;
  end if;
  execute v_hardened;

  v_signature := 'attendance_private.admin_attendance_home(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $needle$
        or (v_access_scope='own_team' and (
          scope_employee.team_id=v_current_team
          or (scope_employee.id is null and public.exam_norm(x.team_name)=public.exam_norm(v_current_team_name))
        ))$needle$;
  v_new := E'\n        or public.backend_employee_in_scope(x.employee_id)';
  v_hardened := replace(v_definition, v_old, v_new);
  if v_hardened = v_definition then
    raise exception 'attendance_scope_definition_changed: %', v_signature;
  end if;
  execute v_hardened;

  v_signature := 'attendance_private.admin_attendance_monthly(jsonb)'::regprocedure;
  select pg_get_functiondef(v_signature) into v_definition;
  v_old := $needle$
        or (v_access_scope='own_team' and (scope_employee.team_id=v_current_team
          or (scope_employee.id is null and public.exam_norm(x.team_name)=public.exam_norm(v_current_team_name))))$needle$;
  v_new := E'\n        or public.backend_employee_in_scope(x.employee_id)';
  v_hardened := replace(v_definition, v_old, v_new);
  if v_hardened = v_definition then
    raise exception 'attendance_scope_definition_changed: %', v_signature;
  end if;
  v_definition := v_hardened;
  v_old := $needle$(v_access_scope='own_team' and e.team_id=v_current_team)$needle$;
  v_new := 'public.backend_employee_in_scope(e.id)';
  v_hardened := replace(v_definition, v_old, v_new);
  if v_hardened = v_definition then
    raise exception 'attendance_current_people_scope_definition_changed: %', v_signature;
  end if;
  execute v_hardened;
end;
$harden_attendance_own_team_scope$;

-- Team/position resources (notably the exam question bank) cannot be checked
-- through an employee UUID. Explicit employee exceptions never grant access to
-- a whole team or position; only the configured base dimensions do.
create or replace function scope_private.assigned_team_position_in_scope(
  p_auth_user_id uuid,
  p_team_name text,
  p_position_name text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_has_team boolean;
  v_has_position boolean;
begin
  select exists (
      select 1 from public.user_scope_team_filters filter
      where filter.auth_user_id = p_auth_user_id
    ), exists (
      select 1 from public.user_scope_position_filters filter
      where filter.auth_user_id = p_auth_user_id
    )
  into v_has_team, v_has_position;

  -- Position is an optional narrowing dimension under selected teams. A
  -- position without any team is invalid and never grants a global position.
  if not v_has_team then return false; end if;
  -- Resolve both configured dimensions through today's strict roster
  -- directory.  A removed/renamed team or position filter therefore stops
  -- granting question-bank resources even before an administrator resaves
  -- the account.  When positions narrow the account, the same current roster
  -- row must satisfy the configured team + position combination.
  return exists (
    select 1
    from scope_private.current_employee_scope_directory() directory
    join public.teams team on team.id = directory.current_team_id
    join public.positions position on position.id = directory.current_position_id
    where public.exam_norm(team.name) = public.exam_norm(p_team_name)
      and exists (
        select 1
        from public.user_scope_team_filters filter
        where filter.auth_user_id = p_auth_user_id
          and filter.team_id = directory.current_team_id
      )
      and (
        not v_has_position
        or (
          nullif(btrim(coalesce(p_position_name, '')), '') is not null
          and public.exam_norm(position.name) = public.exam_norm(p_position_name)
          and exists (
            select 1
            from public.user_scope_position_filters filter
            where filter.auth_user_id = p_auth_user_id
              and filter.position_id = directory.current_position_id
          )
        )
      )
  );
end;
$$;

revoke all on function scope_private.assigned_team_position_in_scope(uuid, text, text)
  from public, anon, authenticated;

create or replace function session_private.exam_team_position_in_scope(
  p_team_name text,
  p_position_name text default null
)
returns boolean
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
begin
  if not session_private.current_app_session_is_valid('admin') then return false; end if;
  select access.data_scope, role.code, access.employee_id
  into v_scope, v_role_code, v_employee_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then return false; end if;
  if v_role_code = 'founder' or v_scope = 'all' then return true; end if;
  if v_scope = 'assigned_teams' then
    return scope_private.assigned_team_position_in_scope(
      v_user_id, p_team_name, p_position_name
    );
  end if;
  if v_scope = 'own_team' and v_employee_id is not null then
    return exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.teams team on team.id = directory.current_team_id
      where directory.employee_id = v_employee_id
        and public.exam_norm(team.name) = public.exam_norm(p_team_name)
    );
  end if;
  return false;
end;
$$;

revoke all on function session_private.exam_team_position_in_scope(text, text)
  from public, anon, authenticated;

create or replace function session_private.exam_team_in_scope(p_team_name text)
returns boolean
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
begin
  if not session_private.current_app_session_is_valid('admin') then return false; end if;
  select access.data_scope, role.code, access.employee_id
  into v_scope, v_role_code, v_employee_id
  from public.user_access access
  join public.roles role on role.id = access.role_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then return false; end if;
  if v_role_code = 'founder' or v_scope = 'all' then return true; end if;
  if v_scope = 'assigned_teams' then
    return exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.teams team on team.id = directory.current_team_id
      where exists (
          select 1
          from public.user_scope_team_filters filter
          where filter.auth_user_id = v_user_id
            and filter.team_id = directory.current_team_id
        )
        and public.exam_norm(team.name) = public.exam_norm(p_team_name)
        and (
          not exists (
            select 1
            from public.user_scope_position_filters filter
            where filter.auth_user_id = v_user_id
          )
          or exists (
            select 1
            from public.user_scope_position_filters filter
            where filter.auth_user_id = v_user_id
              and filter.position_id = directory.current_position_id
          )
        )
    );
  end if;
  if v_scope = 'own_team' and v_employee_id is not null then
    return exists (
      select 1
      from scope_private.current_employee_scope_directory() directory
      join public.teams team on team.id = directory.current_team_id
      where directory.employee_id = v_employee_id
        and public.exam_norm(team.name) = public.exam_norm(p_team_name)
    );
  end if;
  return false;
end;
$$;
revoke all on function session_private.exam_team_in_scope(text)
  from public, anon, authenticated;

create or replace function session_private.exam_assignment_target_in_scope(
  p_team_name text,
  p_position_name text,
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_employee_id is null then
      session_private.exam_team_position_in_scope(p_team_name, p_position_name)
    else public.backend_employee_in_scope(p_employee_id)
      and exists (
        select 1
        from scope_private.current_employee_scope_directory() directory
        join public.teams team on team.id = directory.current_team_id
        join public.positions position on position.id = directory.current_position_id
        where directory.employee_id = p_employee_id
          and public.exam_norm(team.name) = public.exam_norm(p_team_name)
          and public.exam_norm(position.name) = public.exam_norm(p_position_name)
      )
  end;
$$;
revoke all on function session_private.exam_assignment_target_in_scope(text, text, uuid)
  from public, anon, authenticated;

-- Patch the two read dashboards in place so every question row, option and
-- count is checked against both dimensions. Abort the migration if the prior
-- guarded definitions are no longer the expected version.
do $harden_exam_question_reads$
declare
  v_signature regprocedure;
  v_definition text;
  v_hardened text;
begin
  foreach v_signature in array array[
    'public.admin_exam_overview_dashboard(text,text,text,integer,integer)'::regprocedure,
    'public.admin_exam_question_bank_dashboard(text,text,text,integer,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_hardened := replace(
      v_definition,
      'session_private.exam_team_in_scope(question.team_name)',
      'session_private.exam_team_position_in_scope(question.team_name, question.position_name)'
    );
    if v_hardened = v_definition then
      raise exception 'exam_question_scope_definition_changed: %', v_signature;
    end if;
    execute v_hardened;
  end loop;
end;
$harden_exam_question_reads$;

-- Keep the audit/session/permission wrappers installed by the 14:20 and 14:40
-- migrations. Rename those public boundaries, then add position-aware guards
-- in front of them; calling the older page_v1 functions directly would bypass
-- the required mutation audit log.
alter function public.admin_exam_preview_questions(text, text, jsonb)
  rename to admin_exam_preview_questions_position_scope_inner_v1;
alter function public.admin_exam_save_question(jsonb)
  rename to admin_exam_save_question_position_scope_inner_v1;
alter function public.admin_exam_delete_question(uuid)
  rename to admin_exam_delete_question_position_scope_inner_v1;
alter function public.admin_exam_create_assignment(jsonb)
  rename to admin_exam_create_assignment_position_scope_inner_v1;
alter function public.admin_exam_save_assignment(jsonb)
  rename to admin_exam_save_assignment_position_scope_inner_v1;
alter function public.admin_exam_delete_assignment(uuid)
  rename to admin_exam_delete_assignment_position_scope_inner_v1;

revoke all on function
  public.admin_exam_preview_questions_position_scope_inner_v1(text,text,jsonb),
  public.admin_exam_save_question_position_scope_inner_v1(jsonb),
  public.admin_exam_delete_question_position_scope_inner_v1(uuid),
  public.admin_exam_create_assignment_position_scope_inner_v1(jsonb),
  public.admin_exam_save_assignment_position_scope_inner_v1(jsonb),
  public.admin_exam_delete_assignment_position_scope_inner_v1(uuid)
  from public, anon, authenticated, service_role;

create function public.admin_exam_preview_questions(
  p_team text,
  p_position text,
  p_rules jsonb default '{"5":10,"10":3,"20":1}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.has_permission('exam.question_bank.view') then raise exception 'permission_denied'; end if;
  if not session_private.exam_team_position_in_scope(p_team, p_position) then
    raise exception 'team_position_out_of_scope';
  end if;
  return public.admin_exam_preview_questions_position_scope_inner_v1(
    p_team, p_position, p_rules
  );
end;
$$;

create function public.admin_exam_save_question(p_question jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(btrim(p_question->>'id'), '')::uuid;
  v_old_team text;
  v_old_position text;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if v_id is not null then
    select question.team_name, question.position_name
    into v_old_team, v_old_position
    from public.exam_questions question where question.id = v_id for update;
    if not found then raise exception 'question_not_found'; end if;
    if not session_private.exam_team_position_in_scope(v_old_team, v_old_position) then
      raise exception 'team_position_out_of_scope';
    end if;
  end if;
  if not session_private.exam_team_position_in_scope(
    p_question->>'team_name', p_question->>'position_name'
  ) then raise exception 'team_position_out_of_scope'; end if;
  return public.admin_exam_save_question_position_scope_inner_v1(p_question);
end;
$$;

create function public.admin_exam_delete_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text;
  v_position text;
begin
  if not public.has_permission('exam.question_bank.delete') then raise exception 'permission_denied'; end if;
  select question.team_name, question.position_name into v_team, v_position
  from public.exam_questions question where question.id = p_question_id for update;
  if not found then raise exception 'question_not_found'; end if;
  if not session_private.exam_team_position_in_scope(v_team, v_position) then
    raise exception 'team_position_out_of_scope';
  end if;
  return public.admin_exam_delete_question_position_scope_inner_v1(p_question_id);
end;
$$;

create function public.admin_exam_create_assignment(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid := nullif(btrim(p_data->>'employee_id'), '')::uuid;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if not session_private.exam_assignment_target_in_scope(
    p_data->>'team_name', p_data->>'position_name', v_employee_id
  ) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_create_assignment_position_scope_inner_v1(p_data);
end;
$$;

create function public.admin_exam_save_assignment(p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := nullif(btrim(p_data->>'id'), '')::uuid;
  v_employee_id uuid := nullif(btrim(p_data->>'employee_id'), '')::uuid;
  v_old_team text;
  v_old_position text;
  v_old_employee_id uuid;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if v_id is not null then
    select assignment.team_name, assignment.position_name, assignment.employee_id
    into v_old_team, v_old_position, v_old_employee_id
    from public.exam_assignments assignment where assignment.id = v_id for update;
    if not found then raise exception 'assignment_not_found'; end if;
    if not session_private.exam_assignment_target_in_scope(
      v_old_team, v_old_position, v_old_employee_id
    ) then raise exception 'assignment_target_out_of_scope'; end if;
  end if;
  if not session_private.exam_assignment_target_in_scope(
    p_data->>'team_name', p_data->>'position_name', v_employee_id
  ) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_save_assignment_position_scope_inner_v1(p_data);
end;
$$;

create function public.admin_exam_delete_assignment(p_assignment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team text;
  v_position text;
  v_employee_id uuid;
begin
  if not public.has_permission('exam.question_bank.delete') then raise exception 'permission_denied'; end if;
  select assignment.team_name, assignment.position_name, assignment.employee_id
  into v_team, v_position, v_employee_id
  from public.exam_assignments assignment where assignment.id = p_assignment_id for update;
  if not found then raise exception 'assignment_not_found'; end if;
  if not session_private.exam_assignment_target_in_scope(
    v_team, v_position, v_employee_id
  ) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_delete_assignment_position_scope_inner_v1(p_assignment_id);
end;
$$;

revoke all on function
  public.admin_exam_preview_questions(text,text,jsonb),
  public.admin_exam_save_question(jsonb),
  public.admin_exam_delete_question(uuid),
  public.admin_exam_create_assignment(jsonb),
  public.admin_exam_save_assignment(jsonb),
  public.admin_exam_delete_assignment(uuid)
  from public, anon, authenticated;
grant execute on function
  public.admin_exam_preview_questions(text,text,jsonb),
  public.admin_exam_save_question(jsonb),
  public.admin_exam_delete_question(uuid),
  public.admin_exam_create_assignment(jsonb),
  public.admin_exam_save_assignment(jsonb),
  public.admin_exam_delete_assignment(uuid)
  to authenticated, service_role;

-- Online-training assignment/trainer identity may decide which actions a
-- scoped account can perform, but it must never add employees above the
-- generic backend data-scope ceiling.
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
     or not public.online_training_can_view_module()
     or not public.backend_employee_in_scope(p_employee_id) then
    return false;
  end if;
  select access.employee_id into v_caller_employee_id
  from public.user_access access
  where access.auth_user_id = (select auth.uid())
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if v_caller_employee_id is null then return false; end if;
  return exists (
    select 1
    from public.employees employee
    join public.report_sheet_snapshots snapshot
      on snapshot.source = '居家排班表/填表'
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where employee.id = p_employee_id
      and lower(btrim(employee.employee_no)) = lower(btrim(roster.item->>'employee_id'))
      and session_private.online_training_snapshot_employee_id(
        roster.item->>'online_trainer'
      ) = v_caller_employee_id
  );
end;
$$;

create or replace function public.online_training_employee_in_scope(
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_employee_id is not null
    and session_private.current_app_session_is_valid('admin')
    and public.online_training_can_view_module()
    and public.backend_employee_in_scope(p_employee_id);
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
  select access.employee_id into v_caller_employee_id
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
      select 1 from public.online_training_report_members member
      where member.report_id = p_report_id
        and member.employee_id is not null
    )
    and not exists (
      select 1 from public.online_training_report_members member
      where member.report_id = p_report_id
        and not public.backend_employee_in_scope(member.employee_id)
    );
end;
$$;

create or replace function public.online_training_can_view_report(p_report_id uuid)
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

  -- A mixed report is not a safe report-level object for a limited account:
  -- report summaries, notes and attachments are shared across every member.
  -- Require every member to remain below the generic backend scope ceiling.
  if exists (
    select 1
    from public.online_training_report_members member
    where member.report_id = p_report_id
      and not public.backend_employee_in_scope(member.employee_id)
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

-- The granular edit helper still contains the historical "any assigned
-- member" predicate.  Keep its ownership/status rules, but make the new
-- all-member report boundary a mandatory hard ceiling.  Archive and storage
-- deletion call this function at execution time, so they inherit the same
-- mixed-scope protection.
create or replace function public.online_training_can_edit_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (
      public.has_permission('online_training.report.submit')
      or public.has_permission('online_training.report.manage')
    )
    and public.online_training_can_edit_report_granular_v1(p_report_id)
    and public.online_training_can_view_report(p_report_id);
$$;

create or replace function public.online_training_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_login_username text;
  v_role_code text;
  v_scope text;
  v_can_submit boolean;
  v_can_review boolean;
  v_can_manage boolean;
  v_my_roster jsonb := '[]'::jsonb;
  v_manager_options jsonb := '[]'::jsonb;
  v_filter_options jsonb := '{}'::jsonb;
  v_synced_at timestamptz;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  select access.employee_id, employee.employee_no, employee.full_name,
    access.login_username, role.code, access.data_scope
  into v_caller_employee_id, v_employee_no, v_employee_name,
    v_login_username, v_role_code, v_scope
  from public.user_access access
  join public.roles role on role.id = access.role_id
  left join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  v_can_submit := public.has_permission('online_training.report.submit')
    or public.has_permission('online_training.report.manage');
  v_can_review := public.has_permission('online_training.report.review');
  v_can_manage := public.has_permission('online_training.report.manage');
  select snapshot.synced_at into v_synced_at
  from public.report_sheet_snapshots snapshot
  where snapshot.source = '居家排班表/填表'
  order by snapshot.synced_at desc limit 1;

  with scoped as materialized (
    select
      employee.id,
      employee.employee_no,
      coalesce(nullif(btrim(directory.full_name), ''), employee.full_name) full_name,
      employee.status,
      employee.hire_date,
      coalesce(nullif(btrim(directory.country_name), ''), employee.country, employee.nationality, '') country,
      coalesce(directory.position_name, '') position_name,
      coalesce(directory.team_name, '') team_name,
      coalesce(directory.group_name, '') group_name,
      coalesce(directory.shift_name, '') shift_name,
      coalesce(directory.platform_name, '') platform,
      coalesce(employee.work_content, '') work_content,
      coalesce(directory.responsible, employee.person_in_charge, employee.leader_name, '') responsible,
      coalesce(directory.onsite_trainer, employee.on_site_trainer, '') onsite_trainer,
      coalesce(directory.online_leader, employee.online_leader, '') online_leader,
      coalesce(directory.online_trainer, employee.online_trainer, employee.trainer_name, '') online_trainer
    from public.report_employee_directory_cache directory
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        public.employee_master_normalize_id(directory.employee_no)
    where directory.source_kind = 'roster'
      and public.backend_employee_in_scope(employee.id)
  )
  select
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', scoped.id,
        'employee_no', scoped.employee_no,
        'full_name', scoped.full_name,
        'status', scoped.status,
        'hire_date', scoped.hire_date,
        'country', scoped.country,
        'position', scoped.position_name,
        'team', scoped.team_name,
        'group', scoped.group_name,
        'shift', scoped.shift_name,
        'platform', scoped.platform,
        'work_content', scoped.work_content,
        'responsible', scoped.responsible,
        'onsite_trainer', scoped.onsite_trainer,
        'online_leader', scoped.online_leader,
        'online_trainer', scoped.online_trainer
      ) order by scoped.team_name, scoped.group_name, scoped.position_name, scoped.full_name)
      from scoped
      where v_caller_employee_id is not null
        and session_private.online_training_snapshot_employee_id(scoped.online_trainer)
          = v_caller_employee_id
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(option.value order by option.value)
      from (select distinct btrim(scoped.online_trainer) value from scoped
        where nullif(btrim(scoped.online_trainer), '') is not null) option
    ), '[]'::jsonb),
    jsonb_build_object(
      'trainer', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.online_trainer) value from scoped where nullif(btrim(scoped.online_trainer), '') is not null) option), '[]'::jsonb),
      'team', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.team_name) value from scoped where nullif(btrim(scoped.team_name), '') is not null) option), '[]'::jsonb),
      'group', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.group_name) value from scoped where nullif(btrim(scoped.group_name), '') is not null) option), '[]'::jsonb),
      'position', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.position_name) value from scoped where nullif(btrim(scoped.position_name), '') is not null) option), '[]'::jsonb),
      'shift', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.shift_name) value from scoped where nullif(btrim(scoped.shift_name), '') is not null) option), '[]'::jsonb),
      'platform', coalesce((select jsonb_agg(option.value order by option.value) from (select distinct btrim(scoped.platform) value from scoped where nullif(btrim(scoped.platform), '') is not null) option), '[]'::jsonb)
    )
  into v_my_roster, v_manager_options, v_filter_options;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'user_id', v_user_id,
      'employee_id', v_caller_employee_id,
      'employee_no', coalesce(v_employee_no, ''),
      'employee_name', coalesce(v_employee_name, ''),
      'login_username', coalesce(v_login_username, ''),
      'role_code', coalesce(v_role_code, ''),
      'data_scope', coalesce(v_scope, ''),
      'can_submit', v_can_submit,
      'can_review', v_can_review,
      'can_manage', v_can_manage,
      'is_founder', public.is_founder()
    ),
    'identity_aliases', to_jsonb(array_remove(array[
      nullif(v_employee_no, ''), nullif(v_employee_name, ''), nullif(v_login_username, '')
    ], null)),
    'roster', '[]'::jsonb,
    'my_roster', v_my_roster,
    'manager_options', v_manager_options,
    'filter_options', v_filter_options,
    'auto_assignment', jsonb_build_object(
      'source', '居家排班表/填表',
      'linked', v_caller_employee_id is not null,
      'matched', jsonb_array_length(v_my_roster) > 0,
      'member_count', jsonb_array_length(v_my_roster),
      'trainer_name', coalesce(v_employee_name, ''),
      'employee_no', coalesce(v_employee_no, '')
    ),
    'roster_synced_at', v_synced_at
  );
end;
$$;

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
  v_trainer_key text := public.online_training_identity_key(p_trainer_name);
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module()
     or not public.has_permission('online_training.report.manage') then
    raise exception 'permission_denied';
  end if;
  if nullif(v_trainer_key, '') is null then return '[]'::jsonb; end if;

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
    ) order by directory.team_name, directory.group_name, directory.position_name,
      coalesce(nullif(btrim(directory.full_name), ''), employee.full_name))
    from public.report_employee_directory_cache directory
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        public.employee_master_normalize_id(directory.employee_no)
    where directory.source_kind = 'roster'
      and public.backend_employee_in_scope(employee.id)
      and public.online_training_identity_key(
        coalesce(directory.online_trainer, employee.online_trainer, employee.trainer_name, '')
      ) = v_trainer_key
  ), '[]'::jsonb);
end;
$$;

drop policy if exists online_training_members_read
  on public.online_training_report_members;
create policy online_training_members_read
on public.online_training_report_members
for select
to authenticated
using (
  public.online_training_can_view_report(report_id)
  and public.online_training_employee_in_scope(employee_id)
);

-- The two paginated trainer/person directories embed a direct
-- `backend scope OR trainer assignment` CTE. Remove that expansion from their
-- current guarded definitions, failing the migration if a future definition no
-- longer matches the audited shape.
do $harden_online_training_directories$
declare
  v_signature regprocedure;
  v_definition text;
  v_hardened text;
begin
  foreach v_signature in array array[
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure,
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ] loop
    select pg_get_functiondef(v_signature) into v_definition;
    v_hardened := regexp_replace(
      v_definition,
      'where public\.backend_employee_in_scope\(employee\.id\)[[:space:]]+or assignment\.employee_id is not null',
      'where public.backend_employee_in_scope(employee.id)',
      'g'
    );
    if v_hardened = v_definition then
      raise exception 'online_training_directory_scope_definition_changed: %', v_signature;
    end if;
    execute v_hardened;
  end loop;
end;
$harden_online_training_directories$;

revoke all on function
  public.online_training_is_assigned_member(uuid),
  public.online_training_employee_in_scope(uuid),
  public.online_training_employee_history_in_scope(uuid),
  public.online_training_caller_is_report_trainer(uuid),
  public.online_training_can_view_report(uuid),
  public.online_training_can_edit_report(uuid),
  public.online_training_context(),
  public.online_training_roster_for_trainer(text)
  from public, anon;
grant execute on function
  public.online_training_is_assigned_member(uuid),
  public.online_training_employee_in_scope(uuid),
  public.online_training_employee_history_in_scope(uuid),
  public.online_training_caller_is_report_trainer(uuid),
  public.online_training_can_view_report(uuid),
  public.online_training_can_edit_report(uuid)
  to authenticated, service_role;
grant execute on function
  public.online_training_context(),
  public.online_training_roster_for_trainer(text)
  to authenticated;

comment on function public.online_training_employee_in_scope(uuid) is
  'Online-training scope never expands generic backend employee scope; trainer assignment only controls actions within that ceiling.';

-- Convert every existing assigned scope now.  This is the production fix for
-- accounts such as lele001: the legacy team table is emptied and all modules
-- receive only the exact effective employee IDs. own-team is also materialized
-- so large reports do not recompute the roster directory once per data row.
do $rebuild_existing_assigned_scopes$
declare
  account record;
begin
  for account in
    select access.auth_user_id
    from public.user_access access
    where access.data_scope in ('own_team', 'assigned_teams')
    order by access.auth_user_id
  loop
    perform scope_private.rebuild_account_employee_scope(account.auth_user_id);
  end loop;
end;
$rebuild_existing_assigned_scopes$;

notify pgrst, 'reload schema';

commit;
