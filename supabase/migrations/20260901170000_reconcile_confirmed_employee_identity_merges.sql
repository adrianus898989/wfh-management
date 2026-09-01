begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Phase A is intentionally limited to idempotent schema, function and trigger
-- hardening.  It commits immediately after installing the guards so
-- AccessExclusive trigger-DDL locks are never held during the longer employee
-- data reconciliation.  The ordered phase-B migration takes both employee-
-- master advisory locks and performs the data movement in a separate
-- transaction.

do $verify_reconciliation_prerequisites$
begin
  if to_regprocedure(
       'scope_private.rebuild_all_assigned_employee_scopes()'
     ) is null
     or to_regprocedure(
       'scope_private.request_all_assigned_employee_scope_rebuild()'
     ) is null
     or to_regprocedure(
       'public.sync_report_employee_directory_scope_inner_v1(jsonb)'
     ) is null
     or to_regprocedure(
       'session_private.rebuild_online_training_roster_relationships(jsonb)'
     ) is null then
    raise exception 'employee_identity_reconciliation_prerequisite_missing';
  end if;
end;
$verify_reconciliation_prerequisites$;

create table if not exists employee_private.employee_master_roster_overrides (
  employee_no text primary key,
  expected_name_key text not null,
  override_kind text not null check (
    override_kind in ('confirmed_onsite', 'managed_external')
  ),
  employment_type text not null,
  reason text not null,
  approved_by text not null,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (employee_no = public.employee_master_normalize_id(employee_no)),
  check (nullif(btrim(expected_name_key), '') is not null)
);

alter table employee_private.employee_master_roster_overrides
  enable row level security;
revoke all on table employee_private.employee_master_roster_overrides
  from public, anon, authenticated, service_role;

comment on table employee_private.employee_master_roster_overrides is
  'Exact-ID, exact-name approvals for managed schedule rows that are intentionally absent from the home employee roster.';

insert into employee_private.employee_master_roster_overrides (
  employee_no, expected_name_key, override_kind, employment_type,
  reason, approved_by, active, updated_at
)
values
  (
    'PH526083101', '面条', 'confirmed_onsite', '现场人员',
    'User confirmed this schedule-only newcomer is onsite staff.',
    'user-confirmed-2026-09-01', true, clock_timestamp()
  ),
  (
    '336225', '阿德', 'managed_external', '现场人员',
    'User confirmed this external person is inside the managed roster.',
    'user-confirmed-2026-09-01', true, clock_timestamp()
  )
on conflict (employee_no) do update
set expected_name_key = excluded.expected_name_key,
    override_kind = excluded.override_kind,
    employment_type = excluded.employment_type,
    reason = excluded.reason,
    approved_by = excluded.approved_by,
    active = excluded.active,
    updated_at = clock_timestamp();

-- This is deliberately byte-for-byte equivalent to the expression behind
-- public.employees_employee_no_normalized_unique_idx.  Alias reservation and
-- every ingress resolver must use the same identity domain; otherwise a value
-- such as JA-123 could bypass a retired JA123 alias while still representing
-- the same employee everywhere else in the application.
create or replace function employee_private.employee_identity_key(
  p_value text
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    upper(btrim(coalesce(p_value, ''))),
    '[^A-Z0-9]', '', 'g'
  );
$$;

revoke all on function employee_private.employee_identity_key(text)
  from public, anon, authenticated, service_role;

comment on function employee_private.employee_identity_key(text) is
  'Private employee identity key exactly matching the public employees normalized unique-index expression.';

create table if not exists employee_private.employee_identity_merge_ledger (
  migration_key text primary key,
  source_employee_id uuid not null,
  target_employee_id uuid not null
    references public.employees(id) on delete restrict,
  previous_employee_no text not null,
  official_employee_no text not null,
  full_name text not null,
  previous_employee_snapshot jsonb not null,
  moved_reference_counts jsonb not null default '{}'::jsonb,
  reason text not null,
  approved_by text not null,
  merged_at timestamptz not null default clock_timestamp(),
  check (
    previous_employee_no =
      public.employee_master_normalize_id(previous_employee_no)
  ),
  check (
    official_employee_no =
      public.employee_master_normalize_id(official_employee_no)
  ),
  check (source_employee_id <> target_employee_id),
  unique (previous_employee_no),
  unique (official_employee_no)
);

alter table employee_private.employee_identity_merge_ledger
  enable row level security;
revoke all on table employee_private.employee_identity_merge_ledger
  from public, anon, authenticated, service_role;

comment on table employee_private.employee_identity_merge_ledger is
  'Private recovery ledger for confirmed same-person employee-ID merges. Historical rows move to the canonical UUID before the duplicate source row is removed.';

create unique index if not exists
  employee_identity_merge_ledger_previous_identity_key_uidx
on employee_private.employee_identity_merge_ledger (
  employee_private.employee_identity_key(previous_employee_no)
)
where employee_private.employee_identity_key(previous_employee_no) <> '';

create unique index if not exists
  employee_identity_merge_ledger_official_identity_key_uidx
on employee_private.employee_identity_merge_ledger (
  employee_private.employee_identity_key(official_employee_no)
)
where employee_private.employee_identity_key(official_employee_no) <> '';

-- Phase B uses persistent private work tables instead of CREATE TEMP TABLE.
-- Supabase DDL event triggers may inspect Auth relations for any DDL command,
-- including temporary-table DDL; keeping all table creation in this short
-- phase-A transaction lets the long reconciliation remain DML-only.  Both
-- employee-master advisory locks serialize the work tables, and phase B
-- deletes their rows before and after every run.
create table if not exists
  employee_private.employee_identity_reconcile_approved_schedule (
    employee_no text primary key,
    full_name text,
    name_key text,
    responsible text,
    onsite_trainer text,
    online_leader text,
    online_trainer text,
    group_name text,
    team_name text,
    shift_name text,
    position_name text,
    platform_name text,
    work_content text,
    country_name text,
    source_row integer,
    employment_type text
  );

create table if not exists
  employee_private.employee_identity_reconcile_merge_plan (
    previous_employee_no text primary key,
    official_employee_no text not null unique,
    source_employee_id uuid,
    target_employee_id uuid,
    source_present boolean not null default false,
    source_kind text,
    source_row integer,
    moved_reference_counts jsonb not null default '{}'::jsonb
  );

create table if not exists
  employee_private.employee_identity_reconcile_target_schedule_fields (
    target_employee_id uuid primary key,
    official_employee_no text,
    team_name text,
    group_name text,
    shift_name text,
    country_name text,
    position_name text,
    platform_name text,
    work_content text,
    responsible text,
    onsite_trainer text,
    online_leader text,
    online_trainer text,
    source_row integer
  );

create table if not exists
  employee_private.employee_identity_reconcile_expected_fk (
    schema_name text not null,
    table_name text not null,
    column_name text not null,
    primary key (schema_name, table_name, column_name)
  );

create table if not exists
  employee_private.employee_identity_reconcile_expected_name_mismatch (
    employee_no text primary key,
    employee_name_key text not null,
    schedule_name_key text not null
  );

create table if not exists
  employee_private.employee_identity_reconcile_actual_name_mismatch (
    employee_no text primary key,
    employee_name_key text,
    schedule_name_key text,
    employee_name text,
    schedule_name text,
    schedule_source_row integer
  );

create table if not exists
  employee_private.employee_identity_reconcile_source_presence (
    employee_no text primary key,
    home_present boolean not null,
    schedule_present boolean not null,
    schedule_name_mismatch boolean not null
  );

create table if not exists
  employee_private.employee_identity_reconcile_cross_name_mismatch (
    employee_no text not null,
    home_source_row integer not null,
    schedule_source_row integer not null,
    home_name text,
    schedule_name text,
    primary key (employee_no, home_source_row, schedule_source_row)
  );

alter table
  employee_private.employee_identity_reconcile_approved_schedule
  enable row level security;
alter table employee_private.employee_identity_reconcile_merge_plan
  enable row level security;
alter table
  employee_private.employee_identity_reconcile_target_schedule_fields
  enable row level security;
alter table employee_private.employee_identity_reconcile_expected_fk
  enable row level security;
alter table
  employee_private.employee_identity_reconcile_expected_name_mismatch
  enable row level security;
alter table
  employee_private.employee_identity_reconcile_actual_name_mismatch
  enable row level security;
alter table employee_private.employee_identity_reconcile_source_presence
  enable row level security;
alter table
  employee_private.employee_identity_reconcile_cross_name_mismatch
  enable row level security;

revoke all on table
  employee_private.employee_identity_reconcile_approved_schedule,
  employee_private.employee_identity_reconcile_merge_plan,
  employee_private.employee_identity_reconcile_target_schedule_fields,
  employee_private.employee_identity_reconcile_expected_fk,
  employee_private.employee_identity_reconcile_expected_name_mismatch,
  employee_private.employee_identity_reconcile_actual_name_mismatch,
  employee_private.employee_identity_reconcile_source_presence,
  employee_private.employee_identity_reconcile_cross_name_mismatch
  from public, anon, authenticated, service_role;

comment on table
  employee_private.employee_identity_reconcile_merge_plan is
  'Private serialized phase-B work state. Rows are removed before and after each reconciliation transaction.';

