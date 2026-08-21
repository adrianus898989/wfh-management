begin;

-- Build only the current trainer's roster and compact selector values.  The
-- previous implementation first assembled every visible employee into one
-- large JSON document and discarded most of it before returning the page.
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
    where e.status = 'active'
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

revoke all on function public.online_training_context() from public;
grant execute on function public.online_training_context() to authenticated;

commit;
