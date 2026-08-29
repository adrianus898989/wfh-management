begin;

-- Route the established monthly-leave rule by the canonical attendance
-- workbook group.  The employee type is an exact cross-check only; country is
-- deliberately not part of classification.  Missing, mixed, or conflicting
-- evidence keeps the legacy > 5 rule so this change cannot widen alert scope.
do $split_monthly_leave_threshold$
declare
  v_signature regprocedure :=
    'alerts_private.refresh_alert_group(text)'::regprocedure;
  v_definition text;
  v_updated_definition text;
  v_security_definer boolean;
  v_function_config text[];
  v_old_hits integer;
  v_new_hits integer;
  v_old_block text := $old_monthly_leave$
    insert into pg_temp.admin_alert_group_candidates
    with stats as (
      select day.employee_id,
        sum(case when day.event_kind = 'half_day' then 0.5 else 1 end)::numeric occurrence_count,
        count(*) filter (where day.event_kind = 'public_holiday') public_holiday,
        count(*) filter (where day.event_kind = 'leave') leave_days,
        count(*) filter (where day.event_kind = 'absence') absence_days,
        count(*) filter (where day.event_kind = 'half_day') half_days
      from pg_temp.admin_alert_group_attendance_days day
      where day.event_date >= pg_catalog.date_trunc('month', v_today)::date
        and day.event_date <= v_today
        and day.event_kind in ('public_holiday', 'leave', 'absence', 'half_day')
      group by day.employee_id
      having sum(case when day.event_kind = 'half_day' then 0.5 else 1 end) > 5
    )
    select
      'monthly_leave:' || employee.id::text || ':' || pg_catalog.to_char(v_today, 'YYYY-MM'),
      'monthly_leave',
      case when stats.occurrence_count >= 8 then 'critical' else 'warning' end,
      employee.id,
      employee.employee_no,
      employee.full_name,
      '当月休假天数预警',
      employee.full_name || ' 本月累计休假 ' || stats.occurrence_count::text || ' 天（回家不计）',
      pg_catalog.date_trunc('month', v_today)::date,
      v_today,
      stats.occurrence_count,
      pg_catalog.jsonb_build_object(
        'threshold', 5,
        'count', stats.occurrence_count,
        'public_holiday', stats.public_holiday,
        'leave', stats.leave_days,
        'absence', stats.absence_days,
        'half_day', stats.half_days,
        'home_leave_excluded', true
      ),
      'employee_attendance_records'
    from stats
    join public.employees employee on employee.id = stats.employee_id
    where employee.status in ('active', 'probation', 'suspended');
