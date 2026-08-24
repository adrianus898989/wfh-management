-- Make the browser lease authoritative for direct PostgREST access as well as
-- the protected RPC wrappers.  A replaced JWT can remain cryptographically
-- valid until its short access-token expiry; these central helpers and RLS
-- policies ensure it cannot keep reading or mutating application data.

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select r.code
  from public.user_access ua
  join public.roles r on r.id = ua.role_id
  where ua.auth_user_id = (select auth.uid())
    and ua.active = true
    and session_private.current_app_session_is_valid(null)
  limit 1;
$$;

create or replace function public.is_founder()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.current_app_session_is_valid('admin')
    and coalesce(public.current_user_role() = 'founder', false);
$$;

create or replace function public.has_permission(p_permission_code text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_role_id uuid;
  v_override boolean;
begin
  if v_user_id is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;

  if public.is_founder() then
    return true;
  end if;

  select ua.role_id
  into v_role_id
  from public.user_access ua
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true
  order by ua.updated_at desc
  limit 1;

  if v_role_id is null then
    return false;
  end if;

  select upo.allowed
  into v_override
  from public.user_permission_overrides upo
  join public.permissions p on p.id = upo.permission_id
  where upo.auth_user_id = v_user_id
    and p.code = p_permission_code;

  if found then
    return v_override;
  end if;

  return exists (
    select 1
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role_id
      and p.code = p_permission_code
  );
end;
$$;

create or replace function public.daily_work_is_active_backend()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.current_app_session_is_valid('admin')
    and exists (
      select 1
      from public.user_access ua
      where ua.auth_user_id = (select auth.uid())
        and ua.active = true
        and ua.backend_enabled = true
    );
$$;

create or replace function public.exam_is_admin(
  p_permission text default 'exam.view'
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select session_private.current_app_session_is_valid('admin')
    and exists (
      select 1
      from public.user_access ua
      where ua.auth_user_id = (select auth.uid())
        and ua.active = true
        and ua.backend_enabled = true
    )
    and public.has_permission(p_permission);
$$;

-- Staff activity is a public wrapper around a private implementation.  Only
-- the wrapper remains callable by the authenticated API role.
create or replace function public.staff_activity_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  return employee_ops_private.staff_activity_home();
end;
$$;

revoke all on function employee_ops_private.staff_activity_home()
  from public, anon, authenticated;
grant execute on function public.staff_activity_home() to authenticated;

-- Daily-work table and private media are direct client operations, so their
-- owner branches must also require the current admin lease.
drop policy if exists daily_work_submit on public.daily_work_reports;
create policy daily_work_submit
on public.daily_work_reports
for insert
to authenticated
with check (
  public.daily_work_is_active_backend()
  and created_by = (select auth.uid())
  and public.has_permission('daily_work.submit')
);

drop policy if exists daily_work_storage_upload on storage.objects;
create policy daily_work_storage_upload
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'daily-work'
  and public.daily_work_is_active_backend()
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.has_permission('daily_work.submit')
);

drop policy if exists daily_work_storage_delete on storage.objects;
create policy daily_work_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'daily-work'
  and public.daily_work_is_active_backend()
  and (
    owner_id = (select auth.uid())::text
    or public.has_permission('daily_work.manage')
    or exists (
      select 1
      from public.daily_work_reports report,
           jsonb_array_elements(report.attachments) attachment
      where attachment ->> 'path' = storage.objects.name
        and report.created_by = (select auth.uid())
    )
  )
);

drop policy if exists online_training_storage_delete on storage.objects;
create policy online_training_storage_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'online-training'
  and session_private.current_app_session_is_valid('admin')
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.has_permission('online_training.manage')
  )
);

-- Staff exam reads and all authenticated exam writes must belong to the
-- current browser.  The trigger covers SECURITY DEFINER start/save/submit and
-- admin grading paths without duplicating every exam function.
drop policy if exists exam_staff_sessions on public.exam_sessions;
create policy exam_staff_sessions
on public.exam_sessions
for select
to authenticated
using (
  session_private.current_app_session_is_valid('staff')
  and auth_user_id = (select auth.uid())
);

drop policy if exists exam_staff_answers on public.exam_answers;
create policy exam_staff_answers
on public.exam_answers
for select
to authenticated
using (
  session_private.current_app_session_is_valid('staff')
  and exists (
    select 1
    from public.exam_sessions s
    where s.id = exam_answers.session_id
      and s.auth_user_id = (select auth.uid())
  )
);

create or replace function public.enforce_current_exam_write_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Trusted database/service operations have no end-user JWT.  Every
  -- authenticated browser mutation must own either the current staff or admin
  -- lease; a replaced access token owns neither.
  if (select auth.uid()) is not null
     and not session_private.current_app_session_is_valid('staff')
     and not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists exam_sessions_current_session_guard
  on public.exam_sessions;
create trigger exam_sessions_current_session_guard
before insert or update or delete on public.exam_sessions
for each row execute function public.enforce_current_exam_write_session();

drop trigger if exists exam_answers_current_session_guard
  on public.exam_answers;
create trigger exam_answers_current_session_guard
before insert or update or delete on public.exam_answers
for each row execute function public.enforce_current_exam_write_session();

revoke all on function public.enforce_current_exam_write_session()
  from public, anon, authenticated;

-- Direct error-summary reads are retained for the existing reports, but now
-- use the same permission, current-session and employee-scope rules as the
-- employee detail RPCs.
drop policy if exists backend_read_employee_error_summary
  on public.employee_error_summary;
create policy backend_read_employee_error_summary
on public.employee_error_summary
for select
to authenticated
using (
  (
    public.has_permission('employee.view')
    or public.has_permission('report.view')
  )
  and exists (
    select 1
    from public.employees employee
    where regexp_replace(upper(coalesce(employee.employee_no, '')), '[^A-Z0-9]', '', 'g')
        = regexp_replace(upper(coalesce(employee_error_summary.employee_no, '')), '[^A-Z0-9]', '', 'g')
      and public.can_manage_employee(employee.id)
  )
);

drop policy if exists backend_read_employee_error_audit
  on public.employee_error_audit;
create policy backend_read_employee_error_audit
on public.employee_error_audit
for select
to authenticated
using (
  (
    public.has_permission('employee.view')
    or public.has_permission('report.view')
  )
  and exists (
    select 1
    from public.employees employee
    where regexp_replace(upper(coalesce(employee.employee_no, '')), '[^A-Z0-9]', '', 'g')
        = regexp_replace(upper(coalesce(employee_error_audit.employee_no, '')), '[^A-Z0-9]', '', 'g')
      and public.can_manage_employee(employee.id)
  )
);

drop policy if exists user_read_own_access on public.user_access;
create policy user_read_own_access
on public.user_access
for select
to authenticated
using (
  auth_user_id = (select auth.uid())
  and session_private.current_app_session_is_valid(null)
);

comment on function public.has_permission(text) is
  'Returns one backend permission only for the current admin browser lease.';
comment on function public.enforce_current_exam_write_session() is
  'Rejects exam mutations from a JWT whose browser lease was replaced.';
