-- Restore the stable report mirror only after the Google/Supabase watermarks
-- were reconciled manually on 2026-08-28.  The Edge function keeps the last
-- known-good rows for any unavailable source, so a private or transiently
-- failing sheet cannot clear the production mirror.

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

