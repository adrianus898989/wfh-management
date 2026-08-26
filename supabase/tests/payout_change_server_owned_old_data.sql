-- Local regression query. Run only against a disposable database after all
-- migrations. It verifies the false old-payment mismatch path is absent.

begin;

do $$
declare
  v_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.staff_submit_payout_change_request(uuid,jsonb,jsonb,text,text,text)'::regprocedure
  ) into v_definition;

  if position('p_old_data->>' in v_definition)>0 then
    raise exception 'staff submission still trusts employee-entered old payout data';
  end if;
  if position('old_payment_mismatch' in v_definition)>0 then
    raise exception 'obsolete old-payment mismatch error is still reachable';
  end if;
  if position('for update' in lower(v_definition))=0
     or position('v_profile.gcash_account' in v_definition)=0
     or position('v_profile.usdt_address' in v_definition)=0 then
    raise exception 'canonical payout profile is not snapshotted under lock';
  end if;
  if position('insert into public.payout_change_requests' in v_definition)=0
     or position('insert into public.audit_logs' in v_definition)=0 then
    raise exception 'request or audit write shape was removed';
  end if;
end;
$$;

rollback;
