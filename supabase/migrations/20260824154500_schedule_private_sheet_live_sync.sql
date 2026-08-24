-- Near-real-time private schedule push. Google Apps Script sends the exact
-- allowlisted 填表!A:M snapshot; the Edge Function normalizes it and this RPC
-- atomically updates both the durable snapshot and derived employee directory.

create table if not exists public.schedule_sheet_sync_runs (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  trigger_kind text not null check (trigger_kind in ('change', 'manual')),
  spreadsheet_id text not null,
  sheet_gid text not null,
  tab_name text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  parser_version text not null,
  captured_at timestamptz not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'started'
    check (status in ('started', 'success', 'unchanged', 'repaired', 'failed')),
  read_row_count integer not null default 0 check (read_row_count >= 0),
  roster_row_count integer not null default 0 check (roster_row_count >= 0),
  directory_row_count integer not null default 0 check (directory_row_count >= 0),
  inserted_count integer not null default 0 check (inserted_count >= 0),
  updated_count integer not null default 0 check (updated_count >= 0),
  deleted_count integer not null default 0 check (deleted_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  error_code text,
  error_detail text
);

create index if not exists schedule_sheet_sync_runs_started_idx
  on public.schedule_sheet_sync_runs (started_at desc);
create index if not exists schedule_sheet_sync_runs_status_idx
  on public.schedule_sheet_sync_runs (status, started_at desc);

alter table public.schedule_sheet_sync_runs enable row level security;
revoke all on table public.schedule_sheet_sync_runs
  from public, anon, authenticated;
grant select on table public.schedule_sheet_sync_runs to service_role;

create or replace function public.ingest_schedule_roster_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_text text;
  v_request_id uuid;
  v_trigger_kind text;
  v_spreadsheet_id text;
  v_sheet_gid text;
  v_tab_name text;
  v_source_key text;
  v_snapshot_hash text;
  v_parser_version text;
  v_captured_at timestamptz;
  v_read_row_count integer;
  v_warning_count integer;
  v_rows jsonb;
  v_roster_row_count integer;
  v_old_payload jsonb := '[]'::jsonb;
  v_old_note text := '';
  v_old_hash text := '';
  v_run_id bigint;
  v_existing_status text;
  v_existing_snapshot_hash text;
  v_existing_spreadsheet_id text;
  v_existing_sheet_gid text;
  v_existing_tab_name text;
  v_latest_captured_at timestamptz;
  v_directory_result jsonb := '{}'::jsonb;
  v_directory_row_count integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_cache_matches boolean := false;
  v_error_state text;
  v_error_message text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  if octet_length(p_payload::text) > 6291456 then
    raise exception 'payload_too_large';
  end if;

  v_request_text := btrim(coalesce(p_payload->>'request_id', ''));
  if v_request_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'invalid_request_id';
  end if;
  v_request_id := v_request_text::uuid;
  v_trigger_kind := btrim(coalesce(p_payload->>'trigger_kind', ''));
  v_source_key := btrim(coalesce(p_payload#>>'{source,source_key}', ''));
  v_spreadsheet_id := btrim(coalesce(p_payload#>>'{source,spreadsheet_id}', ''));
  v_sheet_gid := btrim(coalesce(p_payload#>>'{source,sheet_gid}', ''));
  v_tab_name := btrim(coalesce(p_payload#>>'{source,tab_name}', ''));
  v_snapshot_hash := lower(btrim(coalesce(p_payload->>'snapshot_hash', '')));
  v_parser_version := btrim(coalesce(p_payload->>'parser_version', ''));

  if v_trigger_kind not in ('change', 'manual') then
    raise exception 'invalid_trigger_kind';
  end if;
  if not (
    v_source_key = 'home_roster_current'
    and v_spreadsheet_id = '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA'
    and v_sheet_gid = '1457335551'
    and v_tab_name = '填表'
  ) then
    raise exception 'source_not_allowlisted';
  end if;
  if v_snapshot_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_snapshot_hash';
  end if;
  if v_parser_version <> 'schedule-roster-a-m-v1' then
    raise exception 'invalid_parser_version';
  end if;

  begin
    v_captured_at := (p_payload->>'captured_at')::timestamptz;
    v_read_row_count := (p_payload->>'read_row_count')::integer;
    v_warning_count := coalesce((p_payload->>'parse_warning_count')::integer, 0);
  exception when others then
    raise exception 'invalid_snapshot_metadata';
  end;
  if v_captured_at is null
    or v_read_row_count is null
    or v_read_row_count < 2 or v_read_row_count > 3500
    or v_warning_count < 0 then
    raise exception 'invalid_snapshot_metadata';
  end if;

  v_rows := p_payload->'rows';
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception 'rows_must_be_array';
  end if;
  v_roster_row_count := jsonb_array_length(v_rows);
  -- Fail closed: a private-source outage or malformed read must never clear
  -- the last known-good roster and derived employee directory.
  if v_roster_row_count < 1 or v_roster_row_count > 3499 then
    raise exception 'snapshot_roster_count_invalid';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_rows) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item->>'name'), '') is null
      or case
        when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer not between 2 and 3500
        else true
      end
  ) then
    raise exception 'invalid_roster_row';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(v_rows) item
    where nullif(btrim(item->>'employee_id'), '') is not null
  ) then
    raise exception 'snapshot_has_no_employee_ids';
  end if;

  -- One transaction at a time owns the authoritative schedule snapshot.
  perform pg_advisory_xact_lock(hashtextextended('schedule-roster-live-sync', 0));

  select
    r.id, r.status, r.snapshot_hash, r.spreadsheet_id, r.sheet_gid, r.tab_name
  into
    v_run_id, v_existing_status, v_existing_snapshot_hash,
    v_existing_spreadsheet_id, v_existing_sheet_gid, v_existing_tab_name
  from public.schedule_sheet_sync_runs r
  where r.request_id = v_request_id;
  if v_run_id is not null then
    if v_existing_snapshot_hash <> v_snapshot_hash
      or v_existing_spreadsheet_id <> v_spreadsheet_id
      or v_existing_sheet_gid <> v_sheet_gid
      or v_existing_tab_name <> v_tab_name then
      raise exception 'request_id_reuse_mismatch';
    end if;
    return jsonb_build_object(
      'ok', v_existing_status <> 'failed',
      'status', v_existing_status,
      'run_id', v_run_id,
      'request_id', v_request_id
    );
  end if;

  insert into public.schedule_sheet_sync_runs (
    request_id, trigger_kind, spreadsheet_id, sheet_gid, tab_name,
    snapshot_hash, parser_version, captured_at, read_row_count,
    roster_row_count, warning_count
  ) values (
    v_request_id, v_trigger_kind, v_spreadsheet_id, v_sheet_gid, v_tab_name,
    v_snapshot_hash, v_parser_version, v_captured_at, v_read_row_count,
    v_roster_row_count, v_warning_count
  )
  returning id into v_run_id;

  select max(r.captured_at)
  into v_latest_captured_at
  from public.schedule_sheet_sync_runs r
  where r.id <> v_run_id
    and r.status in ('success', 'unchanged', 'repaired');
  if v_latest_captured_at is not null and v_captured_at < v_latest_captured_at then
    update public.schedule_sheet_sync_runs
    set status = 'failed', finished_at = now(), error_code = 'stale_snapshot',
      error_detail = 'Older captured_at cannot replace the current schedule snapshot.'
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false, 'status', 'failed', 'run_id', v_run_id,
      'request_id', v_request_id, 'error_code', 'stale_snapshot'
    );
  end if;

  begin
    select s.payload, coalesce(s.note, '')
    into v_old_payload, v_old_note
    from public.report_sheet_snapshots s
    where s.source = '居家排班表/填表'
    for update;
    if v_old_payload is null or jsonb_typeof(v_old_payload) <> 'array' then
      v_old_payload := '[]'::jsonb;
    end if;
    v_old_hash := coalesce(
      substring(lower(v_old_note) from 'hash:([0-9a-f]{64})'),
      ''
    );

    with old_rows as materialized (
      select distinct on (upper(btrim(item->>'employee_id')))
        upper(btrim(item->>'employee_id')) employee_id,
        item row_payload
      from jsonb_array_elements(v_old_payload) item
      where nullif(btrim(item->>'employee_id'), '') is not null
      order by upper(btrim(item->>'employee_id')),
        case when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer end desc nulls last
    ), new_rows as materialized (
      select distinct on (upper(btrim(item->>'employee_id')))
        upper(btrim(item->>'employee_id')) employee_id,
        item row_payload
      from jsonb_array_elements(v_rows) item
      where nullif(btrim(item->>'employee_id'), '') is not null
      order by upper(btrim(item->>'employee_id')),
        case when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer end desc nulls last
    )
    select
      count(*) filter (where o.employee_id is null)::integer,
      count(*) filter (
        where o.employee_id is not null and n.employee_id is not null
          and n.row_payload is distinct from o.row_payload
      )::integer,
      count(*) filter (where n.employee_id is null)::integer
    into v_inserted, v_updated, v_deleted
    from new_rows n
    full outer join old_rows o using (employee_id);

    v_cache_matches := public.report_employee_directory_cache_matches(v_rows);
    if v_old_hash = v_snapshot_hash and v_cache_matches then
      update public.report_sheet_snapshots
      set synced_at = now()
      where source = '居家排班表/填表';

      select count(*)::integer into v_directory_row_count
      from public.report_employee_directory_cache;
      update public.schedule_sheet_sync_runs
      set status = 'unchanged', finished_at = now(),
        directory_row_count = v_directory_row_count,
        inserted_count = 0, updated_count = 0, deleted_count = 0
      where id = v_run_id;
      return jsonb_build_object(
        'ok', true, 'status', 'unchanged', 'run_id', v_run_id,
        'request_id', v_request_id, 'rows', v_roster_row_count,
        'directory_rows', v_directory_row_count,
        'inserted', 0, 'updated', 0, 'deleted', 0,
        'warnings', v_warning_count
      );
    end if;

    insert into public.report_sheet_snapshots (
      source, payload, row_count, synced_at, note
    ) values (
      '居家排班表/填表', v_rows, v_roster_row_count, now(),
      'private-schedule-push-v1;hash:' || v_snapshot_hash
    )
    on conflict (source) do update set
      payload = excluded.payload,
      row_count = excluded.row_count,
      synced_at = excluded.synced_at,
      note = excluded.note;

    v_directory_result := public.sync_report_employee_directory(v_rows);
    v_directory_row_count := greatest(
      0,
      coalesce((v_directory_result->>'rows')::integer, 0)
    );

    update public.schedule_sheet_sync_runs
    set status = case when v_old_hash = v_snapshot_hash then 'repaired' else 'success' end,
      finished_at = now(), directory_row_count = v_directory_row_count,
      inserted_count = v_inserted, updated_count = v_updated,
      deleted_count = v_deleted
    where id = v_run_id;

    return jsonb_build_object(
      'ok', true,
      'status', case when v_old_hash = v_snapshot_hash then 'repaired' else 'success' end,
      'run_id', v_run_id,
      'request_id', v_request_id,
      'rows', v_roster_row_count,
      'directory_rows', v_directory_row_count,
      'inserted', v_inserted,
      'updated', v_updated,
      'deleted', v_deleted,
      'warnings', v_warning_count
    );
  exception when others then
    get stacked diagnostics
      v_error_state = returned_sqlstate,
      v_error_message = message_text;
    update public.schedule_sheet_sync_runs
    set status = 'failed', finished_at = now(), error_code = v_error_state,
      error_detail = left(v_error_message, 1000)
    where id = v_run_id;
    return jsonb_build_object(
      'ok', false,
      'status', 'failed',
      'run_id', v_run_id,
      'request_id', v_request_id,
      'error_code', v_error_state
    );
  end;
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

comment on table public.schedule_sheet_sync_runs is
  'Server-only audit trail for private Google schedule roster push runs.';
comment on function public.ingest_schedule_roster_snapshot(jsonb) is
  'Service-role-only atomic ingest for the allowlisted private 填表!A:M roster snapshot.';
