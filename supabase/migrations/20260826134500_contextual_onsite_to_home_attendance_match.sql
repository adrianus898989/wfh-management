-- Resolve name-only rows from the onsite-to-home workbooks without weakening
-- the global duplicate-name safeguard.  A contextual match is accepted only
-- when exactly one active onsite-to-home employee has that normalized name.

alter table public.employee_attendance_records
  drop constraint if exists employee_attendance_match_method_check;

alter table public.employee_attendance_records
  add constraint employee_attendance_match_method_check
  check (
    match_method is null
    or match_method in (
      'employee_id_exact',
      'name_unique_exact',
      'name_source_unique_exact'
    )
  );

create or replace function attendance_private.apply_contextual_employee_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_group text;
  v_candidate_count integer := 0;
  v_employee_id uuid;
begin
  -- Exact employee-number and already-established matches always win.
  if new.employee_id is not null
    or nullif(public.exam_norm(new.employee_name_raw), '') is null then
    return new;
  end if;

  select s.source_group
  into v_source_group
  from public.attendance_sheet_sources s
  where s.id = new.source_id;

  if v_source_group is distinct from 'onsite_to_home' then
    return new;
  end if;

  select
    count(distinct e.id),
    case
      when count(distinct e.id) = 1 then min(e.id::text)::uuid
    end
  into v_candidate_count, v_employee_id
  from public.employees e
  where lower(btrim(coalesce(e.status, ''))) = 'active'
    and public.exam_norm(e.full_name) = public.exam_norm(new.employee_name_raw)
    and (
      position('现场转居家' in coalesce(e.employment_type, '')) > 0
      or position('现场转居家' in coalesce(e.source_sheet, '')) > 0
    );

  if v_candidate_count = 1 then
    new.employee_id := v_employee_id;
    new.match_status := 'matched';
    new.match_method := 'name_source_unique_exact';
    new.matched_at := clock_timestamp();
    new.updated_at := clock_timestamp();
  end if;

  return new;
end;
$$;

revoke all on function attendance_private.apply_contextual_employee_match()
  from public, anon, authenticated;
grant execute on function attendance_private.apply_contextual_employee_match()
  to service_role;

drop trigger if exists zz_employee_attendance_contextual_match
  on public.employee_attendance_records;

create trigger zz_employee_attendance_contextual_match
before insert or update of
  source_id,
  employee_no_raw,
  employee_name_raw,
  employee_id,
  match_status,
  match_method
on public.employee_attendance_records
for each row
execute function attendance_private.apply_contextual_employee_match();

-- Repair existing contextual rows now. Future sheet synchronizations are kept
-- matched by the trigger even when the generic importer initially proposes an
-- ambiguous global name match.
with contextual_matches as materialized (
  select
    r.id record_id,
    min(e.id::text)::uuid employee_id
  from public.employee_attendance_records r
  join public.attendance_sheet_sources s on s.id = r.source_id
  join public.employees e
    on public.exam_norm(e.full_name) = public.exam_norm(r.employee_name_raw)
    and lower(btrim(coalesce(e.status, ''))) = 'active'
    and (
      position('现场转居家' in coalesce(e.employment_type, '')) > 0
      or position('现场转居家' in coalesce(e.source_sheet, '')) > 0
    )
  where s.source_group = 'onsite_to_home'
    and r.employee_id is null
    and nullif(public.exam_norm(r.employee_name_raw), '') is not null
  group by r.id
  having count(distinct e.id) = 1
)
update public.employee_attendance_records r
set
  employee_id = c.employee_id,
  match_status = 'matched',
  match_method = 'name_source_unique_exact',
  matched_at = clock_timestamp(),
  updated_at = clock_timestamp()
from contextual_matches c
where c.record_id = r.id;

with source_counts as materialized (
  select
    s0.id,
    count(r.id) filter (
      where not r.is_mirror and r.match_status = 'matched'
    )::integer matched_count,
    count(r.id) filter (
      where not r.is_mirror and r.match_status = 'unmatched'
    )::integer unmatched_count,
    count(r.id) filter (
      where not r.is_mirror and r.match_status = 'ambiguous'
    )::integer ambiguous_count
  from public.attendance_sheet_sources s0
  left join public.employee_attendance_records r on r.source_id = s0.id
  where s0.source_group = 'onsite_to_home'
  group by s0.id
)
update public.attendance_sheet_sources s
set
  matched_count = c.matched_count,
  unmatched_count = c.unmatched_count,
  ambiguous_count = c.ambiguous_count,
  updated_at = clock_timestamp()
from source_counts c
where c.id = s.id
  and (s.matched_count, s.unmatched_count, s.ambiguous_count)
    is distinct from (c.matched_count, c.unmatched_count, c.ambiguous_count);

comment on function attendance_private.apply_contextual_employee_match() is
  'Safely matches name-only onsite-to-home attendance rows to one active onsite-to-home employee.';
