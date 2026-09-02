begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
begin
  if to_regnamespace('payment_change_private') is null
     or to_regclass('public.payout_change_requests') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null
     or to_regclass('public.app_session_leases') is null
     or to_regclass('public.audit_logs') is null
     or to_regclass('public.admin_alert_events') is null
     or to_regclass('storage.objects') is null then
    raise exception 'payout_change_delete_dependency_missing';
  end if;
end
$guard$;

-- Hard deletion is intentionally a separate sensitive permission.  Existing
-- reviewers do not receive it automatically; Founder bypass remains in the
-- canonical authorization helper and other roles must be explicitly granted.
insert into public.permissions(code, name, category, sensitive)
values ('payroll.change_history.delete', '删除修改工资信息记录', 'payroll', true)
on conflict(code) do update set
  name = excluded.name,
  category = excluded.category,
  sensitive = excluded.sensitive;

-- Storage deletion and Postgres deletion cannot share one transaction.  This
-- private append-only ledger freezes the exact request identity and proof paths
-- in a short prepare transaction, then makes finalization safely retryable.
-- UUIDs intentionally have no foreign keys: the operation/audit must survive
-- later employee or Auth lifecycle changes.
create table if not exists payment_change_private.payout_change_delete_operation_events (
  operation_id uuid not null,
  event_type text not null,
  request_id uuid not null,
  actor_user_id uuid not null,
  actor_employee_id uuid,
  employee_id uuid not null,
  employee_no text not null,
  employee_name text not null,
  payment_kind text,
  request_status text not null,
  request_created_at timestamptz not null,
  request_updated_at timestamptz not null,
  proof_paths text[] not null default '{}'::text[],
  delete_reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (operation_id, event_type),
  constraint payout_change_delete_operation_event_type_check
    check (event_type in ('prepared', 'finalized', 'superseded')),
  constraint payout_change_delete_operation_reason_check
    check (char_length(btrim(delete_reason)) between 5 and 500),
  constraint payout_change_delete_operation_proof_count_check
    check (cardinality(proof_paths) between 0 and 2)
);

alter table payment_change_private.payout_change_delete_operation_events
  enable row level security;

drop index if exists payment_change_private.payout_change_delete_one_prepare_per_request_idx;
create index if not exists payout_change_delete_prepare_lookup_idx
  on payment_change_private.payout_change_delete_operation_events(request_id, created_at desc)
  where event_type = 'prepared';
create index if not exists payout_change_delete_request_event_idx
  on payment_change_private.payout_change_delete_operation_events(request_id, event_type, operation_id);
create index if not exists payout_change_delete_operation_actor_idx
  on payment_change_private.payout_change_delete_operation_events(actor_user_id, created_at desc);
create index if not exists payout_change_delete_operation_employee_idx
  on payment_change_private.payout_change_delete_operation_events(employee_id, created_at desc);

-- Close the Storage/Database race from the upload side.  Once deletion is
-- prepared, the owning staff account must not be able to recreate either
-- frozen object between the Storage API removal and finalization.  A finalized
-- operation is a durable tombstone for that request UUID.  Invalid paths and
-- lookup failures fail closed; unrelated new request UUIDs remain uploadable.
create or replace function public.payment_change_proof_upload_allowed(
  p_name text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_parts text[];
  v_request_id uuid;
begin
  if v_actor_user_id is null or nullif(btrim(p_name), '') is null then
    return false;
  end if;

  v_parts := string_to_array(p_name, '/');
  if cardinality(v_parts) <> 3
     or v_parts[1] <> v_actor_user_id::text
     or nullif(btrim(v_parts[3]), '') is null then
    return false;
  end if;

  begin
    v_request_id := v_parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  -- Use the identical transaction-scoped key/order as prepare/finalize.  An
  -- upload that began at the boundary waits for the deletion transaction and
  -- then observes its committed ledger state before the policy can allow it.
  perform pg_advisory_xact_lock(hashtextextended(
    'payout_change_request_delete:' || v_request_id::text,
    0
  ));

  return not exists (
    select 1
    from payment_change_private.payout_change_delete_operation_events event
    where event.request_id = v_request_id
      and (
        event.event_type = 'finalized'
        or (
          event.event_type = 'prepared'
          and not exists (
            select 1
            from payment_change_private.payout_change_delete_operation_events terminal
            where terminal.operation_id = event.operation_id
              and terminal.event_type in ('finalized', 'superseded')
          )
        )
      )
  );
exception when others then
  return false;
end;
$$;

revoke all on function public.payment_change_proof_upload_allowed(text)
  from public, anon, authenticated, service_role;
grant execute on function public.payment_change_proof_upload_allowed(text)
  to authenticated;

-- Preserve every existing staff-upload boundary and add the deletion ledger
-- guard as one extra fail-closed condition.
drop policy if exists payment_change_proof_insert on storage.objects;
create policy payment_change_proof_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'payment-change-proof'
  and split_part(name, '/', 1) = (select auth.uid())::text
  and public.payment_change_current_staff_session_is_valid()
  and public.payment_change_proof_upload_allowed(name)
);

