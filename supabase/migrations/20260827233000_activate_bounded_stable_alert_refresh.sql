begin;

-- All four production canaries completed under the six-second breaker. Keep
-- the groups staggered so only one alert connection can be active at a time.
do $verify_bounded_alert_refresh$
declare
  v_definition text := pg_catalog.pg_get_functiondef(
    'alerts_private.refresh_alert_group(text)'::regprocedure
  );
  v_config text[];
begin
  select procedure.proconfig
  into v_config
  from pg_catalog.pg_proc procedure
  where procedure.oid='alerts_private.refresh_alert_group(text)'::regprocedure;

  if position('error_frequency_candidates' in v_definition)>0
     or position('having count(distinct error.record_key) >= 6' in v_definition)=0
     or not ('statement_timeout=6s'=any(v_config))
     or not ('lock_timeout=500ms'=any(v_config)) then
    raise exception 'bounded_alert_refresh_precondition_failed';
  end if;
end;
$verify_bounded_alert_refresh$;

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'admin-alert-refresh',
  'admin-alert-refresh-error',
  'admin-alert-refresh-adjustment',
  'admin-alert-refresh-attendance',
  'admin-alert-refresh-access-exam'
);

select cron.schedule(
  'admin-alert-refresh-error',
  '1,11,21,31,41,51 * * * *',
  $$set statement_timeout='6s'; set lock_timeout='500ms'; select alerts_private.refresh_alert_group('error');$$
);

select cron.schedule(
  'admin-alert-refresh-adjustment',
  '3,13,23,33,43,53 * * * *',
  $$set statement_timeout='6s'; set lock_timeout='500ms'; select alerts_private.refresh_alert_group('adjustment');$$
);

select cron.schedule(
  'admin-alert-refresh-attendance',
  '5,15,25,35,45,55 * * * *',
  $$set statement_timeout='6s'; set lock_timeout='500ms'; select alerts_private.refresh_alert_group('attendance');$$
);

select cron.schedule(
  'admin-alert-refresh-access-exam',
  '8,18,28,38,48,58 * * * *',
  $$set statement_timeout='6s'; set lock_timeout='500ms'; select alerts_private.refresh_alert_group('access_exam');$$
);

comment on function alerts_private.refresh_alert_group(text) is
  'Active bounded stable-alert refresh. Four disjoint groups run every ten minutes, staggered and protected by a global non-blocking lock plus 6s/500ms statement/lock timeouts. Experimental 1/3/7-day detector is not used.';

commit;
