begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

-- Recovery-safe account administration deliberately stays separate from the
-- former all-in-one account bootstrap.  Both readers are JWT/session scoped,
-- have a short statement timeout and return a hard-bounded result set.
do $guard$
begin
  if to_regprocedure('session_private.current_app_session_is_valid(text)') is null then
    raise exception 'current_admin_session_guard_missing';
  end if;
  if to_regprocedure('public.has_permission(text)') is null then
    raise exception 'permission_guard_missing';
  end if;
  if to_regclass('public.user_scope_employees') is null then
    raise exception 'effective_employee_scope_missing';
  end if;
  if to_regclass('public.user_access') is null
     or to_regclass('public.roles') is null
     or to_regclass('public.permissions') is null
     or to_regclass('public.role_permissions') is null
     or to_regclass('public.user_permission_overrides') is null
     or to_regclass('public.employees') is null
     or to_regclass('public.teams') is null
     or to_regclass('public.positions') is null
     or to_regclass('public.audit_logs') is null then
    raise exception 'account_recovery_relation_missing';
  end if;
  if to_regclass('public.backend_role_assignment_rules') is null then
    raise exception 'backend_role_assignment_rules_missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'user_access'
      and column_name = 'account_created_by'
      and udt_name = 'uuid'
      and is_nullable = 'YES'
  ) then
    raise exception 'account_created_by_column_missing';
  end if;
  if to_regclass('public.user_access_login_username_unique') is null then
    raise exception 'backend_username_unique_index_missing';
  end if;
  if to_regprocedure('public.admin_save_account_access_scope(uuid,uuid,uuid,text,uuid[],uuid[],uuid[])') is null then
    raise exception 'atomic_account_scope_writer_missing';
  end if;
end
$guard$;

create index if not exists user_access_backend_created_page_idx
  on public.user_access (created_at desc, auth_user_id desc)
  where backend_enabled = true;

create index if not exists user_access_backend_employee_page_idx
  on public.user_access (employee_id, created_at desc)
  where backend_enabled = true;