-- Resolve only an exact current employee number or an explicitly approved
-- historical alias.  Conflicting evidence returns NULL instead of guessing.
-- Keeping this helper private prevents the alias ledger from becoming an
-- employee-directory API while still letting trusted trigger functions reuse
-- one fail-closed rule.
create or replace function employee_private.resolve_confirmed_employee_id(
  p_employee_no text
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  with requested as (
    select nullif(
      employee_private.employee_identity_key(p_employee_no),
      ''
    ) employee_key
  ), candidates as (
    select employee.id employee_id
    from requested
    join public.employees employee
      on employee_private.employee_identity_key(employee.employee_no) =
        requested.employee_key
    where requested.employee_key is not null

    union all

    select ledger.target_employee_id
    from requested
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = requested.employee_key
    where requested.employee_key is not null
  )
  select case
    when count(distinct candidate.employee_id) = 1 then
      min(candidate.employee_id::text)::uuid
    else null::uuid
  end
  from candidates candidate;
$$;

revoke all on function
  employee_private.resolve_confirmed_employee_id(text)
  from public, anon, authenticated, service_role;

comment on function employee_private.resolve_confirmed_employee_id(text) is
  'Private fail-closed resolver for exact current employee numbers and explicitly approved historical aliases.';

-- Edge workers receive raw IDs from Google snapshots and must canonicalize
-- them before production presence/resignation reconciliation.  Expose only
-- the requested identities through a bounded service-role RPC; the ledger and
-- general directory remain private.  Conflicting evidence is returned with a
-- NULL canonical identity so callers can fail closed.
create or replace function public.resolve_employee_identity_batch(
  p_employee_nos text[]
)
returns table (
  raw_employee_no text,
  raw_identity_key text,
  employee_id uuid,
  canonical_employee_no text,
  confirmed_full_name text,
  is_confirmed_alias boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_employee_nos is null
     or cardinality(p_employee_nos) > 10000 then
    raise exception using
      errcode = '22023',
      message = 'invalid_employee_identity_batch';
  end if;

  return query
  select requested.raw_employee_no,
    employee_private.employee_identity_key(requested.raw_employee_no),
    resolved.employee_id,
    canonical.employee_no,
    case when ledger.target_employee_id is not null then
      ledger.full_name
    end,
    ledger.target_employee_id is not null
  from unnest(p_employee_nos) with ordinality
    requested(raw_employee_no, source_order)
  left join employee_private.employee_identity_merge_ledger ledger
    on employee_private.employee_identity_key(
         ledger.previous_employee_no
       ) = employee_private.employee_identity_key(
         requested.raw_employee_no
       )
  left join lateral (
    select employee_private.resolve_confirmed_employee_id(
      requested.raw_employee_no
    ) employee_id
  ) resolved on true
  left join public.employees canonical
    on canonical.id = resolved.employee_id
  order by requested.source_order;
end;
$$;

revoke all on function public.resolve_employee_identity_batch(text[])
  from public, anon, authenticated;
grant execute on function public.resolve_employee_identity_batch(text[])
  to service_role;

comment on function public.resolve_employee_identity_batch(text[]) is
  'Service-only bounded resolver for raw Google employee numbers. Returns current canonical employee numbers and immutable confirmed-alias names without exposing the private ledger.';

-- A raw ingest that bypasses the supported employee-master RPC must not be
-- able to recreate a second employee under an approved old number.  Supported
-- source ingestion canonicalizes the alias before it reaches this boundary;
-- every other direct INSERT/employee-number UPDATE fails closed.
create or replace function
  employee_private.enforce_employee_no_alias_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_key text := nullif(
    employee_private.employee_identity_key(new.employee_no),
    ''
  );
  v_canonical_employee_id uuid;
begin
  if v_employee_key is null then
    return new;
  end if;

  select ledger.target_employee_id
  into v_canonical_employee_id
  from employee_private.employee_identity_merge_ledger ledger
  where employee_private.employee_identity_key(
          ledger.previous_employee_no
        ) = v_employee_key;

  if v_canonical_employee_id is not null then
    raise exception using
      errcode = '23505',
      message = 'employee_number_reserved_as_confirmed_alias',
      detail = 'Use the canonical employee identity instead of recreating the approved historical employee number.';
  end if;

  return new;
end;
$$;

revoke all on function
  employee_private.enforce_employee_no_alias_reservation()
  from public, anon, authenticated, service_role;

comment on function
  employee_private.enforce_employee_no_alias_reservation() is
  'Fail-closed table boundary that prevents a confirmed historical employee number from being recreated as a new current employee.';

-- Raw resignation history may continue to arrive under an approved old ID.
-- Resolve that alias to the canonical UUID, but keep contradictory or unknown
-- non-empty IDs unmatched so they can never change a same-name employee.
create or replace function
  attendance_private.enforce_resignation_employee_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw_employee_no text;
  v_exact_employee_id uuid;
  v_before_identity record;
begin
  if new.source_block is distinct from 'resignation'
    and new.kind is distinct from 'resignation'
    and new.event_kind is distinct from 'resignation' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if exists (
      select 1
      from employee_private.employee_identity_merge_ledger ledger
      where ledger.source_employee_id = old.employee_id
        and ledger.target_employee_id = new.employee_id
    ) then
      new.match_status := 'matched';
      new.match_method := 'employee_id_exact';
      new.matched_at := coalesce(new.matched_at, clock_timestamp());
      return new;
    end if;
  end if;

  v_raw_employee_no := nullif(
    employee_private.employee_identity_key(new.employee_no_raw),
    ''
  );
  if v_raw_employee_no is null then
    return new;
  end if;

  v_exact_employee_id :=
    employee_private.resolve_confirmed_employee_id(v_raw_employee_no);

  if tg_op = 'UPDATE' then
    select old.employee_id, old.match_status, old.match_method, old.matched_at
    into v_before_identity;
  end if;

  if v_exact_employee_id is not null then
    new.employee_id := v_exact_employee_id;
    new.match_status := 'matched';
    -- The existing constraint intentionally keeps exact canonical and exact
    -- approved-alias matches in the same trusted category.
    new.match_method := 'employee_id_exact';
    new.matched_at := coalesce(new.matched_at, clock_timestamp());
  else
    new.employee_id := null;
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
  end if;

  if tg_op = 'UPDATE' and (
      v_before_identity.employee_id,
      v_before_identity.match_status,
      v_before_identity.match_method,
      v_before_identity.matched_at
    ) is distinct from (
      new.employee_id,
      new.match_status,
      new.match_method,
      new.matched_at
    ) then
    new.updated_at := clock_timestamp();
  end if;

  return new;
end;
$$;

revoke all on function
  attendance_private.enforce_resignation_employee_identity()
  from public, anon, authenticated, service_role;

comment on function
  attendance_private.enforce_resignation_employee_identity() is
  'For resignation rows, a non-empty raw employee number must resolve to the exact current employee or an approved historical alias; otherwise it remains unmatched.';

create or replace function
  attendance_private.enforce_confirmed_employee_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw_employee_no text := nullif(
    employee_private.employee_identity_key(new.employee_no_raw),
    ''
  );
  v_raw_name_key text := nullif(lower(regexp_replace(
    btrim(coalesce(new.employee_name_raw, '')),
    '[[:space:][:punct:]]+', '', 'g'
  )), '');
  v_alias_employee_id uuid;
  v_alias_source_employee_id uuid;
  v_alias_name_key text;
  v_resolved_employee_id uuid;
  v_before_identity record;
begin
  if v_raw_employee_no is null then
    return new;
  end if;

  select ledger.target_employee_id, ledger.source_employee_id,
    lower(regexp_replace(
      btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
    ))
  into v_alias_employee_id, v_alias_source_employee_id, v_alias_name_key
  from employee_private.employee_identity_merge_ledger ledger
  where employee_private.employee_identity_key(
          ledger.previous_employee_no
        ) = v_raw_employee_no;

  if v_alias_employee_id is null then
    return new;
  end if;

  -- The one-time merge moves foreign keys while the duplicate source row is
  -- still present.  Preserve this exact ledger-approved source -> target
  -- transition; all ordinary writes continue through the resolver/name gate.
  if tg_op = 'UPDATE'
     and old.employee_id = v_alias_source_employee_id
     and new.employee_id = v_alias_employee_id then
    new.match_status := 'matched';
    new.match_method := 'employee_id_exact';
    new.matched_at := coalesce(new.matched_at, clock_timestamp());
    return new;
  end if;

  v_resolved_employee_id :=
    employee_private.resolve_confirmed_employee_id(v_raw_employee_no);

  if tg_op = 'UPDATE' then
    select old.employee_id, old.match_status, old.match_method, old.matched_at
    into v_before_identity;
  end if;

  if v_resolved_employee_id = v_alias_employee_id
     and (
       v_raw_name_key is null
       or v_raw_name_key = v_alias_name_key
     ) then
    new.employee_id := v_alias_employee_id;
    new.match_status := 'matched';
    new.match_method := 'employee_id_exact';
    new.matched_at := coalesce(new.matched_at, clock_timestamp());
  else
    -- A live row has reused the old number or the ledger is inconsistent.
    -- Keep the attendance row visible but unresolved; never guess by name.
    new.employee_id := null;
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
  end if;

  if tg_op = 'UPDATE' and (
      v_before_identity.employee_id,
      v_before_identity.match_status,
      v_before_identity.match_method,
      v_before_identity.matched_at
    ) is distinct from (
      new.employee_id,
      new.match_status,
      new.match_method,
      new.matched_at
    ) then
    new.updated_at := clock_timestamp();
  end if;

  return new;
end;
$$;

revoke all on function
  attendance_private.enforce_confirmed_employee_alias()
  from public, anon, authenticated, service_role;

comment on function attendance_private.enforce_confirmed_employee_alias() is
  'Reattaches attendance rows carrying an approved historical employee number to the canonical UUID when an optional supplied name matches the immutable approved name, and fails closed on alias conflicts.';

-- The older payroll heuristic is allowed only for genuinely unknown legacy
-- numbers.  Once an alias is in the confirmed merge ledger, neither the
-- ordinary row classifier nor its audit trigger may create a second heuristic
-- alias record before the final payroll guard runs.
create or replace function
  payroll_private.resolve_legacy_employee_no_identity(
    p_old_employee_no text,
    p_full_name text,
    p_hire_date date
  )
returns table (
  employee_id uuid,
  employee_no text,
  employee_status text,
  employee_resign_date date,
  full_name_key text,
  match_source text
)
language sql
stable
security definer
set search_path = ''
as $$
  with name_candidates as (
    select
      employee.id,
      employee.employee_no,
      lower(btrim(employee.status::text)) employee_status,
      employee.resign_date,
      employee.hire_date,
      internal.payroll_name_key(employee.full_name) full_name_key,
      count(*) over () normalized_name_count
    from public.employees employee
    where internal.payroll_name_key(employee.full_name) =
          internal.payroll_name_key(p_full_name)
      and internal.payroll_name_key(p_full_name) <> ''
  ), unique_candidate as (
    select candidate.*
    from name_candidates candidate
    where candidate.normalized_name_count = 1
      and p_hire_date is not null
      and candidate.hire_date = p_hire_date
  )
  select
    candidate.id,
    candidate.employee_no,
    candidate.employee_status,
    candidate.resign_date,
    candidate.full_name_key,
    'legacy_old_id_unique_name_hire_date'::text
  from unique_candidate candidate
  where employee_private.employee_identity_key(p_old_employee_no) <> ''
    and not exists (
      select 1
      from employee_private.employee_identity_merge_ledger ledger
      where employee_private.employee_identity_key(
              ledger.previous_employee_no
            ) = employee_private.employee_identity_key(
              p_old_employee_no
            )
    )
    and not exists (
      select 1
      from public.employees assigned
      where employee_private.employee_identity_key(assigned.employee_no) =
        employee_private.employee_identity_key(p_old_employee_no)
    )
    and not exists (
      select 1
      from public.employee_lifecycle_events lifecycle
      where employee_private.employee_identity_key(lifecycle.employee_no) =
            employee_private.employee_identity_key(p_old_employee_no)
        and lifecycle.note is distinct from '__VOIDED__'
        and lifecycle.event_type in ('join', 'resign', 'reactivate')
        and lifecycle.employee_id is distinct from candidate.id
    )
    and not exists (
      select 1
      from payroll_private.employee_identity_aliases alias
      where alias.old_employee_no_key =
            employee_private.employee_identity_key(p_old_employee_no)
        and alias.employee_id is distinct from candidate.id
    );
$$;

revoke all on function
  payroll_private.resolve_legacy_employee_no_identity(text, text, date)
  from public, anon, authenticated, service_role;

do $patch_payroll_bulk_confirmed_alias_guard$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'payroll_private.admin_payroll_import(jsonb,jsonb)'::regprocedure
  );
  v_old text := $old$
    where row.employee_id is null and row.employee_key<>''
      and not exists(
        select 1 from public.employees assigned
$old$;
  v_new text := $new$
    where row.employee_id is null and row.employee_key<>''
      and not exists(
        select 1
        from employee_private.employee_identity_merge_ledger ledger
        where employee_private.employee_identity_key(
                ledger.previous_employee_no
              ) = row.employee_key
      )
      and not exists(
        select 1 from public.employees assigned
$new$;
begin
  if pg_catalog.strpos(v_definition, v_new) > 0 then
    return;
  end if;
  if (
       pg_catalog.length(v_definition)
       - pg_catalog.length(pg_catalog.replace(v_definition, v_old, ''))
     ) / pg_catalog.length(v_old) <> 1 then
    raise exception 'payroll_bulk_confirmed_alias_marker_changed';
  end if;
  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch_payroll_bulk_confirmed_alias_guard$;

revoke all on function payroll_private.admin_payroll_import(jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- Payroll has a set-based importer that intentionally skips its ordinary
-- per-row classifier.  This final table guard therefore covers both that bulk
-- path and ordinary writes.  The old raw number remains intact as evidence,
-- while only exact old-ID + normalized-name evidence can attach the canonical
-- employee UUID.
create or replace function payroll_private.enforce_confirmed_employee_alias()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw_employee_no text := nullif(
    employee_private.employee_identity_key(new.employee_no_raw),
    ''
  );
  v_raw_name_key text := nullif(
    nullif(lower(regexp_replace(
      btrim(coalesce(new.full_name, '')),
      '[[:space:][:punct:]]+', '', 'g'
    )), ''),
    '未填写姓名'
  );
  v_alias_employee_id uuid;
  v_alias_source_employee_id uuid;
  v_alias_name_key text;
  v_resolved_employee_id uuid;
begin
  if v_raw_employee_no is null then
    return new;
  end if;

  select ledger.target_employee_id, ledger.source_employee_id,
    lower(regexp_replace(
      btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
    ))
  into v_alias_employee_id, v_alias_source_employee_id, v_alias_name_key
  from employee_private.employee_identity_merge_ledger ledger
  where employee_private.employee_identity_key(
          ledger.previous_employee_no
        ) = v_raw_employee_no;

  if v_alias_employee_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.employee_id = v_alias_source_employee_id
     and new.employee_id = v_alias_employee_id then
    new.identity_match_state := 'employee';
    new.identity_match_source := 'confirmed_employee_id_alias';
    return new;
  end if;

  v_resolved_employee_id :=
    employee_private.resolve_confirmed_employee_id(v_raw_employee_no);

  if v_resolved_employee_id = v_alias_employee_id
     and (
       v_raw_name_key is null
       or v_raw_name_key = v_alias_name_key
     ) then
    new.employee_id := v_alias_employee_id;
    new.identity_match_state := 'employee';
    new.identity_match_source := 'confirmed_employee_id_alias';
  else
    new.employee_id := null;
    new.identity_match_state := 'unmatched';
    new.identity_match_source := 'confirmed_employee_id_alias_conflict';
  end if;

  return new;
end;
$$;

revoke all on function payroll_private.enforce_confirmed_employee_alias()
  from public, anon, authenticated, service_role;

comment on function payroll_private.enforce_confirmed_employee_alias() is
  'Final fail-closed payroll identity guard for confirmed old employee numbers; an optional supplied name must equal the immutable approved normalized name before the canonical UUID is attached.';

create or replace function attendance_private.current_employee_resignations()
returns table (
  employee_id uuid,
  resign_date date,
  source_record_ids uuid[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    record.employee_id,
    min(record.event_date) as resign_date,
    array_agg(record.id order by record.event_date, record.id)
      as source_record_ids
  from public.employee_attendance_records record
  join public.attendance_sheet_sources source
    on source.id = record.source_id
   and source.is_active = true
  join public.employees employee
    on employee.id = record.employee_id
  where record.match_status = 'matched'
    and record.employee_id is not null
    and record.source_block = 'resignation'
    and record.kind = 'resignation'
    and record.event_kind = 'resignation'
    and record.is_mirror = false
    and record.event_date is not null
    and record.event_date <= current_date
    and (
      nullif(
        public.employee_master_normalize_id(record.employee_no_raw),
        ''
      ) is null
      or (
        record.match_method = 'employee_id_exact'
        and employee_private.resolve_confirmed_employee_id(
          record.employee_no_raw
        ) = record.employee_id
      )
    )
    and (employee.hire_date is null or record.event_date >= employee.hire_date)
    and (
      employee.return_date is null
      or record.event_date >= employee.return_date
    )
    and not exists (
      select 1
      from public.employee_lifecycle_events reactivate
      where reactivate.employee_id = record.employee_id
        and reactivate.event_type = 'reactivate'
        and reactivate.note is distinct from '__VOIDED__'
        and reactivate.effective_date > record.event_date
    )
  group by record.employee_id;
$$;

revoke all on function attendance_private.current_employee_resignations()
  from public, anon, authenticated, service_role;

comment on function attendance_private.current_employee_resignations() is
  'Canonical current-cycle resignations. A supplied raw number must resolve to the linked employee through an exact current ID or approved historical alias.';

-- Legacy exam imports use the same approved alias rule.  A conflicting alias
-- and live employee remains ambiguous; name fallback behavior is unchanged for
-- genuinely unknown historical rows.
create or replace function public.legacy_exam_match_employee_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_count integer := 0;
  v_current_employee_id uuid;
  v_alias_count integer := 0;
  v_alias_employee_id uuid;
  v_alias_expected_name_key text;
  v_raw_name_key text := nullif(lower(regexp_replace(
    btrim(coalesce(new.employee_name, '')),
    '[[:space:][:punct:]]+', '', 'g'
  )), '');
begin
  if tg_op = 'UPDATE' then
    if exists (
      select 1
      from employee_private.employee_identity_merge_ledger ledger
      where ledger.source_employee_id = old.employee_id
        and ledger.target_employee_id = new.employee_id
    ) then
      new.employee_match_status := 'matched';
      return new;
    end if;
  end if;

  select count(distinct employee.id)::integer,
    case when count(distinct employee.id) = 1 then
      min(employee.id::text)::uuid
    end
  into v_current_count, v_current_employee_id
  from public.employees employee
  where nullif(public.exam_employee_no_key(new.employee_no), '')
        is not null
    and public.exam_employee_no_key(employee.employee_no) =
      public.exam_employee_no_key(new.employee_no);

  select count(distinct ledger.target_employee_id)::integer,
    case when count(distinct ledger.target_employee_id) = 1 then
      min(ledger.target_employee_id::text)::uuid
    end,
    case when count(distinct lower(regexp_replace(
      btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
    ))) = 1 then min(lower(regexp_replace(
      btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
    ))) end
  into v_alias_count, v_alias_employee_id, v_alias_expected_name_key
  from employee_private.employee_identity_merge_ledger ledger
  where employee_private.employee_identity_key(
          ledger.previous_employee_no
        ) = employee_private.employee_identity_key(new.employee_no);

  if v_alias_count > 0 then
    if v_alias_count <> 1
       or v_alias_expected_name_key is null
       or (
         v_current_count > 0
         and (
           v_current_count <> 1
           or v_current_employee_id <> v_alias_employee_id
         )
       )
       or (
         v_raw_name_key is not null
         and v_raw_name_key <> v_alias_expected_name_key
       ) then
      new.employee_id := null;
      new.employee_match_status := 'ambiguous';
    else
      new.employee_id := v_alias_employee_id;
      new.employee_match_status := 'matched';
    end if;
    return new;
  end if;

  if v_current_count = 1 then
    new.employee_id := v_current_employee_id;
    new.employee_match_status := 'matched';
    return new;
  end if;
  if v_current_count > 1 then
    new.employee_id := null;
    new.employee_match_status := 'ambiguous';
    return new;
  end if;

  select count(distinct employee.id),
    case when count(distinct employee.id) = 1 then
      min(employee.id::text)::uuid
    end
  into v_current_count, v_current_employee_id
  from public.employees employee
  where public.exam_norm(employee.full_name) in (
    nullif(public.exam_norm(new.employee_name), ''),
    nullif(public.exam_norm(new.employee_no), '')
  );

  new.employee_id := case
    when v_current_count = 1 then v_current_employee_id
  end;
  new.employee_match_status := case
    when v_current_count = 1 then 'matched'
    when v_current_count > 1 then 'ambiguous'
    else 'unmatched'
  end;
  return new;
end;
$$;

revoke all on function public.legacy_exam_match_employee_row()
  from public, anon, authenticated, service_role;

comment on function public.legacy_exam_match_employee_row() is
  'Matches legacy exam rows through exact current IDs or approved historical aliases before retaining the legacy unique-name fallback.';

-- The raw schedule remains authoritative for an employee that already has a
-- live canonical profile.  The onsite marker is required only to create a new
-- schedule-only profile; the two explicit overrides are exact-ID/name gated.
do $patch_ingest$
declare
  v_definition text;
  v_old_stage_tail text := $old$
    from jsonb_array_elements(v_schedule_rows) item;

    if exists (
$old$;
  v_new_stage_tail text := $new$
    from jsonb_array_elements(v_schedule_rows) item;

    -- A confirmed historical alias may reappear in either Google source.  It
    -- is canonicalized only when the normalized name still matches the
    -- approved target.  Contradictory reuse of an old number aborts the whole
    -- snapshot instead of recreating a split employee identity.
    if exists (
      select 1
      from (
        select home.employee_no, home.name_key
        from pg_temp.employee_master_home_stage home
        union all
        select schedule.employee_no, schedule.name_key
        from pg_temp.employee_master_schedule_stage schedule
      ) source_row
      join employee_private.employee_identity_merge_ledger ledger
        on employee_private.employee_identity_key(
             ledger.previous_employee_no
           ) = employee_private.employee_identity_key(
             source_row.employee_no
           )
      join public.employees canonical
        on canonical.id = ledger.target_employee_id
      where source_row.name_key <>
              lower(regexp_replace(
                btrim(ledger.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              ))
        and source_row.name_key <>
              lower(regexp_replace(
                btrim(canonical.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              ))
    ) then
      raise exception using
        errcode = '22023',
        message = 'confirmed_employee_alias_name_mismatch';
    end if;

    update pg_temp.employee_master_home_stage home
    set employee_no = public.employee_master_normalize_id(
      canonical.employee_no
    )
    from employee_private.employee_identity_merge_ledger ledger
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where employee_private.employee_identity_key(
            ledger.previous_employee_no
          ) = employee_private.employee_identity_key(home.employee_no)
      and home.name_key in (
        lower(regexp_replace(
          btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
        )),
        lower(regexp_replace(
          btrim(canonical.full_name), '[[:space:][:punct:]]+', '', 'g'
        ))
      );

    update pg_temp.employee_master_schedule_stage schedule
    set employee_no = public.employee_master_normalize_id(
      canonical.employee_no
    )
    from employee_private.employee_identity_merge_ledger ledger
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where employee_private.employee_identity_key(
            ledger.previous_employee_no
          ) = employee_private.employee_identity_key(
            schedule.employee_no
          )
      and schedule.name_key in (
        lower(regexp_replace(
          btrim(ledger.full_name), '[[:space:][:punct:]]+', '', 'g'
        )),
        lower(regexp_replace(
          btrim(canonical.full_name), '[[:space:][:punct:]]+', '', 'g'
        ))
      );

    update pg_temp.employee_master_schedule_stage schedule
    set onsite_marker = true
    from employee_private.employee_master_roster_overrides manual_override
    where manual_override.active
      and public.employee_master_normalize_id(manual_override.employee_no) =
        schedule.employee_no
      and manual_override.expected_name_key = schedule.name_key;

    if exists (
$new$;
  v_old_schedule_accept text :=
    'where schedule.employee_no is not null and schedule.onsite_marker';
  v_new_schedule_accept text := $new$
where schedule.employee_no is not null
        and (
          schedule.onsite_marker
          or exists (
            select 1
            from public.employees accepted_employee
            where public.employee_master_normalize_id(
                    accepted_employee.employee_no
                  ) = schedule.employee_no
              and accepted_employee.status in
                ('active', 'probation', 'suspended')
              and coalesce(accepted_employee.source_type, '') <>
                'google_deleted'
              and lower(regexp_replace(
                    btrim(accepted_employee.full_name),
                    '[[:space:][:punct:]]+', '', 'g'
                  )) = schedule.name_key
          )
        )
$new$;
  v_old_conflict_accept text := 'where conflict.onsite_marker';
  v_new_conflict_accept text := $new$
where conflict.onsite_marker
        or exists (
          select 1
          from public.employees accepted_employee
          where public.employee_master_normalize_id(
                  accepted_employee.employee_no
                ) = conflict.employee_no
            and accepted_employee.status in
              ('active', 'probation', 'suspended')
            and coalesce(accepted_employee.source_type, '') <>
              'google_deleted'
            and not exists (
              select 1
              from jsonb_array_elements(
                conflict.source_rows_evidence
              ) conflict_row
              where btrim(conflict_row->>'name_key') <>
                lower(regexp_replace(
                  btrim(accepted_employee.full_name),
                  '[[:space:][:punct:]]+', '', 'g'
                ))
            )
        )
$new$;
  v_old_schedule_valid text :=
    'or (home.employee_no is null and schedule.onsite_marker)';
  v_new_schedule_valid text := $new$
or (
          home.employee_no is null
          and (
            schedule.onsite_marker
            or exists (
              select 1
              from public.employees accepted_employee
              where public.employee_master_normalize_id(
                      accepted_employee.employee_no
                    ) = schedule.employee_no
                and accepted_employee.status in
                  ('active', 'probation', 'suspended')
                and coalesce(accepted_employee.source_type, '') <>
                  'google_deleted'
                and lower(regexp_replace(
                      btrim(accepted_employee.full_name),
                      '[[:space:][:punct:]]+', '', 'g'
                    )) = schedule.name_key
            )
          )
        )
$new$;
  v_old_missing_marker text := $old$
      and not schedule.onsite_marker
      and not exists (
$old$;
  v_new_missing_marker text := $new$
      and not schedule.onsite_marker
      and not exists (
        select 1
        from public.employees accepted_employee
        where public.employee_master_normalize_id(
                accepted_employee.employee_no
              ) = schedule.employee_no
          and accepted_employee.status in
            ('active', 'probation', 'suspended')
          and coalesce(accepted_employee.source_type, '') <> 'google_deleted'
          and lower(regexp_replace(
                btrim(accepted_employee.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              )) = schedule.name_key
      )
      and not exists (
$new$;
  v_old_missing_details text :=
    'jsonb_build_object(''action'', ''ignored_for_presence_creation_and_updates'')';
  v_new_missing_details text := $new$
jsonb_strip_nulls(jsonb_build_object(
        'action', 'manual_review_no_automatic_identity_change',
        'reason', case
          when exists (
            select 1
            from public.employees existing_employee
            where public.employee_master_normalize_id(
                    existing_employee.employee_no
                  ) = schedule.employee_no
              and existing_employee.status in
                ('active', 'probation', 'suspended')
              and coalesce(existing_employee.source_type, '') <>
                'google_deleted'
          ) then 'canonical_name_mismatch'
          else 'missing_onsite_marker'
        end,
        'home_name', (
          select existing_employee.full_name
          from public.employees existing_employee
          where public.employee_master_normalize_id(
                  existing_employee.employee_no
                ) = schedule.employee_no
            and existing_employee.status in
              ('active', 'probation', 'suspended')
            and coalesce(existing_employee.source_type, '') <>
              'google_deleted'
          limit 1
        ),
        'schedule_name', schedule.full_name
      ))
$new$;
  v_old_status_scope text := $old$where employee.status in ('active', 'probation', 'suspended')
      and public.employee_master_normalize_id(employee.employee_no) not in ('SYSTEM', 'ADMIN')$old$;
  v_new_status_scope text := $new$where employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no) not in ('SYSTEM', 'ADMIN')$new$;
  v_old_employment text :=
    'case when desired.home_active then employee.employment_type else ''现场人员'' end';
  v_new_employment text :=
    'case when desired.home_active or not desired.onsite_marker then employee.employment_type else ''现场人员'' end';
  v_old_source_type text :=
    'case when desired.home_active then employee.source_type else ''schedule_only'' end';
  v_new_source_type text :=
    'case when desired.home_active or not desired.onsite_marker then employee.source_type else ''schedule_only'' end';
  v_old_profile_status text :=
    'case when desired.home_active then employee.profile_status else ''needs_profile_completion'' end';
  v_new_profile_status text :=
    'case when desired.home_active or not desired.onsite_marker then employee.profile_status else ''needs_profile_completion'' end';
  v_old_source_sheet text :=
    'case when desired.home_active then employee.source_sheet else ''居家排班表/填表'' end';
  v_new_source_sheet text :=
    'case when desired.home_active or not desired.onsite_marker then employee.source_sheet else ''居家排班表/填表'' end';
  v_old_source_row text :=
    'case when desired.home_active then employee.source_row else desired.source_row end';
  v_new_source_row text :=
    'case when desired.home_active or not desired.onsite_marker then employee.source_row else desired.source_row end';
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_definition
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace
    on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'ingest_employee_master_snapshot_validated_v1'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) =
      'p_payload jsonb';

  if v_definition is null then
    raise exception 'employee_master_validated_ingest_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_new_stage_tail) > 0 then
    if pg_catalog.strpos(v_definition, v_new_schedule_accept) = 0
       or pg_catalog.strpos(v_definition, v_new_conflict_accept) = 0
       or pg_catalog.strpos(v_definition, v_new_schedule_valid) = 0
       or pg_catalog.strpos(v_definition, v_new_missing_marker) = 0
       or pg_catalog.strpos(v_definition, v_new_missing_details) = 0
       or pg_catalog.strpos(v_definition, v_new_status_scope) = 0
       or pg_catalog.strpos(v_definition, v_new_employment) = 0
       or pg_catalog.strpos(v_definition, v_new_source_type) = 0
       or pg_catalog.strpos(v_definition, v_new_profile_status) = 0
       or pg_catalog.strpos(v_definition, v_new_source_sheet) = 0
       or pg_catalog.strpos(v_definition, v_new_source_row) = 0
       or pg_catalog.strpos(v_definition, v_old_schedule_accept) > 0
       or pg_catalog.strpos(v_definition, v_old_conflict_accept) > 0
       or pg_catalog.strpos(v_definition, v_old_missing_details) > 0 then
      raise exception 'employee_master_roster_patch_partial';
    end if;
    return;
  end if;

  if pg_catalog.strpos(v_definition, v_old_stage_tail) = 0
     or pg_catalog.strpos(v_definition, v_old_schedule_valid) = 0
     or pg_catalog.strpos(v_definition, v_old_missing_marker) = 0 then
    raise exception 'employee_master_roster_patch_marker_missing';
  end if;
  if (length(v_definition) - length(replace(
        v_definition, v_old_schedule_accept, ''
      ))) / length(v_old_schedule_accept) <> 3
     or (length(v_definition) - length(replace(
        v_definition, v_old_conflict_accept, ''
      ))) / length(v_old_conflict_accept) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_status_scope, ''
      ))) / length(v_old_status_scope) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_missing_details, ''
      ))) / length(v_old_missing_details) <> 1
     or (length(v_definition) - length(replace(
        v_definition, v_old_employment, ''
      ))) / length(v_old_employment) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_source_type, ''
      ))) / length(v_old_source_type) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_profile_status, ''
      ))) / length(v_old_profile_status) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_source_sheet, ''
      ))) / length(v_old_source_sheet) <> 2
     or (length(v_definition) - length(replace(
        v_definition, v_old_source_row, ''
      ))) / length(v_old_source_row) <> 2 then
    raise exception 'employee_master_roster_patch_marker_count_changed';
  end if;

  v_definition := replace(v_definition, v_old_stage_tail, v_new_stage_tail);
  v_definition := replace(
    v_definition, v_old_schedule_accept, v_new_schedule_accept
  );
  v_definition := replace(
    v_definition, v_old_conflict_accept, v_new_conflict_accept
  );
  v_definition := replace(
    v_definition, v_old_schedule_valid, v_new_schedule_valid
  );
  v_definition := replace(
    v_definition, v_old_missing_marker, v_new_missing_marker
  );
  v_definition := replace(
    v_definition, v_old_missing_details, v_new_missing_details
  );
  v_definition := replace(
    v_definition, v_old_status_scope, v_new_status_scope
  );
  v_definition := replace(
    v_definition, v_old_employment, v_new_employment
  );
  v_definition := replace(
    v_definition, v_old_source_type, v_new_source_type
  );
  v_definition := replace(
    v_definition, v_old_profile_status, v_new_profile_status
  );
  v_definition := replace(
    v_definition, v_old_source_sheet, v_new_source_sheet
  );
  v_definition := replace(
    v_definition, v_old_source_row, v_new_source_row
  );
  execute v_definition;
