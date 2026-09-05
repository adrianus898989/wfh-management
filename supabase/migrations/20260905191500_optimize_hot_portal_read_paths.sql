begin;

-- These are hot login/bootstrap paths.  Fail fast during deployment if a sync
-- currently owns one of the small source tables instead of queueing more work
-- behind it.  Runtime request timeouts are deliberately unchanged.
set local lock_timeout = '500ms';
set local statement_timeout = '15s';

do $verify_hot_read_prerequisites$
declare
  v_staff_definition text := pg_catalog.pg_get_functiondef(
    'public.staff_portal_home()'::regprocedure
  );
  v_attendance_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.staff_attendance_home(text)'::regprocedure
  );
  v_enabled_cache_triggers integer;
begin
  if pg_catalog.to_regclass(
       'attendance_private.historical_employee_aliases_cache'
     ) is null
     or pg_catalog.to_regclass('public.report_employee_error_rows') is null
     or pg_catalog.to_regclass('public.report_employee_directory_cache') is null
     or pg_catalog.to_regclass('public.employee_error_summary') is null then
    raise exception 'hot_read_source_missing';
  end if;

  select count(*)::integer
  into v_enabled_cache_triggers
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.employee_lifecycle_events'::regclass
    and trigger_row.tgname in (
      'trg_attendance_history_cache_after_insert',
      'trg_attendance_history_cache_after_delete',
      'trg_attendance_history_cache_after_update'
    )
    and not trigger_row.tgisinternal
    and trigger_row.tgenabled <> 'D';

  if v_enabled_cache_triggers <> 3 then
    raise exception 'attendance_history_cache_not_transactionally_maintained';
  end if;

  if (
       pg_catalog.length(v_staff_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_staff_definition,
           'from public.report_employee_errors_v',
           ''
         ))
     ) / pg_catalog.length('from public.report_employee_errors_v') <> 1 then
    raise exception 'staff_portal_recent_error_source_shape_changed';
  end if;

  if (
       pg_catalog.length(v_staff_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_staff_definition,
           'lower(regexp_replace(',
           ''
         ))
     ) / pg_catalog.length('lower(regexp_replace(') <> 5 then
    raise exception 'staff_portal_trainer_identity_shape_changed';
  end if;

  if (
       pg_catalog.length(v_attendance_definition)
       - pg_catalog.length(pg_catalog.replace(
           v_attendance_definition,
           'from attendance_private.historical_employee_aliases identity_alias',
           ''
         ))
     ) / pg_catalog.length(
       'from attendance_private.historical_employee_aliases identity_alias'
     ) <> 1 then
    raise exception 'staff_attendance_alias_source_shape_changed';
  end if;

  if not (
    select procedure.prosecdef and procedure.provolatile = 's'
    from pg_catalog.pg_proc procedure
    where procedure.oid = 'public.staff_portal_home()'::regprocedure
  ) or not (
    select procedure.prosecdef and procedure.provolatile = 's'
    from pg_catalog.pg_proc procedure
    where procedure.oid =
      'attendance_private.staff_attendance_home(text)'::regprocedure
  ) then
    raise exception 'hot_read_function_security_shape_changed';
  end if;
end;
$verify_hot_read_prerequisites$;

-- The cache is keyed by name because it also supports name-to-identity lookup.
-- Staff attendance starts from an employee number, so give that reverse lookup
-- its own very small partial index.
create index if not exists
  historical_employee_aliases_cache_employee_no_idx
on attendance_private.historical_employee_aliases_cache
  (employee_no_key, name_key)
where identity_count = 1
  and employee_no_key is not null;

-- staff_portal_home intentionally accepts harmless case/outer-space drift in
-- cached employee numbers.  The primary keys cannot serve those expressions.
create index if not exists
  report_employee_directory_cache_employee_no_trim_idx
on public.report_employee_directory_cache
  (pg_catalog.upper(pg_catalog.btrim(employee_no)))
include (
  shift_name,
  team_name,
  group_name,
  position_name,
  platform_name,
  refreshed_at,
  source_kind,
  online_trainer
);

create index if not exists
  employee_error_summary_employee_no_trim_idx
on public.employee_error_summary
  (pg_catalog.upper(pg_catalog.btrim(employee_no)), updated_at desc)
include (
  month_error_count,
  last_30d_error_count,
  total_error_count,
  total_deduct,
  last_error_date,
  main_error_type,
  risk_level
);

-- Username already has the equivalent identity-key index.  Email was the only
-- trainer fallback that still had to scan every portal account.
create index if not exists
  user_access_online_training_email_identity_idx
on public.user_access
  (public.online_training_identity_key(login_email))
where employee_id is not null;

