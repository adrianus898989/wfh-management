begin;

-- Confirmed aliases live outside the Data API.  They prevent the same legacy
-- workbook ID from being attached to two different employee identities during
-- concurrent or later imports, while preserving the original workbook value.
create table if not exists payroll_private.employee_identity_aliases (
  old_employee_no_key text primary key,
  old_employee_no_raw text not null,
  employee_id uuid references public.employees(id) on delete set null,
  employee_no_at_match text not null,
  full_name_key text not null,
  hire_date date not null,
  match_source text not null,
  first_batch_id bigint references public.payroll_batches(id) on delete set null,
  first_source_row integer,
  last_batch_id bigint references public.payroll_batches(id) on delete set null,
  last_source_row integer,
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint payroll_employee_identity_alias_source_check check (
    match_source = 'legacy_old_id_unique_name_hire_date'
  )
);

create index if not exists payroll_employee_identity_alias_employee_idx
  on payroll_private.employee_identity_aliases(employee_id,updated_at desc);

alter table payroll_private.employee_identity_aliases enable row level security;
revoke all on table payroll_private.employee_identity_aliases
  from public,anon,authenticated,service_role;

comment on table payroll_private.employee_identity_aliases is
  'Audited legacy workbook employee-number aliases. No direct Data API access; safe import triggers are the only writer.';

create or replace function payroll_private.resolve_legacy_employee_no_identity(
  p_old_employee_no text,
  p_full_name text,
  p_hire_date date
)
returns table(
  employee_id uuid,
  employee_no text,
  employee_status text,
  employee_resign_date date,
  full_name_key text,
  match_source text
)
language sql
stable
security definer
set search_path = ''
as $$
  with name_candidates as (
    select
      employee.id,
      employee.employee_no,
      lower(btrim(employee.status::text)) as employee_status,
      employee.resign_date,
      employee.hire_date,
      internal.payroll_name_key(employee.full_name) as full_name_key,
      count(*) over() as normalized_name_count
    from public.employees employee
    where internal.payroll_name_key(employee.full_name)
          = internal.payroll_name_key(p_full_name)
      and internal.payroll_name_key(p_full_name) <> ''
  ), unique_candidate as (
    select candidate.*
    from name_candidates candidate
    where candidate.normalized_name_count = 1
      and p_hire_date is not null
      and candidate.hire_date = p_hire_date
  )
  select
    candidate.id,
    candidate.employee_no,
    candidate.employee_status,
    candidate.resign_date,
    candidate.full_name_key,
    'legacy_old_id_unique_name_hire_date'::text
  from unique_candidate candidate
  where internal.payroll_employee_no_key(p_old_employee_no) <> ''
    -- A currently assigned ID always wins and must never be treated as an alias.
    and not exists (
      select 1
      from public.employees assigned
      where internal.payroll_employee_no_key(assigned.employee_no)
            = internal.payroll_employee_no_key(p_old_employee_no)
    )
    -- A non-voided lifecycle belonging to somebody else (or to an unresolved
    -- deleted identity) makes the legacy number ambiguous and blocks fallback.
    and not exists (
      select 1
      from public.employee_lifecycle_events lifecycle
      where internal.payroll_employee_no_key(lifecycle.employee_no)
            = internal.payroll_employee_no_key(p_old_employee_no)
        and lifecycle.note is distinct from '__VOIDED__'
        and lifecycle.event_type in ('join','resign','reactivate')
        and lifecycle.employee_id is distinct from candidate.id
    )
    -- A prior confirmed alias may be reused only for the same employee UUID.
    and not exists (
      select 1
      from payroll_private.employee_identity_aliases alias
      where alias.old_employee_no_key = internal.payroll_employee_no_key(p_old_employee_no)
        and alias.employee_id is distinct from candidate.id
    );
$$;

revoke all on function payroll_private.resolve_legacy_employee_no_identity(text,text,date)
  from public,anon,authenticated,service_role;

