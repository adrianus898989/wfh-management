begin;

-- Every current training reader already funnels through this helper. Make the
-- page checkbox the server-side module gate instead of the hidden legacy union.
create or replace function public.online_training_can_view_module()
returns boolean language sql stable security definer set search_path='' as $$
  select public.online_training_is_active_backend()
    and public.has_permission('online_training.report.view');
$$;
revoke all on function public.online_training_can_view_module() from public,anon,authenticated;
grant execute on function public.online_training_can_view_module() to authenticated,service_role;

-- All retained training implementations and storage-policy helpers must use
-- the visible page codes. Otherwise saving a role would have to restore the
-- old broad online_training.* permissions and reopen unrelated RPCs.
do $online_training_permission_bridges$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.online_training_bootstrap()',
    'public.online_training_can_view_report(uuid)',
    'public.online_training_can_edit_report(uuid)',
    'public.online_training_can_review_report(uuid)',
    'public.online_training_storage_can_upload(text)',
    'public.online_training_storage_can_delete(text,text)',
    'session_private.online_training_context_assignment_legacy()',
    'session_private.online_training_save_report_scope_legacy(jsonb,jsonb)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    if strpos(v_definition,'''online_training.submit''')=0
       and strpos(v_definition,'''online_training.review''')=0
       and strpos(v_definition,'''online_training.manage''')=0 then
      raise exception 'online_training_permission_guard_prerequisite_changed: %',v_signature;
    end if;
    execute replace(replace(replace(v_definition,
      '''online_training.submit''','''online_training.report.submit'''),
      '''online_training.review''','''online_training.report.review'''),
      '''online_training.manage''','''online_training.report.manage''');
  end loop;

  select pg_get_functiondef('public.online_training_employee_profile(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 then
    raise exception 'online_training_employee_profile_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,'''employee.view''','''employee.directory.view''');
end
$online_training_permission_bridges$;

alter function public.online_training_can_edit_report(uuid) rename to online_training_can_edit_report_granular_v1;
revoke all on function public.online_training_can_edit_report_granular_v1(uuid) from public,anon,authenticated;
create function public.online_training_can_edit_report(p_report_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select (public.has_permission('online_training.report.submit') or public.has_permission('online_training.report.manage'))
    and public.online_training_can_edit_report_granular_v1(p_report_id);
$$;
revoke all on function public.online_training_can_edit_report(uuid) from public,anon,authenticated;
grant execute on function public.online_training_can_edit_report(uuid) to authenticated,service_role;

alter function public.online_training_can_review_report(uuid) rename to online_training_can_review_report_granular_v1;
revoke all on function public.online_training_can_review_report_granular_v1(uuid) from public,anon,authenticated;
create function public.online_training_can_review_report(p_report_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select (public.has_permission('online_training.report.review') or public.has_permission('online_training.report.manage'))
    and public.online_training_can_review_report_granular_v1(p_report_id);
$$;
revoke all on function public.online_training_can_review_report(uuid) from public,anon,authenticated;
grant execute on function public.online_training_can_review_report(uuid) to authenticated,service_role;

alter function public.online_training_save_report(jsonb,jsonb) rename to online_training_save_report_granular_v1;
revoke all on function public.online_training_save_report_granular_v1(jsonb,jsonb) from public,anon,authenticated;
create function public.online_training_save_report(p_report jsonb,p_members jsonb)
returns uuid language plpgsql security definer set search_path='' as $$ begin
  if not (public.has_permission('online_training.report.submit') or public.has_permission('online_training.report.manage')) then raise exception 'permission_denied'; end if;
  return public.online_training_save_report_granular_v1(p_report,p_members);
end $$;

alter function public.online_training_archive_report(uuid) rename to online_training_archive_report_granular_v1;
revoke all on function public.online_training_archive_report_granular_v1(uuid) from public,anon,authenticated;
create function public.online_training_archive_report(p_report_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$ begin
  if not public.has_permission('online_training.report.manage') then raise exception 'permission_denied'; end if;
  return public.online_training_archive_report_granular_v1(p_report_id);
end $$;

alter function public.online_training_review_report(uuid,text,text) rename to online_training_review_report_granular_v1;
revoke all on function public.online_training_review_report_granular_v1(uuid,text,text) from public,anon,authenticated;
create function public.online_training_review_report(p_report_id uuid,p_status text,p_note text default '')
returns boolean language plpgsql security definer set search_path='' as $$ begin
  if not (public.has_permission('online_training.report.review') or public.has_permission('online_training.report.manage')) then raise exception 'permission_denied'; end if;
  return public.online_training_review_report_granular_v1(p_report_id,p_status,p_note);
end $$;
revoke all on function public.online_training_save_report(jsonb,jsonb),public.online_training_archive_report(uuid),public.online_training_review_report(uuid,text,text) from public,anon,authenticated;
grant execute on function public.online_training_save_report(jsonb,jsonb),public.online_training_archive_report(uuid),public.online_training_review_report(uuid,text,text) to authenticated,service_role;

-- Effective access was copied to the new page permissions by 113000. Retire
-- obsolete grants only after every retained implementation above has been
-- bridged. Founder remains unrestricted through the canonical founder rule.
delete from public.user_permission_overrides override_row
using public.permissions permission
where permission.id=override_row.permission_id and permission.code in (
  'employee.view','employee.resign','employee.reactivate',
  'schedule.view','attendance.view','attendance.edit','leave.approve',
  'online_training.view','online_training.submit','online_training.review','online_training.manage',
  'exam.view','exam.manage','exam.grade','exam.delete',
  'adjustment.view','adjustment.create','adjustment.approve',
  'payroll.view','payroll.edit','payroll.approve','payroll.publish','payroll.export','payroll.rule.edit',
  'payroll.payout_change.view','payroll.payout_change.review'
);
delete from public.role_permissions role_permission
using public.permissions permission
where permission.id=role_permission.permission_id and permission.code in (
  'employee.view','employee.resign','employee.reactivate',
  'schedule.view','attendance.view','attendance.edit','leave.approve',
  'online_training.view','online_training.submit','online_training.review','online_training.manage',
  'exam.view','exam.manage','exam.grade','exam.delete',
  'adjustment.view','adjustment.create','adjustment.approve',
  'payroll.view','payroll.edit','payroll.approve','payroll.publish','payroll.export','payroll.rule.edit',
  'payroll.payout_change.view','payroll.payout_change.review'
);

notify pgrst,'reload schema';
commit;
