begin;

-- The attendance page functions are security-sensitive and heavily used.  Fail
-- quickly if an active request owns one of the objects rather than waiting and
-- adding more pressure to the API connection pool.
set local lock_timeout = '500ms';
set local statement_timeout = '15s';

do $verify_attendance_history_cache_prerequisites$
declare
  v_view_definition text := pg_catalog.pg_get_viewdef(
    'attendance_private.attendance_enriched_records'::regclass,
    true
  );
  v_helper_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.enrich_attendance_record_ids(uuid[])'::regprocedure
  );
  v_view_options text[];
begin
  select relation.reloptions
  into v_view_options
  from pg_catalog.pg_class relation
  where relation.oid =
    'attendance_private.attendance_enriched_records'::regclass;

  if not ('security_invoker=true' = any(coalesce(v_view_options, array[]::text[])))
     or not ('security_barrier=true' = any(coalesce(v_view_options, array[]::text[]))) then
    raise exception 'attendance_enriched_security_boundary_changed';
  end if;

  if (
       pg_catalog.length(v_view_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_view_definition,
           'attendance_private.historical_employee_directory',
           ''
         ))
     ) / pg_catalog.length('attendance_private.historical_employee_directory') <> 1
     or (
       pg_catalog.length(v_view_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_view_definition,
           'attendance_private.historical_employee_aliases',
           ''
         ))
     ) / pg_catalog.length('attendance_private.historical_employee_aliases') <> 1 then
    raise exception 'attendance_enriched_history_source_shape_changed';
  end if;

  if (
       pg_catalog.length(v_helper_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_helper_definition,
           'attendance_private.historical_employee_directory',
           ''
         ))
     ) / pg_catalog.length('attendance_private.historical_employee_directory') <> 1
     or (
       pg_catalog.length(v_helper_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_helper_definition,
           'attendance_private.historical_employee_aliases',
           ''
         ))
     ) / pg_catalog.length('attendance_private.historical_employee_aliases') <> 1 then
    raise exception 'bounded_attendance_history_source_shape_changed';
  end if;

  if not (
    select procedure.prosecdef and procedure.provolatile = 's'
    from pg_catalog.pg_proc procedure
    where procedure.oid =
      'attendance_private.enrich_attendance_record_ids(uuid[])'::regprocedure
  ) then
    raise exception 'bounded_attendance_helper_security_changed';
  end if;
end;
$verify_attendance_history_cache_prerequisites$;

-- These tables contain only the already-existing private historical directory
-- projections.  They are deliberately not exposed through PostgREST.
create table attendance_private.historical_employee_directory_cache (
  employee_no_key text primary key,
  employee_no text,
  full_name text,
  name_key text,
  current_employee_id uuid,
  hire_date date,
  resign_date date,
  employment_type text,
  country text,
  platform text,
  team_name text,
  position_name text,
  manager text,
  latest_event_type text,
  employee_status text
);

create table attendance_private.historical_employee_aliases_cache (
  name_key text primary key,
  identity_count bigint,
  employee_no_key text
);

revoke all on attendance_private.historical_employee_directory_cache
  from public, anon, authenticated, service_role;
revoke all on attendance_private.historical_employee_aliases_cache
  from public, anon, authenticated, service_role;

insert into attendance_private.historical_employee_directory_cache
select *
from attendance_private.historical_employee_directory;

insert into attendance_private.historical_employee_aliases_cache
select *
from attendance_private.historical_employee_aliases;

analyze attendance_private.historical_employee_directory_cache;
analyze attendance_private.historical_employee_aliases_cache;

