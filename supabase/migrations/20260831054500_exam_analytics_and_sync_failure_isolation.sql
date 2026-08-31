begin;

-- Production API traffic wins over maintenance work. The answer table is
-- modest in row count but has wide legacy payloads, so keep lock waits short
-- while allowing enough time for the one-time covering-index build.
set local lock_timeout = '3s';
set local statement_timeout = '90s';

-- The exam overview groups answers by session and grade status. The former
-- index covered only the join key, forcing PostgreSQL to visit the 78 MB
-- legacy heap for every answer just to read grade_status. Keep the old index
-- for compatibility and add a narrow covering index for this hot path.
create index if not exists legacy_exam_answers_overview_stats_idx
  on public.legacy_exam_answers (legacy_session_id)
  include (grade_status);

-- The current table is small today, but give the same query shape a bounded
-- path before it grows to legacy size.
create index if not exists exam_answers_overview_stats_idx
  on public.exam_answers (session_id)
  include (grade_status);

analyze public.legacy_exam_answers;
analyze public.exam_answers;

-- One derived relationship cache must never roll back the authoritative
-- employee-master refresh. The rebuild validates before deleting and raises
-- one of the guarded 22023 errors for an empty, partial, duplicate or loading
-- schedule. Catch only that known family inside a subtransaction, retain the
-- last healthy relationships, and allow the directory/employee sync to finish.
create or replace function public.sync_report_employee_directory(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_directory jsonb;
  v_relationships jsonb;
  v_relationship_error text;
  v_retained_rows integer := 0;
begin
  v_directory :=
    public.sync_report_employee_directory_stable_relationship_inner_v1(p_rows);

  begin
    v_relationships :=
      session_private.rebuild_online_training_roster_relationships(p_rows);
  exception
    when sqlstate '22023' then
      v_relationship_error := sqlerrm;
      if v_relationship_error <> 'invalid_schedule_roster_rows'
         and v_relationship_error not like 'schedule_roster_relationship_%' then
        raise;
      end if;

      select count(*)::integer
      into v_retained_rows
      from session_private.online_training_roster_relationships;

      v_relationships := jsonb_build_object(
        'status', 'retained_previous',
        'reason', v_relationship_error,
        'rows', v_retained_rows
      );
  end;

  return v_directory || jsonb_build_object(
    'online_training_relationships', v_relationships
  );
end;
$$;

revoke all on function public.sync_report_employee_directory(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_report_employee_directory(jsonb)
  to service_role;

comment on function public.sync_report_employee_directory(jsonb) is
  'Refreshes the report directory and fail-closes the derived online-training hierarchy: rejected roster snapshots retain the last healthy relationships without rolling back authoritative employee sync.';

notify pgrst, 'reload schema';
commit;
