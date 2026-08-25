-- Atomically reconcile the canonical employee master from two complete,
-- allowlisted Google snapshots. The current staff list owns identity and
-- explicit employment status. The schedule supplements marked onsite staff
-- and owns live assignment fields. Nothing in this migration deletes an
-- employee or Auth user.

create or replace function public.employee_master_normalize_id(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.upper(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        normalize(coalesce(p_value, ''), NFKC),
        U&'\200B\200C\200D\2060\FEFF',
        ''
      ),
      '[[:space:]]+',
      '',
      'g'
    )
  );
$$;

create or replace function public.employee_master_normalize_shift(p_value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_raw text := pg_catalog.btrim(normalize(coalesce(p_value, ''), NFKC));
  v_compact text;
  v_time text;
begin
  v_raw := pg_catalog.regexp_replace(v_raw, '[[:space:]]+', ' ', 'g');
  if v_raw = '' then return ''; end if;
  v_compact := pg_catalog.upper(pg_catalog.regexp_replace(v_raw, '[[:space:]_/-]+', '', 'g'));
  if v_compact in ('DAYSHIFT','DAYSHIFTT','早班DAY','白班DAY','早班','白班') then
    return '白班 Day';
  end if;
  if v_compact in ('NIGHTSHIFT','NIGHSHIFT','NIGHTSHIFTT','晚班NIGHT','夜班NIGHT','晚班','夜班') then
    return '夜班 Night';
  end if;
  if v_compact in ('MIDSHIFT','MIDSHFFT','中班MID','中班') then
    return '中班 Mid';
  end if;
  if v_compact ~ '(中班MID|MID)(11:?00|11:?30|12:?00|12:?30|13:?00)$' then
    v_time := substring(v_compact from '(11:?00|11:?30|12:?00|12:?30|13:?00)$');
    v_time := pg_catalog.replace(v_time, ':', '');
    return '中班 MID ' || substring(v_time from 1 for 2) || ':' || substring(v_time from 3 for 2);
  end if;
  return v_raw;
end;
$$;

create or replace function public.employee_master_has_explicit_resignation_marker(p_value text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_marker text := pg_catalog.lower(pg_catalog.btrim(normalize(coalesce(p_value, ''), NFKC)));
  v_compact text;
begin
  if v_marker = '' then return false; end if;
  v_compact := pg_catalog.regexp_replace(v_marker, '[[:space:]_‐‑‒–—―-]+', '', 'g');
  if v_compact ~ '(未|非)(辞职|辭職|离职|離職)'
    or v_compact ~ '(not|non)(resigned|terminated)' then
    return false;
  end if;
  return exists (
    select 1
    from pg_catalog.regexp_split_to_table(
      v_marker,
      '[[:space:],，;；|/\\:：()（）\[\]【】{}]+'
    ) as split(token)
    where split.token ~ '^(已)?(辞职|辭職|离职|離職)$'
      or split.token ~ '^(resigned|terminated)$'
  );
end;
$$;

revoke all on function public.employee_master_normalize_id(text)
  from public, anon, authenticated;
revoke all on function public.employee_master_normalize_shift(text)
  from public, anon, authenticated;
revoke all on function public.employee_master_has_explicit_resignation_marker(text)
  from public, anon, authenticated;

create table if not exists public.employee_master_sync_runs (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  trigger_kind text not null check (trigger_kind in ('change', 'manual')),
  parser_version text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  home_snapshot_hash text not null check (home_snapshot_hash ~ '^[0-9a-f]{64}$'),
  schedule_snapshot_hash text not null check (schedule_snapshot_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  status text not null default 'started'
    check (status in ('started', 'success', 'unchanged', 'failed')),
  home_read_row_count integer not null check (home_read_row_count between 2 and 5000),
  home_roster_row_count integer not null check (home_roster_row_count > 0),
  schedule_read_row_count integer not null check (schedule_read_row_count between 2 and 3500),
  schedule_roster_row_count integer not null check (schedule_roster_row_count > 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  rekeyed_count integer not null default 0 check (rekeyed_count >= 0),
  pending_departure_count integer not null default 0 check (pending_departure_count >= 0),
  archived_count integer not null default 0 check (archived_count >= 0),
  restored_count integer not null default 0 check (restored_count >= 0),
  historical_skipped_count integer not null default 0 check (historical_skipped_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  error_code text,
  error_detail text
);

create index if not exists employee_master_sync_runs_started_idx
  on public.employee_master_sync_runs (started_at desc);
create index if not exists employee_master_sync_runs_status_idx
  on public.employee_master_sync_runs (status, started_at desc);

create table if not exists public.employee_master_source_snapshots (
  source_key text primary key,
  spreadsheet_id text not null,
  sheet_gid text not null,
  tab_name text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz not null,
  row_count integer not null check (row_count > 0),
  payload jsonb not null check (jsonb_typeof(payload) = 'array'),
  run_id bigint not null references public.employee_master_sync_runs(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.employee_master_sync_issues (
  id bigint generated always as identity primary key,
  run_id bigint not null references public.employee_master_sync_runs(id) on delete cascade,
  issue_code text not null,
  employee_no text,
  home_source_row integer,
  schedule_source_row integer,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists employee_master_sync_issues_run_idx
  on public.employee_master_sync_issues (run_id, issue_code, id);

create table if not exists public.employee_identity_rekeys (
  id bigint generated always as identity primary key,
  employee_id uuid not null references public.employees(id) on delete restrict,
  previous_employee_no text not null,
  official_employee_no text not null,
  source_kind text not null check (source_kind in ('home_roster', 'schedule_roster')),
  source_row integer not null,
  run_id bigint not null references public.employee_master_sync_runs(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (official_employee_no)
);

create index if not exists employee_identity_rekeys_employee_idx
  on public.employee_identity_rekeys (employee_id, created_at desc);

create table if not exists public.employee_master_presence_state (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  missing_streak integer not null default 0 check (missing_streak >= 0),
  first_missing_at timestamptz,
  last_missing_at timestamptz,
  last_present_at timestamptz,
  prior_status text check (prior_status is null or prior_status in ('active', 'probation', 'suspended', 'resigned')),
  prior_resign_date date,
  auto_archived boolean not null default false,
  auto_archived_at timestamptz,
  eligible_for_disable boolean not null default false,
  account_review_required boolean not null default false,
  last_home_present boolean not null default false,
  last_schedule_present boolean not null default false,
  last_run_id bigint not null references public.employee_master_sync_runs(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp()
);

create index if not exists employee_master_presence_missing_idx
  on public.employee_master_presence_state (missing_streak desc, updated_at desc)
  where missing_streak > 0;
create index if not exists employee_master_presence_account_review_idx
  on public.employee_master_presence_state (account_review_required, updated_at desc)
  where account_review_required;

alter table public.employee_master_sync_runs enable row level security;
alter table public.employee_master_source_snapshots enable row level security;
alter table public.employee_master_sync_issues enable row level security;
alter table public.employee_identity_rekeys enable row level security;
alter table public.employee_master_presence_state enable row level security;

revoke all on table public.employee_master_sync_runs from public, anon, authenticated;
revoke all on table public.employee_master_source_snapshots from public, anon, authenticated;
revoke all on table public.employee_master_sync_issues from public, anon, authenticated;
revoke all on table public.employee_identity_rekeys from public, anon, authenticated;
revoke all on table public.employee_master_presence_state from public, anon, authenticated;

grant select, insert, update on table public.employee_master_sync_runs to service_role;
grant select, insert, update on table public.employee_master_source_snapshots to service_role;
grant select, insert on table public.employee_master_sync_issues to service_role;
grant select, insert on table public.employee_identity_rekeys to service_role;
grant select, insert, update on table public.employee_master_presence_state to service_role;

comment on table public.employee_master_presence_state is
  'Dual-source absence evidence for manual review only. Missing rows never change employment or portal-access state.';
comment on column public.employee_master_presence_state.eligible_for_disable is
  'Compatibility field retained as false; absence never authorizes automatic account disablement.';
comment on column public.employee_master_presence_state.account_review_required is
  'Marks an existing staff portal mapping for explicit administrator review; the mapping is not changed automatically.';

create or replace function public.ingest_employee_master_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_request_text text;
  v_trigger_kind text;
  v_parser_version text;
  v_snapshot_hash text;
  v_home_hash text;
  v_schedule_hash text;
  v_captured_at timestamptz;
  v_warning_count integer := 0;
  v_home_read_count integer := 0;
  v_home_roster_count integer := 0;
  v_schedule_read_count integer := 0;
  v_schedule_roster_count integer := 0;
  v_home_rows jsonb;
  v_schedule_rows jsonb;
  v_run_id bigint;
  v_existing_run public.employee_master_sync_runs%rowtype;
  v_latest_captured_at timestamptz;
  v_previous_snapshot_hash text := '';
  v_previous_home_count integer := 0;
  v_previous_schedule_count integer := 0;
  v_previous_run_id bigint;
  v_previous_schedule_run_id bigint;
  v_same_hash boolean := false;
  v_current_active integer := 0;
  v_active_union integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_step integer := 0;
  v_rekeyed integer := 0;
  v_pending_departure integer := 0;
  v_archived integer := 0;
  v_restored integer := 0;
  v_historical_skipped integer := 0;
  v_issue_count integer := 0;
  v_directory_rows jsonb := '[]'::jsonb;
  v_directory_result jsonb := '{}'::jsonb;
  v_error_state text;
  v_error_message text;
  v_final_status text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;
  if pg_catalog.octet_length(p_payload::text) > 10485760 then
    raise exception using errcode = '22023', message = 'payload_too_large';
  end if;

  v_request_text := pg_catalog.btrim(coalesce(p_payload->>'request_id', ''));
  if v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception using errcode = '22023', message = 'invalid_request_id';
  end if;
  v_request_id := v_request_text::uuid;
  v_trigger_kind := pg_catalog.btrim(coalesce(p_payload->>'trigger_kind', ''));
  v_parser_version := pg_catalog.btrim(coalesce(p_payload->>'parser_version', ''));
  v_snapshot_hash := pg_catalog.lower(pg_catalog.btrim(coalesce(p_payload->>'snapshot_hash', '')));
  if v_trigger_kind not in ('change', 'manual') then
    raise exception using errcode = '22023', message = 'invalid_trigger_kind';
  end if;
  if v_parser_version <> 'employee-master-dual-source-v1' then
    raise exception using errcode = '22023', message = 'invalid_parser_version';
  end if;
  if v_snapshot_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_snapshot_hash';
  end if;

  if not (
    p_payload#>>'{sources,home_roster,source_key}' = 'home_employee_roster_current'
    and p_payload#>>'{sources,home_roster,spreadsheet_id}' = '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8'
    and p_payload#>>'{sources,home_roster,sheet_gid}' = '970844334'
    and p_payload#>>'{sources,home_roster,tab_name}' = '在职名单 Current Staff List'
    and p_payload#>>'{sources,schedule_roster,source_key}' = 'home_schedule_roster_current'
    and p_payload#>>'{sources,schedule_roster,spreadsheet_id}' = '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA'
    and p_payload#>>'{sources,schedule_roster,sheet_gid}' = '1457335551'
    and p_payload#>>'{sources,schedule_roster,tab_name}' = '填表'
  ) then
    raise exception using errcode = '22023', message = 'source_not_allowlisted';
  end if;

  begin
    v_captured_at := (p_payload->>'captured_at')::timestamptz;
    v_warning_count := coalesce((p_payload->>'parse_warning_count')::integer, 0);
    v_home_hash := pg_catalog.lower(p_payload#>>'{sources,home_roster,snapshot_hash}');
    v_schedule_hash := pg_catalog.lower(p_payload#>>'{sources,schedule_roster,snapshot_hash}');
    v_home_read_count := (p_payload#>>'{sources,home_roster,read_row_count}')::integer;
    v_home_roster_count := (p_payload#>>'{sources,home_roster,roster_row_count}')::integer;
    v_schedule_read_count := (p_payload#>>'{sources,schedule_roster,read_row_count}')::integer;
    v_schedule_roster_count := (p_payload#>>'{sources,schedule_roster,roster_row_count}')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid_snapshot_metadata';
  end;
  if v_captured_at is null
    or v_warning_count < 0
    or v_home_hash !~ '^[0-9a-f]{64}$'
    or v_schedule_hash !~ '^[0-9a-f]{64}$'
    or v_home_read_count not between 2 and 5000
    or v_schedule_read_count not between 2 and 3500
    or v_home_roster_count < 1
    or v_schedule_roster_count < 1 then
    raise exception using errcode = '22023', message = 'invalid_snapshot_metadata';
  end if;

  v_home_rows := p_payload->'home_rows';
  v_schedule_rows := p_payload->'schedule_rows';
  if jsonb_typeof(v_home_rows) <> 'array'
    or jsonb_typeof(v_schedule_rows) <> 'array'
    or jsonb_array_length(v_home_rows) <> v_home_roster_count
    or jsonb_array_length(v_schedule_rows) <> v_schedule_roster_count then
    raise exception using errcode = '22023', message = 'snapshot_row_count_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-master-dual-source-sync', 20260825)
  );

  select run.* into v_existing_run
  from public.employee_master_sync_runs run
  where run.request_id = v_request_id;
  if found then
    if v_existing_run.snapshot_hash <> v_snapshot_hash then
      raise exception using errcode = '22023', message = 'request_id_reuse_mismatch';
    end if;
    return jsonb_build_object(
      'ok', v_existing_run.status <> 'failed',
      'status', v_existing_run.status,
      'run_id', v_existing_run.id,
      'request_id', v_existing_run.request_id,
      'inserted', v_existing_run.inserted_count,
      'updated', v_existing_run.updated_count,
      'rekeyed', v_existing_run.rekeyed_count,
      'pending_departure', v_existing_run.pending_departure_count,
      'archived', v_existing_run.archived_count,
      'restored', v_existing_run.restored_count
    );
  end if;

  select snapshot.row_count, snapshot.run_id
  into v_previous_home_count, v_previous_run_id
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_employee_roster_current';
  select snapshot.row_count, snapshot.run_id
  into v_previous_schedule_count, v_previous_schedule_run_id
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_schedule_roster_current';
  select run.snapshot_hash into v_previous_snapshot_hash
  from public.employee_master_sync_runs run
  where run.id = v_previous_run_id and run.status = 'success';
  v_same_hash := v_previous_run_id is not null
    and v_previous_schedule_run_id = v_previous_run_id
    and coalesce(v_previous_snapshot_hash, '') = v_snapshot_hash;

  -- A forced/periodic delivery of an already accepted dual-source snapshot is
  -- a true zero-write path: no run, timestamps, snapshots, issues or employees
  -- are touched.
  if v_same_hash then
    return jsonb_build_object(
      'ok', true,
      'status', 'unchanged',
      'run_id', v_previous_run_id,
      'request_id', v_request_id,
      'home_rows', v_home_roster_count,
      'schedule_rows', v_schedule_roster_count,
      'inserted', 0,
      'updated', 0,
      'rekeyed', 0,
      'pending_departure', 0,
      'archived', 0,
      'restored', 0,
      'warnings', 0
    );
  end if;

  insert into public.employee_master_sync_runs (
    request_id, trigger_kind, parser_version, snapshot_hash,
    home_snapshot_hash, schedule_snapshot_hash, captured_at,
    home_read_row_count, home_roster_row_count,
    schedule_read_row_count, schedule_roster_row_count, warning_count
  ) values (
    v_request_id, v_trigger_kind, v_parser_version, v_snapshot_hash,
    v_home_hash, v_schedule_hash, v_captured_at,
    v_home_read_count, v_home_roster_count,
    v_schedule_read_count, v_schedule_roster_count, v_warning_count
  ) returning id into v_run_id;

  select pg_catalog.max(run.captured_at) into v_latest_captured_at
  from public.employee_master_sync_runs run
  where run.id <> v_run_id and run.status in ('success', 'unchanged');
  if v_latest_captured_at is not null and v_captured_at < v_latest_captured_at then
    update public.employee_master_sync_runs
    set status = 'failed', finished_at = clock_timestamp(),
      error_code = 'stale_snapshot',
      error_detail = 'Older captured_at cannot replace the current employee master snapshot.'
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false, 'status', 'failed', 'run_id', v_run_id,
      'request_id', v_request_id, 'error_code', 'stale_snapshot'
    );
  end if;

  -- Compare each source independently with its last successful snapshot. A
  -- large one-source drop is treated as an incomplete read, even when the
  -- union still looks large enough to pass a combined-count guard.
  if v_previous_home_count > 0
    and v_home_roster_count * 100 < v_previous_home_count * 80 then
    update public.employee_master_sync_runs
    set status = 'failed', finished_at = clock_timestamp(),
      error_code = 'home_snapshot_incomplete_vs_previous',
      error_detail = 'Home roster count dropped below 80% of its last successful snapshot.'
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false, 'status', 'failed', 'run_id', v_run_id,
      'request_id', v_request_id,
      'error_code', 'home_snapshot_incomplete_vs_previous'
    );
  end if;
  if v_previous_schedule_count > 0
    and v_schedule_roster_count * 100 < v_previous_schedule_count * 80 then
    update public.employee_master_sync_runs
    set status = 'failed', finished_at = clock_timestamp(),
      error_code = 'schedule_snapshot_incomplete_vs_previous',
      error_detail = 'Schedule roster count dropped below 80% of its last successful snapshot.'
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false, 'status', 'failed', 'run_id', v_run_id,
      'request_id', v_request_id,
      'error_code', 'schedule_snapshot_incomplete_vs_previous'
    );
  end if;

  begin
    -- A caller may invoke the RPC more than once in one transaction (for
    -- example integration tests or a batched service job). ON COMMIT DROP
    -- alone does not clear tables between those calls, so reset the complete
    -- private staging set before rebuilding it.
    drop table if exists
      pg_temp.employee_master_home_stage,
      pg_temp.employee_master_schedule_stage,
      pg_temp.employee_master_official_candidates,
      pg_temp.employee_master_name_only_rekey_review,
      pg_temp.employee_master_presence_stage,
      pg_temp.employee_master_schedule_valid,
      pg_temp.employee_master_team_map,
      pg_temp.employee_master_position_map;

    create temporary table employee_master_home_stage (
      source_row integer not null,
      employee_no text,
      full_name text not null,
      name_key text not null,
      team_name text,
      platform_name text,
      position_name text,
      shift_name text,
      country_name text,
      hire_date date,
      resign_date date,
      work_tg text,
      backend_accounts text,
      resign_reason text,
      explicitly_resigned boolean not null,
      resignation_signal text not null
    ) on commit drop;

    create temporary table employee_master_schedule_stage (
      source_row integer not null,
      employee_no text,
      full_name text not null,
      name_key text not null,
      responsible text,
      onsite_trainer text,
      online_leader text,
      online_trainer text,
      group_name text,
      team_name text,
      shift_name text,
      country_name text,
      position_name text,
      platform_name text,
      work_content text,
      onsite_marker boolean not null
    ) on commit drop;

    insert into pg_temp.employee_master_home_stage (
      source_row, employee_no, full_name, name_key, team_name, platform_name,
      position_name, shift_name, country_name, hire_date, resign_date,
      work_tg, backend_accounts, resign_reason, explicitly_resigned,
      resignation_signal
    )
    select
      (item->>'source_row')::integer,
      nullif(public.employee_master_normalize_id(item->>'employee_id'), ''),
      btrim(item->>'name'),
      btrim(item->>'name_key'),
      nullif(btrim(item->>'team'), ''),
      nullif(btrim(item->>'platform'), ''),
      nullif(btrim(item->>'position'), ''),
      nullif(public.employee_master_normalize_shift(item->>'shift'), ''),
      nullif(btrim(item->>'country'), ''),
      nullif(item->>'hire_date', '')::date,
      nullif(item->>'resign_date', '')::date,
      nullif(btrim(item->>'work_tg'), ''),
      nullif(btrim(item->>'backend_accounts'), ''),
      nullif(btrim(item->>'resign_reason'), ''),
      nullif(item->>'resign_date', '')::date is not null
        or public.employee_master_has_explicit_resignation_marker(item->>'backend_accounts'),
      case
        when nullif(item->>'resign_date', '')::date is not null then 'date'
        when public.employee_master_has_explicit_resignation_marker(item->>'backend_accounts')
          then 'account_marker'
        else 'none'
      end
    from jsonb_array_elements(v_home_rows) item;

    insert into pg_temp.employee_master_schedule_stage (
      source_row, employee_no, full_name, name_key, responsible,
      onsite_trainer, online_leader, online_trainer, group_name, team_name,
      shift_name, country_name, position_name, platform_name, work_content,
      onsite_marker
    )
    select
      (item->>'source_row')::integer,
      nullif(public.employee_master_normalize_id(item->>'employee_id'), ''),
      btrim(item->>'name'),
      btrim(item->>'name_key'),
      nullif(btrim(item->>'responsible'), ''),
      nullif(btrim(item->>'onsite_trainer'), ''),
      nullif(btrim(item->>'online_leader'), ''),
      nullif(btrim(item->>'online_trainer'), ''),
      nullif(btrim(item->>'group'), ''),
      nullif(btrim(item->>'team'), ''),
      nullif(public.employee_master_normalize_shift(item->>'shift'), ''),
      nullif(btrim(item->>'country'), ''),
      nullif(btrim(item->>'position'), ''),
      nullif(btrim(item->>'platform'), ''),
      nullif(btrim(item->>'work_content'), ''),
      (item->>'onsite_marker')::boolean
    from jsonb_array_elements(v_schedule_rows) item;

    if exists (
      select 1 from pg_temp.employee_master_home_stage
      where source_row not between 3 and 5000
        or nullif(full_name, '') is null
        or nullif(name_key, '') is null
        or resignation_signal not in ('date', 'account_marker', 'none')
    ) then
      raise exception using errcode = '22023', message = 'invalid_home_roster_row';
    end if;
    if exists (
      select 1 from pg_temp.employee_master_schedule_stage
      where source_row not between 2 and 3500
        or nullif(full_name, '') is null
        or nullif(name_key, '') is null
    ) then
      raise exception using errcode = '22023', message = 'invalid_schedule_roster_row';
    end if;
    if exists (
      select 1 from pg_temp.employee_master_home_stage
      where employee_no is not null group by employee_no having count(*) > 1
    ) then
      raise exception using errcode = '21000', message = 'home_duplicate_employee_id';
    end if;
    if exists (
      select 1 from pg_temp.employee_master_schedule_stage
      where employee_no is not null group by employee_no having count(*) > 1
    ) then
      raise exception using errcode = '21000', message = 'schedule_duplicate_employee_id';
    end if;
    if exists (
      select 1
      from pg_temp.employee_master_home_stage home
      join pg_temp.employee_master_schedule_stage schedule
        on schedule.employee_no = home.employee_no
      where home.employee_no is not null
        and home.name_key <> schedule.name_key
    ) then
      raise exception using errcode = '22023', message = 'cross_source_name_mismatch';
    end if;
    if exists (
      select 1
      from (
        select source.employee_no
        from (
          select employee_no from pg_temp.employee_master_home_stage where employee_no is not null
          union
          select employee_no from pg_temp.employee_master_schedule_stage where employee_no is not null
        ) source
        join public.employees employee
          on public.employee_master_normalize_id(employee.employee_no) = source.employee_no
        group by source.employee_no
        having count(*) > 1
      ) duplicate
    ) then
      raise exception using errcode = '21000', message = 'canonical_employee_id_case_conflict';
    end if;

    select count(*)::integer into v_current_active
    from public.employees employee
    where employee.status in ('active', 'probation', 'suspended')
      and public.employee_master_normalize_id(employee.employee_no) not in ('SYSTEM', 'ADMIN');

    select count(*)::integer into v_active_union
    from (
      select home.employee_no
      from pg_temp.employee_master_home_stage home
      where home.employee_no is not null and not home.explicitly_resigned
      union
      select schedule.employee_no
      from pg_temp.employee_master_schedule_stage schedule
      where schedule.employee_no is not null and schedule.onsite_marker
    ) active_source;

    -- The global ratio is a secondary regression guard only after both sources
    -- have an accepted baseline. It must not reject the first installation.
    if v_previous_home_count > 0
      and v_previous_schedule_count > 0
      and v_current_active >= 100
      and v_active_union < floor(v_current_active * 0.80)::integer then
      raise exception using errcode = '22023', message = 'employee_master_mass_absence_guard';
    end if;

    create temporary table employee_master_official_candidates on commit drop as
    select distinct on (candidate.employee_no)
      candidate.employee_no,
      candidate.full_name,
      candidate.name_key,
      candidate.source_kind,
      candidate.source_row
    from (
      select home.employee_no, home.full_name, home.name_key,
        'home_roster'::text source_kind, home.source_row, 0 priority
      from pg_temp.employee_master_home_stage home
      where home.employee_no is not null and not home.explicitly_resigned
      union all
      select schedule.employee_no, schedule.full_name, schedule.name_key,
        'schedule_roster'::text source_kind, schedule.source_row, 1 priority
      from pg_temp.employee_master_schedule_stage schedule
      where schedule.employee_no is not null and schedule.onsite_marker
    ) candidate
    order by candidate.employee_no, candidate.priority, candidate.source_row;

    -- A normalized-name match is advisory evidence only. It must never rewrite
    -- a temporary employee number or silently merge two identities.
    create temporary table employee_master_name_only_rekey_review on commit drop as
    select
      candidate.employee_no official_employee_no,
      candidate.source_kind,
      candidate.source_row,
      employee.id employee_id,
      employee.employee_no previous_employee_no
    from pg_temp.employee_master_official_candidates candidate
    join public.employees employee
      on lower(regexp_replace(btrim(employee.full_name), '[[:space:][:punct:]]+', '', 'g')) = candidate.name_key
     and (employee.official_id_pending = true
       or employee.source_type = 'schedule_temp'
       or public.employee_master_normalize_id(employee.employee_no) like 'TMP-SCHED-%')
    where not exists (
      select 1 from public.employees official
      where public.employee_master_normalize_id(official.employee_no) = candidate.employee_no
    );

    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, details
    )
    select v_run_id, 'temporary_official_id_name_only_manual_review',
      review.official_employee_no,
      jsonb_build_object(
        'temporary_employee_id', review.employee_id,
        'temporary_employee_no', review.previous_employee_no,
        'source_kind', review.source_kind,
        'source_row', review.source_row,
        'evidence', 'normalized_name_only',
        'action', 'manual_review_no_rekey'
      )
    from pg_temp.employee_master_name_only_rekey_review review;
    v_rekeyed := 0;

    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, details
    )
    select distinct v_run_id, 'temporary_and_official_records_both_exist',
      candidate.employee_no,
      jsonb_build_object('temporary_employee_id', temporary.id,
        'official_employee_id', official.id)
    from pg_temp.employee_master_official_candidates candidate
    join public.employees official
      on public.employee_master_normalize_id(official.employee_no) = candidate.employee_no
    join public.employees temporary
      on lower(regexp_replace(btrim(temporary.full_name), '[[:space:][:punct:]]+', '', 'g')) = candidate.name_key
     and temporary.id <> official.id
     and (temporary.official_id_pending = true
       or temporary.source_type = 'schedule_temp'
       or public.employee_master_normalize_id(temporary.employee_no) like 'TMP-SCHED-%');

    create temporary table employee_master_presence_stage on commit drop as
    select
      source.employee_no,
      bool_or(source.home_present) home_present,
      bool_or(source.schedule_present) schedule_present,
      bool_or(source.home_explicitly_resigned) home_explicitly_resigned
    from (
      select home.employee_no, true home_present, false schedule_present,
        home.explicitly_resigned home_explicitly_resigned
      from pg_temp.employee_master_home_stage home
      where home.employee_no is not null
      union all
      select schedule.employee_no, false, true, false
      from pg_temp.employee_master_schedule_stage schedule
      where schedule.employee_no is not null and schedule.onsite_marker
    ) source
    group by source.employee_no;
    v_restored := 0;

    create temporary table employee_master_schedule_valid on commit drop as
    select schedule.*,
      (home.employee_no is not null) home_active
    from pg_temp.employee_master_schedule_stage schedule
    left join pg_temp.employee_master_home_stage home
      on home.employee_no = schedule.employee_no
     and not home.explicitly_resigned
    where schedule.employee_no is not null
      and (
        (home.employee_no is not null and home.name_key = schedule.name_key)
        or (home.employee_no is null and schedule.onsite_marker)
      )
      and not exists (
        select 1 from pg_temp.employee_master_home_stage resigned_home
        where resigned_home.employee_no = schedule.employee_no
          and resigned_home.explicitly_resigned
      );

    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, home_source_row,
      schedule_source_row, details
    )
    select v_run_id, 'cross_source_name_mismatch', schedule.employee_no,
      home.source_row, schedule.source_row,
      jsonb_build_object('home_name', home.full_name,
        'schedule_name', schedule.full_name)
    from pg_temp.employee_master_schedule_stage schedule
    join pg_temp.employee_master_home_stage home
      on home.employee_no = schedule.employee_no
     and not home.explicitly_resigned
    where schedule.employee_no is not null
      and schedule.name_key <> home.name_key;

    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, schedule_source_row, details
    )
    select v_run_id, 'schedule_only_missing_onsite_marker',
      schedule.employee_no, schedule.source_row,
      jsonb_build_object('action', 'ignored_for_presence_creation_and_updates')
    from pg_temp.employee_master_schedule_stage schedule
    where schedule.employee_no is not null
      and not schedule.onsite_marker
      and not exists (
        select 1 from pg_temp.employee_master_home_stage home
        where home.employee_no = schedule.employee_no
          and not home.explicitly_resigned
      );

    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, home_source_row,
      schedule_source_row, details
    )
    select v_run_id, 'home_resigned_but_still_scheduled',
      home.employee_no, home.source_row, schedule.source_row,
      jsonb_build_object('status_source', 'home_roster',
        'schedule_assignment_applied', false)
    from pg_temp.employee_master_home_stage home
    join pg_temp.employee_master_schedule_stage schedule
      on schedule.employee_no = home.employee_no
    where home.explicitly_resigned;

    insert into public.teams (name, status)
    select distinct source.team_name, 'active'
    from (
      select home.team_name
      from pg_temp.employee_master_home_stage home
      where not home.explicitly_resigned and home.team_name is not null
      union
      select schedule.team_name
      from pg_temp.employee_master_schedule_valid schedule
      where schedule.team_name is not null
    ) source
    where not exists (
      select 1 from public.teams team
      where lower(btrim(team.name)) = lower(btrim(source.team_name))
    );

    insert into public.positions (name, status)
    select distinct source.position_name, 'active'
    from (
      select home.position_name
      from pg_temp.employee_master_home_stage home
      where not home.explicitly_resigned and home.position_name is not null
      union
      select schedule.position_name
      from pg_temp.employee_master_schedule_valid schedule
      where schedule.position_name is not null
    ) source
    where not exists (
      select 1 from public.positions position
      where lower(btrim(position.name)) = lower(btrim(source.position_name))
    );

    create temporary table employee_master_team_map on commit drop as
    select lower(btrim(team.name)) name_key,
      (array_agg(team.id order by case when team.status = 'active' then 0 else 1 end, team.id))[1] id
    from public.teams team
    group by lower(btrim(team.name));

    create temporary table employee_master_position_map on commit drop as
    select lower(btrim(position.name)) name_key,
      (array_agg(position.id order by case when position.status = 'active' then 0 else 1 end, position.id))[1] id
    from public.positions position
    group by lower(btrim(position.name));

    insert into public.employees (
      employee_no, full_name, country, nationality, employment_type,
      team_id, position_id, hire_date, resign_date, work_tg,
      status, resign_reason, source_type, profile_status, shift_name,
      group_name, platform_scope, backend_accounts, source_sheet,
      source_row, official_id_pending, market_country, market_position,
      legacy_shift_name, schedule_position, updated_at
    )
    select
      home.employee_no, home.full_name, home.country_name, home.country_name,
      case
        when lower(coalesce(home.country_name, '')) ~ '(菲律宾|philippines|filipino)'
          then '纯居家菲律宾'
        else '纯居家（越南/缅甸/印尼等）'
      end,
      team.id, position.id, home.hire_date, null, home.work_tg,
      'active', null, 'google_sheet', 'sheet_synced', home.shift_name,
      null, home.platform_name, home.backend_accounts,
      '在职名单 Current Staff List', home.source_row, false,
      home.team_name, home.platform_name, home.shift_name,
      home.position_name, clock_timestamp()
    from pg_temp.employee_master_home_stage home
    left join pg_temp.employee_master_team_map team
      on team.name_key = lower(btrim(home.team_name))
    left join pg_temp.employee_master_position_map position
      on position.name_key = lower(btrim(home.position_name))
    where home.employee_no is not null
      and not home.explicitly_resigned
      and not exists (
        select 1 from public.employees employee
        where public.employee_master_normalize_id(employee.employee_no) = home.employee_no
      );
    get diagnostics v_step = row_count;
    v_inserted := v_inserted + v_step;

    with desired as (
      select home.*, team.id team_id, position.id position_id,
        case
          when lower(coalesce(home.country_name, '')) ~ '(菲律宾|philippines|filipino)'
            then '纯居家菲律宾'
          else '纯居家（越南/缅甸/印尼等）'
        end employment_type
      from pg_temp.employee_master_home_stage home
      left join pg_temp.employee_master_team_map team
        on team.name_key = lower(btrim(home.team_name))
      left join pg_temp.employee_master_position_map position
        on position.name_key = lower(btrim(home.position_name))
      where home.employee_no is not null and not home.explicitly_resigned
    )
    update public.employees employee
    set full_name = desired.full_name,
        country = desired.country_name,
        nationality = desired.country_name,
        employment_type = desired.employment_type,
        team_id = desired.team_id,
        position_id = desired.position_id,
        hire_date = desired.hire_date,
        resign_date = null,
        work_tg = desired.work_tg,
        status = 'active',
        resign_reason = null,
        source_type = 'google_sheet',
        profile_status = 'sheet_synced',
        shift_name = desired.shift_name,
        legacy_shift_name = desired.shift_name,
        platform_scope = desired.platform_name,
        backend_accounts = desired.backend_accounts,
        source_sheet = '在职名单 Current Staff List',
        source_row = desired.source_row,
        official_id_pending = false,
        market_country = desired.team_name,
        market_position = desired.platform_name,
        schedule_position = desired.position_name,
        updated_at = clock_timestamp()
    from desired
    where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
      and (
        employee.full_name, employee.country, employee.nationality,
        employee.employment_type, employee.team_id, employee.position_id,
        employee.hire_date, employee.resign_date, employee.work_tg,
        employee.status, employee.resign_reason, employee.source_type,
        employee.profile_status, employee.shift_name, employee.legacy_shift_name,
        employee.platform_scope, employee.backend_accounts,
        employee.source_sheet, employee.source_row, employee.official_id_pending,
        employee.market_country, employee.market_position,
        employee.schedule_position
      ) is distinct from (
        desired.full_name, desired.country_name, desired.country_name,
        desired.employment_type, desired.team_id, desired.position_id,
        desired.hire_date, null::date, desired.work_tg,
        'active'::text, null::text, 'google_sheet'::text,
        'sheet_synced'::text, desired.shift_name, desired.shift_name,
        desired.platform_name, desired.backend_accounts,
        '在职名单 Current Staff List'::text, desired.source_row, false,
        desired.team_name, desired.platform_name,
        desired.position_name
      );
    get diagnostics v_step = row_count;
    v_updated := v_updated + v_step;

    with desired as (
      select home.*,
        coalesce(home.resign_date, v_captured_at::date) effective_resign_date
      from pg_temp.employee_master_home_stage home
      where home.employee_no is not null and home.explicitly_resigned
    )
    update public.employees employee
    set full_name = desired.full_name,
        country = coalesce(desired.country_name, employee.country),
        nationality = coalesce(desired.country_name, employee.nationality),
        hire_date = coalesce(desired.hire_date, employee.hire_date),
        resign_date = desired.effective_resign_date,
        work_tg = coalesce(desired.work_tg, employee.work_tg),
        backend_accounts = coalesce(desired.backend_accounts, employee.backend_accounts),
        status = 'resigned',
        resign_reason = coalesce(desired.resign_reason, employee.resign_reason),
        source_sheet = '在职名单 Current Staff List',
        source_row = desired.source_row,
        profile_status = 'sheet_resigned',
        updated_at = clock_timestamp()
    from desired
    where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
      and (
        employee.full_name, employee.country, employee.nationality,
        employee.hire_date, employee.resign_date, employee.work_tg,
        employee.backend_accounts, employee.status, employee.resign_reason,
        employee.source_sheet, employee.source_row, employee.profile_status
      ) is distinct from (
        desired.full_name,
        coalesce(desired.country_name, employee.country),
        coalesce(desired.country_name, employee.nationality),
        coalesce(desired.hire_date, employee.hire_date),
        desired.effective_resign_date,
        coalesce(desired.work_tg, employee.work_tg),
        coalesce(desired.backend_accounts, employee.backend_accounts),
        'resigned'::text,
        coalesce(desired.resign_reason, employee.resign_reason),
        '在职名单 Current Staff List'::text,
        desired.source_row,
        'sheet_resigned'::text
      );
    get diagnostics v_step = row_count;
    v_updated := v_updated + v_step;

    insert into public.employee_lifecycle_events (
      employee_id, employee_no, full_name, event_type, effective_date,
      reason, note, source, source_sheet, source_row, source_key, snapshot
    )
    select employee.id, employee.employee_no, employee.full_name, 'resign',
      coalesce(home.resign_date, v_captured_at::date),
      home.resign_reason,
      case when home.resignation_signal = 'account_marker'
        then '居家名单后台账号栏明确标记辞职/离职。'
        else '居家名单包含明确离职日期。'
      end,
      'employee_master_sync', '在职名单 Current Staff List', home.source_row,
      'employee-master:home-resign:' || employee.id::text || ':' ||
        coalesce(home.resign_date::text, 'account-marker'),
      jsonb_build_object('run_id', v_run_id,
        'resignation_signal', home.resignation_signal,
        'source_row', home.source_row)
    from pg_temp.employee_master_home_stage home
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) = home.employee_no
    where home.explicitly_resigned
    on conflict (source_key) do update
    set reason = excluded.reason,
        note = excluded.note,
        snapshot = excluded.snapshot;

    select count(*)::integer into v_historical_skipped
    from pg_temp.employee_master_home_stage home
    where home.explicitly_resigned
      and home.employee_no is not null
      and not exists (
        select 1 from public.employees employee
        where public.employee_master_normalize_id(employee.employee_no) = home.employee_no
      );

    insert into public.employees (
      employee_no, full_name, country, nationality, employment_type,
      team_id, position_id, status, source_type, profile_status,
      shift_name, group_name, platform_scope, work_content, source_sheet,
      source_row, official_id_pending, market_country, schedule_position,
      person_in_charge, on_site_trainer, online_leader, online_trainer,
      updated_at
    )
    select
      schedule.employee_no, schedule.full_name, schedule.country_name,
      schedule.country_name, '现场人员', team.id, position.id, 'active',
      'schedule_only', 'needs_profile_completion', schedule.shift_name,
      schedule.group_name, schedule.platform_name, schedule.work_content,
      '居家排班表/填表', schedule.source_row, false,
      schedule.team_name, schedule.position_name, schedule.responsible,
      schedule.onsite_trainer, schedule.online_leader,
      schedule.online_trainer, clock_timestamp()
    from pg_temp.employee_master_schedule_valid schedule
    left join pg_temp.employee_master_team_map team
      on team.name_key = lower(btrim(schedule.team_name))
    left join pg_temp.employee_master_position_map position
      on position.name_key = lower(btrim(schedule.position_name))
    where not schedule.home_active
      and schedule.onsite_marker
      and not exists (
        select 1 from public.employees employee
        where public.employee_master_normalize_id(employee.employee_no) = schedule.employee_no
      );
    get diagnostics v_step = row_count;
    v_inserted := v_inserted + v_step;

    with desired as (
      select schedule.*, team.id team_id, position.id position_id
      from pg_temp.employee_master_schedule_valid schedule
      left join pg_temp.employee_master_team_map team
        on team.name_key = lower(btrim(schedule.team_name))
      left join pg_temp.employee_master_position_map position
        on position.name_key = lower(btrim(schedule.position_name))
    )
    update public.employees employee
    set full_name = case when desired.home_active then employee.full_name else desired.full_name end,
        country = desired.country_name,
        nationality = desired.country_name,
        employment_type = case when desired.home_active then employee.employment_type else '现场人员' end,
        team_id = desired.team_id,
        position_id = desired.position_id,
        source_type = case when desired.home_active then employee.source_type else 'schedule_only' end,
        profile_status = case when desired.home_active then employee.profile_status else 'needs_profile_completion' end,
        shift_name = desired.shift_name,
        group_name = desired.group_name,
        platform_scope = desired.platform_name,
        work_content = desired.work_content,
        source_sheet = case when desired.home_active then employee.source_sheet else '居家排班表/填表' end,
        source_row = case when desired.home_active then employee.source_row else desired.source_row end,
        official_id_pending = false,
        market_country = desired.team_name,
        schedule_position = desired.position_name,
        person_in_charge = desired.responsible,
        on_site_trainer = desired.onsite_trainer,
        online_leader = desired.online_leader,
        online_trainer = desired.online_trainer,
        updated_at = clock_timestamp()
    from desired
    where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
      and (
        employee.full_name, employee.country, employee.nationality,
        employee.employment_type, employee.team_id, employee.position_id,
        employee.source_type, employee.profile_status,
        employee.shift_name, employee.group_name, employee.platform_scope,
        employee.work_content, employee.source_sheet, employee.source_row,
        employee.official_id_pending, employee.market_country,
        employee.schedule_position, employee.person_in_charge,
        employee.on_site_trainer, employee.online_leader,
        employee.online_trainer
      ) is distinct from (
        case when desired.home_active then employee.full_name else desired.full_name end,
        desired.country_name, desired.country_name,
        case when desired.home_active then employee.employment_type else '现场人员' end,
        desired.team_id, desired.position_id,
        case when desired.home_active then employee.source_type else 'schedule_only' end,
        case when desired.home_active then employee.profile_status else 'needs_profile_completion' end,
        desired.shift_name, desired.group_name, desired.platform_name,
        desired.work_content,
        case when desired.home_active then employee.source_sheet else '居家排班表/填表' end,
        case when desired.home_active then employee.source_row else desired.source_row end,
        false, desired.team_name, desired.position_name,
        desired.responsible, desired.onsite_trainer, desired.online_leader,
        desired.online_trainer
      );
    get diagnostics v_step = row_count;
    v_updated := v_updated + v_step;

    insert into public.employee_master_presence_state as state (
      employee_id, missing_streak, last_present_at, last_home_present,
      last_schedule_present, auto_archived, eligible_for_disable,
      last_run_id, updated_at
    )
    select employee.id, 0, v_captured_at, presence.home_present,
      presence.schedule_present, false, false, v_run_id, clock_timestamp()
    from pg_temp.employee_master_presence_stage presence
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) = presence.employee_no
    on conflict (employee_id) do update
    set missing_streak = 0,
        first_missing_at = null,
        last_missing_at = null,
        last_present_at = excluded.last_present_at,
        auto_archived = false,
        auto_archived_at = null,
        eligible_for_disable = false,
        last_home_present = excluded.last_home_present,
        last_schedule_present = excluded.last_schedule_present,
        last_run_id = excluded.last_run_id,
        updated_at = clock_timestamp();

    insert into public.employee_master_presence_state as state (
      employee_id, missing_streak, first_missing_at, last_missing_at,
      prior_status, prior_resign_date, auto_archived,
      eligible_for_disable, account_review_required,
      last_home_present, last_schedule_present, last_run_id, updated_at
    )
    select employee.id, 1, v_captured_at, v_captured_at,
      employee.status, employee.resign_date, false, false,
      exists (
        select 1 from public.user_access access
        where access.employee_id = employee.id
          and access.employee_portal_enabled = true
      ),
      false, false, v_run_id, clock_timestamp()
    from public.employees employee
    where employee.status in ('active', 'probation', 'suspended')
      and public.employee_master_normalize_id(employee.employee_no) not in ('SYSTEM', 'ADMIN')
      and not exists (
        select 1 from pg_temp.employee_master_presence_stage presence
        where presence.employee_no = public.employee_master_normalize_id(employee.employee_no)
      )
    on conflict (employee_id) do update
    set missing_streak = case
          when state.last_run_id = excluded.last_run_id then state.missing_streak
          else state.missing_streak + 1
        end,
        first_missing_at = coalesce(state.first_missing_at, excluded.first_missing_at),
        last_missing_at = excluded.last_missing_at,
        prior_status = case
          when state.last_run_id = excluded.last_run_id then state.prior_status
          else excluded.prior_status
        end,
        prior_resign_date = case
          when state.last_run_id = excluded.last_run_id then state.prior_resign_date
          else excluded.prior_resign_date
        end,
        auto_archived = false,
        auto_archived_at = null,
        eligible_for_disable = false,
        account_review_required = state.account_review_required
          or excluded.account_review_required,
        last_home_present = false,
        last_schedule_present = false,
        last_run_id = excluded.last_run_id,
        updated_at = clock_timestamp();

    -- Absence is evidence, never an employment-status or access instruction.
    -- Emit one issue per accepted snapshot and leave employees, user_access and
    -- lifecycle history untouched.
    insert into public.employee_master_sync_issues (
      run_id, issue_code, employee_no, details
    )
    select v_run_id, 'pending_manual_review', employee.employee_no,
      jsonb_build_object(
        'employee_id', employee.id,
        'missing_streak', state.missing_streak,
        'first_missing_at', state.first_missing_at,
        'last_missing_at', state.last_missing_at,
        'reason', 'missing_from_both_complete_sources',
        'account_review_required', state.account_review_required,
        'action', 'manual_review_no_status_or_access_change'
      )
    from public.employee_master_presence_state state
    join public.employees employee on employee.id = state.employee_id
    where state.last_run_id = v_run_id
      and state.missing_streak >= 1;

    v_archived := 0;
    v_restored := 0;

    select count(*)::integer into v_pending_departure
    from public.employee_master_presence_state state
    where state.last_run_id = v_run_id and state.missing_streak >= 1;

    insert into public.employee_master_source_snapshots (
      source_key, spreadsheet_id, sheet_gid, tab_name, snapshot_hash,
      captured_at, row_count, payload, run_id, updated_at
    ) values
      ('home_employee_roster_current',
        '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8', '970844334',
        '在职名单 Current Staff List', v_home_hash, v_captured_at,
        v_home_roster_count, v_home_rows, v_run_id, clock_timestamp()),
      ('home_schedule_roster_current',
        '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA', '1457335551',
        '填表', v_schedule_hash, v_captured_at,
        v_schedule_roster_count, v_schedule_rows, v_run_id, clock_timestamp())
    on conflict (source_key) do update
    set spreadsheet_id = excluded.spreadsheet_id,
        sheet_gid = excluded.sheet_gid,
        tab_name = excluded.tab_name,
        snapshot_hash = excluded.snapshot_hash,
        captured_at = excluded.captured_at,
        row_count = excluded.row_count,
        payload = excluded.payload,
        run_id = excluded.run_id,
        updated_at = clock_timestamp();

    -- Only rows accepted by the status/identity reconciliation may lead the
    -- report snapshot and directory cache. A schedule-only row without the
    -- onsite marker is deliberately excluded from both consumers.
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_row', schedule.source_row,
          'employee_id', schedule.employee_no,
          'name', schedule.full_name,
          'team', schedule.team_name,
          'group', schedule.group_name,
          'position', schedule.position_name,
          'country', schedule.country_name,
          'shift', schedule.shift_name,
          'platform', schedule.platform_name,
          'work_content', schedule.work_content,
          'responsible', schedule.responsible,
          'onsite_trainer', schedule.onsite_trainer,
          'online_leader', schedule.online_leader,
          'online_trainer', schedule.online_trainer
        ) order by schedule.source_row
      ),
      '[]'::jsonb
    ) into v_directory_rows
    from pg_temp.employee_master_schedule_valid schedule;

    insert into public.report_sheet_snapshots (
      source, payload, row_count, synced_at, note
    ) values
      ('居家员工名单/在职名单 Current Staff List', v_home_rows,
        v_home_roster_count, clock_timestamp(),
        'employee-master-dual-source-v1;hash:' || v_home_hash),
      ('居家排班表/填表', v_directory_rows,
        jsonb_array_length(v_directory_rows), clock_timestamp(),
        'employee-master-dual-source-v1;hash:' || v_schedule_hash)
    on conflict (source) do update
    set payload = excluded.payload,
        row_count = excluded.row_count,
        synced_at = excluded.synced_at,
        note = excluded.note;

    v_directory_result := public.sync_report_employee_directory(v_directory_rows);

    select count(*)::integer into v_issue_count
    from public.employee_master_sync_issues issue
    where issue.run_id = v_run_id;
    v_warning_count := v_warning_count + v_issue_count;

    v_final_status := 'success';

    update public.employee_master_sync_runs
    set status = v_final_status,
        finished_at = clock_timestamp(),
        inserted_count = v_inserted,
        updated_count = v_updated,
        rekeyed_count = v_rekeyed,
        pending_departure_count = v_pending_departure,
        archived_count = v_archived,
        restored_count = v_restored,
        historical_skipped_count = v_historical_skipped,
        warning_count = v_warning_count
    where id = v_run_id;

    return jsonb_build_object(
      'ok', true,
      'status', v_final_status,
      'run_id', v_run_id,
      'request_id', v_request_id,
      'home_rows', v_home_roster_count,
      'schedule_rows', v_schedule_roster_count,
      'inserted', v_inserted,
      'updated', v_updated,
      'rekeyed', v_rekeyed,
      'pending_departure', v_pending_departure,
      'archived', v_archived,
      'restored', v_restored,
      'historical_skipped', v_historical_skipped,
      'warnings', v_warning_count,
      'directory_rows', coalesce((v_directory_result->>'rows')::integer, 0)
    );
  exception when others then
    get stacked diagnostics
      v_error_state = returned_sqlstate,
      v_error_message = message_text;
    update public.employee_master_sync_runs
    set status = 'failed', finished_at = clock_timestamp(),
      error_code = v_error_state,
      error_detail = left(v_error_message, 1000)
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false,
      'status', 'failed',
      'run_id', v_run_id,
      'request_id', v_request_id,
      'error_code', v_error_message
    );
  end;
end;
$$;

revoke all on function public.ingest_employee_master_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_employee_master_snapshot(jsonb)
  to service_role;

comment on function public.ingest_employee_master_snapshot(jsonb) is
  'Service-only atomic dual-source employee master reconciliation. Canonical employees and Auth users are never physically deleted.';

notify pgrst, 'reload schema';
