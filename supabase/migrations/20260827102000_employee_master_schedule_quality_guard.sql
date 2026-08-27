begin;

-- Google formula-backed schedule ranges can transiently return partial rows or
-- literal loading placeholders.  The previous 80% count guard accepted a
-- 936-row transient read after a 1,094-row good snapshot, which then replaced
-- both the report snapshot and the schedule directory.  Keep the full existing
-- ingest transaction private and reject an obviously incomplete source before
-- it can mutate any employee, snapshot, cache, or sync-run state.
alter function public.ingest_employee_master_snapshot(jsonb)
  rename to ingest_employee_master_snapshot_validated_v1;

revoke all on function public.ingest_employee_master_snapshot_validated_v1(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.ingest_employee_master_snapshot(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule_rows jsonb;
  v_schedule_count integer := 0;
  v_recent_good_peak integer := 0;
  v_loading_rows integer := 0;
  v_missing_id_rows integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;

  v_schedule_rows := p_payload->'schedule_rows';
  if jsonb_typeof(v_schedule_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'invalid_schedule_rows';
  end if;
  v_schedule_count := jsonb_array_length(v_schedule_rows);

  select
    count(*) filter (where lower(btrim(coalesce(item->>'name', ''))) ~
      '(正在加载|loading|^#(ref!|n/a|value!|error!))'),
    count(*) filter (where nullif(public.employee_master_normalize_id(item->>'employee_id'), '') is null)
  into v_loading_rows, v_missing_id_rows
  from jsonb_array_elements(v_schedule_rows) item;

  select coalesce(max(run.schedule_roster_row_count), 0)
  into v_recent_good_peak
  from public.employee_master_sync_runs run
  where run.status in ('success', 'unchanged')
    and run.captured_at >= clock_timestamp() - interval '7 days';

  if v_loading_rows > 0 then
    raise exception using
      errcode = '22023',
      message = format('schedule_snapshot_loading_placeholders:%s', v_loading_rows);
  end if;

  if v_missing_id_rows > greatest(5, floor(v_schedule_count * 0.01)::integer) then
    raise exception using
      errcode = '22023',
      message = format(
        'schedule_snapshot_missing_ids:%s_of_%s',
        v_missing_id_rows,
        v_schedule_count
      );
  end if;

  if v_recent_good_peak > 0
    and v_schedule_count * 100 < v_recent_good_peak * 95 then
    raise exception using
      errcode = '22023',
      message = format(
        'schedule_snapshot_below_recent_peak:%s_of_%s',
        v_schedule_count,
        v_recent_good_peak
      );
  end if;

  return public.ingest_employee_master_snapshot_validated_v1(p_payload);
end;
$$;

revoke all on function public.ingest_employee_master_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_employee_master_snapshot(jsonb)
  to service_role;

comment on function public.ingest_employee_master_snapshot(jsonb) is
  'Rejects transient/partial Google schedule reads before invoking the atomic dual-source employee ingest.';

notify pgrst, 'reload schema';

commit;
