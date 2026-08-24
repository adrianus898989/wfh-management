-- Attendance identity, money-unit, and calendar read model.
--
-- Historical employees are deliberately not recreated in public.employees.
-- Attendance rows keep their original match tuple for audit, while the private
-- read model can safely resolve a removed employee through lifecycle history:
-- exact employee number first, then an exact normalized name only when that
-- name maps to one and only one historical employee number.

create index if not exists employee_lifecycle_events_employee_no_norm_idx
  on public.employee_lifecycle_events (upper(btrim(employee_no)))
  where nullif(btrim(employee_no), '') is not null;

create index if not exists employee_lifecycle_events_name_norm_idx
  on public.employee_lifecycle_events (public.exam_norm(full_name))
  where nullif(public.exam_norm(full_name), '') is not null;

alter table public.employee_attendance_records
  add column if not exists currency text;

create or replace function attendance_private.country_is_philippines(p_value text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select
    public.exam_norm(p_value) in (
      '菲律宾', '菲律賓', 'philippines', 'philippine', 'filipino', 'ph'
    )
    or public.exam_norm(p_value) like '%菲律宾%'
    or public.exam_norm(p_value) like '%菲律賓%'
    or public.exam_norm(p_value) like '%philippin%';
$$;

revoke all on function attendance_private.country_is_philippines(text)
  from public, anon, authenticated;

create or replace view attendance_private.historical_employee_directory
with (security_invoker = true, security_barrier = true)
as
with normalized as (
  select
    upper(btrim(le.employee_no)) employee_no_key,
    nullif(btrim(le.employee_no), '') employee_no,
    nullif(btrim(le.full_name), '') full_name,
    public.exam_norm(le.full_name) name_key,
    le.employee_id current_employee_id,
    le.event_type,
    le.effective_date,
    le.created_at,
    coalesce(le.effective_date, le.created_at::date) sort_date,
    case
      when coalesce(le.snapshot->>'hire_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
        then (le.snapshot->>'hire_date')::date
    end hire_date,
    nullif(btrim(le.snapshot->>'employment_type'), '') employment_type,
    coalesce(
      nullif(btrim(le.snapshot->>'country'), ''),
      nullif(btrim(le.snapshot->>'国家 country'), ''),
      nullif(btrim(le.snapshot->>'员工国家'), ''),
      nullif(btrim(le.snapshot->>'国家'), '')
    ) country,
    coalesce(
      nullif(btrim(le.snapshot->>'platform_scope'), ''),
      nullif(btrim(le.snapshot->>'盘口'), ''),
      nullif(btrim(le.snapshot->>'market_country'), ''),
      nullif(btrim(le.snapshot->>'盘口国家'), '')
    ) platform,
    coalesce(
      nullif(btrim(le.snapshot->>'position_name'), ''),
      nullif(btrim(le.snapshot->>'position'), ''),
      nullif(btrim(le.snapshot->>'岗位'), ''),
      nullif(btrim(le.snapshot->>'盘口岗位 Platform position'), '')
    ) position_name,
    coalesce(
      nullif(btrim(le.snapshot->>'team_name'), ''),
      nullif(btrim(le.snapshot->>'团队'), '')
    ) team_name_snapshot,
    case
      when coalesce(le.snapshot->>'team_id', '')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        then (le.snapshot->>'team_id')::uuid
    end team_id,
    coalesce(
      nullif(btrim(le.snapshot->>'manager'), ''),
      nullif(btrim(le.snapshot->>'person_in_charge'), ''),
      nullif(btrim(le.snapshot->>'leader_name'), ''),
      nullif(btrim(le.snapshot->>'online_leader'), ''),
      nullif(btrim(le.snapshot->>'online_trainer'), ''),
      nullif(btrim(le.snapshot->>'on_site_trainer'), ''),
      nullif(btrim(le.snapshot->>'trainer_name'), '')
    ) manager
  from public.employee_lifecycle_events le
  where nullif(btrim(le.employee_no), '') is not null
), aggregated as (
  select
    n.employee_no_key,
    (array_agg(n.employee_no order by n.sort_date desc, n.created_at desc))[1]
      employee_no,
    (array_agg(n.full_name order by n.sort_date desc, n.created_at desc)
      filter (where n.full_name is not null))[1] full_name,
    (array_agg(n.current_employee_id order by n.sort_date desc, n.created_at desc)
      filter (where n.current_employee_id is not null))[1] current_employee_id,
    (array_agg(n.hire_date order by n.sort_date desc, n.created_at desc)
      filter (where n.hire_date is not null))[1] snapshot_hire_date,
    min(n.effective_date) filter (where n.event_type = 'join') first_join_date,
    max(n.effective_date) filter (where n.event_type = 'resign') last_resign_date,
    max(n.effective_date) filter (where n.event_type in ('join', 'reactivate'))
      last_active_date,
    (array_agg(
      n.event_type
      order by
        n.sort_date desc,
        case n.event_type
          when 'reactivate' then 3
          when 'resign' then 2
          when 'join' then 1
          else 0
        end desc,
        n.created_at desc
    ))[1] latest_event_type,
    (array_agg(n.employment_type order by n.sort_date desc, n.created_at desc)
      filter (where n.employment_type is not null))[1] employment_type,
    (array_agg(n.country order by n.sort_date desc, n.created_at desc)
      filter (where n.country is not null))[1] country,
    (array_agg(n.platform order by n.sort_date desc, n.created_at desc)
      filter (where n.platform is not null))[1] platform,
    (array_agg(n.position_name order by n.sort_date desc, n.created_at desc)
      filter (where n.position_name is not null))[1] position_name,
    (array_agg(n.team_name_snapshot order by n.sort_date desc, n.created_at desc)
      filter (where n.team_name_snapshot is not null))[1] team_name_snapshot,
    (array_agg(n.team_id order by n.sort_date desc, n.created_at desc)
      filter (where n.team_id is not null))[1] team_id,
    (array_agg(n.manager order by n.sort_date desc, n.created_at desc)
      filter (where n.manager is not null))[1] manager
  from normalized n
  group by n.employee_no_key
)
select
  a.employee_no_key,
  a.employee_no,
  a.full_name,
  public.exam_norm(a.full_name) name_key,
  a.current_employee_id,
  coalesce(a.snapshot_hire_date, a.first_join_date) hire_date,
  a.last_resign_date resign_date,
  a.employment_type,
  a.country,
  a.platform,
  coalesce(t.name, a.team_name_snapshot) team_name,
  a.position_name,
  a.manager,
  a.latest_event_type,
  case
    when a.latest_event_type = 'resign' then 'resigned'
    when a.latest_event_type in ('join', 'reactivate') then 'historical'
    else 'historical'
  end employee_status
from aggregated a
left join public.teams t on t.id = a.team_id;

create or replace view attendance_private.historical_employee_aliases
with (security_invoker = true, security_barrier = true)
as
select
  public.exam_norm(le.full_name) name_key,
  count(distinct upper(btrim(le.employee_no))) identity_count,
  case
    when count(distinct upper(btrim(le.employee_no))) = 1
      then min(upper(btrim(le.employee_no)))
  end employee_no_key
from public.employee_lifecycle_events le
where nullif(public.exam_norm(le.full_name), '') is not null
  and nullif(btrim(le.employee_no), '') is not null
group by public.exam_norm(le.full_name);

revoke all on attendance_private.historical_employee_directory
  from public, anon, authenticated;
revoke all on attendance_private.historical_employee_aliases
  from public, anon, authenticated;

create or replace function attendance_private.resolve_adjustment_currency(
  p_source_id uuid,
  p_employee_id uuid,
  p_employee_no_raw text,
  p_employee_name_raw text,
  p_country_raw text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source_group text;
  v_country text := nullif(btrim(p_country_raw), '');
  v_employment_type text;
  v_history_key text;
begin
  select s.source_group
  into v_source_group
  from public.attendance_sheet_sources s
  where s.id = p_source_id;

  select
    coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), ''), v_country),
    nullif(btrim(e.employment_type), '')
  into v_country, v_employment_type
  from public.employees e
  where e.id = p_employee_id
    or (
      p_employee_id is null
      and nullif(btrim(p_employee_no_raw), '') is not null
      and upper(btrim(e.employee_no)) = upper(btrim(p_employee_no_raw))
    )
  order by (e.id = p_employee_id) desc
  limit 1;

  if v_employment_type is null or v_country is null then
    select h.employee_no_key
    into v_history_key
    from attendance_private.historical_employee_directory h
    where h.employee_no_key = upper(btrim(p_employee_no_raw))
    limit 1;

    if v_history_key is null then
      select a.employee_no_key
      into v_history_key
      from attendance_private.historical_employee_aliases a
      where a.name_key = public.exam_norm(p_employee_name_raw)
        and a.identity_count = 1
      limit 1;
    end if;

    select
      coalesce(v_country, h.country),
      coalesce(v_employment_type, h.employment_type)
    into v_country, v_employment_type
    from attendance_private.historical_employee_directory h
    where h.employee_no_key = v_history_key;
  end if;

  if v_source_group = 'onsite_to_home'
    or public.exam_norm(v_employment_type) like '%现场转居家%' then
    return 'USD';
  end if;
  if attendance_private.country_is_philippines(v_country) then
    return 'PHP';
  end if;
  if nullif(btrim(v_country), '') is null then
    return null;
  end if;
  return 'USD';
