-- Change-triggered Google Apps Script pushes are the near-real-time path. The
-- three scheduled imports are resilience fallbacks, so five minutes avoids
-- overlapping full reads and cuts the fixed invocation baseline by 80%.
select cron.schedule(
  'wfh-report-sheet-sync-every-minute',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/report-sheet-sync',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
select cron.schedule(
  'wfh-exam-sheet-sync-every-minute',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name='exam_sync_project_url') || '/functions/v1/exam-sheet-sync',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='exam_sync_anon_key')
      ),
      body := '{}'::jsonb
    );
  $cron$
);

select cron.schedule(
  'wfh-legacy-exam-sync-every-minute',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name='exam_sync_project_url') || '/functions/v1/legacy-exam-sync',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-legacy-cron-token',(select decrypted_secret from vault.decrypted_secrets where name='legacy_exam_cron_token'),
        'x-legacy-source-token',(select decrypted_secret from vault.decrypted_secrets where name='legacy_exam_source_token')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