-- Preserve report_employee_errors_v semantics without evaluating its global
-- DISTINCT ON for every staff login.  First use the employee/date index to get
-- this employee's record keys, then use the existing record-key index to check
-- the globally latest revision for each key.  If a record was reassigned, its
-- latest revision is filtered out exactly as it is by the public view.
create or replace function attendance_private.staff_recent_error_rows(
  p_employee_no text
)
returns setof public.report_employee_errors_v
language sql
stable
security definer
set search_path = ''
rows 32
as $$
  with params as materialized (
    select pg_catalog.upper(pg_catalog.btrim(coalesce(p_employee_no, '')))
      as employee_no
  ), target_keys as materialized (
    select distinct error_row.record_key
    from public.report_employee_error_rows error_row
    cross join params
    where params.employee_no <> ''
      and error_row.employee_no = params.employee_no
      and nullif(error_row.employee_no, '') is not null
  ), latest_rows as materialized (
    select current_row.*
    from target_keys target
    cross join lateral (
      select error_row.*
      from public.report_employee_error_rows error_row
      where error_row.record_key = target.record_key
        and nullif(error_row.employee_no, '') is not null
      order by error_row.synced_at desc, error_row.source_row desc
      limit 1
    ) current_row
  )
  select
    latest.record_key,
    latest.source_row,
    latest.employee_no,
    latest.member_order,
    latest.amount,
    latest.error_note,
    latest.correct_action,
    latest.error_type,
    latest.score,
    latest.qc_person,
    latest.qc_date,
    latest.leader_review,
    latest.qc_result,
    latest.review_date,
    latest.synced_at
  from latest_rows latest
  cross join params
  where latest.employee_no = params.employee_no;
$$;

revoke all on function attendance_private.staff_recent_error_rows(text)
  from public, anon, authenticated, service_role;

comment on function attendance_private.staff_recent_error_rows(text) is
  'Private index-bounded equivalent of report_employee_errors_v for one staff employee. Called only by the security-definer staff home RPC.';

do $patch_staff_portal_home$
declare
  v_signature regprocedure;
  v_definition text;
  v_patched text;
  v_manual_identity_count integer;
begin
  for v_signature in
    select candidate.signature
    from (values
      (pg_catalog.to_regprocedure('public.staff_portal_home()')),
      (pg_catalog.to_regprocedure('public.staff_portal_home(boolean)'))
    ) candidate(signature)
    where candidate.signature is not null
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_signature);
    v_manual_identity_count := (
        pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(
            v_definition,
            'lower(regexp_replace(',
            ''
          ))
      ) / pg_catalog.length('lower(regexp_replace(');

    if v_manual_identity_count <> 5 then
      raise exception 'staff_portal_trainer_identity_shape_changed:%',
        v_signature::text;
    end if;

    v_patched := v_definition;
    if v_signature = 'public.staff_portal_home()'::regprocedure then
      v_patched := pg_catalog.replace(
        v_patched,
        'from public.report_employee_errors_v',
        'from attendance_private.staff_recent_error_rows(c.employee_no)'
      );
    end if;

    v_patched := pg_catalog.replace(
      v_patched,
      $old$select lower(regexp_replace(
            btrim(coalesce(
              nullif(btrim(d.online_trainer), ''),
              nullif(btrim(e.online_trainer), ''),
              nullif(btrim(e.trainer_name), ''),
              ''
            )),
            '[[:space:][:punct:]]+',
            '',
            'g'
          )) as trainer_key$old$,
      $new$select public.online_training_identity_key(coalesce(
            nullif(btrim(d.online_trainer), ''),
            nullif(btrim(e.online_trainer), ''),
            nullif(btrim(e.trainer_name), ''),
            ''
          )) as trainer_key$new$
    );

    v_patched := pg_catalog.replace(
      v_patched,
      $old$and lower(regexp_replace(
                btrim(coalesce(candidate.employee_no, '')),
                '[[:space:][:punct:]]+',
                '',
                'g'
              )) = trainer_source.trainer_key$old$,
      $new$and public.online_training_identity_key(candidate.employee_no) =
                trainer_source.trainer_key$new$
    );

    v_patched := pg_catalog.replace(
      v_patched,
      $old$and lower(regexp_replace(
                btrim(coalesce(candidate.full_name, '')),
                '[[:space:][:punct:]]+',
                '',
                'g'
              )) = trainer_source.trainer_key$old$,
      $new$and public.online_training_identity_key(candidate.full_name) =
                trainer_source.trainer_key$new$
    );

    v_patched := pg_catalog.replace(
      v_patched,
      $old$and lower(regexp_replace(
                btrim(coalesce(trainer_access.login_username, '')),
                '[[:space:][:punct:]]+',
                '',
                'g'
              )) = trainer_source.trainer_key$old$,
      $new$and public.online_training_identity_key(
                trainer_access.login_username
              ) = trainer_source.trainer_key$new$
    );

    v_patched := pg_catalog.replace(
      v_patched,
      $old$and lower(regexp_replace(
                btrim(coalesce(trainer_access.login_email, '')),
                '[[:space:][:punct:]]+',
                '',
                'g'
              )) = trainer_source.trainer_key$old$,
      $new$and public.online_training_identity_key(
                trainer_access.login_email
              ) = trainer_source.trainer_key$new$
    );

    if v_patched = v_definition
       or pg_catalog.strpos(v_patched, 'lower(regexp_replace(') > 0
       or (
         v_signature = 'public.staff_portal_home()'::regprocedure
         and pg_catalog.strpos(
           v_patched,
           'from attendance_private.staff_recent_error_rows(c.employee_no)'
         ) = 0
       ) then
      raise exception 'staff_portal_hot_read_patch_failed:%',
        v_signature::text;
    end if;

    execute v_patched;
  end loop;
