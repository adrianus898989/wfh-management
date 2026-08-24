-- RLS expressions evaluate as the authenticated caller.  The lease helper is
-- intentionally kept outside the exposed API schemas, but authenticated RLS
-- policies still need EXECUTE on it in order to evaluate current-session
-- ownership instead of failing with permission_denied.
revoke all on function session_private.current_app_session_is_valid(text)
  from public, anon;
grant execute on function session_private.current_app_session_is_valid(text)
  to authenticated, service_role;

-- SECURITY DEFINER helpers return only caller-scoped booleans/identifiers.
-- Remove PostgreSQL's default PUBLIC execute grant so unauthenticated callers
-- cannot invoke them, while retaining the roles used by PostgREST and Edge
-- Functions.
revoke all on function public.current_employee_id()
  from public, anon;
grant execute on function public.current_employee_id()
  to authenticated, service_role;

revoke all on function public.current_user_role()
  from public, anon;
grant execute on function public.current_user_role()
  to authenticated, service_role;

revoke all on function public.is_founder()
  from public, anon;
grant execute on function public.is_founder()
  to authenticated, service_role;

revoke all on function public.has_permission(text)
  from public, anon;
grant execute on function public.has_permission(text)
  to authenticated, service_role;

revoke all on function public.daily_work_is_active_backend()
  from public, anon;
grant execute on function public.daily_work_is_active_backend()
  to authenticated, service_role;

revoke all on function public.exam_is_admin(text)
  from public, anon;
grant execute on function public.exam_is_admin(text)
  to authenticated, service_role;

revoke all on function public.staff_activity_home()
  from public, anon;
grant execute on function public.staff_activity_home()
  to authenticated, service_role;

notify pgrst, 'reload schema';
