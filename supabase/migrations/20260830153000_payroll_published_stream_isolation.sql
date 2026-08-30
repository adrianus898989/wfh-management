begin;

-- Payroll batches are immutable business documents.  Publishing a new upload
-- must never hide an older published upload, even when month, population,
-- cycle and currency are identical.  Replacement is a separate, explicit
-- action linked to one correction source batch.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.payroll_batches
  add column if not exists population_key text,
  add column if not exists pay_cycle_key text,
  add column if not exists import_request_key text,
  add column if not exists import_payload_hash text;

create or replace function payroll_private.payroll_population_key(
  p_value text,
  p_hint text default null
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_value,''))) in
      ('onsite_to_home','onsite-to-home','onsite') then 'onsite_to_home'
    when lower(btrim(coalesce(p_value,''))) in
      ('pure_remote','pure-remote','remote','home') then 'pure_remote'
    when coalesce(p_hint,'') ~*
      '(现场转居家|現場轉居家|onsite[_ -]*to[_ -]*(home|remote))'
      then 'onsite_to_home'
    else 'pure_remote'
  end;
$$;

create or replace function payroll_private.payroll_cycle_key(
  p_value text,
  p_hint text default null
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when lower(btrim(coalesce(p_value,''))) in
      ('first_half','first-half','1-15') then 'first_half'
    when lower(btrim(coalesce(p_value,''))) in
      ('second_half','second-half','16-end') then 'second_half'
    when lower(btrim(coalesce(p_value,''))) in
      ('monthly','full_month','full-month') then 'monthly'
    when coalesce(p_hint,'') ~*
      '(上半月|前半月|first[_ -]*half|(^|[^0-9])1[[:space:]]*[-–—至到][[:space:]]*15([^0-9]|$))'
      then 'first_half'
    when coalesce(p_hint,'') ~*
      '(下半月|后半月|後半月|second[_ -]*half|(^|[^0-9])16[[:space:]]*[-–—至到][[:space:]]*(末|月底|月末|end|[23][0-9])([^0-9]|$))'
      then 'second_half'
    else 'monthly'
  end;
$$;

-- JSON date fields used to be conditionally cast and malformed non-empty
-- values therefore became NULL without telling the operator.  Keep the bulk
-- path set based, but make every supplied date fail closed with its row.
create or replace function payroll_private.payroll_import_strict_date(
  p_value text,
  p_field text,
  p_row integer
)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value text := nullif(btrim(coalesce(p_value,'')),'');
begin
  if v_value is null then return null; end if;
  if v_value !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid_%_at_row_%',p_field,p_row using errcode='22007';
  end if;
  begin
    return v_value::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'invalid_%_at_row_%',p_field,p_row using errcode='22007';
  end;
end;
$$;

update public.payroll_batches batch
set population_key = payroll_private.payroll_population_key(
      batch.population_key,
      concat_ws(' ',batch.title,batch.source_file_name,
        batch.source_project_ref,batch.source_batch_key,batch.notes)
    ),
    pay_cycle_key = payroll_private.payroll_cycle_key(
      batch.pay_cycle_key,
      concat_ws(' ',batch.title,batch.source_file_name,
        batch.source_project_ref,batch.source_batch_key,batch.notes)
    ),
    currency = upper(coalesce(nullif(btrim(batch.currency),''),'USD'))
where batch.population_key is null
   or batch.population_key not in ('pure_remote','onsite_to_home')
   or batch.pay_cycle_key is null
   or batch.pay_cycle_key not in ('monthly','first_half','second_half')
   or batch.currency is distinct from
      upper(coalesce(nullif(btrim(batch.currency),''),'USD'));

alter table public.payroll_batches
  alter column population_key set default 'pure_remote',
  alter column population_key set not null,
  alter column pay_cycle_key set default 'monthly',
  alter column pay_cycle_key set not null;

alter table public.payroll_batches
  drop constraint if exists payroll_batches_population_key_check,
  drop constraint if exists payroll_batches_pay_cycle_key_check;
alter table public.payroll_batches
  add constraint payroll_batches_population_key_check
    check (population_key in ('pure_remote','onsite_to_home')),
  add constraint payroll_batches_pay_cycle_key_check
    check (pay_cycle_key in ('monthly','first_half','second_half'));

-- Remove the old exclusivity constraint before restoring multiple published
-- documents from one former stream; otherwise the repair UPDATE itself can
-- fail with unique_violation and roll the migration back.
drop index if exists public.payroll_batches_one_published_stream_idx;

-- Undo only the confirmed historical automatic-archival bug.  Manual/business
-- archives and explicitly voided imports must not be changed by this repair.
with restored as (
  update public.payroll_batches batch
  set status = 'published',
      archived_at = null,
      archived_by = null,
      archived_by_name = null,
      archive_reason = null,
      updated_at = clock_timestamp()
  where batch.status = 'archived'
    and batch.voided_at is null
    and batch.published_at is not null
    and batch.archive_reason like '批次 #% 发布后自动替代同月份旧批次'
    and exists (
      select 1 from public.payroll_audit_log audit
      where audit.batch_id=batch.id and audit.action='auto_archive'
    )
  returning batch.id,batch.period_start,batch.population_key,
    batch.pay_cycle_key,batch.currency
)
insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
select restored.id,null,'repair_published_coexistence',jsonb_build_object(
  'system',true,
  'status','published',
  'period_start',restored.period_start,
  'population_key',restored.population_key,
  'pay_cycle_key',restored.pay_cycle_key,
  'currency',restored.currency,
  'reason','恢复被旧版自动归档隐藏的已发布工资批次'
)
from restored;

-- A published batch is not unique by stream: multiple uploaded documents from
-- the same stream intentionally coexist.  Idempotency is scoped only to one
-- browser import attempt.
create unique index if not exists payroll_batches_import_request_key_idx
  on public.payroll_batches(import_request_key)
  where import_request_key is not null;

create index if not exists employees_payroll_employee_no_key_idx
  on public.employees(internal.payroll_employee_no_key(employee_no))
  include(id,status,resign_date,updated_at,hire_date,full_name)
  where internal.payroll_employee_no_key(employee_no) <> '';
create index if not exists employees_payroll_name_key_idx
  on public.employees(internal.payroll_name_key(full_name))
  include(id,employee_no,status,resign_date,updated_at,hire_date)
  where internal.payroll_name_key(full_name) <> '';
create index if not exists employee_lifecycle_payroll_employee_no_key_idx
  on public.employee_lifecycle_events(
    internal.payroll_employee_no_key(employee_no),
    effective_date desc,
    created_at desc,
    id desc
  )
  include(event_type,employee_id,note)
  where note is distinct from '__VOIDED__'
    and event_type in ('join','resign','reactivate');

comment on column public.payroll_batches.population_key is
  'Payroll population label used for filtering only; it does not make published batches mutually exclusive.';
comment on column public.payroll_batches.pay_cycle_key is
  'Payroll cycle label used for filtering only; every published batch remains visible.';
comment on column public.payroll_batches.import_request_key is
  'Unique client attempt key. A retry returns the original committed batch instead of importing duplicate rows.';
comment on column public.payroll_batches.import_payload_hash is
  'Canonical MD5 of the import batch metadata (excluding request key) plus row JSON; same request key with different content is rejected.';

-- Existing correction code inserts a draft directly.  Preserve its source
-- classification without implying that ordinary publication replaces it.
create or replace function payroll_private.payroll_inherit_correction_stream()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.payroll_batches%rowtype;
begin
  if new.correction_of_batch_id is null then return new; end if;
  select * into v_source
  from public.payroll_batches batch
  where batch.id = new.correction_of_batch_id;
  if not found then raise exception 'correction_source_batch_not_found'; end if;
  new.population_key := v_source.population_key;
  new.pay_cycle_key := v_source.pay_cycle_key;
  return new;
end;
$$;

drop trigger if exists payroll_batches_inherit_correction_stream
  on public.payroll_batches;
create trigger payroll_batches_inherit_correction_stream
before insert on public.payroll_batches
for each row execute function payroll_private.payroll_inherit_correction_stream();

-- The bulk importer preclassifies identity in one relational plan.  Skip only
-- the two expensive per-row identity triggers during that private operation;
-- the source-field trigger and every table constraint continue to run.
drop trigger if exists payroll_identity_state_fill on public.payroll_payslips;
create trigger payroll_identity_state_fill
before insert or update of employee_id,employee_no_raw,departure_date,raw_payload
on public.payroll_payslips
for each row
when (coalesce(current_setting('payroll.bulk_identity_preclassified',true),'off') <> 'on')
execute function payroll_private.classify_payroll_identity();

drop trigger if exists payroll_identity_alias_audit on public.payroll_payslips;
create trigger payroll_identity_alias_audit
after insert on public.payroll_payslips
for each row
when (coalesce(current_setting('payroll.bulk_identity_preclassified',true),'off') <> 'on')
execute function payroll_private.audit_legacy_payroll_identity_match();

-- Replace the N+1 importer (employee lookup + lifecycle resolver + three row
-- triggers per row) with one parsed staging set, set-based identity matching
-- and one INSERT ... SELECT.  Exact-ID matching still wins; unique-name fallback
-- remains restricted to rows without an ID; legacy-ID alias matching keeps the
-- existing unique-name + exact-hire-date + no-conflict safety boundary.
create or replace function payroll_private.admin_payroll_import(
  p_batch jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_batch_id bigint;
  v_period date;
  v_request_key text;
  v_payload_hash text;
  v_population text;
  v_pay_cycle text;
  v_hint text;
  v_row_count integer := 0;
  v_matched integer := 0;
  v_unmatched integer := 0;
  v_resigned integer := 0;
  v_legacy_matches integer := 0;
  v_invalid_ordinal integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not (
    public.has_permission('payroll.edit')
    or public.has_permission('payroll.import_history.edit')
  ) then raise exception 'permission_denied'; end if;
  if jsonb_typeof(p_batch) is distinct from 'object' then
    raise exception 'invalid_batch';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid_rows';
  end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'empty_rows'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'too_many_rows'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) rows(row_value)
    where jsonb_typeof(rows.row_value) <> 'object'
  ) then raise exception 'invalid_row_object'; end if;
  if nullif(btrim(coalesce(p_batch->>'id','')),'') is not null then
    raise exception 'import_batch_id_not_allowed';
  end if;
  if nullif(btrim(coalesce(p_batch->>'population_key','')),'') is not null
     and lower(btrim(p_batch->>'population_key')) not in (
       'onsite_to_home','onsite-to-home','onsite',
       'pure_remote','pure-remote','remote','home'
     ) then
    raise exception 'invalid_payroll_population_key';
  end if;
  if nullif(btrim(coalesce(p_batch->>'pay_cycle_key','')),'') is not null
     and lower(btrim(p_batch->>'pay_cycle_key')) not in (
       'first_half','first-half','1-15',
       'second_half','second-half','16-end',
       'monthly','full_month','full-month'
     ) then
    raise exception 'invalid_payroll_cycle_key';
  end if;
  select rows.ordinality::integer into v_invalid_ordinal
  from jsonb_array_elements(p_rows) with ordinality rows(row_value,ordinality)
  where nullif(btrim(coalesce(rows.row_value->>'source_row','')),'') is not null
    and btrim(rows.row_value->>'source_row') !~ '^[1-9][0-9]{0,8}$'
  order by rows.ordinality limit 1;
  if found then
    raise exception 'invalid_source_row_at_row_%',v_invalid_ordinal + 1;
  end if;
  select rows.ordinality::integer into v_invalid_ordinal
  from jsonb_array_elements(p_rows) with ordinality rows(row_value,ordinality)
  where rows.row_value ? 'line_items'
    and coalesce(jsonb_typeof(rows.row_value->'line_items'),'null')
      not in ('array','null')
  order by rows.ordinality limit 1;
  if found then
    raise exception 'invalid_line_items_at_row_%',v_invalid_ordinal + 1;
  end if;
  select rows.ordinality::integer into v_invalid_ordinal
  from jsonb_array_elements(p_rows) with ordinality rows(row_value,ordinality)
  where rows.row_value ? 'raw_payload'
    and coalesce(jsonb_typeof(rows.row_value->'raw_payload'),'null')
      not in ('object','null')
  order by rows.ordinality limit 1;
  if found then
    raise exception 'invalid_raw_payload_at_row_%',v_invalid_ordinal + 1;
  end if;

  v_payload_hash:=md5(
    ((p_batch-'import_request_key')::text)||'|'||p_rows::text
  );
  v_request_key := lower(btrim(coalesce(p_batch->>'import_request_key','')));
  if v_request_key='' then
    -- Compatibility for an already-open pre-deployment browser tab.  The
    -- actor-scoped deterministic key makes its retry idempotent too.
    v_request_key:=substr(md5(v_user::text||'|'||v_payload_hash),1,8)||'-'||
      substr(md5(v_user::text||'|'||v_payload_hash),9,4)||'-5'||
      substr(md5(v_user::text||'|'||v_payload_hash),14,3)||'-a'||
      substr(md5(v_user::text||'|'||v_payload_hash),18,3)||'-'||
      substr(md5(v_user::text||'|'||v_payload_hash),21,12);
  end if;
  if v_request_key !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'invalid_import_request_key'; end if;

  v_period := date_trunc(
    'month',coalesce(nullif(p_batch->>'period_start','')::date,current_date)
  )::date;
  v_hint := concat_ws(' ',p_batch->>'title',p_batch->>'source_file_name',
    p_batch->>'source_project_ref',p_batch->>'source_batch_key',p_batch->>'notes');
  v_population := payroll_private.payroll_population_key(
    p_batch->>'population_key',v_hint
  );
  v_pay_cycle := payroll_private.payroll_cycle_key(
    p_batch->>'pay_cycle_key',v_hint
  );

  insert into public.payroll_batches(
    period_start,title,currency,status,source_type,source_file_name,
    source_project_ref,source_batch_key,notes,created_by,
    population_key,pay_cycle_key,import_request_key,import_payload_hash
  ) values(
    v_period,
    coalesce(nullif(btrim(p_batch->>'title'),''),to_char(v_period,'YYYY-MM')),
    upper(coalesce(nullif(btrim(p_batch->>'currency'),''),'USD')),
    'draft',
    coalesce(nullif(btrim(p_batch->>'source_type'),''),'upload'),
    nullif(btrim(p_batch->>'source_file_name'),''),
    nullif(btrim(p_batch->>'source_project_ref'),''),
    nullif(btrim(p_batch->>'source_batch_key'),''),
    nullif(btrim(p_batch->>'notes'),''),
    v_user,v_population,v_pay_cycle,v_request_key,
    v_payload_hash
  ) returning id into v_batch_id;

  drop table if exists pg_temp.payroll_import_rows;
  create temporary table payroll_import_rows on commit drop as
  with source_rows as (
    select row_data,ordinality::integer as ordinal
    from jsonb_array_elements(p_rows) with ordinality rows(row_data,ordinality)
  ), parsed as (
    select
      source_rows.ordinal,
      source_rows.row_data,
      case
        when nullif(btrim(source_rows.row_data->>'source_row'),'') is not null
          then (source_rows.row_data->>'source_row')::integer
        else source_rows.ordinal + 1
      end as source_row,
      internal.payroll_employee_no_key(source_rows.row_data->>'employee_no')
        as employee_key,
      internal.payroll_name_key(source_rows.row_data->>'full_name')
        as name_key,
      payroll_private.payroll_import_strict_date(
        source_rows.row_data->>'hire_date','hire_date',source_rows.ordinal + 1
      ) as hire_date,
      coalesce(
        nullif(source_rows.row_data->>'departure_date',''),
        nullif(source_rows.row_data#>>'{raw_payload,__payroll_fields,departure_date}',''),
        nullif(source_rows.row_data#>>'{raw_payload,离职日期}','')
      ) as raw_departure
    from source_rows
  )
  select
    parsed.ordinal,parsed.source_row,parsed.row_data,
    parsed.employee_key,parsed.name_key,parsed.hire_date,
    payroll_private.payroll_import_strict_date(
      parsed.raw_departure,'departure_date',parsed.ordinal + 1
    ) as departure_date,
    null::uuid as employee_id,
    null::text as employee_status,
    null::date as employee_resign_date,
    'unmatched'::text as identity_match_state,
    null::text as identity_match_source
  from parsed;

  if exists (
    select 1 from pg_temp.payroll_import_rows
    group by source_row having count(*) > 1
  ) then raise exception 'duplicate_source_row'; end if;

  -- Exact current employee number.  Active/probation wins if legacy data has a
  -- duplicate normalized ID, then the most recently updated record.
  with wanted as (
    select distinct row.employee_key
    from pg_temp.payroll_import_rows row
    where row.employee_key <> ''
  ), ranked as (
    select
      internal.payroll_employee_no_key(employee.employee_no) as employee_key,
      employee.id,lower(btrim(employee.status::text)) as employee_status,
      employee.resign_date,
      row_number() over(
        partition by internal.payroll_employee_no_key(employee.employee_no)
        order by case when lower(btrim(employee.status::text))
          in ('active','probation') then 0 else 1 end,
          employee.updated_at desc,employee.id
      ) as match_rank
    from public.employees employee
    join wanted on wanted.employee_key =
      internal.payroll_employee_no_key(employee.employee_no)
  )
  update pg_temp.payroll_import_rows row
  set employee_id=ranked.id,
      employee_status=ranked.employee_status,
      employee_resign_date=ranked.resign_date,
      departure_date=coalesce(row.departure_date,ranked.resign_date),
      identity_match_state='employee',
      identity_match_source='employees'
  from ranked
  where ranked.match_rank=1 and row.employee_key=ranked.employee_key;

  -- Name fallback is deliberately unavailable when the workbook supplied an
  -- unknown non-empty ID.  It applies only to a globally unique name.
  with wanted as (
    select distinct row.name_key
    from pg_temp.payroll_import_rows row
    where row.employee_id is null and row.employee_key='' and row.name_key<>''
  ), ranked as (
    select
      internal.payroll_name_key(employee.full_name) as name_key,
      employee.id,lower(btrim(employee.status::text)) as employee_status,
      employee.resign_date,
      count(*) over(
        partition by internal.payroll_name_key(employee.full_name)
      ) as name_count,
      row_number() over(
        partition by internal.payroll_name_key(employee.full_name)
        order by employee.updated_at desc,employee.id
      ) as match_rank
    from public.employees employee
    join wanted on wanted.name_key=internal.payroll_name_key(employee.full_name)
  )
  update pg_temp.payroll_import_rows row
  set employee_id=ranked.id,
      employee_status=ranked.employee_status,
      employee_resign_date=ranked.resign_date,
      departure_date=coalesce(row.departure_date,ranked.resign_date),
      identity_match_state='employee',
      identity_match_source='employees'
  from ranked
  where ranked.name_count=1 and ranked.match_rank=1
    and row.employee_id is null and row.employee_key=''
    and row.name_key=ranked.name_key;

  -- Resolve safe legacy ID aliases as a set and upsert one confirmation per
  -- old normalized ID.  Conflicting current IDs, lifecycle owners or aliases
  -- make the candidate ineligible.  The conflict UPDATE is guarded by UUID so
  -- two concurrent imports can never bind the same old ID to different people.
  drop table if exists pg_temp.payroll_import_legacy_candidates;
  create temporary table payroll_import_legacy_candidates on commit drop as
  with wanted_names as (
    select distinct row.name_key
    from pg_temp.payroll_import_rows row
    where row.employee_id is null and row.employee_key<>''
      and row.name_key<>'' and row.hire_date is not null
  ), name_ranked as (
    select
      internal.payroll_name_key(employee.full_name) as name_key,
      employee.id as employee_id,employee.employee_no,
      lower(btrim(employee.status::text)) as employee_status,
      employee.resign_date,employee.hire_date,
      count(*) over(
        partition by internal.payroll_name_key(employee.full_name)
      ) as name_count,
      row_number() over(
        partition by internal.payroll_name_key(employee.full_name)
        order by employee.updated_at desc,employee.id
      ) as match_rank
    from public.employees employee
    join wanted_names wanted
      on wanted.name_key=internal.payroll_name_key(employee.full_name)
  ), raw_candidates as (
    select
      row.employee_key as old_employee_no_key,
      nullif(btrim(row.row_data->>'employee_no'),'') as old_employee_no_raw,
      candidate.employee_id,candidate.employee_no,
      candidate.employee_status,candidate.resign_date,
      row.name_key as full_name_key,row.hire_date,row.source_row
    from pg_temp.payroll_import_rows row
    join name_ranked candidate
      on candidate.name_key=row.name_key
     and candidate.name_count=1 and candidate.match_rank=1
     and candidate.hire_date=row.hire_date
    where row.employee_id is null and row.employee_key<>''
      and not exists(
        select 1 from public.employees assigned
        where internal.payroll_employee_no_key(assigned.employee_no)=row.employee_key
      )
      and not exists(
        select 1 from public.employee_lifecycle_events lifecycle
        where internal.payroll_employee_no_key(lifecycle.employee_no)=row.employee_key
          and lifecycle.note is distinct from '__VOIDED__'
          and lifecycle.event_type in ('join','resign','reactivate')
          and lifecycle.employee_id is distinct from candidate.employee_id
      )
      and not exists(
        select 1 from payroll_private.employee_identity_aliases alias
        where alias.old_employee_no_key=row.employee_key
          and alias.employee_id is distinct from candidate.employee_id
      )
  ), unambiguous as (
    select raw.old_employee_no_key
    from raw_candidates raw
    group by raw.old_employee_no_key
    having count(distinct raw.employee_id)=1
  )
  select distinct on(raw.old_employee_no_key)
    raw.old_employee_no_key,raw.old_employee_no_raw,raw.employee_id,
    raw.employee_no,raw.employee_status,raw.resign_date,
    raw.full_name_key,raw.hire_date,raw.source_row
  from raw_candidates raw
  join unambiguous using(old_employee_no_key)
  order by raw.old_employee_no_key,raw.source_row;

  insert into payroll_private.employee_identity_aliases(
    old_employee_no_key,old_employee_no_raw,employee_id,
    employee_no_at_match,full_name_key,hire_date,match_source,
    first_batch_id,first_source_row,last_batch_id,last_source_row,created_by
  )
  select
    candidate.old_employee_no_key,candidate.old_employee_no_raw,
    candidate.employee_id,candidate.employee_no,candidate.full_name_key,
    candidate.hire_date,'legacy_old_id_unique_name_hire_date',
    v_batch_id,candidate.source_row,v_batch_id,candidate.source_row,v_user
  from pg_temp.payroll_import_legacy_candidates candidate
  on conflict(old_employee_no_key) do update
  set old_employee_no_raw=excluded.old_employee_no_raw,
      employee_no_at_match=excluded.employee_no_at_match,
      full_name_key=excluded.full_name_key,
      hire_date=excluded.hire_date,
      last_batch_id=excluded.last_batch_id,
      last_source_row=excluded.last_source_row,
      updated_at=clock_timestamp()
  where payroll_private.employee_identity_aliases.employee_id=excluded.employee_id;

  update pg_temp.payroll_import_rows row
  set employee_id=candidate.employee_id,
      employee_status=candidate.employee_status,
      employee_resign_date=candidate.resign_date,
      departure_date=coalesce(row.departure_date,candidate.resign_date),
      identity_match_state='employee',
      identity_match_source='legacy_old_id_unique_name_hire_date'
  from pg_temp.payroll_import_legacy_candidates candidate
  join payroll_private.employee_identity_aliases alias
    on alias.old_employee_no_key=candidate.old_employee_no_key
   and alias.employee_id=candidate.employee_id
  where row.employee_id is null
    and row.employee_key=candidate.old_employee_no_key
    and row.name_key=candidate.full_name_key
    and row.hire_date=candidate.hire_date;

  -- One latest lifecycle scan classifies all still-unmatched IDs.  It never
  -- fabricates an employees foreign key for a departed historical identity.
  with wanted as (
    select distinct row.employee_key
    from pg_temp.payroll_import_rows row
    where row.employee_id is null and row.employee_key<>''
  ), ranked as (
    select
      internal.payroll_employee_no_key(lifecycle.employee_no) as employee_key,
      lifecycle.event_type,lifecycle.effective_date,
      row_number() over(
        partition by internal.payroll_employee_no_key(lifecycle.employee_no)
        order by coalesce(lifecycle.effective_date,lifecycle.created_at::date) desc,
          case lifecycle.event_type when 'reactivate' then 3
            when 'resign' then 2 when 'join' then 1 else 0 end desc,
          lifecycle.created_at desc,lifecycle.id desc
      ) as lifecycle_rank
    from public.employee_lifecycle_events lifecycle
    join wanted on wanted.employee_key=
      internal.payroll_employee_no_key(lifecycle.employee_no)
    where lifecycle.note is distinct from '__VOIDED__'
      and lifecycle.event_type in ('join','resign','reactivate')
  )
  update pg_temp.payroll_import_rows row
  set departure_date=coalesce(row.departure_date,ranked.effective_date),
      identity_match_state='historical_resigned',
      identity_match_source='employee_lifecycle'
  from ranked
  where ranked.lifecycle_rank=1 and ranked.event_type='resign'
    and row.employee_id is null and row.employee_key=ranked.employee_key;

  update pg_temp.payroll_import_rows row
  set identity_match_state='historical_resigned',
      identity_match_source='uploaded_departure'
  where row.employee_id is null
    and row.identity_match_state='unmatched'
    and row.departure_date is not null;

  perform set_config('payroll.bulk_identity_preclassified','on',true);

  insert into public.payroll_payslips(
    batch_id,period_start,employee_id,employee_no_raw,employee_no_key,full_name,
    platform,source_group,position_name,hire_date,departure_date,
    card_number,payment_name,payment_method,
    base_salary,attendance_salary,leave_deduction,late_deduction,
    absence_deduction,increment_adjustment,attendance_bonus,
    performance_adjustment,deposit_adjustment,overtime_bonus,
    extra_adjustment,next_deduction,overpayment_deduction,other_adjustment,
    total_pay,line_items,remark,source_row,external_record_id,raw_payload,
    identity_match_state,identity_match_source,
    published_to_staff,publish_exclusion_reason
  )
  select
    v_batch_id,v_period,row.employee_id,
    nullif(btrim(row.row_data->>'employee_no'),''),
    nullif(row.employee_key,''),
    coalesce(nullif(btrim(row.row_data->>'full_name'),''),'未填写姓名'),
    nullif(btrim(row.row_data->>'platform'),''),
    nullif(btrim(row.row_data->>'source_group'),''),
    nullif(btrim(row.row_data->>'position_name'),''),
    row.hire_date,row.departure_date,
    nullif(btrim(row.row_data->>'card_number'),''),
    nullif(btrim(row.row_data->>'payment_name'),''),
    nullif(btrim(row.row_data->>'payment_method'),''),
    internal.payroll_number(row.row_data->>'base_salary'),
    internal.payroll_number(row.row_data->>'attendance_salary'),
    internal.payroll_number(row.row_data->>'leave_deduction'),
    internal.payroll_number(row.row_data->>'late_deduction'),
    internal.payroll_number(row.row_data->>'absence_deduction'),
    internal.payroll_number(row.row_data->>'increment_adjustment'),
    internal.payroll_number(row.row_data->>'attendance_bonus'),
    internal.payroll_number(row.row_data->>'performance_adjustment'),
    internal.payroll_number(row.row_data->>'deposit_adjustment'),
    internal.payroll_number(row.row_data->>'overtime_bonus'),
    internal.payroll_number(row.row_data->>'extra_adjustment'),
    internal.payroll_number(row.row_data->>'next_deduction'),
    internal.payroll_number(row.row_data->>'overpayment_deduction'),
    internal.payroll_number(row.row_data->>'other_adjustment'),
    internal.payroll_number(row.row_data->>'total_pay'),
    case when jsonb_typeof(row.row_data->'line_items')='array'
      then row.row_data->'line_items' else '[]'::jsonb end,
    nullif(btrim(row.row_data->>'remark'),''),row.source_row,
    nullif(btrim(row.row_data->>'external_record_id'),''),
    case when jsonb_typeof(row.row_data->'raw_payload')='object'
      then row.row_data->'raw_payload' else '{}'::jsonb end,
    row.identity_match_state,row.identity_match_source,false,null
  from pg_temp.payroll_import_rows row
  order by row.ordinal;

  -- The per-row audit trigger is intentionally skipped above.  Preserve the
  -- same evidence in one bulk insert.
  insert into public.payroll_audit_log(
    batch_id,payslip_id,actor_user_id,action,detail
  )
  select
    v_batch_id,payslip.id,v_user,'identity_alias_confirmed',
    jsonb_build_object(
      'source_row',payslip.source_row,
      'old_employee_no',payslip.employee_no_raw,
      'matched_employee_id',payslip.employee_id,
      'matched_employee_no',employee.employee_no,
      'hire_date',payslip.hire_date,
      'match_source',payslip.identity_match_source
    )
  from public.payroll_payslips payslip
  join public.employees employee on employee.id=payslip.employee_id
  where payslip.batch_id=v_batch_id
    and payslip.identity_match_source='legacy_old_id_unique_name_hire_date';

  perform set_config('payroll.bulk_identity_preclassified','off',true);

  select
    count(*)::integer,
    count(*) filter(where payslip.identity_match_state<>'unmatched')::integer,
    count(*) filter(where payslip.identity_match_state='unmatched')::integer,
    count(*) filter(where
      payslip.identity_match_state='historical_resigned'
      or (payslip.employee_id is not null
        and lower(btrim(employee.status::text))='resigned')
    )::integer,
    count(*) filter(where payslip.identity_match_source=
      'legacy_old_id_unique_name_hire_date')::integer
  into v_row_count,v_matched,v_unmatched,v_resigned,v_legacy_matches
  from public.payroll_payslips payslip
  left join public.employees employee on employee.id=payslip.employee_id
  where payslip.batch_id=v_batch_id;

  update public.payroll_batches batch
  set row_count=v_row_count,matched_count=v_matched,unmatched_count=v_unmatched,
      updated_at=clock_timestamp()
  where batch.id=v_batch_id;

  insert into public.payroll_audit_log(batch_id,actor_user_id,action,detail)
  values(v_batch_id,v_user,'import',jsonb_build_object(
    'rows',v_row_count,'matched',v_matched,'unmatched',v_unmatched,
    'resigned',v_resigned,'legacy_old_id_matched',v_legacy_matches,
    'population_key',v_population,'pay_cycle_key',v_pay_cycle,
    'import_request_key',v_request_key,'bulk',true
  ));

  return jsonb_build_object(
    'batch_id',v_batch_id,'rows',v_row_count,'matched',v_matched,
    'unmatched',v_unmatched,'resigned',v_resigned,
    'legacy_old_id_matched',v_legacy_matches,
    'population_key',v_population,'pay_cycle_key',v_pay_cycle,
    'import_request_key',v_request_key,'idempotent_replay',false
  );
end;
$$;

create or replace function payroll_private.payroll_import_result(p_batch_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'found',true,
    'batch_id',batch.id,
    'status',batch.status,
    'rows',batch.row_count,
    'matched',batch.matched_count,
    'unmatched',batch.unmatched_count,
    'resigned',count(payslip.id) filter(where
      payslip.identity_match_state='historical_resigned'
      or (payslip.employee_id is not null
        and lower(btrim(employee.status::text))='resigned')
    ),
    'legacy_old_id_matched',count(payslip.id) filter(where
      payslip.identity_match_source='legacy_old_id_unique_name_hire_date'),
    'population_key',batch.population_key,
    'pay_cycle_key',batch.pay_cycle_key,
    'import_request_key',batch.import_request_key,
    'import_payload_hash',batch.import_payload_hash
  )
  from public.payroll_batches batch
  left join public.payroll_payslips payslip on payslip.batch_id=batch.id
  left join public.employees employee on employee.id=payslip.employee_id
  where batch.id=p_batch_id
  group by batch.id;
$$;

-- Retain the existing enriched page contract and add the two classification
-- labels.  The request key/hash are deliberately not exposed in list pages.
create or replace function payroll_private.admin_payroll_batch_metadata(
  p_batch_id bigint
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select jsonb_build_object(
    'notes',batch.notes,
    'created_by',batch.created_by,
    'created_by_name',coalesce(
      batch.created_by_name,
      payroll_private.admin_payroll_actor_name(batch.created_by)
    ),
    'updated_by',batch.updated_by,
    'updated_by_name',coalesce(
      batch.updated_by_name,
      payroll_private.admin_payroll_actor_name(batch.updated_by)
    ),
    'updated_at',batch.updated_at,
    'published_by',batch.published_by,
    'published_by_name',coalesce(
      batch.published_by_name,
      payroll_private.admin_payroll_actor_name(batch.published_by)
    ),
    'archived_at',batch.archived_at,
    'archived_by',batch.archived_by,
    'archived_by_name',coalesce(
      batch.archived_by_name,
      payroll_private.admin_payroll_actor_name(batch.archived_by)
    ),
    'archive_reason',batch.archive_reason,
    'voided_at',batch.voided_at,
    'voided_by',batch.voided_by,
    'voided_by_name',coalesce(
      batch.voided_by_name,
      payroll_private.admin_payroll_actor_name(batch.voided_by)
    ),
    'void_reason',batch.void_reason,
    'voided_prior_status',batch.voided_prior_status,
    'correction_of_batch_id',batch.correction_of_batch_id,
    'population_key',batch.population_key,
    'pay_cycle_key',batch.pay_cycle_key,
    'is_voided',batch.voided_at is not null
  )
  from public.payroll_batches batch
  where batch.id=p_batch_id;
$$;

-- Ordinary publication publishes exactly one draft.  It never changes any
-- other batch, including another batch from the same month/stream/currency.
create or replace function payroll_private.admin_payroll_publish(
  p_batch_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_period date;
  v_total integer;
  v_publishable integer;
  v_excluded integer;
  v_resigned integer;
  v_unmatched integer;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not (
    public.has_permission('payroll.publish')
    or public.has_permission('payroll.pending.publish')
  ) then raise exception 'permission_denied'; end if;

  select batch.period_start into v_period
  from public.payroll_batches batch
  where batch.id=p_batch_id and batch.status='draft'
    and batch.voided_at is null
  for update;
  if not found then raise exception 'batch_not_publishable'; end if;

  update public.payroll_payslips payslip
  set published_to_staff=(
        payslip.identity_match_state='employee'
        and payslip.employee_id is not null
        and coalesce(lower(btrim(employee.status::text)),'')
          in ('active','probation')
      ),
      publish_exclusion_reason=case
        when payslip.identity_match_state='unmatched' then 'unmatched'
        when payslip.identity_match_state='historical_resigned'
          or coalesce(lower(btrim(employee.status::text)),'')='resigned'
          then 'resigned'
        when coalesce(lower(btrim(employee.status::text)),'')='suspended'
          then 'suspended'
        when coalesce(lower(btrim(employee.status::text)),'')='inactive'
          then 'inactive'
        when coalesce(lower(btrim(employee.status::text)),'')
          not in ('active','probation') then 'inactive'
        else null
      end,
      updated_at=clock_timestamp()
  from public.employees employee
  where payslip.batch_id=p_batch_id and employee.id=payslip.employee_id;

  update public.payroll_payslips payslip
  set published_to_staff=false,
      publish_exclusion_reason=case
        when payslip.identity_match_state='historical_resigned'
          then 'resigned' else 'unmatched' end,
      updated_at=clock_timestamp()
  where payslip.batch_id=p_batch_id and payslip.employee_id is null;

  select
    count(*)::integer,
    count(*) filter(where payslip.published_to_staff)::integer,
    count(*) filter(where not payslip.published_to_staff)::integer,
    count(*) filter(where payslip.publish_exclusion_reason='resigned')::integer,
    count(*) filter(where payslip.publish_exclusion_reason='unmatched')::integer
  into v_total,v_publishable,v_excluded,v_resigned,v_unmatched
  from public.payroll_payslips payslip
  where payslip.batch_id=p_batch_id;

  if coalesce(v_total,0)=0 then raise exception 'empty_batch'; end if;
  if coalesce(v_publishable,0)=0 then
    raise exception 'no_publishable_payslips';
  end if;

  update public.payroll_batches batch
  set status='published',published_by=v_user,
      published_at=clock_timestamp(),updated_at=clock_timestamp(),
      archived_at=null,archived_by=null,archived_by_name=null,
      archive_reason=null
  where batch.id=p_batch_id;

  insert into public.payroll_audit_log(
    batch_id,actor_user_id,action,detail
  ) values(
    p_batch_id,v_user,'publish',jsonb_build_object(
      'rows',v_publishable,'excluded_rows',v_excluded,
      'resigned',v_resigned,'unmatched',v_unmatched,
      'period_start',v_period,'replacement_mode','none',
      'coexists_with_other_published',true
    )
  );

  return jsonb_build_object(
    'batch_id',p_batch_id,'status','published','rows',v_publishable,
    'excluded_rows',v_excluded,'resigned',v_resigned,
    'unmatched',v_unmatched,'replacement_mode','none'
  );
end;
$$;

-- Import retries are serialized by request key.  A replay is accepted only
-- for the same actor and byte-equivalent canonical JSON payload.
create or replace function public.admin_payroll_import(
  p_batch jsonb,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid := auth.uid();
  v_actor_name text;
  v_request_key text;
  v_payload_hash text;
  v_safe_batch jsonb;
  v_existing public.payroll_batches%rowtype;
  v_result jsonb;
  v_batch_id bigint;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('payroll.import_history.edit') then
    raise exception 'permission_denied';
  end if;
  if not payroll_private.admin_payroll_has_full_scope() then
    raise exception 'payroll_all_scope_required';
  end if;
  if jsonb_typeof(p_batch) is distinct from 'object' then
    raise exception 'invalid_batch';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'invalid_rows';
  end if;
  if nullif(btrim(coalesce(p_batch->>'id','')),'') is not null then
    raise exception 'import_batch_id_not_allowed';
  end if;
  if nullif(btrim(coalesce(p_batch->>'population_key','')),'') is not null
     and lower(btrim(p_batch->>'population_key')) not in (
       'onsite_to_home','onsite-to-home','onsite',
       'pure_remote','pure-remote','remote','home'
     ) then
    raise exception 'invalid_payroll_population_key';
  end if;
  if nullif(btrim(coalesce(p_batch->>'pay_cycle_key','')),'') is not null
     and lower(btrim(p_batch->>'pay_cycle_key')) not in (
       'first_half','first-half','1-15',
       'second_half','second-half','16-end',
       'monthly','full_month','full-month'
     ) then
    raise exception 'invalid_payroll_cycle_key';
  end if;

  v_safe_batch:=jsonb_build_object(
    'period_start',p_batch->'period_start',
    'title',p_batch->'title',
    'currency',p_batch->'currency',
    'source_type','upload',
    'source_file_name',p_batch->'source_file_name',
    'source_project_ref',p_batch->'source_project_ref',
    'source_batch_key',p_batch->'source_batch_key',
    'notes',p_batch->'notes',
    'population_key',p_batch->'population_key',
    'pay_cycle_key',p_batch->'pay_cycle_key'
  );
  v_payload_hash:=md5(
    (v_safe_batch::text)||'|'||p_rows::text
  );
  v_request_key:=lower(btrim(coalesce(p_batch->>'import_request_key','')));
  if v_request_key='' then
    v_request_key:=substr(md5(v_user::text||'|'||v_payload_hash),1,8)||'-'||
      substr(md5(v_user::text||'|'||v_payload_hash),9,4)||'-5'||
      substr(md5(v_user::text||'|'||v_payload_hash),14,3)||'-a'||
      substr(md5(v_user::text||'|'||v_payload_hash),18,3)||'-'||
      substr(md5(v_user::text||'|'||v_payload_hash),21,12);
  elsif v_request_key !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'invalid_import_request_key'; end if;
  v_safe_batch:=v_safe_batch||jsonb_build_object(
    'import_request_key',v_request_key
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-import|'||v_request_key,0)
  );

  select * into v_existing
  from public.payroll_batches batch
  where batch.import_request_key=v_request_key
  for update;
  if found then
    if v_existing.created_by is distinct from v_user then
      raise exception 'import_request_key_conflict';
    end if;
    if v_existing.import_payload_hash is distinct from v_payload_hash then
      raise exception 'import_request_payload_mismatch';
    end if;
    return coalesce(
      payroll_private.payroll_import_result(v_existing.id),
      jsonb_build_object('found',false)
    )||jsonb_build_object('idempotent_replay',true);
  end if;

  -- Call the new bulk implementation directly.  The legacy granular wrapper
  -- is retained for compatibility with correction code, but must not obscure
  -- which implementation handles this latency-sensitive path.
  v_result:=payroll_private.admin_payroll_import(v_safe_batch,p_rows);
  v_batch_id:=nullif(v_result->>'batch_id','')::bigint;
  v_actor_name:=payroll_private.admin_payroll_actor_name(v_user);

  update public.payroll_batches batch
  set created_by_name=coalesce(batch.created_by_name,v_actor_name),
      updated_by=v_user,updated_by_name=v_actor_name,
      updated_at=clock_timestamp()
  where batch.id=v_batch_id;

  update public.payroll_audit_log audit
  set detail=audit.detail||jsonb_build_object('actor_name',v_actor_name)
  where audit.id=(
    select log.id from public.payroll_audit_log log
    where log.batch_id=v_batch_id and log.actor_user_id=v_user
      and log.action='import'
    order by log.created_at desc,log.id desc limit 1
  );

  return coalesce(
    payroll_private.payroll_import_result(v_batch_id),v_result
  )||jsonb_build_object('idempotent_replay',false);
end;
$$;

create or replace function public.admin_payroll_import_status(
  p_import_request_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_user uuid:=auth.uid();
  v_request_key text:=lower(btrim(coalesce(p_import_request_key,'')));
  v_batch_id bigint;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('payroll.import_history.edit') then
    raise exception 'permission_denied';
  end if;
  if not payroll_private.admin_payroll_has_full_scope() then
    raise exception 'payroll_all_scope_required';
  end if;
  if v_request_key !~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then raise exception 'invalid_import_request_key'; end if;

  select batch.id into v_batch_id
  from public.payroll_batches batch
  where batch.import_request_key=v_request_key
    and batch.created_by=v_user;
  if not found then return jsonb_build_object('found',false); end if;
  return coalesce(
    payroll_private.payroll_import_result(v_batch_id),
    jsonb_build_object('found',false)
  )||jsonb_build_object('idempotent_replay',true);
end;
$$;

create or replace function public.admin_payroll_publish(p_batch_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=auth.uid();
  v_actor_name text;
  v_result jsonb;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('payroll.pending.publish') then
    raise exception 'permission_denied';
  end if;
  if not payroll_private.admin_payroll_has_full_scope() then
    raise exception 'payroll_all_scope_required';
  end if;
  perform 1 from public.payroll_batches batch
  where batch.id=p_batch_id and batch.status='draft'
    and batch.voided_at is null
  for update;
  if not found then raise exception 'batch_not_publishable'; end if;

  v_result:=payroll_private.admin_payroll_publish(p_batch_id);
  v_actor_name:=payroll_private.admin_payroll_actor_name(v_user);
  update public.payroll_batches batch
  set updated_by=v_user,updated_by_name=v_actor_name,
      published_by_name=v_actor_name,updated_at=clock_timestamp()
  where batch.id=p_batch_id;
  update public.payroll_audit_log audit
  set detail=audit.detail||jsonb_build_object('actor_name',v_actor_name)
  where audit.id=(
    select log.id from public.payroll_audit_log log
    where log.batch_id=p_batch_id and log.actor_user_id=v_user
      and log.action='publish'
    order by log.created_at desc,log.id desc limit 1
  );
  return v_result||jsonb_build_object(
    'replacement_mode','none','archived_batch_ids','[]'::jsonb
  );
end;
$$;

-- Replacement is an explicit correction action.  It can archive only the one
-- published source recorded by correction_of_batch_id; it cannot sweep a
-- month, population, cycle or currency.
create or replace function public.admin_payroll_publish_replacement(
  p_batch_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=auth.uid();
  v_actor_name text;
  v_source_id bigint;
  v_target public.payroll_batches%rowtype;
  v_source public.payroll_batches%rowtype;
  v_result jsonb;
  v_now timestamptz:=clock_timestamp();
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('payroll.pending.publish') then
    raise exception 'permission_denied';
  end if;
  if not payroll_private.admin_payroll_has_full_scope() then
    raise exception 'payroll_all_scope_required';
  end if;

  select batch.correction_of_batch_id into v_source_id
  from public.payroll_batches batch
  where batch.id=p_batch_id;
  if not found then raise exception 'batch_not_found'; end if;
  if v_source_id is null then
    raise exception 'replacement_requires_correction_source';
  end if;

  -- Deterministic lock ordering prevents two cross-replacement attempts from
  -- deadlocking.  Re-read both rows only after the locks are held.
  perform 1
  from public.payroll_batches batch
  where batch.id in (p_batch_id,v_source_id)
  order by batch.id
  for update;
  select * into v_target from public.payroll_batches batch
  where batch.id=p_batch_id;
  select * into v_source from public.payroll_batches batch
  where batch.id=v_source_id;

  if v_target.status<>'draft' or v_target.voided_at is not null
     or v_target.correction_of_batch_id is distinct from v_source_id then
    raise exception 'batch_not_publishable';
  end if;
  if v_source.id is null or v_source.status<>'published'
     or v_source.voided_at is not null then
    raise exception 'replacement_source_not_published';
  end if;

  v_result:=payroll_private.admin_payroll_publish(p_batch_id);
  v_actor_name:=payroll_private.admin_payroll_actor_name(v_user);

  update public.payroll_batches batch
  set status='archived',archived_at=v_now,archived_by=v_user,
      archived_by_name=v_actor_name,
      archive_reason=format(
        '批次 #%s 经明确操作替换纠正来源批次 #%s',p_batch_id,v_source_id
      ),
      updated_by=v_user,updated_by_name=v_actor_name,updated_at=v_now
  where batch.id=v_source_id and batch.status='published'
    and batch.voided_at is null;
  if not found then raise exception 'replacement_source_changed'; end if;

  update public.payroll_batches batch
  set updated_by=v_user,updated_by_name=v_actor_name,
      published_by_name=v_actor_name,updated_at=clock_timestamp()
  where batch.id=p_batch_id;

  insert into public.payroll_audit_log(
    batch_id,actor_user_id,action,detail
  ) values(
    v_source_id,v_user,'explicit_replace',jsonb_build_object(
      'actor_name',v_actor_name,'replacement_batch_id',p_batch_id,
      'source_batch_id',v_source_id,'explicit',true,
      'reason',format('批次 #%s 经用户明确操作替换',p_batch_id)
    )
  );
  update public.payroll_audit_log audit
  set detail=audit.detail||jsonb_build_object(
    'actor_name',v_actor_name,'replacement_mode','explicit',
    'replaced_batch_id',v_source_id
  )
  where audit.id=(
    select log.id from public.payroll_audit_log log
    where log.batch_id=p_batch_id and log.actor_user_id=v_user
      and log.action='publish'
    order by log.created_at desc,log.id desc limit 1
  );

  return v_result||jsonb_build_object(
    'replacement_mode','explicit','replaced_batch_id',v_source_id,
    'archived_batch_ids',jsonb_build_array(v_source_id)
  );
end;
$$;

-- A recoverably deleted published document may coexist with all other
-- published documents when restored.  Restore no longer has a same-month
-- conflict because publication itself is intentionally non-exclusive.
create or replace function public.admin_payroll_restore_batch(
  p_batch_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user uuid:=auth.uid();
  v_actor_name text;
  v_batch public.payroll_batches%rowtype;
  v_restore_status text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.is_founder()
    or public.has_permission('payroll.import_history.delete')
  ) then raise exception 'permission_denied'; end if;
  if not payroll_private.admin_payroll_has_full_scope() then
    raise exception 'payroll_all_scope_required';
  end if;

  select * into v_batch
  from public.payroll_batches batch
  where batch.id=p_batch_id
  for update;
  if not found then raise exception 'batch_not_found'; end if;
  if v_batch.voided_at is null then raise exception 'batch_not_deleted'; end if;
  v_restore_status:=case
    when v_batch.voided_prior_status in ('draft','published','archived')
      then v_batch.voided_prior_status
    else 'archived'
  end;
  v_actor_name:=payroll_private.admin_payroll_actor_name(v_user);

  update public.payroll_batches batch
  set status=v_restore_status,
      archived_at=case when v_restore_status='archived'
        then batch.archived_at else null end,
      archived_by=case when v_restore_status='archived'
        then batch.archived_by else null end,
      archived_by_name=case when v_restore_status='archived'
        then batch.archived_by_name else null end,
      archive_reason=case when v_restore_status='archived'
        then batch.archive_reason else null end,
      voided_at=null,voided_by=null,voided_by_name=null,
      void_reason=null,voided_prior_status=null,
      updated_by=v_user,updated_by_name=v_actor_name,
      updated_at=clock_timestamp()
  where batch.id=p_batch_id;

  insert into public.payroll_audit_log(
    batch_id,actor_user_id,action,detail
  ) values(
    p_batch_id,v_user,'restore_deleted_import_record',jsonb_build_object(
      'actor_name',v_actor_name,'restored_status',v_restore_status,
      'previous_delete_reason',v_batch.void_reason,
      'deleted_by_name',v_batch.voided_by_name,
      'deleted_at',v_batch.voided_at,'published_coexistence',true
    )
  );
  return jsonb_build_object(
    'batch_id',p_batch_id,'restored',true,'status',v_restore_status,
    'updated_by_name',v_actor_name
  );
end;
$$;

revoke all on function payroll_private.payroll_population_key(text,text),
  payroll_private.payroll_cycle_key(text,text),
  payroll_private.payroll_import_strict_date(text,text,integer),
  payroll_private.payroll_inherit_correction_stream(),
  payroll_private.admin_payroll_import(jsonb,jsonb),
  payroll_private.payroll_import_result(bigint),
  payroll_private.admin_payroll_batch_metadata(bigint),
  payroll_private.admin_payroll_publish(bigint)
  from public,anon,authenticated,service_role;

revoke all on function public.admin_payroll_import(jsonb,jsonb),
  public.admin_payroll_import_status(text),
  public.admin_payroll_publish(bigint),
  public.admin_payroll_publish_replacement(bigint),
  public.admin_payroll_restore_batch(bigint)
  from public,anon,authenticated;
grant execute on function public.admin_payroll_import(jsonb,jsonb),
  public.admin_payroll_import_status(text),
  public.admin_payroll_publish(bigint),
  public.admin_payroll_publish_replacement(bigint),
  public.admin_payroll_restore_batch(bigint)
  to authenticated,service_role;

comment on function public.admin_payroll_import(jsonb,jsonb) is
  'Set-based payroll import. Request-key retries are actor-owned, payload-checked and idempotent; all authorization checks precede mutation.';
comment on function public.admin_payroll_import_status(text) is
  'Returns only the current actor own committed import attempt, for safe recovery after an ambiguous client/network timeout.';
comment on function public.admin_payroll_publish(bigint) is
  'Publishes one draft without archiving any other batch. All uploaded published batches coexist.';
comment on function public.admin_payroll_publish_replacement(bigint) is
  'Explicitly publishes a correction draft and archives only its correction_of_batch_id source.';
comment on function public.admin_payroll_restore_batch(bigint) is
  'Restores a recoverably deleted import to its prior status; published imports coexist instead of conflicting by month.';

notify pgrst,'reload schema';

commit;
