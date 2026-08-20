-- Employee error grades always follow the employee's cumulative error total.
-- 0 excellent, 1-8 normal, 9-15 attention, 16-30 watch, 31+ high.
create or replace function public.set_employee_error_risk_from_total()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.risk_level := case
    when coalesce(new.total_error_count, 0) >= 31 then 'high'
    when coalesce(new.total_error_count, 0) >= 16 then 'watch'
    when coalesce(new.total_error_count, 0) >= 9 then 'attention'
    when coalesce(new.total_error_count, 0) >= 1 then 'normal'
    else 'excellent'
  end;
  return new;
end;
$$;

drop trigger if exists trg_employee_error_risk_from_total
  on public.employee_error_summary;

create trigger trg_employee_error_risk_from_total
before insert or update of total_error_count, risk_level
on public.employee_error_summary
for each row
execute function public.set_employee_error_risk_from_total();

update public.employee_error_summary
set risk_level = case
  when coalesce(total_error_count, 0) >= 31 then 'high'
  when coalesce(total_error_count, 0) >= 16 then 'watch'
  when coalesce(total_error_count, 0) >= 9 then 'attention'
  when coalesce(total_error_count, 0) >= 1 then 'normal'
  else 'excellent'
end
where risk_level is distinct from case
  when coalesce(total_error_count, 0) >= 31 then 'high'
  when coalesce(total_error_count, 0) >= 16 then 'watch'
  when coalesce(total_error_count, 0) >= 9 then 'attention'
  when coalesce(total_error_count, 0) >= 1 then 'normal'
  else 'excellent'
end;