-- Refresh only identities touched by one lifecycle statement.  Advisory
-- serialization prevents two concurrent staff syncs from overwriting each
-- other's cache work.  The trigger and source change commit atomically, so
-- readers see either the old complete snapshot or the new complete snapshot.
create function attendance_private.refresh_historical_employee_cache_keys(
  p_employee_no_keys text[],
  p_name_keys text[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_employee_no_keys text[];
  v_name_keys text[];
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'attendance_private.historical_employee_identity_cache',
      0
    )
  );

  select coalesce(pg_catalog.array_agg(distinct key_value), array[]::text[])
  into v_employee_no_keys
  from pg_catalog.unnest(coalesce(p_employee_no_keys, array[]::text[]))
    key_source(key_value)
  where nullif(pg_catalog.btrim(key_value), '') is not null;

  select coalesce(pg_catalog.array_agg(distinct key_value), array[]::text[])
  into v_name_keys
  from pg_catalog.unnest(coalesce(p_name_keys, array[]::text[]))
    key_source(key_value)
  where nullif(pg_catalog.btrim(key_value), '') is not null;

  if pg_catalog.cardinality(v_employee_no_keys) > 0 then
    delete from attendance_private.historical_employee_directory_cache cache
    where cache.employee_no_key = any(v_employee_no_keys);

    insert into attendance_private.historical_employee_directory_cache
    select source.*
    from attendance_private.historical_employee_directory source
    where source.employee_no_key = any(v_employee_no_keys);
  end if;

  if pg_catalog.cardinality(v_name_keys) > 0 then
    delete from attendance_private.historical_employee_aliases_cache cache
    where cache.name_key = any(v_name_keys);

    insert into attendance_private.historical_employee_aliases_cache
    select source.*
    from attendance_private.historical_employee_aliases source
    where source.name_key = any(v_name_keys);
  end if;
end;
$$;

revoke all on function attendance_private.refresh_historical_employee_cache_keys(
  text[], text[]
) from public, anon, authenticated, service_role;

create function attendance_private.refresh_historical_employee_cache_after_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_employee_no_keys text[];
  v_name_keys text[];
begin
  select
    coalesce(
      pg_catalog.array_agg(distinct pg_catalog.upper(pg_catalog.btrim(employee_no)))
        filter (where nullif(pg_catalog.btrim(employee_no), '') is not null),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(distinct public.exam_norm(full_name))
        filter (where nullif(public.exam_norm(full_name), '') is not null),
      array[]::text[]
    )
  into v_employee_no_keys, v_name_keys
  from new_lifecycle_rows;

  perform attendance_private.refresh_historical_employee_cache_keys(
    v_employee_no_keys,
    v_name_keys
  );
  return null;
end;
$$;

create function attendance_private.refresh_historical_employee_cache_after_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_employee_no_keys text[];
  v_name_keys text[];
begin
  select
    coalesce(
      pg_catalog.array_agg(distinct pg_catalog.upper(pg_catalog.btrim(employee_no)))
        filter (where nullif(pg_catalog.btrim(employee_no), '') is not null),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(distinct public.exam_norm(full_name))
        filter (where nullif(public.exam_norm(full_name), '') is not null),
      array[]::text[]
    )
  into v_employee_no_keys, v_name_keys
  from old_lifecycle_rows;

  perform attendance_private.refresh_historical_employee_cache_keys(
    v_employee_no_keys,
    v_name_keys
  );
  return null;
end;
$$;

create function attendance_private.refresh_historical_employee_cache_after_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_employee_no_keys text[];
  v_name_keys text[];
begin
  with changed_rows as (
    select employee_no, full_name from old_lifecycle_rows
    union all
    select employee_no, full_name from new_lifecycle_rows
  )
  select
    coalesce(
      pg_catalog.array_agg(distinct pg_catalog.upper(pg_catalog.btrim(employee_no)))
        filter (where nullif(pg_catalog.btrim(employee_no), '') is not null),
      array[]::text[]
    ),
    coalesce(
      pg_catalog.array_agg(distinct public.exam_norm(full_name))
        filter (where nullif(public.exam_norm(full_name), '') is not null),
      array[]::text[]
    )
  into v_employee_no_keys, v_name_keys
  from changed_rows;

  perform attendance_private.refresh_historical_employee_cache_keys(
    v_employee_no_keys,
    v_name_keys
  );
  return null;