comment on function public.payment_change_proof_upload_allowed(text) is
  'Fail-closed staff upload guard: validates caller-owned request paths and blocks active or finalized payout-change deletion UUIDs.';

create or replace function payment_change_private.reject_payout_change_delete_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'payout_change_delete_ledger_is_immutable';
end;
$$;

drop trigger if exists payout_change_delete_operation_events_immutable
  on payment_change_private.payout_change_delete_operation_events;
create trigger payout_change_delete_operation_events_immutable
before update or delete on payment_change_private.payout_change_delete_operation_events
for each row execute function payment_change_private.reject_payout_change_delete_event_mutation();

revoke all on table payment_change_private.payout_change_delete_operation_events
  from public, anon, authenticated, service_role;
revoke all on function payment_change_private.reject_payout_change_delete_event_mutation()
  from public, anon, authenticated, service_role;

create or replace function public.admin_prepare_payout_change_request_delete_v1(
  p_request_id uuid,
  p_reason text,
  p_confirmation text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_confirmation text := btrim(coalesce(p_confirmation, ''));
  v_actor_user_id uuid := auth.uid();
  v_actor_employee_id uuid;
  v_request public.payout_change_requests%rowtype;
  v_prepared_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_paths text[] := '{}'::text[];
  v_current_paths text[] := '{}'::text[];
  v_path text;
  v_operation_id uuid;
  v_prepared_actor uuid;
  v_prepared_payment_kind text;
  v_prepared_status text;
  v_prepared_created_at timestamptz;
  v_prepared_updated_at timestamptz;
  v_prepared_at timestamptz;
  v_finalized_at timestamptz;
begin
  if v_actor_user_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_payout_change_delete_identity';
  end if;
  if char_length(v_reason) < 5 or char_length(v_reason) > 500 then
    raise exception using errcode = '22023', message = 'invalid_payout_change_delete_reason';
  end if;

  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;

  select access.employee_id
  into v_actor_employee_id
  from public.user_access access
  join public.roles role on role.id = access.role_id and role.active = true
  where access.auth_user_id = v_actor_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;

  if not public.has_permission('payroll.change_history.view')
     or not public.has_permission('payroll.change_history.delete') then
    raise exception using errcode = '42501', message = 'payout_change_delete_permission_denied';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'payout_change_request_delete:' || p_request_id::text,
    0
  ));

  -- A response-loss retry after successful finalization returns the recorded
  -- result, but only to the same currently authorized operator and scope.
  select prepared.operation_id, prepared.employee_id,
         prepared.employee_no, prepared.employee_name, prepared.proof_paths,
         prepared.created_at, finalized.created_at
  into v_operation_id, v_prepared_employee_id,
       v_employee_no, v_employee_name, v_paths,
       v_prepared_at, v_finalized_at
  from payment_change_private.payout_change_delete_operation_events prepared
  join payment_change_private.payout_change_delete_operation_events finalized
    on finalized.operation_id = prepared.operation_id
   and finalized.event_type = 'finalized'
  where prepared.request_id = p_request_id
    and prepared.event_type = 'prepared'
    and prepared.actor_user_id = v_actor_user_id
    and prepared.delete_reason = v_reason
  order by finalized.created_at desc
  limit 1;
  if found then
    if v_confirmation <> ('DELETE ' || v_employee_no) then
      raise exception using errcode = '40001', message = 'payout_change_delete_confirmation_mismatch';
    end if;
    if not public.can_manage_employee(v_prepared_employee_id) then
      raise exception using errcode = '42501', message = 'payout_change_delete_scope_denied';
    end if;
    return jsonb_build_object(
      'operation_id', v_operation_id,
      'request_id', p_request_id,
      'employee_id', v_prepared_employee_id,
      'employee_no', v_employee_no,
      'employee_name', v_employee_name,
      'proof_paths', '[]'::jsonb,
      'proof_file_count', cardinality(v_paths),
      'prepared_at', v_prepared_at,
      'already_deleted', true,
      'finalized_at', v_finalized_at
    );
  end if;

  select prepared.operation_id, prepared.actor_user_id, prepared.employee_id,
         prepared.employee_no, prepared.employee_name, prepared.proof_paths,
         prepared.payment_kind, prepared.request_status,
         prepared.request_created_at, prepared.request_updated_at,
         prepared.created_at
  into v_operation_id, v_prepared_actor, v_prepared_employee_id,
       v_employee_no, v_employee_name, v_paths,
       v_prepared_payment_kind, v_prepared_status,
       v_prepared_created_at, v_prepared_updated_at,
       v_prepared_at
  from payment_change_private.payout_change_delete_operation_events prepared
  where prepared.request_id = p_request_id
    and prepared.event_type = 'prepared'
    and not exists (
      select 1
      from payment_change_private.payout_change_delete_operation_events terminal
      where terminal.operation_id = prepared.operation_id
        and terminal.event_type in ('finalized', 'superseded')
    )
  order by prepared.created_at desc
  limit 1;

  if found then
    if v_prepared_actor <> v_actor_user_id
       and v_prepared_at > clock_timestamp() - interval '5 minutes' then
      raise exception using errcode = '55000', message = 'payout_change_delete_operation_in_progress';
    end if;
    if not public.can_manage_employee(v_prepared_employee_id) then
      raise exception using errcode = '42501', message = 'payout_change_delete_scope_denied';
    end if;

    if v_prepared_actor = v_actor_user_id
       and exists (
         select 1
         from payment_change_private.payout_change_delete_operation_events prepared
         where prepared.operation_id = v_operation_id
           and prepared.event_type = 'prepared'
           and prepared.delete_reason = v_reason
       ) then
      if v_confirmation <> ('DELETE ' || v_employee_no) then
        raise exception using errcode = '40001', message = 'payout_change_delete_confirmation_mismatch';
      end if;
      select request.*
      into v_request
      from public.payout_change_requests request
      where request.id = p_request_id
      for update;
      if not found then
        raise exception using errcode = '40001', message = 'payout_change_delete_record_changed';
      end if;
      select coalesce(array_agg(path order by path), '{}'::text[])
      into v_current_paths
      from (
        select distinct nullif(btrim(candidate.path), '') as path
        from unnest(array[
          v_request.identity_proof_path,
          v_request.payment_proof_path
        ]) candidate(path)
        where nullif(btrim(candidate.path), '') is not null
      ) current_paths;
      if v_request.employee_id <> v_prepared_employee_id
         or v_current_paths is distinct from v_paths
         or v_request.payment_kind is distinct from v_prepared_payment_kind
         or v_request.status is distinct from v_prepared_status
         or v_request.created_at is distinct from v_prepared_created_at
         or v_request.updated_at is distinct from v_prepared_updated_at then
        raise exception using errcode = '40001', message = 'payout_change_delete_record_changed';
      end if;

      return jsonb_build_object(
        'operation_id', v_operation_id,
        'request_id', p_request_id,
        'employee_id', v_prepared_employee_id,
        'employee_no', v_employee_no,
        'employee_name', v_employee_name,
        'proof_paths', to_jsonb(v_paths),
        'proof_file_count', cardinality(v_paths),
        'prepared_at', v_prepared_at,
        'already_deleted', false
      );
    end if;

    -- A lost browser/Edge response must not block the record forever.  After
    -- five minutes a newly authorized operator may supersede the abandoned
    -- prepare and start a fresh, independently confirmed operation.
    insert into payment_change_private.payout_change_delete_operation_events (
      operation_id, event_type, request_id,
      actor_user_id, actor_employee_id, employee_id,
      employee_no, employee_name, payment_kind, request_status,
      request_created_at, request_updated_at,
      proof_paths, delete_reason, created_at
    )
    select
      prepared.operation_id, 'superseded', prepared.request_id,
      prepared.actor_user_id, prepared.actor_employee_id, prepared.employee_id,
      prepared.employee_no, prepared.employee_name, prepared.payment_kind,
      prepared.request_status, prepared.request_created_at,
      prepared.request_updated_at,
      prepared.proof_paths, prepared.delete_reason, clock_timestamp()
    from payment_change_private.payout_change_delete_operation_events prepared
    where prepared.operation_id = v_operation_id
      and prepared.event_type = 'prepared';
  end if;

  select request.*
  into v_request
  from public.payout_change_requests request
  where request.id = p_request_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'payout_change_request_not_found';
  end if;

  select btrim(employee.employee_no), btrim(employee.full_name)
  into v_employee_no, v_employee_name
  from public.employees employee
  where employee.id = v_request.employee_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'payout_change_request_not_found';
  end if;

  if not public.can_manage_employee(v_request.employee_id) then
    raise exception using errcode = '42501', message = 'payout_change_delete_scope_denied';
  end if;

  if v_confirmation <> ('DELETE ' || v_employee_no) then
    raise exception using errcode = '40001', message = 'payout_change_delete_confirmation_mismatch';
  end if;

  if nullif(btrim(v_request.identity_proof_path), '') is not null
     and nullif(btrim(v_request.payment_proof_path), '') is not null
     and btrim(v_request.identity_proof_path) = btrim(v_request.payment_proof_path) then
    raise exception using errcode = '55000', message = 'payout_change_proof_path_invalid';
  end if;

  select coalesce(array_agg(path order by path), '{}'::text[])
  into v_paths
  from (
    select distinct nullif(btrim(candidate.path), '') as path
    from unnest(array[
      v_request.identity_proof_path,
      v_request.payment_proof_path
    ]) candidate(path)
    where nullif(btrim(candidate.path), '') is not null
  ) paths;

  foreach v_path in array v_paths loop
    if v_path !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/'
      || p_request_id::text || '/[^/]+$'
    ) then
      raise exception using errcode = '55000', message = 'payout_change_proof_path_invalid';
    end if;
    if exists (
      select 1
      from public.payout_change_requests other_request
      where other_request.id <> p_request_id
        and (
          btrim(coalesce(other_request.identity_proof_path, '')) = v_path
          or btrim(coalesce(other_request.payment_proof_path, '')) = v_path
        )
    ) then
      raise exception using errcode = '55000', message = 'payout_change_proof_path_shared';
    end if;
  end loop;

  v_operation_id := gen_random_uuid();
  v_prepared_at := clock_timestamp();
  insert into payment_change_private.payout_change_delete_operation_events (
    operation_id, event_type, request_id,
    actor_user_id, actor_employee_id, employee_id,
    employee_no, employee_name, payment_kind, request_status,
    request_created_at, request_updated_at,
    proof_paths, delete_reason, created_at
  ) values (
    v_operation_id, 'prepared', p_request_id,
    v_actor_user_id, v_actor_employee_id, v_request.employee_id,
    v_employee_no, v_employee_name, v_request.payment_kind, v_request.status,
    v_request.created_at, v_request.updated_at,
    v_paths, v_reason, v_prepared_at
  );

  return jsonb_build_object(
    'operation_id', v_operation_id,
    'request_id', p_request_id,
    'employee_id', v_request.employee_id,
    'employee_no', v_employee_no,
    'employee_name', v_employee_name,
    'proof_paths', to_jsonb(v_paths),
    'proof_file_count', cardinality(v_paths),
    'prepared_at', v_prepared_at,
    'already_deleted', false
  );
