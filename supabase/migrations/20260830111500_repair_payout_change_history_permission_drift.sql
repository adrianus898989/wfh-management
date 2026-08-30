begin;

set local lock_timeout = '2s';
set local statement_timeout = '10s';

-- A later payout workflow migration restored the legacy payout-change guard
-- after the page was split to payroll.change_history.* permissions. Repair the
-- deployed reader without changing its query, scope or result shape.
do $repair$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.admin_payout_change_requests(text,text,integer,integer)'::regprocedure
  ) into v_definition;

  if strpos(v_definition, '''payroll.payout_change.view''') > 0
     or strpos(v_definition, '''payroll.payout_change.review''') > 0 then
    execute replace(
      replace(
        v_definition,
        '''payroll.payout_change.view''',
        '''payroll.change_history.view'''
      ),
      '''payroll.payout_change.review''',
      '''payroll.change_history.review'''
    );
  elsif strpos(v_definition, '''payroll.change_history.view''') = 0
     or strpos(v_definition, '''payroll.change_history.review''') = 0 then
    raise exception 'payout_change_history_permission_guard_prerequisite_changed';
  end if;
end;
$repair$;

notify pgrst, 'reload schema';

commit;
