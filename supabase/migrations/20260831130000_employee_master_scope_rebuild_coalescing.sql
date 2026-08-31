begin;

-- The employee-master ingest performs several set-based employee writes in a
-- single transaction.  The existing statement trigger rebuilt every assigned
-- backend scope after each write, even when UPDATE OF employee_no assigned the
-- same value.  Keep the scope model unchanged, but defer those rebuild requests
-- while the atomic ingest runs and coalesce them into at most one final rebuild.
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $verify_employee_master_scope_coalescing_prerequisites$
declare
  v_ingest_definition text;
  v_refresh_definition text;
  v_employee_update_trigger text;
begin
  if to_regprocedure('public.ingest_employee_master_snapshot(jsonb)') is null
     or to_regprocedure('public.ingest_employee_master_snapshot_validated_v1(jsonb)') is null
     or to_regprocedure('scope_private.rebuild_all_assigned_employee_scopes()') is null
     or to_regprocedure('scope_private.refresh_all_assigned_employee_scopes()') is null
     or to_regprocedure('scope_private.current_employee_scope_directory()') is null then
    raise exception 'employee_master_scope_coalescing_prerequisite_missing';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.ingest_employee_master_snapshot(jsonb)'::regprocedure
  ) into v_ingest_definition;
  if pg_catalog.strpos(
       v_ingest_definition,
       'ingest_employee_master_snapshot_validated_v1'
     ) = 0
     or pg_catalog.strpos(
       v_ingest_definition,
       'employee-master-dual-source-sync'
     ) = 0
     or pg_catalog.strpos(
       v_ingest_definition,
       'scope_private.skip_next_directory_sync'
     ) = 0 then
    raise exception 'employee_master_scope_coalescing_ingest_shape_changed';
  end if;

  select pg_catalog.pg_get_functiondef(
    'scope_private.refresh_all_assigned_employee_scopes()'::regprocedure
  ) into v_refresh_definition;
  if pg_catalog.strpos(
       v_refresh_definition,
       'rebuild_all_assigned_employee_scopes'
     ) = 0 then
    raise exception 'employee_master_scope_refresh_shape_changed';
  end if;

  select pg_catalog.pg_get_triggerdef(trigger.oid, true)
  into v_employee_update_trigger
  from pg_catalog.pg_trigger trigger
  where trigger.tgrelid = 'public.employees'::regclass
    and trigger.tgname =
      'refresh_effective_scope_after_employee_team_position_update'
    and not trigger.tgisinternal;
  if v_employee_update_trigger is null
     or pg_catalog.strpos(
       v_employee_update_trigger,
       'AFTER UPDATE OF employee_no'
     ) = 0
     or pg_catalog.strpos(
       v_employee_update_trigger,
       'scope_private.refresh_all_assigned_employee_scopes()'
     ) = 0 then
    raise exception 'employee_master_scope_update_trigger_shape_changed';
  end if;

  if not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name = 'employees'
      and column_definition.column_name in (
        'id', 'employee_no', 'team_id', 'position_id'
      )
    group by column_definition.table_schema, column_definition.table_name
    having count(*) = 4
  ) then
    raise exception 'employee_master_scope_input_columns_missing';
  end if;
end;
$verify_employee_master_scope_coalescing_prerequisites$;

-- A regular private helper lets every existing statement trigger request a
-- rebuild without making trigger functions directly callable.  Outside the
-- employee-master wrapper the old immediate behavior is preserved exactly.
create or replace function scope_private.request_all_assigned_employee_scope_rebuild()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if pg_catalog.current_setting(
       'scope_private.defer_assigned_scope_rebuild', true
     ) = 'on' then
    perform pg_catalog.set_config(
      'scope_private.assigned_scope_rebuild_dirty', 'on', true
    );
    return false;
  end if;

  perform scope_private.rebuild_all_assigned_employee_scopes();
  return true;
end;
$$;