end;
$patch_ingest$;

revoke all on function
  public.ingest_employee_master_snapshot_validated_v1(jsonb)
  from public, anon, authenticated, service_role;

comment on function
  public.ingest_employee_master_snapshot_validated_v1(jsonb) is
  'Private atomic dual-source reconciliation. Existing live canonical employees are accepted from the full schedule only when both normalized employee number and normalized name match, without changing their profile classification; exact approved rows may create schedule-only profiles.';

-- Successful master runs retain the untouched source payload for audit.  The
-- report cache is a derived current-identity projection, so approved old IDs
-- must be canonicalized there as well.  A reused old ID with a different name
-- aborts the refresh instead of publishing a split roster identity.
create or replace function
  public.refresh_schedule_report_snapshot_after_master_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payload jsonb;
  v_canonical_payload jsonb;
  v_row_count integer;
  v_snapshot_hash text;
  v_captured_at timestamptz;
  v_directory_result jsonb;
  v_cache_diagnostic jsonb;
  v_relationship_error text;
  v_parse_warning_count integer := 0;
  v_issue_count integer := 0;
begin
  if new.status <> 'success' then
    return new;
  end if;

  select snapshot.payload, snapshot.row_count, snapshot.snapshot_hash,
    snapshot.captured_at
  into v_payload, v_row_count, v_snapshot_hash, v_captured_at
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_schedule_roster_current'
    and snapshot.run_id = new.id;

  if v_payload is null or jsonb_typeof(v_payload) <> 'array'
     or v_row_count < 1
     or jsonb_array_length(v_payload) <> v_row_count then
    raise exception using
      errcode = '22023',
      message = 'successful_master_run_missing_schedule_snapshot';
  end if;

  if not exists (
    select 1
    from public.employee_master_source_snapshots snapshot
    where snapshot.source_key = 'home_employee_roster_current'
      and snapshot.run_id = new.id
      and jsonb_typeof(snapshot.payload) = 'array'
      and snapshot.row_count = jsonb_array_length(snapshot.payload)
  ) then
    raise exception using
      errcode = '22023',
      message = 'successful_master_run_missing_home_snapshot';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_payload) item
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = employee_private.employee_identity_key(item->>'employee_id')
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(ledger.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
      and coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(canonical.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
  ) then
    raise exception using
      errcode = '22023',
      message = 'confirmed_employee_alias_name_mismatch';
  end if;

  select coalesce(jsonb_agg(
    case
      when ledger.target_employee_id is not null then
        jsonb_set(
          item,
          '{employee_id}',
          to_jsonb(public.employee_master_normalize_id(
            canonical.employee_no
          )),
          true
        )
      else item
    end
    order by source_row
  ), '[]'::jsonb)
  into v_canonical_payload
  from jsonb_array_elements(v_payload)
    with ordinality source(item, source_row)
  left join employee_private.employee_identity_merge_ledger ledger
    on employee_private.employee_identity_key(
         ledger.previous_employee_no
       ) = employee_private.employee_identity_key(item->>'employee_id')
  left join public.employees canonical
    on canonical.id = ledger.target_employee_id;

  if jsonb_array_length(v_canonical_payload) <> v_row_count then
    raise exception 'canonical_schedule_report_row_count_mismatch';
  end if;

  insert into public.report_sheet_snapshots (
    source, payload, row_count, synced_at, note
  ) values (
    '居家排班表/填表', v_canonical_payload, v_row_count,
    greatest(
      coalesce(v_captured_at, clock_timestamp()),
      clock_timestamp()
    ),
    'employee-master-full-schedule-v4;confirmed-aliases;hash:' ||
      v_snapshot_hash
  )
  on conflict (source) do update
  set payload = excluded.payload,
      row_count = excluded.row_count,
      synced_at = excluded.synced_at,
      note = excluded.note;

  v_directory_result :=
    public.sync_report_employee_directory_scope_inner_v1(
      v_canonical_payload
    );

  -- inline_directory_cache_diff_refresh_v1
  -- Keep this as the immediate outer PL/pgSQL statement after the writer.
  -- Static PL/pgSQL plans retained both this variable's initial value and the
  -- pre-writer relation snapshot in production.  The SQL text is fixed, while
  -- EXECUTE ... USING forces a fresh SPI plan/snapshot and passes the current
  -- payload without interpolation.
  execute $directory_cache_diff_refresh$
  with expected as materialized (
    select distinct on (upper(btrim(item->>'employee_id')))
      upper(btrim(item->>'employee_id')) employee_no,
      case
        when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer
      end source_row,
      nullif(btrim(item->>'name'), '') full_name,
      nullif(btrim(item->>'team'), '') team_name,
      nullif(btrim(item->>'group'), '') group_name,
      nullif(btrim(item->>'position'), '') position_name,
      nullif(btrim(item->>'country'), '') country_name,
      nullif(btrim(item->>'shift'), '') shift_name,
      nullif(btrim(item->>'platform'), '') platform_name,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer
    from jsonb_array_elements($1::jsonb) item
    where nullif(btrim(item->>'employee_id'), '') is not null
    order by upper(btrim(item->>'employee_id')),
      case
        when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer
      end desc nulls last
  ), cached as materialized (
    select
      upper(btrim(directory.employee_no)) employee_no,
      directory.source_row,
      directory.full_name,
      directory.team_name,
      directory.group_name,
      directory.position_name,
      directory.country_name,
      directory.shift_name,
      directory.platform_name,
      directory.responsible,
      directory.onsite_trainer,
      directory.online_leader,
      directory.online_trainer
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
  ), differences as materialized (
    select
      expected.employee_no,
      case
        when cached.employee_no is null then 'missing_cached'
        else 'field_mismatch'
      end difference_kind,
      case
        when cached.employee_no is null then array[]::text[]
        else array_remove(array[
          case when expected.source_row is distinct from cached.source_row
            then 'source_row' end,
          case when expected.full_name is distinct from cached.full_name
            then 'full_name' end,
          case when expected.team_name is distinct from cached.team_name
            then 'team_name' end,
          case when expected.group_name is distinct from cached.group_name
            then 'group_name' end,
          case
            when expected.position_name is distinct from cached.position_name
              then 'position_name'
          end,
          case when expected.country_name is distinct from cached.country_name
            then 'country_name' end,
          case when expected.shift_name is distinct from cached.shift_name
            then 'shift_name' end,
          case
            when expected.platform_name is distinct from cached.platform_name
              then 'platform_name'
          end,
          case when expected.responsible is distinct from cached.responsible
            then 'responsible' end,
          case
            when expected.onsite_trainer is distinct from cached.onsite_trainer
              then 'onsite_trainer'
          end,
          case
            when expected.online_leader is distinct from cached.online_leader
              then 'online_leader'
          end,
          case
            when expected.online_trainer is distinct from cached.online_trainer
              then 'online_trainer'
          end
        ], null)::text[]
      end differing_fields
    from expected
    left join cached using (employee_no)
    where cached.employee_no is null
       or row(
         expected.source_row, expected.full_name, expected.team_name,
         expected.group_name, expected.position_name, expected.country_name,
         expected.shift_name, expected.platform_name, expected.responsible,
         expected.onsite_trainer, expected.online_leader,
         expected.online_trainer
       ) is distinct from row(
         cached.source_row, cached.full_name, cached.team_name,
         cached.group_name, cached.position_name, cached.country_name,
         cached.shift_name, cached.platform_name, cached.responsible,
         cached.onsite_trainer, cached.online_leader,
         cached.online_trainer
       )

    union all

    select cached.employee_no, 'extra_cached', array[]::text[]
    from cached
    left join expected using (employee_no)
    where expected.employee_no is null
  )
  select jsonb_build_object(
    'comparison_version', 'inline_directory_cache_diff_refresh_v1',
    'matches',
      (select count(*) from expected) > 0
      and not exists (select 1 from differences),
    'input_rows', jsonb_array_length($1::jsonb),
    'row_count', $2::integer,
    'expected_rows', (select count(*) from expected),
    'cached_roster_rows', (select count(*) from cached),
    'missing_cached', (
      select count(*) from differences
      where difference_kind = 'missing_cached'
    ),
    'extra_cached', (
      select count(*) from differences
      where difference_kind = 'extra_cached'
    ),
    'field_mismatch', (
      select count(*) from differences
      where difference_kind = 'field_mismatch'
    ),
    'samples', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_no', sample.employee_no,
          'difference_kind', sample.difference_kind,
          'differing_fields', to_jsonb(sample.differing_fields)
        )
        order by sample.difference_kind, sample.employee_no
      )
      from (
        select difference.employee_no, difference.difference_kind,
          difference.differing_fields
        from differences difference
        order by difference.difference_kind, difference.employee_no
        limit 5
      ) sample
    ), '[]'::jsonb)
  )
  $directory_cache_diff_refresh$
  into v_cache_diagnostic
  using v_canonical_payload, v_row_count;
  if v_cache_diagnostic->>'comparison_version' is distinct from
       'inline_directory_cache_diff_refresh_v1'
     or (v_cache_diagnostic->>'matches')::boolean is distinct from true then
    raise exception using
      errcode = '22023',
      message = 'full_schedule_directory_cache_mismatch',
      detail = (
        coalesce(v_cache_diagnostic, '{}'::jsonb) ||
        jsonb_build_object(
          'writer_result', coalesce(v_directory_result, '{}'::jsonb)
        )
      )::text;
  end if;

  begin
    perform session_private.rebuild_online_training_roster_relationships(
      v_canonical_payload
    );
  exception
    when sqlstate '22023' then
      get stacked diagnostics v_relationship_error = message_text;
      if v_relationship_error <> 'invalid_schedule_roster_rows'
         and v_relationship_error not like
           'schedule_roster_relationship_%' then
        raise;
      end if;
  end;

  -- Keep the discrepancy center current on every successful master run.
  -- Effective home employees that are not yet scheduled remain active; one
  -- visible issue follows them until a later schedule snapshot includes the
  -- canonical UUID/employee number.  Future hires are intentionally excluded.
  select count(*)::integer
  into v_issue_count
  from public.employee_master_sync_issues issue
  where issue.run_id = new.id;
  if new.warning_count < v_issue_count then
    raise exception using
      errcode = '22023',
      message = 'employee_master_warning_count_below_issue_count';
  end if;
  v_parse_warning_count := new.warning_count - v_issue_count;

  delete from public.employee_master_sync_issues issue
  where issue.run_id = new.id
    and issue.issue_code = 'home_only_missing_schedule';

  insert into public.employee_master_sync_issues (
    run_id, issue_code, employee_no, home_source_row, details
  )
  with schedule_employee_ids as materialized (
    select distinct employee_private.resolve_confirmed_employee_id(
      item->>'employee_id'
    ) employee_id
    from jsonb_array_elements(v_canonical_payload) item
  ), home_candidates as materialized (
    select employee.id employee_id, employee.employee_no,
      employee.full_name,
      (item->>'source_row')::integer home_source_row,
      row_number() over (
        partition by employee.id
        order by (item->>'source_row')::integer
      ) source_rank
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    join public.employees employee
      on employee.id = employee_private.resolve_confirmed_employee_id(
        item->>'employee_id'
      )
    where snapshot.source_key = 'home_employee_roster_current'
      and snapshot.run_id = new.id
      and not coalesce(
        (item->>'explicitly_resigned')::boolean,
        false
      )
      and employee.status in ('active', 'probation')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and (
        employee.hire_date is null
        or employee.hire_date <=
          (statement_timestamp() at time zone 'Asia/Manila')::date
      )
  )
  select new.id, 'home_only_missing_schedule',
    candidate.employee_no, candidate.home_source_row,
    jsonb_build_object(
      'reason', 'active_home_employee_not_yet_scheduled',
      'action', 'await_schedule_assignment',
      'employee_name', candidate.full_name,
      'account_review_required', true
    )
  from home_candidates candidate
  where candidate.source_rank = 1
    and not exists (
      select 1
      from schedule_employee_ids scheduled
      where scheduled.employee_id = candidate.employee_id
    )
  order by candidate.employee_no;

  select count(*)::integer
  into v_issue_count
  from public.employee_master_sync_issues issue
  where issue.run_id = new.id;

  update public.employee_master_sync_runs run
  set warning_count = v_parse_warning_count + v_issue_count
  where run.id = new.id
    and run.warning_count is distinct from
      v_parse_warning_count + v_issue_count;

  -- The outer employee-master wrapper owns rebuild coalescing.  Mark it dirty
  -- so a directory-only change still produces exactly one final scope rebuild.
  perform scope_private.request_all_assigned_employee_scope_rebuild();

  return new;
end;
$$;

revoke all on function
  public.refresh_schedule_report_snapshot_after_master_sync()
  from public, anon, authenticated, service_role;

comment on function
  public.refresh_schedule_report_snapshot_after_master_sync() is
  'After an accepted employee-master run, rebuilds the full report roster while resolving confirmed old employee numbers to canonical IDs, rejecting alias/name conflicts, and maintaining visible effective-home-only schedule discrepancies.';

