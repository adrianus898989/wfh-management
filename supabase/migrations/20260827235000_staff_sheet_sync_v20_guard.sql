begin;

-- staff-sheet-sync v20 is the sole writer for the legacy onsite-to-home tab.
-- Current/schedule are owned by employee-master-sync and bank is owned by
-- staff-full-reconcile v2, so those routes never reach this lease or RPC.
alter table attendance_private.sheet_sync_runtime_leases
  drop constraint if exists sheet_sync_runtime_leases_job_name_check;
alter table attendance_private.sheet_sync_runtime_leases
  add constraint sheet_sync_runtime_leases_job_name_check check (
    job_name in (
      'adjustment-sheet-sync',
      'employee-master-sync',
      'attendance-sheet-sync',
      'schedule-sheet-sync',
      'staff-sheet-sync'
    )
  );

create or replace function public.claim_sheet_sync_runtime_lease(
  p_job_name text,
  p_holder uuid,
  p_ttl_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_name text := lower(btrim(coalesce(p_job_name, '')));
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds, 90), 10), 300);
  v_holder uuid;
  v_expires_at timestamptz;
  v_retry_after integer := 1;
begin
  if v_job_name not in (
    'adjustment-sheet-sync',
    'employee-master-sync',
    'attendance-sheet-sync',
    'schedule-sheet-sync',
    'staff-sheet-sync'
  ) or p_holder is null then
    raise exception using errcode = '22023', message = 'invalid_sheet_sync_lease';
  end if;

  insert into attendance_private.sheet_sync_runtime_leases as lease (
    job_name, holder, acquired_at, expires_at
  ) values (
    v_job_name, p_holder, clock_timestamp(),
    clock_timestamp() + make_interval(secs => v_ttl)
  )
  on conflict (job_name) do update
  set holder = excluded.holder,
      acquired_at = excluded.acquired_at,
      expires_at = excluded.expires_at
  where lease.expires_at <= clock_timestamp()
     or lease.holder = excluded.holder
  returning holder, expires_at into v_holder, v_expires_at;

  if found then
    return jsonb_build_object(
      'ok', true, 'acquired', true, 'job_name', v_job_name,
      'holder', v_holder, 'expires_at', v_expires_at
    );
  end if;

  select greatest(
           1,
           ceil(extract(epoch from (lease.expires_at - clock_timestamp())))::integer
         )
  into v_retry_after
  from attendance_private.sheet_sync_runtime_leases lease
  where lease.job_name = v_job_name;

  return jsonb_build_object(
    'ok', true, 'acquired', false, 'job_name', v_job_name,
    'retry_after_seconds', coalesce(v_retry_after, 1)
  );
end;
$$;

revoke all on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  to service_role;

