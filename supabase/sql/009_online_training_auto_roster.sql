-- Online-training reports should open with the linked trainer's roster already loaded.
-- The authoritative assignment source is 居家排班表/填表 -> online_trainer.

create or replace function public.online_training_identity_key(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(regexp_replace(btrim(coalesce(p_value, '')), '[[:space:][:punct:]]+', '', 'g'));
$$;

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
      and e.status = 'active'
  )
  select exists (
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

create or replace function public.online_training_employee_in_scope(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_caller_employee_id uuid;
  v_scope text;
  v_caller_team_id uuid;
begin
  if p_employee_id is null or not public.online_training_can_view_module() then
    return false;
  end if;

  select ua.employee_id, ua.data_scope, e.team_id
  into v_caller_employee_id, v_scope, v_caller_team_id
  from public.user_access ua
  left join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.backend_enabled = true;

  if public.is_founder()
     or public.has_permission('online_training.manage')
     or v_scope = 'all' then
    return true;
  end if;

  if p_employee_id = v_caller_employee_id
     or public.online_training_is_assigned_member(p_employee_id) then
    return true;
  end if;

  if v_scope = 'assigned' then
    return exists (
      select 1
      from public.employees e
      where e.id = p_employee_id
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
    );
  end if;

  if v_scope = 'own_team' and v_caller_team_id is not null then
    return exists (
      select 1 from public.employees e
      where e.id = p_employee_id and e.team_id = v_caller_team_id
    );
  end if;

  return false;
end;
$$;

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
    where e.status = 'active'
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
          v_scope = 'assigned'
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

revoke all on function public.online_training_identity_key(text) from public;
revoke all on function public.online_training_is_assigned_member(uuid) from public;
revoke all on function public.online_training_bootstrap() from public;

grant execute on function public.online_training_identity_key(text)
  to authenticated, service_role;
grant execute on function public.online_training_is_assigned_member(uuid) to authenticated;
grant execute on function public.online_training_bootstrap() to authenticated;
