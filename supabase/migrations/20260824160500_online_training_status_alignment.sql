begin;

-- Keep the live online-training roster, submit validation and zero-report
-- statistics on one status definition. Historical report-member snapshots are
-- deliberately retained for suspended and resigned employees.
create or replace function public.online_training_is_assigned_member(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with caller as (
    select
      public.online_training_identity_key(e.employee_no) as employee_no_key,
      public.online_training_identity_key(e.full_name) as employee_name_key,
      public.online_training_identity_key(ua.login_username) as login_key
    from public.user_access ua
    join public.employees e on e.id = ua.employee_id
    where ua.auth_user_id = (select auth.uid())
      and ua.active = true
      and ua.backend_enabled = true
  ), target as (
    select lower(btrim(e.employee_no)) as employee_no
    from public.employees e
    where e.id = p_employee_id
      and e.status in ('active', 'probation')
  )
  select session_private.current_app_session_is_valid('admin') and exists (
    select 1
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) roster(item)
    cross join caller c
    cross join target t
    where s.source = '居家排班表/填表'
      and lower(btrim(roster.item->>'employee_id')) = t.employee_no
      and nullif(public.online_training_identity_key(roster.item->>'online_trainer'), '') is not null
      and public.online_training_identity_key(roster.item->>'online_trainer') in (
        c.employee_no_key, c.employee_name_key, c.login_key
      )
  );
$$;

revoke all on function public.online_training_is_assigned_member(uuid)
  from public, anon;
grant execute on function public.online_training_is_assigned_member(uuid)
  to authenticated;

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
  if p_employee_id=v_caller_employee_id
     or public.online_training_is_assigned_member(p_employee_id) then
    return true;
  end if;

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

revoke all on function public.online_training_employee_in_scope(uuid)
  from public, anon;
grant execute on function public.online_training_employee_in_scope(uuid)
  to authenticated, service_role;

create or replace function public.online_training_bootstrap()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_login_username text;
  v_role_code text;
  v_scope text;
  v_team_id uuid;
  v_can_submit boolean;
  v_can_review boolean;
  v_can_manage boolean;
  v_roster jsonb;
  v_my_roster jsonb;
  v_trainer_options jsonb;
  v_synced_at timestamptz;
  v_my_count integer := 0;
  v_employee_no_key text;
  v_employee_name_key text;
  v_login_key text;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  select ua.employee_id, e.employee_no, e.full_name, ua.login_username,
         r.code, ua.data_scope, e.team_id
  into v_employee_id, v_employee_no, v_employee_name, v_login_username,
       v_role_code, v_scope, v_team_id
  from public.user_access ua
  join public.roles r on r.id = ua.role_id
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true;

  v_can_submit := public.has_permission('online_training.submit')
                  or public.has_permission('online_training.manage');
  v_can_review := public.has_permission('online_training.review');
  v_can_manage := public.has_permission('online_training.manage');
  v_employee_no_key := public.online_training_identity_key(v_employee_no);
  v_employee_name_key := public.online_training_identity_key(v_employee_name);
  v_login_key := public.online_training_identity_key(v_login_username);

  select s.synced_at into v_synced_at
  from public.report_sheet_snapshots s
  where s.source = '居家排班表/填表';

  with source_rows as (
    select roster.item
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) roster(item)
    where s.source = '居家排班表/填表'
  ), scoped as (
    select
      e.id,
      e.employee_no,
      coalesce(nullif(btrim(sr.item->>'name'), ''), e.full_name) as full_name,
      e.status,
      coalesce(nullif(btrim(sr.item->>'country'), ''), e.country, e.nationality, '') as country,
      coalesce(nullif(btrim(sr.item->>'position'), ''), p.name, e.schedule_position, '') as position_name,
      coalesce(nullif(btrim(sr.item->>'team'), ''), t.name, '') as team_name,
      coalesce(nullif(btrim(sr.item->>'group'), ''), e.group_name, '') as group_name,
      coalesce(nullif(btrim(sr.item->>'shift'), ''), e.shift_name, e.legacy_shift_name, '') as shift_name,
      coalesce(nullif(btrim(sr.item->>'platform'), ''), e.platform_scope, '') as platform,
      coalesce(nullif(btrim(sr.item->>'work_content'), ''), e.work_content, '') as work_content,
      coalesce(nullif(btrim(sr.item->>'responsible'), ''), e.person_in_charge, e.leader_name, '') as responsible,
      coalesce(nullif(btrim(sr.item->>'onsite_trainer'), ''), e.on_site_trainer, '') as onsite_trainer,
      coalesce(nullif(btrim(sr.item->>'online_leader'), ''), e.online_leader, '') as online_leader,
      coalesce(nullif(btrim(sr.item->>'online_trainer'), ''), e.online_trainer, e.trainer_name, '') as online_trainer
    from source_rows sr
    join public.employees e
      on lower(btrim(e.employee_no)) = lower(btrim(sr.item->>'employee_id'))
    left join public.teams t on t.id = e.team_id
    left join public.positions p on p.id = e.position_id
    where e.status in ('active', 'probation')
      and (
        public.is_founder()
        or v_can_manage
        or v_scope = 'all'
        or e.id = v_employee_id
        or (
          nullif(public.online_training_identity_key(sr.item->>'online_trainer'), '') is not null
          and public.online_training_identity_key(sr.item->>'online_trainer') in (
            v_employee_no_key, v_employee_name_key, v_login_key
          )
        )
        or (
          v_scope = 'assigned_teams'
          and (
            exists (
              select 1 from public.user_scope_employees se
              where se.auth_user_id = v_user_id and se.employee_id = e.id
            )
            or exists (
              select 1 from public.user_scope_teams st
              where st.auth_user_id = v_user_id and st.team_id = e.team_id
            )
          )
        )
        or (v_scope = 'own_team' and v_team_id is not null and e.team_id = v_team_id)
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'employee_no', employee_no,
    'full_name', full_name,
    'status', status,
    'country', country,
    'position', position_name,
    'team', team_name,
    'group', group_name,
    'shift', shift_name,
    'platform', platform,
    'work_content', work_content,
    'responsible', responsible,
    'onsite_trainer', onsite_trainer,
    'online_leader', online_leader,
    'online_trainer', online_trainer
  ) order by team_name, group_name, position_name, full_name), '[]'::jsonb)
  into v_roster
  from scoped;

  select coalesce(jsonb_agg(item order by item->>'team', item->>'group', item->>'position', item->>'full_name'), '[]'::jsonb)
  into v_my_roster
  from jsonb_array_elements(v_roster) roster(item)
  where v_employee_id is not null
    and nullif(public.online_training_identity_key(item->>'online_trainer'), '') is not null
    and public.online_training_identity_key(item->>'online_trainer') in (
      v_employee_no_key, v_employee_name_key, v_login_key
    );

  v_my_count := jsonb_array_length(v_my_roster);

  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  into v_trainer_options
  from (
    select distinct btrim(item->>'online_trainer') as value
    from jsonb_array_elements(v_roster) roster(item)
    where nullif(btrim(item->>'online_trainer'), '') is not null
  ) trainers;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'user_id', v_user_id,
      'employee_id', v_employee_id,
      'employee_no', coalesce(v_employee_no, ''),
      'employee_name', coalesce(v_employee_name, ''),
      'login_username', coalesce(v_login_username, ''),
      'role_code', coalesce(v_role_code, ''),
      'data_scope', coalesce(v_scope, ''),
      'can_submit', v_can_submit,
      'can_review', v_can_review,
      'can_manage', v_can_manage,
      'is_founder', public.is_founder()
    ),
    'identity_aliases', to_jsonb(array_remove(array[
      nullif(v_employee_no, ''),
      nullif(v_employee_name, ''),
      nullif(v_login_username, '')
    ], null)),
    'roster', v_roster,
    'my_roster', v_my_roster,
    'manager_options', v_trainer_options,
    'auto_assignment', jsonb_build_object(
      'source', '居家排班表/填表',
      'linked', v_employee_id is not null,
      'matched', v_my_count > 0,
      'member_count', v_my_count,
      'trainer_name', coalesce(v_employee_name, ''),
      'employee_no', coalesce(v_employee_no, '')
    ),
    'roster_synced_at', v_synced_at
  );