$old_monthly_leave$;
  v_new_block text := $new_monthly_leave$
    insert into pg_temp.admin_alert_group_candidates
    with stats as materialized (
      select day.employee_id,
        sum(case when day.event_kind = 'half_day' then 0.5 else 1 end)::numeric occurrence_count,
        count(*) filter (where day.event_kind = 'public_holiday') public_holiday,
        count(*) filter (where day.event_kind = 'leave') leave_days,
        count(*) filter (where day.event_kind = 'absence') absence_days,
        count(*) filter (where day.event_kind = 'half_day') half_days
      from pg_temp.admin_alert_group_attendance_days day
      where day.event_date >= pg_catalog.date_trunc('month', v_today)::date
        and day.event_date <= v_today
        and day.event_kind in ('public_holiday', 'leave', 'absence', 'half_day')
      group by day.employee_id
    ), source_evidence as materialized (
      select day.employee_id,
        count(distinct nullif(pg_catalog.lower(pg_catalog.btrim(source.source_group)), '')) source_group_count,
        min(nullif(pg_catalog.lower(pg_catalog.btrim(source.source_group)), '')) source_group_min
      from pg_temp.admin_alert_group_attendance_days day
      join public.employee_attendance_records record
        on record.employee_id = day.employee_id
       and record.event_date = day.event_date
       and record.kind = 'attendance'
       and not record.is_mirror
       and pg_catalog.lower(record.event_kind) in (
         'public_holiday', 'leave', 'half_day', 'absence', 'absent'
       )
      join public.attendance_sheet_sources source on source.id = record.source_id
      where day.event_date >= pg_catalog.date_trunc('month', v_today)::date
        and day.event_date <= v_today
        and day.event_kind in ('public_holiday', 'leave', 'absence', 'half_day')
      group by day.employee_id
    ), classified as (
      select stats.*,
        employee.employee_no,
        employee.full_name,
        employee.employment_type,
        case
          when evidence.source_group_count = 1
           and evidence.source_group_min = 'onsite_to_home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) = '现场转居家'
          then 'onsite_to_home'
          when evidence.source_group_count = 1
           and evidence.source_group_min = 'home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) in (
             '纯居家菲律宾', '纯居家（越南/缅甸/印尼等）'
           )
          then 'home'
          else 'legacy_fallback'
        end work_mode,
        case
          when evidence.source_group_count = 1
           and evidence.source_group_min = 'onsite_to_home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) = '现场转居家'
          then 2
          when evidence.source_group_count = 1
           and evidence.source_group_min = 'home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) in (
             '纯居家菲律宾', '纯居家（越南/缅甸/印尼等）'
           )
          then 4
          else 5
        end allowed_days,
        case
          when coalesce(evidence.source_group_count, 0) = 0 then 'unknown'
          when evidence.source_group_count > 1 then 'mixed'
          else evidence.source_group_min
        end source_group,
        case
          when evidence.source_group_count = 1
           and (
             (evidence.source_group_min = 'onsite_to_home'
               and pg_catalog.btrim(coalesce(employee.employment_type, '')) = '现场转居家')
             or
             (evidence.source_group_min = 'home'
               and pg_catalog.btrim(coalesce(employee.employment_type, '')) in (
                 '纯居家菲律宾', '纯居家（越南/缅甸/印尼等）'
               ))
           )
          then 'verified'
          else 'fallback'
        end classification_quality,
        case
          when coalesce(evidence.source_group_count, 0) = 0
          then 'missing_source_group'
          when evidence.source_group_count > 1
          then 'mixed_source_group'
          when evidence.source_group_min not in ('home', 'onsite_to_home')
          then 'unknown_source_group'
          when evidence.source_group_min = 'onsite_to_home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) <> '现场转居家'
          then 'employment_type_source_conflict'
          when evidence.source_group_min = 'home'
           and pg_catalog.btrim(coalesce(employee.employment_type, '')) not in (
             '纯居家菲律宾', '纯居家（越南/缅甸/印尼等）'
           )
          then 'employment_type_source_conflict'
        end classification_issue
      from stats
      join public.employees employee on employee.id = stats.employee_id
      left join source_evidence evidence on evidence.employee_id = stats.employee_id
      where employee.status in ('active', 'probation', 'suspended')
    ), qualified as (
      select classified.*
      from classified
      where classified.occurrence_count > classified.allowed_days
    )
    select
      'monthly_leave:' || qualified.employee_id::text || ':' || pg_catalog.to_char(v_today, 'YYYY-MM'),
      'monthly_leave',
      case when qualified.occurrence_count >= 8 then 'critical' else 'warning' end,
      qualified.employee_id,
      qualified.employee_no,
      qualified.full_name,
      '当月休假天数预警',
      qualified.full_name || ' 本月累计休假 ' || qualified.occurrence_count::text ||
        ' 天，已超过 ' || qualified.allowed_days::text || ' 天上限（回家不计）',
      pg_catalog.date_trunc('month', v_today)::date,
      v_today,
      qualified.occurrence_count,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'threshold', qualified.allowed_days,
        'allowed_days', qualified.allowed_days,
        'trigger_at', qualified.allowed_days + 1,
        'comparison_operator', '>',
        'half_day_weight', 0.5,
        'count', qualified.occurrence_count,
        'public_holiday', qualified.public_holiday,
        'leave', qualified.leave_days,
        'absence', qualified.absence_days,
        'half_day', qualified.half_days,
        'home_leave_excluded', true,
        'work_mode', qualified.work_mode,
        'source_group', qualified.source_group,
        'employment_type', nullif(pg_catalog.btrim(qualified.employment_type), ''),
        'classification_source', 'attendance_sheet_sources.source_group+employees.employment_type',
        'classification_quality', qualified.classification_quality,
        'classification_issue', qualified.classification_issue
      )),
      'employee_attendance_records'
    from qualified;
