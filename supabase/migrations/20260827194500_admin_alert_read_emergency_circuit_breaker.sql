begin;

-- Emergency recovery circuit breaker.
--
-- The alert reader can be mounted in more than one browser surface.  Its
-- current implementation performs employee-scope, current-roster, reader and
-- aggregate work for every request.  During recovery that query exhausted the
-- interactive database pool and caused unrelated login and write requests to
-- time out.  Keep the same authentication and page-permission boundary, but
-- temporarily return an explicit maintenance payload without touching alert
-- data.  No alert rows are deleted or changed by this migration.
create or replace function public.admin_alert_center(
  p_filters jsonb default '{}'::jsonb,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;

  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  if not public.has_permission('alert.view') then
    raise exception 'permission_denied';
  end if;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', 0,
    'pages', 1,
    'active_total', 0,
    'unread_total', 0,
    'type_counts', '{}'::jsonb,
    'rows', '[]'::jsonb,
    'degraded', true,
    'degraded_reason', 'temporary_recovery'
  );
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Emergency read circuit breaker: preserves authentication and alert.view authorization while interactive database service recovers; alert data is unchanged.';

notify pgrst, 'reload schema';

commit;