end;
$$;

revoke all on function public.online_training_bootstrap()
  from public, anon;
grant execute on function public.online_training_bootstrap()
  to authenticated;

create or replace function public.online_training_context()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_employee_name text;
  v_login_username text;
  v_role_code text;
  v_scope text;
  v_team_id uuid;
  v_can_submit boolean;
  v_can_review boolean;
  v_can_manage boolean;
  v_is_founder boolean;
  v_employee_no_key text;
  v_employee_name_key text;
  v_login_key text;
  v_my_roster jsonb := '[]'::jsonb;
  v_manager_options jsonb := '[]'::jsonb;
  v_filter_options jsonb := '{}'::jsonb;
  v_synced_at timestamptz;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;

  select ua.employee_id, e.employee_no, e.full_name, ua.login_username,
         r.code, ua.data_scope, e.team_id
  into v_employee_id, v_employee_no, v_employee_name, v_login_username,
       v_role_code, v_scope, v_team_id
  from public.user_access ua
  join public.roles r on r.id = ua.role_id
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true;

  v_can_submit := public.has_permission('online_training.submit')
                  or public.has_permission('online_training.manage');
  v_can_review := public.has_permission('online_training.review');
  v_can_manage := public.has_permission('online_training.manage');
  v_is_founder := public.is_founder();
  v_employee_no_key := public.online_training_identity_key(v_employee_no);
  v_employee_name_key := public.online_training_identity_key(v_employee_name);
  v_login_key := public.online_training_identity_key(v_login_username);

  select s.synced_at
  into v_synced_at
  from public.report_sheet_snapshots s
  where s.source = '居家排班表/填表'
  order by s.synced_at desc
  limit 1;

  with source_rows as materialized (
    select roster.item
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) roster(item)
    where s.source = '居家排班表/填表'
  ), scoped as materialized (
    select
      e.id,
      e.employee_no,
      coalesce(nullif(btrim(sr.item->>'name'), ''), e.full_name) as full_name,
      e.status,
      coalesce(nullif(btrim(sr.item->>'country'), ''), e.country, e.nationality, '') as country,
      coalesce(nullif(btrim(sr.item->>'position'), ''), p.name, e.schedule_position, '') as position_name,
      coalesce(nullif(btrim(sr.item->>'team'), ''), t.name, '') as team_name,
      coalesce(nullif(btrim(sr.item->>'group'), ''), e.group_name, '') as group_name,
      coalesce(nullif(btrim(sr.item->>'shift'), ''), e.shift_name, e.legacy_shift_name, '') as shift_name,
      coalesce(nullif(btrim(sr.item->>'platform'), ''), e.platform_scope, '') as platform,
      coalesce(nullif(btrim(sr.item->>'work_content'), ''), e.work_content, '') as work_content,
      coalesce(nullif(btrim(sr.item->>'responsible'), ''), e.person_in_charge, e.leader_name, '') as responsible,
      coalesce(nullif(btrim(sr.item->>'onsite_trainer'), ''), e.on_site_trainer, '') as onsite_trainer,
      coalesce(nullif(btrim(sr.item->>'online_leader'), ''), e.online_leader, '') as online_leader,
      coalesce(nullif(btrim(sr.item->>'online_trainer'), ''), e.online_trainer, e.trainer_name, '') as online_trainer
    from source_rows sr
    join public.employees e
      on lower(btrim(e.employee_no)) = lower(btrim(sr.item->>'employee_id'))
    left join public.teams t on t.id = e.team_id
    left join public.positions p on p.id = e.position_id
    where e.status in ('active', 'probation')
      and (
        v_is_founder
        or v_can_manage
        or v_scope = 'all'
        or e.id = v_employee_id
        or (
          nullif(public.online_training_identity_key(sr.item->>'online_trainer'), '') is not null
          and public.online_training_identity_key(sr.item->>'online_trainer') in (
            v_employee_no_key, v_employee_name_key, v_login_key
          )
        )
        or (
          v_scope = 'assigned_teams'
          and (
            exists (
              select 1 from public.user_scope_employees se
              where se.auth_user_id = v_user_id and se.employee_id = e.id
            )
            or exists (
              select 1 from public.user_scope_teams st
              where st.auth_user_id = v_user_id and st.team_id = e.team_id
            )
          )
        )
        or (v_scope = 'own_team' and v_team_id is not null and e.team_id = v_team_id)
      )
  )
  select
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'employee_no', s.employee_no,
        'full_name', s.full_name,
        'status', s.status,
        'country', s.country,
        'position', s.position_name,
        'team', s.team_name,
        'group', s.group_name,
        'shift', s.shift_name,
        'platform', s.platform,
        'work_content', s.work_content,
        'responsible', s.responsible,
        'onsite_trainer', s.onsite_trainer,
        'online_leader', s.online_leader,
        'online_trainer', s.online_trainer
      ) order by s.team_name, s.group_name, s.position_name, s.full_name)
      from scoped s
      where v_employee_id is not null
        and nullif(public.online_training_identity_key(s.online_trainer), '') is not null
        and public.online_training_identity_key(s.online_trainer) in (
          v_employee_no_key, v_employee_name_key, v_login_key
        )
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(x.value order by x.value)
      from (select distinct btrim(s.online_trainer) as value from scoped s
            where nullif(btrim(s.online_trainer), '') is not null) x
    ), '[]'::jsonb),
    jsonb_build_object(
      'trainer', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.online_trainer) value from scoped s where nullif(btrim(s.online_trainer), '') is not null) x), '[]'::jsonb),
      'team', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.team_name) value from scoped s where nullif(btrim(s.team_name), '') is not null) x), '[]'::jsonb),
      'group', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.group_name) value from scoped s where nullif(btrim(s.group_name), '') is not null) x), '[]'::jsonb),
      'position', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.position_name) value from scoped s where nullif(btrim(s.position_name), '') is not null) x), '[]'::jsonb),
      'shift', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.shift_name) value from scoped s where nullif(btrim(s.shift_name), '') is not null) x), '[]'::jsonb),
      'platform', coalesce((select jsonb_agg(x.value order by x.value) from (select distinct btrim(s.platform) value from scoped s where nullif(btrim(s.platform), '') is not null) x), '[]'::jsonb)
    )
  into v_my_roster, v_manager_options, v_filter_options;

  return jsonb_build_object(
    'access', jsonb_build_object(
      'user_id', v_user_id,
      'employee_id', v_employee_id,
      'employee_no', coalesce(v_employee_no, ''),
      'employee_name', coalesce(v_employee_name, ''),
      'login_username', coalesce(v_login_username, ''),
      'role_code', coalesce(v_role_code, ''),
      'data_scope', coalesce(v_scope, ''),
      'can_submit', v_can_submit,
      'can_review', v_can_review,
      'can_manage', v_can_manage,
      'is_founder', v_is_founder
    ),
    'identity_aliases', to_jsonb(array_remove(array[
      nullif(v_employee_no, ''), nullif(v_employee_name, ''), nullif(v_login_username, '')
    ], null)),
    'roster', '[]'::jsonb,
    'my_roster', v_my_roster,
    'manager_options', v_manager_options,
    'filter_options', v_filter_options,
    'auto_assignment', jsonb_build_object(
      'source', '居家排班表/填表',
      'linked', v_employee_id is not null,
      'matched', jsonb_array_length(v_my_roster) > 0,
      'member_count', jsonb_array_length(v_my_roster),
      'trainer_name', coalesce(v_employee_name, ''),
      'employee_no', coalesce(v_employee_no, '')
    ),
    'roster_synced_at', v_synced_at
  );
