begin;

-- Keep the existing five/ten-minute frequencies, but reserve separate
-- minute slots for the exam mirror and attendance alert refresh on a small
-- production database. Reusing each job's existing command also avoids
-- copying credentials or request details here.
do $stagger_jobs$
declare
  exam_command text;
  attendance_command text;
begin
  select command
  into exam_command
  from cron.job
  where jobname = 'wfh-exam-sheet-sync-every-minute';

  select command
  into attendance_command
  from cron.job
  where jobname = 'admin-alert-refresh-attendance';

  if exam_command is null or attendance_command is null then
    raise exception 'background_job_stagger_missing_required_job';
  end if;

  perform cron.schedule(
    'wfh-exam-sheet-sync-every-minute',
    '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
    exam_command
  );

  perform cron.schedule(
    'admin-alert-refresh-attendance',
    '4,14,24,34,44,54 * * * *',
    attendance_command
  );
end;
$stagger_jobs$;

do $verify_stagger$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'wfh-exam-sheet-sync-every-minute'
      and schedule = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'
      and active
  ) or not exists (
    select 1
    from cron.job
    where jobname = 'admin-alert-refresh-attendance'
      and schedule = '4,14,24,34,44,54 * * * *'
      and active
  ) then
    raise exception 'background_job_stagger_verification_failed';
  end if;
end;
$verify_stagger$;

commit;
