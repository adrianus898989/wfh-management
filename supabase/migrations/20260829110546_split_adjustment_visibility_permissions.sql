begin;

-- Keep the page shell permission, but split the financial rows it may expose.
-- Existing page viewers receive both categories so this migration is neutral
-- until Founder intentionally changes a role or user override.
insert into public.permissions(code,name,category,sensitive)
values
  ('adjustment.bonus.view','查看奖金记录','adjustment',true),
  ('adjustment.deduction.view','查看扣款记录','adjustment',true)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

with permission_ids as (
  select
    (select id from public.permissions where code='adjustment.page.view') page_view_id,
    (select id from public.permissions where code='adjustment.bonus.view') bonus_view_id,
    (select id from public.permissions where code='adjustment.deduction.view') deduction_view_id
)
insert into public.role_permissions(role_id,permission_id)
select source.role_id,target.permission_id
from public.role_permissions source
cross join permission_ids ids
cross join lateral (values(ids.bonus_view_id),(ids.deduction_view_id)) target(permission_id)
where source.permission_id=ids.page_view_id
on conflict(role_id,permission_id) do nothing;

with permission_ids as (
  select
    (select id from public.permissions where code='adjustment.page.view') page_view_id,
    (select id from public.permissions where code='adjustment.bonus.view') bonus_view_id,
    (select id from public.permissions where code='adjustment.deduction.view') deduction_view_id
)
insert into public.user_permission_overrides(auth_user_id,permission_id,allowed)
select source.auth_user_id,target.permission_id,source.allowed
from public.user_permission_overrides source
cross join permission_ids ids
cross join lateral (values(ids.bonus_view_id),(ids.deduction_view_id)) target(permission_id)
where source.permission_id=ids.page_view_id
on conflict(auth_user_id,permission_id) do update set allowed=excluded.allowed;

-- Match the classification already used by both readers' counts: a canonical
-- event kind wins, otherwise a non-canonical non-null kind falls back to sign.
-- A null/zero ambiguous row is visible only when the caller may see both
-- categories, preserving legacy access without leaking it to either subset.
create or replace function attendance_private.adjustment_visibility_kind(
  p_event_kind text,
  p_amount numeric
)
returns text
language sql
immutable
parallel safe
security invoker
set search_path=''
as $$
  select case
    when p_event_kind='bonus' then 'bonus'
    when p_event_kind='deduction' then 'deduction'
    when p_event_kind not in ('bonus','deduction') and p_amount>0 then 'bonus'
    when p_event_kind not in ('bonus','deduction') and p_amount<0 then 'deduction'
    else 'unclassified'
  end
$$;

revoke all on function attendance_private.adjustment_visibility_kind(text,numeric)
from public,anon,authenticated,service_role;