end;
$$;

revoke all on function
  attendance_private.refresh_historical_employee_cache_after_insert(),
  attendance_private.refresh_historical_employee_cache_after_delete(),
  attendance_private.refresh_historical_employee_cache_after_update()
from public, anon, authenticated, service_role;

create trigger trg_attendance_history_cache_after_insert
after insert on public.employee_lifecycle_events
referencing new table as new_lifecycle_rows
for each statement
execute function attendance_private.refresh_historical_employee_cache_after_insert();

create trigger trg_attendance_history_cache_after_delete
after delete on public.employee_lifecycle_events
referencing old table as old_lifecycle_rows
for each statement
execute function attendance_private.refresh_historical_employee_cache_after_delete();

create trigger trg_attendance_history_cache_after_update
after update on public.employee_lifecycle_events
referencing old table as old_lifecycle_rows new table as new_lifecycle_rows
for each statement
execute function attendance_private.refresh_historical_employee_cache_after_update();

-- A team rename affects only the cached display label.  Recompute the label
-- against the live private source but update rows only when the value changed;
-- routine upserts with unchanged names therefore create no cache churn.
create function attendance_private.refresh_historical_employee_cache_team_names()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'attendance_private.historical_employee_identity_cache',
      0
    )
  );

  update attendance_private.historical_employee_directory_cache cache
  set team_name = source.team_name
  from attendance_private.historical_employee_directory source
  where source.employee_no_key = cache.employee_no_key
    and cache.team_name is distinct from source.team_name;
  return null;
end;
$$;

revoke all on function
  attendance_private.refresh_historical_employee_cache_team_names()
from public, anon, authenticated, service_role;

create trigger trg_attendance_history_cache_after_team_insert_or_delete
after insert or delete on public.teams
for each statement
execute function attendance_private.refresh_historical_employee_cache_team_names();

create trigger trg_attendance_history_cache_after_team_name_update
after update of name on public.teams
for each statement
execute function attendance_private.refresh_historical_employee_cache_team_names();

-- Swap only the two expensive private sources.  Public functions, permission
-- guards, RLS behavior, JSON keys and row ordering are not changed.
do $install_attendance_history_cache$
declare
  v_view_definition text := pg_catalog.pg_get_viewdef(
    'attendance_private.attendance_enriched_records'::regclass,
    true
  );
  v_helper_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.enrich_attendance_record_ids(uuid[])'::regprocedure
  );
  v_patched text;
begin
  v_patched := pg_catalog.replace(
    pg_catalog.replace(
      v_view_definition,
      'attendance_private.historical_employee_directory',
      'attendance_private.historical_employee_directory_cache'
    ),
    'attendance_private.historical_employee_aliases',
    'attendance_private.historical_employee_aliases_cache'
  );
  -- pg_get_viewdef expands SELECT * with the source relation name as an
  -- unqualified column qualifier.  Rewrite those qualifiers as well as the
  -- FROM targets so the cached relation remains resolvable.
  v_patched := pg_catalog.replace(
    pg_catalog.replace(
      v_patched,
      'historical_employee_directory.',
      'historical_employee_directory_cache.'
    ),
    'historical_employee_aliases.',
    'historical_employee_aliases_cache.'
  );
  if v_patched = v_view_definition then
    raise exception 'attendance_enriched_history_cache_patch_failed';
  end if;
  execute 'create or replace view attendance_private.attendance_enriched_records '
    || 'with (security_invoker = true, security_barrier = true) as '
    || v_patched;

  v_patched := pg_catalog.replace(
    pg_catalog.replace(
      v_helper_definition,
      'attendance_private.historical_employee_directory',
      'attendance_private.historical_employee_directory_cache'
    ),
    'attendance_private.historical_employee_aliases',
    'attendance_private.historical_employee_aliases_cache'
  );
  v_patched := pg_catalog.replace(
    pg_catalog.replace(
      v_patched,
      'historical_employee_directory.',
      'historical_employee_directory_cache.'
    ),
    'historical_employee_aliases.',
    'historical_employee_aliases_cache.'
  );
  if v_patched = v_helper_definition then
    raise exception 'bounded_attendance_history_cache_patch_failed';
  end if;
  execute v_patched;
