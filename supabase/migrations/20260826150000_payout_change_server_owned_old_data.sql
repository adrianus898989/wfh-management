-- The employee-facing form no longer accepts a typed copy of old payout details.
-- Keep p_old_data in the public signature for deployed-client compatibility,
-- but always snapshot the canonical profile under the same row lock used by
-- validation. The request, approval and audit shapes remain unchanged.

create or replace function public.staff_submit_payout_change_request(
  p_request_id uuid,
  p_old_data jsonb,
  p_new_data jsonb,
  p_reason text,
  p_identity_proof_path text,
  p_payment_proof_path text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  c record;
  v_user uuid:=(select auth.uid());
  v_kind text;
  v_profile public.employee_payment_profiles%rowtype;
  v_old jsonb;
  v_new jsonb;
  v_reason text:=btrim(coalesce(p_reason,''));
  v_prefix text;
  v_proof_count integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception 'staff_profile_unavailable'; end if;
  if p_request_id is null then raise exception 'request_id_required'; end if;
  if char_length(v_reason)<5 or char_length(v_reason)>1000 then
    raise exception 'invalid_reason';
  end if;
  if exists(
    select 1 from public.payout_change_requests r
    where r.employee_id=c.employee_id and r.status='pending'
  ) then
    raise exception 'pending_request_exists';
  end if;

  v_kind:=payment_change_private.expected_kind(c.employee_id);
  select * into v_profile
  from public.employee_payment_profiles p
  where p.employee_id=c.employee_id
  for update;
  if not found then raise exception 'current_payment_unavailable'; end if;

  if v_kind='bank_wallet' then
    if nullif(btrim(v_profile.transfer_using),'') is null
       or nullif(btrim(v_profile.gcash_name),'') is null
       or nullif(btrim(v_profile.gcash_account),'') is null then
      raise exception 'current_payment_unavailable';
    end if;
    if nullif(btrim(p_new_data->>'transfer_using'),'') is null
       or nullif(btrim(p_new_data->>'account_name'),'') is null
       or nullif(btrim(p_new_data->>'account_number'),'') is null
       or char_length(btrim(p_new_data->>'transfer_using'))>100
       or char_length(btrim(p_new_data->>'account_name'))>200
       or char_length(btrim(p_new_data->>'account_number'))>300 then
      raise exception 'invalid_new_payment';
    end if;
    v_old:=jsonb_build_object(
      'transfer_using',btrim(v_profile.transfer_using),
      'account_name',btrim(v_profile.gcash_name),
      'account_number',btrim(v_profile.gcash_account)
    );
    v_new:=jsonb_build_object(
      'transfer_using',btrim(p_new_data->>'transfer_using'),
      'account_name',btrim(p_new_data->>'account_name'),
      'account_number',btrim(p_new_data->>'account_number')
    );
  else
    if nullif(btrim(v_profile.usdt_address),'') is null then
      raise exception 'current_payment_unavailable';
    end if;
    if nullif(btrim(p_new_data->>'usdt_address'),'') is null
       or char_length(btrim(p_new_data->>'usdt_address'))>300 then
      raise exception 'invalid_new_payment';
    end if;
    v_old:=jsonb_build_object(
      'usdt_address',btrim(v_profile.usdt_address)
    );
    v_new:=jsonb_build_object(
      'usdt_address',btrim(p_new_data->>'usdt_address')
    );
  end if;

  if v_old=v_new then raise exception 'payment_unchanged'; end if;

  v_prefix:=v_user::text||'/'||p_request_id::text||'/';
  if nullif(btrim(p_identity_proof_path),'') is null
     or nullif(btrim(p_payment_proof_path),'') is null
     or p_identity_proof_path=p_payment_proof_path
     or left(p_identity_proof_path,char_length(v_prefix))<>v_prefix
     or left(p_payment_proof_path,char_length(v_prefix))<>v_prefix then
    raise exception 'proof_required';
  end if;

  select count(*) into v_proof_count
  from storage.objects o
  where o.bucket_id='payment-change-proof'
    and o.owner_id=v_user::text
    and o.name in (p_identity_proof_path,p_payment_proof_path);
  if v_proof_count<>2 then raise exception 'proof_unavailable'; end if;

  insert into public.payout_change_requests(
    id,employee_id,requested_by,old_data,new_data,reason,status,
    payment_kind,identity_proof_path,payment_proof_path,created_at,updated_at
  ) values(
    p_request_id,c.employee_id,v_user,v_old,v_new,v_reason,'pending',
    v_kind,p_identity_proof_path,p_payment_proof_path,
    clock_timestamp(),clock_timestamp()
  );

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,c.employee_id,'payroll','submit_payout_change',p_request_id::text,
    jsonb_build_object('payment_kind',v_kind,'payment',v_old),
    jsonb_build_object('payment_kind',v_kind,'payment',v_new,'status','pending'),
    v_reason
  );

  return jsonb_build_object('ok',true,'id',p_request_id,'status','pending');
exception
  when unique_violation then raise exception 'pending_request_exists';
end;
$$;

revoke all on function public.staff_submit_payout_change_request(
  uuid,jsonb,jsonb,text,text,text
) from public,anon,authenticated;
grant execute on function public.staff_submit_payout_change_request(
  uuid,jsonb,jsonb,text,text,text
) to authenticated;

comment on function public.staff_submit_payout_change_request(
  uuid,jsonb,jsonb,text,text,text
) is
  'Snapshots canonical old payout details, validates new details and private proofs, then creates one guarded change request. p_old_data is retained only for client compatibility.';

notify pgrst,'reload schema';