-- Assignment summaries are profile data.  Resolve both current numbers and
-- approved historical aliases to a UUID, but update only rows whose normalized
-- schedule name equals that employee's normalized canonical name.  The twelve
-- known same-ID/name-mismatch rows therefore remain visible for review without
-- overwriting the employee profile.
create or replace function public.sync_schedule_employee_assignments(
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer := 0;
  v_skipped_name_mismatch integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_schedule_assignment_rows';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) item
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = employee_private.employee_identity_key(item->>'employee_id')
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(ledger.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
      and coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(canonical.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
  ) then
    raise exception using
      errcode = '22023',
      message = 'confirmed_employee_alias_name_mismatch';
  end if;

  if exists (
    select resolved.employee_id
    from (
      select employee_private.resolve_confirmed_employee_id(
        item->>'employee_id'
      ) employee_id
      from jsonb_array_elements(p_rows) item
      where nullif(public.employee_master_normalize_id(
              item->>'employee_id'
            ), '') is not null
    ) resolved
    where resolved.employee_id is not null
    group by resolved.employee_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '22023',
      message = 'duplicate_canonical_schedule_identity';
  end if;

  with assignments as materialized (
    select
      employee_private.resolve_confirmed_employee_id(
        item->>'employee_id'
      ) employee_id,
      coalesce(
        nullif(btrim(item->>'name_key'), ''),
        lower(regexp_replace(
          btrim(coalesce(item->>'name', '')),
          '[[:space:][:punct:]]+', '', 'g'
        ))
      ) schedule_name_key,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer
    from jsonb_array_elements(p_rows) item
    where nullif(public.employee_master_normalize_id(
            item->>'employee_id'
          ), '') is not null
  ), desired as materialized (
    select assignments.*,
      coalesce(
        assignments.online_leader,
        assignments.responsible
      ) leader_name,
      coalesce(
        assignments.online_trainer,
        assignments.onsite_trainer
      ) trainer_name
    from assignments
  )
  update public.employees employee
  set person_in_charge = desired.responsible,
      on_site_trainer = desired.onsite_trainer,
      online_leader = desired.online_leader,
      online_trainer = desired.online_trainer,
      leader_name = desired.leader_name,
      trainer_name = desired.trainer_name,
      updated_at = clock_timestamp()
  from desired
  where employee.id = desired.employee_id
    and employee.status in ('active', 'probation', 'suspended')
    and coalesce(employee.source_type, '') <> 'google_deleted'
    and lower(regexp_replace(
          btrim(employee.full_name),
          '[[:space:][:punct:]]+', '', 'g'
        )) = desired.schedule_name_key
    and row(
      employee.person_in_charge, employee.on_site_trainer,
      employee.online_leader, employee.online_trainer,
      employee.leader_name, employee.trainer_name
    ) is distinct from row(
      desired.responsible, desired.onsite_trainer,
      desired.online_leader, desired.online_trainer,
      desired.leader_name, desired.trainer_name
    );
  get diagnostics v_updated = row_count;

  select count(*)::integer
  into v_skipped_name_mismatch
  from jsonb_array_elements(p_rows) item
  join public.employees employee
    on employee.id = employee_private.resolve_confirmed_employee_id(
      item->>'employee_id'
    )
  where employee.status in ('active', 'probation', 'suspended')
    and coalesce(employee.source_type, '') <> 'google_deleted'
    and lower(regexp_replace(
          btrim(employee.full_name),
          '[[:space:][:punct:]]+', '', 'g'
        )) <> coalesce(
          nullif(btrim(item->>'name_key'), ''),
          lower(regexp_replace(
            btrim(coalesce(item->>'name', '')),
            '[[:space:][:punct:]]+', '', 'g'
          ))
        );

  return jsonb_build_object(
    'updated', v_updated,
    'skipped_name_mismatch', v_skipped_name_mismatch
  );
end;
$$;

revoke all on function public.sync_schedule_employee_assignments(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_schedule_employee_assignments(jsonb)
  to service_role;

comment on function public.sync_schedule_employee_assignments(jsonb) is
  'Propagates schedule assignment fields only after exact canonical UUID and normalized-name agreement, resolving confirmed old employee numbers without recreating them.';

-- The standalone schedule push bypasses employee-master staging.  Canonicalize
-- its approved aliases before the guarded snapshot writer calculates hashes,
-- report rows or directory cache entries; otherwise a later Apps Script push
-- could restore the retired number in the current read model.
create or replace function public.ingest_schedule_roster_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '40s'
set lock_timeout = '2s'
as $$
declare
  v_rows jsonb := p_payload->'rows';
  v_canonical_rows jsonb;
  v_canonical_payload jsonb;
  v_result jsonb;
  v_assignment_result jsonb := jsonb_build_object('updated', 0);
begin
  -- Preserve the existing structured validation response for malformed input.
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or v_rows is null or jsonb_typeof(v_rows) <> 'array'
     or jsonb_array_length(v_rows) = 0 then
    return public.ingest_schedule_roster_snapshot_guarded_v1(p_payload);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_rows) item
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = employee_private.employee_identity_key(item->>'employee_id')
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(ledger.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
      and coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) <> lower(regexp_replace(
            btrim(canonical.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
  ) then
    raise exception using
      errcode = '22023',
      message = 'confirmed_employee_alias_name_mismatch';
  end if;

  select coalesce(jsonb_agg(
    case
      when ledger.target_employee_id is not null then
        jsonb_set(
          item || jsonb_build_object(
            'confirmed_previous_employee_id',
            public.employee_master_normalize_id(item->>'employee_id')
          ),
          '{employee_id}',
          to_jsonb(public.employee_master_normalize_id(
            canonical.employee_no
          )),
          true
        )
      else item
    end
    order by source_row
  ), '[]'::jsonb)
  into v_canonical_rows
  from jsonb_array_elements(v_rows)
    with ordinality source(item, source_row)
  left join employee_private.employee_identity_merge_ledger ledger
    on employee_private.employee_identity_key(
         ledger.previous_employee_no
       ) = employee_private.employee_identity_key(item->>'employee_id')
  left join public.employees canonical
    on canonical.id = ledger.target_employee_id;

  if jsonb_array_length(v_canonical_rows) < 1
     or jsonb_array_length(v_canonical_rows) <>
        jsonb_array_length(v_rows) then
    raise exception using
      errcode = '22023',
      message = 'canonical_schedule_roster_rows_invalid';
  end if;

  v_canonical_payload := jsonb_set(
    p_payload,
    '{rows}',
    v_canonical_rows,
    true
  );
  v_result := public.ingest_schedule_roster_snapshot_guarded_v1(
    v_canonical_payload
  );

  if coalesce((v_result->>'ok')::boolean, false) then
    v_assignment_result := public.sync_schedule_employee_assignments(
      v_canonical_rows
    );
  end if;

  return v_result || jsonb_build_object(
    'employee_assignments_updated',
      coalesce((v_assignment_result->>'updated')::integer, 0),
    'employee_assignments_name_mismatch',
      coalesce(
        (v_assignment_result->>'skipped_name_mismatch')::integer,
        0
      )
  );
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

comment on function public.ingest_schedule_roster_snapshot(jsonb) is
  'Service-only guarded schedule ingest that resolves confirmed old employee numbers before writing the report snapshot/cache and then propagates only exact ID/name assignment matches.';

-- A future hire is a valid employee record, but is not an effective active
-- employee until the Manila hire date.  Do not mislabel that row as inactive.
do $patch_dashboard$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'public.admin_home_dashboard()'::regprocedure
  );
  v_old_active text := $old$
  active_employees as materialized (
    select employee.*
    from scoped_employees employee
    where lower(btrim(coalesce(employee.status, ''))) in ('active', 'probation', '在职', '试用')
  ),
$old$;
  v_new_active text := $new$
  active_employees as materialized (
    select employee.*
    from scoped_employees employee
    where lower(btrim(coalesce(employee.status, ''))) in ('active', 'probation', '在职', '试用')
      and (employee.hire_date is null or employee.hire_date <= v_today)
  ),
$new$;
  v_old_inactive text := $old$
      'inactive', (select count(*)::integer from scoped_employees) -
        (select count(*)::integer from active_employees),
$old$;
  v_new_inactive text := $new$
      'inactive', (select count(*)::integer
        from scoped_employees employee
        where lower(btrim(coalesce(employee.status, ''))) not in
          ('active', 'probation', '在职', '试用')),
$new$;
begin
  if pg_catalog.strpos(v_definition, v_new_active) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_old_active) = 0
     or pg_catalog.strpos(v_definition, v_old_inactive) = 0 then
    raise exception 'admin_dashboard_effective_date_marker_missing';
  end if;
  v_definition := replace(v_definition, v_old_active, v_new_active);
  v_definition := replace(v_definition, v_old_inactive, v_new_inactive);
  execute v_definition;
end;
$patch_dashboard$;

revoke all on function public.admin_home_dashboard()
  from public, anon, authenticated, service_role;
grant execute on function public.admin_home_dashboard()
  to authenticated, service_role;

comment on function public.admin_home_dashboard() is
  'Session-, permission- and scope-checked bounded management-home aggregate. Active headcount is effective as of the Manila date and excludes future hires, resignation history and deleted Google archives.';

create or replace function
  employee_private.apply_confirmed_employee_identity_reconciliation()
returns void
language plpgsql
security definer
set search_path = ''
as $reconcile$
declare
  v_latest_run_id bigint;
  v_latest_captured_at timestamptz;
  v_schedule_count integer := 0;
  v_inserted integer := 0;
  v_merged integer := 0;
  v_expected_merge integer := 0;
  v_old_issue_count integer := 0;
  v_parse_warning_count integer := 0;
  v_remaining_issue_count integer := 0;
  v_directory_rows jsonb := '[]'::jsonb;
  v_directory_result jsonb;
  v_cache_diagnostic jsonb;
  v_relationship_error text;
  v_directory_nonblank_count integer := 0;
  v_directory_distinct_count integer := 0;
  v_ref record;
  v_left integer;
  v_reference_preserved boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-master-reconciliation', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'employee-master-dual-source-sync', 20260825
    )
  );

  -- Employee inserts/deletes and access relinks normally request a full
  -- assigned-scope rebuild.  Coalesce every request from this transaction and
  -- rebuild once after every canonical UUID and directory row is final.
  perform pg_catalog.set_config(
    'scope_private.defer_assigned_scope_rebuild', 'on', true
  );
  perform pg_catalog.set_config(
    'scope_private.assigned_scope_rebuild_dirty', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild', 'on', true
  );

  delete from employee_private.employee_identity_reconcile_approved_schedule;
  delete from employee_private.employee_identity_reconcile_merge_plan;
  delete from
    employee_private.employee_identity_reconcile_target_schedule_fields;
  delete from employee_private.employee_identity_reconcile_expected_fk;
  delete from
    employee_private.employee_identity_reconcile_expected_name_mismatch;
  delete from
    employee_private.employee_identity_reconcile_actual_name_mismatch;
  delete from employee_private.employee_identity_reconcile_source_presence;
  delete from
    employee_private.employee_identity_reconcile_cross_name_mismatch;

  select snapshot.run_id, snapshot.captured_at, snapshot.row_count
  into v_latest_run_id, v_latest_captured_at, v_schedule_count
  from public.employee_master_source_snapshots snapshot
  where snapshot.source_key = 'home_schedule_roster_current';

  -- A truly fresh installation has no source run to reconcile; schema and
  -- function hardening above still apply.  Any existing but unexpectedly
  -- small/malformed production snapshot must fail closed instead of silently
  -- recording this data migration as applied.
  if v_latest_run_id is null and coalesce(v_schedule_count, 0) = 0 then
    perform pg_catalog.set_config(
      'scope_private.defer_assigned_scope_rebuild', 'off', true
    );
    perform pg_catalog.set_config(
      'scope_private.assigned_scope_rebuild_dirty', 'off', true
    );
    perform pg_catalog.set_config(
      'scope_private.skip_rebuild', 'off', true
    );
    return;
  end if;
  if coalesce(v_schedule_count, 0) < 100 then
    raise exception using
      errcode = '22023',
      message = 'employee_identity_schedule_snapshot_too_small',
      detail = format(
        'run_id=%s,schedule_count=%s',
        coalesce(v_latest_run_id::text, 'null'),
        coalesce(v_schedule_count::text, 'null')
      );
  end if;

  select count(*)::integer
  into v_old_issue_count
  from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id;

  select greatest(run.warning_count - v_old_issue_count, 0)
  into v_parse_warning_count
  from public.employee_master_sync_runs run
  where run.id = v_latest_run_id;

  insert into employee_private.employee_identity_reconcile_approved_schedule (
    employee_no, full_name, name_key, responsible, onsite_trainer,
    online_leader, online_trainer, group_name, team_name, shift_name,
    position_name, platform_name, work_content, country_name, source_row,
    employment_type
  )
  select
    public.employee_master_normalize_id(item->>'employee_id') employee_no,
    btrim(item->>'name') full_name,
    btrim(item->>'name_key') name_key,
    nullif(btrim(item->>'responsible'), '') responsible,
    nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
    nullif(btrim(item->>'online_leader'), '') online_leader,
    nullif(btrim(item->>'online_trainer'), '') online_trainer,
    nullif(btrim(item->>'group'), '') group_name,
    nullif(btrim(item->>'team'), '') team_name,
    nullif(public.employee_master_normalize_shift(item->>'shift'), '') shift_name,
    nullif(btrim(item->>'position'), '') position_name,
    nullif(btrim(item->>'platform'), '') platform_name,
    nullif(btrim(item->>'work_content'), '') work_content,
    nullif(btrim(item->>'country'), '') country_name,
    (item->>'source_row')::integer source_row,
    manual_override.employment_type
  from public.employee_master_source_snapshots snapshot
  cross join lateral jsonb_array_elements(snapshot.payload) item
  join employee_private.employee_master_roster_overrides manual_override
    on public.employee_master_normalize_id(manual_override.employee_no) =
      public.employee_master_normalize_id(item->>'employee_id')
   and manual_override.expected_name_key = btrim(item->>'name_key')
   and manual_override.active
  where snapshot.source_key = 'home_schedule_roster_current';

  if (select count(*) from employee_private.employee_identity_reconcile_approved_schedule) <> 2
     or exists (
       select 1
       from employee_private.employee_master_roster_overrides manual_override
       where manual_override.active
         and not exists (
           select 1
           from employee_private.employee_identity_reconcile_approved_schedule approved
           where approved.employee_no = manual_override.employee_no
         )
     ) then
    raise exception 'approved_schedule_identity_preflight_failed';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_approved_schedule approved
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        approved.employee_no
    where lower(regexp_replace(
            btrim(employee.full_name), '[[:space:][:punct:]]+', '', 'g'
          )) <> approved.name_key
  ) then
    raise exception 'approved_schedule_existing_name_mismatch';
  end if;

  insert into public.teams (name, status)
  select distinct approved.team_name, 'active'
  from employee_private.employee_identity_reconcile_approved_schedule approved
  where approved.team_name is not null
    and not exists (
      select 1 from public.teams team
      where lower(btrim(team.name)) = lower(btrim(approved.team_name))
    );

  insert into public.positions (name, status)
  select distinct approved.position_name, 'active'
  from employee_private.employee_identity_reconcile_approved_schedule approved
  where approved.position_name is not null
    and not exists (
      select 1 from public.positions position
      where lower(btrim(position.name)) = lower(btrim(approved.position_name))
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
    approved.employee_no, approved.full_name, approved.country_name,
    approved.country_name, approved.employment_type,
    team.id, position.id, 'active', 'schedule_only',
    'needs_profile_completion', approved.shift_name,
    approved.group_name, approved.platform_name, approved.work_content,
    '居家排班表/填表', approved.source_row, false,
    approved.team_name, approved.position_name, approved.responsible,
    approved.onsite_trainer, approved.online_leader,
    approved.online_trainer, clock_timestamp()
  from employee_private.employee_identity_reconcile_approved_schedule approved
  left join lateral (
    select candidate.id
    from public.teams candidate
    where lower(btrim(candidate.name)) = lower(btrim(approved.team_name))
    order by case when candidate.status = 'active' then 0 else 1 end,
      candidate.id
    limit 1
  ) team on true
  left join lateral (
    select candidate.id
    from public.positions candidate
    where lower(btrim(candidate.name)) =
      lower(btrim(approved.position_name))
    order by case when candidate.status = 'active' then 0 else 1 end,
      candidate.id
    limit 1
  ) position on true
  where not exists (
    select 1
    from public.employees employee
    where public.employee_master_normalize_id(employee.employee_no) =
      approved.employee_no
  );
  get diagnostics v_inserted = row_count;

  if (select count(*)
      from employee_private.employee_identity_reconcile_approved_schedule approved
      join public.employees employee
        on public.employee_master_normalize_id(employee.employee_no) =
          approved.employee_no
       and employee.status in ('active', 'probation')) <> 2 then
    raise exception 'approved_schedule_profile_creation_failed';
  end if;

  insert into employee_private.employee_identity_reconcile_merge_plan (
    previous_employee_no, official_employee_no
  ) values
    ('JA523040701', 'YM523040701'),
    ('JA523070601', 'JA526022401'),
    ('JA523101103', 'JA525081901'),
    ('JA525090101', 'YM525090101'),
    ('TMP-SCHED-0020', 'YM525111702'),
    ('WD000649', 'ZJ00194'),
    ('WD000830', 'ZJ00193'),
    ('ZJ00144', 'WD001804'),
    ('TMP-SCHED-1757', '336225');

  update employee_private.employee_identity_reconcile_merge_plan plan
  set target_employee_id = target_employee.id
  from public.employees target_employee
  where public.employee_master_normalize_id(target_employee.employee_no) =
    plan.official_employee_no;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_employee_id = source_employee.id,
      source_present = true
  from public.employees source_employee
  where public.employee_master_normalize_id(source_employee.employee_no) =
    plan.previous_employee_no;

  -- A repeat run has no source employee row. Recover its immutable UUID only
  -- from the exact ledger tuple written by the first successful transaction.
  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_employee_id = ledger.source_employee_id
  from employee_private.employee_identity_merge_ledger ledger
  where plan.source_employee_id is null
    and ledger.migration_key = '2026-09-01:' || plan.previous_employee_no
    and public.employee_master_normalize_id(ledger.previous_employee_no) =
      plan.previous_employee_no
    and public.employee_master_normalize_id(ledger.official_employee_no) =
      plan.official_employee_no
    and ledger.target_employee_id = plan.target_employee_id;

  if (select count(*) from employee_private.employee_identity_reconcile_merge_plan
      where source_employee_id is not null
        and target_employee_id is not null
        and source_employee_id <> target_employee_id) <> 9
     or exists (
       select 1
       from employee_private.employee_identity_merge_ledger ledger
       join employee_private.employee_identity_reconcile_merge_plan plan
         on ledger.migration_key =
              '2026-09-01:' || plan.previous_employee_no
           or public.employee_master_normalize_id(
                ledger.previous_employee_no
              ) = plan.previous_employee_no
           or public.employee_master_normalize_id(
                ledger.official_employee_no
              ) = plan.official_employee_no
       where ledger.migration_key <>
               '2026-09-01:' || plan.previous_employee_no
          or public.employee_master_normalize_id(
               ledger.previous_employee_no
             ) <> plan.previous_employee_no
          or public.employee_master_normalize_id(
               ledger.official_employee_no
             ) <> plan.official_employee_no
          or ledger.source_employee_id <> plan.source_employee_id
          or ledger.target_employee_id <> plan.target_employee_id
     ) then
    raise exception 'confirmed_identity_merge_pair_preflight_failed';
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_merge_plan plan
    join public.employees source_employee
      on source_employee.id = plan.source_employee_id
    join public.employees target_employee
      on target_employee.id = plan.target_employee_id
    where lower(regexp_replace(
            btrim(source_employee.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          )) <> lower(regexp_replace(
            btrim(target_employee.full_name),
            '[[:space:][:punct:]]+', '', 'g'
          ))
  ) then
    raise exception 'confirmed_identity_merge_name_mismatch';
  end if;

  -- The duplicate source rows held some newer schedule-owned fields.  Capture
  -- one exact-name schedule row for every canonical target before deleting a
  -- source UUID, then copy only schedule-owned attributes.  Home-owned status,
  -- employment classification, source sheet and sensitive profile fields stay
  -- on the canonical employee.
  insert into
    employee_private.employee_identity_reconcile_target_schedule_fields (
      target_employee_id, official_employee_no, team_name, group_name,
      shift_name, country_name, position_name, platform_name, work_content,
      responsible, onsite_trainer, online_leader, online_trainer, source_row
    )
  select distinct on (plan.target_employee_id)
    plan.target_employee_id,
    plan.official_employee_no,
    nullif(btrim(item->>'team'), '') team_name,
    nullif(btrim(item->>'group'), '') group_name,
    nullif(public.employee_master_normalize_shift(
      item->>'shift'
    ), '') shift_name,
    nullif(btrim(item->>'country'), '') country_name,
    nullif(btrim(item->>'position'), '') position_name,
    nullif(btrim(item->>'platform'), '') platform_name,
    nullif(btrim(item->>'work_content'), '') work_content,
    nullif(btrim(item->>'responsible'), '') responsible,
    nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
    nullif(btrim(item->>'online_leader'), '') online_leader,
    nullif(btrim(item->>'online_trainer'), '') online_trainer,
    (item->>'source_row')::integer source_row
  from employee_private.employee_identity_reconcile_merge_plan plan
  join public.employees canonical
    on canonical.id = plan.target_employee_id
  join public.employee_master_source_snapshots snapshot
    on snapshot.source_key = 'home_schedule_roster_current'
  cross join lateral jsonb_array_elements(snapshot.payload) item
  where public.employee_master_normalize_id(item->>'employee_id') in (
          plan.official_employee_no,
          plan.previous_employee_no
        )
    and btrim(item->>'name_key') = lower(regexp_replace(
      btrim(canonical.full_name), '[[:space:][:punct:]]+', '', 'g'
    ))
  order by plan.target_employee_id,
    case
      when public.employee_master_normalize_id(item->>'employee_id') =
           plan.official_employee_no then 0
      else 1
    end,
    (item->>'source_row')::integer desc;

  if (select count(*)
      from employee_private.employee_identity_reconcile_target_schedule_fields) <> 9 then
    raise exception 'confirmed_identity_target_schedule_fields_missing';
  end if;

  insert into public.teams (name, status)
  select distinct schedule.team_name, 'active'
  from employee_private.employee_identity_reconcile_target_schedule_fields schedule
  where schedule.team_name is not null
    and not exists (
      select 1
      from public.teams team
      where lower(btrim(team.name)) = lower(btrim(schedule.team_name))
    );

  insert into public.positions (name, status)
  select distinct schedule.position_name, 'active'
  from employee_private.employee_identity_reconcile_target_schedule_fields schedule
  where schedule.position_name is not null
    and not exists (
      select 1
      from public.positions position
      where lower(btrim(position.name)) =
        lower(btrim(schedule.position_name))
    );

  with desired as (
    select schedule.*,
      team.id team_id,
      position.id position_id
    from employee_private.employee_identity_reconcile_target_schedule_fields schedule
    left join lateral (
      select candidate.id
      from public.teams candidate
      where lower(btrim(candidate.name)) =
        lower(btrim(schedule.team_name))
      order by case when candidate.status = 'active' then 0 else 1 end,
        candidate.id
      limit 1
    ) team on true
    left join lateral (
      select candidate.id
      from public.positions candidate
      where lower(btrim(candidate.name)) =
        lower(btrim(schedule.position_name))
      order by case when candidate.status = 'active' then 0 else 1 end,
        candidate.id
      limit 1
    ) position on true
  )
  update public.employees employee
  set team_id = desired.team_id,
      position_id = desired.position_id,
      shift_name = desired.shift_name,
      group_name = desired.group_name,
      platform_scope = desired.platform_name,
      work_content = desired.work_content,
      market_country = desired.team_name,
      schedule_position = desired.position_name,
      person_in_charge = desired.responsible,
      on_site_trainer = desired.onsite_trainer,
      online_leader = desired.online_leader,
      online_trainer = desired.online_trainer,
      official_id_pending = false,
      updated_at = clock_timestamp()
  from desired
  where employee.id = desired.target_employee_id
    and row(
      employee.team_id, employee.position_id,
      employee.shift_name, employee.group_name,
      employee.platform_scope, employee.work_content,
      employee.market_country, employee.schedule_position,
      employee.person_in_charge, employee.on_site_trainer,
      employee.online_leader, employee.online_trainer,
      employee.official_id_pending
    ) is distinct from row(
      desired.team_id, desired.position_id,
      desired.shift_name, desired.group_name,
      desired.platform_name, desired.work_content,
      desired.team_name, desired.position_name,
      desired.responsible, desired.onsite_trainer,
      desired.online_leader, desired.online_trainer,
      false
    );

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_target_schedule_fields schedule
    join public.employees employee
      on employee.id = schedule.target_employee_id
    left join lateral (
      select candidate.id
      from public.teams candidate
      where lower(btrim(candidate.name)) =
        lower(btrim(schedule.team_name))
      order by case when candidate.status = 'active' then 0 else 1 end,
        candidate.id
      limit 1
    ) team on true
    left join lateral (
      select candidate.id
      from public.positions candidate
      where lower(btrim(candidate.name)) =
        lower(btrim(schedule.position_name))
      order by case when candidate.status = 'active' then 0 else 1 end,
        candidate.id
      limit 1
    ) position on true
    where row(
      employee.team_id, employee.position_id,
      employee.shift_name, employee.group_name,
      employee.platform_scope, employee.work_content,
      employee.market_country, employee.schedule_position,
      employee.person_in_charge, employee.on_site_trainer,
      employee.online_leader, employee.online_trainer,
      employee.official_id_pending
    ) is distinct from row(
      team.id, position.id,
      schedule.shift_name, schedule.group_name,
      schedule.platform_name, schedule.work_content,
      schedule.team_name, schedule.position_name,
      schedule.responsible, schedule.onsite_trainer,
      schedule.online_leader, schedule.online_trainer,
      false
    )
  ) then
    raise exception 'confirmed_identity_schedule_fields_not_preserved';
  end if;

  select count(*)::integer
  into v_expected_merge
  from employee_private.employee_identity_reconcile_merge_plan plan
  where plan.source_present;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set source_kind = case
        when exists (
          select 1
          from public.employee_master_source_snapshots snapshot
          cross join lateral jsonb_array_elements(snapshot.payload) item
          where snapshot.source_key = 'home_employee_roster_current'
            and public.employee_master_normalize_id(
                  item->>'employee_id'
                ) in (
                  plan.official_employee_no,
                  plan.previous_employee_no
                )
        ) then 'home_roster'
        else 'schedule_roster'
      end,
      source_row = coalesce(
        (
          select min((item->>'source_row')::integer)
          from public.employee_master_source_snapshots snapshot
          cross join lateral jsonb_array_elements(snapshot.payload) item
          where snapshot.source_key = 'home_employee_roster_current'
            and public.employee_master_normalize_id(
                  item->>'employee_id'
                ) in (
                  plan.official_employee_no,
                  plan.previous_employee_no
                )
        ),
        (
          select min((item->>'source_row')::integer)
          from public.employee_master_source_snapshots snapshot
          cross join lateral jsonb_array_elements(snapshot.payload) item
          where snapshot.source_key = 'home_schedule_roster_current'
            and public.employee_master_normalize_id(
                  item->>'employee_id'
                ) in (
                  plan.official_employee_no,
                  plan.previous_employee_no
                )
        )
      );

  if exists (
    select 1 from employee_private.employee_identity_reconcile_merge_plan
    where source_kind is null or source_row is null
  ) then
    raise exception 'confirmed_identity_merge_source_row_missing';
  end if;

  insert into employee_private.employee_identity_reconcile_expected_fk values
    ('attendance_private', 'employee_resignation_sync_state', 'employee_id'),
    ('employee_private', 'employee_identity_merge_ledger', 'target_employee_id'),
    ('employee_private', 'employee_note_revisions', 'employee_id'),
    ('employee_private', 'employee_notes', 'employee_id'),
    ('payroll_private', 'employee_identity_aliases', 'employee_id'),
    ('public', 'admin_alert_events', 'employee_id'),
    ('public', 'audit_logs', 'employee_id'),
    ('public', 'employee_activation_codes', 'employee_id'),
    ('public', 'employee_attendance_records', 'employee_id'),
    ('public', 'employee_audit_logs', 'employee_id'),
    ('public', 'employee_compensation_legacy', 'employee_id'),
    ('public', 'employee_compensation_settings', 'employee_id'),
    ('public', 'employee_connectivity_incidents', 'employee_id'),
    ('public', 'employee_contact_profiles', 'employee_id'),
    ('public', 'employee_identity_rekeys', 'employee_id'),
    ('public', 'employee_lifecycle_events', 'employee_id'),
    ('public', 'employee_master_presence_state', 'employee_id'),
    ('public', 'employee_payment_profiles', 'employee_id'),
    ('public', 'employees', 'direct_leader_id'),
    ('public', 'employees', 'trainer_id'),
    ('public', 'exam_assignments', 'employee_id'),
    ('public', 'exam_sessions', 'employee_id'),
    ('public', 'legacy_exam_sessions', 'employee_id'),
    ('public', 'online_training_report_members', 'employee_id'),
    ('public', 'online_training_reports', 'author_employee_id'),
    ('public', 'payout_accounts', 'employee_id'),
    ('public', 'payout_change_requests', 'employee_id'),
    ('public', 'payroll_payslips', 'employee_id'),
    ('public', 'user_access', 'employee_id'),
    ('public', 'user_scope_employee_filters', 'employee_id'),
    ('public', 'user_scope_employees', 'employee_id'),
    ('session_private', 'online_training_roster_relationships', 'learner_employee_id'),
    ('session_private', 'online_training_roster_relationships', 'online_leader_employee_id'),
    ('session_private', 'online_training_roster_relationships', 'online_trainer_employee_id'),
    ('session_private', 'online_training_roster_relationships', 'onsite_trainer_employee_id'),
    ('session_private', 'online_training_roster_relationships', 'responsible_employee_id');

  if exists (
    with actual as (
      select namespace.nspname schema_name,
        relation.relname table_name,
        attribute.attname column_name
      from pg_catalog.pg_constraint constraint_row
      join pg_catalog.pg_class relation
        on relation.oid = constraint_row.conrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      cross join lateral unnest(constraint_row.conkey) key_column(attnum)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
      where constraint_row.contype = 'f'
        and constraint_row.confrelid = 'public.employees'::regclass
    )
    select 1
    from (
      (select schema_name, table_name, column_name from actual
       except
       select schema_name, table_name, column_name
       from employee_private.employee_identity_reconcile_expected_fk)
      union all
      (select schema_name, table_name, column_name
       from employee_private.employee_identity_reconcile_expected_fk
       except
       select schema_name, table_name, column_name from actual)
    ) difference
  ) then
    raise exception 'employee_identity_fk_inventory_changed';
  end if;

  for v_ref in
    select * from employee_private.employee_identity_reconcile_expected_fk
    order by schema_name, table_name, column_name
  loop
    execute format(
      'update employee_private.employee_identity_reconcile_merge_plan plan '
      || 'set moved_reference_counts = plan.moved_reference_counts '
      || '|| jsonb_build_object(%L, ('
      || 'select count(*) from %I.%I referenced '
      || 'where referenced.%I = plan.source_employee_id), %L, ('
      || 'select count(*) from %I.%I referenced '
      || 'where referenced.%I = plan.target_employee_id))',
      v_ref.schema_name || '.' || v_ref.table_name || '.' ||
        v_ref.column_name,
      v_ref.schema_name, v_ref.table_name, v_ref.column_name,
      v_ref.schema_name || '.' || v_ref.table_name || '.' ||
        v_ref.column_name || ':target_before',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name
    );
  end loop;

  if to_regclass(
       'attendance_private.historical_employee_directory_cache'
     ) is null then
    raise exception 'historical_employee_directory_cache_missing';
  end if;

  update employee_private.employee_identity_reconcile_merge_plan plan
  set moved_reference_counts = plan.moved_reference_counts ||
    jsonb_build_object(
      'attendance_private.historical_employee_directory_cache.current_employee_id',
      (
        select count(*)
        from attendance_private.historical_employee_directory_cache cache
        where cache.current_employee_id = plan.source_employee_id
      ),
      'attendance_private.historical_employee_directory_cache.current_employee_id:target_before',
      (
        select count(*)
        from attendance_private.historical_employee_directory_cache cache
        where cache.current_employee_id = plan.target_employee_id
      )
    );

  insert into employee_private.employee_identity_merge_ledger (
    migration_key, source_employee_id, target_employee_id,
    previous_employee_no, official_employee_no, full_name,
    previous_employee_snapshot, moved_reference_counts,
    reason, approved_by, merged_at
  )
  select
    '2026-09-01:' || plan.previous_employee_no,
    plan.source_employee_id, plan.target_employee_id,
    plan.previous_employee_no, plan.official_employee_no,
    target_employee.full_name, to_jsonb(source_employee),
    plan.moved_reference_counts,
    'User confirmed old and official IDs represent the same person.',
    'user-confirmed-2026-09-01', clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join public.employees source_employee
    on source_employee.id = plan.source_employee_id
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  where plan.source_present
  on conflict (migration_key) do nothing;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      join employee_private.employee_identity_merge_ledger ledger
        on ledger.migration_key =
             '2026-09-01:' || plan.previous_employee_no
       and ledger.source_employee_id = plan.source_employee_id
       and ledger.target_employee_id = plan.target_employee_id
       and public.employee_master_normalize_id(
             ledger.previous_employee_no
           ) = plan.previous_employee_no
       and public.employee_master_normalize_id(
             ledger.official_employee_no
           ) = plan.official_employee_no) <> 9 then
    raise exception 'employee_identity_merge_ledger_write_failed';
  end if;

  update attendance_private.historical_employee_directory_cache cache
  set current_employee_id = plan.target_employee_id
  from employee_private.employee_identity_reconcile_merge_plan plan
  where cache.current_employee_id = plan.source_employee_id;

  if exists (
    select 1
    from attendance_private.historical_employee_directory_cache cache
    join employee_private.employee_identity_reconcile_merge_plan plan
      on cache.current_employee_id = plan.source_employee_id
  ) then
    raise exception 'historical_employee_directory_cache_source_remains';
  end if;

  if (select count(*)
      from attendance_private.historical_employee_directory_cache cache
      join employee_private.employee_identity_reconcile_merge_plan plan
        on cache.current_employee_id = plan.target_employee_id) <>
     (select coalesce(sum(
        coalesce((plan.moved_reference_counts->>
          'attendance_private.historical_employee_directory_cache.current_employee_id')::bigint, 0)
        + coalesce((plan.moved_reference_counts->>
          'attendance_private.historical_employee_directory_cache.current_employee_id:target_before')::bigint, 0)
      ), 0)
      from employee_private.employee_identity_reconcile_merge_plan plan) then
    raise exception
      'historical_employee_directory_cache_reference_count_changed';
  end if;

  -- Presence is a derived one-row state and both UUIDs may already have one.
  -- Keep the canonical row and rebuild it from the accepted source snapshots.
  delete from public.employee_master_presence_state presence
  using employee_private.employee_identity_reconcile_merge_plan plan
  where presence.employee_id = plan.source_employee_id;

  for v_ref in
    select *
    from employee_private.employee_identity_reconcile_expected_fk
    where not (
      schema_name = 'public'
      and table_name = 'employee_master_presence_state'
      and column_name = 'employee_id'
    )
      and not (
        schema_name = 'employee_private'
        and table_name = 'employee_identity_merge_ledger'
        and column_name = 'target_employee_id'
      )
    order by schema_name, table_name, column_name
  loop
    execute format(
      'update %I.%I referenced set %I = plan.target_employee_id '
      || 'from employee_private.employee_identity_reconcile_merge_plan plan '
      || 'where referenced.%I = plan.source_employee_id',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name,
      v_ref.column_name
    );
  end loop;

  if exists (
    select 1
    from public.employee_identity_rekeys rekey
    join employee_private.employee_identity_reconcile_merge_plan plan
      on public.employee_master_normalize_id(rekey.official_employee_no) =
           plan.official_employee_no
        or public.employee_master_normalize_id(rekey.previous_employee_no) =
           plan.previous_employee_no
    where rekey.employee_id <> plan.target_employee_id
       or public.employee_master_normalize_id(rekey.official_employee_no) <>
            plan.official_employee_no
       or public.employee_master_normalize_id(rekey.previous_employee_no) <>
            plan.previous_employee_no
  ) then
    raise exception 'employee_identity_rekey_target_conflict';
  end if;

  for v_ref in
    select * from employee_private.employee_identity_reconcile_expected_fk
    order by schema_name, table_name, column_name
  loop
    execute format(
      'select count(*) from %I.%I referenced '
      || 'join employee_private.employee_identity_reconcile_merge_plan plan '
      || 'on referenced.%I = plan.source_employee_id',
      v_ref.schema_name, v_ref.table_name, v_ref.column_name
    ) into v_left;
    if v_left <> 0 then
      raise exception 'employee_identity_source_reference_remains: %.%.%=%',
        v_ref.schema_name, v_ref.table_name, v_ref.column_name, v_left;
    end if;


    if not (
         v_ref.schema_name = 'public'
         and v_ref.table_name = 'employee_master_presence_state'
         and v_ref.column_name = 'employee_id'
       )
       and not (
         v_ref.schema_name = 'employee_private'
         and v_ref.table_name = 'employee_identity_merge_ledger'
         and v_ref.column_name = 'target_employee_id'
       ) then
      execute format(
        'select ('
        || 'select count(*) from %I.%I referenced '
        || 'join employee_private.employee_identity_reconcile_merge_plan plan '
        || 'on referenced.%I = plan.target_employee_id) = ('
        || 'select coalesce(sum('
        || 'coalesce((plan.moved_reference_counts->>%L)::bigint,0) + '
        || 'coalesce((plan.moved_reference_counts->>%L)::bigint,0)'
        || '),0) from employee_private.employee_identity_reconcile_merge_plan plan)',
        v_ref.schema_name, v_ref.table_name, v_ref.column_name,
        v_ref.schema_name || '.' || v_ref.table_name || '.' ||
          v_ref.column_name,
        v_ref.schema_name || '.' || v_ref.table_name || '.' ||
          v_ref.column_name || ':target_before'
      ) into v_reference_preserved;
      if not coalesce(v_reference_preserved, false) then
        raise exception
          'employee_identity_target_reference_count_changed: %.%.%',
          v_ref.schema_name, v_ref.table_name, v_ref.column_name;
      end if;
    end if;
  end loop;

  insert into public.employee_identity_rekeys (
    employee_id, previous_employee_no, official_employee_no,
    source_kind, source_row, run_id, created_at
  )
  select plan.target_employee_id, plan.previous_employee_no,
    plan.official_employee_no, plan.source_kind, plan.source_row,
    v_latest_run_id, clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  on conflict (official_employee_no) do update
  set employee_id = excluded.employee_id,
      previous_employee_no = excluded.previous_employee_no,
      source_kind = excluded.source_kind,
      source_row = excluded.source_row,
      run_id = excluded.run_id;

  if (select count(*)
      from public.employee_identity_rekeys rekey
      join employee_private.employee_identity_reconcile_merge_plan plan
        on rekey.employee_id = plan.target_employee_id
       and public.employee_master_normalize_id(
             rekey.previous_employee_no
           ) = plan.previous_employee_no
       and public.employee_master_normalize_id(
             rekey.official_employee_no
           ) = plan.official_employee_no) <> 9 then
    raise exception 'employee_identity_rekey_write_failed';
  end if;

  delete from public.employees employee
  using employee_private.employee_identity_reconcile_merge_plan plan
  where plan.source_present
    and employee.id = plan.source_employee_id;
  get diagnostics v_merged = row_count;
  if v_merged <> v_expected_merge then
    raise exception 'employee_identity_duplicate_delete_count:%', v_merged;
  end if;

  -- Pre-reserve every retired number in payroll's own alias cache.  Its
  -- ordinary and bulk legacy matchers write this table before the final
  -- payslip trigger runs; owning the key here prevents either matcher from
  -- first attaching the old number to a different same-name employee.  Any
  -- pre-existing third-party ownership is left untouched and the exact
  -- assertion below aborts the transaction.
  insert into payroll_private.employee_identity_aliases (
    old_employee_no_key, old_employee_no_raw, employee_id,
    employee_no_at_match, full_name_key, hire_date, match_source,
    first_batch_id, first_source_row, last_batch_id, last_source_row,
    created_by, updated_at
  )
  select
    employee_private.employee_identity_key(plan.previous_employee_no),
    plan.previous_employee_no,
    plan.target_employee_id,
    target_employee.employee_no,
    internal.payroll_name_key(ledger.full_name),
    target_employee.hire_date,
    'confirmed_employee_id_alias',
    null, null, null, null, null, clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join employee_private.employee_identity_merge_ledger ledger
    on ledger.migration_key =
         '2026-09-01:' || plan.previous_employee_no
   and ledger.target_employee_id = plan.target_employee_id
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  on conflict (old_employee_no_key) do update
  set employee_id = excluded.employee_id,
      old_employee_no_raw = excluded.old_employee_no_raw,
      employee_no_at_match = excluded.employee_no_at_match,
      full_name_key = excluded.full_name_key,
      hire_date = excluded.hire_date,
      match_source = excluded.match_source,
      updated_at = clock_timestamp()
  where payroll_private.employee_identity_aliases.employee_id is null
     or payroll_private.employee_identity_aliases.employee_id =
          excluded.employee_id;

  if (select count(*)
      from employee_private.employee_identity_reconcile_merge_plan plan
      join employee_private.employee_identity_merge_ledger ledger
        on ledger.migration_key =
             '2026-09-01:' || plan.previous_employee_no
       and ledger.target_employee_id = plan.target_employee_id
      join public.employees target_employee
        on target_employee.id = plan.target_employee_id
      join payroll_private.employee_identity_aliases alias
        on alias.old_employee_no_key =
             employee_private.employee_identity_key(
               plan.previous_employee_no
             )
       and alias.employee_id = plan.target_employee_id
       and alias.employee_no_at_match = target_employee.employee_no
       and alias.full_name_key =
             internal.payroll_name_key(ledger.full_name)
       and alias.hire_date is not distinct from target_employee.hire_date
       and alias.match_source = 'confirmed_employee_id_alias') <> 9 then
    raise exception 'payroll_confirmed_employee_alias_reservation_failed';
  end if;

  insert into public.employee_audit_logs (
    employee_id, employee_no, full_name, action, source,
    actor_username, changes, metadata, created_at
  )
  select target_employee.id, target_employee.employee_no,
    target_employee.full_name, 'identity_merge_confirmed',
    'employee_master_reconciliation', 'system',
    jsonb_build_object(
      'employee_no', jsonb_build_object(
        'from', plan.previous_employee_no,
        'to', plan.official_employee_no
      )
    ),
    jsonb_build_object(
      'previous_employee_id', plan.source_employee_id,
      'canonical_employee_id', plan.target_employee_id,
      'history_preserved', true,
      'approval', 'user-confirmed-2026-09-01'
    ), clock_timestamp()
  from employee_private.employee_identity_reconcile_merge_plan plan
  join public.employees target_employee
    on target_employee.id = plan.target_employee_id
  where not exists (
    select 1
    from public.employee_audit_logs existing_audit
    where existing_audit.employee_id = plan.target_employee_id
      and existing_audit.action = 'identity_merge_confirmed'
      and existing_audit.source = 'employee_master_reconciliation'
      and existing_audit.metadata->>'previous_employee_id' =
        plan.source_employee_id::text
      and existing_audit.metadata->>'canonical_employee_id' =
        plan.target_employee_id::text
  );

  -- These are the only unresolved current schedule identities approved for
  -- manual review.  Same employee number is not enough: the canonical and
  -- schedule normalized names must also agree before schedule data can update
  -- a profile.  Exact two-way EXCEPT checks make a stale production snapshot
  -- abort atomically instead of silently broadening the exception set.
  insert into employee_private.employee_identity_reconcile_expected_name_mismatch values
    ('JA522042301', '胜建mul', '胜建'),
    ('JA522110702', '小文', '小福'),
    ('JA523041402', '阿零', '啊零'),
    ('JA524012701', 'cuong世强', '世强'),
    ('JA524070102', 'gairi盖瑞', 'gairi'),
    ('JA525082203', 'vin大龙', '大龙'),
    ('JA525120501', 'xiaofen', '小分'),
    ('JA525120704', 'lili', '丽丽'),
    ('JA525122801', 'zeffri', '程章祥'),
    ('JA526041401', 'finka', 'finka啊萍'),
    ('JA526041701', 'johanindrawan', 'johanindrawan世浩'),
    ('YM525030702', '阿贵', '阿贵2');

  insert into
    employee_private.employee_identity_reconcile_actual_name_mismatch (
      employee_no, employee_name_key, schedule_name_key, employee_name,
      schedule_name, schedule_source_row
    )
  select
    public.employee_master_normalize_id(item->>'employee_id') employee_no,
    lower(regexp_replace(
      btrim(employee.full_name), '[[:space:][:punct:]]+', '', 'g'
    )) employee_name_key,
    btrim(item->>'name_key') schedule_name_key,
    employee.full_name employee_name,
    btrim(item->>'name') schedule_name,
    (item->>'source_row')::integer schedule_source_row
  from public.employee_master_source_snapshots snapshot
  cross join lateral jsonb_array_elements(snapshot.payload) item
  join public.employees employee
    on public.employee_master_normalize_id(employee.employee_no) =
      public.employee_master_normalize_id(item->>'employee_id')
  where snapshot.source_key = 'home_schedule_roster_current'
    and employee.status in ('active', 'probation', 'suspended')
    and coalesce(employee.source_type, '') <> 'google_deleted'
    and not coalesce((item->>'onsite_marker')::boolean, false)
    and lower(regexp_replace(
          btrim(employee.full_name), '[[:space:][:punct:]]+', '', 'g'
        )) <> btrim(item->>'name_key')
    and not exists (
      select 1
      from public.employee_master_source_snapshots home_snapshot
      cross join lateral jsonb_array_elements(home_snapshot.payload) home_item
      where home_snapshot.source_key = 'home_employee_roster_current'
        and public.employee_master_normalize_id(
              home_item->>'employee_id'
            ) = public.employee_master_normalize_id(item->>'employee_id')
        and not coalesce(
          (home_item->>'explicitly_resigned')::boolean,
          false
        )
    );

  if (select count(*)
      from employee_private.employee_identity_reconcile_actual_name_mismatch) <> 12
     or exists (
       (select employee_no, employee_name_key, schedule_name_key
        from employee_private.employee_identity_reconcile_actual_name_mismatch
        except
        select employee_no, employee_name_key, schedule_name_key
        from employee_private.employee_identity_reconcile_expected_name_mismatch)
       union all
       (select employee_no, employee_name_key, schedule_name_key
        from employee_private.employee_identity_reconcile_expected_name_mismatch
        except
        select employee_no, employee_name_key, schedule_name_key
        from employee_private.employee_identity_reconcile_actual_name_mismatch)
     ) then
    raise exception 'employee_identity_name_mismatch_set_changed';
  end if;

  insert into employee_private.employee_identity_reconcile_source_presence (
    employee_no, home_present, schedule_present, schedule_name_mismatch
  )
  select source.employee_no,
    bool_or(source.home_present) home_present,
    bool_or(source.schedule_present) schedule_present,
    bool_or(source.schedule_name_mismatch) schedule_name_mismatch
  from (
    select public.employee_master_normalize_id(
      accepted_employee.employee_no
    ) employee_no,
      true home_present, false schedule_present,
      false schedule_name_mismatch
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    join public.employees accepted_employee
      on accepted_employee.id =
        employee_private.resolve_confirmed_employee_id(
          item->>'employee_id'
        )
     and accepted_employee.status in ('active', 'probation', 'suspended')
     and coalesce(accepted_employee.source_type, '') <> 'google_deleted'
    where snapshot.source_key = 'home_employee_roster_current'
      and not coalesce((item->>'explicitly_resigned')::boolean, false)
    union all
    select public.employee_master_normalize_id(
      accepted_employee.employee_no
    ),
      false, true,
      lower(regexp_replace(
        btrim(accepted_employee.full_name),
        '[[:space:][:punct:]]+', '', 'g'
      )) <> btrim(item->>'name_key')
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    join public.employees accepted_employee
      on accepted_employee.id =
        employee_private.resolve_confirmed_employee_id(
          item->>'employee_id'
        )
     and accepted_employee.status in ('active', 'probation', 'suspended')
     and coalesce(accepted_employee.source_type, '') <> 'google_deleted'
    where snapshot.source_key = 'home_schedule_roster_current'
  ) source
  where nullif(source.employee_no, '') is not null
  group by source.employee_no;

  insert into public.employee_master_presence_state as state (
    employee_id, missing_streak, first_missing_at, last_missing_at,
    last_present_at, auto_archived, eligible_for_disable,
    account_review_required, last_home_present, last_schedule_present,
    last_run_id, updated_at
  )
  select employee.id, 0, null, null, v_latest_captured_at,
    false, false, presence.schedule_name_mismatch, presence.home_present,
    presence.schedule_present, v_latest_run_id, clock_timestamp()
  from public.employees employee
  join employee_private.employee_identity_reconcile_source_presence presence
    on presence.employee_no =
      public.employee_master_normalize_id(employee.employee_no)
  where employee.status in ('active', 'probation', 'suspended')
    and coalesce(employee.source_type, '') <> 'google_deleted'
    and public.employee_master_normalize_id(employee.employee_no)
      not in ('SYSTEM', 'ADMIN')
  on conflict (employee_id) do update
  set missing_streak = 0,
      first_missing_at = null,
      last_missing_at = null,
      last_present_at = excluded.last_present_at,
      auto_archived = false,
      auto_archived_at = null,
      eligible_for_disable = false,
      account_review_required = excluded.account_review_required,
      last_home_present = excluded.last_home_present,
      last_schedule_present = excluded.last_schedule_present,
      last_run_id = excluded.last_run_id,
      updated_at = clock_timestamp();

  delete from public.employee_master_presence_state state
  using public.employees employee
  where employee.id = state.employee_id
    and coalesce(employee.source_type, '') = 'google_deleted';

  if exists (
    select 1
    from public.employees employee
    where employee.status in ('active', 'probation', 'suspended')
      and coalesce(employee.source_type, '') <> 'google_deleted'
      and public.employee_master_normalize_id(employee.employee_no)
        not in ('SYSTEM', 'ADMIN')
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_source_presence presence
        where presence.employee_no =
          public.employee_master_normalize_id(employee.employee_no)
      )
  ) then
    raise exception 'current_employee_missing_from_both_sources_after_merge';
  end if;

  -- Every unmarked schedule-only row must now be either an exact current
  -- ID/name match or one of the twelve frozen name-mismatch review rows.
  if exists (
    select 1
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    where snapshot.source_key = 'home_schedule_roster_current'
      and not coalesce((item->>'onsite_marker')::boolean, false)
      and not exists (
        select 1
        from public.employee_master_source_snapshots home_snapshot
        cross join lateral jsonb_array_elements(
          home_snapshot.payload
          ) home_item
        where home_snapshot.source_key = 'home_employee_roster_current'
          and employee_private.resolve_confirmed_employee_id(
                home_item->>'employee_id'
              ) = employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              )
          and employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              ) is not null
          and not coalesce(
            (home_item->>'explicitly_resigned')::boolean,
            false
          )
      )
      and not exists (
        select 1
        from public.employees employee
        where employee.id = employee_private.resolve_confirmed_employee_id(
                item->>'employee_id'
              )
          and employee.status in ('active', 'probation', 'suspended')
          and coalesce(employee.source_type, '') <> 'google_deleted'
          and lower(regexp_replace(
                btrim(employee.full_name),
                '[[:space:][:punct:]]+', '', 'g'
              )) = btrim(item->>'name_key')
      )
      and not exists (
        select 1
        from employee_private.employee_identity_reconcile_actual_name_mismatch mismatch
        where mismatch.employee_no =
          public.employee_master_normalize_id(item->>'employee_id')
          and mismatch.schedule_name_key = btrim(item->>'name_key')
      )
  ) then
    raise exception 'unapproved_schedule_only_identity_remains';
  end if;

  -- Rebuild the retained cross-source mismatch warnings from the same two
  -- immutable current snapshots.  A count-only assertion could preserve a
  -- stale/wrong set of 29 rows; the exact ID, source rows and both names are
  -- the review evidence.
  insert into
    employee_private.employee_identity_reconcile_cross_name_mismatch (
      employee_no, home_source_row, schedule_source_row, home_name,
      schedule_name
    )
  select
    public.employee_master_normalize_id(
      schedule_item->>'employee_id'
    ) employee_no,
    (home_item->>'source_row')::integer home_source_row,
    (schedule_item->>'source_row')::integer schedule_source_row,
    btrim(home_item->>'name') home_name,
    btrim(schedule_item->>'name') schedule_name
  from public.employee_master_source_snapshots schedule_snapshot
  cross join lateral jsonb_array_elements(
    schedule_snapshot.payload
  ) schedule_item
  join public.employee_master_source_snapshots home_snapshot
    on home_snapshot.source_key = 'home_employee_roster_current'
  cross join lateral jsonb_array_elements(home_snapshot.payload) home_item
  where schedule_snapshot.source_key = 'home_schedule_roster_current'
    and public.employee_master_normalize_id(home_item->>'employee_id') =
      public.employee_master_normalize_id(
        schedule_item->>'employee_id'
      )
    and not coalesce(
      (home_item->>'explicitly_resigned')::boolean,
      false
    )
    and btrim(home_item->>'name_key') <>
      btrim(schedule_item->>'name_key');

  if (select count(*)
      from employee_private.employee_identity_reconcile_cross_name_mismatch) <> 29 then
    raise exception 'cross_source_name_mismatch_snapshot_set_changed';
  end if;

  delete from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id
    and issue.issue_code = 'cross_source_name_mismatch';

  insert into public.employee_master_sync_issues (
    run_id, issue_code, employee_no, home_source_row,
    schedule_source_row, details
  )
  select v_latest_run_id, 'cross_source_name_mismatch',
    mismatch.employee_no, mismatch.home_source_row,
    mismatch.schedule_source_row,
    jsonb_build_object(
      'home_name', mismatch.home_name,
      'schedule_name', mismatch.schedule_name
    )
  from employee_private.employee_identity_reconcile_cross_name_mismatch mismatch
  order by mismatch.employee_no, mismatch.home_source_row,
    mismatch.schedule_source_row;

  delete from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id
    and issue.issue_code in (
      'pending_manual_review',
      'schedule_only_missing_onsite_marker'
    );

  insert into public.employee_master_sync_issues (
    run_id, issue_code, employee_no, schedule_source_row, details
  )
  select v_latest_run_id,
    'schedule_only_missing_onsite_marker',
    mismatch.employee_no,
    mismatch.schedule_source_row,
    jsonb_build_object(
      'reason', 'canonical_name_mismatch',
      'action', 'manual_review_no_automatic_identity_change',
      'home_name', mismatch.employee_name,
      'schedule_name', mismatch.schedule_name,
      'account_review_required', true
    )
  from employee_private.employee_identity_reconcile_actual_name_mismatch mismatch
  order by mismatch.employee_no;

  -- Rebuild the current discrepancy set from the live sources.  The latest
  -- accepted schedule now contains every effective home employee, so no
  -- one-time home-only exception may survive this reconciliation.
  delete from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id
    and issue.issue_code = 'home_only_missing_schedule';

  delete from public.employee_master_sync_issues issue
  using employee_private.employee_identity_reconcile_merge_plan plan
  where issue.run_id = v_latest_run_id
    and issue.issue_code in (
      'temporary_and_official_records_both_exist',
      'temporary_official_id_name_only_manual_review'
    )
    and public.employee_master_normalize_id(issue.employee_no) =
      plan.official_employee_no;

  if (select count(*)
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code = 'pending_manual_review') <> 0 then
    raise exception 'stale_pending_manual_review_issue_remains';
  end if;

  if (select count(*)
      from public.employee_master_sync_issues issue
      where issue.run_id = v_latest_run_id
        and issue.issue_code =
          'schedule_only_missing_onsite_marker') <> 12
     or exists (
       (select public.employee_master_normalize_id(issue.employee_no)
          employee_no
        from public.employee_master_sync_issues issue
        where issue.run_id = v_latest_run_id
          and issue.issue_code =
            'schedule_only_missing_onsite_marker'
        except
        select mismatch.employee_no
        from employee_private.employee_identity_reconcile_expected_name_mismatch mismatch)
       union all
       (select mismatch.employee_no
        from employee_private.employee_identity_reconcile_expected_name_mismatch mismatch
        except
        select public.employee_master_normalize_id(issue.employee_no)
        from public.employee_master_sync_issues issue
        where issue.run_id = v_latest_run_id
          and issue.issue_code =
            'schedule_only_missing_onsite_marker')
     ) then
    raise exception 'employee_identity_name_mismatch_issue_set_changed';
  end if;

  if exists (
    select 1
    from public.employee_master_sync_issues issue
    where issue.run_id = v_latest_run_id
      and issue.issue_code = 'schedule_only_missing_onsite_marker'
      and (
        issue.details->>'reason' <> 'canonical_name_mismatch'
        or issue.details->>'action' <>
          'manual_review_no_automatic_identity_change'
        or issue.details->>'home_name' is null
        or issue.details->>'schedule_name' is null
        or issue.details->>'account_review_required' <> 'true'
      )
  ) then
    raise exception 'employee_identity_name_mismatch_issue_detail_changed';
  end if;

  if exists (
    select 1
    from public.employee_master_sync_issues issue
    where issue.run_id = v_latest_run_id
      and issue.issue_code = 'home_only_missing_schedule'
  ) then
    raise exception 'unexpected_home_only_employee_issue_remains';
  end if;

  if (select count(*)
      from public.employee_master_presence_state state
      join public.employees employee
        on employee.id = state.employee_id
      join employee_private.employee_identity_reconcile_expected_name_mismatch mismatch
        on mismatch.employee_no =
          public.employee_master_normalize_id(employee.employee_no)
      where state.last_run_id = v_latest_run_id
        and state.last_schedule_present
        and state.account_review_required
        and state.missing_streak = 0) <> 12 then
    raise exception 'employee_identity_name_mismatch_presence_state_changed';
  end if;

  if exists (
    select 1
    from public.employee_master_sync_issues issue
    join public.employees employee
      on public.employee_master_normalize_id(employee.employee_no) =
        public.employee_master_normalize_id(issue.employee_no)
    where issue.run_id = v_latest_run_id
      and coalesce(employee.source_type, '') = 'google_deleted'
  ) then
    raise exception 'google_deleted_employee_sync_issue_remains';
  end if;

  if exists (
    (select public.employee_master_normalize_id(issue.employee_no),
       issue.home_source_row, issue.schedule_source_row,
       issue.details->>'home_name', issue.details->>'schedule_name'
     from public.employee_master_sync_issues issue
     where issue.run_id = v_latest_run_id
       and issue.issue_code = 'cross_source_name_mismatch'
     except
     select mismatch.employee_no, mismatch.home_source_row,
       mismatch.schedule_source_row, mismatch.home_name,
       mismatch.schedule_name
     from employee_private.employee_identity_reconcile_cross_name_mismatch mismatch)
    union all
    (select mismatch.employee_no, mismatch.home_source_row,
       mismatch.schedule_source_row, mismatch.home_name,
       mismatch.schedule_name
     from employee_private.employee_identity_reconcile_cross_name_mismatch mismatch
     except
     select public.employee_master_normalize_id(issue.employee_no),
       issue.home_source_row, issue.schedule_source_row,
       issue.details->>'home_name', issue.details->>'schedule_name'
     from public.employee_master_sync_issues issue
     where issue.run_id = v_latest_run_id
       and issue.issue_code = 'cross_source_name_mismatch')
  ) then
    raise exception 'cross_source_name_mismatch_issue_set_changed';
  end if;

  select count(*)::integer
  into v_remaining_issue_count
  from public.employee_master_sync_issues issue
  where issue.run_id = v_latest_run_id;

  if v_parse_warning_count <> 3
     or v_remaining_issue_count <> 41
     or (select count(*)
         from public.employee_master_sync_issues issue
         where issue.run_id = v_latest_run_id
           and issue.issue_code = 'cross_source_name_mismatch') <> 29 then
    raise exception
      'employee_identity_reconciliation_warning_set_changed:%:%',
      v_parse_warning_count, v_remaining_issue_count;
  end if;

  update public.employee_master_sync_runs run
  set inserted_count = run.inserted_count + v_inserted,
      rekeyed_count = greatest(run.rekeyed_count, v_merged),
      pending_departure_count = (
        select count(*)::integer
        from public.employee_master_presence_state state
        where state.last_run_id = v_latest_run_id
          and state.missing_streak >= 1
      ),
      warning_count = v_parse_warning_count + v_remaining_issue_count
  where run.id = v_latest_run_id;

  if not exists (
    select 1
    from public.employee_master_sync_runs run
    where run.id = v_latest_run_id
      and run.warning_count = 44
  ) then
    raise exception 'employee_identity_reconciliation_warning_total_changed';
  end if;

  if exists (
    select 1
    from public.employee_master_source_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    join employee_private.employee_identity_merge_ledger ledger
      on employee_private.employee_identity_key(
           ledger.previous_employee_no
         ) = employee_private.employee_identity_key(
           item->>'employee_id'
         )
    join public.employees canonical
      on canonical.id = ledger.target_employee_id
    where snapshot.source_key = 'home_schedule_roster_current'
      and coalesce(
            nullif(btrim(item->>'name_key'), ''),
            lower(regexp_replace(
              btrim(coalesce(item->>'name', '')),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          ) not in (
            lower(regexp_replace(
              btrim(ledger.full_name),
              '[[:space:][:punct:]]+', '', 'g'
            )),
            lower(regexp_replace(
              btrim(canonical.full_name),
              '[[:space:][:punct:]]+', '', 'g'
            ))
          )
  ) then
    raise exception 'confirmed_employee_alias_name_mismatch';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'source_row', (item->>'source_row')::integer,
      'employee_id', coalesce(
        nullif(
          public.employee_master_normalize_id(canonical.employee_no),
          ''
        ),
        public.employee_master_normalize_id(item->>'employee_id')
      ),
      'name', btrim(item->>'name'),
      'team', nullif(btrim(item->>'team'), ''),
      'group', nullif(btrim(item->>'group'), ''),
      'position', nullif(btrim(item->>'position'), ''),
      'country', nullif(btrim(item->>'country'), ''),
      'shift', nullif(btrim(item->>'shift'), ''),
      'platform', nullif(btrim(item->>'platform'), ''),
      'work_content', nullif(btrim(item->>'work_content'), ''),
      'responsible', nullif(btrim(item->>'responsible'), ''),
      'onsite_trainer', nullif(btrim(item->>'onsite_trainer'), ''),
      'online_leader', nullif(btrim(item->>'online_leader'), ''),
      'online_trainer', nullif(btrim(item->>'online_trainer'), '')
    ) order by (item->>'source_row')::integer
  ), '[]'::jsonb)
  into v_directory_rows
  from public.employee_master_source_snapshots snapshot
  cross join lateral jsonb_array_elements(snapshot.payload) item
  left join employee_private.employee_identity_merge_ledger ledger
    on employee_private.employee_identity_key(
         ledger.previous_employee_no
       ) = employee_private.employee_identity_key(item->>'employee_id')
  left join public.employees canonical
    on canonical.id = ledger.target_employee_id
  where snapshot.source_key = 'home_schedule_roster_current';

  if jsonb_array_length(v_directory_rows) <> v_schedule_count then
    raise exception 'full_schedule_directory_rebuild_count_mismatch';
  end if;

  execute $directory_identity_shape$
    select
      count(*) filter (
        where nullif(
          public.employee_master_normalize_id(item->>'employee_id'), ''
        ) is not null
      )::integer,
      count(distinct public.employee_master_normalize_id(
        item->>'employee_id'
      )) filter (
        where nullif(
          public.employee_master_normalize_id(item->>'employee_id'), ''
        ) is not null
      )::integer
    from jsonb_array_elements($1::jsonb) item
  $directory_identity_shape$
  into v_directory_nonblank_count, v_directory_distinct_count
  using v_directory_rows;

  if v_directory_nonblank_count <> v_schedule_count
     or v_directory_distinct_count <> v_schedule_count then
    raise exception using
      errcode = '22023',
      message = 'full_schedule_directory_identity_shape_mismatch',
      detail = jsonb_build_object(
        'input_rows', jsonb_array_length(v_directory_rows),
        'nonblank_employee_ids', v_directory_nonblank_count,
        'distinct_employee_ids', v_directory_distinct_count,
        'schedule_count', v_schedule_count
      )::text;
  end if;

  perform public.sync_schedule_employee_assignments(v_directory_rows);

  update public.report_sheet_snapshots snapshot
  set payload = v_directory_rows,
      row_count = jsonb_array_length(v_directory_rows),
      synced_at = clock_timestamp(),
      note = 'employee-master-full-schedule-v4;identity-reconciled;run:' ||
        v_latest_run_id::text
  where snapshot.source = '居家排班表/填表';
  if not found then
    raise exception 'schedule_report_snapshot_missing';
  end if;

  -- Call the deepest directory writer directly so its historical wrapper does
  -- not rebuild every assigned scope here.  Preserve the current online-
  -- training relationship isolation behavior, then perform one explicit scope
  -- rebuild only after every canonical UUID and directory row is final.
  v_directory_result :=
    public.sync_report_employee_directory_scope_inner_v1(v_directory_rows);

  -- inline_directory_cache_diff_reconcile_v1
  -- Keep this comparison in the reconciliation function itself. Both a nested SQL
  -- function and a static PL/pgSQL CTE exposed this variable's initial [] and
  -- the pre-writer cache snapshot in production.  Fixed SQL plus USING forces
  -- a fresh SPI plan/snapshot without interpolating roster data.
  execute $directory_cache_diff_reconcile$
  with expected as materialized (
    select distinct on (upper(btrim(item->>'employee_id')))
      upper(btrim(item->>'employee_id')) employee_no,
      case
        when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer
      end source_row,
      nullif(btrim(item->>'name'), '') full_name,
      nullif(btrim(item->>'team'), '') team_name,
      nullif(btrim(item->>'group'), '') group_name,
      nullif(btrim(item->>'position'), '') position_name,
      nullif(btrim(item->>'country'), '') country_name,
      nullif(btrim(item->>'shift'), '') shift_name,
      nullif(btrim(item->>'platform'), '') platform_name,
      nullif(btrim(item->>'responsible'), '') responsible,
      nullif(btrim(item->>'onsite_trainer'), '') onsite_trainer,
      nullif(btrim(item->>'online_leader'), '') online_leader,
      nullif(btrim(item->>'online_trainer'), '') online_trainer
    from jsonb_array_elements($1::jsonb) item
    where nullif(btrim(item->>'employee_id'), '') is not null
    order by upper(btrim(item->>'employee_id')),
      case
        when coalesce(item->>'source_row', '') ~ '^\d+$'
          then (item->>'source_row')::integer
      end desc nulls last
  ), cached as materialized (
    select
      upper(btrim(directory.employee_no)) employee_no,
      directory.source_row,
      directory.full_name,
      directory.team_name,
      directory.group_name,
      directory.position_name,
      directory.country_name,
      directory.shift_name,
      directory.platform_name,
      directory.responsible,
      directory.onsite_trainer,
      directory.online_leader,
      directory.online_trainer
    from public.report_employee_directory_cache directory
    where directory.source_kind = 'roster'
  ), differences as materialized (
    select
      expected.employee_no,
      case
        when cached.employee_no is null then 'missing_cached'
        else 'field_mismatch'
      end difference_kind,
      case
        when cached.employee_no is null then array[]::text[]
        else array_remove(array[
          case when expected.source_row is distinct from cached.source_row
            then 'source_row' end,
          case when expected.full_name is distinct from cached.full_name
            then 'full_name' end,
          case when expected.team_name is distinct from cached.team_name
            then 'team_name' end,
          case when expected.group_name is distinct from cached.group_name
            then 'group_name' end,
          case
            when expected.position_name is distinct from cached.position_name
              then 'position_name'
          end,
          case when expected.country_name is distinct from cached.country_name
            then 'country_name' end,
          case when expected.shift_name is distinct from cached.shift_name
            then 'shift_name' end,
          case
            when expected.platform_name is distinct from cached.platform_name
              then 'platform_name'
          end,
          case when expected.responsible is distinct from cached.responsible
            then 'responsible' end,
          case
            when expected.onsite_trainer is distinct from cached.onsite_trainer
              then 'onsite_trainer'
          end,
          case
            when expected.online_leader is distinct from cached.online_leader
              then 'online_leader'
          end,
          case
            when expected.online_trainer is distinct from cached.online_trainer
              then 'online_trainer'
          end
        ], null)::text[]
      end differing_fields
    from expected
    left join cached using (employee_no)
    where cached.employee_no is null
       or row(
         expected.source_row, expected.full_name, expected.team_name,
         expected.group_name, expected.position_name, expected.country_name,
         expected.shift_name, expected.platform_name, expected.responsible,
         expected.onsite_trainer, expected.online_leader,
         expected.online_trainer
       ) is distinct from row(
         cached.source_row, cached.full_name, cached.team_name,
         cached.group_name, cached.position_name, cached.country_name,
         cached.shift_name, cached.platform_name, cached.responsible,
         cached.onsite_trainer, cached.online_leader,
         cached.online_trainer
       )

    union all

    select cached.employee_no, 'extra_cached', array[]::text[]
    from cached
    left join expected using (employee_no)
    where expected.employee_no is null
  )
  select jsonb_build_object(
    'comparison_version', 'inline_directory_cache_diff_reconcile_v1',
    'matches',
      (select count(*) from expected) > 0
      and not exists (select 1 from differences),
    'input_rows', jsonb_array_length($1::jsonb),
    'schedule_count', $2::integer,
    'expected_rows', (select count(*) from expected),
    'cached_roster_rows', (select count(*) from cached),
    'missing_cached', (
      select count(*) from differences
      where difference_kind = 'missing_cached'
    ),
    'extra_cached', (
      select count(*) from differences
      where difference_kind = 'extra_cached'
    ),
    'field_mismatch', (
      select count(*) from differences
      where difference_kind = 'field_mismatch'
    ),
    'samples', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'employee_no', sample.employee_no,
          'difference_kind', sample.difference_kind,
          'differing_fields', to_jsonb(sample.differing_fields)
        )
        order by sample.difference_kind, sample.employee_no
      )
      from (
        select difference.employee_no, difference.difference_kind,
          difference.differing_fields
        from differences difference
        order by difference.difference_kind, difference.employee_no
        limit 5
      ) sample
    ), '[]'::jsonb)
  )
  $directory_cache_diff_reconcile$
  into v_cache_diagnostic
  using v_directory_rows, v_schedule_count;
  if v_cache_diagnostic->>'comparison_version' is distinct from
       'inline_directory_cache_diff_reconcile_v1'
     or (v_cache_diagnostic->>'matches')::boolean is distinct from true then
    raise exception using
      errcode = '22023',
      message = 'full_schedule_directory_cache_mismatch_after_merge',
      detail = (
        coalesce(v_cache_diagnostic, '{}'::jsonb) ||
        jsonb_build_object(
          'writer_result', coalesce(v_directory_result, '{}'::jsonb)
        )
      )::text;
  end if;

  begin
    perform session_private.rebuild_online_training_roster_relationships(
      v_directory_rows
    );
  exception
    when sqlstate '22023' then
      get stacked diagnostics v_relationship_error = message_text;
      if v_relationship_error <> 'invalid_schedule_roster_rows'
         and v_relationship_error not like
           'schedule_roster_relationship_%' then
        raise;
      end if;
  end;

  perform pg_catalog.set_config(
    'scope_private.assigned_scope_rebuild_dirty', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.defer_assigned_scope_rebuild', 'off', true
  );
  perform pg_catalog.set_config(
    'scope_private.skip_rebuild', 'off', true
  );
  perform scope_private.rebuild_all_assigned_employee_scopes();

  if exists (
    with effective_active as (
      select public.employee_master_normalize_id(employee.employee_no)
        employee_no
      from public.employees employee
      where employee.status in ('active', 'probation')
        and (
          employee.hire_date is null
          or employee.hire_date <=
            (statement_timestamp() at time zone 'Asia/Manila')::date
        )
        and coalesce(employee.source_type, '') <> 'google_deleted'
        and public.employee_master_normalize_id(employee.employee_no)
          not in ('SYSTEM', 'ADMIN')
    ), schedule as (
      select coalesce(
        nullif(
          public.employee_master_normalize_id(canonical.employee_no),
          ''
        ),
        public.employee_master_normalize_id(item->>'employee_id')
      ) employee_no
      from public.employee_master_source_snapshots snapshot
      cross join lateral jsonb_array_elements(snapshot.payload) item
      left join employee_private.employee_identity_merge_ledger ledger
        on employee_private.employee_identity_key(
             ledger.previous_employee_no
           ) = employee_private.employee_identity_key(
             item->>'employee_id'
           )
      left join public.employees canonical
        on canonical.id = ledger.target_employee_id
      where snapshot.source_key = 'home_schedule_roster_current'
    ), actual_difference as (
      (select employee_no, 'employee_only'::text direction
       from effective_active
       except
       select employee_no, 'employee_only'::text
       from schedule)
      union all
      (select employee_no, 'schedule_only'::text
       from schedule
       except
       select employee_no, 'schedule_only'::text
       from effective_active)
    ), expected_difference(employee_no, direction) as (
      select null::text, null::text
      where false
    )
    select 1
    from (
      (select employee_no, direction from actual_difference
       except
       select employee_no, direction from expected_difference)
      union all
      (select employee_no, direction from expected_difference
       except
       select employee_no, direction from actual_difference)
    ) difference
  ) then
    raise exception 'effective_active_schedule_set_changed_after_merge';
  end if;

  delete from employee_private.employee_identity_reconcile_approved_schedule;
  delete from employee_private.employee_identity_reconcile_merge_plan;
  delete from
    employee_private.employee_identity_reconcile_target_schedule_fields;
  delete from employee_private.employee_identity_reconcile_expected_fk;
  delete from
    employee_private.employee_identity_reconcile_expected_name_mismatch;
  delete from
    employee_private.employee_identity_reconcile_actual_name_mismatch;
  delete from employee_private.employee_identity_reconcile_source_presence;
  delete from
    employee_private.employee_identity_reconcile_cross_name_mismatch;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_approved_schedule
    union all
    select 1
    from employee_private.employee_identity_reconcile_merge_plan
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_target_schedule_fields
    union all
    select 1
    from employee_private.employee_identity_reconcile_expected_fk
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_expected_name_mismatch
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_actual_name_mismatch
    union all
    select 1
    from employee_private.employee_identity_reconcile_source_presence
    union all
    select 1
    from employee_private.employee_identity_reconcile_cross_name_mismatch
  ) then
    raise exception 'employee_identity_reconciliation_work_state_not_empty';
  end if;
