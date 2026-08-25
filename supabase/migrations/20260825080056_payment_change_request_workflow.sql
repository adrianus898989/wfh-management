-- Employee payout-detail change workflow (production baseline 20260825080056).
--
-- Sensitive values are never exposed through direct table access. Staff submit
-- through guarded RPCs, evidence stays in a private bucket, and an approval
-- updates the canonical payment profile and its audit trail atomically.

-- Older production databases already have this table, but the repository did
-- not contain its original DDL. Keep the migration self-contained so a clean
-- environment can replay it safely as well.
create table if not exists public.payout_change_requests(
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  old_data jsonb,
  new_data jsonb not null,
  reason text not null,
  note text,
  otp_verified_at timestamptz,
  status text not null default 'pending'
    check(status in ('pending','approved','rejected','cancelled')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);

alter table public.payout_change_requests
  add column if not exists payment_kind text,
  add column if not exists identity_proof_path text,
  add column if not exists payment_proof_path text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.payout_change_requests
  drop constraint if exists payout_change_requests_payment_kind_check;
alter table public.payout_change_requests
  add constraint payout_change_requests_payment_kind_check
  check (payment_kind is null or payment_kind in ('bank_wallet','usdt'));

create unique index if not exists payout_change_requests_one_pending_per_employee_idx
  on public.payout_change_requests(employee_id)
  where status='pending';
create index if not exists payout_change_requests_status_created_idx
  on public.payout_change_requests(status,created_at desc);
create index if not exists payout_change_requests_employee_created_idx
  on public.payout_change_requests(employee_id,created_at desc);

alter table public.payout_change_requests enable row level security;
revoke all on table public.payout_change_requests from anon,authenticated;

insert into public.permissions(code,name,category,sensitive)
values
  ('payroll.payout_change.view','查看收款资料修改申请','payroll',true),
  ('payroll.payout_change.review','审核收款资料修改申请','payroll',true)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'payment-change-proof',
  'payment-change-proof',
  false,
  10485760,
  array['image/jpeg','image/png','image/webp','application/pdf']::text[]
)
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create schema if not exists payment_change_private;
revoke all on schema payment_change_private from public,anon,authenticated;

create or replace function payment_change_private.mask_sensitive(p_value text)
returns text
language sql
immutable
set search_path=''
as $$
  select case
    when nullif(btrim(p_value),'') is null then null
    when char_length(btrim(p_value))<=4
      then repeat('*',greatest(char_length(btrim(p_value))-1,1))||right(btrim(p_value),1)
    when char_length(btrim(p_value))<=8
      then left(btrim(p_value),1)||repeat('*',char_length(btrim(p_value))-2)||right(btrim(p_value),1)
    else left(btrim(p_value),4)||repeat('*',greatest(char_length(btrim(p_value))-8,4))||right(btrim(p_value),4)
  end;
$$;

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

revoke all on function payment_change_private.mask_sensitive(text)
  from public,anon,authenticated;
revoke all on function payment_change_private.expected_kind(uuid)
  from public,anon,authenticated;

create or replace function public.payment_change_current_staff_session_is_valid()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select session_private.current_app_session_is_valid('staff')
    and exists(select 1 from public.exam_staff_context());
$$;

create or replace function public.payment_change_admin_can_read_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select
    (
      public.has_permission('payroll.payout_change.view')
      or public.has_permission('payroll.payout_change.review')
    )
    and exists(
      select 1
      from public.payout_change_requests r
      where (r.identity_proof_path=p_name or r.payment_proof_path=p_name)
        and public.can_manage_employee(r.employee_id)
    );
$$;

create or replace function public.payment_change_staff_may_delete_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select public.payment_change_current_staff_session_is_valid()
    and split_part(p_name,'/',1)=(select auth.uid())::text
    and not exists(
      select 1 from public.payout_change_requests r
      where r.identity_proof_path=p_name or r.payment_proof_path=p_name
    );
$$;

revoke all on function public.payment_change_current_staff_session_is_valid()
  from public,anon,authenticated;
revoke all on function public.payment_change_admin_can_read_object(text)
  from public,anon,authenticated;
revoke all on function public.payment_change_staff_may_delete_object(text)
  from public,anon,authenticated;
grant execute on function public.payment_change_current_staff_session_is_valid()
  to authenticated;
grant execute on function public.payment_change_admin_can_read_object(text)
  to authenticated;
grant execute on function public.payment_change_staff_may_delete_object(text)
  to authenticated;

drop policy if exists payment_change_proof_read on storage.objects;
create policy payment_change_proof_read
on storage.objects for select to authenticated
using(
  bucket_id='payment-change-proof'
  and (
    (
      owner_id=(select auth.uid())::text
      and split_part(name,'/',1)=(select auth.uid())::text
      and public.payment_change_current_staff_session_is_valid()
    )
    or public.payment_change_admin_can_read_object(name)
  )
);

