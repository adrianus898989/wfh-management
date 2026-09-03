-- The confirmed-identity trigger functions introduced in
-- 20260901170000_reconcile_confirmed_employee_identity_merges.sql stored the
-- OLD identity in an untyped record only for UPDATE.  Their final IF combined
-- the TG_OP check and record-field access in one PL/pgSQL expression.  On an
-- INSERT carrying a confirmed historical alias PostgreSQL can still resolve
-- those record fields before the boolean expression short-circuits, raising:
--   record "v_before_identity" is not assigned yet
-- Keep the same identity rules and privilege boundary, but put the record
-- comparison inside a nested UPDATE-only branch so INSERT never references it.

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
    new.match_method := 'employee_id_exact';
    new.matched_at := coalesce(new.matched_at, clock_timestamp());
  else
    new.employee_id := null;
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
  end if;

  if tg_op = 'UPDATE' then
    if (
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
    new.employee_id := null;
    new.match_status := 'unmatched';
    new.match_method := null;
    new.matched_at := null;
  end if;

  if tg_op = 'UPDATE' then
    if (
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
  end if;

  return new;
end;
$$;

revoke all on function
  attendance_private.enforce_confirmed_employee_alias()
  from public, anon, authenticated, service_role;

comment on function attendance_private.enforce_confirmed_employee_alias() is
  'Reattaches attendance rows carrying an approved historical employee number to the canonical UUID when an optional supplied name matches the immutable approved name, and fails closed on alias conflicts.';