end;
$patch_staff_portal_home$;

revoke all on function public.staff_portal_home()
  from public, anon;
grant execute on function public.staff_portal_home()
  to authenticated;

do $restore_optional_compact_staff_portal_acl$
begin
  if pg_catalog.to_regprocedure(
       'public.staff_portal_home(boolean)'
     ) is not null then
    revoke all on function public.staff_portal_home(boolean)
      from public, anon;
    grant execute on function public.staff_portal_home(boolean)
      to authenticated;
  end if;
end;
$restore_optional_compact_staff_portal_acl$;

do $patch_staff_attendance_home$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.staff_attendance_home(text)'::regprocedure
  );
  v_patched text;
begin
  v_patched := pg_catalog.replace(
    v_definition,
    'from attendance_private.historical_employee_aliases identity_alias',
    'from attendance_private.historical_employee_aliases_cache identity_alias'
  );

  if v_patched = v_definition
     or pg_catalog.strpos(
          v_patched,
          'from attendance_private.historical_employee_aliases_cache identity_alias'
        ) = 0
     or pg_catalog.strpos(
          v_patched,
          'from attendance_private.historical_employee_aliases identity_alias'
        ) > 0 then
    raise exception 'staff_attendance_alias_cache_patch_failed';
  end if;

  execute v_patched;
end;
$patch_staff_attendance_home$;

revoke all on function attendance_private.staff_attendance_home(text)
  from public, anon, authenticated;
grant execute on function attendance_private.staff_attendance_home(text)
  to service_role;

do $verify_hot_read_installation$
declare
  v_staff_definition text := pg_catalog.pg_get_functiondef(
    'public.staff_portal_home()'::regprocedure
  );
  v_compact_staff_definition text;
  v_attendance_definition text := pg_catalog.pg_get_functiondef(
    'attendance_private.staff_attendance_home(text)'::regprocedure
  );
begin
  if pg_catalog.to_regprocedure(
       'public.staff_portal_home(boolean)'
     ) is not null then
    v_compact_staff_definition := pg_catalog.pg_get_functiondef(
      'public.staff_portal_home(boolean)'::regprocedure
    );
  end if;

  if pg_catalog.strpos(
       v_staff_definition,
       'from attendance_private.staff_recent_error_rows(c.employee_no)'
     ) = 0
     or pg_catalog.strpos(
       v_staff_definition,
       'public.online_training_identity_key('
     ) = 0
     or pg_catalog.strpos(
       v_staff_definition,
       'from public.report_employee_errors_v'
     ) > 0
     or pg_catalog.strpos(v_staff_definition, 'lower(regexp_replace(') > 0 then
    raise exception 'staff_portal_hot_read_installation_mismatch';
  end if;

  if v_compact_staff_definition is not null
     and (
       pg_catalog.strpos(
         v_compact_staff_definition,
         'public.online_training_identity_key('
       ) = 0
       or pg_catalog.strpos(
         v_compact_staff_definition,
         'lower(regexp_replace('
       ) > 0
     ) then
    raise exception 'compact_staff_portal_hot_read_installation_mismatch';
  end if;

  if pg_catalog.strpos(
       v_attendance_definition,
       'from attendance_private.historical_employee_aliases_cache identity_alias'
     ) = 0
     or pg_catalog.strpos(
       v_attendance_definition,
       'from attendance_private.historical_employee_aliases identity_alias'
     ) > 0 then
    raise exception 'staff_attendance_cache_installation_mismatch';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.staff_recent_error_rows(text)',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'attendance_private.staff_recent_error_rows(text)',
       'execute'
     ) then
    raise exception 'staff_recent_error_helper_privilege_leak';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated',
       'public.staff_portal_home()',
       'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'attendance_private.staff_attendance_home(text)',
       'execute'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'attendance_private.staff_attendance_home(text)',
       'execute'
     ) then
    raise exception 'staff_hot_read_api_privilege_missing';
  end if;
end;
$verify_hot_read_installation$;

comment on function public.staff_portal_home() is
  'Returns only the authenticated staff member own portal data. Hot error, directory and trainer lookups are index-bounded; trainer identity is exposed only when uniquely resolved.';

comment on function attendance_private.staff_attendance_home(text) is
  'Private staff attendance payload using the transactionally maintained historical identity cache for self-only record discovery.';

commit;
