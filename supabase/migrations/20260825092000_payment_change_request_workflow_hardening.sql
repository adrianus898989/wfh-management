-- Delta for the already-applied 20260825080056 payout-change workflow.
-- Keep this migration limited to the post-deployment rule/review hardening so
-- production does not replay the table, bucket, policies, or base RPCs.

create or replace function payment_change_private.expected_kind(p_employee_id uuid)
returns text
language sql
stable
set search_path=''
as $$
  select case
    when (
          coalesce(e.employment_type,'') ilike '%纯居家%'
          or lower(coalesce(e.employment_type,'')) like '%pure remote%'
          or lower(coalesce(e.employment_type,'')) like '%fully remote%'
         )
     and coalesce(e.employment_type,'') not ilike '%现场%'
     and lower(coalesce(e.employment_type,'')) not like '%onsite%'
     and lower(concat_ws(' ',e.country,e.nationality))
       ~ '(菲律宾|philippines|philippine|filipino)'
    then 'bank_wallet'
    else 'usdt'
  end
  from public.employees e
  where e.id=p_employee_id;
$$;

revoke all on function payment_change_private.expected_kind(uuid)
  from public,anon,authenticated;

create or replace function public.admin_review_payout_change_request(
  p_request_id uuid,
  p_decision text,
  p_review_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=(select auth.uid());
  v_decision text:=lower(btrim(coalesce(p_decision,'')));
  v_note text:=nullif(btrim(coalesce(p_review_note,'')),'');
  v_request public.payout_change_requests%rowtype;
  v_profile public.employee_payment_profiles%rowtype;
  v_employee public.employees%rowtype;
  v_kind text;
  v_method text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('payroll.payout_change.review') then
    raise exception 'permission_denied';
  end if;
  if v_decision not in ('approved','rejected') then raise exception 'invalid_decision'; end if;
  if char_length(coalesce(v_note,''))>1000
     or (v_decision='rejected' and v_note is null) then
    raise exception 'review_note_required';
  end if;

  select * into v_request
  from public.payout_change_requests r
  where r.id=p_request_id
  for update;
  if not found then raise exception 'request_not_found'; end if;
  if not public.can_manage_employee(v_request.employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if v_request.status<>'pending' then raise exception 'request_already_reviewed'; end if;

  if v_decision='rejected' then
    update public.payout_change_requests
    set status='rejected',reviewed_by=v_user,reviewed_at=clock_timestamp(),
        review_note=v_note,updated_at=clock_timestamp()
    where id=v_request.id;

    insert into public.audit_logs(
      actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
    ) values(
      v_user,v_request.employee_id,'payroll','reject_payout_change',v_request.id::text,
      jsonb_build_object('status','pending'),
      jsonb_build_object('status','rejected','review_note',v_note),
      v_note
    );
    return jsonb_build_object('ok',true,'id',v_request.id,'status','rejected');
  end if;

  select * into v_employee
  from public.employees e
  where e.id=v_request.employee_id
  for update;
  if not found
     or lower(btrim(coalesce(v_employee.status::text,''))) not in ('active','probation') then
    raise exception 'employee_not_active';
  end if;

  v_kind:=payment_change_private.expected_kind(v_request.employee_id);
  if v_request.payment_kind<>v_kind then raise exception 'payment_rule_changed'; end if;

  select * into v_profile
  from public.employee_payment_profiles p
  where p.employee_id=v_request.employee_id
  for update;
  if not found then raise exception 'current_payment_unavailable'; end if;

  if v_kind='bank_wallet' then
    if btrim(coalesce(v_profile.transfer_using,''))<>btrim(coalesce(v_request.old_data->>'transfer_using',''))
       or btrim(coalesce(v_profile.gcash_name,''))<>btrim(coalesce(v_request.old_data->>'account_name',''))
       or btrim(coalesce(v_profile.gcash_account,''))<>btrim(coalesce(v_request.old_data->>'account_number','')) then
      raise exception 'current_payment_changed';
    end if;

    update public.employee_payment_profiles
    set transfer_using=v_request.new_data->>'transfer_using',
        gcash_name=v_request.new_data->>'account_name',
        gcash_account=v_request.new_data->>'account_number',
        usdt_address=null,
        payment_mode='bank_wallet',
        payment_mode_source='employee_change_approved',
        updated_at=clock_timestamp()
    where employee_id=v_request.employee_id;

    v_method:=case
      when upper(v_request.new_data->>'transfer_using') like '%MAYA%' then 'MAYA'
      when upper(v_request.new_data->>'transfer_using') like '%GCASH%' then 'GCASH'
      else 'BANK'
    end;
    update public.payout_accounts set is_current=false,updated_at=clock_timestamp()
    where employee_id=v_request.employee_id and is_current;
    insert into public.payout_accounts(
      employee_id,method,account_name,account_number,bank_name,is_current,created_at,updated_at
    ) values(
      v_request.employee_id,v_method,v_request.new_data->>'account_name',
      v_request.new_data->>'account_number',v_request.new_data->>'transfer_using',
      true,clock_timestamp(),clock_timestamp()
    );
  else
    if btrim(coalesce(v_profile.usdt_address,''))<>btrim(coalesce(v_request.old_data->>'usdt_address','')) then
      raise exception 'current_payment_changed';
    end if;

    update public.employee_payment_profiles
    set transfer_using='USDT',gcash_name=null,gcash_account=null,
        usdt_address=v_request.new_data->>'usdt_address',
        payment_mode='usdt',payment_mode_source='employee_change_approved',
        updated_at=clock_timestamp()
    where employee_id=v_request.employee_id;

    update public.payout_accounts set is_current=false,updated_at=clock_timestamp()
    where employee_id=v_request.employee_id and is_current;
    insert into public.payout_accounts(
      employee_id,method,account_name,wallet_address,is_current,created_at,updated_at
    ) values(
      v_request.employee_id,'USDT',v_employee.full_name,
      v_request.new_data->>'usdt_address',true,clock_timestamp(),clock_timestamp()
    );
  end if;

  update public.payout_change_requests
  set status='approved',reviewed_by=v_user,reviewed_at=clock_timestamp(),
      review_note=v_note,updated_at=clock_timestamp()
  where id=v_request.id;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_request.employee_id,'payroll','approve_payout_change',v_request.id::text,
    jsonb_build_object('payment_kind',v_kind,'payment',v_request.old_data,'status','pending'),
    jsonb_build_object('payment_kind',v_kind,'payment',v_request.new_data,'status','approved'),
    coalesce(v_note,v_request.reason)
  );

  return jsonb_build_object('ok',true,'id',v_request.id,'status','approved');
end;
$$;

revoke all on function public.admin_review_payout_change_request(uuid,text,text)
  from public,anon,authenticated;
grant execute on function public.admin_review_payout_change_request(uuid,text,text)
  to authenticated;

notify pgrst,'reload schema';
