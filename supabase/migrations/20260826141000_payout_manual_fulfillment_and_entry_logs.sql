-- Payment-detail requests are reviewed first and fulfilled manually by default.
-- The automatic writer is implemented behind a private, database-only switch,
-- which is deliberately OFF. No public/admin RPC can enable it.

alter table public.payout_change_requests
  add column if not exists fulfillment_status text not null default 'awaiting_review',
  add column if not exists fulfilled_at timestamptz,
  add column if not exists fulfilled_by uuid references auth.users(id) on delete set null,
  add column if not exists fulfillment_checked_at timestamptz,
  add column if not exists auto_applied boolean not null default false;

alter table public.payout_change_requests
  drop constraint if exists payout_change_requests_fulfillment_status_check;
alter table public.payout_change_requests
  add constraint payout_change_requests_fulfillment_status_check
  check (fulfillment_status in (
    'awaiting_review','pending_manual','matched','mismatch','not_applicable'
  ));

create index if not exists payout_change_requests_fulfillment_created_idx
  on public.payout_change_requests(fulfillment_status,created_at desc);

alter table public.payout_change_requests enable row level security;
revoke all on table public.payout_change_requests from public,anon,authenticated;

create schema if not exists payment_change_private;
revoke all on schema payment_change_private from public,anon,authenticated;