create or replace function public.admin_backend_accounts_page(
  p_username_query text default '',
  p_employee_query text default '',
  p_context_query text default '',
  p_page integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '3500ms'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 100000);
  v_page_size constant integer := 20;
  v_username text := lower(btrim(coalesce(p_username_query, '')));
  v_employee text := lower(btrim(coalesce(p_employee_query, '')));
  v_context text := lower(btrim(coalesce(p_context_query, '')));
  v_caller_role_id uuid;
  v_caller_employee_id uuid;
  v_caller_scope text;
  v_caller_role text;
  v_is_founder boolean := false;
  v_actor_permission_ids uuid[] := '{}'::uuid[];
  v_actor_has_wildcard boolean := false;
  v_result jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if length(v_username) > 64 or length(v_employee) > 64 or length(v_context) > 64 then
    raise exception using errcode = '22023', message = 'search_query_too_long';
  end if;

  select access.role_id, access.employee_id, access.data_scope, role.code
  into v_caller_role_id, v_caller_employee_id, v_caller_scope, v_caller_role
  from public.user_access access
  join public.roles role on role.id = access.role_id and role.active = true
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;

  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  v_is_founder := v_caller_role = 'founder';
  if not v_is_founder and not public.has_permission('backend_account.view') then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  if not v_is_founder then
    select coalesce(array_agg(actor_permission.permission_id), '{}'::uuid[])
    into v_actor_permission_ids
    from (
      select role_permission.permission_id
      from public.role_permissions role_permission
      where role_permission.role_id = v_caller_role_id
      union
      select override.permission_id
      from public.user_permission_overrides override
      where override.auth_user_id = v_user_id
        and override.allowed = true
      except
      select override.permission_id
      from public.user_permission_overrides override
      where override.auth_user_id = v_user_id
        and override.allowed = false
    ) actor_permission;

    select exists (
      select 1
      from unnest(v_actor_permission_ids) actor_permission(permission_id)
      join public.permissions permission
        on permission.id = actor_permission.permission_id
      where permission.code = '*'
    ) into v_actor_has_wildcard;
  end if;

  with account_effective_permissions as materialized (
    select access.auth_user_id, access.role_id, role_permission.permission_id
    from public.user_access access
    join public.role_permissions role_permission on role_permission.role_id = access.role_id
    where not v_is_founder
      and access.backend_enabled = true
    union
    select access.auth_user_id, access.role_id, override.permission_id
    from public.user_access access
    join public.user_permission_overrides override
      on override.auth_user_id = access.auth_user_id
     and override.allowed = true
    where not v_is_founder
      and access.backend_enabled = true
    except
    select access.auth_user_id, access.role_id, override.permission_id
    from public.user_access access
    join public.user_permission_overrides override
      on override.auth_user_id = access.auth_user_id
     and override.allowed = false
    where not v_is_founder
      and access.backend_enabled = true
  ), manageable as materialized (
    select
      access.auth_user_id,
      access.employee_id,
      access.role_id,
      access.login_username,
      access.otp_required,
      access.data_scope,
      access.active,
      access.created_at,
      access.account_created_by,
      role.code role_code,
      role.name role_name,
      employee.employee_no,
      employee.full_name
    from public.user_access access
    join public.roles role on role.id = access.role_id and role.active = true
    left join public.employees employee on employee.id = access.employee_id
    where access.backend_enabled = true
      and (v_is_founder or role.code <> 'founder')
      and (v_is_founder or access.employee_id is not null)
      and (
        v_is_founder
        or v_caller_scope = 'all'
        or (v_caller_scope = 'self' and access.employee_id = v_caller_employee_id)
        or (
          v_caller_scope in ('own_team', 'assigned_teams')
          and exists (
            select 1
            from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = access.employee_id
          )
        )
      )
      and (
        v_is_founder
        or v_caller_scope = 'all'
        or (
          exists (
            select 1
            from public.user_scope_employees target_scope
            where target_scope.auth_user_id = access.auth_user_id
          )
          and not exists (
            select 1
            from public.user_scope_employees target_scope
            where target_scope.auth_user_id = access.auth_user_id
              and not exists (
                select 1
                from public.user_scope_employees caller_scope
                where caller_scope.auth_user_id = v_user_id
                  and caller_scope.employee_id = target_scope.employee_id
              )
          )
        )
      )
      and (
        v_is_founder
        or v_actor_has_wildcard
        or (
          not exists (
            select 1
            from account_effective_permissions target_permission
            where target_permission.auth_user_id = access.auth_user_id
              and not (target_permission.permission_id = any(v_actor_permission_ids))
          )
          and exists (
            select 1
            from unnest(v_actor_permission_ids) actor_permission(permission_id)
            where not exists (
              select 1
              from account_effective_permissions target_permission
              where target_permission.auth_user_id = access.auth_user_id
                and target_permission.permission_id = actor_permission.permission_id
            )
          )
        )
        or (
          exists (
            select 1
            from public.backend_role_assignment_rules assignment
            where assignment.grantor_role_id = v_caller_role_id
              and assignment.target_role_id = access.role_id
              and assignment.active = true
          )
          and not exists (
            select 1
            from account_effective_permissions target_permission
            where target_permission.auth_user_id = access.auth_user_id
              and not exists (
                select 1
                from public.role_permissions base_permission
                where base_permission.role_id = access.role_id
                  and base_permission.permission_id = target_permission.permission_id
              )
          )
        )
      )
  ), joined_accounts as materialized (
    select
      manageable.*,
      creator.auth_user_id creator_auth_user_id,
      creator.login_username creator_username,
      creator.backend_enabled creator_backend_enabled,
      creator.employee_id creator_employee_id,
      (
        v_is_founder
        or creator.auth_user_id = v_user_id
        or exists (
          select 1
          from manageable manageable_creator
          where manageable_creator.auth_user_id = creator.auth_user_id
        )
      ) creator_visible
    from manageable
    left join public.user_access creator
      on creator.auth_user_id = manageable.account_created_by
  ), visible as materialized (
    select joined_accounts.*
    from joined_accounts
    where (v_username = '' or lower(coalesce(joined_accounts.login_username, '')) like '%' || v_username || '%')
      and (
        v_employee = ''
        or lower(coalesce(joined_accounts.employee_no, '')) like '%' || v_employee || '%'
        or lower(coalesce(joined_accounts.full_name, '')) like '%' || v_employee || '%'
      )
      and (
        v_context = ''
        or lower(joined_accounts.role_name) like '%' || v_context || '%'
        or lower(joined_accounts.role_code) like '%' || v_context || '%'
        or lower(coalesce(joined_accounts.data_scope, '')) like '%' || v_context || '%'
        or (
          joined_accounts.creator_visible
          and lower(coalesce(joined_accounts.creator_username, '')) like '%' || v_context || '%'
        )
      )
  ), page_rows as (
    select *
    from visible
    order by created_at desc, auth_user_id desc
    offset (v_page - 1) * v_page_size
    limit v_page_size
  )
  select jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from visible),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'auth_user_id', page_row.auth_user_id,
        'employee_id', page_row.employee_id,
        'role_id', page_row.role_id,
        'login_username', page_row.login_username,
        'otp_required', page_row.otp_required,
        'data_scope', page_row.data_scope,
        'active', page_row.active,
        'created_at', page_row.created_at,
        'roles', jsonb_build_object(
          'id', page_row.role_id,
          'code', page_row.role_code,
          'name', page_row.role_name,
          'active', true
        ),
        'employee', case when page_row.employee_id is null then null else jsonb_build_object(
          'id', page_row.employee_id,
          'employee_no', page_row.employee_no,
          'full_name', page_row.full_name
        ) end,
        'account_created_by_label', case
          when page_row.account_created_by is null then '系统 / 历史导入'
          when page_row.creator_auth_user_id is null then
            case when v_is_founder then '已删除账号' else '其他授权管理员' end
          when page_row.creator_visible and coalesce(page_row.creator_backend_enabled, false) then
            coalesce(nullif(btrim(page_row.creator_username), ''), '后台账号')
          else '其他授权管理员'
        end
      ) order by page_row.created_at desc, page_row.auth_user_id desc)
      from page_rows page_row
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_backend_accounts_page(text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_backend_accounts_page(text, text, text, integer)
  to authenticated;

comment on function public.admin_backend_accounts_page(text, text, text, integer) is
  'Recovery-safe backend account reader: fixed 20-row pages, three explicit search fields, session/permission/scope enforcement, and privacy-projected creator labels.';

create or replace function public.admin_backend_account_employee_lookup(
  p_query text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '2500ms'
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_caller_employee_id uuid;
  v_caller_scope text;
  v_caller_role text;
  v_is_founder boolean := false;
  v_rows jsonb;
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception using errcode = '42501', message = 'session_not_current';
  end if;
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if length(v_query) < 2 or length(v_query) > 64 then
    return '[]'::jsonb;
  end if;

  select access.employee_id, access.data_scope, role.code
  into v_caller_employee_id, v_caller_scope, v_caller_role
  from public.user_access access
  join public.roles role on role.id = access.role_id and role.active = true
  where access.auth_user_id = v_user_id
    and access.active = true
    and access.backend_enabled = true
  order by access.updated_at desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'backend_access_denied';
  end if;
  v_is_founder := v_caller_role = 'founder';
  if not v_is_founder and not public.has_permission('account.create') then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', candidate.id,
    'employee_no', candidate.employee_no,
    'full_name', candidate.full_name,
    'teams', case when candidate.team_id is null then null else
      jsonb_build_object('id', candidate.team_id, 'name', candidate.team_name) end,
    'positions', case when candidate.position_id is null then null else
      jsonb_build_object('id', candidate.position_id, 'name', candidate.position_name) end
  ) order by candidate.employee_no, candidate.id), '[]'::jsonb)
  into v_rows
  from (
    select employee.id, employee.employee_no, employee.full_name,
      employee.team_id, team.name team_name,
      employee.position_id, position.name position_name
    from public.employees employee
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    where employee.status = 'active'
      and (
        v_is_founder
        or v_caller_scope = 'all'
        or (v_caller_scope = 'self' and employee.id = v_caller_employee_id)
        or (
          v_caller_scope in ('own_team', 'assigned_teams')
          and exists (
            select 1 from public.user_scope_employees scoped_employee
            where scoped_employee.auth_user_id = v_user_id
              and scoped_employee.employee_id = employee.id
          )
        )
      )
      and (
        lower(coalesce(employee.employee_no, '')) like '%' || v_query || '%'
        or lower(coalesce(employee.full_name, '')) like '%' || v_query || '%'
      )
    order by
      case when lower(coalesce(employee.employee_no, '')) = v_query then 0 else 1 end,
      employee.employee_no,
      employee.id
    limit 10
  ) candidate;

  return v_rows;
