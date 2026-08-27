begin;

-- The warning catalog is based on day-scale windows. A fifteen-minute refresh
-- keeps it timely while preventing an expensive scan from competing with every
-- backend page load five times per hour.
select cron.unschedule(jobid)
from cron.job
where jobname = 'admin-alert-refresh';

select cron.schedule(
  'admin-alert-refresh',
  '*/15 * * * *',
  $schedule$select alerts_private.refresh_alerts();$schedule$
);

-- A refresh is background maintenance, never a reason to hold the interactive
-- backend hostage. Abort a pathological run and let the next cron cycle retry.
alter function alerts_private.refresh_alerts()
  set statement_timeout = '15s';
alter function alerts_private.refresh_alerts()
  set lock_timeout = '2s';

comment on function alerts_private.refresh_alerts() is
  'Refreshes warning incidents every 15 minutes; capped at 15 seconds with a 2-second lock wait so background scans cannot stall interactive backend requests.';

commit;