end;
$install_attendance_history_cache$;

revoke all on attendance_private.attendance_enriched_records
  from public, anon, authenticated;
revoke all on function attendance_private.enrich_attendance_record_ids(uuid[])
  from public, anon, authenticated, service_role;

do $verify_attendance_history_cache_installation$
declare
  v_view_definition text := pg_catalog.pg_get_viewdef(
    'attendance_private.attendance_enriched_records'::regclass,
    true
  );
  v_helper_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.enrich_attendance_record_ids(uuid[])'::regprocedure
  );
  v_view_options text[];
begin
  if pg_catalog.strpos(
       v_view_definition,
       'attendance_private.historical_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_view_definition,
       'attendance_private.historical_employee_aliases_cache'
     ) = 0
     or pg_catalog.strpos(
       v_helper_definition,
       'attendance_private.historical_employee_directory_cache'
     ) = 0
     or pg_catalog.strpos(
       v_helper_definition,
       'attendance_private.historical_employee_aliases_cache'
     ) = 0
     or pg_catalog.strpos(
       v_view_definition,
       'attendance_private.historical_employee_directory '
     ) > 0
     or pg_catalog.strpos(
       v_helper_definition,
       'attendance_private.historical_employee_directory '
     ) > 0
     or pg_catalog.strpos(
       v_view_definition,
       'historical_employee_directory.'
     ) > 0
     or pg_catalog.strpos(
       v_view_definition,
       'historical_employee_aliases.'
     ) > 0
     or pg_catalog.strpos(
       v_helper_definition,
       'historical_employee_directory.'
     ) > 0
     or pg_catalog.strpos(
       v_helper_definition,
       'historical_employee_aliases.'
     ) > 0 then
    raise exception 'attendance_history_cache_reference_verification_failed';
  end if;

  select relation.reloptions
  into v_view_options
  from pg_catalog.pg_class relation
  where relation.oid =
    'attendance_private.attendance_enriched_records'::regclass;
  if not ('security_invoker=true' = any(coalesce(v_view_options, array[]::text[])))
     or not ('security_barrier=true' = any(coalesce(v_view_options, array[]::text[]))) then
    raise exception 'attendance_enriched_security_boundary_not_preserved';
  end if;

  if exists (
       select * from attendance_private.historical_employee_directory
       except
       select * from attendance_private.historical_employee_directory_cache
     )
     or exists (
       select * from attendance_private.historical_employee_directory_cache
       except
       select * from attendance_private.historical_employee_directory
     )
     or exists (
       select * from attendance_private.historical_employee_aliases
       except
       select * from attendance_private.historical_employee_aliases_cache
     )
     or exists (
       select * from attendance_private.historical_employee_aliases_cache
       except
       select * from attendance_private.historical_employee_aliases
     ) then
    raise exception 'attendance_history_cache_initial_snapshot_mismatch';
  end if;

  if pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.historical_employee_directory_cache',
       'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated',
       'attendance_private.historical_employee_aliases_cache',
       'select'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.refresh_historical_employee_cache_keys(text[],text[])',
       'execute'
     ) then
    raise exception 'attendance_history_cache_privilege_leak';
  end if;
end;
$verify_attendance_history_cache_installation$;

comment on table attendance_private.historical_employee_directory_cache is
  'Private transactionally maintained cache for attendance historical identity enrichment. Not an application API.';
comment on table attendance_private.historical_employee_aliases_cache is
  'Private transactionally maintained cache for unique historical-name resolution. Not an application API.';

commit;
