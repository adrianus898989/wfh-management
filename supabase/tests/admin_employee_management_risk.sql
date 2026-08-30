-- Run against a disposable database after all migrations. This test guards
-- the API boundary, authoritative organization source and non-causal contract.
begin;

set local search_path=pg_catalog;

do $$
declare
  v_function regprocedure:=
    'public.admin_employee_management_risk(date,date,jsonb,integer)'::regprocedure;
  v_definition text:=pg_get_functiondef(v_function);
begin
  if position('session_private.current_app_session_is_valid(''admin'')' in v_definition)=0
     or position('public.has_permission(''employee.management_risk.view'')' in v_definition)=0
     or position('attendance_private.current_schedule_roster()' in v_definition)=0 then
    raise exception 'management risk RPC lost its session, permission or current-roster guard';
  end if;

  if (position('authorized_employee_ids as materialized' in v_definition)=0
     and position('public.backend_employee_in_scope(roster.employee_id)' in v_definition)=0)
     or position('public.user_scope_teams' in v_definition)>0
     or position('v_scope=''own_team''' in replace(v_definition,' ',''))>0 then
    raise exception 'management risk RPC lost its current-roster data-scope boundary';
  end if;

  if position('public.report_employee_error_rows' in v_definition)=0
     or position('public.exam_sessions' in v_definition)=0
     or position('public.legacy_exam_sessions' in v_definition)=0
     or position('public.employee_attendance_records' in v_definition)=0 then
    raise exception 'management risk RPC lost an event source';
  end if;

  if position('team_name_raw' in v_definition)>0
     or position('manager_raw' in v_definition)>0
     or position('report_employee_error_admin_v' in v_definition)>0 then
    raise exception 'management risk RPC reused historical event organization fields';
  end if;

  if position('error_rate_per_100' in v_definition)=0
     or position('exam_failure_rate_pct' in v_definition)=0
     or position('attendance_rate_per_100' in v_definition)=0
     or position('deduction_rate_per_100' in v_definition)=0
     or position('minimum_sample_rules' in v_definition)=0
     or position('causality_notice' in v_definition)=0 then
    raise exception 'management risk normalization, sample, or causality contract regressed';
  end if;

  if position('''options''' in v_definition)=0
     or position('''organization''' in v_definition)=0
     or position('''repeat_employees''' in v_definition)=0
     or position('''common_issues''' in v_definition)=0
     or position('''daily''' in v_definition)=0
     or position('''weekly''' in v_definition)=0 then
    raise exception 'management risk JSON contract regressed';
  end if;

  if position('organization_rank' in v_definition)=0
     or position(
       'metric.dimension=''group'' and metric.organization_rank<=v_top_limit'
       in v_definition
     )=0
     or position(
       'metric.dimension=''manager'' and metric.organization_rank<=v_top_limit'
       in v_definition
     )=0
     or position('option_groups as materialized' in v_definition)=0
     or position('option_managers as materialized' in v_definition)=0 then
    raise exception 'management risk ranking payload is no longer bounded while options remain complete';
  end if;

  if position('''name'',option.team_name' in replace(v_definition,' ',''))=0
     or position('''name'',option.group_name' in replace(v_definition,' ',''))=0
     or position('''name'',option.manager_name' in replace(v_definition,' ',''))=0
     or position('''affected_employees''' in v_definition)=0
     or position('''negative_rate_per_100''' in v_definition)=0
     or position('''category_label''' in v_definition)=0
     or position('''min_sample_rules''' in v_definition)=0 then
    raise exception 'management risk presentation aliases regressed';
  end if;

  if not has_function_privilege('authenticated',v_function,'execute')
     or has_function_privilege('anon',v_function,'execute') then
    raise exception 'management risk RPC execute privileges changed';
  end if;

  if not exists(
    select 1 from pg_proc procedure
    where procedure.oid=v_function
      and procedure.prosecdef
      and procedure.provolatile='s'
      and coalesce(array_to_string(procedure.proconfig,','),'') like '%search_path=%'
  ) then
    raise exception 'management risk RPC must remain stable, security definer, and search_path pinned';
  end if;
end;
$$;

do $$
declare
  v_score regprocedure:=
    'attendance_private.management_risk_score(integer,integer,integer,integer,integer,integer)'::regprocedure;
  v_flags regprocedure:=
    'attendance_private.management_risk_sample_flags(integer,integer,integer)'::regprocedure;
begin
  if (select provolatile from pg_proc where oid=v_score)<>'i'
     or (select provolatile from pg_proc where oid=v_flags)<>'i' then
    raise exception 'management risk scoring helpers must remain immutable';
  end if;

  if attendance_private.management_risk_score(10,30,10,10,20,20)<>100
     or attendance_private.management_risk_score(0,30,10,10,20,20)<>0 then
    raise exception 'management risk score caps changed';
  end if;

  if attendance_private.management_risk_sample_flags(4,4,4)
       <>jsonb_build_array('low_event_sample','low_exam_sample','low_headcount') then
    raise exception 'management risk minimum-sample flags changed';
  end if;

  if attendance_private.management_risk_sample_flags(10,0,0)<>'[]'::jsonb then
    raise exception 'zero negative events must not be mislabeled as a small positive sample';
  end if;

  if has_function_privilege('authenticated',v_score,'execute')
     or has_function_privilege('authenticated',v_flags,'execute') then
    raise exception 'private management risk helpers became directly executable';
  end if;
end;
$$;

do $$
begin
  if not exists(
    select 1 from public.permissions permission
    where permission.code='employee.management_risk.view'
      and permission.sensitive
  ) then
    raise exception 'management risk permission is missing or not sensitive';
  end if;

  if exists(
    select 1
    from public.role_permissions role_permission
    join public.permissions permission on permission.id=role_permission.permission_id
    where permission.code='employee.management_risk.view'
  ) then
    raise exception 'management risk permission was granted to a non-Founder role by default';
  end if;
end;
$$;

rollback;
