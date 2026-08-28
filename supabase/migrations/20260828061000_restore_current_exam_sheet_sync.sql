-- The current Google question bank was reconciled against production before
-- this stable five-minute fallback was restored: 2,340 source rows produced
-- 2,151 eligible active questions with zero inserts, updates or errors.
-- The separate legacy exam source remains paused while its source project is
-- inactive; this job only maintains the current Google question bank.

select cron.schedule(
  'wfh-exam-sheet-sync-every-minute',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name='exam_sync_project_url'
      ) || '/functions/v1/exam-sheet-sync',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'Authorization','Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name='exam_sync_anon_key'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);