end;
$$;

revoke all on function public.online_training_context()
  from public, anon;
grant execute on function public.online_training_context()
  to authenticated;

create or replace function public.online_training_save_report(p_report jsonb, p_members jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_report_id uuid;
  v_existing public.online_training_reports;
  v_author_employee_id uuid;
  v_author_name text;
  v_author_employee_no text;
  v_report_date date;
  v_title text;
  v_attachments jsonb;
  v_roster_synced_at timestamptz;
  v_member jsonb;
  v_employee public.employees;
  v_employee_position text;
  v_employee_team text;
  v_existing_members_by_employee jsonb := '{}'::jsonb;
  v_existing_member_row jsonb := '{}'::jsonb;
  v_roster_by_employee jsonb := '{}'::jsonb;
  v_schedule_row jsonb := '{}'::jsonb;
  v_attendance text;
  v_member_count integer := 0;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_is_active_backend()
     or not (
       public.has_permission('online_training.submit')
       or public.has_permission('online_training.manage')
     ) then
    raise exception '当前账号没有线上培训提交权限';
  end if;

  if jsonb_typeof(p_report) is distinct from 'object'
     or jsonb_typeof(p_members) is distinct from 'array' then
    raise exception '报告数据格式不正确';
  end if;

  if jsonb_array_length(p_members) = 0 then
    raise exception '请从居家排班表载入至少一名员工';
  end if;

  v_report_id := coalesce(nullif(p_report->>'id', '')::uuid, gen_random_uuid());
  v_report_date := coalesce(
    nullif(p_report->>'report_date', '')::date,
    (current_timestamp at time zone 'Asia/Manila')::date
  );
  if v_report_date > (current_timestamp at time zone 'Asia/Manila')::date then
    raise exception '日报日期不能晚于马尼拉业务今日';
  end if;
  v_title := btrim(coalesce(nullif(p_report->>'title', ''), '线上培训日报 · ' || v_report_date::text));
  v_attachments := coalesce(p_report->'attachments', '[]'::jsonb);

  if char_length(v_title) < 2 or char_length(v_title) > 160 then
    raise exception '报告标题长度不正确';
  end if;
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 12 then
    raise exception '每份报告最多上传12张截图';
  end if;

  select * into v_existing
  from public.online_training_reports
  where id = v_report_id;

  if found and not public.online_training_can_edit_report(v_report_id) then
    raise exception '无权编辑该报告';
  end if;

  -- An edit changes the report content, not the organizational facts captured
  -- when that report was first submitted. Keep the existing member snapshot
  -- available before replacing the rows below; genuinely new members still
  -- receive the current authoritative schedule snapshot.
  if v_existing.id is not null then
    select coalesce(
      jsonb_object_agg(member.employee_id::text, to_jsonb(member)),
      '{}'::jsonb
    )
    into v_existing_members_by_employee
    from public.online_training_report_members member
    where member.report_id = v_report_id
      and member.employee_id is not null;
  end if;

  select ua.employee_id,
         coalesce(nullif(btrim(e.full_name), ''), nullif(btrim(ua.login_username), ''), '后台用户'),
         coalesce(nullif(btrim(e.employee_no), ''), '')
  into v_author_employee_id, v_author_name, v_author_employee_no
  from public.user_access ua
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id;

  select synced_at into v_roster_synced_at
  from public.report_sheet_snapshots
  where source = '居家排班表/填表';

  select coalesce(
    jsonb_object_agg(snapshot_row.employee_key, snapshot_row.item),
    '{}'::jsonb
  )
  into v_roster_by_employee
  from (
    select distinct on (lower(btrim(roster.item->>'employee_id')))
      lower(btrim(roster.item->>'employee_id')) employee_key,
      roster.item
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where snapshot.source = '居家排班表/填表'
      and nullif(btrim(roster.item->>'employee_id'), '') is not null
    order by
      lower(btrim(roster.item->>'employee_id')),
      case when coalesce(roster.item->>'source_row', '') ~ '^\d+$'
        then (roster.item->>'source_row')::integer end desc nulls last
  ) snapshot_row;

  if v_existing.id is null then
    insert into public.online_training_reports (
      id, report_date, title, platform, shift_name, team_name, group_name,
      leader_name, trainer_name, course_type, report_summary, issues_summary,
      next_plan, roster_synced_at, attachments, status, created_by, updated_by,
      author_employee_id, author_name, author_employee_no
    ) values (
      v_report_id, v_report_date, v_title,
      btrim(coalesce(p_report->>'platform', '')),
      btrim(coalesce(p_report->>'shift_name', '')),
      btrim(coalesce(p_report->>'team_name', '')),
      btrim(coalesce(p_report->>'group_name', '')),
      btrim(coalesce(p_report->>'leader_name', '')),
      btrim(coalesce(p_report->>'trainer_name', '')),
      btrim(coalesce(p_report->>'course_type', '')),
      btrim(coalesce(p_report->>'report_summary', '')),
      btrim(coalesce(p_report->>'issues_summary', '')),
      btrim(coalesce(p_report->>'next_plan', '')),
      v_roster_synced_at, v_attachments, 'published', v_user_id, v_user_id,
      v_author_employee_id, coalesce(v_author_name, '后台用户'), coalesce(v_author_employee_no, '')
    );
  else
    update public.online_training_reports
    set report_date = v_report_date,
        title = v_title,
        platform = btrim(coalesce(p_report->>'platform', '')),
        shift_name = btrim(coalesce(p_report->>'shift_name', '')),
        team_name = btrim(coalesce(p_report->>'team_name', '')),
        group_name = btrim(coalesce(p_report->>'group_name', '')),
        leader_name = btrim(coalesce(p_report->>'leader_name', '')),
        trainer_name = btrim(coalesce(p_report->>'trainer_name', '')),
        course_type = btrim(coalesce(p_report->>'course_type', '')),
        report_summary = btrim(coalesce(p_report->>'report_summary', '')),
        issues_summary = btrim(coalesce(p_report->>'issues_summary', '')),
        next_plan = btrim(coalesce(p_report->>'next_plan', '')),
        roster_synced_at = coalesce(v_roster_synced_at, roster_synced_at),
        attachments = v_attachments,
        status = 'published',
        updated_by = v_user_id,
        updated_at = now(),
        archived_at = null,
        archived_by = null
    where id = v_report_id;

    delete from public.online_training_report_members where report_id = v_report_id;
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    if nullif(v_member->>'employee_id', '') is null then
      raise exception '报告成员缺少员工档案关联';
    end if;

    select * into v_employee
    from public.employees
    where id = (v_member->>'employee_id')::uuid
      and status in ('active', 'probation');

    if not found then raise exception '报告成员不存在或当前不可填报'; end if;
    if not public.online_training_employee_in_scope(v_employee.id)
       and not public.has_permission('online_training.manage') then
      raise exception '报告中包含超出管理范围的员工';
    end if;

    v_attendance := coalesce(nullif(v_member->>'attendance_status', ''), 'normal');
    v_schedule_row := coalesce(
      v_roster_by_employee -> lower(btrim(v_employee.employee_no)),
      '{}'::jsonb
    );
    v_existing_member_row := coalesce(
      v_existing_members_by_employee -> v_employee.id::text,
      '{}'::jsonb
    );
    if v_schedule_row = '{}'::jsonb
       or nullif(btrim(v_schedule_row->>'online_trainer'), '') is null then
      raise exception '% 不在当前线上培训排班或未配置线上培训员',
        v_employee.employee_no;
    end if;
    if v_attendance not in ('normal', 'rest', 'leave', 'absent', 'transferred') then
      raise exception '员工当日状态不正确';
    end if;

    if v_attendance = 'normal'
       and nullif(btrim(concat_ws('', v_member->>'work_details', v_member->>'performance',
         v_member->>'issues', v_member->>'follow_up')), '') is null then
      raise exception '% 的正常上班记录尚未填写', v_employee.employee_no;
    end if;

    if v_attendance in ('leave', 'absent', 'transferred')
       and nullif(btrim(coalesce(v_member->>'status_note', '')), '') is null then
      raise exception '% 的状态需要填写批注', v_employee.employee_no;
    end if;

    select
      coalesce(
        nullif(btrim(v_schedule_row->>'position'), ''),
        p.name,
        v_employee.schedule_position,
        ''
      ),
      coalesce(
        nullif(btrim(v_schedule_row->>'team'), ''),
        t.name,
        ''
      )
    into v_employee_position, v_employee_team
    from public.employees e
    left join public.positions p on p.id = e.position_id
    left join public.teams t on t.id = e.team_id
    where e.id = v_employee.id;

    insert into public.online_training_report_members (
      report_id, employee_id, employee_no, employee_name, position_name,
      team_name, group_name, shift_name, platform, leader_name, trainer_name,
      attendance_status, status_note, work_details, performance, issues,
      follow_up, metrics, sort_order
    ) values (
      v_report_id,
      v_employee.id,
      coalesce(
        nullif(btrim(v_existing_member_row->>'employee_no'), ''),
        v_employee.employee_no
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'employee_name'), ''),
        nullif(btrim(v_schedule_row->>'name'), ''),
        v_employee.full_name
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'position_name'), ''),
        v_employee_position,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'team_name'), ''),
        v_employee_team,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'group_name'), ''),
        nullif(btrim(v_schedule_row->>'group'), ''),
        v_employee.group_name,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'shift_name'), ''),
        nullif(btrim(v_schedule_row->>'shift'), ''),
        v_employee.shift_name,
        v_employee.legacy_shift_name,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'platform'), ''),
        nullif(btrim(v_schedule_row->>'platform'), ''),
        v_employee.platform_scope,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'leader_name'), ''),
        nullif(btrim(v_schedule_row->>'responsible'), ''),
        nullif(btrim(v_schedule_row->>'online_leader'), ''),
        v_employee.person_in_charge,
        v_employee.leader_name,
        ''
      ),
      coalesce(
        nullif(btrim(v_existing_member_row->>'trainer_name'), ''),
        nullif(btrim(v_schedule_row->>'online_trainer'), ''),
        v_employee.online_trainer,
        v_employee.trainer_name,
        ''
      ),
      v_attendance,
      btrim(coalesce(v_member->>'status_note', '')),
      btrim(coalesce(v_member->>'work_details', '')),
      btrim(coalesce(v_member->>'performance', '')),
      btrim(coalesce(v_member->>'issues', '')),
      btrim(coalesce(v_member->>'follow_up', '')),
      case when jsonb_typeof(coalesce(v_member->'metrics', '{}'::jsonb)) = 'object'
           then coalesce(v_member->'metrics', '{}'::jsonb) else '{}'::jsonb end,
      v_member_count
    );
    v_member_count := v_member_count + 1;
  end loop;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    v_user_id, v_author_employee_id, 'online_training',
    case when v_existing.id is null then 'create' else 'update' end,
    v_report_id::text,
    v_report_date::text || ' · ' || v_title || ' · ' || v_member_count::text || '人'
  );

  return v_report_id;
