-- Admin-created bonus / deduction records with a durable Google Sheets outbox.
--
-- The browser writes the canonical Supabase row and the outbox in one database
-- transaction. Google Apps Script leases pending outbox rows, writes the exact
-- allowlisted workbook/month block, and acknowledges the result separately.
-- Google-originated edits use a stable external_id and monotonically increasing
-- revision, so a Supabase echo cannot create a second record or a sync loop.

create schema if not exists attendance_private;
revoke all on schema attendance_private from public, anon, authenticated;

alter table public.employee_attendance_records
  add column if not exists external_id uuid,
  add column if not exists sync_origin text,
  add column if not exists sync_revision bigint not null default 0,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.employee_attendance_records'::regclass
      and conname='employee_attendance_sync_origin_check'
  ) then
    alter table public.employee_attendance_records
      add constraint employee_attendance_sync_origin_check
      check (sync_origin is null or sync_origin in ('admin','google'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.employee_attendance_records'::regclass
      and conname='employee_attendance_sync_revision_check'
  ) then
    alter table public.employee_attendance_records
      add constraint employee_attendance_sync_revision_check
      check (sync_revision >= 0);
  end if;
end
$$;

create unique index if not exists employee_attendance_external_id_unique_idx
  on public.employee_attendance_records(external_id)
  where external_id is not null;

create sequence if not exists attendance_private.adjustment_managed_source_row_seq
  as bigint start with 100000000 increment by 1 minvalue 100000000 maxvalue 2000000000;
revoke all on sequence attendance_private.adjustment_managed_source_row_seq
  from public, anon, authenticated;
grant usage, select on sequence attendance_private.adjustment_managed_source_row_seq
  to service_role;

create table if not exists attendance_private.adjustment_sheet_outbox (
  id bigint generated always as identity primary key,
  adjustment_record_id uuid not null
    references public.employee_attendance_records(id) on delete cascade,
  external_id uuid not null,
  revision bigint not null,
  operation text not null default 'upsert',
  source_key text not null,
  source_month text not null,
  source_slot text not null,
  currency text not null,
  payload jsonb not null,
  state text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_by uuid,
  locked_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint adjustment_sheet_outbox_revision_check check (revision > 0),
  constraint adjustment_sheet_outbox_operation_check check (operation='upsert'),
  constraint adjustment_sheet_outbox_month_check
    check (source_month in ('2026-09','2026-10','2026-11','2026-12')),
  constraint adjustment_sheet_outbox_source_slot_check
    check (source_slot in ('primary','first_half','second_half')),
  constraint adjustment_sheet_outbox_currency_check check (currency in ('USD','PHP')),
  constraint adjustment_sheet_outbox_payload_check check (jsonb_typeof(payload)='object'),
  constraint adjustment_sheet_outbox_state_check
    check (state in ('pending','processing','delivered','failed','superseded')),
  constraint adjustment_sheet_outbox_attempts_check check (attempts >= 0),
  constraint adjustment_sheet_outbox_external_revision_unique
    unique(external_id,revision,operation)
);

create index if not exists adjustment_sheet_outbox_pending_idx
  on attendance_private.adjustment_sheet_outbox(available_at,id)
  where state='pending';
create index if not exists adjustment_sheet_outbox_record_idx
  on attendance_private.adjustment_sheet_outbox(adjustment_record_id,revision desc,id desc);

create table if not exists attendance_private.adjustment_sheet_inbound_requests (
  request_id uuid primary key,
  payload_hash text not null,
  source_key text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint adjustment_sheet_inbound_hash_check
    check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint adjustment_sheet_inbound_result_check
    check (result is null or jsonb_typeof(result)='object')
);

alter table attendance_private.adjustment_sheet_outbox enable row level security;
alter table attendance_private.adjustment_sheet_inbound_requests enable row level security;

revoke all on table attendance_private.adjustment_sheet_outbox
  from public, anon, authenticated;
revoke all on table attendance_private.adjustment_sheet_inbound_requests
  from public, anon, authenticated;
grant select, insert, update, delete on table attendance_private.adjustment_sheet_outbox
  to service_role;
grant select, insert, update, delete on table attendance_private.adjustment_sheet_inbound_requests
  to service_role;
grant usage, select on sequence attendance_private.adjustment_sheet_outbox_id_seq
  to service_role;

drop policy if exists adjustment_sheet_outbox_no_direct_access
  on attendance_private.adjustment_sheet_outbox;
create policy adjustment_sheet_outbox_no_direct_access
  on attendance_private.adjustment_sheet_outbox
  for all to anon, authenticated using(false) with check(false);

drop policy if exists adjustment_sheet_inbound_no_direct_access
  on attendance_private.adjustment_sheet_inbound_requests;
create policy adjustment_sheet_inbound_no_direct_access
  on attendance_private.adjustment_sheet_inbound_requests
  for all to anon, authenticated using(false) with check(false);

-- These are the only three workbooks accepted by the bidirectional protocol.
-- Each workbook uses one fixed gid and four month blocks in the same tab.
insert into public.attendance_sheet_sources(
  source_key,source_name,scope,source_group,source_month,
  sheet_id,sheet_gid,sheet_url,status,is_active,metadata
)
select
  x.source_key,x.source_name,'adjustment',x.source_group,x.source_month,
  x.sheet_id,x.sheet_gid,x.sheet_url,'pending',true,
  jsonb_build_object(
    'sync_protocol','adjustment-v1',
    'workbook_key',x.workbook_key,
    'currency',x.currency,
    'layout',x.layout
  )
from (values
  ('adjustment_onsite_2026_09','现场转居家奖金扣款 · 2026-09','onsite_to_home','2026-09','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','1011694934','https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit?gid=1011694934','onsite','USD','standard'),
  ('adjustment_onsite_2026_10','现场转居家奖金扣款 · 2026-10','onsite_to_home','2026-10','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','1011694934','https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit?gid=1011694934','onsite','USD','standard'),
  ('adjustment_onsite_2026_11','现场转居家奖金扣款 · 2026-11','onsite_to_home','2026-11','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','1011694934','https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit?gid=1011694934','onsite','USD','standard'),
  ('adjustment_onsite_2026_12','现场转居家奖金扣款 · 2026-12','onsite_to_home','2026-12','1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg','1011694934','https://docs.google.com/spreadsheets/d/1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg/edit?gid=1011694934','onsite','USD','standard'),
  ('adjustment_home_vim_2026_09','居家越印缅奖金扣款 · 2026-09','home_vim','2026-09','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','3368572','https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit?gid=3368572','home_vim','USD','standard'),
  ('adjustment_home_vim_2026_10','居家越印缅奖金扣款 · 2026-10','home_vim','2026-10','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','3368572','https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit?gid=3368572','home_vim','USD','standard'),
  ('adjustment_home_vim_2026_11','居家越印缅奖金扣款 · 2026-11','home_vim','2026-11','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','3368572','https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit?gid=3368572','home_vim','USD','standard'),
  ('adjustment_home_vim_2026_12','居家越印缅奖金扣款 · 2026-12','home_vim','2026-12','1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ','3368572','https://docs.google.com/spreadsheets/d/1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ/edit?gid=3368572','home_vim','USD','standard'),
  ('adjustment_home_ph_2026_09','居家菲律宾奖金扣款 · 2026-09','home_ph','2026-09','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','687407921','https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit?gid=687407921','home_ph','PHP','philippines'),
  ('adjustment_home_ph_2026_10','居家菲律宾奖金扣款 · 2026-10','home_ph','2026-10','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','687407921','https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit?gid=687407921','home_ph','PHP','philippines'),
  ('adjustment_home_ph_2026_11','居家菲律宾奖金扣款 · 2026-11','home_ph','2026-11','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','687407921','https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit?gid=687407921','home_ph','PHP','philippines'),
  ('adjustment_home_ph_2026_12','居家菲律宾奖金扣款 · 2026-12','home_ph','2026-12','1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ','687407921','https://docs.google.com/spreadsheets/d/1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ/edit?gid=687407921','home_ph','PHP','philippines')
) as x(source_key,source_name,source_group,source_month,sheet_id,sheet_gid,sheet_url,workbook_key,currency,layout)
on conflict(source_key) do update set
  source_name=excluded.source_name,
  scope=excluded.scope,
  source_group=excluded.source_group,
  source_month=excluded.source_month,
  sheet_id=excluded.sheet_id,
  sheet_gid=excluded.sheet_gid,
  sheet_url=excluded.sheet_url,
  is_active=true,
  metadata=public.attendance_sheet_sources.metadata || excluded.metadata,
  updated_at=now();

create or replace function attendance_private.adjustment_route(
  p_workbook_key text,
  p_source_month text
)
returns table(
  source_id uuid,
  source_key text,
  source_month text,
  workbook_key text,
  currency text,
  spreadsheet_id text,
  sheet_gid text,
  layout text
)
language sql
stable
security definer
set search_path=''
as $$
  select
    s.id,s.source_key,s.source_month,s.metadata->>'workbook_key',
    s.metadata->>'currency',s.sheet_id,s.sheet_gid,s.metadata->>'layout'
  from public.attendance_sheet_sources s
  where s.source_key='adjustment_'||btrim(coalesce(p_workbook_key,''))||'_'||replace(coalesce(p_source_month,''),'-','_')
    and s.scope='adjustment'
    and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1'
  limit 1;
$$;

revoke all on function attendance_private.adjustment_route(text,text)
  from public, anon, authenticated;

create or replace function public.admin_adjustment_editor_options(
  p_search text default '',
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_search text := public.exam_norm(p_search);
  v_limit integer := least(greatest(coalesce(p_limit,100),1),200);
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('adjustment.create')
    or public.has_permission('adjustment.approve')
  ) then raise exception 'permission_denied'; end if;

  return jsonb_build_object(
    'can_create',public.has_permission('adjustment.create'),
    'can_edit',public.has_permission('adjustment.approve'),
    'workbooks',jsonb_build_array(
      jsonb_build_object('key','onsite','label','现场转居家','currency','USD'),
      jsonb_build_object('key','home_vim','label','居家越南 / 印尼 / 缅甸','currency','USD'),
      jsonb_build_object('key','home_ph','label','居家菲律宾','currency','PHP')
    ),
    'months',jsonb_build_array('2026-09','2026-10','2026-11','2026-12'),
    'employees',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.employee_no)
      from (
        select
          e.id,e.employee_no,e.full_name,e.status,e.employment_type,
          coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),'')) country,
          t.name team_name,p.name position_name,
          case
            when public.exam_norm(e.employment_type) like '%现场%'
              or public.exam_norm(e.employment_type) like '%onsite%' then 'onsite'
            when attendance_private.country_is_philippines(
              coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''))
            ) then 'home_ph'
            else 'home_vim'
          end suggested_workbook
        from public.employees e
        left join public.teams t on t.id=e.team_id
        left join public.positions p on p.id=e.position_id
        where public.can_manage_employee(e.id)
          and coalesce(e.source_type,'')<>'google_deleted'
          and upper(btrim(e.employee_no)) not in ('SYSTEM','ADMIN')
          and upper(btrim(e.employee_no)) not like 'TEST%'
          and (
            v_search=''
            or public.exam_norm(e.employee_no) like '%'||v_search||'%'
            or public.exam_norm(e.full_name) like '%'||v_search||'%'
          )
        order by e.employee_no,e.id
        limit v_limit
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