revoke all on function
  scope_private.request_all_assigned_employee_scope_rebuild()
  from public, anon, authenticated, service_role;

create or replace function scope_private.refresh_all_assigned_employee_scopes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform scope_private.request_all_assigned_employee_scope_rebuild();
  return null;
end;
$$;

revoke all on function scope_private.refresh_all_assigned_employee_scopes()
  from public, anon, authenticated, service_role;

-- UPDATE OF fires when a column is present in SET, even if the value does not
-- change.  Transition tables let one statement-level trigger compare the real
-- before/after employee identity, team and position values.
create or replace function
  scope_private.refresh_assigned_scopes_after_employee_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope_input_changed boolean := false;
begin
  select exists (
    select 1
    from old_employee_scope_rows old_row
    full join new_employee_scope_rows new_row using (id)
    where old_row.id is null
       or new_row.id is null
       or old_row.employee_no is distinct from new_row.employee_no
       or old_row.team_id is distinct from new_row.team_id
       or old_row.position_id is distinct from new_row.position_id
  ) into v_scope_input_changed;

  if v_scope_input_changed then
    perform scope_private.request_all_assigned_employee_scope_rebuild();
  end if;
  return null;
end;
$$;

revoke all on function
  scope_private.refresh_assigned_scopes_after_employee_update()
  from public, anon, authenticated, service_role;

drop trigger if exists
  refresh_effective_scope_after_employee_team_position_update
  on public.employees;
create trigger refresh_effective_scope_after_employee_team_position_update
after update on public.employees
referencing old table as old_employee_scope_rows
  new table as new_employee_scope_rows
for each statement execute function
  scope_private.refresh_assigned_scopes_after_employee_update();

-- Hash both the direct employee columns requested by the trigger contract and
-- the canonical roster mapping that actually feeds user_scope_employees.  This
-- avoids a rebuild for zero-row inserts and no-op team/position statements,
-- while still detecting canonical name/status changes in teams or positions.
create or replace function
  scope_private.assigned_employee_scope_input_fingerprint()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with scope_inputs as (
    select
      'employee'::text source_kind,
      employee.id::text row_key,
      pg_catalog.concat_ws(
        pg_catalog.chr(31),
        coalesce(employee.employee_no, ''),
        coalesce(employee.team_id::text, ''),
        coalesce(employee.position_id::text, '')
      ) row_value
    from public.employees employee

    union all

    select
      'directory',
      directory.employee_id::text,
      pg_catalog.concat_ws(
        pg_catalog.chr(31),
        coalesce(directory.employee_no, ''),
        coalesce(directory.current_team_id::text, ''),
        coalesce(directory.current_position_id::text, '')
      )
    from scope_private.current_employee_scope_directory() directory
  )
  select pg_catalog.md5(coalesce(pg_catalog.string_agg(
    pg_catalog.concat_ws(
      pg_catalog.chr(31), source_kind, row_key, row_value
    ),
    pg_catalog.chr(30) order by source_kind, row_key, row_value
  ), ''))
  from scope_inputs;
$$;

revoke all on function
  scope_private.assigned_employee_scope_input_fingerprint()
  from public, anon, authenticated, service_role;

-- Wrap the exact production quality/locking entrypoint rather than copying its
-- validation body.  The outer advisory lock makes the before fingerprint and
-- the already-serialized inner ingest one atomic observation.
alter function public.ingest_employee_master_snapshot(jsonb)
  rename to ingest_employee_master_snapshot_scope_coalesce_inner_v1;

revoke all on function
  public.ingest_employee_master_snapshot_scope_coalesce_inner_v1(jsonb)
  from public, anon, authenticated, service_role;

create function public.ingest_employee_master_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_before_fingerprint text;
  v_after_fingerprint text;
  v_previous_defer text := coalesce(nullif(pg_catalog.current_setting(
    'scope_private.defer_assigned_scope_rebuild', true
  ), ''), 'off');
  v_previous_dirty text := coalesce(nullif(pg_catalog.current_setting(
    'scope_private.assigned_scope_rebuild_dirty', true
  ), ''), 'off');
  v_owns_defer boolean;
  v_dirty boolean := false;
