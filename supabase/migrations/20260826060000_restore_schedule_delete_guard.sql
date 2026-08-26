begin;

-- Preserve the ID-first/name-fallback identity rule introduced by the prior
-- migration, but apply the mass-delete guard to every trigger kind, including
-- manual/installer runs.
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
  v_new_unique_identities integer := 0;
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
    count(distinct case
      when nullif(btrim(item->>'employee_id'), '') is not null
        then 'id:' || upper(btrim(item->>'employee_id'))
      else 'name:' || lower(regexp_replace(btrim(item->>'name'), '[[:space:]]+', ' ', 'g'))
    end)::integer,
    count(distinct upper(btrim(item->>'employee_id')))
      filter (where nullif(btrim(item->>'employee_id'), '') is not null)::integer
  into v_new_unique_identities, v_new_unique_ids
  from jsonb_array_elements(v_rows) item;

  if v_new_count < 1 or v_new_unique_identities <> v_new_count then
    return jsonb_build_object('ok', false, 'status', 'failed',
      'error_code', 'schedule_identities_incomplete',
      'rows', v_new_count,
      'unique_identities', v_new_unique_identities,
      'unique_employee_ids', v_new_unique_ids);
  end if;

  with old_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from public.report_sheet_snapshots snapshot
    cross join lateral jsonb_array_elements(snapshot.payload) item
    where snapshot.source = '居家排班表/填表'
      and nullif(btrim(item->>'employee_id'), '') is not null
  ), new_ids as (
    select distinct upper(btrim(item->>'employee_id')) employee_id
    from jsonb_array_elements(v_rows) item
    where nullif(btrim(item->>'employee_id'), '') is not null
  )
  select
    (select count(*)::integer from old_ids),
    (select count(*)::integer from old_ids old_row
      where not exists (
        select 1 from new_ids new_row
        where new_row.employee_id = old_row.employee_id
      ))
  into v_old_unique_ids, v_removed_ids;

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
  'Service-only ID-first schedule ingest that always guards mass-removed IDs, including manual runs.';

notify pgrst, 'reload schema';

commit;