end;
$reconcile$;

revoke all on function
  employee_private.apply_confirmed_employee_identity_reconciliation()
  from public, anon, authenticated, service_role;

comment on function
  employee_private.apply_confirmed_employee_identity_reconciliation() is
  'Private idempotent phase-B employee identity data reconciliation with both employee-master transaction advisory locks and one deferred assigned-scope rebuild.';

-- Acquire hot-table DDL locks only after every function has been compiled.
-- Nothing after this block performs business-data work; metadata verification
-- is followed immediately by COMMIT so PostgREST readers wait only for the
-- bounded trigger/constraint installation window.
-- Payroll imports lock payslips before touching their private alias cache, so
-- acquire the two AccessExclusive metadata locks in that same order.
drop trigger if exists zzzz_payroll_confirmed_employee_alias_guard
  on public.payroll_payslips;
create trigger zzzz_payroll_confirmed_employee_alias_guard
before insert or update
on public.payroll_payslips
for each row
execute function payroll_private.enforce_confirmed_employee_alias();

alter table payroll_private.employee_identity_aliases
  alter column hire_date drop not null;
alter table payroll_private.employee_identity_aliases
  drop constraint if exists payroll_employee_identity_alias_source_check;
alter table payroll_private.employee_identity_aliases
  add constraint payroll_employee_identity_alias_source_check check (
    (
      match_source = 'legacy_old_id_unique_name_hire_date'
      and hire_date is not null
    )
    or match_source = 'confirmed_employee_id_alias'
  );