create table if not exists payment_change_private.workflow_settings(
  singleton boolean primary key default true check(singleton),
  auto_apply_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table payment_change_private.workflow_settings enable row level security;
revoke all on table payment_change_private.workflow_settings
  from public,anon,authenticated;
grant select,insert,update,delete on table payment_change_private.workflow_settings
  to service_role;

insert into payment_change_private.workflow_settings(singleton,auto_apply_enabled)
values(true,false)
on conflict(singleton) do update
set auto_apply_enabled=false,
    updated_at=clock_timestamp(),
    updated_by=null;

comment on table payment_change_private.workflow_settings is
  'Private payout-change switch. auto_apply_enabled is intentionally false and has no browser/admin toggle.';

create or replace function payment_change_private.profile_match_state(
  p_employee_id uuid,
  p_payment_kind text,
  p_old_data jsonb,
  p_new_data jsonb
)
returns text
language sql
stable
set search_path=''
as $$
  select case
    when p.employee_id is null then 'unavailable'
    when p_payment_kind='bank_wallet'
      and btrim(coalesce(p.transfer_using,''))=btrim(coalesce(p_new_data->>'transfer_using',''))
      and btrim(coalesce(p.gcash_name,''))=btrim(coalesce(p_new_data->>'account_name',''))
      and btrim(coalesce(p.gcash_account,''))=btrim(coalesce(p_new_data->>'account_number',''))
      then 'matched'
    when p_payment_kind='bank_wallet'
      and btrim(coalesce(p.transfer_using,''))=btrim(coalesce(p_old_data->>'transfer_using',''))
      and btrim(coalesce(p.gcash_name,''))=btrim(coalesce(p_old_data->>'account_name',''))
      and btrim(coalesce(p.gcash_account,''))=btrim(coalesce(p_old_data->>'account_number',''))
      then 'unchanged'
    when p_payment_kind='usdt'
      and btrim(coalesce(p.usdt_address,''))=btrim(coalesce(p_new_data->>'usdt_address',''))
      then 'matched'
    when p_payment_kind='usdt'
      and btrim(coalesce(p.usdt_address,''))=btrim(coalesce(p_old_data->>'usdt_address',''))
      then 'unchanged'
    else 'mismatch'
  end
  from (select 1) anchor
  left join public.employee_payment_profiles p on p.employee_id=p_employee_id;
$$;

revoke all on function payment_change_private.profile_match_state(uuid,text,jsonb,jsonb)
  from public,anon,authenticated;

-- This writer is kept private and refuses to run while the private switch is
-- off. The switch is off by default and is not exposed through any RPC/UI.
create or replace function payment_change_private.auto_apply_request(
  p_request_id uuid,
  p_actor uuid
)
returns text
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request public.payout_change_requests%rowtype;
  v_profile public.employee_payment_profiles%rowtype;
  v_employee public.employees%rowtype;
  v_kind text;
  v_match text;
  v_method text;
begin
  if not coalesce((
    select s.auto_apply_enabled
    from payment_change_private.workflow_settings s
    where s.singleton
  ),false) then
    raise exception 'auto_apply_disabled';
  end if;

  select * into v_request
  from public.payout_change_requests r
  where r.id=p_request_id
  for update;
  if not found then raise exception 'request_not_found'; end if;

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

  v_match:=payment_change_private.profile_match_state(
    v_request.employee_id,v_kind,v_request.old_data,v_request.new_data
  );
  if v_match='matched' then return 'matched'; end if;
  if v_match<>'unchanged' then raise exception 'current_payment_changed'; end if;

  if v_kind='bank_wallet' then
    update public.employee_payment_profiles
    set transfer_using=v_request.new_data->>'transfer_using',
        gcash_name=v_request.new_data->>'account_name',
        gcash_account=v_request.new_data->>'account_number',
        usdt_address=null,
        payment_mode='bank_wallet',
        payment_mode_source='employee_change_auto_approved',
        updated_at=clock_timestamp()
    where employee_id=v_request.employee_id;

    v_method:=case
      when upper(v_request.new_data->>'transfer_using') like '%MAYA%' then 'MAYA'
      when upper(v_request.new_data->>'transfer_using') like '%GCASH%' then 'GCASH'
      else 'BANK'
    end;
    update public.payout_accounts
    set is_current=false,updated_at=clock_timestamp()
    where employee_id=v_request.employee_id and is_current;
    insert into public.payout_accounts(
      employee_id,method,account_name,account_number,bank_name,
      is_current,created_at,updated_at
    ) values(
      v_request.employee_id,v_method,v_request.new_data->>'account_name',
      v_request.new_data->>'account_number',v_request.new_data->>'transfer_using',
      true,clock_timestamp(),clock_timestamp()
    );
  else
    update public.employee_payment_profiles
    set transfer_using='USDT',gcash_name=null,gcash_account=null,
        usdt_address=v_request.new_data->>'usdt_address',
        payment_mode='usdt',
        payment_mode_source='employee_change_auto_approved',
        updated_at=clock_timestamp()
    where employee_id=v_request.employee_id;

    update public.payout_accounts
    set is_current=false,updated_at=clock_timestamp()
    where employee_id=v_request.employee_id and is_current;
    insert into public.payout_accounts(
      employee_id,method,account_name,wallet_address,
      is_current,created_at,updated_at
    ) values(
      v_request.employee_id,'USDT',v_employee.full_name,
      v_request.new_data->>'usdt_address',true,
      clock_timestamp(),clock_timestamp()
    );
  end if;

  return 'matched';
end;
$$;

revoke all on function payment_change_private.auto_apply_request(uuid,uuid)
  from public,anon,authenticated;

create or replace function payment_change_private.reconcile_profile_change()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request record;
  v_match text;
  v_next text;
  v_actor uuid:=(select auth.uid());
begin
  for v_request in
    select r.*
    from public.payout_change_requests r
    where r.employee_id=new.employee_id
      and r.status='approved'
      -- A matched request is completed history. A later, unrelated profile change
      -- must not retroactively turn that completed request into a mismatch.
      and r.fulfillment_status in ('pending_manual','mismatch')
    order by r.reviewed_at desc nulls last,r.created_at desc
  loop
    v_match:=payment_change_private.profile_match_state(
      v_request.employee_id,v_request.payment_kind,
      v_request.old_data,v_request.new_data
    );
    v_next:=case
      when v_match='matched' then 'matched'
      when v_match='unchanged' then 'pending_manual'
      else 'mismatch'
    end;

    if v_request.fulfillment_status is distinct from v_next then
      update public.payout_change_requests
      set fulfillment_status=v_next,
          fulfilled_at=case when v_next='matched' then clock_timestamp() else null end,
          fulfilled_by=case when v_next='matched' then v_actor else null end,
          fulfillment_checked_at=clock_timestamp(),
          updated_at=clock_timestamp()
      where id=v_request.id;

      insert into public.audit_logs(
        actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
      ) values(
        v_actor,v_request.employee_id,'payroll','payout_change_fulfillment_status',
        v_request.id::text,
        jsonb_build_object('fulfillment_status',v_request.fulfillment_status),
        jsonb_build_object('fulfillment_status',v_next),
        case
          when v_next='matched' then '员工收款资料已与审核通过的申请一致'
          when v_next='mismatch' then '员工收款资料已变化，但与审核通过的申请不一致'
          else '审核已通过，等待人工修改员工收款资料'
        end
      );
    else
      update public.payout_change_requests
      set fulfillment_checked_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=v_request.id;
    end if;
  end loop;
  return new;
end;
$$;

revoke all on function payment_change_private.reconcile_profile_change()
  from public,anon,authenticated;

drop trigger if exists payout_change_profile_reconcile_trigger
  on public.employee_payment_profiles;
create trigger payout_change_profile_reconcile_trigger
after insert or update of transfer_using,gcash_name,gcash_account,usdt_address,payment_mode
on public.employee_payment_profiles
for each row execute function payment_change_private.reconcile_profile_change();

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
  v_employee public.employees%rowtype;
  v_kind text;
  v_match text;
  v_fulfillment text;
  v_auto_apply_enabled boolean:=false;
  v_auto_applied boolean:=false;
  v_reviewed_at timestamptz:=clock_timestamp();
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
    set status='rejected',reviewed_by=v_user,reviewed_at=v_reviewed_at,
        review_note=v_note,fulfillment_status='not_applicable',
        fulfillment_checked_at=v_reviewed_at,auto_applied=false,
        updated_at=v_reviewed_at
    where id=v_request.id;

    insert into public.audit_logs(
      actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
    ) values(
      v_user,v_request.employee_id,'payroll','reject_payout_change',v_request.id::text,
      jsonb_build_object('status','pending','fulfillment_status','awaiting_review'),
      jsonb_build_object('status','rejected','fulfillment_status','not_applicable','review_note',v_note),
      v_note
    );
    return jsonb_build_object(
      'ok',true,'id',v_request.id,'status','rejected',
      'fulfillment_status','not_applicable','auto_applied',false
    );
  end if;

  select * into v_employee
  from public.employees e
  where e.id=v_request.employee_id;
  if not found
     or lower(btrim(coalesce(v_employee.status::text,''))) not in ('active','probation') then
    raise exception 'employee_not_active';
  end if;

  v_kind:=payment_change_private.expected_kind(v_request.employee_id);
  if v_request.payment_kind<>v_kind then raise exception 'payment_rule_changed'; end if;

  v_match:=payment_change_private.profile_match_state(
    v_request.employee_id,v_kind,v_request.old_data,v_request.new_data
  );
  if v_match='unavailable' then raise exception 'current_payment_unavailable'; end if;

  select coalesce(s.auto_apply_enabled,false)
  into v_auto_apply_enabled
  from payment_change_private.workflow_settings s
  where s.singleton;

  if coalesce(v_auto_apply_enabled,false) then
    v_match:=payment_change_private.auto_apply_request(v_request.id,v_user);
    v_auto_applied:=true;
  end if;

  v_fulfillment:=case
    when v_match='matched' then 'matched'
    when v_match='unchanged' then 'pending_manual'
    else 'mismatch'
  end;

  update public.payout_change_requests
  set status='approved',reviewed_by=v_user,reviewed_at=v_reviewed_at,
      review_note=v_note,fulfillment_status=v_fulfillment,
      fulfilled_at=case when v_fulfillment='matched' then v_reviewed_at else null end,
      fulfilled_by=case when v_fulfillment='matched' then v_user else null end,
      fulfillment_checked_at=v_reviewed_at,auto_applied=v_auto_applied,
      updated_at=v_reviewed_at
  where id=v_request.id;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_request.employee_id,'payroll','approve_payout_change',v_request.id::text,
    jsonb_build_object(
      'payment_kind',v_kind,'payment',v_request.old_data,
      'status','pending','fulfillment_status','awaiting_review'
    ),
    jsonb_build_object(
      'payment_kind',v_kind,'payment',v_request.new_data,
      'status','approved','fulfillment_status',v_fulfillment,
      'auto_applied',v_auto_applied
    ),
    coalesce(v_note,v_request.reason)
  );

  return jsonb_build_object(
    'ok',true,'id',v_request.id,'status','approved',
    'fulfillment_status',v_fulfillment,'auto_applied',v_auto_applied
  );
