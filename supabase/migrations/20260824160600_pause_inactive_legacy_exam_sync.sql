begin;

-- The legacy source project is currently INACTIVE and every scheduled request
-- fails before any data can be read. Stop the five-minute retry loop so the
-- retained local exam history remains usable without burning Edge invocations.
-- Re-enable this job only after the source project has been resumed or its
-- downloaded backup has been restored to a reachable replacement project.
do $$
declare
  v_job_id bigint;
begin
  select jobid
    into v_job_id
  from cron.job
  where jobname = 'wfh-legacy-exam-sync-every-minute'
  limit 1;

  if v_job_id is not null then
    perform cron.alter_job(job_id := v_job_id, active := false);
  end if;
end;
$$;

do $$
begin
  alter table public.legacy_exam_sync_state
    drop constraint if exists legacy_exam_sync_state_status_check;

  alter table public.legacy_exam_sync_state
    add constraint legacy_exam_sync_state_status_check
    check (status = any (array[
      'pending'::text,
      'running'::text,
      'success'::text,
      'error'::text,
      'source_paused'::text
    ]));

  update public.legacy_exam_sync_state
  set status = 'source_paused',
      last_error = '旧考试源项目已暂停；本库保留现有历史，自动重试已停止。恢复源项目后再启用同步。',
      updated_at = now()
  where source_project_ref = 'vlabmqvbfhdkjsxhajkp'
    and status = 'error';
end;
$$;

commit;