end;
$$;

revoke all on function attendance_private.resolve_adjustment_currency(uuid, uuid, text, text, text)
  from public, anon, authenticated;

create or replace function attendance_private.set_attendance_record_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.currency := case
    when new.kind = 'adjustment' then
      attendance_private.resolve_adjustment_currency(
        new.source_id,
        new.employee_id,
        new.employee_no_raw,
        new.employee_name_raw,
        new.country_raw
      )
    else null
  end;
  return new;
end;
$$;

revoke all on function attendance_private.set_attendance_record_currency()
  from public, anon, authenticated;

drop trigger if exists employee_attendance_set_currency
  on public.employee_attendance_records;
create trigger employee_attendance_set_currency
before insert or update of
  source_id, kind, employee_id, employee_no_raw, employee_name_raw, country_raw
on public.employee_attendance_records
for each row
execute function attendance_private.set_attendance_record_currency();

-- Backfill in one set-based statement. The historical directory and aliases are
-- aggregated once, rather than invoking the trigger resolver (and rebuilding
-- both aggregates) twice for every existing adjustment row.
with historical_directory as materialized (
  select * from attendance_private.historical_employee_directory
), historical_aliases as materialized (
  select * from attendance_private.historical_employee_aliases
), classified as materialized (
  select
    r.id,
    s.source_group,
    coalesce(
      nullif(btrim(e.country), ''),
      nullif(btrim(e.nationality), ''),
      nullif(btrim(r.country_raw), ''),
      h.country
    ) country,
    coalesce(nullif(btrim(e.employment_type), ''), h.employment_type)
      employment_type
  from public.employee_attendance_records r
  join public.attendance_sheet_sources s on s.id = r.source_id
  left join lateral (
    select e0.country, e0.nationality, e0.employment_type
    from public.employees e0
    where e0.id = r.employee_id
      or (
        r.employee_id is null
        and nullif(btrim(r.employee_no_raw), '') is not null
        and upper(btrim(e0.employee_no)) = upper(btrim(r.employee_no_raw))
      )
    order by (e0.id = r.employee_id) desc
    limit 1
  ) e on true
  left join historical_directory h_direct
    on nullif(btrim(r.employee_no_raw), '') is not null
    and h_direct.employee_no_key = upper(btrim(r.employee_no_raw))
  left join historical_aliases ha
    on h_direct.employee_no_key is null
    and ha.name_key = public.exam_norm(r.employee_name_raw)
    and ha.identity_count = 1
  left join historical_directory h_name
    on h_name.employee_no_key = ha.employee_no_key
  left join historical_directory h
    on h.employee_no_key = coalesce(h_direct.employee_no_key, h_name.employee_no_key)
  where r.kind = 'adjustment'
), resolved as materialized (
  select
    c.id,
    case
      when c.source_group = 'onsite_to_home'
        or public.exam_norm(c.employment_type) like '%现场转居家%' then 'USD'
      when attendance_private.country_is_philippines(c.country) then 'PHP'
      when nullif(btrim(c.country), '') is null then null
      else 'USD'
    end currency
  from classified c
)
update public.employee_attendance_records r
set currency = x.currency
from resolved x
where r.id = x.id
  and r.currency is distinct from x.currency;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.employee_attendance_records'::regclass
      and conname = 'employee_attendance_currency_check'
  ) then
    alter table public.employee_attendance_records
      add constraint employee_attendance_currency_check
      check (
        (kind = 'adjustment' and (currency is null or currency in ('USD', 'PHP')))
        or (kind <> 'adjustment' and currency is null)
      ) not valid;
  end if;