begin
  -- Re-entrant with the inner guard and prevents a second ingest from taking
  -- its before fingerprint while the first one is still mutating scope input.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-master-dual-source-sync', 20260825)
  );

  v_owns_defer := v_previous_defer <> 'on';
  if not v_owns_defer then
    return public.ingest_employee_master_snapshot_scope_coalesce_inner_v1(
      p_payload
    );
  end if;

  v_before_fingerprint :=
    scope_private.assigned_employee_scope_input_fingerprint();
  perform pg_catalog.set_config(
    'scope_private.defer_assigned_scope_rebuild', 'on', true
  );
  perform pg_catalog.set_config(
    'scope_private.assigned_scope_rebuild_dirty', 'off', true
  );

  begin
    v_result :=
      public.ingest_employee_master_snapshot_scope_coalesce_inner_v1(
        p_payload
      );
    v_dirty := pg_catalog.current_setting(
      'scope_private.assigned_scope_rebuild_dirty', true
    ) = 'on';
    if v_dirty then
      v_after_fingerprint :=
        scope_private.assigned_employee_scope_input_fingerprint();
    end if;

    perform pg_catalog.set_config(
      'scope_private.defer_assigned_scope_rebuild', v_previous_defer, true
    );
    perform pg_catalog.set_config(
      'scope_private.assigned_scope_rebuild_dirty', v_previous_dirty, true
    );

    if v_dirty
       and v_before_fingerprint is distinct from v_after_fingerprint then
      perform scope_private.rebuild_all_assigned_employee_scopes();
    end if;
    return v_result;
  exception when others then
    perform pg_catalog.set_config(
      'scope_private.defer_assigned_scope_rebuild', v_previous_defer, true
    );
    perform pg_catalog.set_config(
      'scope_private.assigned_scope_rebuild_dirty', v_previous_dirty, true
    );
    raise;
  end;
end;
$$;

revoke all on function public.ingest_employee_master_snapshot(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_employee_master_snapshot(jsonb)
  to service_role;

comment on function public.ingest_employee_master_snapshot(jsonb) is
  'Validates and ingests the dual Google employee snapshot while coalescing assigned-scope rebuilds to at most one changed-input rebuild per atomic ingest.';

do $verify_employee_master_scope_coalescing_install$
declare
  v_wrapper text := pg_catalog.pg_get_functiondef(
    'public.ingest_employee_master_snapshot(jsonb)'::regprocedure
  );
  v_update_trigger text;
begin
  if pg_catalog.strpos(
       v_wrapper,
       'ingest_employee_master_snapshot_scope_coalesce_inner_v1'
     ) = 0
     or pg_catalog.strpos(
       v_wrapper,
       'assigned_employee_scope_input_fingerprint'
     ) = 0
     or pg_catalog.strpos(
       v_wrapper,
       'defer_assigned_scope_rebuild'
     ) = 0 then
    raise exception 'employee_master_scope_coalescing_install_failed';
  end if;

  select pg_catalog.pg_get_triggerdef(trigger.oid, true)
  into v_update_trigger
  from pg_catalog.pg_trigger trigger
  where trigger.tgrelid = 'public.employees'::regclass
    and trigger.tgname =
      'refresh_effective_scope_after_employee_team_position_update'
    and not trigger.tgisinternal;
  if v_update_trigger is null
     or pg_catalog.strpos(v_update_trigger, 'REFERENCING OLD TABLE') = 0
     or pg_catalog.strpos(
       v_update_trigger,
       'refresh_assigned_scopes_after_employee_update()'
     ) = 0 then
    raise exception 'employee_master_scope_update_trigger_install_failed';
  end if;
end;
$verify_employee_master_scope_coalescing_install$;

notify pgrst, 'reload schema';

commit;
