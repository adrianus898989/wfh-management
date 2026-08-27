begin;

-- Editing an existing adjustment is not an approval action. Preserve every
-- role/user's current effective edit access while giving the page its own
-- selectable permission.
insert into public.permissions(code,name,category,sensitive)
values('adjustment.page.edit','编辑奖惩记录','adjustment',true)
on conflict(code) do update set name=excluded.name,category=excluded.category,sensitive=excluded.sensitive;

with permission_ids as (
  select
    (select id from public.permissions where code='adjustment.page.approve') approve_id,
    (select id from public.permissions where code='adjustment.page.edit') edit_id
)
insert into public.role_permissions(role_id,permission_id)
select role_permission.role_id,permission_ids.edit_id
from public.role_permissions role_permission
cross join permission_ids
where role_permission.permission_id=permission_ids.approve_id
on conflict(role_id,permission_id) do nothing;

with permission_ids as (
  select
    (select id from public.permissions where code='adjustment.page.approve') approve_id,
    (select id from public.permissions where code='adjustment.page.edit') edit_id
)
insert into public.user_permission_overrides(auth_user_id,permission_id,allowed)
select permission_override.auth_user_id,permission_ids.edit_id,permission_override.allowed
from public.user_permission_overrides permission_override
cross join permission_ids
where permission_override.permission_id=permission_ids.approve_id
on conflict(auth_user_id,permission_id) do update set allowed=excluded.allowed;

do $adjustment_edit_permission_bridge$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.admin_adjustment_editor_options_page_v1(text,integer)',
    'public.admin_adjustment_upsert_without_category(jsonb)'
  ] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_definition;
    if strpos(v_definition,'''adjustment.page.approve''')>0 then
      execute replace(v_definition,'''adjustment.page.approve''','''adjustment.page.edit''');
    elsif strpos(v_definition,'''adjustment.page.edit''')=0 then
      raise exception 'adjustment_edit_permission_guard_prerequisite_changed: %',v_signature;
    end if;
  end loop;
end
$adjustment_edit_permission_bridge$;

create or replace function public.admin_adjustment_editor_options(
  p_search text default '',
  p_limit integer default 100
)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not (
    public.has_permission('adjustment.page.create')
    or public.has_permission('adjustment.page.edit')
  ) then raise exception 'permission_denied'; end if;
  return public.admin_adjustment_editor_options_page_v1(p_search,p_limit);
end $$;

create or replace function public.admin_adjustment_upsert(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$ begin
  if (nullif(btrim(p_payload->>'id'),'') is not null and not public.has_permission('adjustment.page.edit'))
     or (nullif(btrim(p_payload->>'id'),'') is null and not public.has_permission('adjustment.page.create')) then
    raise exception 'permission_denied';
  end if;
  return public.admin_adjustment_upsert_page_v1(p_payload);
end $$;

revoke all on function public.admin_adjustment_editor_options(text,integer),public.admin_adjustment_upsert(jsonb)
  from public,anon,authenticated;
grant execute on function public.admin_adjustment_editor_options(text,integer),public.admin_adjustment_upsert(jsonb)
  to authenticated,service_role;

notify pgrst,'reload schema';
commit;