end;
$$;

alter table public.employee_attendance_records
  validate constraint employee_attendance_currency_check;

create index if not exists employee_attendance_adjustment_currency_event_idx
  on public.employee_attendance_records (currency, event_date desc nulls last, id desc)
  where kind = 'adjustment';

create or replace view attendance_private.attendance_enriched_records
with (security_invoker = true, security_barrier = true)
as
with historical_directory as materialized (
  select * from attendance_private.historical_employee_directory
), historical_aliases as materialized (
  select * from attendance_private.historical_employee_aliases
), base as (
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
    r.currency stored_currency,
    -- A historical employee id is exposed only when the current employees row
    -- still exists (e.id is null for stale lifecycle references).
    coalesce(
      r.employee_id,
      case when e.id is not null then h.current_employee_id end
    ) employee_id,
    r.employee_id record_employee_id,
    coalesce(nullif(btrim(e.employee_no), ''), h.employee_no, r.employee_no_raw)
      employee_no,
    coalesce(nullif(btrim(e.full_name), ''), h.full_name, r.employee_name_raw)
      full_name,
    coalesce(e.hire_date, h.hire_date) hire_date,
    coalesce(nullif(btrim(e.employment_type), ''), h.employment_type)
      employment_type,
    coalesce(
      nullif(btrim(e.status), ''),
      case
        when r.kind = 'resignation' or r.event_kind = 'resignation' then 'resigned'
        else h.employee_status
      end,
      r.employee_status_raw
    ) employee_status,
    coalesce(nullif(btrim(t.name), ''), h.team_name, r.team_name_raw) team_name,
    coalesce(nullif(btrim(pos.name), ''), h.position_name, r.position_name_raw)
      position_name,
    coalesce(
      nullif(btrim(e.country), ''),
      nullif(btrim(e.nationality), ''),
      h.country,
      r.country_raw
    ) country,
    coalesce(nullif(btrim(e.platform_scope), ''), h.platform, r.platform_raw)
      platform,
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
      h.manager,
      r.manager_raw
    ) manager,
    h.employee_no historical_employee_no,
    h.full_name historical_employee_name,
    case
      when h_direct.employee_no_key is not null then 'historical_employee_no_exact'
      when h_name.employee_no_key is not null then 'historical_name_unique_exact'
    end historical_match_method,
    case
      when coalesce(
        r.employee_id,
        case when e.id is not null then h.current_employee_id end
      ) is not null then 'matched'
      when r.match_status = 'ambiguous' then 'ambiguous'
      when h.employee_no_key is not null and h.employee_status = 'resigned'
        then 'historical_resigned'
      when h.employee_no_key is not null then 'historical_matched'
      when r.kind = 'resignation' or r.event_kind = 'resignation'
        then 'resignation_unlinked'
      else 'unmatched'
    end effective_match_status,
    case
      when r.match_status = 'ambiguous' then true
      when r.match_status = 'unmatched'
        and h.employee_no_key is null
        and r.kind <> 'resignation'
        and r.event_kind <> 'resignation' then true
      else false
    end needs_review,
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
  left join historical_directory h_direct
    on r.employee_id is null
    and r.match_status = 'unmatched'
    and nullif(btrim(r.employee_no_raw), '') is not null
    and h_direct.employee_no_key = upper(btrim(r.employee_no_raw))
  left join historical_aliases ha
    on r.employee_id is null
    and r.match_status = 'unmatched'
    and h_direct.employee_no_key is null
    and ha.name_key = public.exam_norm(r.employee_name_raw)
    and ha.identity_count = 1
  left join historical_directory h_name
    on h_name.employee_no_key = ha.employee_no_key
  left join historical_directory h
    on h.employee_no_key = coalesce(h_direct.employee_no_key, h_name.employee_no_key)
  left join public.employees e
    on e.id = coalesce(r.employee_id, h.current_employee_id)
  left join public.teams t on t.id = e.team_id
  left join public.positions pos on pos.id = e.position_id
)
select
  b.*,
  b.employment_type employee_type,
  case
    when b.kind <> 'adjustment' then null
    when b.source_group = 'onsite_to_home'
      or public.exam_norm(b.employment_type) like '%现场转居家%' then 'USD'
    when attendance_private.country_is_philippines(b.country) then 'PHP'
    when nullif(btrim(b.country), '') is null then null
    else 'USD'
  end currency,
  case
    when b.kind <> 'adjustment' then null
    when b.source_group = 'onsite_to_home' then 'onsite_to_home_usd'
    when public.exam_norm(b.employment_type) like '%现场转居家%'
      then 'employee_type_onsite_to_home_usd'
    when nullif(btrim(b.country), '') is null then 'home_country_unknown'
    when attendance_private.country_is_philippines(b.country)
      then 'home_philippines_php'
    else 'home_non_philippines_usd'
  end currency_rule,
  jsonb_build_object(
    'source_id', b.source_id,
    'source_key', b.source_key,
    'source_name', b.source_name,
    'source_group', b.source_group,
    'source_month', b.source_month,
    'source_status', b.source_status,
    'source_row', b.source_row,
    'source_block', b.source_block,
    'source_item_key', b.source_item_key,
    'content_hash', b.content_hash,
    'is_mirror', b.is_mirror,
    'source_updated_at', b.source_updated_at,
    'synced_at', b.synced_at,
    'created_at', b.created_at,
    'updated_at', b.updated_at,
    'raw_values', b.raw_values,
    'raw_amount', b.raw_amount,
    'stored_currency', b.stored_currency,
    'record_employee_id', b.record_employee_id
  ) source_audit