create or replace function attendance_private.enqueue_adjustment_sheet_outbox(
  p_record_id uuid
)
returns bigint
language plpgsql
security definer
set search_path=''
as $$
declare
  v_record public.employee_attendance_records%rowtype;
  v_source public.attendance_sheet_sources%rowtype;
  v_outbox_id bigint;
  v_payload jsonb;
  v_workbook text;
  v_layout text;
  v_source_slot text;
begin
  select * into v_record
  from public.employee_attendance_records r
  where r.id=p_record_id and r.kind='adjustment'
  for update;
  if not found or v_record.external_id is null or v_record.sync_revision<1 then
    raise exception 'managed_adjustment_not_found';
  end if;

  select * into v_source
  from public.attendance_sheet_sources s
  where s.id=v_record.source_id
    and s.metadata->>'sync_protocol'='adjustment-v1';
  if not found then raise exception 'adjustment_route_not_found'; end if;
  v_workbook:=v_source.metadata->>'workbook_key';
  v_layout:=v_source.metadata->>'layout';
  v_source_slot:=lower(btrim(coalesce(v_record.raw_values->>'source_slot','')));
  if v_source_slot='' then
    v_source_slot:=case
      when v_layout='standard' then 'primary'
      when extract(day from v_record.event_date)<=15 then 'first_half'
      else 'second_half'
    end;
  end if;
  if (v_layout='standard' and v_source_slot<>'primary')
    or (v_layout='philippines' and v_source_slot not in ('first_half','second_half')) then
    raise exception 'invalid_source_slot';
  end if;

  update attendance_private.adjustment_sheet_outbox o
  set state='superseded',locked_by=null,locked_until=null,updated_at=clock_timestamp()
  where o.external_id=v_record.external_id
    and o.revision<v_record.sync_revision
    and o.state in ('pending','failed');

  v_payload:=jsonb_build_object(
    'external_id',v_record.external_id,
    'origin','supabase',
    'revision',v_record.sync_revision,
    'operation','upsert',
    'source_key',v_source.source_key,
    'workbook_key',v_workbook,
    'source_month',v_source.source_month,
    'source_slot',v_source_slot,
    'spreadsheet_id',v_source.sheet_id,
    'sheet_gid',v_source.sheet_gid,
    'layout',v_source.metadata->>'layout',
    'currency',v_record.currency,
    'event_date',v_record.event_date,
    'employee_id',v_record.employee_id,
    'employee_no',v_record.employee_no_raw,
    'employee_name',v_record.employee_name_raw,
    'signed_amount',v_record.amount,
    'event_kind',v_record.event_kind,
    'note',v_record.note
  );

  insert into attendance_private.adjustment_sheet_outbox(
    adjustment_record_id,external_id,revision,operation,source_key,
    source_month,source_slot,currency,payload,state,available_at
  ) values(
    v_record.id,v_record.external_id,v_record.sync_revision,'upsert',v_source.source_key,
    v_source.source_month,v_source_slot,v_record.currency,v_payload,'pending',clock_timestamp()
  )
  on conflict(external_id,revision,operation) do update set
    payload=excluded.payload,
    source_slot=excluded.source_slot,
    state=case
      when attendance_private.adjustment_sheet_outbox.state='delivered' then 'delivered'
      else 'pending'
    end,
    available_at=case
      when attendance_private.adjustment_sheet_outbox.state='delivered'
        then attendance_private.adjustment_sheet_outbox.available_at
      else clock_timestamp()
    end,
    locked_by=null,
    locked_until=null,
    last_error=null,
    updated_at=clock_timestamp()
  returning id into v_outbox_id;

  return v_outbox_id;
