-- Deleting an imported payroll batch is a privileged destructive action. A
-- stale browser JWT must not remain usable after another device takes over the
-- application session lease.

revoke all on function payroll_private.admin_payroll_delete(bigint)
  from public, anon, authenticated;

create or replace function public.admin_payroll_delete(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  return payroll_private.admin_payroll_delete(p_batch_id);
end;
$$;

revoke all on function public.admin_payroll_delete(bigint)
  from public, anon, authenticated;
grant execute on function public.admin_payroll_delete(bigint)
  to authenticated;

notify pgrst,'reload schema';
