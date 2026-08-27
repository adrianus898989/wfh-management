begin;

-- "not_started" is only for employees already present in the remote roster
-- whose report date is still before their hire date.  It intentionally does
-- not join the statuses that require a free-text reason.
alter table public.online_training_report_members
  drop constraint if exists online_training_report_members_attendance_status_check;

alter table public.online_training_report_members
  add constraint online_training_report_members_attendance_status_check
  check (
    attendance_status in (
      'normal', 'rest', 'not_started', 'leave', 'absent', 'transferred'
    )
  );

alter table public.online_training_report_members
  drop constraint if exists online_training_report_members_status_reason_check;

alter table public.online_training_report_members
  add constraint online_training_report_members_status_reason_check
  check (
    attendance_status not in ('leave', 'absent', 'transferred')
    or nullif(btrim(status_note), '') is not null
  );

comment on column public.online_training_report_members.attendance_status is
  'Daily training status. not_started is allowed by the writer only when report_date is before the employee hire_date.';

-- The public writer has several permission/scope wrappers.  Preserve them and
-- update the single private implementation that performs member validation.
do $online_training_not_started_writer$
declare
  v_definition text;
  v_next text;
  v_old_allowlist constant text :=
    'if v_attendance not in (''normal'', ''rest'', ''leave'', ''absent'', ''transferred'') then';
  v_new_allowlist constant text :=
    'if v_attendance not in (''normal'', ''rest'', ''not_started'', ''leave'', ''absent'', ''transferred'') then';
  v_normal_guard constant text :=
    '    if v_attendance = ''normal''';
  v_not_started_guard constant text :=
    E'    if v_attendance = ''not_started'' and v_report_date is null then\n'
    || E'      raise exception ''请先选择报告日期再使用未入'';\n'
    || E'    end if;\n\n'
    || E'    if v_attendance = ''not_started'' and v_employee.hire_date is null then\n'
    || E'      raise exception ''% 的员工档案缺少入职日期，不能标记未入'', v_employee.employee_no;\n'
    || E'    end if;\n\n'
    || E'    if v_attendance = ''not_started'' and v_report_date >= v_employee.hire_date then\n'
    || E'      raise exception ''% 已到入职日期，不能标记未入'', v_employee.employee_no;\n'
    || E'    end if;\n\n'
    || '    if v_attendance = ''normal''';
begin
  if to_regprocedure(
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'
  ) is null then
    raise exception 'online_training_not_started_writer_missing';
  end if;

  select pg_get_functiondef(
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'::regprocedure
  ) into v_definition;

  if position(v_new_allowlist in v_definition) = 0 then
    if position(v_old_allowlist in v_definition) = 0 then
      raise exception 'online_training_not_started_writer_allowlist_changed';
    end if;
    v_definition := replace(v_definition, v_old_allowlist, v_new_allowlist);
  end if;

  if position('v_report_date >= v_employee.hire_date' in v_definition) = 0 then
    if position(v_normal_guard in v_definition) = 0 then
      raise exception 'online_training_not_started_writer_normal_guard_changed';
    end if;
    v_definition := replace(
      v_definition,
      v_normal_guard,
      v_not_started_guard
    );
  end if;

  v_next := v_definition;
  if position(v_new_allowlist in v_next) = 0
     or position('v_report_date >= v_employee.hire_date' in v_next) = 0
     or position(
       'v_attendance in (''leave'', ''absent'', ''transferred'')'
       in v_next
     ) = 0 then
    raise exception 'online_training_not_started_writer_patch_incomplete';
  end if;
  execute v_next;
end
$online_training_not_started_writer$;