end;
$$;

revoke all on function attendance_private.enqueue_adjustment_sheet_outbox(uuid)
  from public, anon, authenticated;

create or replace function public.admin_adjustment_upsert(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := (select auth.uid());
  v_id uuid;
  v_employee public.employees%rowtype;
  v_employee_no text := upper(btrim(coalesce(p_payload->>'employee_no','')));
  v_workbook text := lower(btrim(coalesce(p_payload->>'workbook_key','')));
  v_month text := btrim(coalesce(p_payload->>'source_month',''));
  v_currency text := upper(btrim(coalesce(p_payload->>'currency','')));
  v_event_date date;
  v_amount numeric;
  v_note text := btrim(coalesce(p_payload->>'note',''));
  v_source_id uuid;
  v_source_key text;
  v_expected_currency text;
  v_external_id uuid;
  v_revision bigint;
  v_expected_revision bigint;
  v_employee_count integer := 0;
  v_source_slot text;
  v_outbox_id bigint;
  v_record_id uuid;
  v_record public.employee_attendance_records%rowtype;
  v_old_json jsonb;
  v_raw jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'invalid_payload';
  end if;

  if nullif(btrim(coalesce(p_payload->>'id','')),'') is not null then
    begin v_id:=(p_payload->>'id')::uuid;
    exception when invalid_text_representation then raise exception 'invalid_record_id'; end;
    begin v_expected_revision:=(p_payload->>'expected_revision')::bigint;
    exception when others then raise exception 'invalid_expected_revision'; end;
    if v_expected_revision is null or v_expected_revision<1 then
      raise exception 'invalid_expected_revision';
    end if;
  end if;
  if v_id is null and not public.has_permission('adjustment.create') then
    raise exception 'permission_denied';
  end if;
  if v_id is not null and not public.has_permission('adjustment.approve') then
    raise exception 'permission_denied';
  end if;

  if v_workbook not in ('onsite','home_vim','home_ph') then
    raise exception 'invalid_workbook';
  end if;
  if v_month not in ('2026-09','2026-10','2026-11','2026-12') then
    raise exception 'invalid_source_month';
  end if;
  begin v_event_date:=(p_payload->>'event_date')::date;
  exception when others then raise exception 'invalid_event_date'; end;
  if to_char(v_event_date,'YYYY-MM')<>v_month then
    raise exception 'event_date_outside_source_month';
  end if;
  begin v_amount:=round((p_payload->>'amount')::numeric,2);
  exception when others then raise exception 'invalid_amount'; end;
  if v_amount=0 or abs(v_amount)>100000000 then raise exception 'invalid_amount'; end if;
  if v_note='' then raise exception 'note_required'; end if;
  if char_length(v_note)>4000 then raise exception 'note_too_long'; end if;
  if v_employee_no='' then raise exception 'employee_no_required'; end if;

  select count(*)::integer into v_employee_count
  from public.employees e
  where upper(btrim(e.employee_no))=v_employee_no;
  if v_employee_count=0 then raise exception 'employee_not_found'; end if;
  if v_employee_count>1 then raise exception 'canonical_employee_id_ambiguous'; end if;
  select e.* into strict v_employee
  from public.employees e
  where upper(btrim(e.employee_no))=v_employee_no;
  if not public.can_manage_employee(v_employee.id) then
    raise exception 'employee_out_of_scope';
  end if;

  select r.source_id,r.source_key,r.currency
  into v_source_id,v_source_key,v_expected_currency
  from attendance_private.adjustment_route(v_workbook,v_month) r;
  if v_source_id is null then raise exception 'adjustment_route_not_found'; end if;
  if v_currency='' or v_currency<>v_expected_currency then
    raise exception 'currency_does_not_match_workbook';
  end if;
  v_source_slot:=case
    when v_workbook='home_ph' and extract(day from v_event_date)<=15 then 'first_half'
    when v_workbook='home_ph' then 'second_half'
    else 'primary'
  end;

  if v_id is null then
    v_external_id:=gen_random_uuid();
    v_revision:=1;
    v_raw:=jsonb_build_object(
      'sync_protocol','adjustment-v1','external_id',v_external_id,
      'origin','admin','revision',v_revision,'google_sync_state','pending',
      'workbook_key',v_workbook,'source_key',v_source_key,
      'source_month',v_month,'source_slot',v_source_slot,'currency',v_currency
    );
    insert into public.employee_attendance_records(
      source_id,source_block,source_row,source_item_key,kind,event_date,event_kind,
      reason,note,amount,raw_amount,currency,employee_id,employee_no_raw,
      employee_name_raw,employee_status_raw,team_name_raw,position_name_raw,
      country_raw,platform_raw,manager_raw,match_status,match_method,matched_at,
      raw_values,content_hash,is_mirror,source_updated_at,synced_at,
      external_id,sync_origin,sync_revision,created_by,updated_by
    ) values(
      v_source_id,'adjustment',
      nextval('attendance_private.adjustment_managed_source_row_seq')::integer,
      v_external_id::text,'adjustment',v_event_date,
      case when v_amount>0 then 'bonus' else 'deduction' end,
      case when v_amount>0 then '后台录入奖金' else '后台录入扣款' end,
      v_note,v_amount,v_amount::text,v_currency,v_employee.id,v_employee.employee_no,
      v_employee.full_name,v_employee.status,null,null,
      coalesce(nullif(btrim(v_employee.country),''),nullif(btrim(v_employee.nationality),'')),
      v_employee.platform_scope,
      nullif(concat_ws(' / ',nullif(btrim(v_employee.person_in_charge),''),
        nullif(btrim(v_employee.leader_name),''),nullif(btrim(v_employee.online_leader),''),
        nullif(btrim(v_employee.online_trainer),''),nullif(btrim(v_employee.on_site_trainer),''),
        nullif(btrim(v_employee.trainer_name),'')),''),
      'matched','employee_id_exact',clock_timestamp(),v_raw,
      md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,v_event_date::text,
        v_employee.employee_no,v_amount::text,v_note)),false,clock_timestamp(),clock_timestamp(),
      v_external_id,'admin',v_revision,v_user,v_user
    ) returning * into v_record;
  else
    select * into v_record
    from public.employee_attendance_records r
    where r.id=v_id and r.kind='adjustment'
    for update;
    if not found then raise exception 'adjustment_not_found'; end if;
    if v_record.sync_revision<>v_expected_revision then
      raise exception 'adjustment_revision_conflict';
    end if;
    if not public.can_manage_employee(v_record.employee_id) then
      raise exception 'employee_out_of_scope';
    end if;
    if v_record.external_id is null
      or coalesce(v_record.raw_values->>'sync_protocol','')<>'adjustment-v1' then
      raise exception 'adjustment_not_editable';
    end if;
    if v_record.source_id<>v_source_id then
      raise exception 'workbook_and_month_cannot_change';
    end if;
    v_source_slot:=lower(btrim(coalesce(v_record.raw_values->>'source_slot','')));
    if v_source_slot='' then
      v_source_slot:=case
        when v_workbook='home_ph' and extract(day from v_record.event_date)<=15 then 'first_half'
        when v_workbook='home_ph' then 'second_half'
        else 'primary'
      end;
    end if;
    if (v_workbook='home_ph' and v_source_slot not in ('first_half','second_half'))
      or (v_workbook<>'home_ph' and v_source_slot<>'primary') then
      raise exception 'invalid_source_slot';
    end if;
    if v_workbook='home_ph' and (
      (v_source_slot='first_half' and extract(day from v_event_date)>15)
      or (v_source_slot='second_half' and extract(day from v_event_date)<=15)
    ) then
      raise exception 'event_date_cannot_cross_source_slot';
    end if;

    v_old_json:=to_jsonb(v_record);
    v_external_id:=v_record.external_id;
    v_revision:=greatest(v_record.sync_revision,0)+1;
    v_raw:=coalesce(v_record.raw_values,'{}'::jsonb)||jsonb_build_object(
      'sync_protocol','adjustment-v1','external_id',v_external_id,
      'origin','admin','revision',v_revision,'google_sync_state','pending',
      'workbook_key',v_workbook,'source_key',v_source_key,
      'source_month',v_month,'source_slot',v_source_slot,'currency',v_currency
    );
    update public.employee_attendance_records r
    set event_date=v_event_date,
        event_kind=case when v_amount>0 then 'bonus' else 'deduction' end,
        reason=case when v_amount>0 then '后台录入奖金' else '后台录入扣款' end,
        note=v_note,amount=v_amount,raw_amount=v_amount::text,currency=v_currency,
        employee_id=v_employee.id,employee_no_raw=v_employee.employee_no,
        employee_name_raw=v_employee.full_name,employee_status_raw=v_employee.status,
        country_raw=coalesce(nullif(btrim(v_employee.country),''),nullif(btrim(v_employee.nationality),'')),
        platform_raw=v_employee.platform_scope,match_status='matched',
        match_method='employee_id_exact',matched_at=clock_timestamp(),raw_values=v_raw,
        content_hash=md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,
          v_event_date::text,v_employee.employee_no,v_amount::text,v_note)),
        source_updated_at=clock_timestamp(),synced_at=clock_timestamp(),
        sync_origin='admin',sync_revision=v_revision,updated_by=v_user,updated_at=clock_timestamp()
    where r.id=v_record.id
    returning * into v_record;
  end if;

  -- The legacy currency trigger derives currency from employee geography. This
  -- protocol's contract is stricter: the selected workbook is authoritative.
  v_record_id:=v_record.id;
  update public.employee_attendance_records
  set currency=v_expected_currency
  where id=v_record_id and currency is distinct from v_expected_currency;
  select * into strict v_record
  from public.employee_attendance_records
  where id=v_record_id;

  v_outbox_id:=attendance_private.enqueue_adjustment_sheet_outbox(v_record.id);
  update public.attendance_sheet_sources
  set status='pending',error_message=null,updated_at=clock_timestamp(),
      metadata=metadata||jsonb_build_object('google_sync_state','pending')
  where id=v_source_id;

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,old_data,new_data,reason
  ) values(
    v_user,v_employee.id,'attendance_adjustment',
    case when v_id is null then 'create_adjustment' else 'update_adjustment' end,
    v_record.id::text,v_old_json,to_jsonb(v_record),
    case when v_id is null then '后台新增奖金 / 扣款并进入 Google 同步队列'
      else '后台编辑奖金 / 扣款并进入 Google 同步队列' end
  );

  return jsonb_build_object(
    'ok',true,'database_saved',true,'id',v_record.id,
    'external_id',v_record.external_id,'revision',v_record.sync_revision,
    'source_slot',v_source_slot,
    'event_kind',v_record.event_kind,'signed_amount',v_record.amount,
    'currency',v_record.currency,'sync_state','pending','outbox_id',v_outbox_id
  );
