begin;

-- Account-first lookups use the composite primary key. This reverse index
-- protects employee deletion/cascade and employee-first diagnostics from a
-- full scan of the materialized authorization allow-list.
create index if not exists user_scope_employees_employee_id_idx
  on public.user_scope_employees (employee_id);

commit;