create or replace function payroll_private.classify_payroll_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_history record;
  v_legacy record;
  v_alias_employee_id uuid;
  v_raw_departure text := coalesce(
    nullif(new.raw_payload#>>'{__payroll_fields,departure_date}', ''),
    nullif(new.raw_payload->>'离职日期', '')
  );
begin
  if new.departure_date is null and v_raw_departure ~ '^\d{4}-\d{2}-\d{2}$' then
    new.departure_date := v_raw_departure::date;
  end if;

  if tg_op = 'INSERT'
     and new.employee_id is null
     and internal.payroll_employee_no_key(new.employee_no_raw) <> ''
     and internal.payroll_name_key(new.full_name) <> ''
     and new.hire_date is not null
     and exists (
       select 1
       from public.payroll_batches batch
       where batch.id=new.batch_id
         and batch.source_type='upload'
         and batch.status='draft'
         and batch.voided_at is null
     ) then
    select legacy.* into v_legacy
    from payroll_private.resolve_legacy_employee_no_identity(
      new.employee_no_raw,new.full_name,new.hire_date
    ) legacy
    limit 1;

    if found then
      insert into payroll_private.employee_identity_aliases(
        old_employee_no_key,old_employee_no_raw,employee_id,
        employee_no_at_match,full_name_key,hire_date,match_source,
        first_batch_id,first_source_row,last_batch_id,last_source_row,created_by
      ) values(
        internal.payroll_employee_no_key(new.employee_no_raw),
        btrim(new.employee_no_raw),v_legacy.employee_id,
        v_legacy.employee_no,v_legacy.full_name_key,new.hire_date,v_legacy.match_source,
        new.batch_id,new.source_row,new.batch_id,new.source_row,auth.uid()
      )
      on conflict(old_employee_no_key) do update
      set old_employee_no_raw=excluded.old_employee_no_raw,
          employee_no_at_match=excluded.employee_no_at_match,
          full_name_key=excluded.full_name_key,
          hire_date=excluded.hire_date,
          last_batch_id=excluded.last_batch_id,
          last_source_row=excluded.last_source_row,
          updated_at=clock_timestamp()
      where payroll_private.employee_identity_aliases.employee_id=excluded.employee_id
      returning employee_identity_aliases.employee_id into v_alias_employee_id;

      -- The RETURNING guard closes the race where another transaction confirms
      -- the same old number for a different UUID after the resolver read.
      if v_alias_employee_id = v_legacy.employee_id then
        new.employee_id := v_legacy.employee_id;
        new.identity_match_state := 'employee';
        new.identity_match_source := v_legacy.match_source;
        new.departure_date := coalesce(new.departure_date,v_legacy.employee_resign_date);
      end if;
    end if;
  end if;

  if new.employee_id is not null then
    new.identity_match_state := 'employee';
    if not (
      new.identity_match_source = 'legacy_old_id_unique_name_hire_date'
      and exists (
        select 1
        from payroll_private.employee_identity_aliases alias
        where alias.old_employee_no_key = internal.payroll_employee_no_key(new.employee_no_raw)
          and alias.employee_id = new.employee_id
      )
    ) then
      new.identity_match_source := 'employees';
    end if;
  else
    select history.match_source,history.resignation_date
    into v_history
    from payroll_private.resolve_historical_resigned_identity(new.employee_no_raw) history
    limit 1;

    if found then
      new.identity_match_state := 'historical_resigned';
      new.identity_match_source := v_history.match_source;
      new.departure_date := coalesce(new.departure_date,v_history.resignation_date);
    elsif new.departure_date is not null then
      new.identity_match_state := 'historical_resigned';
      new.identity_match_source := 'uploaded_departure';
    else
      new.identity_match_state := 'unmatched';
      new.identity_match_source := null;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function payroll_private.classify_payroll_identity()
  from public,anon,authenticated,service_role;

create or replace function payroll_private.audit_legacy_payroll_identity_match()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.identity_match_source = 'legacy_old_id_unique_name_hire_date'
     and exists (
       select 1
       from public.payroll_batches batch
       where batch.id=new.batch_id
         and batch.source_type='upload'
         and batch.status='draft'
         and batch.voided_at is null
     ) then
    insert into public.payroll_audit_log(
      batch_id,payslip_id,actor_user_id,action,detail
    ) values(
      new.batch_id,new.id,auth.uid(),'identity_alias_confirmed',
      jsonb_build_object(
        'source_row',new.source_row,
        'old_employee_no',new.employee_no_raw,
        'matched_employee_id',new.employee_id,
        'matched_employee_no',(
          select employee.employee_no from public.employees employee
          where employee.id=new.employee_id
        ),
        'hire_date',new.hire_date,
        'match_source',new.identity_match_source
      )
    );
  end if;
  return new;
end;
$$;

revoke all on function payroll_private.audit_legacy_payroll_identity_match()
  from public,anon,authenticated,service_role;

drop trigger if exists payroll_identity_alias_audit on public.payroll_payslips;
create trigger payroll_identity_alias_audit
after insert on public.payroll_payslips
for each row execute function payroll_private.audit_legacy_payroll_identity_match();

-- The row trigger performs the safe fallback after the retained importer has
-- counted its local variables. Recompute the authoritative batch/result counts
-- in the current public wrapper so UI totals and the import audit stay correct.
create or replace function public.admin_payroll_import(p_batch jsonb,p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_result jsonb;
  v_batch_id bigint;
  v_started timestamptz := clock_timestamp();
  v_rows integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_resigned integer := 0;
  v_legacy_matches integer := 0;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('payroll.import_history.edit') then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then raise exception 'payroll_all_scope_required'; end if;
  if jsonb_typeof(p_batch) <> 'object' then raise exception 'invalid_batch'; end if;
  if nullif(btrim(coalesce(p_batch->>'id','')),'') is not null then raise exception 'import_batch_id_not_allowed'; end if;

  v_actor_name := payroll_private.admin_payroll_actor_name(v_user);
  v_result := public.admin_payroll_import_granular_v1(
    jsonb_build_object(
      'period_start',p_batch->'period_start','title',p_batch->'title',
      'currency',p_batch->'currency','source_type','upload',
      'source_file_name',p_batch->'source_file_name','notes',p_batch->'notes'
    ),
    p_rows
  );
  v_batch_id := nullif(v_result->>'batch_id','')::bigint;

  select
    count(*)::integer,
    count(*) filter(where payslip.identity_match_state <> 'unmatched')::integer,
    count(*) filter(where payslip.identity_match_state = 'unmatched')::integer,
    count(*) filter(where
      payslip.identity_match_state = 'historical_resigned'
      or (payslip.employee_id is not null and lower(btrim(employee.status::text))='resigned')
    )::integer,
    count(*) filter(where
      payslip.identity_match_source='legacy_old_id_unique_name_hire_date'
    )::integer
  into v_rows,v_matched,v_unmatched,v_resigned,v_legacy_matches
  from public.payroll_payslips payslip
  left join public.employees employee on employee.id=payslip.employee_id
  where payslip.batch_id=v_batch_id;

  update public.payroll_batches batch
  set row_count=v_rows,matched_count=v_matched,unmatched_count=v_unmatched,
      created_by_name=coalesce(batch.created_by_name,v_actor_name),
      updated_by=v_user,updated_by_name=v_actor_name,
      updated_at=greatest(batch.updated_at,v_started)
  where batch.id=v_batch_id;

  update public.payroll_audit_log audit
  set detail=audit.detail||jsonb_build_object(
    'actor_name',v_actor_name,'rows',v_rows,'matched',v_matched,
    'unmatched',v_unmatched,'resigned',v_resigned,
    'legacy_old_id_matched',v_legacy_matches
  )
  where audit.id=(
    select log.id from public.payroll_audit_log log
    where log.batch_id=v_batch_id and log.actor_user_id=v_user
      and log.action='import'
    order by log.created_at desc,log.id desc limit 1
  );

  return jsonb_build_object(
    'batch_id',v_batch_id,'rows',v_rows,'matched',v_matched,
    'unmatched',v_unmatched,'resigned',v_resigned,
    'legacy_old_id_matched',v_legacy_matches
  );
end;
$$;

revoke all on function public.admin_payroll_import(jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.admin_payroll_import(jsonb,jsonb)
  to authenticated;

comment on function payroll_private.resolve_legacy_employee_no_identity(text,text,date) is
  'Matches an unknown non-empty workbook ID only when normalized name is globally unique, hire date exactly matches, and no conflicting current/lifecycle/alias identity exists.';
comment on function public.admin_payroll_import(jsonb,jsonb) is
  'Imports a new payroll draft and returns authoritative identity counts, including audited safe legacy-ID fallback matches.';

notify pgrst,'reload schema';

commit;