end;
$$;

create or replace function public.admin_finalize_payout_change_request_delete_v1(
  p_operation_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '3000ms'
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_prepared payment_change_private.payout_change_delete_operation_events%rowtype;
  v_request public.payout_change_requests%rowtype;
  v_current_paths text[] := '{}'::text[];
  v_finalized_at timestamptz;
begin
  if v_actor_user_id is null or p_operation_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_payout_change_delete_finalize';
  end if;

  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;
  if not exists (
    select 1
    from public.user_access access
    join public.roles role on role.id = access.role_id and role.active = true
    where access.auth_user_id = v_actor_user_id
      and access.active = true
      and access.backend_enabled = true
  ) then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  if not public.has_permission('payroll.change_history.view')
     or not public.has_permission('payroll.change_history.delete') then
    raise exception using errcode = '42501', message = 'payout_change_delete_permission_denied';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'payout_change_request_delete:' || p_request_id::text,
    0
  ));

  select prepared.*
  into v_prepared
  from payment_change_private.payout_change_delete_operation_events prepared
  where prepared.operation_id = p_operation_id
    and prepared.event_type = 'prepared'
    and prepared.request_id = p_request_id
    and prepared.actor_user_id = v_actor_user_id
    and not exists (
      select 1
      from payment_change_private.payout_change_delete_operation_events superseded
      where superseded.operation_id = prepared.operation_id
        and superseded.event_type = 'superseded'
    )
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'payout_change_delete_operation_not_found';
  end if;
  if not public.can_manage_employee(v_prepared.employee_id) then
    raise exception using errcode = '42501', message = 'payout_change_delete_scope_denied';
  end if;

  select finalized.created_at
  into v_finalized_at
  from payment_change_private.payout_change_delete_operation_events finalized
  where finalized.operation_id = p_operation_id
    and finalized.event_type = 'finalized';
  if found then
    return jsonb_build_object(
      'operation_id', p_operation_id,
      'request_id', p_request_id,
      'employee_id', v_prepared.employee_id,
      'employee_no', v_prepared.employee_no,
      'employee_name', v_prepared.employee_name,
      'proof_file_count', cardinality(v_prepared.proof_paths),
      'already_deleted', true,
      'finalized_at', v_finalized_at
    );
  end if;

  -- Storage is read here only as a verification gate.  Objects are always
  -- removed through the Storage API by the Edge function; SQL never mutates
  -- the storage schema.  A partial/failed batch therefore remains retryable.
  if exists (
    select 1
    from storage.objects stored
    where stored.bucket_id = 'payment-change-proof'
      and stored.name = any(v_prepared.proof_paths)
  ) then
    raise exception using errcode = '55000', message = 'payout_change_proof_cleanup_incomplete';
  end if;

  select request.*
  into v_request
  from public.payout_change_requests request
  where request.id = p_request_id
  for update;
  if not found then
    raise exception using errcode = '40001', message = 'payout_change_delete_record_changed';
  end if;

  select coalesce(array_agg(path order by path), '{}'::text[])
  into v_current_paths
  from (
    select distinct nullif(btrim(candidate.path), '') as path
    from unnest(array[
      v_request.identity_proof_path,
      v_request.payment_proof_path
    ]) candidate(path)
    where nullif(btrim(candidate.path), '') is not null
  ) paths;

  if v_request.employee_id <> v_prepared.employee_id
     or v_current_paths is distinct from v_prepared.proof_paths
     or v_request.payment_kind is distinct from v_prepared.payment_kind
     or v_request.status is distinct from v_prepared.request_status
     or v_request.created_at is distinct from v_prepared.request_created_at
     or v_request.updated_at is distinct from v_prepared.request_updated_at then
    raise exception using errcode = '40001', message = 'payout_change_delete_record_changed';
  end if;

  delete from public.payout_change_requests request
  where request.id = p_request_id
    and request.employee_id = v_prepared.employee_id;
  if not found then
    raise exception using errcode = '40001', message = 'payout_change_delete_record_changed';
  end if;

  v_finalized_at := clock_timestamp();

  -- Preserve every historical alert event, including already-resolved ones,
  -- while making it explicit that its source request was intentionally deleted.
  update public.admin_alert_events event
  set is_active = false,
      last_seen_at = v_finalized_at,
      resolved_at = coalesce(event.resolved_at, v_finalized_at),
      payload = coalesce(event.payload, '{}'::jsonb) || jsonb_build_object(
        'request_status', 'deleted',
        'deleted_at', v_finalized_at
      )
  where event.condition_key = 'payout_change:' || p_request_id::text;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id,
    old_data, new_data, reason
  ) values (
    v_actor_user_id,
    v_prepared.employee_id,
    'payroll',
    'delete_payout_change_request',
    p_request_id::text,
    jsonb_build_object(
      'request_id', p_request_id,
      'employee_no', v_prepared.employee_no,
      'employee_name', v_prepared.employee_name,
      'payment_kind', v_prepared.payment_kind,
      'request_status', v_prepared.request_status,
      'request_created_at', v_prepared.request_created_at,
      'proof_file_count', cardinality(v_prepared.proof_paths)
    ),
    jsonb_build_object(
      'deleted', true,
      'proof_storage_cleanup', 'completed',
      'employee_profile_retained', true,
      'payroll_data_retained', true,
      'operation_id', p_operation_id
    ),
    v_prepared.delete_reason
  );

  insert into payment_change_private.payout_change_delete_operation_events (
    operation_id, event_type, request_id,
    actor_user_id, actor_employee_id, employee_id,
    employee_no, employee_name, payment_kind, request_status,
    request_created_at, request_updated_at,
    proof_paths, delete_reason, created_at
  ) values (
    p_operation_id, 'finalized', p_request_id,
    v_prepared.actor_user_id, v_prepared.actor_employee_id, v_prepared.employee_id,
    v_prepared.employee_no, v_prepared.employee_name,
    v_prepared.payment_kind, v_prepared.request_status,
    v_prepared.request_created_at, v_prepared.request_updated_at,
    v_prepared.proof_paths,
    v_prepared.delete_reason, v_finalized_at
  );

  return jsonb_build_object(
    'operation_id', p_operation_id,
    'request_id', p_request_id,
    'employee_id', v_prepared.employee_id,
    'employee_no', v_prepared.employee_no,
    'employee_name', v_prepared.employee_name,
    'proof_file_count', cardinality(v_prepared.proof_paths),
    'already_deleted', false,
    'finalized_at', v_finalized_at
  );
