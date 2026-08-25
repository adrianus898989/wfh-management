-- Keep evidence reads on native private-bucket signed URLs without an Edge
-- Function hop.  The previous storage.objects policy queried protected public
-- tables directly as `authenticated`; authenticated intentionally has no
-- SELECT grant on those tables, so policy evaluation returned HTTP 400 even
-- when the object existed.  Encapsulate all authorization in one guarded
-- SECURITY DEFINER helper and expose only its boolean result to Storage RLS.

create or replace function public.connectivity_can_read_evidence(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_object_name text := btrim(coalesce(p_object_name,''));
  v_employee_key text;
  v_staff_session boolean := false;
begin
  if v_user_id is null
     or v_object_name=''
     or left(v_object_name,1)='/'
     or v_object_name like '%../%'
     or v_object_name like '../%'
  then
    return false;
  end if;

  -- An incident-bound object is readable either by an in-scope backend user
  -- with connectivity.view, or by the active employee who owns the record.
  if public.has_permission('connectivity.view') then
    if exists(
      select 1
      from public.employee_connectivity_incidents incident
      where incident.attachments @>
        jsonb_build_array(jsonb_build_object('path',v_object_name))
        and public.can_manage_employee(incident.employee_id)
    ) then
      return true;
    end if;
  end if;

  v_staff_session := session_private.current_app_session_is_valid('staff');
  if v_staff_session and exists(
    select 1
    from public.employee_connectivity_incidents incident
    join public.user_access access
      on access.employee_id=incident.employee_id
     and access.auth_user_id=v_user_id
     and access.active=true
     and access.employee_portal_enabled=true
    join public.employees employee
      on employee.id=incident.employee_id
     and employee.status='active'
    where incident.attachments @>
      jsonb_build_array(jsonb_build_object('path',v_object_name))
  ) then
    return true;
  end if;

  -- Preserve the existing edit workflow for a canonical object uploaded
  -- before its incident row is saved: actor_uuid/employee_no/date/file.
  v_employee_key := regexp_replace(
    upper(split_part(v_object_name,'/',2)),
    '[^A-Z0-9]','','g'
  );
  if v_employee_key='' then
    return false;
  end if;

  if (
    (
      split_part(v_object_name,'/',1)=v_user_id::text
      and (
        public.has_permission('connectivity.create')
        or public.has_permission('connectivity.edit')
        or public.has_permission('connectivity.delete')
      )
    )
    or public.has_permission('connectivity.edit')
    or public.has_permission('connectivity.delete')
  ) and exists(
    select 1
    from public.employees employee
    where regexp_replace(upper(employee.employee_no),'[^A-Z0-9]','','g')=v_employee_key
      and public.can_manage_employee(employee.id)
  ) then
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.connectivity_can_read_evidence(text)
  from public,anon,authenticated;
grant execute on function public.connectivity_can_read_evidence(text)
  to authenticated,service_role;

drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
on storage.objects for select to authenticated
using(
  bucket_id='connectivity-evidence'
  and public.connectivity_can_read_evidence(storage.objects.name)
);

comment on function public.connectivity_can_read_evidence(text) is
  'Authorizes private connectivity evidence reads for a current staff self-session or an in-scope backend user without exposing protected business tables to authenticated.';

notify pgrst,'reload schema';
