-- The UI and write APIs treat cosmetic employee-ID differences as the same
-- identity. Enforce that rule in Postgres as well so concurrent creates cannot
-- bypass the application-level duplicate check.

do $$
begin
  if exists (
    select 1
    from public.employees employee
    where nullif(
      regexp_replace(upper(btrim(employee.employee_no)), '[^A-Z0-9]', '', 'g'),
      ''
    ) is not null
    group by regexp_replace(
      upper(btrim(employee.employee_no)), '[^A-Z0-9]', '', 'g'
    )
    having count(*) > 1
  ) then
    raise exception 'duplicate_normalized_employee_no';
  end if;
end;
$$;

create unique index if not exists employees_employee_no_normalized_unique_idx
on public.employees (
  (regexp_replace(upper(btrim(employee_no)), '[^A-Z0-9]', '', 'g'))
)
where nullif(
  regexp_replace(upper(btrim(employee_no)), '[^A-Z0-9]', '', 'g'),
  ''
) is not null;

comment on index public.employees_employee_no_normalized_unique_idx is
  'Prevents duplicate employee identities that differ only by case, spaces, or punctuation.';
