-- Salary data is especially sensitive: every public entry point must reject a
-- JWT whose browser lease has been replaced by a newer login.

revoke all on function payroll_private.admin_payroll_import(jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_home(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.admin_payroll_publish(bigint)
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_home()
  from public, anon, authenticated;
revoke all on function payroll_private.staff_payroll_detail(bigint)
  from public, anon, authenticated;

create or replace function public.admin_payroll_import(p_batch jsonb, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.admin_payroll_import(p_batch,p_rows);
end;
$$;

create or replace function public.admin_payroll_home(p_batch_id bigint default null)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.admin_payroll_home(p_batch_id);
end;
$$;

create or replace function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.admin_payroll_publish(p_batch_id);
end;
$$;

create or replace function public.staff_payroll_home()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.staff_payroll_home();
end;
$$;

create or replace function public.staff_payroll_detail(p_payslip_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.staff_payroll_detail(p_payslip_id);
end;
$$;

revoke all on function public.admin_payroll_import(jsonb,jsonb)
  from public, anon, authenticated;
revoke all on function public.admin_payroll_home(bigint)
  from public, anon, authenticated;
revoke all on function public.admin_payroll_publish(bigint)
  from public, anon, authenticated;
revoke all on function public.staff_payroll_home()
  from public, anon, authenticated;
revoke all on function public.staff_payroll_detail(bigint)
  from public, anon, authenticated;

grant execute on function public.admin_payroll_import(jsonb,jsonb) to authenticated;
grant execute on function public.admin_payroll_home(bigint) to authenticated;
grant execute on function public.admin_payroll_publish(bigint) to authenticated;
grant execute on function public.staff_payroll_home() to authenticated;
grant execute on function public.staff_payroll_detail(bigint) to authenticated;

notify pgrst,'reload schema';
