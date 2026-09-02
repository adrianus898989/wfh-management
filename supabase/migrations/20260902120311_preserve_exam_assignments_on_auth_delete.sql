begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $guard$
declare
  v_nullable text;
begin
  if to_regclass('public.exam_assignments') is null
     or to_regclass('auth.users') is null then
    raise exception 'exam_assignment_auth_reference_missing';
  end if;

  select column_info.is_nullable
  into v_nullable
  from information_schema.columns column_info
  where column_info.table_schema = 'public'
    and column_info.table_name = 'exam_assignments'
    and column_info.column_name = 'updated_by';

  if v_nullable is distinct from 'YES' then
    raise exception 'exam_assignment_updated_by_must_be_nullable';
  end if;
end
$guard$;

-- updated_by is historical attribution, not ownership.  Keep the exam
-- assignment when an employee login identity is removed, matching the other
-- actor-reference columns in this schema that already use ON DELETE SET NULL.
alter table public.exam_assignments
  drop constraint if exists exam_assignments_updated_by_fkey;

alter table public.exam_assignments
  add constraint exam_assignments_updated_by_fkey
  foreign key (updated_by)
  references auth.users(id)
  on delete set null
  not valid;

alter table public.exam_assignments
  validate constraint exam_assignments_updated_by_fkey;

commit;