end;
$$;

create or replace function public.admin_payout_change_requests(
  p_status text default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_status text:=lower(btrim(coalesce(p_status,'')));
  v_search text:=lower(btrim(coalesce(p_search,'')));
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),100);
  v_total bigint;
  v_rows jsonb;
  v_auto_apply_enabled boolean:=false;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('payroll.payout_change.view')
    or public.has_permission('payroll.payout_change.review')
  ) then raise exception 'permission_denied'; end if;
  if v_status<>'' and v_status not in ('pending','approved','rejected','cancelled') then
    raise exception 'invalid_status';
  end if;

  select coalesce(s.auto_apply_enabled,false)
  into v_auto_apply_enabled
  from payment_change_private.workflow_settings s
  where s.singleton;

  select count(*) into v_total
  from public.payout_change_requests r
  join public.employees e on e.id=r.employee_id
  where (v_status='' or r.status=v_status)
    and public.can_manage_employee(r.employee_id)
    and (
      v_search=''
      or lower(coalesce(e.employee_no,'')) like '%'||v_search||'%'
      or lower(coalesce(e.full_name,'')) like '%'||v_search||'%'
      or lower(coalesce(r.reason,'')) like '%'||v_search||'%'
      or lower(coalesce(r.review_note,'')) like '%'||v_search||'%'
    );

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
  into v_rows
  from (
    select
      r.id,r.employee_id,e.employee_no,e.full_name as employee_name,
      e.employment_type,
      coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),'')) as country,
      e.status as employee_status,t.name as team_name,p.name as position_name,
      r.payment_kind,r.old_data,r.new_data,r.reason,
      r.identity_proof_path,r.payment_proof_path,r.status,r.review_note,
      r.created_at,r.reviewed_at,r.fulfillment_status,r.fulfilled_at,
      r.fulfillment_checked_at,r.auto_applied,
      coalesce(
        nullif(requester.login_username,''),nullif(requester.login_email,''),
        e.full_name||'（员工本人）'
      ) as requested_by,
      coalesce(nullif(reviewer.login_username,''),nullif(reviewer.login_email,'')) as reviewed_by,
      coalesce(
        nullif(manual_fulfillment.actor_username,''),
        nullif(fulfiller.login_username,''),nullif(fulfiller.login_email,'')
      ) as fulfilled_by,
      payment_change_private.profile_match_state(
        r.employee_id,r.payment_kind,r.old_data,r.new_data
      ) as current_match_state
    from public.payout_change_requests r
    join public.employees e on e.id=r.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    left join public.user_access requester on requester.auth_user_id=r.requested_by
    left join public.user_access reviewer on reviewer.auth_user_id=r.reviewed_by
    left join public.user_access fulfiller on fulfiller.auth_user_id=r.fulfilled_by
    -- Employee profile editing currently runs through a service-role Edge
    -- Function, so auth.uid() is unavailable inside the profile trigger. Recover
    -- the recorded human editor from the existing employee audit row by matching
    -- the approved values; never guess from an unrelated profile edit.
    left join lateral (
      select a.actor_username
      from public.employee_audit_logs a
      where a.employee_id=r.employee_id
        and r.fulfilled_at is not null
        and a.created_at between r.fulfilled_at-interval '1 day'
                             and r.fulfilled_at+interval '1 day'
        and (
          (
            r.payment_kind='bank_wallet'
            and (
              a.changes ? 'payment.transfer_using'
              or a.changes ? 'payment.gcash_name'
              or a.changes ? 'payment.gcash_account'
            )
            and (
              not (a.changes ? 'payment.transfer_using')
              or btrim(coalesce(a.changes->'payment.transfer_using'->>'after',''))
                =btrim(coalesce(r.new_data->>'transfer_using',''))
            )
            and (
              not (a.changes ? 'payment.gcash_name')
              or btrim(coalesce(a.changes->'payment.gcash_name'->>'after',''))
                =btrim(coalesce(r.new_data->>'account_name',''))
            )
            and (
              not (a.changes ? 'payment.gcash_account')
              or btrim(coalesce(a.changes->'payment.gcash_account'->>'after',''))
                =btrim(coalesce(r.new_data->>'account_number',''))
            )
          )
          or (
            r.payment_kind='usdt'
            and a.changes ? 'payment.usdt_address'
            and btrim(coalesce(a.changes->'payment.usdt_address'->>'after',''))
              =btrim(coalesce(r.new_data->>'usdt_address',''))
          )
        )
      order by abs(extract(epoch from (a.created_at-r.fulfilled_at))),a.id
      limit 1
    ) manual_fulfillment on true
    where (v_status='' or r.status=v_status)
      and public.can_manage_employee(r.employee_id)
      and (
        v_search=''
        or lower(coalesce(e.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(e.full_name,'')) like '%'||v_search||'%'
        or lower(coalesce(r.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(r.review_note,'')) like '%'||v_search||'%'
      )
    order by r.created_at desc
    limit v_size offset (v_page-1)*v_size
  ) x;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1),
    'auto_apply_enabled',v_auto_apply_enabled,
    'fulfillment_mode',case when v_auto_apply_enabled then 'automatic' else 'manual' end
  );