end;
$$;

revoke all on function public.online_training_save_report(jsonb, jsonb)
  from public, anon;
grant execute on function public.online_training_save_report(jsonb, jsonb)
  to authenticated;

create or replace function public.online_training_search_people(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword', '')));
  v_team text := lower(btrim(coalesce(p_filters->>'team', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', '')));
  v_position text := lower(btrim(coalesce(p_filters->>'position', '')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift', '')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform', '')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance', '')));
  v_requested_from date := nullif(p_filters->>'from', '')::date;
  v_requested_to date := nullif(p_filters->>'to', '')::date;
  v_business_today date := (current_timestamp at time zone 'Asia/Manila')::date;
  v_effective_from date;
  v_effective_to date;
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_caller_team_id uuid;
  v_employee_no_key text;
  v_employee_name_key text;
  v_login_key text;
  v_is_founder boolean := false;
  v_can_manage boolean := false;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_requested_from is not null and v_requested_to is not null
     and v_requested_from > v_requested_to then
    raise exception '日期起不能晚于日期止';
  end if;

  -- The business day is Manila time.  Future input is clamped to today.  If
  -- only an end date is supplied, use the start of that end date's month;
  -- otherwise the natural defaults are the current month start through today.
  v_effective_to := least(coalesce(v_requested_to, v_business_today), v_business_today);
  v_effective_from := case
    when v_requested_from is not null
      then least(v_requested_from, v_business_today)
    else date_trunc('month', v_effective_to)::date
  end;
  if v_effective_from > v_effective_to then
    raise exception '有效日期起不能晚于有效日期止';
  end if;

  select
    access.employee_id,
    access.data_scope,
    employee.team_id,
    public.online_training_identity_key(employee.employee_no),
    public.online_training_identity_key(employee.full_name),
    public.online_training_identity_key(access.login_username)
  into
    v_caller_employee_id,
    v_scope,
    v_caller_team_id,
    v_employee_no_key,
    v_employee_name_key,
    v_login_key
  from public.user_access access
  left join public.employees employee on employee.id = access.employee_id
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then
    raise exception '当前账号没有有效后台权限';
  end if;
  v_is_founder := public.is_founder();
  v_can_manage := public.has_permission('online_training.manage');

  with source_rows as materialized (
    select roster.item
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(snapshot.payload) = 'array'
        then snapshot.payload else '[]'::jsonb end
    ) roster(item)
    where snapshot.source = '居家排班表/填表'
  ), trainer_assignment_ids as materialized (
    select distinct employee.id employee_id
    from source_rows schedule_row
    join public.employees employee
      on lower(btrim(employee.employee_no)) =
         lower(btrim(schedule_row.item->>'employee_id'))
    where employee.status in ('active', 'probation')
      and nullif(
        public.online_training_identity_key(schedule_row.item->>'online_trainer'),
        ''
      ) is not null
      and public.online_training_identity_key(
        schedule_row.item->>'online_trainer'
      ) in (v_employee_no_key, v_employee_name_key, v_login_key)
  ), allowed_employee_ids as materialized (
    select employee.id employee_id
    from public.employees employee
    left join trainer_assignment_ids assignment
      on assignment.employee_id = employee.id
    where v_is_founder
      or v_can_manage
      or v_scope = 'all'
      or employee.id = v_caller_employee_id
      or assignment.employee_id is not null
      or (
        v_scope = 'assigned_teams'
        and (
          exists (
            select 1
            from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = employee.id
          )
          or exists (
            select 1
            from public.user_scope_teams scoped_team
            where scoped_team.auth_user_id = v_user_id
              and scoped_team.team_id = employee.team_id
          )
        )
      )
      or (
        v_scope = 'own_team'
        and v_caller_team_id is not null
        and employee.team_id = v_caller_team_id
      )
  ), roster_people as materialized (
    select distinct on (employee.id)
      employee.id employee_id,
      employee.employee_no,
      coalesce(nullif(btrim(schedule_row.item->>'name'), ''), employee.full_name) employee_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'position'), ''),
        pos.name,
        employee.schedule_position,
        ''
      ) position_name,
      coalesce(nullif(btrim(schedule_row.item->>'team'), ''), team.name, '') team_name,
      coalesce(nullif(btrim(schedule_row.item->>'group'), ''), employee.group_name, '') group_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'shift'), ''),
        employee.shift_name,
        employee.legacy_shift_name,
        ''
      ) shift_name,
      coalesce(
        nullif(btrim(schedule_row.item->>'platform'), ''),
        employee.platform_scope,
        ''
      ) platform,
      coalesce(
        nullif(btrim(schedule_row.item->>'online_trainer'), ''),
        employee.online_trainer,
        employee.trainer_name,
        ''
      ) trainer_name,
      employee.hire_date,
      employee.resign_date
    from source_rows schedule_row
    join public.employees employee
      on lower(btrim(employee.employee_no)) =
         lower(btrim(schedule_row.item->>'employee_id'))
    join allowed_employee_ids allowed
      on allowed.employee_id = employee.id
    left join public.teams team on team.id = employee.team_id
    left join public.positions pos on pos.id = employee.position_id
    -- Only active and probation employees are currently expected to submit a
    -- training daily report. Suspended/resigned people remain history-only.
    where employee.status in ('active', 'probation')
      and nullif(
        public.online_training_identity_key(schedule_row.item->>'online_trainer'),
        ''
      ) is not null
      and (
        employee.hire_date is null
        or employee.hire_date <= v_effective_to
      )
      and (
        employee.resign_date is null
        or employee.resign_date >= v_effective_from
      )
    order by employee.id,
      case when coalesce(schedule_row.item->>'source_row', '') ~ '^\d+$'
        then (schedule_row.item->>'source_row')::integer end desc nulls last
  ), visible_member_rows as materialized (
    select
      report.id report_id,
      report.report_date,
      report.created_at report_created_at,
      report.title,
      report.author_name,
      report.author_employee_no,
      report.trainer_name report_trainer_name,
      report.platform report_platform,
      report.course_type,
      report.report_summary,
      report.issues_summary,
      report.next_plan,
      member.employee_id,
      member.employee_no,
      member.employee_name,
      member.position_name,
      member.team_name,
      member.group_name,
      member.shift_name,
      member.platform,
      member.trainer_name,
      member.attendance_status,
      member.status_note,
      member.work_details,
      member.performance,
      member.issues,
      member.follow_up,
      member.metrics,
      employee.hire_date,
      employee.resign_date
    from public.online_training_report_members member
    join public.online_training_reports report on report.id = member.report_id
    left join public.employees employee on employee.id = member.employee_id
    left join allowed_employee_ids allowed_member
      on allowed_member.employee_id = member.employee_id
    where report.status = 'published'
      and member.employee_id is not null
      and (
        allowed_member.employee_id is not null
        or report.created_by = v_user_id
        or v_can_manage
        or v_is_founder
      )
      and report.report_date between v_effective_from and v_effective_to
  ), report_people as materialized (
    select distinct on (history.employee_id)
      history.employee_id,
      history.employee_no,
      history.employee_name,
      history.position_name,
      history.team_name,
      history.group_name,
      history.shift_name,
      history.platform,
      coalesce(
        nullif(history.trainer_name, ''),
        nullif(history.report_trainer_name, ''),
        history.author_name,
        ''
      ) trainer_name,
      history.hire_date,
      history.resign_date
    from visible_member_rows history
    order by history.employee_id,
      history.report_date desc,
      history.report_created_at desc
  ), candidate_people as materialized (
    select
      coalesce(roster.employee_id, history.employee_id) employee_id,
      coalesce(nullif(roster.employee_no, ''), history.employee_no, '') employee_no,
      coalesce(nullif(roster.employee_name, ''), history.employee_name, '') employee_name,
      coalesce(nullif(roster.position_name, ''), history.position_name, '') position_name,
      coalesce(nullif(roster.team_name, ''), history.team_name, '') team_name,
      coalesce(nullif(roster.group_name, ''), history.group_name, '') group_name,
      coalesce(nullif(roster.shift_name, ''), history.shift_name, '') shift_name,
      coalesce(nullif(roster.platform, ''), history.platform, '') platform,
      coalesce(nullif(roster.trainer_name, ''), history.trainer_name, '') trainer_name,
      coalesce(roster.hire_date, history.hire_date) hire_date,
      coalesce(roster.resign_date, history.resign_date) resign_date,
      roster.employee_id is not null is_current_roster,
      history.employee_id is not null has_history
    from roster_people roster
    full join report_people history using (employee_id)
  ), person_rollup as materialized (
    select
      candidate.employee_id,
      candidate.employee_no,
      candidate.employee_name,
      candidate.position_name,
      candidate.team_name,
      candidate.group_name,
      candidate.shift_name,
      candidate.platform,
      candidate.trainer_name,
      candidate.is_current_roster,
      candidate.has_history,
      count(distinct history.report_id)::integer report_count,
      count(distinct history.report_date)::integer recorded_days,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'normal')::integer normal_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'rest')::integer rest_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'leave')::integer leave_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'absent')::integer absent_count,
      count(distinct history.report_date)
        filter (where history.attendance_status = 'transferred')::integer home_count,
      count(distinct history.report_date)
        filter (where nullif(btrim(history.issues), '') is not null)::integer issue_count,
      max(history.report_date) last_report_date,
      greatest(
        v_effective_from,
        coalesce(candidate.hire_date, v_effective_from)
      ) period_from,
      least(
        v_effective_to,
        coalesce(candidate.resign_date, v_effective_to)
      ) period_to
    from candidate_people candidate
    left join visible_member_rows history
      on history.employee_id = candidate.employee_id
    where (
      -- Current roster values and every visible historical member snapshot
      -- are independent match sources. A recent reassignment is searchable
      -- immediately, while an older trainer/organization remains searchable.
      (
        candidate.is_current_roster
        and (
          v_employee_no = ''
          or lower(candidate.employee_no) like '%' || v_employee_no || '%'
        )
        and (
          v_employee_name = ''
          or lower(candidate.employee_name) like '%' || v_employee_name || '%'
        )
        and (
          v_trainer = ''
          or lower(candidate.trainer_name) like '%' || v_trainer || '%'
        )
        and (v_team = '' or lower(btrim(candidate.team_name)) = v_team)
        and (v_group = '' or lower(btrim(candidate.group_name)) = v_group)
        and (v_position = '' or lower(btrim(candidate.position_name)) = v_position)
        and (v_shift = '' or lower(btrim(candidate.shift_name)) = v_shift)
        and (v_platform = '' or lower(btrim(candidate.platform)) = v_platform)
        and v_attendance = ''
        and v_keyword = ''
      )
      or (
        candidate.has_history
        and exists (
          select 1
          from visible_member_rows history_filter
          where history_filter.employee_id = candidate.employee_id
            and (
              v_employee_no = ''
              or lower(coalesce(history_filter.employee_no, ''))
                like '%' || v_employee_no || '%'
            )
            and (
              v_employee_name = ''
              or lower(coalesce(history_filter.employee_name, ''))
                like '%' || v_employee_name || '%'
            )
            and (
              v_trainer = ''
              or lower(concat_ws(' ',
                history_filter.author_name,
                history_filter.author_employee_no,
                history_filter.report_trainer_name,
                history_filter.trainer_name
              )) like '%' || v_trainer || '%'
            )
            and (
              v_team = ''
              or lower(btrim(coalesce(history_filter.team_name, ''))) = v_team
            )
            and (
              v_group = ''
              or lower(btrim(coalesce(history_filter.group_name, ''))) = v_group
            )
            and (
              v_position = ''
              or lower(btrim(coalesce(history_filter.position_name, ''))) = v_position
            )
            and (
              v_shift = ''
              or lower(btrim(coalesce(history_filter.shift_name, ''))) = v_shift
            )
            and (
              v_platform = ''
              or lower(btrim(coalesce(history_filter.platform, ''))) = v_platform
            )
            and (
              v_attendance = ''
              or lower(coalesce(history_filter.attendance_status, '')) = v_attendance
            )
            and (
              v_keyword = ''
              or lower(concat_ws(' ',
                history_filter.title,
                history_filter.report_platform,
                history_filter.course_type,
                history_filter.report_summary,
                history_filter.issues_summary,
                history_filter.next_plan,
                history_filter.status_note,
                history_filter.work_details,
                history_filter.performance,
                history_filter.issues,
                history_filter.follow_up,
                history_filter.metrics::text
              )) like '%' || v_keyword || '%'
            )
        )
      )
    )
    group by
      candidate.employee_id,
      candidate.employee_no,
      candidate.employee_name,
      candidate.position_name,
      candidate.team_name,
      candidate.group_name,
      candidate.shift_name,
      candidate.platform,
      candidate.trainer_name,
      candidate.hire_date,
      candidate.resign_date,
      candidate.is_current_roster,
      candidate.has_history
  ), people as materialized (
    select
      person.*,
      greatest((person.period_to - person.period_from) + 1, 0)::integer period_days,
      case
        when person.is_current_roster then greatest(
          ((person.period_to - person.period_from) + 1) - person.recorded_days,
          0
        )::integer
        else 0
      end missing_days,
      to_char(person.period_from, 'YYYY-MM-DD') || ' – ' ||
        to_char(person.period_to, 'YYYY-MM-DD') period_label
    from person_rollup person
  )
  select
    (select count(*)::integer from people),
    coalesce((
      select jsonb_agg(to_jsonb(page_row)
        order by page_row.last_report_date desc nulls last, page_row.employee_name)
      from (
        select *
        from people
        order by last_report_date desc nulls last, employee_name
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) page_row
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer),
    'effective_from', v_effective_from,
    'effective_to', v_effective_to,
    'business_today', v_business_today
  );