drop policy if exists payment_change_proof_insert on storage.objects;
create policy payment_change_proof_insert
on storage.objects for insert to authenticated
with check(
  bucket_id='payment-change-proof'
  and split_part(name,'/',1)=(select auth.uid())::text
  and public.payment_change_current_staff_session_is_valid()
);

drop policy if exists payment_change_proof_delete on storage.objects;
create policy payment_change_proof_delete
on storage.objects for delete to authenticated
using(
  bucket_id='payment-change-proof'
  and owner_id=(select auth.uid())::text
  and public.payment_change_staff_may_delete_object(name)
);

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
      'employee_no',c.employee_no,
      'employee_name',c.employee_name
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
      )
      else jsonb_build_object(
        'usdt_address_masked',payment_change_private.mask_sensitive(v_profile.usdt_address)
      )
    end,
    'requests',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select
          r.id,
          r.payment_kind,
          r.reason,
          r.status,
          r.review_note,
          r.created_at,
          r.reviewed_at,
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
    if btrim(coalesce(p_old_data->>'transfer_using',''))<>btrim(v_profile.transfer_using)
       or btrim(coalesce(p_old_data->>'account_name',''))<>btrim(v_profile.gcash_name)
       or btrim(coalesce(p_old_data->>'account_number',''))<>btrim(v_profile.gcash_account) then
      raise exception 'old_payment_mismatch';
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
    if btrim(coalesce(p_old_data->>'usdt_address',''))<>btrim(v_profile.usdt_address) then
      raise exception 'old_payment_mismatch';
    end if;
    if nullif(btrim(p_new_data->>'usdt_address'),'') is null
       or char_length(btrim(p_new_data->>'usdt_address'))>300 then
      raise exception 'invalid_new_payment';
    end if;
    v_old:=jsonb_build_object('usdt_address',btrim(v_profile.usdt_address));
    v_new:=jsonb_build_object('usdt_address',btrim(p_new_data->>'usdt_address'));
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
    v_kind,p_identity_proof_path,p_payment_proof_path,clock_timestamp(),clock_timestamp()
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
    );

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
  into v_rows
  from (
    select
      r.id,
      r.employee_id,
      e.employee_no,
      e.full_name as employee_name,
      e.employment_type,
      coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),'')) as country,
      e.status as employee_status,
      t.name as team_name,
      p.name as position_name,
      r.payment_kind,
      r.old_data,
      r.new_data,
      r.reason,
      r.identity_proof_path,
      r.payment_proof_path,
      r.status,
      r.review_note,
      r.created_at,
      r.reviewed_at,
      coalesce(requester.login_username,requester.login_email) as requested_by,
      coalesce(reviewer.login_username,reviewer.login_email) as reviewed_by
    from public.payout_change_requests r
    join public.employees e on e.id=r.employee_id
    left join public.teams t on t.id=e.team_id
    left join public.positions p on p.id=e.position_id
    left join public.user_access requester on requester.auth_user_id=r.requested_by
    left join public.user_access reviewer on reviewer.auth_user_id=r.reviewed_by
    where (v_status='' or r.status=v_status)
      and public.can_manage_employee(r.employee_id)
      and (
        v_search=''
        or lower(coalesce(e.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(e.full_name,'')) like '%'||v_search||'%'
        or lower(coalesce(r.reason,'')) like '%'||v_search||'%'
      )
    order by r.created_at desc
    limit v_size offset (v_page-1)*v_size
  ) x;

  return jsonb_build_object(
    'rows',v_rows,
    'total',v_total,
    'page',v_page,
    'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1)
  );
end;
$$;

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

  select * into v_employee from public.employees e where e.id=v_request.employee_id for update;
  if not found or lower(btrim(coalesce(v_employee.status::text,''))) not in ('active','probation') then
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

revoke all on function public.staff_payment_change_context()
  from public,anon,authenticated;
revoke all on function public.staff_submit_payout_change_request(uuid,jsonb,jsonb,text,text,text)
  from public,anon,authenticated;
revoke all on function public.admin_payout_change_requests(text,text,integer,integer)
  from public,anon,authenticated;
revoke all on function public.admin_review_payout_change_request(uuid,text,text)
  from public,anon,authenticated;

grant execute on function public.staff_payment_change_context()
  to authenticated;
grant execute on function public.staff_submit_payout_change_request(uuid,jsonb,jsonb,text,text,text)
  to authenticated;
grant execute on function public.admin_payout_change_requests(text,text,integer,integer)
  to authenticated;
grant execute on function public.admin_review_payout_change_request(uuid,text,text)
  to authenticated;

comment on function public.staff_payment_change_context() is
  'Returns the current staff payout rule, masked current value, and that staff member''s request history.';
comment on function public.staff_submit_payout_change_request(uuid,jsonb,jsonb,text,text,text) is
  'Validates old payout details and two private proof objects before creating one pending request.';
comment on function public.admin_review_payout_change_request(uuid,text,text) is
  'Atomically approves or rejects an in-scope payout change and records a restricted audit event.';

notify pgrst,'reload schema';
