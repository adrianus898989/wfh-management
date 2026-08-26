begin;

do $$
declare
  v_resolver text;
  v_writer text;
begin
  if to_regprocedure(
    'public.online_training_resolve_trainer_identities(jsonb)'
  ) is null then
    raise exception 'trainer identity resolver is missing';
  end if;

  select pg_get_functiondef(
    'public.online_training_resolve_trainer_identities(jsonb)'::regprocedure
  ) into v_resolver;
  if position('current_app_session_is_valid' in v_resolver) = 0
     or position('online_training_can_view_module' in v_resolver) = 0
     or position('jsonb_array_length(p_candidates) > 200' in v_resolver) = 0
     or position('employee_lifecycle_events' in v_resolver) = 0
     or position('online_training_identity_key(employee.employee_no)' in v_resolver) = 0
     or position('online_training_identity_key(employee.full_name)' in v_resolver) = 0
     or position('count(distinct lifecycle.employee_id) = 1' in v_resolver) = 0
     or position('online_training_identity_key' in v_resolver) = 0 then
    raise exception 'trainer identity resolver lost a guard or exact history lookup';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.online_training_resolve_trainer_identities(jsonb)',
    'EXECUTE'
  ) then
    raise exception 'authenticated role cannot execute trainer resolver';
  end if;
  if has_function_privilege(
    'anon',
    'public.online_training_resolve_trainer_identities(jsonb)',
    'EXECUTE'
  ) then
    raise exception 'anon role can execute trainer resolver';
  end if;

  select pg_get_functiondef(
    'public.online_training_save_report(jsonb,jsonb)'::regprocedure
  ) into v_writer;
  if position('online_training_report_summary_required' in v_writer) = 0
     or position('report_summary' in v_writer) = 0
     or position('online_training_employee_in_scope' in v_writer) = 0
     or position('online_training_save_report_scope_legacy' in v_writer) = 0 then
    raise exception 'report writer lost summary, scope, or legacy delegation guard';
  end if;
end;
$$;

rollback;