drop trigger if exists aa_employee_attendance_confirmed_alias_guard
  on public.employee_attendance_records;
create trigger aa_employee_attendance_confirmed_alias_guard
before insert or update of
  source_id, employee_no_raw, employee_name_raw,
  employee_id, match_status, match_method
on public.employee_attendance_records
for each row
execute function attendance_private.enforce_confirmed_employee_alias();

drop trigger if exists zzzz_employee_attendance_confirmed_alias_guard
  on public.employee_attendance_records;
create trigger zzzz_employee_attendance_confirmed_alias_guard
before insert or update
on public.employee_attendance_records
for each row
execute function attendance_private.enforce_confirmed_employee_alias();

drop trigger if exists legacy_exam_match_employee_before_write
  on public.legacy_exam_sessions;
create trigger legacy_exam_match_employee_before_write
before insert or update of
  employee_no, employee_name, employee_id, employee_match_status
on public.legacy_exam_sessions
for each row
execute function public.legacy_exam_match_employee_row();

-- Reserve approved historical numbers at the public employee table itself.
-- The phase-A/phase-B gap is safe: this trigger does not run on DELETE and the
-- alias ledger is empty until phase B writes its exact nine approved pairs.
drop trigger if exists zzzz_employee_no_confirmed_alias_reservation
  on public.employees;
