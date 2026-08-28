begin;

-- The current-staff source owns identity/lifecycle fields, while the schedule
-- source owns the live assignment fields below.  Previously the home stage
-- rewrote those assignment fields on every ingest and the schedule stage wrote
-- them back a few statements later.  A one-row schedule change therefore
-- counted as roughly 1,300 employee updates and amplified every sheet push.
--
-- Patch the already-validated private ingest in place so all existing quality,
-- lifecycle, presence, reporting and directory logic remains byte-for-byte
-- unchanged outside this one update block.
do $migration$
declare
  v_definition text;
  v_old text := $old$
    with desired as (
      select home.*, team.id team_id, position.id position_id,
        case
          when lower(coalesce(home.country_name, '')) ~ '(菲律宾|philippines|filipino)'
            then '纯居家菲律宾'
          else '纯居家（越南/缅甸/印尼等）'
        end employment_type
      from pg_temp.employee_master_home_stage home
      left join pg_temp.employee_master_team_map team
        on team.name_key = lower(btrim(home.team_name))
      left join pg_temp.employee_master_position_map position
        on position.name_key = lower(btrim(home.position_name))
      where home.employee_no is not null and not home.explicitly_resigned
    )
    update public.employees employee
    set full_name = desired.full_name,
        country = desired.country_name,
        nationality = desired.country_name,
        employment_type = desired.employment_type,
        team_id = desired.team_id,
        position_id = desired.position_id,
        hire_date = desired.hire_date,
        resign_date = null,
        work_tg = desired.work_tg,
        status = 'active',
        resign_reason = null,
        source_type = 'google_sheet',
        profile_status = 'sheet_synced',
        shift_name = desired.shift_name,
        legacy_shift_name = desired.shift_name,
        platform_scope = desired.platform_name,
        backend_accounts = desired.backend_accounts,
        source_sheet = '在职名单 Current Staff List',
        source_row = desired.source_row,
        official_id_pending = false,
        market_country = desired.team_name,
        market_position = desired.platform_name,
        schedule_position = desired.position_name,
        updated_at = clock_timestamp()
    from desired
    where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
      and (
        employee.full_name, employee.country, employee.nationality,
        employee.employment_type, employee.team_id, employee.position_id,
        employee.hire_date, employee.resign_date, employee.work_tg,
        employee.status, employee.resign_reason, employee.source_type,
        employee.profile_status, employee.shift_name, employee.legacy_shift_name,
        employee.platform_scope, employee.backend_accounts,
        employee.source_sheet, employee.source_row, employee.official_id_pending,
        employee.market_country, employee.market_position,
        employee.schedule_position
      ) is distinct from (
        desired.full_name, desired.country_name, desired.country_name,
        desired.employment_type, desired.team_id, desired.position_id,
        desired.hire_date, null::date, desired.work_tg,
        'active'::text, null::text, 'google_sheet'::text,
        'sheet_synced'::text, desired.shift_name, desired.shift_name,
        desired.platform_name, desired.backend_accounts,
        '在职名单 Current Staff List'::text, desired.source_row, false,
        desired.team_name, desired.platform_name,
        desired.position_name
      );