end;
$$;

revoke all on function public.admin_prepare_payout_change_request_delete_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_prepare_payout_change_request_delete_v1(uuid, text, text)
  to authenticated;
revoke all on function public.admin_finalize_payout_change_request_delete_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_finalize_payout_change_request_delete_v1(uuid, uuid)
  to authenticated;

comment on table payment_change_private.payout_change_delete_operation_events is
  'Append-only two-phase ledger for authorized payout-change record deletion across private Storage and Postgres.';
comment on function public.admin_prepare_payout_change_request_delete_v1(uuid, text, text) is
  'Authenticated prepare: verifies current admin session, separate view/delete permissions, canonical employee scope, typed confirmation and exact unshared proof paths.';
comment on function public.admin_finalize_payout_change_request_delete_v1(uuid, uuid) is
  'Authenticated retry-safe finalizer: rechecks current session, canonical permission/scope and Storage absence, then atomically deletes the request, preserves alert history and writes a non-sensitive audit.';

-- Keep the old comprehensive search RPC for compatibility.  The new reader
-- gives each compact UI field one corresponding server-side filter so results
-- and pagination remain exact rather than being filtered in the browser.
create or replace function public.admin_payout_change_requests_v2(
  p_status text default null,
  p_employee_no text default null,
  p_employee_name text default null,
  p_team text default null,
  p_position text default null,
  p_reason text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_employee_no text := lower(btrim(coalesce(p_employee_no, '')));
  v_employee_name text := lower(btrim(coalesce(p_employee_name, '')));
  v_team text := lower(btrim(coalesce(p_team, '')));
  v_position text := lower(btrim(coalesce(p_position, '')));
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  v_total bigint;
  v_rows jsonb;
  v_auto_apply_enabled boolean := false;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('payroll.change_history.view')
    or public.has_permission('payroll.change_history.review')
  ) then raise exception 'permission_denied'; end if;
  if v_status <> '' and v_status not in ('pending', 'approved', 'rejected', 'cancelled') then
    raise exception 'invalid_status';
  end if;

  select coalesce(setting.auto_apply_enabled, false)
  into v_auto_apply_enabled
  from payment_change_private.workflow_settings setting
  where setting.singleton;

  select count(*)
  into v_total
  from public.payout_change_requests request
  join public.employees employee on employee.id = request.employee_id
  left join public.teams team on team.id = employee.team_id
  left join public.positions position on position.id = employee.position_id
  where (v_status = '' or request.status = v_status)
    and public.can_manage_employee(request.employee_id)
    and (v_employee_no = '' or lower(coalesce(employee.employee_no, '')) like '%' || v_employee_no || '%')
    and (v_employee_name = '' or lower(coalesce(employee.full_name, '')) like '%' || v_employee_name || '%')
    and (v_team = '' or lower(coalesce(team.name, '')) like '%' || v_team || '%')
    and (v_position = '' or lower(coalesce(position.name, '')) like '%' || v_position || '%')
    and (v_reason = '' or lower(coalesce(request.reason, '')) like '%' || v_reason || '%');

  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.created_at desc), '[]'::jsonb)
  into v_rows
  from (
    select
      request.id, request.employee_id, employee.employee_no,
      employee.hire_date as employee_hire_date,
      employee.full_name as employee_name, employee.employment_type,
      coalesce(nullif(btrim(employee.country), ''), nullif(btrim(employee.nationality), '')) as country,
      employee.status as employee_status, team.name as team_name, position.name as position_name,
      request.payment_kind, request.old_data, request.new_data, request.reason,
      request.identity_proof_path, request.payment_proof_path, request.status, request.review_note,
      request.created_at, request.reviewed_at, request.fulfillment_status, request.fulfilled_at,
      request.fulfillment_checked_at, request.auto_applied,
      case
        when strpos(btrim(coalesce(reviewer.login_username, '')), '@') = 0
          then nullif(btrim(reviewer.login_username), '')
        else null
      end as reviewed_by,
      coalesce(
        case
          when strpos(btrim(coalesce(manual_fulfillment.actor_username, '')), '@') = 0
            then nullif(btrim(manual_fulfillment.actor_username), '')
          else null
        end,
        case
          when strpos(btrim(coalesce(fulfiller.login_username, '')), '@') = 0
            then nullif(btrim(fulfiller.login_username), '')
          else null
        end
      ) as fulfilled_by,
      payment_change_private.profile_match_state(
        request.employee_id, request.payment_kind, request.old_data, request.new_data
      ) as current_match_state
    from public.payout_change_requests request
    join public.employees employee on employee.id = request.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    left join public.user_access reviewer on reviewer.auth_user_id = request.reviewed_by
    left join public.user_access fulfiller on fulfiller.auth_user_id = request.fulfilled_by
    left join lateral (
      select audit.actor_username
      from public.employee_audit_logs audit
      where audit.employee_id = request.employee_id
        and request.fulfilled_at is not null
        and audit.created_at between request.fulfilled_at - interval '1 day'
                                 and request.fulfilled_at + interval '1 day'
        and (
          (
            request.payment_kind = 'bank_wallet'
            and (
              audit.changes ? 'payment.transfer_using'
              or audit.changes ? 'payment.gcash_name'
              or audit.changes ? 'payment.gcash_account'
            )
            and (
              not (audit.changes ? 'payment.transfer_using')
              or btrim(coalesce(audit.changes->'payment.transfer_using'->>'after', ''))
                = btrim(coalesce(request.new_data->>'transfer_using', ''))
            )
            and (
              not (audit.changes ? 'payment.gcash_name')
              or btrim(coalesce(audit.changes->'payment.gcash_name'->>'after', ''))
                = btrim(coalesce(request.new_data->>'account_name', ''))
            )
            and (
              not (audit.changes ? 'payment.gcash_account')
              or btrim(coalesce(audit.changes->'payment.gcash_account'->>'after', ''))
                = btrim(coalesce(request.new_data->>'account_number', ''))
            )
          )
          or (
            request.payment_kind = 'usdt'
            and audit.changes ? 'payment.usdt_address'
            and btrim(coalesce(audit.changes->'payment.usdt_address'->>'after', ''))
              = btrim(coalesce(request.new_data->>'usdt_address', ''))
          )
        )
      order by abs(extract(epoch from (audit.created_at - request.fulfilled_at))), audit.id
      limit 1
    ) manual_fulfillment on true
    where (v_status = '' or request.status = v_status)
      and public.can_manage_employee(request.employee_id)
      and (v_employee_no = '' or lower(coalesce(employee.employee_no, '')) like '%' || v_employee_no || '%')
      and (v_employee_name = '' or lower(coalesce(employee.full_name, '')) like '%' || v_employee_name || '%')
      and (v_team = '' or lower(coalesce(team.name, '')) like '%' || v_team || '%')
      and (v_position = '' or lower(coalesce(position.name, '')) like '%' || v_position || '%')
      and (v_reason = '' or lower(coalesce(request.reason, '')) like '%' || v_reason || '%')
    order by request.created_at desc
    limit v_size offset (v_page - 1) * v_size
  ) row_data;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'pages', greatest(ceil(v_total::numeric / v_size)::integer, 1),
    'auto_apply_enabled', v_auto_apply_enabled,
    'fulfillment_mode', case when v_auto_apply_enabled then 'automatic' else 'manual' end
  );
end;
$$;

revoke all on function public.admin_payout_change_requests_v2(text, text, text, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_payout_change_requests_v2(text, text, text, text, text, text, integer, integer)
  to authenticated;

comment on function public.admin_payout_change_requests_v2(text, text, text, text, text, text, integer, integer) is
  'Employee-scoped payout-change history with independent employee ID, name, team, position and reason filters; applicant secrets remain excluded.';

notify pgrst, 'reload schema';

commit;