create trigger zzzz_employee_no_confirmed_alias_reservation
before insert or update of employee_no
on public.employees
for each row
execute function
  employee_private.enforce_employee_no_alias_reservation();

do $verify$
declare
  v_ingest text := pg_catalog.pg_get_functiondef(
    'public.ingest_employee_master_snapshot_validated_v1(jsonb)'::regprocedure
  );
  v_dashboard text := pg_catalog.pg_get_functiondef(
    'public.admin_home_dashboard()'::regprocedure
  );
  v_refresh text := pg_catalog.pg_get_functiondef(
    'public.refresh_schedule_report_snapshot_after_master_sync()'::regprocedure
  );
  v_reconciliation text := pg_catalog.pg_get_functiondef(
    'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure
  );
  v_assignments text := pg_catalog.pg_get_functiondef(
    'public.sync_schedule_employee_assignments(jsonb)'::regprocedure
  );
  v_standalone text := pg_catalog.pg_get_functiondef(
    'public.ingest_schedule_roster_snapshot(jsonb)'::regprocedure
  );
  v_batch_resolver text := pg_catalog.pg_get_functiondef(
    'public.resolve_employee_identity_batch(text[])'::regprocedure
  );
  v_payroll_import text := pg_catalog.pg_get_functiondef(
    'payroll_private.admin_payroll_import(jsonb,jsonb)'::regprocedure
  );
  v_payroll_guard text := pg_catalog.pg_get_functiondef(
    'payroll_private.enforce_confirmed_employee_alias()'::regprocedure
  );
  v_attendance_guard text := pg_catalog.pg_get_functiondef(
    'attendance_private.enforce_confirmed_employee_alias()'::regprocedure
  );
  v_resignation_guard text := pg_catalog.pg_get_functiondef(
    'attendance_private.enforce_resignation_employee_identity()'::regprocedure
  );
  v_exam text := pg_catalog.pg_get_functiondef(
    'public.legacy_exam_match_employee_row()'::regprocedure
  );
  v_scope_refresh text := pg_catalog.pg_get_functiondef(
    'scope_private.refresh_all_assigned_employee_scopes()'::regprocedure
  );
  v_attendance_trigger text;
  v_trigger_count integer := 0;
  v_work_table_count integer := 0;
