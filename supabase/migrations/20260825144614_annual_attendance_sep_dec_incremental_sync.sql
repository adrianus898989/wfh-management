-- Three annual 2026 workbooks, September-December.
--
-- Each source is one authoritative monthly snapshot containing sparse day-grid
-- exceptions plus that month's adjustment block. Physical Google row numbers
-- are audit metadata only; the Edge parser supplies a stable SHA-256 identity
-- tuple in source_row/source_item_key.

insert into public.attendance_sheet_sources (
  source_key, source_name, scope, source_group, source_month,
  sheet_id, sheet_gid, sheet_url, status, is_active, metadata
)
values
  ('onsite_annual_2026_09','2026年现场转居家考勤绩效 · 9月','mixed','onsite_to_home','2026-09',
    '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','605098048',
    'https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit#gid=605098048','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"9月","adjustment_tab":"填表","adjustment_sheet_gid":"1011694934","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('onsite_annual_2026_10','2026年现场转居家考勤绩效 · 10月','mixed','onsite_to_home','2026-10',
    '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','938715589',
    'https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit#gid=938715589','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"10月","adjustment_tab":"填表","adjustment_sheet_gid":"1011694934","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('onsite_annual_2026_11','2026年现场转居家考勤绩效 · 11月','mixed','onsite_to_home','2026-11',
    '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','200094426',
    'https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit#gid=200094426','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"11月","adjustment_tab":"填表","adjustment_sheet_gid":"1011694934","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('onsite_annual_2026_12','2026年现场转居家考勤绩效 · 12月','mixed','onsite_to_home','2026-12',
    '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','462628124',
    'https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit#gid=462628124','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"12月","adjustment_tab":"填表","adjustment_sheet_gid":"1011694934","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('home_vimm_annual_2026_09','2026年居家越南-印尼-缅甸考勤绩效 · 9月','mixed','home','2026-09',
    '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','515895997',
    'https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit#gid=515895997','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"9月","adjustment_tab":"填表","adjustment_sheet_gid":"3368572","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('home_vimm_annual_2026_10','2026年居家越南-印尼-缅甸考勤绩效 · 10月','mixed','home','2026-10',
    '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','2006236394',
    'https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit#gid=2006236394','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"10月","adjustment_tab":"填表","adjustment_sheet_gid":"3368572","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('home_vimm_annual_2026_11','2026年居家越南-印尼-缅甸考勤绩效 · 11月','mixed','home','2026-11',
    '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','465666790',
    'https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit#gid=465666790','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"11月","adjustment_tab":"填表","adjustment_sheet_gid":"3368572","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('home_vimm_annual_2026_12','2026年居家越南-印尼-缅甸考勤绩效 · 12月','mixed','home','2026-12',
    '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','527622305',
    'https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit#gid=527622305','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"12月","adjustment_tab":"填表","adjustment_sheet_gid":"3368572","currency":"USD","snapshot_mode":"sparse_exceptions"}}'),
  ('home_ph_annual_2026_09','2026年居家菲律宾考勤绩效 · 9月','mixed','home','2026-09',
    '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','1827489324',
    'https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit#gid=1827489324','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"9月","adjustment_tab":"填表","adjustment_sheet_gid":"687407921","currency":"PHP","snapshot_mode":"sparse_exceptions"}}'),
  ('home_ph_annual_2026_10','2026年居家菲律宾考勤绩效 · 10月','mixed','home','2026-10',
    '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','296363311',
    'https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit#gid=296363311','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"10月","adjustment_tab":"填表","adjustment_sheet_gid":"687407921","currency":"PHP","snapshot_mode":"sparse_exceptions"}}'),
  ('home_ph_annual_2026_11','2026年居家菲律宾考勤绩效 · 11月','mixed','home','2026-11',
    '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','138573169',
    'https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit#gid=138573169','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"11月","adjustment_tab":"填表","adjustment_sheet_gid":"687407921","currency":"PHP","snapshot_mode":"sparse_exceptions"}}'),
  ('home_ph_annual_2026_12','2026年居家菲律宾考勤绩效 · 12月','mixed','home','2026-12',
    '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','787543818',
    'https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit#gid=787543818','pending',true,
    '{"annual_sync":{"contract":"annual_v1","attendance_tab":"12月","adjustment_tab":"填表","adjustment_sheet_gid":"687407921","currency":"PHP","snapshot_mode":"sparse_exceptions"}}')
