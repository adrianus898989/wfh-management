-- Enforce the claimed browser lease in server-side admin entry points and
-- remove direct authenticated access to private employee-history functions.

create or replace function session_private.current_app_session_is_valid(
  p_portal text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_text text := nullif(btrim(coalesce((select auth.jwt()->>'session_id'),'')), '');
  v_session_id uuid;
begin
  if v_user_id is null or v_session_text is null then return false; end if;
  begin
    v_session_id:=v_session_text::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return exists(
    select 1
    from public.app_session_leases lease
    join auth.sessions auth_session
      on auth_session.id=lease.session_id
     and auth_session.user_id=lease.user_id
    where lease.user_id=v_user_id
      and lease.session_id=v_session_id
      and lease.lease_expires_at>clock_timestamp()
      and (p_portal is null or lease.portal=lower(btrim(p_portal)))
  );
end;
$$;

revoke all on function session_private.current_app_session_is_valid(text)
  from public,anon,authenticated;

create or replace function public.can_manage_employee(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_scope text;
  v_current_employee uuid;
  v_current_team uuid;
  v_target_team uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then return false; end if;
  if v_user_id is null or p_employee_id is null then return false; end if;
  if public.is_founder() then return true; end if;

  select ua.data_scope,ua.employee_id,e.team_id
  into v_scope,v_current_employee,v_current_team
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  where ua.auth_user_id=v_user_id
    and ua.active=true
    and ua.backend_enabled=true
  order by ua.updated_at desc
  limit 1;

  if v_scope is null then return false; end if;
  if v_scope='all' then return true; end if;
  if p_employee_id=v_current_employee then return true; end if;
  if v_scope='self' then return false; end if;

  select e.team_id into v_target_team from public.employees e where e.id=p_employee_id;
  if not found then return false; end if;
  if v_scope='own_team' then
    return v_current_team is not null and v_current_team=v_target_team;
  end if;
  if v_scope='assigned_teams' then
    return exists(
      select 1 from public.user_scope_employees se
      where se.auth_user_id=v_user_id and se.employee_id=p_employee_id
    ) or exists(
      select 1 from public.user_scope_teams st
      where st.auth_user_id=v_user_id and st.team_id=v_target_team
    );
  end if;
  return false;
end;
$$;

create or replace function public.online_training_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_caller_team_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then return false; end if;
  if p_employee_id is null or not public.online_training_can_view_module() then return false; end if;

  select ua.employee_id,ua.data_scope,e.team_id
  into v_caller_employee_id,v_scope,v_caller_team_id
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  where ua.auth_user_id=v_user_id and ua.active=true and ua.backend_enabled=true
  order by ua.updated_at desc
  limit 1;

  if public.is_founder() or v_scope='all' then return true; end if;
  if p_employee_id=v_caller_employee_id then return true; end if;

  if v_scope='assigned_teams' then
    return exists(
      select 1 from public.employees e
      where e.id=p_employee_id and (
        exists(select 1 from public.user_scope_employees se
          where se.auth_user_id=v_user_id and se.employee_id=e.id)
        or exists(select 1 from public.user_scope_teams st
          where st.auth_user_id=v_user_id and st.team_id=e.team_id)
      )
    );
  end if;
  if v_scope='own_team' and v_caller_team_id is not null then
    return exists(select 1 from public.employees e
      where e.id=p_employee_id and e.team_id=v_caller_team_id);
  end if;
  return false;
end;
$$;

create or replace function public.online_training_list(
  p_query text default '',
  p_date_from date default null,
  p_date_to date default null,
  p_employee_id uuid default null,
  p_page integer default 1,
  p_page_size integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query,'')));
  v_page integer := greatest(coalesce(p_page,1),1);
  v_page_size integer := least(greatest(coalesce(p_page_size,12),1),50);
  v_total integer;
  v_rows jsonb;
  v_full_scope boolean := false;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  select public.is_founder() or exists(
    select 1 from public.user_access ua
    where ua.auth_user_id=(select auth.uid())
      and ua.active=true and ua.backend_enabled=true and ua.data_scope='all'
  ) into v_full_scope;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if p_employee_id is not null
     and not public.online_training_employee_in_scope(p_employee_id) then
    raise exception '无权查看该员工培训记录';
  end if;

  with visible as materialized (
    select r.*
    from public.online_training_reports r
    where r.status='published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date>=p_date_from)
      and (p_date_to is null or r.report_date<=p_date_to)
      and exists(
        select 1 from public.online_training_report_members scoped_member
        where scoped_member.report_id=r.id
          and (p_employee_id is null or scoped_member.employee_id=p_employee_id)
          and public.online_training_employee_in_scope(scoped_member.employee_id)
      )
      and (
        v_query=''
        or lower(concat_ws(' ',r.title,r.platform,r.shift_name,r.team_name,
          r.group_name,r.leader_name,r.trainer_name,r.course_type,
          r.report_summary,r.issues_summary,r.next_plan)) like '%'||v_query||'%'
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id
            and (p_employee_id is null or m.employee_id=p_employee_id)
            and public.online_training_employee_in_scope(m.employee_id)
            and lower(concat_ws(' ',m.employee_no,m.employee_name,m.position_name,
              m.team_name,m.group_name,m.shift_name,m.platform,
              m.work_details,m.performance,m.issues,m.follow_up)) like '%'||v_query||'%'
        )
      )
  )
  select count(*) into v_total from visible;

  with visible as materialized (
    select r.*
    from public.online_training_reports r
    where r.status='published'
      and public.online_training_can_view_report(r.id)
      and (p_date_from is null or r.report_date>=p_date_from)
      and (p_date_to is null or r.report_date<=p_date_to)
      and exists(
        select 1 from public.online_training_report_members scoped_member
        where scoped_member.report_id=r.id
          and (p_employee_id is null or scoped_member.employee_id=p_employee_id)
          and public.online_training_employee_in_scope(scoped_member.employee_id)
      )
      and (
        v_query=''
        or lower(concat_ws(' ',r.title,r.platform,r.shift_name,r.team_name,
          r.group_name,r.leader_name,r.trainer_name,r.course_type,
          r.report_summary,r.issues_summary,r.next_plan)) like '%'||v_query||'%'
        or exists(
          select 1 from public.online_training_report_members m
          where m.report_id=r.id
            and (p_employee_id is null or m.employee_id=p_employee_id)
            and public.online_training_employee_in_scope(m.employee_id)
            and lower(concat_ws(' ',m.employee_no,m.employee_name,m.position_name,
              m.team_name,m.group_name,m.shift_name,m.platform,
              m.work_details,m.performance,m.issues,m.follow_up)) like '%'||v_query||'%'
        )
      )
    order by r.report_date desc,r.created_at desc
    offset (v_page-1)*v_page_size
    limit v_page_size
  )
  select coalesce(jsonb_agg(
    (case
      when p_employee_id is null and v_full_scope then to_jsonb(v)
      else to_jsonb(v)-'attachments'-'report_summary'-'issues_summary'-'next_plan'-'review_note'
    end)
    || jsonb_build_object(
      'can_edit',case
        when p_employee_id is null
          and (v_full_scope or not exists(
            select 1 from public.online_training_report_members outside_member
            where outside_member.report_id=v.id
              and not public.online_training_employee_in_scope(outside_member.employee_id)
          ))
        then public.online_training_can_edit_report(v.id)
        else false
      end,
      'can_review',case
        when p_employee_id is null
          and (v_full_scope or not exists(
            select 1 from public.online_training_report_members outside_member
            where outside_member.report_id=v.id
              and not public.online_training_employee_in_scope(outside_member.employee_id)
          ))
        then public.online_training_can_review_report(v.id)
        else false
      end,
      'members',coalesce((
        select jsonb_agg(to_jsonb(m) order by m.sort_order,m.employee_name)
        from public.online_training_report_members m
        where m.report_id=v.id
          and (p_employee_id is null or m.employee_id=p_employee_id)
          and public.online_training_employee_in_scope(m.employee_id)
      ),'[]'::jsonb)
    ) order by v.report_date desc,v.created_at desc
  ),'[]'::jsonb)
  into v_rows
  from visible v;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_page_size,
    'pages',greatest(1,ceil(v_total::numeric/v_page_size)::integer)
  );
