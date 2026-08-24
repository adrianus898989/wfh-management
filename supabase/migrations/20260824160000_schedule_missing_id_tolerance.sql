-- Preserve named roster rows that are waiting for an employee ID while still
-- failing closed on duplicate IDs, a complete ID-column outage, and large
-- accidental removals. Name-only rows remain visible in the durable source
-- snapshot but are intentionally excluded from employee-linked caches.

create or replace function public.ingest_schedule_roster_snapshot(
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb := p_payload->'rows';
  v_new_count integer := 0;
  v_new_id_count integer := 0;
  v_new_unique_ids integer := 0;
  v_old_unique_ids integer := 0;
  v_removed_ids integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'invalid_schedule_snapshot');
  end if;

  v_new_count := jsonb_array_length(v_rows);
  select
    count(*) filter (
      where nullif(btrim(item->>'employee_id'), '') is not null
    )::integer,
    count(distinct upper(btrim(item->>'employee_id'))) filter (
      where nullif(btrim(item->>'employee_id'), '') is not null
    )::integer
  into v_new_id_count, v_new_unique_ids
  from jsonb_array_elements(v_rows) item;

  if v_new_count < 1 or v_new_unique_ids < 1 then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_employee_ids_missing',
      'rows', v_new_count, 'unique_employee_ids', v_new_unique_ids);
  end if;

  if v_new_unique_ids <> v_new_id_count then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_employee_ids_duplicated',
      'rows', v_new_count, 'id_rows', v_new_id_count,
      'unique_employee_ids', v_new_unique_ids);
  end if;

  with old_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from public.report_sheet_snapshots s
    cross join lateral jsonb_array_elements(s.payload) item
    where s.source = '居家排班表/填表'
      and nullif(btrim(item->>'employee_id'), '') is not null
  ), new_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from jsonb_array_elements(v_rows) item
    where nullif(btrim(item->>'employee_id'), '') is not null
  )
  select
    (select count(*)::integer from old_ids),
    (select count(*)::integer from old_ids o
      where not exists (select 1 from new_ids n where n.employee_id=o.employee_id))
  into v_old_unique_ids, v_removed_ids;

  -- Every push, including first-install and manual reconciliation, keeps the
  -- same mass-removal guard. This prevents a manual troubleshooting run from
  -- accepting a temporarily broken/formula-empty ID column.
  if v_old_unique_ids >= 100
    and v_removed_ids > greatest(50, floor(v_old_unique_ids * 0.20)::integer) then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_mass_delete_guard',
      'previous_employee_ids', v_old_unique_ids,
      'new_employee_ids', v_new_unique_ids,
      'removed_employee_ids', v_removed_ids);
  end if;

  return public.ingest_schedule_roster_snapshot_internal(p_payload);
end;
$$;

revoke all on function public.ingest_schedule_roster_snapshot(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_schedule_roster_snapshot(jsonb)
  to service_role;

comment on function public.ingest_schedule_roster_snapshot(jsonb) is
  'Service-only schedule ingest preserving named rows without IDs and guarding duplicate/mass-removed IDs.';

notify pgrst, 'reload schema';