-- Include hire_date in both roster sources used by the regular trainer and by
-- the founder/manager picker, so the UI can disable the status before submit.
do $online_training_context_hire_date$
declare
  v_target regprocedure;
  v_definition text;
  v_old_source constant text :=
    E'      e.status,\n      coalesce(nullif(btrim(sr.item->>''country''), ''''), e.country, e.nationality, '''') as country,';
  v_new_source constant text :=
    E'      e.status,\n      e.hire_date,\n      coalesce(nullif(btrim(sr.item->>''country''), ''''), e.country, e.nationality, '''') as country,';
  v_old_context_payload constant text :=
    E'        ''status'', s.status,\n        ''country'', s.country,';
  v_new_context_payload constant text :=
    E'        ''status'', s.status,\n        ''hire_date'', s.hire_date,\n        ''country'', s.country,';
  v_old_bootstrap_payload constant text :=
    E'    ''status'', status,\n    ''country'', country,';
  v_new_bootstrap_payload constant text :=
    E'    ''status'', status,\n    ''hire_date'', hire_date,\n    ''country'', country,';
begin
  foreach v_target in array array[
    to_regprocedure('session_private.online_training_context_assignment_legacy()'),
    to_regprocedure('public.online_training_bootstrap()')
  ] loop
    if v_target is null then
      raise exception 'online_training_roster_source_missing';
    end if;
    select pg_get_functiondef(v_target) into v_definition;
    if position('''hire_date'', s.hire_date' in v_definition) > 0
       or position('''hire_date'', hire_date' in v_definition) > 0 then
      continue;
    end if;
    if position(v_old_source in v_definition) = 0 then
      raise exception 'online_training_roster_source_changed: %', v_target;
    end if;
    v_definition := replace(v_definition, v_old_source, v_new_source);
    if position(v_old_context_payload in v_definition) > 0 then
      v_definition := replace(
        v_definition,
        v_old_context_payload,
        v_new_context_payload
      );
    elsif position(v_old_bootstrap_payload in v_definition) > 0 then
      v_definition := replace(
        v_definition,
        v_old_bootstrap_payload,
        v_new_bootstrap_payload
      );
    else
      raise exception 'online_training_roster_payload_changed: %', v_target;
    end if;
    if position('''hire_date'', s.hire_date' in v_definition) = 0
       and position('''hire_date'', hire_date' in v_definition) = 0 then
      raise exception 'online_training_roster_hire_date_patch_incomplete: %', v_target;
    end if;
    execute v_definition;
  end loop;
end
$online_training_context_hire_date$;

-- Existing report rows are also editable.  Enrich their member snapshots with
-- the current authoritative hire date in the same bounded member query, so an
-- edit uses the same pre-hire rule as a newly loaded roster without N+1 calls.
do $online_training_report_member_hire_date$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  if to_regprocedure(
    'public.online_training_search_reports(jsonb,integer,integer)'
  ) is null then
    raise exception 'online_training_search_reports_missing';
  end if;
  select pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if position('''hire_date'', employee.hire_date' in v_definition) = 0 then
    v_old := E'              to_jsonb(member) order by member.sort_order, member.employee_name\n'
      || E'            )\n'
      || E'            from public.online_training_report_members member\n'
      || '            where member.report_id = page_report.id';
    v_new := E'              to_jsonb(member)\n'
      || E'              || jsonb_build_object(''hire_date'', employee.hire_date)\n'
      || E'              order by member.sort_order, member.employee_name\n'
      || E'            )\n'
      || E'            from public.online_training_report_members member\n'
      || E'            left join public.employees employee\n'
      || E'              on employee.id = member.employee_id\n'
      || '            where member.report_id = page_report.id';
    if position(v_old in v_definition) = 0 then
      raise exception 'online_training_search_reports_member_payload_changed';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    if position('''hire_date'', employee.hire_date' in v_definition) = 0 then
      raise exception 'online_training_search_reports_hire_date_patch_incomplete';
    end if;
    execute v_definition;
  end if;

  if to_regprocedure(
    'public.online_training_list(text,date,date,uuid,integer,integer)'
  ) is null then
    raise exception 'online_training_list_missing';
  end if;
  select pg_get_functiondef(
    'public.online_training_list(text,date,date,uuid,integer,integer)'::regprocedure
  ) into v_definition;
  if position('''hire_date'', employee.hire_date' in v_definition) = 0 then
    v_old := E'          to_jsonb(member) order by member.sort_order, member.employee_name\n'
      || E'        )\n'
      || E'        from public.online_training_report_members member\n'
      || '        where member.report_id = report.id';
    v_new := E'          to_jsonb(member)\n'
      || E'          || jsonb_build_object(''hire_date'', employee.hire_date)\n'
      || E'          order by member.sort_order, member.employee_name\n'
      || E'        )\n'
      || E'        from public.online_training_report_members member\n'
      || E'        left join public.employees employee\n'
      || E'          on employee.id = member.employee_id\n'
      || '        where member.report_id = report.id';
    if position(v_old in v_definition) = 0 then
      raise exception 'online_training_list_member_payload_changed';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    if position('''hire_date'', employee.hire_date' in v_definition) = 0 then
      raise exception 'online_training_list_hire_date_patch_incomplete';
    end if;
    execute v_definition;
  end if;
end
$online_training_report_member_hire_date$;

-- Employee history summary returned by online_training_search_people.
do $online_training_people_not_started_count$
declare
  v_definition text;
  v_old constant text :=
    E'      count(distinct history.report_date)\n        filter (where history.attendance_status = ''transferred'')::integer home_count,';
  v_new constant text :=
    E'      count(distinct history.report_date)\n        filter (where history.attendance_status = ''transferred'')::integer home_count,\n'
    || E'      count(distinct history.report_date)\n        filter (where history.attendance_status = ''not_started'')::integer not_started_count,';
begin
  if to_regprocedure(
    'public.online_training_search_people(jsonb,integer,integer)'
  ) is null then
    raise exception 'online_training_search_people_missing';
  end if;
  select pg_get_functiondef(
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if position('not_started_count' in v_definition) = 0 then
    if position(v_old in v_definition) = 0 then
      raise exception 'online_training_search_people_home_count_changed';
    end if;
    v_definition := replace(v_definition, v_old, v_new);
    execute v_definition;
  end if;
end
$online_training_people_not_started_count$;

-- Trainer summary is report-member based and therefore needs the same count in
-- both the aggregate CTE and the final row payload.
do $online_training_trainer_not_started_count$
declare
  v_definition text;
  v_old_aggregate constant text :=
    '      count(*) filter (where member.attendance_status = ''transferred'')::integer home_count,';
  v_new_aggregate constant text :=
    E'      count(*) filter (where member.attendance_status = ''transferred'')::integer home_count,\n'
    || '      count(*) filter (where member.attendance_status = ''not_started'')::integer not_started_count,';
  v_old_summary constant text :=
    '      coalesce(report.home_count, 0)::integer home_count,';
  v_new_summary constant text :=
    E'      coalesce(report.home_count, 0)::integer home_count,\n'
    || '      coalesce(report.not_started_count, 0)::integer not_started_count,';
begin
  if to_regprocedure(
    'public.online_training_search_trainers(jsonb,integer,integer)'
  ) is null then
    raise exception 'online_training_search_trainers_missing';
  end if;
  select pg_get_functiondef(
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ) into v_definition;
  if position('member.attendance_status = ''not_started''' in v_definition) = 0 then
    if position(v_old_aggregate in v_definition) = 0
       or position(v_old_summary in v_definition) = 0 then
      raise exception 'online_training_search_trainers_summary_changed';
    end if;
    v_definition := replace(v_definition, v_old_aggregate, v_new_aggregate);
    v_definition := replace(v_definition, v_old_summary, v_new_summary);
    if position('report.not_started_count' in v_definition) = 0 then
      raise exception 'online_training_search_trainers_patch_incomplete';
    end if;
    execute v_definition;
  end if;
end
$online_training_trainer_not_started_count$;

select pg_notify('pgrst', 'reload schema');

commit;