$new_monthly_leave$;
begin
  select pg_catalog.pg_get_functiondef(v_signature),
    procedure.prosecdef,
    procedure.proconfig
  into v_definition, v_security_definer, v_function_config
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  -- Validate the complete reviewed production shape before changing anything.
  if not coalesce(v_security_definer, false)
     or not coalesce('statement_timeout=6s' = any(v_function_config), false)
     or not coalesce('lock_timeout=500ms' = any(v_function_config), false)
     or position('pg_catalog.pg_try_advisory_xact_lock(' in v_definition) = 0
     or position(
       'pg_catalog.hashtextextended(''alerts_private.refresh_alerts'', 0)'
       in v_definition
     ) = 0
     or position('alerts_private.enrich_attendance_alert_details()' in v_definition) = 0
     or position('where v_group <> ''access_exam''' in v_definition) = 0
     or position('having count(distinct error.record_key) >= 6' in v_definition) = 0
     or position('error_frequency_candidates' in v_definition) > 0 then
    raise exception 'monthly_leave_threshold_function_precondition_failed';
  end if;

  v_old_hits := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_block, ''))
  ) / pg_catalog.length(v_old_block);
  v_new_hits := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_new_block, ''))
  ) / pg_catalog.length(v_new_block);

  if v_old_hits <> 1 or v_new_hits <> 0 then
    raise exception 'monthly_leave_threshold_block_shape_changed:old=%,new=%',
      v_old_hits, v_new_hits;
  end if;

  -- The exact block is known to occur once, so this cannot rewrite unrelated
  -- rules that happen to contain the same threshold token.
  v_updated_definition := pg_catalog.replace(
    v_definition,
    v_old_block,
    v_new_block
  );
  execute v_updated_definition;

  select pg_catalog.pg_get_functiondef(v_signature),
    procedure.prosecdef,
    procedure.proconfig
  into v_definition, v_security_definer, v_function_config
  from pg_catalog.pg_proc procedure
  where procedure.oid = v_signature;

  v_old_hits := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_old_block, ''))
  ) / pg_catalog.length(v_old_block);
  v_new_hits := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_new_block, ''))
  ) / pg_catalog.length(v_new_block);

  if v_old_hits <> 0
     or v_new_hits <> 1
     or not coalesce(v_security_definer, false)
     or not coalesce('statement_timeout=6s' = any(v_function_config), false)
     or not coalesce('lock_timeout=500ms' = any(v_function_config), false)
     or position(
       'pg_catalog.hashtextextended(''alerts_private.refresh_alerts'', 0)'
       in v_definition
     ) = 0
     or position('alerts_private.enrich_attendance_alert_details()' in v_definition) = 0
     or position('where classified.occurrence_count > classified.allowed_days' in v_definition) = 0
     or position('error_frequency_candidates' in v_definition) > 0 then
    raise exception 'monthly_leave_threshold_postcondition_failed';
  end if;
end;
$split_monthly_leave_threshold$;

comment on function alerts_private.refresh_alert_group(text) is
  'Bounded stable-alert refresh. Monthly leave uses canonical source_group plus exact employment_type cross-checks (>2 onsite-to-home, >4 pure-home, compatibility legacy >5 fallback); home_leave remains excluded and half-day remains 0.5. Experimental 1/3/7-day error detection remains absent.';

commit;