end;
$$;

create or replace function public.staff_payment_change_context()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  c record;
  v_kind text;
  v_profile public.employee_payment_profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into c from public.exam_staff_context();
  if c.employee_id is null then raise exception 'staff_profile_unavailable'; end if;

  v_kind:=payment_change_private.expected_kind(c.employee_id);
  select * into v_profile
  from public.employee_payment_profiles p
  where p.employee_id=c.employee_id;

  return jsonb_build_object(
    'employee',jsonb_build_object(
      'employee_no',c.employee_no,'employee_name',c.employee_name
    ),
    'payment_kind',v_kind,
    'has_current',case
      when v_kind='bank_wallet' then
        nullif(btrim(v_profile.gcash_account),'') is not null
        and nullif(btrim(v_profile.gcash_name),'') is not null
        and nullif(btrim(v_profile.transfer_using),'') is not null
      else nullif(btrim(v_profile.usdt_address),'') is not null
    end,
    'current',case
      when v_kind='bank_wallet' then jsonb_build_object(
        'transfer_using',v_profile.transfer_using,
        'account_name',v_profile.gcash_name,
        'account_number_masked',payment_change_private.mask_sensitive(v_profile.gcash_account)
      ) else jsonb_build_object(
        'usdt_address_masked',payment_change_private.mask_sensitive(v_profile.usdt_address)
      )
    end,
    'fulfillment_mode','manual',
    'requests',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select
          r.id,r.payment_kind,r.reason,r.status,r.review_note,
          r.created_at,r.reviewed_at,r.fulfillment_status,r.fulfilled_at,
          r.fulfillment_checked_at,r.auto_applied,
          case when r.payment_kind='bank_wallet' then jsonb_build_object(
            'transfer_using',r.old_data->>'transfer_using',
            'account_name',r.old_data->>'account_name',
            'account_number_masked',payment_change_private.mask_sensitive(r.old_data->>'account_number')
          ) else jsonb_build_object(
            'usdt_address_masked',payment_change_private.mask_sensitive(r.old_data->>'usdt_address')
          ) end as old_payment,
          case when r.payment_kind='bank_wallet' then jsonb_build_object(
            'transfer_using',r.new_data->>'transfer_using',
            'account_name',r.new_data->>'account_name',
            'account_number_masked',payment_change_private.mask_sensitive(r.new_data->>'account_number')
          ) else jsonb_build_object(
            'usdt_address_masked',payment_change_private.mask_sensitive(r.new_data->>'usdt_address')
          ) end as new_payment
        from public.payout_change_requests r
        where r.employee_id=c.employee_id
        order by r.created_at desc
        limit 20
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

-- Reconcile any historical rows without changing payment details.
update public.payout_change_requests r
set fulfillment_status=case
      when r.status='pending' then 'awaiting_review'
      when r.status in ('rejected','cancelled') then 'not_applicable'
      when payment_change_private.profile_match_state(
        r.employee_id,r.payment_kind,r.old_data,r.new_data
      )='matched' then 'matched'
      when payment_change_private.profile_match_state(
        r.employee_id,r.payment_kind,r.old_data,r.new_data
      )='unchanged' then 'pending_manual'
      else 'mismatch'
    end,
    fulfilled_at=case
      when r.status='approved' and payment_change_private.profile_match_state(
        r.employee_id,r.payment_kind,r.old_data,r.new_data
      )='matched' then coalesce(r.fulfilled_at,r.reviewed_at,r.updated_at)
      else null
    end,
    fulfillment_checked_at=clock_timestamp(),
    auto_applied=coalesce(r.auto_applied,false),
    updated_at=greatest(r.updated_at,clock_timestamp());

revoke all on function public.admin_review_payout_change_request(uuid,text,text)
  from public,anon,authenticated;
revoke all on function public.admin_payout_change_requests(text,text,integer,integer)
  from public,anon,authenticated;
revoke all on function public.staff_payment_change_context()
  from public,anon,authenticated;
grant execute on function public.admin_review_payout_change_request(uuid,text,text)
  to authenticated;
grant execute on function public.admin_payout_change_requests(text,text,integer,integer)
  to authenticated;
grant execute on function public.staff_payment_change_context()
  to authenticated;

comment on function public.admin_review_payout_change_request(uuid,text,text) is
  'Approves or rejects an in-scope request. Approval records the decision only; automatic payment-profile writes remain privately disabled by default.';
comment on function public.admin_payout_change_requests(text,text,integer,integer) is
  'Returns scoped payout-change audit records, reviewer timestamps, and manual fulfillment/mismatch status.';

-- Reusable, scoped data-entry logs for the new archive-change subdocuments.
create or replace function public.admin_data_entry_logs(
  p_category text default 'adjustment',
  p_search text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_category text:=lower(btrim(coalesce(p_category,'')));
  v_search text:=lower(btrim(coalesce(p_search,'')));
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,20),1),100);
  v_rows jsonb;
  v_total bigint;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('audit.view') then raise exception 'permission_denied'; end if;
  if v_category not in ('adjustment','attendance') then raise exception 'invalid_category'; end if;
  if v_category='adjustment' and not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;
  if v_category='attendance' and not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;

  with entries as (
    select
      'audit:'||a.id::text as id,a.created_at,a.actor_user_id,a.employee_id,
      case
        when a.action='create_adjustment' then 'create'
        when a.action='update_adjustment' then 'update'
        else a.action
      end as action,
      a.record_id,
      r.event_date,
      coalesce(r.event_kind,a.new_data->>'event_kind') as event_kind,
      coalesce(
        r.amount,
        case
          when coalesce(a.new_data->>'amount','') ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
            then (a.new_data->>'amount')::numeric
          else null
        end
      ) as amount,
      coalesce(r.currency,a.new_data->>'currency') as currency,
      coalesce(r.reason,a.reason,a.new_data->>'reason') as reason,
      coalesce(r.note,a.new_data->>'note') as note,
      coalesce(r.sync_origin,'backend') as source,
      coalesce(r.raw_values->>'google_sync_state','saved') as sync_state
    from public.audit_logs a
    left join public.employee_attendance_records r on r.id::text=a.record_id
    where (
      (v_category='adjustment' and a.module='attendance_adjustment')
      or (v_category='attendance' and a.module in ('attendance','attendance_entry','leave'))
    )
    union all
    select
      'record:'||r.id::text as id,r.updated_at,
      coalesce(r.updated_by,r.created_by),r.employee_id,
      case when r.updated_by is not null and r.updated_by<>r.created_by then 'update' else 'create' end,
      r.id::text,r.event_date,r.event_kind,r.amount,r.currency,r.reason,r.note,
      coalesce(r.sync_origin,'backend'),
      coalesce(r.raw_values->>'google_sync_state','saved')
    from public.employee_attendance_records r
    where (
      (v_category='adjustment' and r.kind='adjustment')
      or (v_category='attendance' and r.kind='attendance')
    )
      and coalesce(r.updated_by,r.created_by) is not null
      and not exists(
        select 1 from public.audit_logs a
        where a.record_id=r.id::text
          and (
            (v_category='adjustment' and a.module='attendance_adjustment')
            or (v_category='attendance' and a.module in ('attendance','attendance_entry','leave'))
          )
      )
  ), scoped as (
    select
      x.*,e.employee_no,e.full_name,
      coalesce(nullif(u.login_username,''),nullif(u.login_email,''),'系统 / 外部同步') as actor_name
    from entries x
    left join public.employees e on e.id=x.employee_id
    left join public.user_access u on u.auth_user_id=x.actor_user_id
    -- An unlinked/global row has no employee scope to prove and must never be
    -- exposed by this employee audit endpoint.
    where x.employee_id is not null
      and public.can_manage_employee(x.employee_id)
  ), filtered as materialized (
    select * from scoped x
    where (p_date_from is null or x.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or x.created_at<(p_date_to+1)::timestamptz)
      and (
        v_search=''
        or lower(coalesce(x.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(x.full_name,'')) like '%'||v_search||'%'
        or lower(coalesce(x.actor_name,'')) like '%'||v_search||'%'
        or lower(coalesce(x.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(x.note,'')) like '%'||v_search||'%'
      )
  ), paged as (
    select x.*
    from filtered x
    order by x.created_at desc,x.id desc
    limit v_size offset (v_page-1)*v_size
  )
  select (select count(*) from filtered),
         coalesce((
           select jsonb_agg(to_jsonb(paged) order by created_at desc,id desc)
           from paged
         ),'[]'::jsonb)
  into v_total,v_rows
  ;

  return jsonb_build_object(
    'category',v_category,'rows',v_rows,'total',v_total,
    'page',v_page,'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1)
  );
end;
$$;

revoke all on function public.admin_data_entry_logs(text,text,date,date,integer,integer)
  from public,anon,authenticated;
grant execute on function public.admin_data_entry_logs(text,text,date,date,integer,integer)
  to authenticated;
comment on function public.admin_data_entry_logs(text,text,date,date,integer,integer) is
  'Returns scoped backend-entry logs for attendance or bonus/deduction records, including the responsible account when recorded.';

notify pgrst,'reload schema';
