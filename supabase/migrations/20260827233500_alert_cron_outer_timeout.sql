begin;

-- A function SET clause restores settings around the function but does not
-- reliably arm a new timer for the already-running outer SELECT. Set the
-- limits in separate statements on the cron connection before each call.
select cron.unschedule(jobid)
from cron.job
where jobname in (
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

do $verify_outer_timeout$
begin
  if exists(
    select 1
    from cron.job
    where jobname like 'admin-alert-refresh-%'
      and (
        command not like 'set statement_timeout=''6s'';%'
        or command not like '%set lock_timeout=''500ms'';%'
      )
  ) or (
    select count(*) from cron.job
    where jobname like 'admin-alert-refresh-%' and active
  )<>4 then
    raise exception 'alert_cron_outer_timeout_incomplete';
  end if;
end;
$verify_outer_timeout$;

commit;