on conflict (source_key) do update set
  source_name = excluded.source_name,
  scope = excluded.scope,
  source_group = excluded.source_group,
  source_month = excluded.source_month,
  sheet_id = excluded.sheet_id,
  sheet_gid = excluded.sheet_gid,
  sheet_url = excluded.sheet_url,
  is_active = true,
  metadata = public.attendance_sheet_sources.metadata || excluded.metadata,
  updated_at = now();

-- The workbook is the money-unit authority for these fixed routes. Employee
-- country is only a fallback for older sources: it must not turn an allowlisted
-- USD/PHP workbook into NULL when the employee is not matched yet.
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
  v_source_currency text;
  v_country text := nullif(btrim(p_country_raw), '');
  v_employment_type text;
  v_history_key text;
begin
  select
    s.source_group,
    case
      when upper(btrim(coalesce(s.metadata#>>'{annual_sync,currency}', ''))) in ('USD', 'PHP')
        then upper(btrim(s.metadata#>>'{annual_sync,currency}'))
      when upper(btrim(coalesce(s.metadata->>'currency', ''))) in ('USD', 'PHP')
        then upper(btrim(s.metadata->>'currency'))
    end
  into v_source_group, v_source_currency
  from public.attendance_sheet_sources s
  where s.id = p_source_id;

  if v_source_currency is not null then
    return v_source_currency;
  end if;

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

-- Fail the migration if any of the twelve immutable annual routes lost its
-- declared currency. This protects both the trigger and the historical repair.
do $$
declare
  v_valid_annual_sources integer;
begin
  select count(*)
  into v_valid_annual_sources
  from public.attendance_sheet_sources s
  where s.source_key in (
    'onsite_annual_2026_09', 'onsite_annual_2026_10',
    'onsite_annual_2026_11', 'onsite_annual_2026_12',
    'home_vimm_annual_2026_09', 'home_vimm_annual_2026_10',
    'home_vimm_annual_2026_11', 'home_vimm_annual_2026_12',
    'home_ph_annual_2026_09', 'home_ph_annual_2026_10',
    'home_ph_annual_2026_11', 'home_ph_annual_2026_12'
  )
    and s.metadata#>>'{annual_sync,contract}' = 'annual_v1'
    and (
      (s.source_key like 'onsite_annual_2026_%'
        and upper(btrim(coalesce(s.metadata#>>'{annual_sync,currency}', ''))) = 'USD')
      or (s.source_key like 'home_vimm_annual_2026_%'
        and upper(btrim(coalesce(s.metadata#>>'{annual_sync,currency}', ''))) = 'USD')
      or (s.source_key like 'home_ph_annual_2026_%'
        and upper(btrim(coalesce(s.metadata#>>'{annual_sync,currency}', ''))) = 'PHP')
    );

  if v_valid_annual_sources <> 12 then
    raise exception 'annual_source_currency_configuration_invalid';
  end if;
end;
$$;

-- Repair rows created by a partially deployed predecessor. Future INSERTs and
-- identity-rematch UPDATEs are covered by employee_attendance_set_currency.
with configured_sources as materialized (
  select
    s.id,
    case
      when upper(btrim(coalesce(s.metadata#>>'{annual_sync,currency}', ''))) in ('USD', 'PHP')
        then upper(btrim(s.metadata#>>'{annual_sync,currency}'))
      when upper(btrim(coalesce(s.metadata->>'currency', ''))) in ('USD', 'PHP')
        then upper(btrim(s.metadata->>'currency'))
    end currency
  from public.attendance_sheet_sources s
  where s.metadata#>>'{annual_sync,contract}' = 'annual_v1'
    or s.metadata->>'sync_protocol' = 'adjustment-v1'
)
update public.employee_attendance_records r
set currency = s.currency,
  updated_at = now()
from configured_sources s
where r.source_id = s.id
  and r.kind = 'adjustment'
  and s.currency is not null
  and r.currency is distinct from s.currency;

create or replace function attendance_private.ingest_annual_attendance_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
  v_run_id uuid;
  v_source_id uuid;
  v_source_key text;
  v_spreadsheet_id text;
  v_sheet_gid text;
  v_tab_name text;
  v_adjustment_sheet_gid text;
  v_adjustment_tab_name text;
  v_source_month text;
  v_trigger_kind text;
  v_snapshot_hash text;
  v_previous_hash text;
  v_last_captured_at timestamptz;
  v_captured_at timestamptz;
  v_date_from date;
  v_date_to date;
  v_read_row_count integer;
  v_payload_row_count integer;
  v_existing_record_count integer := 0;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_deleted integer := 0;
  v_unchanged integer := 0;
  v_raw integer := 0;
  v_canonical integer := 0;
  v_mirrors integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_ambiguous integer := 0;
  v_result jsonb;
  v_existing_result jsonb;
  v_existing_status text;
  v_existing_source_id uuid;
  v_existing_snapshot_hash text;
  v_error text;
  v_allow_large_delete boolean := false;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_payload';
  end if;
  if octet_length(p_payload::text) > 6291456 then raise exception 'payload_too_large'; end if;

  v_request_id := nullif(btrim(p_payload->>'request_id'), '')::uuid;
  v_source_key := btrim(coalesce(p_payload#>>'{source,source_key}', ''));
  v_spreadsheet_id := btrim(coalesce(p_payload#>>'{source,spreadsheet_id}', ''));
  v_sheet_gid := btrim(coalesce(p_payload#>>'{source,sheet_gid}', ''));
  v_tab_name := coalesce(p_payload#>>'{source,tab_name}', '');
  v_adjustment_sheet_gid := btrim(coalesce(p_payload#>>'{source,adjustment_sheet_gid}', ''));
  v_adjustment_tab_name := coalesce(p_payload#>>'{source,adjustment_tab_name}', '');
  v_trigger_kind := lower(btrim(coalesce(p_payload->>'trigger_kind', 'change')));
  v_snapshot_hash := lower(btrim(coalesce(p_payload->>'snapshot_hash', '')));
  v_captured_at := coalesce(nullif(p_payload->>'captured_at', '')::timestamptz, now());
  v_read_row_count := coalesce(nullif(p_payload->>'read_row_count', '')::integer, 0);
  v_allow_large_delete := coalesce((p_payload->>'allow_large_delete')::boolean, false);

  if v_request_id is null then raise exception 'request_id_required'; end if;
  if v_trigger_kind not in ('change', 'daily_reconcile', 'manual') then raise exception 'invalid_trigger_kind'; end if;
  if v_snapshot_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_snapshot_hash'; end if;
  if v_read_row_count < 0 or v_read_row_count > 4000 then raise exception 'invalid_read_row_count'; end if;
  if coalesce(jsonb_typeof(p_payload->'rows'), 'null') <> 'array' then raise exception 'rows_must_be_array'; end if;
  v_payload_row_count := jsonb_array_length(p_payload->'rows');
  if v_payload_row_count > 60000 then raise exception 'too_many_records'; end if;

  with allowed(
    source_key, spreadsheet_id, sheet_gid, tab_name,
    adjustment_sheet_gid, adjustment_tab_name, source_month
  ) as (values
    ('onsite_annual_2026_09','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','605098048','9月','1011694934','填表','2026-09'),
    ('onsite_annual_2026_10','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','938715589','10月','1011694934','填表','2026-10'),
    ('onsite_annual_2026_11','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','200094426','11月','1011694934','填表','2026-11'),
    ('onsite_annual_2026_12','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','462628124','12月','1011694934','填表','2026-12'),
    ('home_vimm_annual_2026_09','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','515895997','9月','3368572','填表','2026-09'),
    ('home_vimm_annual_2026_10','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','2006236394','10月','3368572','填表','2026-10'),
    ('home_vimm_annual_2026_11','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','465666790','11月','3368572','填表','2026-11'),
    ('home_vimm_annual_2026_12','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','527622305','12月','3368572','填表','2026-12'),
    ('home_ph_annual_2026_09','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','1827489324','9月','687407921','填表','2026-09'),
    ('home_ph_annual_2026_10','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','296363311','10月','687407921','填表','2026-10'),
    ('home_ph_annual_2026_11','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','138573169','11月','687407921','填表','2026-11'),
    ('home_ph_annual_2026_12','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','787543818','12月','687407921','填表','2026-12')
  )
  select s.id, a.source_month
  into v_source_id, v_source_month
  from allowed a
  join public.attendance_sheet_sources s
    on s.source_key = a.source_key
    and s.source_month = a.source_month
    and s.sheet_id = a.spreadsheet_id
    and s.sheet_gid = a.sheet_gid
    and s.is_active
  where a.source_key = v_source_key
    and a.spreadsheet_id = v_spreadsheet_id
    and a.sheet_gid = v_sheet_gid
    and a.tab_name = v_tab_name
    and a.adjustment_sheet_gid = v_adjustment_sheet_gid
    and a.adjustment_tab_name = v_adjustment_tab_name
  limit 1;
  if v_source_id is null then raise exception 'source_not_configured'; end if;

  v_date_from := (v_source_month || '-01')::date;
  v_date_to := (v_date_from + interval '1 month')::date;
  perform pg_advisory_xact_lock(hashtextextended('attendance-annual-sync:' || v_source_key, 0));

  select
    case when lower(s.content_hash) ~ '^[0-9a-f]{64}$' then lower(s.content_hash) end,
    nullif(s.metadata#>>'{live_sync,last_captured_at}', '')::timestamptz
  into v_previous_hash, v_last_captured_at
  from public.attendance_sheet_sources s
  where s.id = v_source_id;

  select r.id, r.status, r.result, r.source_id, r.snapshot_hash
  into v_run_id, v_existing_status, v_existing_result, v_existing_source_id, v_existing_snapshot_hash
  from public.attendance_sheet_sync_runs r
  where r.request_id = v_request_id;
  if v_run_id is not null then
    if v_existing_source_id <> v_source_id or v_existing_snapshot_hash <> v_snapshot_hash then
      raise exception 'request_id_reuse_mismatch';
    end if;
    return coalesce(v_existing_result, jsonb_build_object(
      'ok', v_existing_status in ('success','unchanged'),
      'request_id', v_request_id, 'run_id', v_run_id, 'status', v_existing_status
    )) || jsonb_build_object('idempotent_replay', true);
  end if;

  -- Hash equality is deliberately checked before inserting an audit run or
  -- touching source metadata: unchanged annual snapshots are a zero-write path.
  if v_previous_hash = v_snapshot_hash then
    return jsonb_build_object(
      'ok', true, 'request_id', v_request_id, 'source_key', v_source_key,
      'status', 'unchanged', 'snapshot_hash', v_snapshot_hash,
      'inserted', 0, 'updated', 0, 'deleted', 0
    );
  end if;

  insert into public.attendance_sheet_sync_runs (
    request_id, source_id, trigger_kind, status, snapshot_hash,
    previous_snapshot_hash, read_row_count, captured_at, details
  ) values (
    v_request_id, v_source_id, v_trigger_kind, 'running', v_snapshot_hash,
    v_previous_hash, v_read_row_count, v_captured_at,
    jsonb_build_object(
      'source_key', v_source_key, 'spreadsheet_id', v_spreadsheet_id,
      'sheet_gid', v_sheet_gid, 'tab_name', v_tab_name,
      'adjustment_sheet_gid', v_adjustment_sheet_gid,
      'adjustment_tab_name', v_adjustment_tab_name,
      'parser_version', coalesce(p_payload->>'parser_version', 'unknown'),
      'parse_warning_count', coalesce((p_payload->>'parse_warning_count')::integer, 0),
      'identity', 'stable_sha256_not_physical_row'
    )
  ) returning id into v_run_id;

  if v_last_captured_at is not null and v_captured_at < v_last_captured_at then
    v_result := jsonb_build_object(
      'ok', false, 'request_id', v_request_id, 'run_id', v_run_id,
      'source_key', v_source_key, 'status', 'failed', 'error', 'stale_snapshot'
    );
    update public.attendance_sheet_sync_runs
    set status='failed', error_message='stale_snapshot', result=v_result, completed_at=now()
    where id=v_run_id;
    return v_result;
  end if;

  update public.attendance_sheet_sources
  set status='running', sync_started_at=now(), error_message=null, updated_at=now()
  where id=v_source_id;

  begin
    -- Static shape invariant: 24 target columns = 24 SELECT expressions.
    -- The recordset has 22 payload fields; run_id/source_id are trusted context.
    insert into attendance_private.attendance_sheet_sync_stage (
      run_id, source_id, source_block, source_row, source_item_key,
      kind, event_date, event_kind, reason, note, amount, raw_amount,
      employee_no_raw, employee_name_raw, employee_status_raw,
      team_name_raw, position_name_raw, country_raw, platform_raw, manager_raw,
      raw_values, content_hash, is_mirror, source_updated_at
    )
    select
      v_run_id, v_source_id, btrim(x.source_block), x.source_row,
      btrim(x.source_item_key), btrim(x.kind), x.event_date,
      btrim(x.event_kind), nullif(btrim(x.reason), ''), nullif(btrim(x.note), ''),
      x.amount, nullif(btrim(x.raw_amount), ''), nullif(btrim(x.employee_no_raw), ''),
      nullif(btrim(x.employee_name_raw), ''), nullif(btrim(x.employee_status_raw), ''),
      nullif(btrim(x.team_name_raw), ''), nullif(btrim(x.position_name_raw), ''),
      nullif(btrim(x.country_raw), ''), nullif(btrim(x.platform_raw), ''),
      nullif(btrim(x.manager_raw), ''), coalesce(x.raw_values, '{}'::jsonb),
      lower(btrim(x.content_hash)), false, v_captured_at
    from jsonb_to_recordset(p_payload->'rows') as x(
      source_block text, source_row integer, source_item_key text,
      kind text, event_date date, event_kind text, reason text, note text,
      amount numeric, raw_amount text, employee_no_raw text, employee_name_raw text,
      employee_status_raw text, team_name_raw text, position_name_raw text,
      country_raw text, platform_raw text, manager_raw text, raw_values jsonb,
      content_hash text, is_mirror boolean, source_updated_at timestamptz
    );

    if (select count(*) from attendance_private.attendance_sheet_sync_stage where run_id=v_run_id)
      <> v_payload_row_count then raise exception 'staging_count_mismatch'; end if;

    if exists (
      select 1 from attendance_private.attendance_sheet_sync_stage x
      where x.run_id=v_run_id and (
        x.source_block not in ('attendance','resignation','adjustment')
        or x.kind <> x.source_block
        or x.source_row <= 0
        or x.source_item_key !~ '^v1:[0-9a-f]{64}$'
        or x.event_date is null or x.event_date < v_date_from or x.event_date >= v_date_to
        or nullif(btrim(x.event_kind), '') is null
        or (x.employee_no_raw is null and x.employee_name_raw is null)
        or (x.kind='attendance' and x.event_kind not in ('public_holiday','home_leave','leave','half_day','absence'))
        or (x.kind='resignation' and x.event_kind <> 'resignation')
        or (x.kind='adjustment' and (x.event_kind not in ('bonus','deduction') or x.amount is null or x.amount=0))
        or (x.kind<>'adjustment' and x.amount is not null)
        or x.is_mirror
        or x.content_hash !~ '^[0-9a-f]{64}$'
        or octet_length(coalesce(x.employee_no_raw,'')) > 2000
        or octet_length(coalesce(x.employee_name_raw,'')) > 2000
        or octet_length(coalesce(x.note,'')) > 40000
        or octet_length(x.raw_values::text) > 100000
      )
    ) then raise exception 'invalid_normalized_record'; end if;

    select count(*) into v_existing_record_count
    from public.employee_attendance_records r where r.source_id=v_source_id;

    select count(*) into v_deleted
    from public.employee_attendance_records r
    where r.source_id=v_source_id and not exists (
      select 1 from attendance_private.attendance_sheet_sync_stage x
      where x.run_id=v_run_id and x.source_block=r.source_block
        and x.source_row=r.source_row and x.source_item_key=r.source_item_key
    );

    if v_existing_record_count>0 and v_payload_row_count=0 and v_read_row_count=0
      and not (v_trigger_kind='manual' and v_allow_large_delete) then
      raise exception 'empty_snapshot_requires_manual_override';
    end if;
    -- Automatic snapshots may insert and update, but never remove canonical
    -- attendance or adjustment history. Any deletion requires an explicit
    -- reviewed manual run, even when only one row would disappear.
    if v_deleted>0 and not (v_trigger_kind='manual' and v_allow_large_delete) then
      raise exception 'large_delete_requires_manual_override';
    end if;

    select
      count(*) filter(where r.id is null),
      count(*) filter(where r.id is not null and r.content_hash is distinct from x.content_hash),
      count(*) filter(where r.id is not null and r.content_hash=x.content_hash)
    into v_inserted,v_updated,v_unchanged
    from attendance_private.attendance_sheet_sync_stage x
    left join public.employee_attendance_records r
      on r.source_id=v_source_id and r.source_block=x.source_block
      and r.source_row=x.source_row and r.source_item_key=x.source_item_key
    where x.run_id=v_run_id;

    insert into public.attendance_sheet_sync_changes (
      run_id,source_id,operation,source_block,source_row,source_item_key,record_id,before_record
    )
    select v_run_id,v_source_id,'update',r.source_block,r.source_row,r.source_item_key,r.id,to_jsonb(r)
    from public.employee_attendance_records r
    join attendance_private.attendance_sheet_sync_stage x
      on x.run_id=v_run_id and x.source_block=r.source_block
      and x.source_row=r.source_row and x.source_item_key=r.source_item_key
    where r.source_id=v_source_id and r.content_hash is distinct from x.content_hash;

    insert into public.attendance_sheet_sync_changes (
      run_id,source_id,operation,source_block,source_row,source_item_key,record_id,before_record
    )
    select v_run_id,v_source_id,'delete',r.source_block,r.source_row,r.source_item_key,r.id,to_jsonb(r)
    from public.employee_attendance_records r
    where r.source_id=v_source_id and not exists (
      select 1 from attendance_private.attendance_sheet_sync_stage x
      where x.run_id=v_run_id and x.source_block=r.source_block
        and x.source_row=r.source_row and x.source_item_key=r.source_item_key
    );

    insert into public.attendance_sheet_sync_changes (
      run_id,source_id,operation,source_block,source_row,source_item_key
    )
    select v_run_id,v_source_id,'insert',x.source_block,x.source_row,x.source_item_key
    from attendance_private.attendance_sheet_sync_stage x
    left join public.employee_attendance_records r
      on r.source_id=v_source_id and r.source_block=x.source_block
      and r.source_row=x.source_row and r.source_item_key=x.source_item_key
    where x.run_id=v_run_id and r.id is null;

    -- New rows only. Unlike the August v1 ingest, unchanged stage rows are not
    -- attempted inserts, so their currency trigger/resolver never runs.
    -- Currency is intentionally absent: the BEFORE trigger derives it from the
    -- trusted source metadata, never from the HTTP payload. Static invariant:
    -- 25 target columns = 25 SELECT expressions.
    insert into public.employee_attendance_records (
      source_id,source_block,source_row,source_item_key,kind,event_date,event_kind,
      reason,note,amount,raw_amount,employee_no_raw,employee_name_raw,
      employee_status_raw,team_name_raw,position_name_raw,country_raw,platform_raw,
      manager_raw,match_status,raw_values,content_hash,is_mirror,source_updated_at,synced_at
    )
    select
      v_source_id,x.source_block,x.source_row,x.source_item_key,x.kind,x.event_date,x.event_kind,
      x.reason,x.note,x.amount,x.raw_amount,x.employee_no_raw,x.employee_name_raw,
      x.employee_status_raw,x.team_name_raw,x.position_name_raw,x.country_raw,x.platform_raw,
      x.manager_raw,'unmatched',x.raw_values,x.content_hash,false,x.source_updated_at,now()
    from attendance_private.attendance_sheet_sync_stage x
    left join public.employee_attendance_records r
      on r.source_id=v_source_id and r.source_block=x.source_block
      and r.source_row=x.source_row and r.source_item_key=x.source_item_key
    where x.run_id=v_run_id and r.id is null;

    -- Existing rows are updated only when semantic/audit content changed.
    update public.employee_attendance_records r
    set
      kind=x.kind,event_date=x.event_date,event_kind=x.event_kind,reason=x.reason,note=x.note,
      amount=x.amount,raw_amount=x.raw_amount,employee_no_raw=x.employee_no_raw,
      employee_name_raw=x.employee_name_raw,employee_status_raw=x.employee_status_raw,
      team_name_raw=x.team_name_raw,position_name_raw=x.position_name_raw,
      country_raw=x.country_raw,platform_raw=x.platform_raw,manager_raw=x.manager_raw,
      employee_id=null,match_status='unmatched',match_method=null,matched_at=null,
      raw_values=x.raw_values,content_hash=x.content_hash,is_mirror=false,
      source_updated_at=x.source_updated_at,synced_at=now(),updated_at=now()
    from attendance_private.attendance_sheet_sync_stage x
    where x.run_id=v_run_id and r.source_id=v_source_id
      and r.source_block=x.source_block and r.source_row=x.source_row
      and r.source_item_key=x.source_item_key
      and r.content_hash is distinct from x.content_hash;

    delete from public.employee_attendance_records r
    where r.source_id=v_source_id and not exists (
      select 1 from attendance_private.attendance_sheet_sync_stage x
      where x.run_id=v_run_id and x.source_block=r.source_block
        and x.source_row=r.source_row and x.source_item_key=r.source_item_key
    );

    with employee_id_keys as materialized (
      select upper(btrim(e.employee_no)) match_key,count(distinct e.id) match_count,
        case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
      from public.employees e where nullif(btrim(e.employee_no),'') is not null
      group by upper(btrim(e.employee_no))
    ), employee_name_keys as materialized (
      select public.exam_norm(e.full_name) match_key,count(distinct e.id) match_count,
        case when count(distinct e.id)=1 then min(e.id::text)::uuid end employee_id
      from public.employees e where nullif(public.exam_norm(e.full_name),'') is not null
      group by public.exam_norm(e.full_name)
    ), proposed as materialized (
      select r.id,
        case when idm.match_count=1 then idm.employee_id
          when coalesce(idm.match_count,0)=0 and namem.match_count=1 then namem.employee_id end employee_id,
        case when idm.match_count=1 then 'matched'
          when coalesce(idm.match_count,0)>1 then 'ambiguous'
          when namem.match_count=1 then 'matched'
          when coalesce(namem.match_count,0)>1 then 'ambiguous' else 'unmatched' end match_status,
        case when idm.match_count=1 then 'employee_id_exact'
          when coalesce(idm.match_count,0)=0 and namem.match_count=1 then 'name_unique_exact' end match_method
      from public.employee_attendance_records r
      join public.attendance_sheet_sync_changes c
        on c.run_id = v_run_id
        and c.operation in ('insert', 'update')
        and c.source_id = r.source_id
        and c.source_block = r.source_block
        and c.source_row = r.source_row
        and c.source_item_key = r.source_item_key
      left join employee_id_keys idm on idm.match_key=upper(btrim(r.employee_no_raw))
      left join employee_name_keys namem
        on coalesce(idm.match_count,0)=0 and namem.match_key=public.exam_norm(r.employee_name_raw)
      where r.source_id=v_source_id
    )
    update public.employee_attendance_records r
    set employee_id=p.employee_id,match_status=p.match_status,match_method=p.match_method,
      matched_at=case when p.match_status='matched' then now() end,
      updated_at=case when (r.employee_id,r.match_status,r.match_method) is distinct from
        (p.employee_id,p.match_status,p.match_method) then now() else r.updated_at end
    from proposed p
    where p.id=r.id and (r.employee_id,r.match_status,r.match_method) is distinct from
      (p.employee_id,p.match_status,p.match_method);

    select count(*),count(*) filter(where not r.is_mirror),count(*) filter(where r.is_mirror),
      count(*) filter(where not r.is_mirror and r.match_status='matched'),
      count(*) filter(where not r.is_mirror and r.match_status='unmatched'),
      count(*) filter(where not r.is_mirror and r.match_status='ambiguous')
    into v_raw,v_canonical,v_mirrors,v_matched,v_unmatched,v_ambiguous
    from public.employee_attendance_records r where r.source_id=v_source_id;

    update public.attendance_sheet_sync_changes c
    set record_id=r.id,after_record=to_jsonb(r)
    from public.employee_attendance_records r
    where c.run_id=v_run_id and c.operation in ('insert','update')
      and r.source_id=c.source_id and r.source_block=c.source_block
      and r.source_row=c.source_row and r.source_item_key=c.source_item_key;

    update public.attendance_sheet_sources s
    set status='success',row_count=v_canonical,matched_count=v_matched,
      unmatched_count=v_unmatched,ambiguous_count=v_ambiguous,skipped_count=v_mirrors,
      error_count=0,content_hash=v_snapshot_hash,synced_at=now(),error_message=null,
      metadata=s.metadata || jsonb_build_object(
        'raw_event_count',v_raw,'canonical_event_count',v_canonical,'mirror_count',v_mirrors,
        'live_sync',jsonb_build_object(
          'enabled',true,'architecture','apps_script_debounced_month_push',
          'last_run_id',v_run_id,'last_request_id',v_request_id,
          'last_trigger_kind',v_trigger_kind,'last_snapshot_hash',v_snapshot_hash,
          'last_captured_at',v_captured_at,'last_completed_at',now()
        )
      ),updated_at=now()
    where s.id=v_source_id;

    v_result := jsonb_build_object(
      'ok',true,'request_id',v_request_id,'run_id',v_run_id,'source_key',v_source_key,
      'status','success','snapshot_hash',v_snapshot_hash,'read_rows',v_read_row_count,
      'raw_records',v_raw,'canonical_records',v_canonical,'mirror_records',v_mirrors,
      'inserted',v_inserted,'updated',v_updated,'deleted',v_deleted,'unchanged',v_unchanged,
      'matched',v_matched,'unmatched',v_unmatched,'ambiguous',v_ambiguous
    );

    update public.attendance_sheet_sync_runs
    set status='success',raw_record_count=v_raw,canonical_record_count=v_canonical,
      mirror_record_count=v_mirrors,inserted_count=v_inserted,updated_count=v_updated,
      deleted_count=v_deleted,unchanged_count=v_unchanged,matched_count=v_matched,
      unmatched_count=v_unmatched,ambiguous_count=v_ambiguous,result=v_result,completed_at=now()
    where id=v_run_id;

    delete from attendance_private.attendance_sheet_sync_stage where run_id=v_run_id;
    return v_result;
  exception when others then
    v_error := left(sqlerrm,2000);
    delete from attendance_private.attendance_sheet_sync_stage where run_id=v_run_id;
    v_result := jsonb_build_object(
      'ok',false,'request_id',v_request_id,'run_id',v_run_id,
      'source_key',v_source_key,'status','failed','error','ingest_failed'
    );
    update public.attendance_sheet_sync_runs
    set status='failed',error_message=v_error,result=v_result,completed_at=now()
    where id=v_run_id;
    update public.attendance_sheet_sources
    set status='failed',error_count=error_count+1,error_message=v_error,
      synced_at=now(),updated_at=now()
    where id=v_source_id;
    return v_result;
  end;
end;
$$;

create or replace function public.ingest_annual_attendance_snapshot(
  p_payload jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select attendance_private.ingest_annual_attendance_snapshot(p_payload);
$$;

revoke all on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  from public,anon,authenticated;
revoke all on function public.ingest_annual_attendance_snapshot(jsonb)
  from public,anon,authenticated;
grant usage on schema attendance_private to service_role;
grant execute on function attendance_private.ingest_annual_attendance_snapshot(jsonb)
  to service_role;
grant execute on function public.ingest_annual_attendance_snapshot(jsonb)
  to service_role;

comment on function public.ingest_annual_attendance_snapshot(jsonb) is
  'Service-role-only atomic ingest for 12 allowlisted Sep-Dec annual attendance/adjustment sources; unchanged hashes and unchanged rows are zero-write paths.';

notify pgrst,'reload schema';