end;
$$;

create or replace function public.claim_adjustment_sheet_outbox(
  p_worker_id uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit,50),1),100);
  v_lease integer := least(greatest(coalesce(p_lease_seconds,90),30),300);
  v_result jsonb;
begin
  if p_worker_id is null then raise exception 'worker_id_required'; end if;

  update attendance_private.adjustment_sheet_outbox
  set state=case when attempts>=8 then 'failed' else 'pending' end,
      locked_by=null,locked_until=null,
      available_at=case when attempts>=8 then available_at else clock_timestamp() end,
      last_error=case when attempts>=8 then 'lease_expired_retry_limit'
        else 'lease_expired' end,
      updated_at=clock_timestamp()
  where state='processing' and locked_until<clock_timestamp();

  with picked as (
    select o.id
    from attendance_private.adjustment_sheet_outbox o
    where o.state='pending' and o.available_at<=clock_timestamp()
    order by o.available_at,o.id
    for update skip locked
    limit v_limit
  ), claimed as (
    update attendance_private.adjustment_sheet_outbox o
    set state='processing',attempts=o.attempts+1,locked_by=p_worker_id,
        locked_until=clock_timestamp()+make_interval(secs=>v_lease),
        updated_at=clock_timestamp()
    from picked p where o.id=p.id
    returning o.*
  )
  select jsonb_build_object(
    'ok',true,'worker_id',p_worker_id,
    'items',coalesce(jsonb_agg(
      c.payload||jsonb_build_object(
        'outbox_id',c.id::text,'attempt',c.attempts,
        'lease_expires_at',c.locked_until
      ) order by c.id
    ),'[]'::jsonb)
  ) into v_result
  from claimed c;

  return v_result;