$old$;
  v_new text := $new$
    with desired as (
      select home.*, team.id team_id, position.id position_id,
        exists (
          select 1
          from pg_temp.employee_master_schedule_valid schedule
          where schedule.employee_no = home.employee_no
        ) schedule_managed,
        case
          when lower(coalesce(home.country_name, '')) ~ '(菲律宾|philippines|filipino)'
            then '纯居家菲律宾'
          else '纯居家（越南/缅甸/印尼等）'
        end employment_type
      from pg_temp.employee_master_home_stage home
      left join pg_temp.employee_master_team_map team
        on team.name_key = lower(btrim(home.team_name))
      left join pg_temp.employee_master_position_map position
        on position.name_key = lower(btrim(home.position_name))
      where home.employee_no is not null and not home.explicitly_resigned
    )
    update public.employees employee
    set full_name = desired.full_name,
        country = case when desired.schedule_managed then employee.country else desired.country_name end,
        nationality = case when desired.schedule_managed then employee.nationality else desired.country_name end,
        employment_type = desired.employment_type,
        team_id = case when desired.schedule_managed then employee.team_id else desired.team_id end,
        position_id = case when desired.schedule_managed then employee.position_id else desired.position_id end,
        hire_date = desired.hire_date,
        resign_date = null,
        work_tg = desired.work_tg,
        status = 'active',
        resign_reason = null,
        source_type = 'google_sheet',
        profile_status = 'sheet_synced',
        shift_name = case when desired.schedule_managed then employee.shift_name else desired.shift_name end,
        legacy_shift_name = desired.shift_name,
        platform_scope = case when desired.schedule_managed then employee.platform_scope else desired.platform_name end,
        backend_accounts = desired.backend_accounts,
        source_sheet = '在职名单 Current Staff List',
        source_row = desired.source_row,
        official_id_pending = false,
        market_country = case when desired.schedule_managed then employee.market_country else desired.team_name end,
        market_position = desired.platform_name,
        schedule_position = case when desired.schedule_managed then employee.schedule_position else desired.position_name end,
        updated_at = clock_timestamp()
    from desired
    where public.employee_master_normalize_id(employee.employee_no) = desired.employee_no
      and (
        employee.full_name, employee.country, employee.nationality,
        employee.employment_type, employee.team_id, employee.position_id,
        employee.hire_date, employee.resign_date, employee.work_tg,
        employee.status, employee.resign_reason, employee.source_type,
        employee.profile_status, employee.shift_name, employee.legacy_shift_name,
        employee.platform_scope, employee.backend_accounts,
        employee.source_sheet, employee.source_row, employee.official_id_pending,
        employee.market_country, employee.market_position,
        employee.schedule_position
      ) is distinct from (
        desired.full_name,
        case when desired.schedule_managed then employee.country else desired.country_name end,
        case when desired.schedule_managed then employee.nationality else desired.country_name end,
        desired.employment_type,
        case when desired.schedule_managed then employee.team_id else desired.team_id end,
        case when desired.schedule_managed then employee.position_id else desired.position_id end,
        desired.hire_date, null::date, desired.work_tg,
        'active'::text, null::text, 'google_sheet'::text,
        'sheet_synced'::text,
        case when desired.schedule_managed then employee.shift_name else desired.shift_name end,
        desired.shift_name,
        case when desired.schedule_managed then employee.platform_scope else desired.platform_name end,
        desired.backend_accounts,
        '在职名单 Current Staff List'::text, desired.source_row, false,
        case when desired.schedule_managed then employee.market_country else desired.team_name end,
        desired.platform_name,
        case when desired.schedule_managed then employee.schedule_position else desired.position_name end
      );
$new$;
begin
  select pg_catalog.pg_get_functiondef(procedure.oid)
  into v_definition
  from pg_catalog.pg_proc procedure
  join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
  where namespace.nspname = 'public'
    and procedure.proname = 'ingest_employee_master_snapshot_validated_v1'
    and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = 'p_payload jsonb';

  if v_definition is null then
    raise exception 'employee_master_validated_ingest_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_new) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'employee_master_home_update_marker_missing';
  end if;
  if length(v_definition) - length(pg_catalog.replace(v_definition, v_old, '')) <> length(v_old) then
    raise exception 'employee_master_home_update_marker_not_unique';
  end if;

  v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  execute v_definition;
end;
$migration$;

revoke all on function public.ingest_employee_master_snapshot_validated_v1(jsonb)
  from public, anon, authenticated, service_role;

comment on function public.ingest_employee_master_snapshot_validated_v1(jsonb) is
  'Private atomic dual-source employee reconciliation. Home owns identity/lifecycle; schedule owns live assignment fields without same-run rewrite amplification.';

notify pgrst, 'reload schema';

commit;
