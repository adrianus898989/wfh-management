begin;

-- Never re-enable the monolithic refresh while restoring the interactive
-- reader.  The existing event rows are durable and can be served independently
-- from candidate recomputation.
select cron.unschedule(jobid)
from cron.job
where jobname = 'admin-alert-refresh'
   or command ilike '%alerts_private.refresh_alerts%';

do $stable_alert_contract$
declare
  v_core text;
begin
  select pg_get_functiondef('alerts_private.refresh_core_alerts()'::regprocedure)
  into v_core;

  if position('count(distinct error.record_key) >= 6' in v_core) = 0
     or position('error_frequency_candidates(v_today)' in v_core) > 0 then
    raise exception 'stable_alert_rule_contract_changed';
  end if;

  if position(
    'Emergency read circuit breaker'
    in coalesce(obj_description(
      'public.admin_alert_center(jsonb,integer,integer)'::regprocedure,
      'pg_proc'
    ), '')
  ) = 0 then
    raise exception 'alert_reader_breaker_not_active';
  end if;
end;
$stable_alert_contract$;

-- The user explicitly excluded the experimental 1/3/7-day detector.  Remove
-- its callable implementation with RESTRICT so an unexpected dependency aborts
-- this transaction instead of being silently cascaded.
drop function if exists alerts_private.error_frequency_candidates(date) restrict;

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
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;

  return alerts_private.admin_alert_center_page_fast(
    v_user_id,
    p_filters,
    p_page,
    p_page_size
  );
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

alter function public.admin_alert_center(jsonb, integer, integer)
  set statement_timeout = '4s';
alter function public.admin_alert_center(jsonb, integer, integer)
  set lock_timeout = '500ms';

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Bounded on-demand reader for durable precomputed alert events. Resolves caller permissions and employee scope once; automatic monolithic refresh remains disabled.';
comment on function alerts_private.refresh_alerts() is
  'Manual only during recovery. Do not schedule the monolithic refresh; replace it with bounded per-alert-group jobs.';

notify pgrst, 'reload schema';

commit;