end;
$$;

create or replace function public.ack_adjustment_sheet_outbox(
  p_worker_id uuid,
  p_receipts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_receipt jsonb;
  v_outbox attendance_private.adjustment_sheet_outbox%rowtype;
  v_status text;
  v_outbox_id bigint;
  v_revision bigint;
  v_ok integer := 0;
  v_retry integer := 0;
  v_failed integer := 0;
  v_already integer := 0;
  v_sheet_row integer;
begin
  if p_worker_id is null then raise exception 'worker_id_required'; end if;
  if jsonb_typeof(coalesce(p_receipts,'null'::jsonb))<>'array'
    or jsonb_array_length(p_receipts)>100 then raise exception 'invalid_receipts'; end if;

  for v_receipt in select value from jsonb_array_elements(p_receipts)
  loop
    begin
      v_outbox_id:=(v_receipt->>'outbox_id')::bigint;
      v_revision:=(v_receipt->>'revision')::bigint;
    exception when others then
      raise exception 'invalid_receipt_identity';
    end;
    v_status:=lower(btrim(coalesce(v_receipt->>'status','')));
    if v_status not in ('ok','retry','fatal') then raise exception 'invalid_receipt_status'; end if;

    select * into v_outbox
    from attendance_private.adjustment_sheet_outbox o
    where o.id=v_outbox_id
    for update;
    if not found then
      v_failed:=v_failed+1;
      continue;
    end if;
    if v_outbox.external_id::text<>coalesce(v_receipt->>'external_id','')
      or v_outbox.revision<>v_revision then raise exception 'receipt_identity_mismatch'; end if;
    if v_outbox.state='delivered' then
      v_already:=v_already+1;
      continue;
    end if;
    if v_outbox.state<>'processing' or v_outbox.locked_by<>p_worker_id then
      v_failed:=v_failed+1;
      continue;
    end if;

    if v_status='ok' then
      if coalesce(v_receipt->>'sheet_row','') !~ '^[0-9]+$' then
        raise exception 'invalid_google_row';
      end if;
      v_sheet_row:=(v_receipt->>'sheet_row')::integer;
      update attendance_private.adjustment_sheet_outbox
      set state='delivered',delivered_at=clock_timestamp(),locked_by=null,
          locked_until=null,last_error=null,updated_at=clock_timestamp()
      where id=v_outbox.id;

      update public.employee_attendance_records r
      set raw_values=coalesce(r.raw_values,'{}'::jsonb)||jsonb_build_object(
            'google_sync_state','synced','google_synced_at',clock_timestamp(),
            'google_row',v_sheet_row,'google_sheet_gid',v_receipt->>'sheet_gid',
            'google_sheet_name',v_receipt->>'sheet_name'
          )
      where r.id=v_outbox.adjustment_record_id
        and r.external_id=v_outbox.external_id
        and r.sync_revision=v_outbox.revision;

      update public.attendance_sheet_sources
      set status='success',synced_at=clock_timestamp(),error_message=null,
          metadata=metadata||jsonb_build_object('google_sync_state','synced'),
          updated_at=clock_timestamp()
      where source_key=v_outbox.source_key;
      v_ok:=v_ok+1;
    else
      update attendance_private.adjustment_sheet_outbox
      set state=case when v_status='fatal' or attempts>=8 then 'failed' else 'pending' end,
          available_at=case when v_status='fatal' or attempts>=8 then available_at
            else clock_timestamp()+make_interval(secs=>least(3600,(power(2,least(attempts,6))::integer)*60)) end,
          locked_by=null,locked_until=null,
          last_error=left(coalesce(v_receipt->>'error','google_write_failed'),1000),
          updated_at=clock_timestamp()
      where id=v_outbox.id;
      update public.employee_attendance_records r
      set raw_values=coalesce(r.raw_values,'{}'::jsonb)||jsonb_build_object(
            'google_sync_state',case
              when v_status='fatal' or v_outbox.attempts>=8 then 'failed'
              else 'pending'
            end,
            'google_sync_error',left(coalesce(v_receipt->>'error','google_write_failed'),1000)
          )
      where r.id=v_outbox.adjustment_record_id
        and r.external_id=v_outbox.external_id
        and r.sync_revision=v_outbox.revision;
      update public.attendance_sheet_sources
      set status='partial',error_message=left(coalesce(v_receipt->>'error','google_write_failed'),1000),
          metadata=metadata||jsonb_build_object('google_sync_state','pending'),
          updated_at=clock_timestamp()
      where source_key=v_outbox.source_key;
      if v_status='fatal' or v_outbox.attempts>=8 then v_failed:=v_failed+1;
      else v_retry:=v_retry+1; end if;
    end if;
  end loop;

  return jsonb_build_object(
    'ok',true,'delivered',v_ok,'retried',v_retry,
    'failed',v_failed,'already_delivered',v_already
  );
end;
$$;

create or replace function public.ingest_adjustment_sheet_inbound(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request_id uuid;
  v_claimed uuid;
  v_payload_hash text := lower(btrim(coalesce(p_payload->>'payload_hash','')));
  v_source_key text := btrim(coalesce(p_payload->>'source_key',''));
  v_source public.attendance_sheet_sources%rowtype;
  v_workbook text;
  v_layout text;
  v_currency text;
  v_row jsonb;
  v_external_id uuid;
  v_origin text;
  v_revision bigint;
  v_source_slot text;
  v_existing_source_slot text;
  v_google_row integer;
  v_event_date date;
  v_amount numeric;
  v_note text;
  v_employee_no text;
  v_employee_name text;
  v_employee_id uuid;
  v_employee_count integer;
  v_match_status text;
  v_match_method text;
  v_record public.employee_attendance_records%rowtype;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_echo_ignored integer := 0;
  v_stale integer := 0;
  v_result jsonb;
  v_existing_hash text;
  v_existing_result jsonb;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'invalid_payload';
  end if;
  begin v_request_id:=(p_payload->>'request_id')::uuid;
  exception when others then raise exception 'invalid_request_id'; end;
  if v_payload_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_payload_hash'; end if;
  if jsonb_typeof(coalesce(p_payload->'rows','null'::jsonb))<>'array'
    or jsonb_array_length(p_payload->'rows')=0
    or jsonb_array_length(p_payload->'rows')>200 then raise exception 'invalid_rows'; end if;

  select * into v_source
  from public.attendance_sheet_sources s
  where s.source_key=v_source_key and s.scope='adjustment' and s.is_active
    and s.metadata->>'sync_protocol'='adjustment-v1';
  if not found then raise exception 'source_not_allowlisted'; end if;
  v_workbook:=v_source.metadata->>'workbook_key';
  v_layout:=v_source.metadata->>'layout';
  v_currency:=v_source.metadata->>'currency';

  insert into attendance_private.adjustment_sheet_inbound_requests(
    request_id,payload_hash,source_key
  ) values(v_request_id,v_payload_hash,v_source_key)
  on conflict(request_id) do nothing
  returning request_id into v_claimed;
  if v_claimed is null then
    select payload_hash,result into v_existing_hash,v_existing_result
    from attendance_private.adjustment_sheet_inbound_requests
    where request_id=v_request_id;
    if v_existing_hash<>v_payload_hash then raise exception 'request_id_payload_mismatch'; end if;
    return coalesce(v_existing_result,jsonb_build_object('ok',true,'status','already_processing'));
  end if;

  for v_row in select value from jsonb_array_elements(p_payload->'rows')
  loop
    -- A rowtype variable keeps its prior value when reused unless it is reset.
    -- Reset the identity before every lookup so a new external_id can never
    -- accidentally update the previous loop iteration's record.
    v_record:=null;
    begin
      v_external_id:=(v_row->>'external_id')::uuid;
      v_revision:=(v_row->>'revision')::bigint;
      v_event_date:=(v_row->>'event_date')::date;
      v_amount:=round((v_row->>'signed_amount')::numeric,2);
      v_google_row:=(v_row->>'google_row')::integer;
    exception when others then raise exception 'invalid_inbound_row'; end;
    v_origin:=lower(btrim(coalesce(v_row->>'origin','')));
    v_source_slot:=lower(btrim(coalesce(v_row->>'source_slot','')));
    v_note:=btrim(coalesce(v_row->>'note',''));
    v_employee_no:=upper(btrim(coalesce(v_row->>'employee_no','')));
    v_employee_name:=btrim(coalesce(v_row->>'employee_name',''));
    if v_origin not in ('google','supabase') or v_revision<1
      or to_char(v_event_date,'YYYY-MM')<>v_source.source_month
      or v_amount=0 or abs(v_amount)>100000000
      or v_note='' or char_length(v_note)>4000
      or v_employee_no='' or char_length(v_employee_no)>100
      or v_employee_name='' or v_google_row<3 then raise exception 'invalid_inbound_row'; end if;
    if (v_layout='standard' and v_source_slot<>'primary')
      or (v_layout='philippines' and v_source_slot not in ('first_half','second_half')) then
      raise exception 'invalid_source_slot';
    end if;
    if upper(btrim(coalesce(v_row->>'currency','')))<>v_currency then
      raise exception 'currency_does_not_match_workbook';
    end if;

    select * into v_record
    from public.employee_attendance_records r
    where r.external_id=v_external_id
    for update;

    if found then
      if v_record.source_id<>v_source.id then raise exception 'external_id_route_mismatch'; end if;
      v_existing_source_slot:=lower(btrim(coalesce(v_record.raw_values->>'source_slot','')));
      if v_existing_source_slot='' then
        v_existing_source_slot:=case
          when v_layout='standard' then 'primary'
          when extract(day from v_record.event_date)<=15 then 'first_half'
          else 'second_half'
        end;
      end if;
      if v_existing_source_slot<>v_source_slot then
        raise exception 'external_id_source_slot_mismatch';
      end if;
    end if;

    if v_origin='supabase' then
      if found and v_record.sync_revision>=v_revision then
        v_echo_ignored:=v_echo_ignored+1;
        continue;
      end if;
      raise exception 'unknown_supabase_echo';
    end if;

    if found then
      if v_record.sync_revision>=v_revision then
        v_stale:=v_stale+1;
        continue;
      end if;
    end if;

    -- A supplied canonical ID is authoritative. Never hide a missing/wrong ID
    -- behind a same-name match; duplicated canonical IDs are a hard stop.
    select count(*)::integer,min(e.id::text)::uuid
    into v_employee_count,v_employee_id
    from public.employees e
    where upper(btrim(e.employee_no))=v_employee_no;
    if v_employee_count=0 then raise exception 'employee_not_found'; end if;
    if v_employee_count>1 then raise exception 'canonical_employee_id_ambiguous'; end if;
    v_match_status:='matched';
    v_match_method:='employee_id_exact';

    if exists (
      select 1
      from public.employee_attendance_records r
      where r.source_id=v_source.id
        and r.kind='adjustment'
        and r.external_id is distinct from v_external_id
        and coalesce(r.raw_values->>'google_row','')=v_google_row::text
        and coalesce(r.raw_values->>'source_slot','')=v_source_slot
    ) then
      raise exception 'google_source_slot_identity_conflict';
    end if;

    if v_record.id is null then
      insert into public.employee_attendance_records(
        source_id,source_block,source_row,source_item_key,kind,event_date,event_kind,
        reason,note,amount,raw_amount,currency,employee_id,employee_no_raw,
        employee_name_raw,match_status,match_method,matched_at,raw_values,
        content_hash,is_mirror,source_updated_at,synced_at,
        external_id,sync_origin,sync_revision
      ) values(
        v_source.id,'adjustment',
        nextval('attendance_private.adjustment_managed_source_row_seq')::integer,
        v_external_id::text,'adjustment',v_event_date,
        case when v_amount>0 then 'bonus' else 'deduction' end,
        case when v_amount>0 then 'Google 奖金' else 'Google 扣款' end,
        v_note,v_amount,v_amount::text,v_currency,v_employee_id,
        nullif(v_employee_no,''),v_employee_name,v_match_status,v_match_method,
        case when v_employee_id is not null then clock_timestamp() end,
        jsonb_build_object(
          'sync_protocol','adjustment-v1','external_id',v_external_id,
          'origin','google','revision',v_revision,'google_sync_state','synced',
          'workbook_key',v_workbook,'source_key',v_source_key,
          'source_month',v_source.source_month,'source_slot',v_source_slot,
          'currency',v_currency,'google_row',v_google_row
        ),
        md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,v_event_date::text,
          v_employee_no,v_employee_name,v_amount::text,v_note)),false,
        clock_timestamp(),clock_timestamp(),v_external_id,'google',v_revision
      ) returning * into v_record;
      v_inserted:=v_inserted+1;
    else
      update public.employee_attendance_records r
      set event_date=v_event_date,
          event_kind=case when v_amount>0 then 'bonus' else 'deduction' end,
          reason=case when v_amount>0 then 'Google 奖金' else 'Google 扣款' end,
          note=v_note,amount=v_amount,raw_amount=v_amount::text,currency=v_currency,
          employee_id=v_employee_id,employee_no_raw=nullif(v_employee_no,''),
          employee_name_raw=v_employee_name,match_status=v_match_status,
          match_method=v_match_method,
          matched_at=case when v_employee_id is not null then clock_timestamp() end,
          raw_values=jsonb_build_object(
            'sync_protocol','adjustment-v1','external_id',v_external_id,
            'origin','google','revision',v_revision,'google_sync_state','synced',
            'workbook_key',v_workbook,'source_key',v_source_key,
            'source_month',v_source.source_month,'source_slot',v_source_slot,
            'currency',v_currency,'google_row',v_google_row
          ),
          content_hash=md5(concat_ws('|',v_external_id::text,v_revision::text,v_source_slot,
            v_event_date::text,v_employee_no,v_employee_name,v_amount::text,v_note)),
          source_updated_at=clock_timestamp(),synced_at=clock_timestamp(),
          sync_origin='google',sync_revision=v_revision,updated_by=null,
          updated_at=clock_timestamp()
      where r.id=v_record.id
      returning * into v_record;
      v_updated:=v_updated+1;
    end if;

    update public.employee_attendance_records
    set currency=v_currency
    where id=v_record.id and currency is distinct from v_currency;

    update attendance_private.adjustment_sheet_outbox
    set state='superseded',locked_by=null,locked_until=null,
        last_error='google_revision_ahead',updated_at=clock_timestamp()
    where external_id=v_external_id and revision<=v_revision
      and state in ('pending','processing','failed');
  end loop;

  update public.attendance_sheet_sources
  set status='success',synced_at=clock_timestamp(),error_message=null,
      metadata=metadata||jsonb_build_object('google_sync_state','synced'),
      updated_at=clock_timestamp()
  where id=v_source.id;

  v_result:=jsonb_build_object(
    'ok',true,'status','accepted','request_id',v_request_id,
    'source_key',v_source_key,'inserted',v_inserted,'updated',v_updated,
    'echo_ignored',v_echo_ignored,'stale_ignored',v_stale
  );
  update attendance_private.adjustment_sheet_inbound_requests
  set result=v_result,completed_at=clock_timestamp()
  where request_id=v_request_id;
  return v_result;
