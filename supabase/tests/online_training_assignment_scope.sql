-- Local integration test. Run only against a disposable database after all
-- migrations. Every mutation is rolled back.

begin;

insert into public.employees (
  id, employee_no, full_name, status, source_type, source_sheet
) values
  (
    '00000000-0000-4000-8000-000000000101',
    'OT-TRAINER-A', '__OT_TRAINER_A__', 'active', 'schedule_temp', 'test'
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    'OT-MEMBER-A', '__OT_MEMBER_A__', 'active', 'schedule_temp', 'test'
  ),
  (
    '00000000-0000-4000-8000-000000000103',
    'OT-TRAINER-B', '__OT_TRAINER_B__', 'active', 'schedule_temp', 'test'
  );

insert into public.online_training_reports (
  id, title, trainer_name, created_by, author_name, author_employee_no
) values (
  '00000000-0000-4000-8000-000000000201',
  '__OT_ASSIGNMENT_SCOPE_TEST__',
  '',
  '00000000-0000-4000-8000-000000000901',
  '__OT_FOUNDER_AUTHOR__',
  'OT-ADMIN'
);

insert into public.online_training_report_members (
  report_id, employee_id, employee_no, employee_name, trainer_name, sort_order
) values (
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000102',
  'OT-MEMBER-A',
  '__OT_MEMBER_A__',
  '__OT_TRAINER_A__',
  0
);

do $$
declare
  v_report_id constant uuid := '00000000-0000-4000-8000-000000000201';
  v_trainer_a constant uuid := '00000000-0000-4000-8000-000000000101';
begin
  if session_private.online_training_snapshot_employee_id(
    ' __OT TRAINER-A__ '
  ) is distinct from v_trainer_a then
    raise exception 'normalized unique trainer snapshot did not resolve';
  end if;

  if session_private.online_training_report_trainer_employee_id(v_report_id)
     is distinct from v_trainer_a then
    raise exception 'member-only legacy trainer snapshot did not resolve';
  end if;

  if public.online_training_caller_is_report_trainer(v_report_id) then
    raise exception 'an unauthenticated/unlinked caller claimed a trainer report';
  end if;

  if position(
    'online_training_caller_is_report_trainer'
    in pg_get_functiondef(
      'public.online_training_can_edit_report(uuid)'::regprocedure
    )
  ) <> 0 then
    raise exception 'historical trainer ownership expanded report edit access';
  end if;

  if not exists (
    select 1
    from public.online_training_reports report
    where report.id = v_report_id
      and report.created_by = '00000000-0000-4000-8000-000000000901'
      and report.author_name = '__OT_FOUNDER_AUTHOR__'
      and report.author_employee_no = 'OT-ADMIN'
  ) then
    raise exception 'trainer resolution changed the audit author';
  end if;
end;
$$;

update public.online_training_reports
set trainer_name = '__OT_TRAINER_A__'
where id = '00000000-0000-4000-8000-000000000201';

update public.online_training_report_members
set trainer_name = '__OT_TRAINER_B__'
where report_id = '00000000-0000-4000-8000-000000000201';

do $$
begin
  if session_private.online_training_report_trainer_employee_id(
    '00000000-0000-4000-8000-000000000201'
  ) is not null then
    raise exception 'mixed report/member trainer snapshots did not fail closed';
  end if;
end;
$$;

update public.online_training_report_members
set trainer_name = '__OT_TRAINER_A__'
where report_id = '00000000-0000-4000-8000-000000000201';

insert into public.employees (
  id, employee_no, full_name, status, source_type, source_sheet
) values (
  '00000000-0000-4000-8000-000000000104',
  'OT-TRAINER-A-DUPLICATE', '__OT_TRAINER_A__', 'active', 'schedule_temp', 'test'
);

do $$
begin
  if session_private.online_training_snapshot_employee_id(
    '__OT_TRAINER_A__'
  ) is not null then
    raise exception 'duplicate normalized trainer name did not fail closed';
  end if;
  if session_private.online_training_snapshot_employee_id(
    'OT-TRAINER-A'
  ) is not null then
    raise exception 'cross-field employee ID/name collision did not fail closed';
  end if;
  if session_private.online_training_report_trainer_employee_id(
    '00000000-0000-4000-8000-000000000201'
  ) is not null then
    raise exception 'report with ambiguous trainer identity did not fail closed';
  end if;
end;
$$;

rollback;
