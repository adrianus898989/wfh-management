begin;

-- Sheet pushes are initiated by independent Apps Script triggers, so an
-- in-memory flag inside an Edge isolate cannot prevent concurrent database
-- ingests. This short-lived, service-role-only lease is the cross-isolate
-- admission control. Expiry is the recovery path if an Edge worker is killed.
create table if not exists attendance_private.sheet_sync_runtime_leases (
  job_name text primary key,
  holder uuid not null,
  acquired_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  constraint sheet_sync_runtime_leases_job_name_check check (
    job_name in (
      'adjustment-sheet-sync',
      'employee-master-sync',
      'attendance-sheet-sync',
      'schedule-sheet-sync'
    )
  ),
  constraint sheet_sync_runtime_leases_expiry_check check (expires_at > acquired_at)
);

alter table attendance_private.sheet_sync_runtime_leases enable row level security;
revoke all on table attendance_private.sheet_sync_runtime_leases
  from public, anon, authenticated, service_role;

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
    'schedule-sheet-sync'
  ) or p_holder is null then
    raise exception using errcode = '22023', message = 'invalid_sheet_sync_lease';
  end if;

  insert into attendance_private.sheet_sync_runtime_leases as lease (
    job_name,
    holder,
    acquired_at,
    expires_at
  ) values (
    v_job_name,
    p_holder,
    clock_timestamp(),
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
      'ok', true,
      'acquired', true,
      'job_name', v_job_name,
      'holder', v_holder,
      'expires_at', v_expires_at
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
    'ok', true,
    'acquired', false,
    'job_name', v_job_name,
    'retry_after_seconds', coalesce(v_retry_after, 1)
  );
end;
$$;

create or replace function public.release_sheet_sync_runtime_lease(
  p_job_name text,
  p_holder uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  if p_holder is null then
    raise exception using errcode = '22023', message = 'invalid_sheet_sync_lease';
  end if;

  delete from attendance_private.sheet_sync_runtime_leases lease
  where lease.job_name = lower(btrim(coalesce(p_job_name, '')))
    and lease.holder = p_holder;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('ok', true, 'released', v_deleted = 1);
end;
$$;

revoke all on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.release_sheet_sync_runtime_lease(text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  to service_role;
grant execute on function public.release_sheet_sync_runtime_lease(text, uuid)
  to service_role;

-- Bound database lock waits and total work below the Edge request budget. A
-- lock timeout is deliberately retryable; it must not queue behind an older
-- full-sheet ingest and amplify an outage.
alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set statement_timeout = '3s';
alter function public.claim_sheet_sync_runtime_lease(text, uuid, integer)
  set lock_timeout = '1s';
alter function public.release_sheet_sync_runtime_lease(text, uuid)
  set statement_timeout = '2s';
alter function public.release_sheet_sync_runtime_lease(text, uuid)
  set lock_timeout = '1s';

alter function public.claim_adjustment_sheet_outbox(uuid, integer, integer)
  set statement_timeout = '10s';
alter function public.claim_adjustment_sheet_outbox(uuid, integer, integer)
  set lock_timeout = '2s';
alter function public.ack_adjustment_sheet_outbox(uuid, jsonb)
  set statement_timeout = '10s';
alter function public.ack_adjustment_sheet_outbox(uuid, jsonb)
  set lock_timeout = '2s';
alter function public.ingest_adjustment_sheet_inbound(jsonb)
  set statement_timeout = '12s';
alter function public.ingest_adjustment_sheet_inbound(jsonb)
  set lock_timeout = '2s';

alter function public.ingest_employee_master_snapshot(jsonb)
  set statement_timeout = '40s';
alter function public.ingest_employee_master_snapshot(jsonb)
  set lock_timeout = '2s';
alter function public.ingest_august_attendance_snapshot(jsonb)
  set statement_timeout = '40s';
alter function public.ingest_august_attendance_snapshot(jsonb)
  set lock_timeout = '2s';
alter function public.ingest_annual_attendance_snapshot(jsonb)
  set statement_timeout = '40s';
alter function public.ingest_annual_attendance_snapshot(jsonb)
  set lock_timeout = '2s';
alter function public.ingest_schedule_roster_snapshot(jsonb)
  set statement_timeout = '40s';
alter function public.ingest_schedule_roster_snapshot(jsonb)
  set lock_timeout = '2s';

comment on table attendance_private.sheet_sync_runtime_leases is
  'Cross-isolate TTL leases that prevent concurrent private sheet ingests from overloading Postgres.';
comment on function public.claim_sheet_sync_runtime_lease(text, uuid, integer) is
  'Service-role-only, fail-fast admission control for private sheet sync Edge functions.';

notify pgrst, 'reload schema';

commit;
