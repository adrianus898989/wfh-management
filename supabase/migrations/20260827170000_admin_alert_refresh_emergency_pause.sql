begin;

-- The refresh occasionally exceeds fifty seconds and competes with every
-- interactive backend request. Function-level statement_timeout does not cap
-- the statement that is already invoking that function, so pause the job until
-- it is replaced by a genuinely bounded incremental refresh.
select cron.unschedule(jobid)
from cron.job
where jobname = 'admin-alert-refresh';

comment on function alerts_private.refresh_alerts() is
  'Manual refresh only. Automatic execution is paused after repeated 50+ second runs saturated interactive admin and staff traffic.';

commit;