begin
  if pg_catalog.strpos(
       v_ingest,
       'employee_private.employee_master_roster_overrides'
     ) = 0
     or pg_catalog.strpos(
       v_ingest,
       'accepted_employee.source_type'
     ) = 0
     or pg_catalog.strpos(
       v_ingest,
       'desired.home_active or not desired.onsite_marker'
     ) = 0
     or pg_catalog.strpos(v_ingest, 'ledger.full_name') = 0
     or pg_catalog.strpos(v_ingest, 'canonical.full_name') = 0
     or pg_catalog.strpos(v_ingest, 'canonical.employee_no') = 0
     or pg_catalog.strpos(
       v_ingest, 'employee_private.employee_identity_key'
     ) = 0 then
    raise exception 'employee_master_roster_patch_verification_failed';
  end if;
  if pg_catalog.strpos(
       v_dashboard,
       'employee.hire_date <= v_today'
     ) = 0 then
    raise exception 'admin_dashboard_effective_date_patch_verification_failed';
  end if;

  if pg_catalog.strpos(
       v_refresh, 'sync_report_employee_directory_scope_inner_v1'
     ) = 0
     or pg_catalog.strpos(
       v_refresh,
       'inline_directory_cache_diff_refresh_v1'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'public.report_employee_directory_cache_matches'
     ) > 0
     or pg_catalog.strpos(
       v_refresh, 'employee_private.report_employee_directory_cache_diff'
     ) > 0
     or pg_catalog.strpos(
       v_refresh, 'execute $' || 'directory_cache_diff_refresh$'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'jsonb_array_elements($1::jsonb)'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'using v_canonical_payload, v_row_count'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'from public.report_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(v_refresh, 'source_kind = ''roster''') = 0
     or pg_catalog.strpos(v_refresh, '''missing_cached''') = 0
     or pg_catalog.strpos(v_refresh, '''extra_cached''') = 0
     or pg_catalog.strpos(v_refresh, '''field_mismatch''') = 0
     or pg_catalog.strpos(v_refresh, '''input_rows''') = 0
     or pg_catalog.strpos(v_refresh, '''row_count''') = 0
     or pg_catalog.strpos(v_refresh, 'limit 5') = 0
     or pg_catalog.strpos(v_refresh, 'ledger.full_name') = 0
     or pg_catalog.strpos(v_refresh, 'canonical.full_name') = 0
     or pg_catalog.strpos(v_refresh, 'canonical.employee_no') = 0
     or pg_catalog.strpos(
       v_refresh, 'home_only_missing_schedule'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'active_home_employee_not_yet_scheduled'
     ) = 0
     or pg_catalog.strpos(
       v_refresh, 'employee_master_warning_count_below_issue_count'
     ) = 0
     or pg_catalog.strpos(v_refresh, 'ledger.official_employee_no') > 0
     or pg_catalog.strpos(
       v_assignments, 'resolve_confirmed_employee_id'
     ) = 0
     or pg_catalog.strpos(
       v_assignments, 'btrim(employee.full_name)'
     ) = 0
     or pg_catalog.strpos(
       v_standalone, 'ingest_schedule_roster_snapshot_guarded_v1'
     ) = 0
     or pg_catalog.strpos(
       v_standalone, 'confirmed_previous_employee_id'
     ) = 0
     or pg_catalog.strpos(v_standalone, 'canonical.employee_no') = 0
     or pg_catalog.strpos(v_standalone, 'ledger.official_employee_no') > 0
     or pg_catalog.strpos(
       v_batch_resolver, 'resolve_confirmed_employee_id'
     ) = 0
     or pg_catalog.strpos(v_batch_resolver, 'canonical.employee_no') = 0
     or pg_catalog.strpos(v_batch_resolver, 'ledger.full_name') = 0 then
    raise exception 'confirmed_identity_ingress_patch_verification_failed';
  end if;

  if pg_catalog.strpos(
       v_payroll_import, 'employee_identity_merge_ledger'
     ) = 0
     or pg_catalog.strpos(
       v_payroll_guard, 'confirmed_employee_id_alias_conflict'
     ) = 0
     or pg_catalog.strpos(
       v_payroll_guard, 'ledger.source_employee_id'
     ) = 0
     or pg_catalog.strpos(
       v_attendance_guard, 'ledger.source_employee_id'
     ) = 0
     or pg_catalog.strpos(
       v_resignation_guard,
       'ledger.source_employee_id = old.employee_id'
     ) = 0
     or pg_catalog.strpos(v_exam, 'public.exam_employee_no_key') = 0
     or pg_catalog.strpos(v_exam, 'ledger.full_name') = 0
     or pg_catalog.strpos(
       v_exam, 'ledger.source_employee_id = old.employee_id'
     ) = 0
     or pg_catalog.strpos(
       v_scope_refresh,
       'request_all_assigned_employee_scope_rebuild'
     ) = 0 then
    raise exception 'confirmed_identity_guard_patch_verification_failed';
  end if;

  if pg_catalog.strpos(
       v_reconciliation, 'employee-master-reconciliation'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'employee-master-dual-source-sync'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation,
       'employee_private.employee_identity_reconcile_merge_plan'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'full_schedule_directory_identity_shape_mismatch'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'inline_directory_cache_diff_reconcile_v1'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'effective_active_schedule_set_changed_after_merge'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'v_remaining_issue_count <> 41'
     ) = 0
     or pg_catalog.strpos(
       v_reconciliation, 'run.warning_count = 44'
     ) = 0
     or pg_catalog.strpos(v_reconciliation, 'pg_temp.') > 0
     or pg_catalog.strpos(v_reconciliation, 'create temporary table') > 0
     or pg_catalog.strpos(v_reconciliation, 'drop table') > 0
     or pg_catalog.strpos(v_reconciliation, 'alter table') > 0
     or pg_catalog.strpos(v_reconciliation, 'create trigger') > 0
     or pg_catalog.strpos(v_reconciliation, 'truncate ') > 0 then
    raise exception 'phase_b_reconciliation_definition_changed';
  end if;

  if employee_private.employee_identity_key(' ja-123 ') <>
       employee_private.employee_identity_key('JA123')
     or employee_private.employee_identity_key('TMP_SCHED.1757') <>
       employee_private.employee_identity_key('tmp-sched-1757') then
    raise exception 'employee_identity_key_semantics_changed';
  end if;

  select count(*)::integer
  into v_trigger_count
  from (
    values
      (
        'public.employee_attendance_records'::regclass,
        'aa_employee_attendance_confirmed_alias_guard'::text,
        'attendance_private.enforce_confirmed_employee_alias()'::regprocedure
      ),
      (
        'public.employee_attendance_records'::regclass,
        'zzz_employee_attendance_resignation_identity_guard'::text,
        'attendance_private.enforce_resignation_employee_identity()'::regprocedure
      ),
      (
        'public.employee_attendance_records'::regclass,
        'zzzz_employee_attendance_confirmed_alias_guard'::text,
        'attendance_private.enforce_confirmed_employee_alias()'::regprocedure
      ),
      (
        'public.payroll_payslips'::regclass,
        'zzzz_payroll_confirmed_employee_alias_guard'::text,
        'payroll_private.enforce_confirmed_employee_alias()'::regprocedure
      ),
      (
        'public.employees'::regclass,
        'zzzz_employee_no_confirmed_alias_reservation'::text,
        'employee_private.enforce_employee_no_alias_reservation()'::regprocedure
      ),
      (
        'public.legacy_exam_sessions'::regclass,
        'legacy_exam_match_employee_before_write'::text,
        'public.legacy_exam_match_employee_row()'::regprocedure
      ),
      (
        'public.employee_master_sync_runs'::regclass,
        'employee_master_refresh_full_schedule_report'::text,
        'public.refresh_schedule_report_snapshot_after_master_sync()'::regprocedure
      )
  ) expected(relation_id, trigger_name, function_id)
  join pg_catalog.pg_trigger trigger_row
    on trigger_row.tgrelid = expected.relation_id
   and trigger_row.tgname = expected.trigger_name
   and trigger_row.tgfoid = expected.function_id
   and not trigger_row.tgisinternal
   and trigger_row.tgenabled = 'O';

  if v_trigger_count <> 7 then
    raise exception 'confirmed_identity_trigger_installation_failed:%',
      v_trigger_count;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
          'payroll_private.employee_identity_aliases'::regclass
      and constraint_row.conname =
          'payroll_employee_identity_alias_source_check'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) like
          '%confirmed_employee_id_alias%'
  ) then
    raise exception 'payroll_confirmed_alias_constraint_changed';
  end if;

  select count(*)::integer
  into v_work_table_count
  from (
    values
      ('employee_identity_reconcile_approved_schedule'::text),
      ('employee_identity_reconcile_merge_plan'::text),
      ('employee_identity_reconcile_target_schedule_fields'::text),
      ('employee_identity_reconcile_expected_fk'::text),
      ('employee_identity_reconcile_expected_name_mismatch'::text),
      ('employee_identity_reconcile_actual_name_mismatch'::text),
      ('employee_identity_reconcile_source_presence'::text),
      ('employee_identity_reconcile_cross_name_mismatch'::text)
  ) expected(table_name)
  join pg_catalog.pg_namespace namespace
    on namespace.nspname = 'employee_private'
  join pg_catalog.pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = expected.table_name
   and relation.relkind = 'r'
   and relation.relrowsecurity
  where not exists (
    select 1
    from (
      values
        ('anon'::text),
        ('authenticated'::text),
        ('service_role'::text)
    ) boundary_role(role_name)
    cross join (
      values
        ('select'::text),
        ('insert'::text),
        ('update'::text),
        ('delete'::text),
        ('truncate'::text),
        ('references'::text),
        ('trigger'::text)
    ) boundary_privilege(privilege_name)
    where pg_catalog.has_table_privilege(
      boundary_role.role_name,
      relation.oid,
      boundary_privilege.privilege_name
    )
  );
  if v_work_table_count <> 8 then
    raise exception 'phase_b_work_table_boundary_changed:%',
      v_work_table_count;
  end if;

  if exists (
    select 1
    from employee_private.employee_identity_reconcile_approved_schedule
    union all
    select 1
    from employee_private.employee_identity_reconcile_merge_plan
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_target_schedule_fields
    union all
    select 1
    from employee_private.employee_identity_reconcile_expected_fk
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_expected_name_mismatch
    union all
    select 1
    from
      employee_private.employee_identity_reconcile_actual_name_mismatch
    union all
    select 1
    from employee_private.employee_identity_reconcile_source_presence
    union all
    select 1
    from employee_private.employee_identity_reconcile_cross_name_mismatch
  ) then
    raise exception 'phase_b_work_table_not_empty_before_reconciliation';
  end if;

  select lower(pg_catalog.pg_get_triggerdef(trigger_row.oid, true))
  into v_attendance_trigger
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid =
        'public.employee_attendance_records'::regclass
    and trigger_row.tgname =
        'aa_employee_attendance_confirmed_alias_guard';
  if pg_catalog.strpos(v_attendance_trigger, 'employee_name_raw') = 0
     or pg_catalog.strpos(v_attendance_trigger, 'source_id') = 0 then
    raise exception 'attendance_confirmed_alias_trigger_columns_changed';
  end if;

  if not (
       select relation.relrowsecurity
       from pg_catalog.pg_class relation
       where relation.oid =
         'employee_private.employee_identity_merge_ledger'::regclass
     )
     or not (
       select relation.relrowsecurity
       from pg_catalog.pg_class relation
       where relation.oid =
         'employee_private.employee_master_roster_overrides'::regclass
     )
     or pg_catalog.has_table_privilege(
       'service_role',
       'employee_private.employee_identity_merge_ledger',
       'select'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'employee_private.resolve_confirmed_employee_id(text)'::regprocedure,
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'employee_private.apply_confirmed_employee_identity_reconciliation()'::regprocedure,
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.resolve_employee_identity_batch(text[])'::regprocedure,
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.resolve_employee_identity_batch(text[])'::regprocedure,
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.resolve_employee_identity_batch(text[])'::regprocedure,
       'execute'
     ) then
    raise exception 'confirmed_identity_privilege_boundary_changed';
  end if;

  if (select count(*)
      from employee_private.employee_identity_merge_ledger) not in (0, 9)
     or (
       (select count(*)
        from employee_private.employee_identity_merge_ledger) = 9
       and (select count(*)
            from employee_private.employee_identity_merge_ledger ledger
            join public.employees canonical
              on canonical.id = ledger.target_employee_id
            join payroll_private.employee_identity_aliases alias
              on alias.old_employee_no_key =
                   employee_private.employee_identity_key(
                     ledger.previous_employee_no
                   )
             and alias.employee_id = ledger.target_employee_id
             and alias.employee_no_at_match = canonical.employee_no
             and alias.match_source =
                   'confirmed_employee_id_alias') <> 9
     ) then
    raise exception 'confirmed_identity_alias_ledger_verification_failed';
  end if;
end;
$verify$;

notify pgrst, 'reload schema';

commit;
