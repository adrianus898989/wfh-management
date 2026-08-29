-- Historical connectivity rows predate the ongoing-incident workflow. They
-- could have a recovery time while still carrying the old `reported` or
-- `verified` label. Once recovery is known, the canonical state is resolved;
-- normalize those rows before the UI relabels `reported` as "ongoing".

begin;

set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $connectivity_status_prerequisites$
begin
  if to_regclass('public.employee_connectivity_incidents') is null then
    raise exception 'employee_connectivity_incidents_missing';
  end if;
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'employee_connectivity_incidents'
      and column_name = 'ended_at'
      and is_nullable = 'YES'
  ) then
    raise exception 'ongoing_connectivity_migration_missing';
  end if;
end
$connectivity_status_prerequisites$;

update public.employee_connectivity_incidents
set status = 'resolved'
where ended_at is not null
  and status in ('reported', 'verified');

commit;