end;
$$;

revoke all on function public.admin_backend_account_employee_lookup(text)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_backend_account_employee_lookup(text)
  to authenticated;

comment on function public.admin_backend_account_employee_lookup(text) is
  'Recovery-safe account-link lookup. Requires account.create, returns at most ten in-scope active employees and no private contact fields.';

create or replace function public.admin_recovery_finalize_backend_account(
  p_auth_user_id uuid,
  p_employee_id uuid,
  p_role_id uuid,
  p_login_username text,
  p_login_email text,
  p_otp_required boolean,
  p_data_scope text,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '4500ms'
as $$
declare
  v_actor_role_id uuid;
  v_actor_role_code text;
  v_actor_employee_id uuid;
  v_actor_scope text;
  v_actor_permission_ids uuid[] := '{}'::uuid[];
  v_target_permission_ids uuid[] := '{}'::uuid[];
  v_actor_has_wildcard boolean := false;
  v_role_assignable boolean := false;
  v_employee_in_scope boolean := false;
  v_role_code text;
begin
  if p_auth_user_id is null or p_role_id is null or p_actor_user_id is null then
    raise exception using errcode = '22023', message = 'missing_account_identity';
  end if;
  if btrim(coalesce(p_login_username, '')) !~ '^[a-z0-9._-]{3,32}$' then
    raise exception using errcode = '22023', message = 'invalid_username';
  end if;
  if p_data_scope not in ('all', 'self', 'own_team') then
    raise exception using errcode = '22023', message = 'unsupported_recovery_scope';
  end if;
  if p_data_scope in ('self', 'own_team') and p_employee_id is null then
    raise exception using errcode = '22023', message = 'employee_required';
  end if;
  select actor.role_id, actor_role.code, actor.employee_id, actor.data_scope
  into v_actor_role_id, v_actor_role_code, v_actor_employee_id, v_actor_scope
  from public.user_access actor
  join public.roles actor_role on actor_role.id = actor.role_id and actor_role.active = true
  where actor.auth_user_id = p_actor_user_id
    and actor.active = true
    and actor.backend_enabled = true
  order by actor.updated_at desc
  limit 1;
  if not found then
    raise exception using errcode = '42501', message = 'actor_backend_access_denied';
  end if;

  select role.code into v_role_code
  from public.roles role
  where role.id = p_role_id and role.active = true;
  if not found or v_role_code in ('founder', 'employee') then
    raise exception using errcode = '42501', message = 'target_role_not_allowed';
  end if;

  if v_actor_role_code = 'founder' then
    v_role_assignable := true;
  else
    select coalesce(array_agg(effective.permission_id), '{}'::uuid[])
    into v_actor_permission_ids
    from (
      (
        select role_permission.permission_id
        from public.role_permissions role_permission
        where role_permission.role_id = v_actor_role_id
        union
        select override.permission_id
        from public.user_permission_overrides override
        where override.auth_user_id = p_actor_user_id
          and override.allowed = true
      )
      except
      select override.permission_id
      from public.user_permission_overrides override
      where override.auth_user_id = p_actor_user_id
        and override.allowed = false
    ) effective;

    select coalesce(array_agg(role_permission.permission_id), '{}'::uuid[])
    into v_target_permission_ids
    from public.role_permissions role_permission
    where role_permission.role_id = p_role_id;

    select exists (
      select 1
      from unnest(v_actor_permission_ids) actor_permission(permission_id)
      join public.permissions permission on permission.id = actor_permission.permission_id
      where permission.code = '*'
    ) into v_actor_has_wildcard;

    if not v_actor_has_wildcard and not exists (
      select 1
      from unnest(v_actor_permission_ids) actor_permission(permission_id)
      join public.permissions permission on permission.id = actor_permission.permission_id
      where permission.code = 'account.create'
    ) then
      raise exception using errcode = '42501', message = 'permission_denied';
    end if;

    v_role_assignable := exists (
      select 1
      from public.backend_role_assignment_rules assignment
      where assignment.grantor_role_id = v_actor_role_id
        and assignment.target_role_id = p_role_id
        and assignment.active = true
    ) or v_actor_has_wildcard or (
      v_target_permission_ids <@ v_actor_permission_ids
      and not v_actor_permission_ids <@ v_target_permission_ids
    );
  end if;
  if not v_role_assignable then
    raise exception using errcode = '42501', message = 'role_not_assignable';
  end if;

  if p_employee_id is not null then
    v_employee_in_scope := v_actor_role_code = 'founder'
      or v_actor_scope = 'all'
      or (v_actor_scope = 'self' and p_employee_id = v_actor_employee_id)
      or (
        v_actor_scope in ('own_team', 'assigned_teams')
        and exists (
          select 1 from public.user_scope_employees scoped_employee
          where scoped_employee.auth_user_id = p_actor_user_id
            and scoped_employee.employee_id = p_employee_id
        )
      );
    if not v_employee_in_scope or not exists (
      select 1 from public.employees employee
      where employee.id = p_employee_id and employee.status = 'active'
    ) then
      raise exception using errcode = '42501', message = 'employee_out_of_scope';
    end if;
  end if;
  if v_actor_role_code <> 'founder' and p_employee_id is null then
    raise exception using errcode = '42501', message = 'employee_required';
  end if;
  if p_data_scope = 'all' and v_actor_role_code <> 'founder' then
    raise exception using errcode = '42501', message = 'founder_required_for_all_scope';
  end if;
  if p_data_scope = 'own_team'
     and v_actor_role_code <> 'founder'
     and v_actor_scope <> 'all' then
    raise exception using errcode = '42501', message = 'own_team_not_delegable';
  end if;

  insert into public.user_access (
    auth_user_id, employee_id, role_id, login_username, login_email,
    backend_enabled, employee_portal_enabled, otp_required, data_scope,
    active, must_change_password, account_created_by
  ) values (
    p_auth_user_id, p_employee_id, p_role_id, lower(btrim(p_login_username)),
    nullif(btrim(p_login_email), ''), true, false, coalesce(p_otp_required, false),
    p_data_scope, true, true, p_actor_user_id
  );

  -- This service-only writer has no caller-JWT guard by design.  The recovery
  -- Edge function performs the actor/role/scope checks first; this RPC keeps
  -- access, effective scope and audit insertion in one database transaction.
  perform public.admin_save_account_access_scope(
    p_auth_user_id,
    p_employee_id,
    p_role_id,
    p_data_scope,
    '{}'::uuid[],
    '{}'::uuid[],
    '{}'::uuid[]
  );

  insert into public.audit_logs (
    actor_user_id, employee_id, module, action, record_id, new_data, reason
  ) values (
    p_actor_user_id,
    v_actor_employee_id,
    'access_control',
    'backend_account_create',
    p_auth_user_id::text,
    jsonb_build_object(
      'login_username', lower(btrim(p_login_username)),
      'role_id', p_role_id,
      'role_code', v_role_code,
      'data_scope', p_data_scope,
      'linked_employee_id', p_employee_id
    ),
    format(
      '创建后台账号 username=%s role=%s data_scope=%s linked_employee=%s',
      lower(btrim(p_login_username)),
      v_role_code,
      p_data_scope,
      coalesce(p_employee_id::text, 'none')
    )
  );

  return jsonb_build_object(
    'auth_user_id', p_auth_user_id,
    'username', lower(btrim(p_login_username)),
    'role_code', v_role_code,
    'data_scope', p_data_scope
  );
end;
$$;

revoke all on function public.admin_recovery_finalize_backend_account(
  uuid, uuid, uuid, text, text, boolean, text, uuid
) from public, anon, authenticated;
grant execute on function public.admin_recovery_finalize_backend_account(
  uuid, uuid, uuid, text, text, boolean, text, uuid
) to service_role;

comment on function public.admin_recovery_finalize_backend_account(
  uuid, uuid, uuid, text, text, boolean, text, uuid
) is
  'Service-only recovery finalizer. user_access, effective scope and backend_account_create audit are one transaction; any audit/scope failure rolls back every database row so Edge can delete the just-created Auth user.';

notify pgrst, 'reload schema';

commit;
