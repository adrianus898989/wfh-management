begin;

-- The reports UI promises a five-minute fallback.  Put that fallback on
-- :00/:05 while the exam and alert jobs occupy :02 and :04 respectively.
do $restore_report_cadence$
declare
  report_job_id bigint;
begin
  select jobid
  into report_job_id
  from cron.job
  where jobname = 'wfh-report-sheet-sync-every-minute';

  if report_job_id is null then
    raise exception 'report_sync_job_missing';
  end if;

  perform cron.alter_job(
    job_id := report_job_id,
    schedule := '0,5,10,15,20,25,30,35,40,45,50,55 * * * *',
    active := true
  );
end;
$restore_report_cadence$;

do $verify_report_cadence$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'wfh-report-sheet-sync-every-minute'
      and schedule = '0,5,10,15,20,25,30,35,40,45,50,55 * * * *'
      and active
  ) then
    raise exception 'report_sync_five_minute_cadence_verification_failed';
  end if;
end;
$verify_report_cadence$;

commit;