create table if not exists attendance_private.staff_sheet_sync_requests (
  request_id text primary key,
  payload_hash text not null,
  action text not null,
  state text not null,
  response jsonb,
  error_code text,
  attempt_count integer not null default 1,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint staff_sheet_sync_requests_request_id_check check (
    char_length(request_id) between 8 and 128
    and request_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint staff_sheet_sync_requests_payload_hash_check check (
    payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint staff_sheet_sync_requests_action_check check (
    action in ('sheet_row_changed', 'sheet_batch_sync')
  ),
  constraint staff_sheet_sync_requests_state_check check (
    state in ('processing', 'succeeded', 'failed')
  ),
  constraint staff_sheet_sync_requests_attempt_count_check check (
    attempt_count between 1 and 1000
  )
);

create index if not exists staff_sheet_sync_requests_updated_idx
  on attendance_private.staff_sheet_sync_requests (updated_at desc);

alter table attendance_private.staff_sheet_sync_requests enable row level security;
revoke all on table attendance_private.staff_sheet_sync_requests
  from public, anon, authenticated, service_role;

create or replace function attendance_private.staff_sync_employee_key(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(upper(btrim(coalesce(p_value, ''))), '[^A-Z0-9]', '', 'g');
$$;

create or replace function attendance_private.staff_sync_name_key(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g'));
$$;

create or replace function attendance_private.staff_sync_date(
  p_value text,
  p_field text
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := btrim(coalesce(p_value, ''));
  v_match text[];
begin
  if v_value = '' then return null; end if;
  v_match := regexp_match(v_value, '^(\d{4})-(\d{1,2})-(\d{1,2})');
  if v_match is null then
    v_match := regexp_match(v_value, '^(\d{4})年(\d{1,2})月(\d{1,2})日');
  end if;
  if v_match is null then
    raise exception using errcode = '22007',
      message = 'invalid_date_' || regexp_replace(lower(coalesce(p_field, 'value')), '[^a-z0-9_]', '', 'g');
  end if;
  begin
    return make_date(v_match[1]::integer, v_match[2]::integer, v_match[3]::integer);
  exception when others then
    raise exception using errcode = '22007',
      message = 'invalid_date_' || regexp_replace(lower(coalesce(p_field, 'value')), '[^a-z0-9_]', '', 'g');
  end;
end;
$$;

create or replace function attendance_private.staff_sync_number(
  p_value text,
  p_field text
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := replace(btrim(coalesce(p_value, '')), ',', '');
begin
  if v_value = '' then return null; end if;
  begin
    return v_value::numeric;
  exception when others then
    raise exception using errcode = '22P02',
      message = 'invalid_number_' || regexp_replace(lower(coalesce(p_field, 'value')), '[^a-z0-9_]', '', 'g');
  end;
end;
$$;

create or replace function attendance_private.staff_sync_shift(p_value text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw text := regexp_replace(btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g');
  v_compact text;
begin
  if v_raw = '' then return null; end if;
  v_compact := upper(regexp_replace(v_raw, '[[:space:]]+', '', 'g'));
  if v_compact in ('DAYSHIFT','DAYSHIFTT','早班DAY','白班DAY') then return '白班 Day'; end if;
  if v_compact in ('NIGHTSHIFT','NIGHSHIFT','NIGHTSHIFTT','晚班NIGHT','夜班NIGHT') then return '夜班 Night'; end if;
  if v_compact in ('MIDSHIFT','MIDSHFFT','中班MID') then return '中班 Mid'; end if;
  if v_compact ~ '中班MID11点' or v_compact ~ 'MID11:?00' then return '中班 MID 11:00'; end if;
  if v_compact ~ 'MID11:?30' then return '中班 MID 11:30'; end if;
  if v_compact ~ 'MID12:?00' then return '中班 MID 12:00'; end if;
  if v_compact ~ 'MID12:?30' then return '中班 MID 12:30'; end if;
  if v_compact ~ 'MID13:?00' then return '中班 MID 13:00'; end if;
  return v_raw;
end;
$$;

create or replace function attendance_private.staff_sync_position_id(p_name text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  v_key text;
  v_id uuid;
begin
  if v_name = '' then return null; end if;
  v_key := lower(v_name);
  if not pg_try_advisory_xact_lock(hashtextextended('staff-sync-position:' || v_key, 0)) then
    raise exception using errcode = '55P03', message = 'position_lock_busy';
  end if;
  select position.id into v_id
  from public.positions position
  where lower(btrim(position.name)) = v_key
  order by position.created_at, position.id
  limit 1;
  if v_id is null then
    insert into public.positions(name, status)
    values (v_name, 'active')
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function attendance_private.staff_sync_upsert_lifecycle(
  p_employee_id uuid,
  p_employee_no text,
  p_full_name text,
  p_event_type text,
  p_effective_date date,
  p_reason text,
  p_source_row integer,
  p_snapshot jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_winner uuid;
  v_source_key text;
begin
  if p_effective_date is null then return; end if;
  if p_event_type not in ('join', 'resign') then
    raise exception using errcode = '22023', message = 'invalid_lifecycle_event';
  end if;

  select event.id into v_winner
  from public.employee_lifecycle_events event
  where attendance_private.staff_sync_employee_key(event.employee_no) =
        attendance_private.staff_sync_employee_key(p_employee_no)
    and event.event_type = p_event_type
    and event.effective_date = p_effective_date
    and coalesce(event.note, '') <> '__VOIDED__'
  order by case event.source
      when 'backend' then 40
      when 'google_sheet_live' then 30
      when 'google_sheet_history' then 20
      else 10
    end desc,
    (event.employee_id is not null) desc,
    event.created_at desc,
    event.id
  limit 1
  for update;

  if v_winner is not null then
    update public.employee_lifecycle_events event
    set employee_id = coalesce(p_employee_id, event.employee_id),
        employee_no = upper(btrim(p_employee_no)),
        full_name = coalesce(nullif(btrim(p_full_name), ''), event.full_name),
        reason = coalesce(nullif(btrim(p_reason), ''), event.reason),
        source_sheet = '现场转居家',
        source_row = p_source_row,
        snapshot = coalesce(event.snapshot, '{}'::jsonb) || coalesce(p_snapshot, '{}'::jsonb)
    where event.id = v_winner;

    update public.employee_lifecycle_events event
    set note = '__VOIDED__'
    where attendance_private.staff_sync_employee_key(event.employee_no) =
          attendance_private.staff_sync_employee_key(p_employee_no)
      and event.event_type = p_event_type
      and event.effective_date = p_effective_date
      and coalesce(event.note, '') <> '__VOIDED__'
      and event.id <> v_winner;
    return;
  end if;

  v_source_key := 'lifecycle:' || upper(btrim(p_employee_no)) || ':' ||
    p_event_type || ':' || p_effective_date::text;
  insert into public.employee_lifecycle_events (
    employee_id, employee_no, full_name, event_type, effective_date,
    reason, note, source, source_sheet, source_row, source_key, snapshot
  ) values (
    p_employee_id, upper(btrim(p_employee_no)), nullif(btrim(p_full_name), ''),
    p_event_type, p_effective_date, nullif(btrim(p_reason), ''), null,
    'google_sheet_live', '现场转居家', p_source_row, v_source_key,
    coalesce(p_snapshot, '{}'::jsonb)
  )
  on conflict (source_key) do update
  set employee_id = coalesce(excluded.employee_id, employee_lifecycle_events.employee_id),
      employee_no = excluded.employee_no,
      full_name = coalesce(excluded.full_name, employee_lifecycle_events.full_name),
      reason = coalesce(excluded.reason, employee_lifecycle_events.reason),
      source_sheet = excluded.source_sheet,
      source_row = excluded.source_row,
      snapshot = coalesce(employee_lifecycle_events.snapshot, '{}'::jsonb) || excluded.snapshot;
end;
$$;

create or replace function attendance_private.ingest_staff_sheet_sync_v20(
  p_request_id text,
  p_payload_hash text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id text := btrim(coalesce(p_request_id, ''));
  v_payload_hash text := lower(btrim(coalesce(p_payload_hash, '')));
  v_action text := lower(btrim(coalesce(p_payload->>'action', '')));
  v_items jsonb := p_payload->'items';
  v_count integer;
  v_request attendance_private.staff_sheet_sync_requests%rowtype;
  v_response jsonb;
  v_results jsonb := '[]'::jsonb;
  v_item jsonb;
  v_row jsonb;
  v_audit jsonb;
  v_snapshot jsonb;
  v_row_number integer;
  v_no text;
  v_no_key text;
  v_full_name text;
  v_name_key text;
  v_country text;
  v_backend text;
  v_reason text;
  v_position_name text;
  v_raw_shift text;
  v_hire_date date;
  v_resign_date date;
  v_return_date date;
  v_home_date date;
  v_resigned boolean;
  v_position_id uuid;
  v_employee public.employees%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_row_matches integer;
  v_identity_changed boolean;
  v_name_changed boolean;
  v_existing_status text;
  v_audit_action text;
  v_error_state text;
  v_error_message text;
  v_safe_error text;
begin
  if char_length(v_request_id) not between 8 and 128
    or v_request_id !~ '^[A-Za-z0-9._:-]+$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_request_id');
  end if;
  if v_payload_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_payload_hash');
  end if;
  if v_action not in ('sheet_row_changed', 'sheet_batch_sync') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
  end if;

  insert into attendance_private.staff_sheet_sync_requests (
    request_id, payload_hash, action, state
  ) values (
    v_request_id, v_payload_hash, v_action, 'processing'
  ) on conflict (request_id) do nothing;

  select request.* into v_request
  from attendance_private.staff_sheet_sync_requests request
  where request.request_id = v_request_id
  for update;

  if v_request.payload_hash <> v_payload_hash then
    return jsonb_build_object(
      'ok', false, 'error', 'request_id_reuse_mismatch',
      'request_id', v_request_id
    );
  end if;
  if v_request.state = 'succeeded' then
    return coalesce(v_request.response, '{}'::jsonb) || jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'request_id', v_request_id
    );
  end if;

  update attendance_private.staff_sheet_sync_requests request
  set state = 'processing', response = null, error_code = null,
      attempt_count = case when request.state = 'processing'
        then request.attempt_count else least(request.attempt_count + 1, 1000) end,
      updated_at = clock_timestamp(), completed_at = null
  where request.request_id = v_request_id;

  begin
    if coalesce(p_payload->>'protocol_version', '') <> 'staff-sheet-sync-v20' then
      raise exception using errcode = '22023', message = 'invalid_protocol_version';
    end if;
    if v_items is null or jsonb_typeof(v_items) <> 'array' then
      raise exception using errcode = '22023', message = 'invalid_items';
    end if;
    v_count := jsonb_array_length(v_items);
    if v_count < 1 or v_count > 8 then
      raise exception using errcode = '22023', message = 'invalid_batch_size';
    end if;

    for v_item in select item.value from jsonb_array_elements(v_items) item(value)
    loop
      if coalesce(v_item->>'sheet_name', '') <> '现场转居家' then
        raise exception using errcode = '22023', message = 'source_not_supported';
      end if;
      if v_item->'row' is null or jsonb_typeof(v_item->'row') <> 'object' then
        raise exception using errcode = '22023', message = 'invalid_row';
      end if;
      v_row_number := case when coalesce(v_item->>'row_number', '') ~ '^\d+$'
        then (v_item->>'row_number')::integer else 0 end;
      if v_row_number < 1 or v_row_number > 1000000 then
        raise exception using errcode = '22023', message = 'invalid_row_number';
      end if;

      v_row := v_item->'row';
      v_audit := coalesce(v_item->'audit_context', '{}'::jsonb);
      v_no := upper(btrim(coalesce(v_row->>'ID', '')));
      v_no_key := attendance_private.staff_sync_employee_key(v_no);
      v_full_name := regexp_replace(btrim(coalesce(v_row->>'名字', '')), '[[:space:]]+', ' ', 'g');
      v_name_key := attendance_private.staff_sync_name_key(v_full_name);
      if v_no_key = '' or v_no in ('SYSTEM', 'ADMIN') then
        raise exception using errcode = '22023', message = 'invalid_employee_id';
      end if;
      if v_full_name = '' then
        raise exception using errcode = '22023', message = 'invalid_employee_name';
      end if;

      v_country := btrim(coalesce(v_row->>'员工国家', ''));
      v_backend := btrim(coalesce(v_row->>'后台账号', ''));
      v_reason := btrim(coalesce(v_row->>'离职原因', v_row->>'离职原因 Reason', ''));
      v_position_name := btrim(coalesce(v_row->>'岗位', ''));
      v_raw_shift := btrim(coalesce(v_row->>'班次', ''));
      v_hire_date := attendance_private.staff_sync_date(v_row->>'入职时间', 'hire_date');
      v_resign_date := attendance_private.staff_sync_date(v_row->>'离职时间', 'resign_date');
      v_return_date := attendance_private.staff_sync_date(v_row->>'回去时间', 'return_date');
      v_home_date := attendance_private.staff_sync_date(v_row->>'居家时间', 'home_date');
      v_resigned := v_resign_date is not null or v_backend = '辞职';

      v_snapshot := v_row - array[
        'USDT地址', 'WORKFOLIO邮箱', 'telegram 用户名', 'ZOOM邮箱',
        'Facebook', 'WhatsApp/或者手机号', '居家底薪工资', '绩效', '餐补'
      ]::text[];
      v_snapshot := v_snapshot || jsonb_build_object(
        'employment_type', '现场转居家',
        'operator_label', nullif(btrim(coalesce(v_audit->>'actor_label', '')), ''),
        'event_at', nullif(btrim(coalesce(v_audit->>'event_at', '')), '')
      );

      v_employee := null;
      select count(*)::integer into v_row_matches
      from public.employees employee
      where employee.source_sheet = '现场转居家'
        and employee.source_row = v_row_number
        and attendance_private.staff_sync_name_key(employee.full_name) = v_name_key;
      if v_row_matches > 1 then
        raise exception using errcode = 'P0001', message = 'source_row_identity_conflict';
      elsif v_row_matches = 1 then
        select employee.* into v_employee
        from public.employees employee
        where employee.source_sheet = '现场转居家'
          and employee.source_row = v_row_number
          and attendance_private.staff_sync_name_key(employee.full_name) = v_name_key
        for update;
      else
        select employee.* into v_employee
        from public.employees employee
        where attendance_private.staff_sync_employee_key(employee.employee_no) = v_no_key
        limit 1
        for update;
      end if;

      v_identity_changed := v_employee.id is null
        or attendance_private.staff_sync_employee_key(v_employee.employee_no) <> v_no_key;
      v_name_changed := v_employee.id is null
        or attendance_private.staff_sync_name_key(v_employee.full_name) <> v_name_key;

      if v_employee.id is not null then
        if exists (
          select 1 from public.employees employee
          where attendance_private.staff_sync_employee_key(employee.employee_no) = v_no_key
            and employee.id <> v_employee.id
        ) then
          raise exception using errcode = 'P0001', message = 'employee_id_conflict';
        end if;
        if v_name_changed
          and exists (
            select 1 from public.employees employee
            where attendance_private.staff_sync_name_key(employee.full_name) = v_name_key
              and employee.id <> v_employee.id
          ) then
          raise exception using errcode = 'P0001', message = 'employee_name_conflict';
        end if;
      else
        if exists (
          select 1 from public.employees employee
          where attendance_private.staff_sync_name_key(employee.full_name) = v_name_key
        ) then
          raise exception using errcode = 'P0001', message = 'employee_name_conflict';
        end if;
      end if;

      -- Normal updates of an existing employee must not be rejected by an old
      -- unlinked lifecycle row. Permanent ID history is consulted only for a
      -- genuinely new employee or an employee-number change.
      if v_identity_changed and exists (
        select 1 from public.employee_lifecycle_events event
        where attendance_private.staff_sync_employee_key(event.employee_no) = v_no_key
          and (
            (v_employee.id is null and (
              event.employee_id is not null
              or attendance_private.staff_sync_name_key(event.full_name) <> v_name_key
            ))
            or (v_employee.id is not null and event.employee_id is distinct from v_employee.id)
          )
      ) then
        raise exception using errcode = 'P0001', message = 'employee_id_history_conflict';
      end if;

      -- A historical name belonging to this same permanent employee or same
      -- employee number is allowed. Reuse by another identity is rejected.
      if v_name_changed and exists (
        select 1 from public.employee_lifecycle_events event
        where attendance_private.staff_sync_name_key(event.full_name) = v_name_key
          and attendance_private.staff_sync_employee_key(event.employee_no) <> v_no_key
          and (v_employee.id is null or event.employee_id is distinct from v_employee.id)
      ) then
        raise exception using errcode = 'P0001', message = 'employee_name_history_conflict';
      end if;

      -- Historical resigned rows that never became employees remain lifecycle
      -- history only. No live profile or account is manufactured for them.
      if v_employee.id is null and v_resigned then
        perform attendance_private.staff_sync_upsert_lifecycle(
          null, v_no, v_full_name, 'join', v_hire_date, null,
          v_row_number, v_snapshot
        );
        perform attendance_private.staff_sync_upsert_lifecycle(
          null, v_no, v_full_name, 'resign', v_resign_date, v_reason,
          v_row_number, v_snapshot
        );
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'ok', true, 'historical', true, 'employee_no', v_no,
          'row_number', v_row_number, 'status', 'resigned'
        ));
        continue;
      end if;

      v_position_id := attendance_private.staff_sync_position_id(v_position_name);
      v_before := case when v_employee.id is null then null else to_jsonb(v_employee) end;
      v_existing_status := coalesce(v_employee.status, '');

      if v_employee.id is null then
        insert into public.employees (
          employee_no, full_name, country, nationality, employment_type,
          position_id, status, market_country, platform_scope, shift_name,
          legacy_shift_name, last_location, hire_date, return_date, home_date,
          resign_date, backend_accounts, source_type, source_sheet, source_row,
          profile_status, updated_at
        ) values (
          v_no, v_full_name, nullif(v_country, ''), nullif(v_country, ''),
          '现场转居家', v_position_id, case when v_resigned then 'resigned' else 'active' end,
          nullif(btrim(coalesce(v_row->>'国家', '')), ''),
          nullif(btrim(coalesce(v_row->>'盘口', '')), ''),
          attendance_private.staff_sync_shift(v_raw_shift), nullif(v_raw_shift, ''),
          nullif(btrim(coalesce(v_row->>'最后的地点', '')), ''),
          v_hire_date, v_return_date, v_home_date, v_resign_date,
          case when v_resigned then '辞职' else nullif(v_backend, '') end,
          'google_sheet', '现场转居家', v_row_number, 'sheet_synced', clock_timestamp()
        ) returning * into v_employee;
      else
        update public.employees employee
        set employee_no = v_no,
            full_name = v_full_name,
            country = nullif(v_country, ''),
            nationality = nullif(v_country, ''),
            employment_type = '现场转居家',
            position_id = v_position_id,
            status = case when v_resigned then 'resigned' else 'active' end,
            market_country = nullif(btrim(coalesce(v_row->>'国家', '')), ''),
            platform_scope = nullif(btrim(coalesce(v_row->>'盘口', '')), ''),
            shift_name = attendance_private.staff_sync_shift(v_raw_shift),
            legacy_shift_name = nullif(v_raw_shift, ''),
            last_location = nullif(btrim(coalesce(v_row->>'最后的地点', '')), ''),
            hire_date = v_hire_date,
            return_date = v_return_date,
            home_date = v_home_date,
            resign_date = v_resign_date,
            backend_accounts = case when v_resigned then '辞职' else nullif(v_backend, '') end,
            source_type = case when employee.source_type = 'backend' then 'backend' else 'google_sheet' end,
            source_sheet = '现场转居家',
            source_row = v_row_number,
            profile_status = 'sheet_synced',
            updated_at = clock_timestamp()
        where employee.id = v_employee.id
        returning employee.* into v_employee;
      end if;

      v_after := to_jsonb(v_employee);
      update public.employee_lifecycle_events event
      set employee_no = v_no
      where event.employee_id = v_employee.id
        and attendance_private.staff_sync_employee_key(event.employee_no) <> v_no_key;

      insert into public.employee_contact_profiles (
        employee_id, work_email, telegram_username, zoom_email, facebook,
        whatsapp_phone, source_sheet, updated_at
      ) values (
        v_employee.id,
        nullif(btrim(coalesce(v_row->>'WORKFOLIO邮箱', '')), ''),
        nullif(btrim(coalesce(v_row->>'telegram 用户名', '')), ''),
        nullif(btrim(coalesce(v_row->>'ZOOM邮箱', '')), ''),
        nullif(btrim(coalesce(v_row->>'Facebook', '')), ''),
        nullif(btrim(coalesce(v_row->>'WhatsApp/或者手机号', '')), ''),
        '现场转居家', clock_timestamp()
      ) on conflict (employee_id) do update
      set work_email = excluded.work_email,
          telegram_username = excluded.telegram_username,
          zoom_email = excluded.zoom_email,
          facebook = excluded.facebook,
          whatsapp_phone = excluded.whatsapp_phone,
          source_sheet = excluded.source_sheet,
          updated_at = excluded.updated_at;

      insert into public.employee_compensation_settings (
        employee_id, base_salary, performance_default, meal_allowance,
        currency, effective_from, note, updated_at
      ) values (
        v_employee.id,
        attendance_private.staff_sync_number(v_row->>'居家底薪工资', 'base_salary'),
        attendance_private.staff_sync_number(v_row->>'绩效', 'performance'),
        attendance_private.staff_sync_number(v_row->>'餐补', 'meal_allowance'),
        'USD', v_home_date, 'Google Sheet 现场转居家同步', clock_timestamp()
      ) on conflict (employee_id) do update
      set base_salary = excluded.base_salary,
          performance_default = excluded.performance_default,
          meal_allowance = excluded.meal_allowance,
          currency = excluded.currency,
          effective_from = excluded.effective_from,
          note = excluded.note,
          updated_at = excluded.updated_at;

      insert into public.employee_payment_profiles (
        employee_id, payment_mode, payment_mode_source, transfer_using,
        usdt_address, source_sheet, updated_at
      ) values (
        v_employee.id, 'usdt', '现场转居家', 'USDT',
        nullif(btrim(coalesce(v_row->>'USDT地址', '')), ''),
        '现场转居家', clock_timestamp()
      ) on conflict (employee_id) do update
      set payment_mode = excluded.payment_mode,
          payment_mode_source = excluded.payment_mode_source,
          transfer_using = excluded.transfer_using,
          usdt_address = excluded.usdt_address,
          source_sheet = excluded.source_sheet,
          updated_at = excluded.updated_at;

      perform attendance_private.staff_sync_upsert_lifecycle(
        v_employee.id, v_no, v_full_name, 'join', v_hire_date, null,
        v_row_number, v_snapshot
      );
      if v_resigned then
        perform attendance_private.staff_sync_upsert_lifecycle(
          v_employee.id, v_no, v_full_name, 'resign', v_resign_date, v_reason,
          v_row_number, v_snapshot
        );
      end if;

      if coalesce((v_audit->>'audit')::boolean, false) then
        v_audit_action := case
          when v_before is null then 'google_employee_create'
          when v_before->>'employee_no' is distinct from v_after->>'employee_no' then 'google_employee_id_edit'
          when v_existing_status <> 'resigned' and v_employee.status = 'resigned' then 'resign'
          when v_existing_status = 'resigned' and v_employee.status <> 'resigned' then 'reactivate'
          else 'google_profile_sync'
        end;
        insert into public.employee_audit_logs (
          employee_id, employee_no, full_name, action, source,
          actor_username, changes, metadata, created_at
        ) values (
          v_employee.id, v_employee.employee_no, v_employee.full_name,
          v_audit_action, 'google_sheet',
          coalesce(
            nullif(btrim(v_audit->>'actor_label'), ''),
            nullif(btrim(v_audit->>'actor_email'), ''),
            'Google Sheet（未登记操作人）'
          ),
          jsonb_build_object(
            'before', case when v_before is null then null else jsonb_build_object(
              'employee_no', v_before->>'employee_no', 'full_name', v_before->>'full_name',
              'status', v_before->>'status', 'hire_date', v_before->>'hire_date',
              'resign_date', v_before->>'resign_date'
            ) end,
            'after', jsonb_build_object(
              'employee_no', v_after->>'employee_no', 'full_name', v_after->>'full_name',
              'status', v_after->>'status', 'hire_date', v_after->>'hire_date',
              'resign_date', v_after->>'resign_date'
            )
          ),
          jsonb_build_object(
            'source_sheet', '现场转居家', 'source_row', v_row_number,
            'editor_email', nullif(btrim(v_audit->>'actor_email'), ''),
            'editor_key', nullif(btrim(v_audit->>'actor_key'), ''),
            'event_at', nullif(btrim(v_audit->>'event_at'), ''),
            'trigger_kind', nullif(btrim(v_audit->>'trigger_kind'), '')
          ),
          coalesce(nullif(v_audit->>'event_at', '')::timestamptz, clock_timestamp())
        );
      end if;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'ok', true, 'employee_id', v_employee.id,
        'employee_no', v_employee.employee_no, 'status', v_employee.status,
        'row_number', v_row_number
      ));
    end loop;

    v_response := jsonb_build_object(
      'ok', true, 'request_id', v_request_id, 'count', v_count,
      'processed', jsonb_array_length(v_results), 'results', v_results
    );
  exception when others then
    get stacked diagnostics v_error_state = returned_sqlstate,
      v_error_message = message_text;
    if v_error_state in ('57014', '55P03', '40P01', '40001', '53300', '53400') then
      raise;
    end if;
    v_safe_error := case
      when v_error_message ~ '^(invalid_|source_not_supported$|employee_|source_row_identity_conflict$)'
        then v_error_message
      when v_error_state = '23505' then 'identity_conflict'
      else 'database_ingest_failed'
    end;
    v_response := jsonb_build_object(
      'ok', false, 'error', v_safe_error, 'request_id', v_request_id,
      'retryable', v_safe_error = 'database_ingest_failed'
    );
    update attendance_private.staff_sheet_sync_requests request
    set state = 'failed', response = v_response, error_code = v_safe_error,
        updated_at = clock_timestamp(), completed_at = clock_timestamp()
    where request.request_id = v_request_id;
    return v_response;
  end;

  update attendance_private.staff_sheet_sync_requests request
  set state = 'succeeded', response = v_response, error_code = null,
      updated_at = clock_timestamp(), completed_at = clock_timestamp()
  where request.request_id = v_request_id;
  return v_response;
end;
$$;

create or replace function public.ingest_staff_sheet_sync_v20(
  p_request_id text,
  p_payload_hash text,
  p_payload jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select attendance_private.ingest_staff_sheet_sync_v20(
    p_request_id, p_payload_hash, p_payload
  );
$$;

revoke all on function attendance_private.staff_sync_employee_key(text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_name_key(text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_date(text, text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_number(text, text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_shift(text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_position_id(text)
  from public, anon, authenticated, service_role;
revoke all on function attendance_private.staff_sync_upsert_lifecycle(
  uuid, text, text, text, date, text, integer, jsonb
) from public, anon, authenticated, service_role;
revoke all on function attendance_private.ingest_staff_sheet_sync_v20(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function attendance_private.ingest_staff_sheet_sync_v20(text, text, jsonb)
  to service_role;

revoke all on function public.ingest_staff_sheet_sync_v20(text, text, jsonb)
  from public, anon, authenticated;
grant usage on schema attendance_private to service_role;
grant execute on function public.ingest_staff_sheet_sync_v20(text, text, jsonb)
  to service_role;

alter function attendance_private.ingest_staff_sheet_sync_v20(text, text, jsonb)
  set statement_timeout = '15s';
alter function attendance_private.ingest_staff_sheet_sync_v20(text, text, jsonb)
  set lock_timeout = '750ms';
alter function public.ingest_staff_sheet_sync_v20(text, text, jsonb)
  set statement_timeout = '15s';
alter function public.ingest_staff_sheet_sync_v20(text, text, jsonb)
  set lock_timeout = '750ms';
-- CREATE OR REPLACE is followed by explicit reassertion so a future restore
-- cannot silently lose the fail-fast lease admission limits.
alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set statement_timeout = '3s';
alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set lock_timeout = '1s';

comment on table attendance_private.staff_sheet_sync_requests is
  'Payload-free idempotency ledger for transactional onsite-to-home staff sheet writes.';
comment on function public.ingest_staff_sheet_sync_v20(text, text, jsonb) is
  'Service-role-only transactional staff-sheet-sync v20 RPC; accepts at most eight onsite-to-home rows.';

notify pgrst, 'reload schema';

commit;
