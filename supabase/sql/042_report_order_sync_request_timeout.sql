-- Full workbook synchronization normally takes longer than pg_net's default
-- five-second request timeout. Keep the five-minute cadence and allow enough
-- time for an incremental or first full synchronization to finish.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'wfh-report-sheet-sync-every-minute'
  limit 1;

  if v_job_id is not null then
    perform cron.alter_job(
      job_id := v_job_id,
      schedule := '*/5 * * * *',
      command := $command$
        select net.http_post(
          url := 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/report-sheet-sync',
          headers := '{"Content-Type":"application/json"}'::jsonb,
          body := '{}'::jsonb,
          timeout_milliseconds := 120000
        );
      $command$
    );
  end if;
end;
$$;
