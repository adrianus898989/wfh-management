-- Storage policies run as the authenticated role.  Keep employee and incident
-- tables private by moving their scope checks into narrow boolean-only,
-- security-definer helpers.

create or replace function public.connectivity_storage_admin_can_manage_employee_path(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    session_private.current_app_session_is_valid('admin')
    and exists(
      select 1
      from public.employees employee
      where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')
        = regexp_replace(upper(split_part(coalesce(p_name,''),'/',2)),'[^A-Z0-9]','','g')
        and public.can_manage_employee(employee.id)
    );
$$;

create or replace function public.connectivity_storage_admin_can_view_incident_path(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    session_private.current_app_session_is_valid('admin')
    and exists(
      select 1
      from public.employee_connectivity_incidents incident
      where incident.attachments @> jsonb_build_array(jsonb_build_object('path',coalesce(p_name,'')))
        and public.can_manage_employee(incident.employee_id)
    );
$$;

create or replace function public.connectivity_storage_staff_can_view_incident_path(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    session_private.current_app_session_is_valid('staff')
    and exists(
      select 1
      from public.employee_connectivity_incidents incident
      join public.user_access access
        on access.employee_id=incident.employee_id
       and access.auth_user_id=(select auth.uid())
       and access.active
       and access.employee_portal_enabled
      where incident.attachments @> jsonb_build_array(jsonb_build_object('path',coalesce(p_name,'')))
    );
$$;

revoke all on function public.connectivity_storage_admin_can_manage_employee_path(text)
  from public,anon,authenticated;
revoke all on function public.connectivity_storage_admin_can_view_incident_path(text)
  from public,anon,authenticated;
revoke all on function public.connectivity_storage_staff_can_view_incident_path(text)
  from public,anon,authenticated;
grant execute on function public.connectivity_storage_admin_can_manage_employee_path(text)
  to authenticated;
grant execute on function public.connectivity_storage_admin_can_view_incident_path(text)
  to authenticated;
grant execute on function public.connectivity_storage_staff_can_view_incident_path(text)
  to authenticated;

drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
on storage.objects for select to authenticated
using(
  bucket_id='connectivity-evidence'
  and (
    (
      public.has_permission('connectivity.view')
      and public.connectivity_storage_admin_can_view_incident_path(name)
    )
    or (
      owner_id=(select auth.uid())::text
      and (
        public.has_permission('connectivity.create')
        or public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and public.connectivity_storage_admin_can_manage_employee_path(name)
    )
    or (
      (
        public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and public.connectivity_storage_admin_can_manage_employee_path(name)
    )
    or public.connectivity_storage_staff_can_view_incident_path(name)
  )
);

drop policy if exists connectivity_evidence_admin_insert on storage.objects;
create policy connectivity_evidence_admin_insert
on storage.objects for insert to authenticated
with check(
  bucket_id='connectivity-evidence'
  and (
    public.has_permission('connectivity.create')
    or public.has_permission('connectivity.edit')
  )
  and split_part(name,'/',1)=(select auth.uid())::text
  and public.connectivity_storage_admin_can_manage_employee_path(name)
);

drop policy if exists connectivity_evidence_admin_delete on storage.objects;
create policy connectivity_evidence_admin_delete
on storage.objects for delete to authenticated
using(
  bucket_id='connectivity-evidence'
  and (
    (
      owner_id=(select auth.uid())::text
      and (
        public.has_permission('connectivity.create')
        or public.has_permission('connectivity.edit')
      )
      and public.connectivity_storage_admin_can_manage_employee_path(name)
    )
    or (
      (
        public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
      and public.connectivity_storage_admin_can_manage_employee_path(name)
    )
  )
);

comment on function public.connectivity_storage_admin_can_manage_employee_path(text) is
  'Boolean-only Storage RLS helper for an in-scope employee encoded in a connectivity object path.';
comment on function public.connectivity_storage_admin_can_view_incident_path(text) is
  'Boolean-only Storage RLS helper for an in-scope connectivity incident attachment.';
comment on function public.connectivity_storage_staff_can_view_incident_path(text) is
  'Boolean-only Storage RLS helper allowing staff to read only their own incident attachments.';

notify pgrst,'reload schema';
