-- report-sheet-sync uses the service role internally and must not be publicly
-- triggerable. Keep the raw cron token in Vault and send it only from pg_cron.
select cron.schedule(
  'wfh-report-sheet-sync-every-minute',
  '*/5 * * * *',
  $cron$
    select net.http_post(
      url := 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/report-sheet-sync',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-report-cron-token',(
          select decrypted_secret
          from vault.decrypted_secrets
          where name='legacy_exam_cron_token'
        )
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    );
  $cron$
);
