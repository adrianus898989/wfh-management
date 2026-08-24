-- Every staff self-service RPC resolves its employee through this context.
-- Requiring the current application lease here prevents a displaced browser's
-- still-unexpired JWT from reading profile, payment, exam, or portal data.

create or replace function public.exam_staff_context()
returns table(
  auth_user_id uuid,
  employee_id uuid,
  employee_no text,
  employee_name text,
  team_name text,
  position_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    ua.auth_user_id,
    e.id,
    e.employee_no,
    e.full_name,
    t.name,
    p.name
  from public.user_access ua
  join public.employees e on e.id = ua.employee_id
  left join public.teams t on t.id = e.team_id
  left join public.positions p on p.id = e.position_id
  where ua.auth_user_id = (select auth.uid())
    and session_private.current_app_session_is_valid('staff')
    and ua.active
    and ua.employee_portal_enabled
    and e.status in ('active', 'probation')
  limit 1;
$$;

comment on function public.exam_staff_context() is
  'Resolves only the current authenticated employee while their single-device staff application lease is valid.';