end;
$$;

revoke all on function public.admin_adjustment_editor_options(text,integer)
  from public, anon, authenticated;
revoke all on function public.admin_adjustment_upsert(jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_adjustment_sheet_outbox(uuid,integer,integer)
  from public, anon, authenticated;
revoke all on function public.ack_adjustment_sheet_outbox(uuid,jsonb)
  from public, anon, authenticated;
revoke all on function public.ingest_adjustment_sheet_inbound(jsonb)
  from public, anon, authenticated;

grant execute on function public.admin_adjustment_editor_options(text,integer)
  to authenticated;
grant execute on function public.admin_adjustment_upsert(jsonb)
  to authenticated;
grant execute on function public.claim_adjustment_sheet_outbox(uuid,integer,integer)
  to service_role;
grant execute on function public.ack_adjustment_sheet_outbox(uuid,jsonb)
  to service_role;
grant execute on function public.ingest_adjustment_sheet_inbound(jsonb)
  to service_role;

comment on table attendance_private.adjustment_sheet_outbox is
  'Durable, leased, idempotent delivery queue from canonical Supabase adjustments to three allowlisted Google workbooks.';
comment on function public.admin_adjustment_upsert(jsonb) is
  'Atomically saves a scoped signed bonus/deduction in Supabase and queues Google delivery; it never waits for Google.';
comment on function public.ingest_adjustment_sheet_inbound(jsonb) is
  'Idempotently applies Google-originated edits by stable external_id/revision without producing a return outbox row.';

-- Existing authenticated attendance wrappers still resolve selected
-- SECURITY DEFINER helpers in this schema. Keep object-level EXECUTE grants
-- narrow, but restore schema lookup after the defensive revoke at the top.
grant usage on schema attendance_private to authenticated, service_role;

notify pgrst,'reload schema';