end;
$$;

-- Connectivity APIs: public wrappers own the permission/scope boundary.
create or replace function public.admin_connectivity_home(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('connectivity.view') then raise exception 'permission_denied'; end if;
  return employee_ops_private.admin_connectivity_home(p_filters);
end;
$$;

create or replace function public.admin_connectivity_employee_lookup(p_employee_no text)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('connectivity.create') then raise exception 'permission_denied'; end if;
  return employee_ops_private.admin_connectivity_employee_lookup(p_employee_no);
end;
$$;

create or replace function public.admin_connectivity_create(p_record jsonb)
returns jsonb language plpgsql security definer set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('connectivity.create') then raise exception 'permission_denied'; end if;
  return employee_ops_private.admin_connectivity_create(p_record);
end;
$$;

create or replace function public.admin_employee_profile_summary(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_profile_summary(p_employee_id);
end;
$$;

create or replace function public.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not public.has_permission('employee.view') or not public.has_permission('connectivity.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_connectivity_history(p_employee_id);
end;
$$;

create or replace function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not public.has_permission('payroll.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return payroll_private.admin_employee_payroll_history(p_employee_id);
end;
$$;

create or replace function public.admin_employee_attendance_history(
  p_employee_id uuid,p_page integer default 1,p_page_size integer default 30
)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not (public.has_permission('attendance.view') or public.has_permission('employee.view')) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_attendance_history(p_employee_id,p_page,p_page_size);
end;
$$;

create or replace function public.admin_employee_adjustment_history(
  p_employee_id uuid,p_page integer default 1,p_page_size integer default 30
)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not (public.has_permission('attendance.view') or public.has_permission('employee.view')) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_adjustment_history(p_employee_id,p_page,p_page_size);
end;
$$;

-- Authenticated callers must only use the guarded public wrappers.
revoke execute on function employee_ops_private.admin_connectivity_home(jsonb) from authenticated;
revoke execute on function employee_ops_private.admin_connectivity_employee_lookup(text) from authenticated;
revoke execute on function employee_ops_private.admin_connectivity_create(jsonb) from authenticated;
revoke execute on function employee_ops_private.admin_employee_connectivity_history(uuid) from authenticated;
revoke execute on function employee_ops_private.admin_employee_profile_summary(uuid) from authenticated;
revoke execute on function payroll_private.admin_employee_payroll_history(uuid) from authenticated;
revoke execute on function attendance_private.admin_employee_attendance_history(uuid,integer,integer) from authenticated;
revoke execute on function attendance_private.admin_employee_adjustment_history(uuid,integer,integer) from authenticated;

revoke all on function public.admin_connectivity_home(jsonb) from public,anon,authenticated;
revoke all on function public.admin_connectivity_employee_lookup(text) from public,anon,authenticated;
revoke all on function public.admin_connectivity_create(jsonb) from public,anon,authenticated;
revoke all on function public.admin_employee_profile_summary(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_connectivity_history(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_payroll_history(uuid) from public,anon,authenticated;
revoke all on function public.admin_employee_attendance_history(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_employee_adjustment_history(uuid,integer,integer) from public,anon,authenticated;

grant execute on function public.admin_connectivity_home(jsonb) to authenticated;
grant execute on function public.admin_connectivity_employee_lookup(text) to authenticated;
grant execute on function public.admin_connectivity_create(jsonb) to authenticated;
grant execute on function public.admin_employee_profile_summary(uuid) to authenticated;
grant execute on function public.admin_employee_connectivity_history(uuid) to authenticated;
grant execute on function public.admin_employee_payroll_history(uuid) to authenticated;
grant execute on function public.admin_employee_attendance_history(uuid,integer,integer) to authenticated;
grant execute on function public.admin_employee_adjustment_history(uuid,integer,integer) to authenticated;

notify pgrst,'reload schema';