end;
$$;

comment on function public.online_training_search_people(jsonb, integer, integer) is
  'Lists active/probation training roster employees, retains historical report people, uses Manila effective dates and accrues missing days only for the current roster.';

revoke all on function public.online_training_search_people(jsonb, integer, integer)
  from public, anon;
grant execute on function public.online_training_search_people(jsonb, integer, integer)
  to authenticated;

-- A displaced browser can retain a valid Supabase JWT for a short period.
-- Every frontend-facing training read/write RPC must therefore verify the
-- current application lease, not merely the JWT and ordinary permissions.
create or replace function public.online_training_search_reports(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_employee_name text := lower(btrim(coalesce(p_filters->>'employee_name', '')));
  v_trainer text := lower(btrim(coalesce(p_filters->>'trainer', '')));
  v_keyword text := lower(btrim(coalesce(p_filters->>'keyword', '')));
  v_team text := lower(btrim(coalesce(p_filters->>'team', '')));
  v_group text := lower(btrim(coalesce(p_filters->>'group', '')));
  v_position text := lower(btrim(coalesce(p_filters->>'position', '')));
  v_shift text := lower(btrim(coalesce(p_filters->>'shift', '')));
  v_platform text := lower(btrim(coalesce(p_filters->>'platform', '')));
  v_attendance text := lower(btrim(coalesce(p_filters->>'attendance', '')));
  v_date_from date := nullif(p_filters->>'from', '')::date;
  v_date_to date := nullif(p_filters->>'to', '')::date;
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_page_size integer := least(greatest(coalesce(p_page_size, 12), 1), 50);
  v_total integer;
  v_rows jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_view_module() then
    raise exception '当前账号没有线上培训查看权限';
  end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    raise exception '日期起不能晚于日期止';
  end if;

  with visible as materialized (
    select r.*
    from public.online_training_reports r
    where r.status = 'published'
      and public.online_training_can_view_report(r.id)
      and (v_date_from is null or r.report_date >= v_date_from)
      and (v_date_to is null or r.report_date <= v_date_to)
      and (
        v_trainer = ''
        or lower(concat_ws(' ', r.author_name, r.author_employee_no, r.trainer_name)) like '%' || v_trainer || '%'
        or exists (
          select 1 from public.online_training_report_members tm
          where tm.report_id = r.id and lower(coalesce(tm.trainer_name, '')) like '%' || v_trainer || '%'
        )
      )
      and (
        (v_employee_no = '' and v_employee_name = '' and v_team = '' and v_group = ''
          and v_position = '' and v_shift = '' and v_platform = '' and v_attendance = '')
        or exists (
          select 1
          from public.online_training_report_members m
          where m.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(m.employee_id)
            )
            and (v_employee_no = '' or lower(coalesce(m.employee_no, '')) like '%' || v_employee_no || '%')
            and (v_employee_name = '' or lower(coalesce(m.employee_name, '')) like '%' || v_employee_name || '%')
            and (v_team = '' or lower(btrim(coalesce(m.team_name, ''))) = v_team)
            and (v_group = '' or lower(btrim(coalesce(m.group_name, ''))) = v_group)
            and (v_position = '' or lower(btrim(coalesce(m.position_name, ''))) = v_position)
            and (v_shift = '' or lower(btrim(coalesce(m.shift_name, ''))) = v_shift)
            and (v_platform = '' or lower(btrim(coalesce(m.platform, ''))) = v_platform)
            and (v_attendance = '' or lower(coalesce(m.attendance_status, '')) = v_attendance)
        )
      )
      and (
        v_keyword = ''
        or lower(concat_ws(' ', r.title, r.platform, r.shift_name, r.team_name, r.group_name,
          r.leader_name, r.trainer_name, r.course_type, r.report_summary, r.issues_summary, r.next_plan))
          like '%' || v_keyword || '%'
        or exists (
          select 1
          from public.online_training_report_members km
          where km.report_id = r.id
            and (
              r.created_by = (select auth.uid())
              or public.has_permission('online_training.manage')
              or public.online_training_employee_in_scope(km.employee_id)
            )
            and lower(concat_ws(' ', km.employee_no, km.employee_name, km.position_name,
              km.team_name, km.group_name, km.shift_name, km.platform, km.status_note,
              km.work_details, km.performance, km.issues, km.follow_up, km.metrics::text))
              like '%' || v_keyword || '%'
        )
      )
  )
  select
    (select count(*)::integer from visible),
    coalesce((
      select jsonb_agg(
        to_jsonb(v)
        || jsonb_build_object(
          'can_edit', public.online_training_can_edit_report(v.id),
          'can_review', public.online_training_can_review_report(v.id),
          'members', coalesce((
            select jsonb_agg(to_jsonb(m) order by m.sort_order, m.employee_name)
            from public.online_training_report_members m
            where m.report_id = v.id
              and (
                v.created_by = (select auth.uid())
                or public.has_permission('online_training.manage')
                or public.online_training_employee_in_scope(m.employee_id)
              )
          ), '[]'::jsonb)
        )
        order by v.report_date desc, v.created_at desc
      )
      from (
        select * from visible
        order by report_date desc, created_at desc
        offset (v_page - 1) * v_page_size
        limit v_page_size
      ) v
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_page_size,
    'pages', greatest(1, ceil(v_total::numeric / v_page_size)::integer)
  );
end;
$$;

revoke all on function public.online_training_search_reports(jsonb, integer, integer)
  from public, anon;
grant execute on function public.online_training_search_reports(jsonb, integer, integer)
  to authenticated;

create or replace function public.online_training_archive_report(p_report_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_employee_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.online_training_can_edit_report(p_report_id) then
    raise exception '无权删除该报告';
  end if;

  select employee_id into v_author_employee_id
  from public.user_access where auth_user_id = (select auth.uid());

  update public.online_training_reports
  set status = 'archived', archived_at = now(), archived_by = (select auth.uid()),
      updated_at = now(), updated_by = (select auth.uid())
  where id = p_report_id;

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    (select auth.uid()), v_author_employee_id, 'online_training', 'archive',
    p_report_id::text, '归档删除线上培训日报'
  );

  return true;
end;
$$;

revoke all on function public.online_training_archive_report(uuid)
  from public, anon;
grant execute on function public.online_training_archive_report(uuid)
  to authenticated;

create or replace function public.online_training_review_report(
  p_report_id uuid,
  p_status text,
  p_note text default ''
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text := btrim(coalesce(p_status, ''));
  v_employee_id uuid;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if v_status not in ('read', 'needs_changes') then
    raise exception '批注状态不正确';
  end if;
  if not public.online_training_can_review_report(p_report_id) then
    raise exception '无权批注该报告';
  end if;

  select employee_id into v_employee_id
  from public.user_access where auth_user_id = (select auth.uid());

  update public.online_training_reports
  set review_status = v_status,
      review_note = btrim(coalesce(p_note, '')),
      reviewed_by = (select auth.uid()),
      reviewed_at = now(),
      updated_at = now()
  where id = p_report_id and status = 'published';

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, reason
  ) values (
    (select auth.uid()), v_employee_id, 'online_training', 'review',
    p_report_id::text, v_status || ' · ' || btrim(coalesce(p_note, ''))
  );

  return true;
end;
$$;

revoke all on function public.online_training_review_report(uuid, text, text)
  from public, anon;
grant execute on function public.online_training_review_report(uuid, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
