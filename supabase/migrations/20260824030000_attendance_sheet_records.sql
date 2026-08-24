-- Canonical attendance / resignation / adjustment rows imported from sheets.
--
-- The public tables are deliberately not a Data API surface. Authenticated
-- clients read them only through the permission-checked public RPC wrappers;
-- the SECURITY DEFINER implementations live in the non-exposed private schema.

create schema if not exists attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;

create table if not exists public.attendance_sheet_sources (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_name text not null,
  scope text not null default 'attendance',
  source_group text,
  source_month text,
  sheet_id text,
  sheet_gid text,
  sheet_url text,
  status text not null default 'pending',
  is_active boolean not null default true,
  row_count integer not null default 0,
  matched_count integer not null default 0,
  unmatched_count integer not null default 0,
  ambiguous_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  content_hash text,
  sync_started_at timestamptz,
  synced_at timestamptz,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint attendance_sheet_sources_key_not_blank
    check (btrim(source_key) <> ''),
  constraint attendance_sheet_sources_name_not_blank
    check (btrim(source_name) <> ''),
  constraint attendance_sheet_sources_scope_check
    check (scope in ('attendance', 'adjustment', 'mixed')),
  constraint attendance_sheet_sources_month_check
    check (
      source_month is null
      or source_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    ),
  constraint attendance_sheet_sources_status_check
    check (status in ('pending', 'running', 'success', 'partial', 'failed', 'disabled')),
  constraint attendance_sheet_sources_counts_check
    check (
      row_count >= 0
      and matched_count >= 0
      and unmatched_count >= 0
      and ambiguous_count >= 0
      and skipped_count >= 0
      and error_count >= 0
    ),
  constraint attendance_sheet_sources_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create table if not exists public.employee_attendance_records (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.attendance_sheet_sources(id) on delete restrict,
  source_block text not null default 'main',
  source_row integer not null,
  source_item_key text not null default 'primary',
  kind text not null,
  event_date date,
  event_kind text not null,
  reason text,
  note text,
  amount numeric,
  raw_amount text,
  employee_id uuid references public.employees(id) on delete set null,
  employee_no_raw text,
  employee_name_raw text,
  employee_status_raw text,
  team_name_raw text,
  position_name_raw text,
  country_raw text,
  platform_raw text,
  manager_raw text,
  match_status text not null default 'unmatched',
  match_method text,
  matched_at timestamptz,
  raw_values jsonb not null default '{}'::jsonb,
  content_hash text not null,
  is_mirror boolean not null default false,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_attendance_source_position_unique
    unique (source_id, source_block, source_row, source_item_key),
  constraint employee_attendance_source_row_check
    check (source_row > 0),
  constraint employee_attendance_source_block_not_blank
    check (btrim(source_block) <> ''),
  constraint employee_attendance_source_item_not_blank
    check (btrim(source_item_key) <> ''),
  constraint employee_attendance_kind_check
    check (kind in ('attendance', 'resignation', 'adjustment')),
  constraint employee_attendance_event_kind_not_blank
    check (btrim(event_kind) <> ''),
  constraint employee_attendance_resignation_kind_check
    check (kind <> 'resignation' or event_kind = 'resignation'),
  constraint employee_attendance_match_status_check
    check (match_status in ('matched', 'unmatched', 'ambiguous')),
  constraint employee_attendance_match_method_check
    check (
      match_method is null
      or match_method in ('employee_id_exact', 'name_unique_exact')
    ),
  constraint employee_attendance_match_consistency_check
    check (
      (
        match_status = 'matched'
        and employee_id is not null
        and match_method is not null
      )
      or (
        match_status in ('unmatched', 'ambiguous')
        and employee_id is null
        and match_method is null
      )
    ),
  constraint employee_attendance_raw_values_object_check
    check (jsonb_typeof(raw_values) = 'object'),
  constraint employee_attendance_content_hash_not_blank
    check (btrim(content_hash) <> '')
);

create index if not exists attendance_sources_scope_month_group_idx
  on public.attendance_sheet_sources (scope, source_month desc, source_group, source_key);
create index if not exists attendance_sources_synced_at_idx
  on public.attendance_sheet_sources (synced_at desc nulls last, id);

create index if not exists employee_attendance_event_date_idx
  on public.employee_attendance_records (event_date desc nulls last, id desc);
create index if not exists employee_attendance_employee_event_idx
  on public.employee_attendance_records (employee_id, event_date desc nulls last, id desc)
  where employee_id is not null;
create index if not exists employee_attendance_source_event_idx
  on public.employee_attendance_records (source_id, event_date desc nulls last, id desc);
create index if not exists employee_attendance_kind_event_idx
  on public.employee_attendance_records (kind, event_date desc nulls last, id desc);
create index if not exists employee_attendance_match_event_idx
  on public.employee_attendance_records (match_status, event_date desc nulls last, id desc);
create index if not exists employee_attendance_employee_no_exact_idx
  on public.employee_attendance_records (upper(btrim(employee_no_raw)))
  where nullif(btrim(employee_no_raw), '') is not null;
create index if not exists employee_attendance_employee_name_norm_idx
  on public.employee_attendance_records (public.exam_norm(employee_name_raw))
  where nullif(public.exam_norm(employee_name_raw), '') is not null;
create index if not exists employee_attendance_content_hash_idx
  on public.employee_attendance_records (content_hash);

alter table public.attendance_sheet_sources enable row level security;
alter table public.employee_attendance_records enable row level security;

revoke all on table public.attendance_sheet_sources from public, anon, authenticated;
revoke all on table public.employee_attendance_records from public, anon, authenticated;
grant select, insert, update, delete on table public.attendance_sheet_sources to service_role;
grant select, insert, update, delete on table public.employee_attendance_records to service_role;

drop policy if exists attendance_sheet_sources_no_direct_access
  on public.attendance_sheet_sources;
create policy attendance_sheet_sources_no_direct_access
  on public.attendance_sheet_sources
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists employee_attendance_records_no_direct_access
  on public.employee_attendance_records;
create policy employee_attendance_records_no_direct_access
  on public.employee_attendance_records
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Keep the match tuple valid when an employee is ever hard-deleted. Normal
-- employee lifecycle changes are soft status changes, but the FK uses SET NULL
-- so source history can still be retained in the exceptional hard-delete case.
create or replace function attendance_private.normalize_unlinked_employee_match()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.employee_id is not null and new.employee_id is null then
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

revoke all on function attendance_private.normalize_unlinked_employee_match()
  from public, anon, authenticated;
drop trigger if exists employee_attendance_normalize_unlinked_match
  on public.employee_attendance_records;
create trigger employee_attendance_normalize_unlinked_match
before update of employee_id on public.employee_attendance_records
for each row
execute function attendance_private.normalize_unlinked_employee_match();

-- Re-evaluate every row against the canonical employee directory. Employee IDs
-- are compared exactly after trimming/case folding. Name fallback uses exam_norm
-- and succeeds only when that normalized name identifies exactly one employee.
create or replace function attendance_private.refresh_employee_matches()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scanned bigint := 0;
  v_changed bigint := 0;
  v_matched bigint := 0;
  v_unmatched bigint := 0;
  v_ambiguous bigint := 0;
  v_canonical bigint := 0;
  v_mirrors bigint := 0;
begin
  select count(*) into v_scanned
  from public.employee_attendance_records;

  with employee_id_keys as materialized (
    select
      upper(btrim(e.employee_no)) match_key,
      count(distinct e.id) match_count,
      case
        when count(distinct e.id) = 1 then min(e.id::text)::uuid
      end employee_id
    from public.employees e
    where nullif(btrim(e.employee_no), '') is not null
    group by upper(btrim(e.employee_no))
  ),
  employee_name_keys as materialized (
    select
      public.exam_norm(e.full_name) match_key,
      count(distinct e.id) match_count,
      case
        when count(distinct e.id) = 1 then min(e.id::text)::uuid
      end employee_id
    from public.employees e
    where nullif(public.exam_norm(e.full_name), '') is not null
    group by public.exam_norm(e.full_name)
  ),
  proposed as materialized (
    select
      r.id,
      case
        when id_match.match_count = 1 then id_match.employee_id
        when coalesce(id_match.match_count, 0) = 0
          and name_match.match_count = 1 then name_match.employee_id
      end employee_id,
      case
        when id_match.match_count = 1 then 'matched'
        when coalesce(id_match.match_count, 0) > 1 then 'ambiguous'
        when name_match.match_count = 1 then 'matched'
        when coalesce(name_match.match_count, 0) > 1 then 'ambiguous'
        else 'unmatched'
      end match_status,
      case
        when id_match.match_count = 1 then 'employee_id_exact'
        when coalesce(id_match.match_count, 0) = 0
          and name_match.match_count = 1 then 'name_unique_exact'
      end match_method
    from public.employee_attendance_records r
    left join employee_id_keys id_match
      on id_match.match_key = upper(btrim(r.employee_no_raw))
    left join employee_name_keys name_match
      on name_match.match_key = public.exam_norm(r.employee_name_raw)
  )
  update public.employee_attendance_records r
  set
    employee_id = p.employee_id,
    match_status = p.match_status,
    match_method = p.match_method,
    matched_at = case when p.match_status = 'matched' then now() end,
    updated_at = now()
  from proposed p
  where p.id = r.id
    and (
      r.employee_id,
      r.match_status,
      r.match_method
    ) is distinct from (
      p.employee_id,
      p.match_status,
      p.match_method
    );

  get diagnostics v_changed = row_count;

  select
    count(*) filter (where not r.is_mirror),
    count(*) filter (where r.is_mirror),
    count(*) filter (where not r.is_mirror and r.match_status = 'matched'),
    count(*) filter (where not r.is_mirror and r.match_status = 'unmatched'),
    count(*) filter (where not r.is_mirror and r.match_status = 'ambiguous')
  into v_canonical, v_mirrors, v_matched, v_unmatched, v_ambiguous
  from public.employee_attendance_records r;

  with source_counts as materialized (
    select
      s0.id,
      count(r.id) filter (
        where not r.is_mirror and r.match_status = 'matched'
      )::integer matched_count,
      count(r.id) filter (
        where not r.is_mirror and r.match_status = 'unmatched'
      )::integer unmatched_count,
      count(r.id) filter (
        where not r.is_mirror and r.match_status = 'ambiguous'
      )::integer ambiguous_count
    from public.attendance_sheet_sources s0
    left join public.employee_attendance_records r on r.source_id = s0.id
    group by s0.id
  )
  update public.attendance_sheet_sources s
  set
    matched_count = c.matched_count,
    unmatched_count = c.unmatched_count,
    ambiguous_count = c.ambiguous_count,
    updated_at = now()
  from source_counts c
  where c.id = s.id
    and (
      s.matched_count,
      s.unmatched_count,
      s.ambiguous_count
    ) is distinct from (
      c.matched_count,
      c.unmatched_count,
      c.ambiguous_count
    );

  return jsonb_build_object(
    'scanned', v_scanned,
    'canonical_rows', v_canonical,
    'mirror_rows', v_mirrors,
    'changed', v_changed,
    'matched', v_matched,
    'unmatched', v_unmatched,
    'ambiguous', v_ambiguous
  );
end;
$$;

create or replace function attendance_private.admin_attendance_home(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_scope text := lower(btrim(coalesce(p_filters->>'scope', 'attendance')));
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_date_from date := nullif(p_filters->>'date_from', '')::date;
  v_date_to date := nullif(p_filters->>'date_to', '')::date;
  v_source_month text := btrim(coalesce(p_filters->>'source_month', ''));
  v_source_group text := btrim(coalesce(p_filters->>'source_group', ''));
  v_source_key text := btrim(coalesce(p_filters->>'source_key', p_filters->>'source', ''));
  v_event_kind text := btrim(coalesce(p_filters->>'event_kind', ''));
  v_employee_status text := btrim(coalesce(p_filters->>'employee_status', ''));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_position text := btrim(coalesce(p_filters->>'position', ''));
  v_country text := btrim(coalesce(p_filters->>'country', ''));
  v_platform text := btrim(coalesce(p_filters->>'platform', ''));
  v_manager text := btrim(coalesce(p_filters->>'manager', ''));
  v_match_status text := btrim(coalesce(p_filters->>'match_status', ''));
  v_include_mirrors boolean := lower(btrim(coalesce(p_filters->>'include_mirrors', 'false')))
    in ('true', '1', 'yes');
  v_page integer := least(
    greatest(coalesce(nullif(p_filters->>'page', '')::integer, 1), 1),
    1000000
  );
  v_page_size integer := least(
    greatest(coalesce(nullif(p_filters->>'page_size', '')::integer, 30), 1),
    100
  );
  v_result jsonb;
  v_swap_date date;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not (
    public.has_permission('attendance.view')
    or public.has_permission('employee.view')
    or public.has_permission('schedule.view')
  ) then
    raise exception 'permission_denied';
  end if;
  if v_scope not in ('attendance', 'adjustment') then
    raise exception 'invalid_scope';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    v_swap_date := v_date_from;
    v_date_from := v_date_to;
    v_date_to := v_swap_date;
  end if;

  with enriched as materialized (
    select
      r.id,
      case when r.kind = 'adjustment' then 'adjustment' else 'attendance' end scope,
      r.kind,
      r.event_date,
      r.event_kind,
      r.reason,
      r.note,
      r.amount,
      r.raw_amount,
      r.employee_id,
      coalesce(nullif(btrim(e.employee_no), ''), r.employee_no_raw) employee_no,
      coalesce(nullif(btrim(e.full_name), ''), r.employee_name_raw) full_name,
      coalesce(nullif(btrim(e.status), ''), r.employee_status_raw) employee_status,
      coalesce(nullif(btrim(t.name), ''), r.team_name_raw) team_name,
      coalesce(nullif(btrim(pos.name), ''), r.position_name_raw) position_name,
      coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), ''), r.country_raw) country,
      coalesce(nullif(btrim(e.platform_scope), ''), r.platform_raw) platform,
      coalesce(
        nullif(concat_ws(
          ' / ',
          nullif(btrim(e.person_in_charge), ''),
          nullif(btrim(e.leader_name), ''),
          nullif(btrim(e.online_leader), ''),
          nullif(btrim(e.online_trainer), ''),
          nullif(btrim(e.on_site_trainer), ''),
          nullif(btrim(e.trainer_name), '')
        ), ''),
        r.manager_raw
      ) manager,
      r.employee_no_raw,
      r.employee_name_raw,
      r.employee_status_raw,
      r.team_name_raw,
      r.position_name_raw,
      r.country_raw,
      r.platform_raw,
      r.manager_raw,
      r.match_status,
      r.match_method,
      r.matched_at,
      s.id source_id,
      s.source_key,
      s.source_name,
      s.source_name source_title,
      s.scope source_scope,
      s.source_group,
      s.source_month,
      s.status source_status,
      r.source_row,
      r.source_block,
      r.source_item_key,
      r.content_hash,
      r.is_mirror,
      r.raw_values,
      r.source_updated_at,
      r.synced_at,
      r.created_at,
      r.updated_at
    from public.employee_attendance_records r
    join public.attendance_sheet_sources s on s.id = r.source_id
    left join public.employees e on e.id = r.employee_id
    left join public.teams t on t.id = e.team_id
    left join public.positions pos on pos.id = e.position_id
    where (
      (v_scope = 'adjustment' and r.kind = 'adjustment')
      or (v_scope = 'attendance' and r.kind in ('attendance', 'resignation'))
    )
  ),
  filtered as materialized (
    select x.*
    from enriched x
    where (v_include_mirrors or not x.is_mirror)
      and (
        v_search = ''
        or lower(concat_ws(
          ' ',
          x.employee_no,
          x.full_name,
          x.employee_no_raw,
          x.employee_name_raw,
          x.reason,
          x.note,
          x.amount,
          x.raw_amount,
          x.event_kind,
          x.source_name,
          x.source_key,
          x.source_month,
          x.source_group,
          x.source_block,
          x.source_row,
          x.team_name,
          x.position_name,
          x.country,
          x.platform,
          x.manager,
          x.team_name_raw,
          x.position_name_raw,
          x.country_raw,
          x.platform_raw,
          x.manager_raw
        )) like '%' || v_search || '%'
      )
      and (v_date_from is null or x.event_date >= v_date_from)
      and (v_date_to is null or x.event_date <= v_date_to)
      and (v_source_month = '' or x.source_month = v_source_month)
      and (v_source_group = '' or x.source_group = v_source_group)
      and (v_source_key = '' or x.source_key = v_source_key)
      and (v_event_kind = '' or x.event_kind = v_event_kind)
      and (
        v_employee_status = ''
        or (v_employee_status = 'unmatched' and x.employee_id is null)
        or (
          v_employee_status <> 'unmatched'
          and x.employee_status = v_employee_status
        )
      )
      and (v_team = '' or public.exam_norm(x.team_name) = public.exam_norm(v_team))
      and (v_position = '' or public.exam_norm(x.position_name) = public.exam_norm(v_position))
      and (v_country = '' or public.exam_norm(x.country) = public.exam_norm(v_country))
      and (v_platform = '' or public.exam_norm(x.platform) = public.exam_norm(v_platform))
      and (v_manager = '' or public.exam_norm(x.manager) = public.exam_norm(v_manager))
      and (v_match_status = '' or x.match_status = v_match_status)
  ),
  paged as materialized (
    select f.*
    from filtered f
    order by f.event_date desc nulls last, f.id desc
    limit v_page_size
    offset ((v_page::bigint - 1) * v_page_size)
  )
  select jsonb_build_object(
    'scope', v_scope,
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from filtered),
    'pages', greatest(
      1,
      ceil((select count(*) from filtered)::numeric / v_page_size)::integer
    ),
    'summary', case
      when v_scope = 'adjustment' then (
        select jsonb_build_object(
          'total', count(*),
          'matched', count(*) filter (where f.match_status = 'matched'),
          'unmatched', count(*) filter (where f.match_status = 'unmatched'),
          'ambiguous', count(*) filter (where f.match_status = 'ambiguous'),
          'mirror_count', count(*) filter (where f.is_mirror),
          'employees', count(distinct f.employee_id) filter (where f.employee_id is not null),
          'bonus_count', count(*) filter (
            where f.event_kind = 'bonus'
              or (f.event_kind not in ('bonus', 'deduction') and f.amount > 0)
          ),
          'bonus_total', coalesce(sum(f.amount) filter (where f.amount > 0), 0),
          'deduction_count', count(*) filter (
            where f.event_kind = 'deduction'
              or (f.event_kind not in ('bonus', 'deduction') and f.amount < 0)
          ),
          'deduction_total', abs(coalesce(sum(f.amount) filter (where f.amount < 0), 0)),
          'deduction_total_signed', coalesce(sum(f.amount) filter (where f.amount < 0), 0),
          'net_amount', coalesce(sum(f.amount), 0),
          'incomplete', count(*) filter (where f.amount is null)
        )
        from filtered f
      )
      else (
        select jsonb_build_object(
          'total', count(*),
          'matched', count(*) filter (where f.match_status = 'matched'),
          'unmatched', count(*) filter (where f.match_status = 'unmatched'),
          'ambiguous', count(*) filter (where f.match_status = 'ambiguous'),
          'mirror_count', count(*) filter (where f.is_mirror),
          'employees', count(distinct f.employee_id) filter (where f.employee_id is not null),
          'public_holiday', count(*) filter (where f.event_kind = 'public_holiday'),
          'home_leave', count(*) filter (where f.event_kind = 'home_leave'),
          'leave', count(*) filter (where f.event_kind = 'leave'),
          'half_day', count(*) filter (where f.event_kind = 'half_day'),
          'absence', count(*) filter (where f.event_kind = 'absence'),
          'resignation', count(*) filter (
            where f.kind = 'resignation' or f.event_kind = 'resignation'
          )
        )
        from filtered f
      )
    end,
    'options', jsonb_build_object(
      'source_months', (
        select coalesce(jsonb_agg(o.value order by o.value desc), '[]'::jsonb)
        from (
          select distinct s.source_month value
          from public.attendance_sheet_sources s
          where s.scope in (v_scope, 'mixed')
            and nullif(btrim(s.source_month), '') is not null
        ) o
      ),
      'source_groups', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct s.source_group value
          from public.attendance_sheet_sources s
          where s.scope in (v_scope, 'mixed')
            and nullif(btrim(s.source_group), '') is not null
        ) o
      ),
      'event_kinds', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.event_kind value
          from enriched x
          where nullif(btrim(x.event_kind), '') is not null
        ) o
      ),
      'employee_statuses', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.employee_status value
          from enriched x
          where nullif(btrim(x.employee_status), '') is not null
        ) o
      ),
      'teams', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.team_name value
          from enriched x
          where nullif(btrim(x.team_name), '') is not null
        ) o
      ),
      'positions', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.position_name value
          from enriched x
          where nullif(btrim(x.position_name), '') is not null
        ) o
      ),
      'countries', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.country value
          from enriched x
          where nullif(btrim(x.country), '') is not null
        ) o
      ),
      'platforms', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.platform value
          from enriched x
          where nullif(btrim(x.platform), '') is not null
        ) o
      ),
      'managers', (
        select coalesce(jsonb_agg(o.value order by o.value), '[]'::jsonb)
        from (
          select distinct x.manager value
          from enriched x
          where nullif(btrim(x.manager), '') is not null
        ) o
      ),
      'match_statuses', jsonb_build_array('matched', 'unmatched', 'ambiguous')
    ),
    'sources', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', s.id,
            'source_key', s.source_key,
            'source_name', s.source_name,
            'source_title', s.source_name,
            'scope', s.scope,
            'source_group', s.source_group,
            'source_month', s.source_month,
            'status', s.status,
            'is_active', s.is_active,
            'row_count', s.row_count,
            'matched_count', s.matched_count,
            'unmatched_count', s.unmatched_count,
            'ambiguous_count', s.ambiguous_count,
            'skipped_count', s.skipped_count,
            'error_count', s.error_count,
            'latest_sync', s.synced_at,
            'synced_at', s.synced_at,
            'sync_started_at', s.sync_started_at,
            'error_message', s.error_message,
            'content_hash', s.content_hash,
            'metadata', s.metadata
          )
          order by s.source_month desc nulls last, s.source_group, s.source_name
        ),
        '[]'::jsonb
      )
      from public.attendance_sheet_sources s
      where s.scope in (v_scope, 'mixed')
    ),
    'latest_sync', (
      select jsonb_build_object(
        'id', s.id,
        'source_key', s.source_key,
        'source_name', s.source_name,
        'source_title', s.source_name,
        'source_group', s.source_group,
        'source_month', s.source_month,
        'status', s.status,
        'row_count', s.row_count,
        'matched_count', s.matched_count,
        'unmatched_count', s.unmatched_count,
        'ambiguous_count', s.ambiguous_count,
        'started_at', s.sync_started_at,
        'synced_at', s.synced_at,
        'error_message', s.error_message,
        'metadata', s.metadata
      )
      from public.attendance_sheet_sources s
      where s.scope in (v_scope, 'mixed')
        and s.synced_at is not null
      order by s.synced_at desc, s.id desc
      limit 1
    ),
    'rows', coalesce(
      (
        select jsonb_agg(to_jsonb(p) order by p.event_date desc nulls last, p.id desc)
        from paged p
      ),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end;
$$;

create or replace function attendance_private.admin_employee_attendance_history(
  p_employee_id uuid,
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
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not (
    public.has_permission('attendance.view')
    or public.has_permission('employee.view')
    or public.has_permission('schedule.view')
  ) then
    raise exception 'permission_denied';
  end if;
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id
  ) then
    raise exception 'employee_not_found';
  end if;

  with history as materialized (
    select
      r.id,
      r.kind,
      r.event_date,
      r.event_kind,
      r.reason,
      r.note,
      r.amount,
      r.raw_amount,
      r.employee_id,
      e.employee_no,
      e.full_name,
      e.status employee_status,
      t.name team_name,
      pos.name position_name,
      coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), '')) country,
      e.platform_scope platform,
      nullif(concat_ws(
        ' / ',
        nullif(btrim(e.person_in_charge), ''),
        nullif(btrim(e.leader_name), ''),
        nullif(btrim(e.online_leader), ''),
        nullif(btrim(e.online_trainer), ''),
        nullif(btrim(e.on_site_trainer), ''),
        nullif(btrim(e.trainer_name), '')
      ), '') manager,
      r.employee_no_raw,
      r.employee_name_raw,
      r.employee_status_raw,
      r.team_name_raw,
      r.position_name_raw,
      r.country_raw,
      r.platform_raw,
      r.manager_raw,
      r.match_status,
      r.match_method,
      r.matched_at,
      s.id source_id,
      s.source_key,
      s.source_name,
      s.source_name source_title,
      s.source_group,
      s.source_month,
      s.status source_status,
      r.source_row,
      r.source_block,
      r.source_item_key,
      r.content_hash,
      r.is_mirror,
      r.raw_values,
      r.source_updated_at,
      r.synced_at,
      r.created_at,
      r.updated_at,
      jsonb_build_object(
        'source_id', s.id,
        'source_key', s.source_key,
        'source_name', s.source_name,
        'source_title', s.source_name,
        'source_group', s.source_group,
        'source_month', s.source_month,
        'source_status', s.status,
        'source_row', r.source_row,
        'source_block', r.source_block,
        'source_item_key', r.source_item_key,
        'content_hash', r.content_hash,
        'is_mirror', r.is_mirror,
        'source_updated_at', r.source_updated_at,
        'synced_at', r.synced_at,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'raw_values', r.raw_values
      ) source_audit
    from public.employee_attendance_records r
    join public.attendance_sheet_sources s on s.id = r.source_id
    join public.employees e on e.id = r.employee_id
    left join public.teams t on t.id = e.team_id
    left join public.positions pos on pos.id = e.position_id
    where r.employee_id = p_employee_id
      and r.kind in ('attendance', 'resignation')
      and not r.is_mirror
  ),
  paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last, h.id desc
    limit v_page_size
    offset ((v_page::bigint - 1) * v_page_size)
  )
  select jsonb_build_object(
    'employee', (
      select to_jsonb(x)
      from (
        select
          e.id,
          e.employee_no,
          e.full_name,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name
        from public.employees e
        left join public.teams t on t.id = e.team_id
        left join public.positions pos on pos.id = e.position_id
        where e.id = p_employee_id
      ) x
    ),
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from history),
    'pages', greatest(
      1,
      ceil((select count(*) from history)::numeric / v_page_size)::integer
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'first_event_date', min(h.event_date),
        'last_event_date', max(h.event_date),
        'mirror_count', count(*) filter (where h.is_mirror),
        'public_holiday', count(*) filter (where h.event_kind = 'public_holiday'),
        'home_leave', count(*) filter (where h.event_kind = 'home_leave'),
        'leave', count(*) filter (where h.event_kind = 'leave'),
        'half_day', count(*) filter (where h.event_kind = 'half_day'),
        'absence', count(*) filter (where h.event_kind = 'absence'),
        'resignation', count(*) filter (
          where h.kind = 'resignation' or h.event_kind = 'resignation'
        )
      )
      from history h
    ),
    'rows', coalesce(
      (
        select jsonb_agg(to_jsonb(p) order by p.event_date desc nulls last, p.id desc)
        from paged p
      ),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end;
$$;

create or replace function attendance_private.admin_employee_adjustment_history(
  p_employee_id uuid,
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
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not (
    public.has_permission('attendance.view')
    or public.has_permission('employee.view')
    or public.has_permission('schedule.view')
  ) then
    raise exception 'permission_denied';
  end if;
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id
  ) then
    raise exception 'employee_not_found';
  end if;

  with history as materialized (
    select
      r.id,
      r.kind,
      r.event_date,
      r.event_kind,
      r.reason,
      r.note,
      r.amount,
      r.raw_amount,
      r.employee_id,
      e.employee_no,
      e.full_name,
      e.status employee_status,
      t.name team_name,
      pos.name position_name,
      coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), '')) country,
      e.platform_scope platform,
      nullif(concat_ws(
        ' / ',
        nullif(btrim(e.person_in_charge), ''),
        nullif(btrim(e.leader_name), ''),
        nullif(btrim(e.online_leader), ''),
        nullif(btrim(e.online_trainer), ''),
        nullif(btrim(e.on_site_trainer), ''),
        nullif(btrim(e.trainer_name), '')
      ), '') manager,
      r.employee_no_raw,
      r.employee_name_raw,
      r.employee_status_raw,
      r.team_name_raw,
      r.position_name_raw,
      r.country_raw,
      r.platform_raw,
      r.manager_raw,
      r.match_status,
      r.match_method,
      r.matched_at,
      s.id source_id,
      s.source_key,
      s.source_name,
      s.source_name source_title,
      s.source_group,
      s.source_month,
      s.status source_status,
      r.source_row,
      r.source_block,
      r.source_item_key,
      r.content_hash,
      r.is_mirror,
      r.raw_values,
      r.source_updated_at,
      r.synced_at,
      r.created_at,
      r.updated_at,
      jsonb_build_object(
        'source_id', s.id,
        'source_key', s.source_key,
        'source_name', s.source_name,
        'source_title', s.source_name,
        'source_group', s.source_group,
        'source_month', s.source_month,
        'source_status', s.status,
        'source_row', r.source_row,
        'source_block', r.source_block,
        'source_item_key', r.source_item_key,
        'content_hash', r.content_hash,
        'is_mirror', r.is_mirror,
        'source_updated_at', r.source_updated_at,
        'synced_at', r.synced_at,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'raw_values', r.raw_values,
        'raw_amount', r.raw_amount
      ) source_audit
    from public.employee_attendance_records r
    join public.attendance_sheet_sources s on s.id = r.source_id
    join public.employees e on e.id = r.employee_id
    left join public.teams t on t.id = e.team_id
    left join public.positions pos on pos.id = e.position_id
    where r.employee_id = p_employee_id
      and r.kind = 'adjustment'
      and not r.is_mirror
  ),
  paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last, h.id desc
    limit v_page_size
    offset ((v_page::bigint - 1) * v_page_size)
  )
  select jsonb_build_object(
    'employee', (
      select to_jsonb(x)
      from (
        select
          e.id,
          e.employee_no,
          e.full_name,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name
        from public.employees e
        left join public.teams t on t.id = e.team_id
        left join public.positions pos on pos.id = e.position_id
        where e.id = p_employee_id
      ) x
    ),
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from history),
    'pages', greatest(
      1,
      ceil((select count(*) from history)::numeric / v_page_size)::integer
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'first_event_date', min(h.event_date),
        'last_event_date', max(h.event_date),
        'mirror_count', count(*) filter (where h.is_mirror),
        'bonus_count', count(*) filter (
          where h.event_kind = 'bonus'
            or (h.event_kind not in ('bonus', 'deduction') and h.amount > 0)
        ),
        'bonus_total', coalesce(sum(h.amount) filter (where h.amount > 0), 0),
        'deduction_count', count(*) filter (
          where h.event_kind = 'deduction'
            or (h.event_kind not in ('bonus', 'deduction') and h.amount < 0)
        ),
        'deduction_total', abs(coalesce(sum(h.amount) filter (where h.amount < 0), 0)),
        'deduction_total_signed', coalesce(sum(h.amount) filter (where h.amount < 0), 0),
        'net_amount', coalesce(sum(h.amount), 0),
        'incomplete', count(*) filter (where h.amount is null)
      )
      from history h
    ),
    'rows', coalesce(
      (
        select jsonb_agg(to_jsonb(p) order by p.event_date desc nulls last, p.id desc)
        from paged p
      ),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end;
$$;

-- The private implementations must remain outside the exposed schemas. The
-- authenticated role needs USAGE/EXECUTE only so the SECURITY INVOKER wrappers
-- can call them; each implementation performs its own auth.uid/permission check.
revoke all on function attendance_private.refresh_employee_matches()
  from public, anon, authenticated;
revoke all on function attendance_private.admin_attendance_home(jsonb)
  from public, anon, authenticated;
revoke all on function attendance_private.admin_employee_attendance_history(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function attendance_private.admin_employee_adjustment_history(uuid, integer, integer)
  from public, anon, authenticated;

grant usage on schema attendance_private to authenticated, service_role;
grant execute on function attendance_private.admin_attendance_home(jsonb)
  to authenticated;
grant execute on function attendance_private.admin_employee_attendance_history(uuid, integer, integer)
  to authenticated;
grant execute on function attendance_private.admin_employee_adjustment_history(uuid, integer, integer)
  to authenticated;
grant execute on function attendance_private.refresh_employee_matches()
  to service_role;

create or replace function public.admin_attendance_home(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select attendance_private.admin_attendance_home(p_filters);
$$;

create or replace function public.admin_employee_attendance_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select attendance_private.admin_employee_attendance_history(
    p_employee_id,
    p_page,
    p_page_size
  );
$$;

create or replace function public.admin_employee_adjustment_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select attendance_private.admin_employee_adjustment_history(
    p_employee_id,
    p_page,
    p_page_size
  );
$$;

revoke all on function public.admin_attendance_home(jsonb)
  from public, anon, authenticated;
revoke all on function public.admin_employee_attendance_history(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.admin_employee_adjustment_history(uuid, integer, integer)
  from public, anon, authenticated;

grant execute on function public.admin_attendance_home(jsonb)
  to authenticated;
grant execute on function public.admin_employee_attendance_history(uuid, integer, integer)
  to authenticated;
grant execute on function public.admin_employee_adjustment_history(uuid, integer, integer)
  to authenticated;

comment on table public.attendance_sheet_sources is
  'Sheet source registry and latest synchronization audit for attendance imports.';
comment on table public.employee_attendance_records is
  'Canonical attendance, resignation, and signed adjustment rows with complete source audit.';
comment on function attendance_private.refresh_employee_matches() is
  'Refresh exact employee-number and unique normalized-name matches; callable only by service_role.';

notify pgrst, 'reload schema';
