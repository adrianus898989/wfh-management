-- Run against a disposable database after all migrations.  This test inspects
-- the guarded writer because invoking it requires a complete authenticated app
-- lease and a current remote-schedule snapshot.

begin;

do $online_training_not_started_regression$
declare
  v_attendance_constraint text;
  v_reason_constraint text;
  v_writer text;
  v_context text;
  v_public_context text;
  v_trainer_roster text;
  v_bootstrap text;
  v_reports text;
  v_list text;
  v_people text;
  v_trainers text;
begin
  select pg_get_constraintdef(oid)
  into v_attendance_constraint
  from pg_constraint
  where conrelid = 'public.online_training_report_members'::regclass
    and conname = 'online_training_report_members_attendance_status_check';

  if position('not_started' in coalesce(v_attendance_constraint, '')) = 0 then
    raise exception 'not_started is missing from the attendance constraint';
  end if;

  select pg_get_constraintdef(oid)
  into v_reason_constraint
  from pg_constraint
  where conrelid = 'public.online_training_report_members'::regclass
    and conname = 'online_training_report_members_status_reason_check';

  if position('not_started' in coalesce(v_reason_constraint, '')) > 0
     or position('leave' in coalesce(v_reason_constraint, '')) = 0
     or position('absent' in coalesce(v_reason_constraint, '')) = 0
     or position('transferred' in coalesce(v_reason_constraint, '')) = 0 then
    raise exception 'reason-required statuses changed unexpectedly';
  end if;

  select pg_get_functiondef(
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'::regprocedure
  ) into v_writer;
  if position(
       'v_attendance not in (''normal'', ''rest'', ''not_started'', ''leave'', ''absent'', ''transferred'')'
       in v_writer
     ) = 0
     or position('v_report_date >= v_employee.hire_date' in v_writer) = 0
     or position('v_employee.hire_date is null' in v_writer) = 0
     or position('v_report_date is null' in v_writer) = 0 then
    raise exception 'writer does not enforce the pre-hire-only not_started rule';
  end if;
  if position(
       'v_attendance in (''leave'', ''absent'', ''transferred'')'
       in v_writer
     ) = 0 then
    raise exception 'writer reason guard changed unexpectedly';
  end if;

  select pg_get_functiondef(
    'session_private.online_training_context_assignment_legacy()'::regprocedure
  ) into v_context;
  select pg_get_functiondef(
    'public.online_training_bootstrap()'::regprocedure
  ) into v_bootstrap;
  select pg_get_functiondef(
    'public.online_training_context()'::regprocedure
  ) into v_public_context;
  select pg_get_functiondef(
    'public.online_training_roster_for_trainer(text)'::regprocedure
  ) into v_trainer_roster;
  if position('''hire_date'', s.hire_date' in v_context) = 0
     or position('''hire_date'', hire_date' in v_bootstrap) = 0
     or position('''hire_date'', scoped.hire_date' in v_public_context) = 0
     or position('''hire_date'', employee.hire_date' in v_trainer_roster) = 0 then
    raise exception 'roster payload does not expose hire_date to the editor';
  end if;

  select pg_get_functiondef(
    'public.online_training_search_reports(jsonb,integer,integer)'::regprocedure
  ) into v_reports;
  select pg_get_functiondef(
    'public.online_training_list(text,date,date,uuid,integer,integer)'::regprocedure
  ) into v_list;
  if position('''hire_date'', employee.hire_date' in v_reports) = 0
     or position('''hire_date'', employee.hire_date' in v_list) = 0 then
    raise exception 'existing report member payloads do not expose hire_date';
  end if;

  select pg_get_functiondef(
    'public.online_training_search_people(jsonb,integer,integer)'::regprocedure
  ) into v_people;
  select pg_get_functiondef(
    'public.online_training_search_trainers(jsonb,integer,integer)'::regprocedure
  ) into v_trainers;
  if position('not_started_count' in v_people) = 0
     or position('member.attendance_status = ''not_started''' in v_trainers) = 0
     or position('report.not_started_count' in v_trainers) = 0 then
    raise exception 'not_started summary counts are incomplete';
  end if;

  if has_function_privilege(
       'authenticated',
       'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'private report writer became directly executable';
  end if;
  if not has_function_privilege(
       'authenticated',
       'public.online_training_save_report(jsonb,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'public report writer grant was lost';
  end if;
end
$online_training_not_started_regression$;

rollback;