from base b;

revoke all on attendance_private.attendance_enriched_records
  from public, anon, authenticated;

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
  v_currency text := upper(btrim(coalesce(p_filters->>'currency', '')));
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
  if not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;
  if v_scope not in ('attendance', 'adjustment') then
    raise exception 'invalid_scope';
  end if;
  if v_currency <> '' and v_currency not in ('USD', 'PHP') then
    raise exception 'invalid_currency';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    v_swap_date := v_date_from;
    v_date_from := v_date_to;
    v_date_to := v_swap_date;
  end if;

  with enriched as materialized (
    select x.*
    from attendance_private.attendance_enriched_records x
    where (
      (v_scope = 'adjustment' and x.kind = 'adjustment')
      or (v_scope = 'attendance' and x.kind in ('attendance', 'resignation'))
    )
  ), filtered as materialized (
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
          x.currency,
          x.event_kind,
          x.source_name,
          x.source_key,
          x.source_month,
          x.source_group,
          x.source_block,
          x.source_row,
          x.hire_date,
          x.employment_type,
          x.employee_status,
          x.team_name,
          x.position_name,
          x.country,
          x.platform,
          x.manager,
          x.effective_match_status,
          x.historical_employee_no,
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
        or (v_employee_status = 'unmatched' and x.needs_review)
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
      and (
        v_match_status = ''
        or (v_match_status = 'unmatched' and x.needs_review)
        or x.effective_match_status = v_match_status
      )
      and (v_currency = '' or x.currency = v_currency)
  ), currency_stats as materialized (
    select
      f.currency,
      count(*) filter (
        where f.event_kind = 'bonus'
          or (f.event_kind not in ('bonus', 'deduction') and f.amount > 0)
      ) bonus_count,
      coalesce(sum(f.amount) filter (where f.amount > 0), 0) bonus_total,
      count(*) filter (
        where f.event_kind = 'deduction'
          or (f.event_kind not in ('bonus', 'deduction') and f.amount < 0)
      ) deduction_count,
      abs(coalesce(sum(f.amount) filter (where f.amount < 0), 0)) deduction_total,
      coalesce(sum(f.amount) filter (where f.amount < 0), 0) deduction_total_signed,
      coalesce(sum(f.amount), 0) net_amount,
      count(*) filter (where f.amount is null) incomplete
    from filtered f
    where f.scope = 'adjustment'
      and f.currency is not null
    group by f.currency
  ), paged as materialized (
    select f.*
    from filtered f
    order by
      f.event_date desc nulls last,
      f.hire_date asc nulls last,
      f.employee_no,
      f.id desc
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
          'matched', count(*) filter (where f.effective_match_status = 'matched'),
          'historical_resigned', count(*) filter (
            where f.effective_match_status = 'historical_resigned'
          ),
          'historical_matched', count(*) filter (
            where f.effective_match_status = 'historical_matched'
          ),
          'resignation_unlinked', count(*) filter (
            where f.effective_match_status = 'resignation_unlinked'
          ),
          'unmatched', count(*) filter (where f.needs_review),
          'raw_unmatched', count(*) filter (where f.match_status = 'unmatched'),
          'ambiguous', count(*) filter (where f.match_status = 'ambiguous'),
          'mirror_count', count(*) filter (where f.is_mirror),
          'employees', count(distinct coalesce(
            f.employee_id::text,
            'history:' || f.historical_employee_no
          )) filter (
            where f.employee_id is not null or f.historical_employee_no is not null
          ),
          'bonus_count', count(*) filter (
            where f.event_kind = 'bonus'
              or (f.event_kind not in ('bonus', 'deduction') and f.amount > 0)
          ),
          'deduction_count', count(*) filter (
            where f.event_kind = 'deduction'
              or (f.event_kind not in ('bonus', 'deduction') and f.amount < 0)
          ),
          'incomplete', count(*) filter (where f.amount is null),
          'currency_review_count', count(*) filter (where f.currency is null),
          'currency', case
            when (select count(*) from currency_stats) = 1
              then (select min(cs.currency) from currency_stats cs)
          end,
          'mixed_currency', (select count(*) from currency_stats) > 1,
          'bonus_total', case
            when (select count(*) from currency_stats) = 1
              then (select min(cs.bonus_total) from currency_stats cs)
          end,
          'deduction_total', case
            when (select count(*) from currency_stats) = 1
              then (select min(cs.deduction_total) from currency_stats cs)
          end,
          'deduction_total_signed', case
            when (select count(*) from currency_stats) = 1
              then (select min(cs.deduction_total_signed) from currency_stats cs)
          end,
          'net_amount', case
            when (select count(*) from currency_stats) = 1
              then (select min(cs.net_amount) from currency_stats cs)
          end,
          'currencies', coalesce(
            (
              select jsonb_object_agg(
                cs.currency,
                jsonb_build_object(
                  'bonus_count', cs.bonus_count,
                  'bonus_total', cs.bonus_total,
                  'deduction_count', cs.deduction_count,
                  'deduction_total', cs.deduction_total,
                  'deduction_total_signed', cs.deduction_total_signed,
                  'net_amount', cs.net_amount,
                  'incomplete', cs.incomplete
                )
                order by cs.currency
              )
              from currency_stats cs
            ),
            '{}'::jsonb
          ),
          'money_totals_scope', 'all_filtered_rows'
        )
        from filtered f
      )
      else (
        select jsonb_build_object(
          'total', count(*),
          'matched', count(*) filter (where f.effective_match_status = 'matched'),
          'historical_resigned', count(*) filter (
            where f.effective_match_status = 'historical_resigned'
          ),
          'historical_matched', count(*) filter (
            where f.effective_match_status = 'historical_matched'
          ),
          'resignation_unlinked', count(*) filter (
            where f.effective_match_status = 'resignation_unlinked'
          ),
          'unmatched', count(*) filter (where f.needs_review),
          'raw_unmatched', count(*) filter (where f.match_status = 'unmatched'),
          'ambiguous', count(*) filter (where f.match_status = 'ambiguous'),
          'mirror_count', count(*) filter (where f.is_mirror),
          'employees', count(distinct coalesce(
            f.employee_id::text,
            'history:' || f.historical_employee_no
          )) filter (
            where f.employee_id is not null or f.historical_employee_no is not null
          ),
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
      'currencies', case
        when v_scope = 'adjustment' then jsonb_build_array('PHP', 'USD')
        else '[]'::jsonb
      end,
      'match_statuses', jsonb_build_array(
        'matched',
        'historical_resigned',
        'historical_matched',
        'resignation_unlinked',
        'unmatched',
        'ambiguous'
      )
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
        select jsonb_agg(
          to_jsonb(p)
          order by
            p.event_date desc nulls last,
            p.hire_date asc nulls last,
            p.employee_no,
            p.id desc
        )
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
  ) then
    raise exception 'permission_denied';
  end if;
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id
  ) then
    raise exception 'employee_not_found';
  end if;

  with history as materialized (
    select x.*
    from attendance_private.attendance_enriched_records x
    where x.employee_id = p_employee_id
      and x.kind in ('attendance', 'resignation')
      and not x.is_mirror
  ), paged as materialized (
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
          e.hire_date,
          e.employment_type,
          e.employment_type employee_type,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name,
          nullif(concat_ws(
            ' / ',
            nullif(btrim(e.person_in_charge), ''),
            nullif(btrim(e.leader_name), ''),
            nullif(btrim(e.online_leader), ''),
            nullif(btrim(e.online_trainer), ''),
            nullif(btrim(e.on_site_trainer), ''),
            nullif(btrim(e.trainer_name), '')
          ), '') manager
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
        select jsonb_agg(
          to_jsonb(p)
          order by p.event_date desc nulls last, p.id desc
        )
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
  ) then
    raise exception 'permission_denied';
  end if;
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id
  ) then
    raise exception 'employee_not_found';
  end if;

  with history as materialized (
    select x.*
    from attendance_private.attendance_enriched_records x
    where x.employee_id = p_employee_id
      and x.kind = 'adjustment'
      and not x.is_mirror
  ), currency_stats as materialized (
    select
      h.currency,
      count(*) filter (
        where h.event_kind = 'bonus'
          or (h.event_kind not in ('bonus', 'deduction') and h.amount > 0)
      ) bonus_count,
      coalesce(sum(h.amount) filter (where h.amount > 0), 0) bonus_total,
      count(*) filter (
        where h.event_kind = 'deduction'
          or (h.event_kind not in ('bonus', 'deduction') and h.amount < 0)
      ) deduction_count,
      abs(coalesce(sum(h.amount) filter (where h.amount < 0), 0)) deduction_total,
      coalesce(sum(h.amount) filter (where h.amount < 0), 0) deduction_total_signed,
      coalesce(sum(h.amount), 0) net_amount,
      count(*) filter (where h.amount is null) incomplete
    from history h
    where h.currency is not null
    group by h.currency
  ), paged as materialized (
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
          e.hire_date,
          e.employment_type,
          e.employment_type employee_type,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name,
          nullif(concat_ws(
            ' / ',
            nullif(btrim(e.person_in_charge), ''),
            nullif(btrim(e.leader_name), ''),
            nullif(btrim(e.online_leader), ''),
            nullif(btrim(e.online_trainer), ''),
            nullif(btrim(e.on_site_trainer), ''),
            nullif(btrim(e.trainer_name), '')
          ), '') manager
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
        'deduction_count', count(*) filter (
          where h.event_kind = 'deduction'
            or (h.event_kind not in ('bonus', 'deduction') and h.amount < 0)
        ),
        'incomplete', count(*) filter (where h.amount is null),
        'currency_review_count', count(*) filter (where h.currency is null),
        'currency', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.currency) from currency_stats cs)
        end,
        'mixed_currency', (select count(*) from currency_stats) > 1,
        'bonus_total', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.bonus_total) from currency_stats cs)
        end,
        'deduction_total', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.deduction_total) from currency_stats cs)
        end,
        'deduction_total_signed', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.deduction_total_signed) from currency_stats cs)
        end,
        'net_amount', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.net_amount) from currency_stats cs)
        end,
        'currencies', coalesce(
          (
            select jsonb_object_agg(
              cs.currency,
              jsonb_build_object(
                'bonus_count', cs.bonus_count,
                'bonus_total', cs.bonus_total,
                'deduction_count', cs.deduction_count,
                'deduction_total', cs.deduction_total,
                'deduction_total_signed', cs.deduction_total_signed,
                'net_amount', cs.net_amount,
                'incomplete', cs.incomplete
              )
              order by cs.currency
            )
            from currency_stats cs
          ),
          '{}'::jsonb
        ),
        'money_totals_scope', 'all_employee_history_rows'
      )
      from history h
    ),
    'rows', coalesce(
      (
        select jsonb_agg(
          to_jsonb(p)
          order by p.event_date desc nulls last, p.id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end;
$$;

create or replace function attendance_private.admin_attendance_monthly(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month text := btrim(coalesce(p_filters->>'month', ''));
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_month_start date;
  v_month_end date;
  v_days_in_month integer;
  v_max_rows constant integer := 2500;
  v_result jsonb;
  v_total integer;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid_month';
  end if;

  v_month_start := (v_month || '-01')::date;
  v_month_end := (v_month_start + interval '1 month')::date;
  v_days_in_month := extract(day from (v_month_end - 1))::integer;

  with month_events as materialized (
    select
      x.*,
      case
        when x.employee_id is not null then 'employee:' || x.employee_id::text
        when x.historical_employee_no is not null
          then 'history:' || upper(btrim(x.historical_employee_no))
        when x.effective_match_status = 'resignation_unlinked' then
          'resignation:' || coalesce(
            nullif(upper(btrim(x.employee_no_raw)), ''),
            nullif(
              coalesce(nullif(x.source_key, ''), 'unknown') || ':'
                || public.exam_norm(x.employee_name_raw),
              'unknown:'
            ),
            'record:' || x.id::text
          )
        when nullif(btrim(x.employee_no_raw), '') is not null then
          'review:employee_no:' || upper(btrim(x.employee_no_raw))
        when nullif(public.exam_norm(x.employee_name_raw), '') is not null then
          'review:name:' || coalesce(nullif(x.source_group, ''), 'unknown')
            || ':' || public.exam_norm(x.employee_name_raw)
        else 'review:record:' || x.id::text
      end identity_key
    from attendance_private.attendance_enriched_records x
    where x.kind in ('attendance', 'resignation')
      and not x.is_mirror
      and x.event_date >= v_month_start
      and x.event_date < v_month_end
  ), usable_events as materialized (
    -- Every source event has an identity. Review identities are intentionally
    -- separate from employee/history identities and never imply a match.
    select e.*
    from month_events e
  ), current_people as materialized (
    select
      'employee:' || e.id::text identity_key,
      e.id employee_id,
      e.employee_no,
      e.employee_no employee_no_sort,
      e.full_name,
      e.hire_date,
      e.status,
      e.employment_type,
      coalesce(nullif(btrim(e.country), ''), nullif(btrim(e.nationality), ''))
        country,
      e.platform_scope platform,
      pos.name position_name,
      t.name team_name,
      nullif(concat_ws(
        ' / ',
        nullif(btrim(e.person_in_charge), ''),
        nullif(btrim(e.leader_name), ''),
        nullif(btrim(e.online_leader), ''),
        nullif(btrim(e.online_trainer), ''),
        nullif(btrim(e.on_site_trainer), ''),
        nullif(btrim(e.trainer_name), '')
      ), '') manager,
      'current' identity_kind,
      'matched' effective_match_status
    from public.employees e
    left join public.teams t on t.id = e.team_id
    left join public.positions pos on pos.id = e.position_id
    -- Suspended employees remain part of the current roster and must stay
    -- visible in a monthly attendance grid. Resigned employees are included
    -- only when they have an event in the requested month.
    where e.status in ('active', 'probation', 'suspended')
  ), event_people as materialized (
    select distinct on (e.identity_key)
      e.identity_key,
      e.employee_id,
      e.employee_no,
      e.employee_no employee_no_sort,
      e.full_name,
      e.hire_date,
      e.employee_status status,
      e.employment_type,
      e.country,
      e.platform,
      e.position_name,
      e.team_name,
      e.manager,
      case
        when e.employee_id is not null then 'current'
        when e.historical_employee_no is not null then 'historical'
        when e.effective_match_status = 'resignation_unlinked'
          then 'resignation_unlinked'
        else 'review'
      end identity_kind,
      e.effective_match_status
    from usable_events e
    order by
      e.identity_key,
      (e.kind = 'resignation' or e.event_kind = 'resignation') desc,
      e.event_date desc nulls last,
      e.id desc
  ), people as materialized (
    select * from current_people
    union all
    select ep.*
    from event_people ep
    where not exists (
      select 1 from current_people cp where cp.identity_key = ep.identity_key
    )
  ), day_event_lists as materialized (
    select
      e.identity_key,
      extract(day from e.event_date)::integer day_no,
      jsonb_agg(
        jsonb_build_object(
          'event_kind', e.event_kind,
          'kind', e.kind,
          'reason', e.reason,
          'note', e.note,
          'status', e.employee_status,
          'effective_match_status', e.effective_match_status
        )
        order by e.kind, e.event_kind, e.id
      ) events
    from usable_events e
    group by e.identity_key, extract(day from e.event_date)::integer
  ), person_days as materialized (
    select
      d.identity_key,
      jsonb_object_agg(d.day_no::text, d.events order by d.day_no) days
    from day_event_lists d
    group by d.identity_key
  ), filtered_people as materialized (
    select p.*, coalesce(d.days, '{}'::jsonb) days
    from people p
    left join person_days d on d.identity_key = p.identity_key
    where (v_team = '' or public.exam_norm(p.team_name) = public.exam_norm(v_team))
      and (
        v_search = ''
        or lower(concat_ws(
          ' ',
          p.employee_no,
          p.full_name,
          p.hire_date,
          p.status,
          p.employment_type,
          p.country,
          p.platform,
          p.position_name,
          p.team_name,
          p.manager
        )) like '%' || v_search || '%'
      )
  ), bounded as materialized (
    select p.*
    from filtered_people p
    order by
      p.hire_date asc nulls last,
      p.employee_no_sort,
      p.full_name,
      p.identity_key
    limit (v_max_rows + 1)
  )
  select
    count(*)::integer,
    jsonb_build_object(
      'month', v_month,
      'month_start', v_month_start,
      'month_end_exclusive', v_month_end,
      'days_in_month', v_days_in_month,
      'max_rows', v_max_rows,
      'total', count(*),
      'rows', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'row_key', b.identity_key,
            'employee_id', b.employee_id,
            'employee_no', b.employee_no,
            'no', b.employee_no,
            'full_name', b.full_name,
            'name', b.full_name,
            'hire_date', b.hire_date,
            'status', b.status,
            'employment_type', b.employment_type,
            'employee_type', b.employment_type,
            'country', b.country,
            'platform', b.platform,
            'position_name', b.position_name,
            'position', b.position_name,
            'team_name', b.team_name,
            'team', b.team_name,
            'manager', b.manager,
            'identity_kind', b.identity_kind,
            'effective_match_status', b.effective_match_status,
            'days', b.days
          )
          order by
            b.hire_date asc nulls last,
            b.employee_no_sort,
            b.full_name,
            b.identity_key
        ),
        '[]'::jsonb
      ),
      'options', jsonb_build_object(
        'teams', (
          select coalesce(jsonb_agg(o.team_name order by o.team_name), '[]'::jsonb)
          from (
            select distinct p.team_name
            from people p
            where nullif(btrim(p.team_name), '') is not null
          ) o
        )
      )
    )
  into v_total, v_result
  from bounded b;

  if v_total > v_max_rows then
    raise exception 'attendance_monthly_too_many_rows';
  end if;

  return v_result;
end;
$$;

revoke all on function attendance_private.admin_attendance_monthly(jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.admin_attendance_monthly(jsonb)
  to authenticated;

create or replace function public.admin_attendance_monthly(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select attendance_private.admin_attendance_monthly(p_filters);
$$;

revoke all on function public.admin_attendance_monthly(jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_attendance_monthly(jsonb)
  to authenticated;

notify pgrst, 'reload schema';
