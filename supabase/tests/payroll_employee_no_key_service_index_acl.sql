-- Run against a disposable database after all migrations.  The probe proves
-- that service_role can evaluate the employee-number and employee-name helpers
-- through stored expression-index OIDs while direct schema access, browser
-- access and the remaining amount helper stay private. The temporary write is
-- rolled back.

begin;

do $acl$
begin
  if has_schema_privilege('service_role', 'internal', 'USAGE')
     or not has_function_privilege(
          'service_role', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or not has_function_privilege(
          'service_role', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_schema_privilege('anon', 'internal', 'USAGE')
     or has_schema_privilege('authenticated', 'internal', 'USAGE')
     or has_function_privilege(
          'anon', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'authenticated', 'internal.payroll_employee_no_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'anon', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'authenticated', 'internal.payroll_name_key(text)', 'EXECUTE'
        )
     or has_function_privilege(
          'service_role', 'internal.payroll_number(text)', 'EXECUTE'
        )
  then
    raise exception 'payroll identity helper ACL is not narrowly scoped';
  end if;
end
$acl$;

create temporary table payroll_employee_no_key_acl_probe (
  employee_no text not null,
  full_name text not null,
  marker text not null
) on commit drop;

create index payroll_employee_no_key_acl_probe_employee_no_idx
  on payroll_employee_no_key_acl_probe (
    internal.payroll_employee_no_key(employee_no)
  );

create index payroll_employee_no_key_acl_probe_name_idx
  on payroll_employee_no_key_acl_probe (
    internal.payroll_name_key(full_name)
  );

grant select, insert, update
  on payroll_employee_no_key_acl_probe
  to service_role;

set local role service_role;

insert into payroll_employee_no_key_acl_probe(employee_no, full_name, marker)
values (' CJ-00 007 ', 'Dohren Joy P. Del Rosario', 'inserted');

update payroll_employee_no_key_acl_probe
set employee_no = ' WD-00 0460 ',
    full_name = 'Katelyn G. Bustamante',
    marker = 'updated'
where marker = 'inserted';

reset role;

do $index_probe$
begin
  if (
    select count(*)
    from payroll_employee_no_key_acl_probe probe
    where internal.payroll_employee_no_key(probe.employee_no) = 'WD000460'
      and internal.payroll_name_key(probe.full_name) = 'katelyngbustamante'
      and probe.marker = 'updated'
  ) <> 1 then
    raise exception 'service-role expression-index maintenance probe failed';
  end if;
end
$index_probe$;

rollback;