-- Patch the shared private attendance reader rather than wrapping its JSON
-- result. Filtering in the base CTE makes rows, totals, summaries and filter
-- options follow the same server-side boundary and avoids post-aggregation
-- disclosure. Exact blocks make upstream definition drift fail closed.
do $adjustment_home_visibility$
declare
  v_definition text;
  v_old_declaration text := $old_declaration$  v_all boolean := false;
  v_result jsonb;$old_declaration$;
  v_new_declaration text := $new_declaration$  v_all boolean := false;
  v_can_bonus boolean := false;
  v_can_deduction boolean := false;
  v_result jsonb;$new_declaration$;
  v_old_guard text := $old_guard$  if v_scope='adjustment' and not public.has_permission('adjustment.page.view') then
    raise exception 'permission_denied';
  end if;$old_guard$;
  v_new_guard text := $new_guard$  if v_scope='adjustment' then
    v_can_bonus := public.has_permission('adjustment.bonus.view');
    v_can_deduction := public.has_permission('adjustment.deduction.view');
    if not public.has_permission('adjustment.page.view')
       or not (v_can_bonus or v_can_deduction) then
      raise exception 'permission_denied';
    end if;
  end if;$new_guard$;
  v_old_base text := $old_base$where ((v_scope='adjustment' and x.kind='adjustment')
        or (v_scope='attendance' and x.kind in ('attendance','resignation')$old_base$;
  v_new_base text := $new_base$where ((v_scope='adjustment' and x.kind='adjustment'
          and (
            (v_can_bonus and v_can_deduction)
            or attendance_private.adjustment_visibility_kind(x.event_kind,x.amount)=
              case when v_can_bonus then 'bonus' else 'deduction' end
          ))
        or (v_scope='attendance' and x.kind in ('attendance','resignation')$new_base$;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_attendance_home(jsonb)'::regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition,v_old_declaration)=0
     or pg_catalog.strpos(v_definition,v_old_guard)=0
     or pg_catalog.strpos(v_definition,v_old_base)=0 then
    raise exception 'admin_attendance_home_adjustment_visibility_prerequisite_changed';
  end if;

  v_definition:=pg_catalog.replace(v_definition,v_old_declaration,v_new_declaration);
  v_definition:=pg_catalog.replace(v_definition,v_old_guard,v_new_guard);
  v_definition:=pg_catalog.replace(v_definition,v_old_base,v_new_base);
  execute v_definition;

  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_attendance_home(jsonb)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(v_definition,'''adjustment.bonus.view''')=0
     or pg_catalog.strpos(v_definition,'''adjustment.deduction.view''')=0
     or pg_catalog.strpos(v_definition,'attendance_private.adjustment_visibility_kind(x.event_kind,x.amount)')=0 then
    raise exception 'admin_attendance_home_adjustment_visibility_patch_failed';
  end if;
end
$adjustment_home_visibility$;

-- Apply the identical row classification before the employee-history reader
-- computes its totals, currency summaries and pagination.
do $employee_adjustment_visibility$
declare
  v_definition text;
  v_old_declaration text := $old_declaration$  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;$old_declaration$;
  v_new_declaration text := $new_declaration$  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_can_bonus boolean := false;
  v_can_deduction boolean := false;
  v_result jsonb;$new_declaration$;
  v_old_guard text := $old_guard$  if not public.has_permission('adjustment.page.view') then
    raise exception 'permission_denied';
  end if;$old_guard$;
  v_new_guard text := $new_guard$  v_can_bonus := public.has_permission('adjustment.bonus.view');
  v_can_deduction := public.has_permission('adjustment.deduction.view');
  if not public.has_permission('adjustment.page.view')
     or not (v_can_bonus or v_can_deduction) then
    raise exception 'permission_denied';
  end if;$new_guard$;
  v_old_history text := $old_history$    where x.employee_id = p_employee_id
      and x.kind = 'adjustment'
      and not x.is_mirror$old_history$;
  v_new_history text := $new_history$    where x.employee_id = p_employee_id
      and x.kind = 'adjustment'
      and not x.is_mirror
      and (
        (v_can_bonus and v_can_deduction)
        or attendance_private.adjustment_visibility_kind(x.event_kind,x.amount)=
          case when v_can_bonus then 'bonus' else 'deduction' end
      )$new_history$;
  -- Production currently uses the historical-ID enrichment reader.  Fresh
  -- installs still have the simpler attendance_enriched_records alias above.
  -- Support both exact canonical shapes and fail closed on anything else.
  v_old_enriched_history text := $old_enriched_history$    where enriched.employee_id = p_employee_id
      and enriched.kind = 'adjustment'
      and not enriched.is_mirror$old_enriched_history$;
  v_new_enriched_history text := $new_enriched_history$    where enriched.employee_id = p_employee_id
      and enriched.kind = 'adjustment'
      and not enriched.is_mirror
      and (
        (v_can_bonus and v_can_deduction)
        or attendance_private.adjustment_visibility_kind(enriched.event_kind,enriched.amount)=
          case when v_can_bonus then 'bonus' else 'deduction' end
      )$new_enriched_history$;
begin
  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_employee_adjustment_history(uuid,integer,integer)'::regprocedure
  ) into v_definition;

  if pg_catalog.strpos(v_definition,v_old_declaration)=0
     or pg_catalog.strpos(v_definition,v_old_guard)=0
     or (
       pg_catalog.strpos(v_definition,v_old_history)=0
       and pg_catalog.strpos(v_definition,v_old_enriched_history)=0
     ) then
    raise exception 'admin_employee_adjustment_history_visibility_prerequisite_changed';
  end if;

  v_definition:=pg_catalog.replace(v_definition,v_old_declaration,v_new_declaration);
  v_definition:=pg_catalog.replace(v_definition,v_old_guard,v_new_guard);
  if pg_catalog.strpos(v_definition,v_old_history)>0 then
    v_definition:=pg_catalog.replace(v_definition,v_old_history,v_new_history);
  else
    v_definition:=pg_catalog.replace(
      v_definition,v_old_enriched_history,v_new_enriched_history
    );
  end if;
  execute v_definition;

  select pg_catalog.pg_get_functiondef(
    'attendance_private.admin_employee_adjustment_history(uuid,integer,integer)'::regprocedure
  ) into v_definition;
  if pg_catalog.strpos(v_definition,'''adjustment.bonus.view''')=0
     or pg_catalog.strpos(v_definition,'''adjustment.deduction.view''')=0
     or (
       pg_catalog.strpos(v_definition,'attendance_private.adjustment_visibility_kind(x.event_kind,x.amount)')=0
       and pg_catalog.strpos(v_definition,'attendance_private.adjustment_visibility_kind(enriched.event_kind,enriched.amount)')=0
     ) then
    raise exception 'admin_employee_adjustment_history_visibility_patch_failed';
  end if;
end
$employee_adjustment_visibility$;

revoke all on function attendance_private.admin_attendance_home(jsonb)
from public,anon,authenticated,service_role;
revoke all on function attendance_private.admin_employee_adjustment_history(uuid,integer,integer)
from public,anon,authenticated,service_role;

-- Public RPCs keep the common page/directory and employee-scope gates, while
-- requiring at least one category. The private readers enforce the same check
-- and perform the actual row filtering.
create or replace function public.admin_adjustment_page(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not public.has_permission('adjustment.page.view')
     or not (
       public.has_permission('adjustment.bonus.view')
       or public.has_permission('adjustment.deduction.view')
     ) then
    raise exception 'permission_denied';
  end if;
  return public.admin_attendance_page_projection(
    public.admin_attendance_home(
      public.admin_attendance_page_filters(
        coalesce(p_filters,'{}'::jsonb),
        jsonb_build_object('scope','adjustment')
      )
    )
  );
end
$$;

create or replace function public.admin_employee_adjustment_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('adjustment.page.view')
     or not (
       public.has_permission('adjustment.bonus.view')
       or public.has_permission('adjustment.deduction.view')
     ) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  return attendance_private.admin_employee_adjustment_history(
    p_employee_id,p_page,p_page_size
  );
end
$$;

revoke all on function public.admin_adjustment_page(jsonb)
from public,anon,authenticated,service_role;
revoke all on function public.admin_employee_adjustment_history(uuid,integer,integer)
from public,anon,authenticated,service_role;
grant execute on function public.admin_adjustment_page(jsonb)
to authenticated,service_role;
grant execute on function public.admin_employee_adjustment_history(uuid,integer,integer)
to authenticated,service_role;

comment on function attendance_private.adjustment_visibility_kind(text,numeric) is
  'Classifies adjustment rows exactly as the admin readers do for category visibility.';
comment on function public.admin_adjustment_page(jsonb) is
  'Server-filtered adjustment page; requires page view plus bonus and/or deduction visibility.';
comment on function public.admin_employee_adjustment_history(uuid,integer,integer) is
  'Server-filtered employee adjustment history with the same category visibility as the adjustment page.';

notify pgrst,'reload schema';

commit;
