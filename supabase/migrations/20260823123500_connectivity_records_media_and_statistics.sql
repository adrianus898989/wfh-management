-- Keep connectivity incidents in this project only. Evidence is stored in a
-- private Storage bucket and read through short-lived signed URLs.

alter table public.employee_connectivity_incidents
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table public.employee_connectivity_incidents
  drop constraint if exists employee_connectivity_attachments_check;
alter table public.employee_connectivity_incidents
  add constraint employee_connectivity_attachments_check
  check (
    case when jsonb_typeof(attachments) = 'array'
      then jsonb_array_length(attachments) <= 3
      else false
    end
  );

alter table public.employee_connectivity_incidents
  alter column started_at set not null,
  alter column ended_at set not null;

alter table public.employee_connectivity_incidents
  drop constraint if exists employee_connectivity_incident_type_check;
alter table public.employee_connectivity_incidents
  add constraint employee_connectivity_incident_type_check
  check (incident_type in ('power_outage','internet_outage'));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'connectivity-evidence',
  'connectivity-evidence',
  false,
  52428800,
  array[
    'image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
    'video/mp4','video/quicktime','video/webm'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists connectivity_evidence_admin_read on storage.objects;
create policy connectivity_evidence_admin_read
  on storage.objects for select to authenticated
  using (
    bucket_id = 'connectivity-evidence'
    and public.has_permission('employee.view')
  );

drop policy if exists connectivity_evidence_admin_insert on storage.objects;
create policy connectivity_evidence_admin_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'connectivity-evidence'
    and public.has_permission('employee.edit')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists connectivity_evidence_admin_delete on storage.objects;
create policy connectivity_evidence_admin_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'connectivity-evidence'
    and public.has_permission('employee.edit')
  );

create or replace function employee_ops_private.admin_connectivity_home(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1);
  v_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size','')::integer,30),1),100);
  v_q text := lower(btrim(coalesce(p_filters->>'q','')));
  v_type text := btrim(coalesce(p_filters->>'incident_type',''));
  v_status text := btrim(coalesce(p_filters->>'status',''));
  v_country text := btrim(coalesce(p_filters->>'country',''));
  v_from date := nullif(p_filters->>'date_from','')::date;
  v_to date := nullif(p_filters->>'date_to','')::date;
  v_result jsonb;
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if v_from is not null and v_to is not null and v_from > v_to then
    select v_to,v_from into v_from,v_to;
  end if;

  with filtered as materialized (
    select
      c.id,c.employee_id,c.incident_date,c.incident_type,c.started_at,c.ended_at,
      c.duration_minutes,c.details,c.evidence_url,c.attachments,c.status,c.created_at,
      e.employee_no,e.full_name,e.hire_date,e.status employee_status,
      coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写') employee_country,
      t.name team_name,p.name position_name,coalesce(u.email,u.id::text) recorded_by_name
    from public.employee_connectivity_incidents c
    join public.employees e on e.id = c.employee_id
    left join public.teams t on t.id = e.team_id
    left join public.positions p on p.id = e.position_id
    left join auth.users u on u.id = c.recorded_by
    where (v_q = '' or lower(e.employee_no) like '%'||v_q||'%' or lower(e.full_name) like '%'||v_q||'%')
      and (v_type = '' or c.incident_type = v_type)
      and (v_status = '' or c.status = v_status)
      and (v_country = '' or lower(coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写')) = lower(v_country))
      and (v_from is null or c.incident_date >= v_from)
      and (v_to is null or c.incident_date <= v_to)
  ), country_daily as (
    select incident_date,employee_country,count(distinct employee_id)::integer employees
    from filtered
    group by incident_date,employee_country
  ), daily as (
    select
      f.incident_date,
      count(*)::integer total_records,
      count(distinct f.employee_id)::integer affected_employees,
      count(*) filter(where f.incident_type = 'power_outage')::integer power,
      count(*) filter(where f.incident_type = 'internet_outage')::integer internet,
      coalesce((
        select jsonb_agg(jsonb_build_object('name',d.employee_country,'employees',d.employees) order by d.employees desc,d.employee_country)
        from country_daily d where d.incident_date = f.incident_date
      ),'[]'::jsonb) countries
    from filtered f
    group by f.incident_date
  ), paged as (
    select * from filtered
    order by incident_date desc,id desc
    limit v_size offset (v_page-1)*v_size
  )
  select jsonb_build_object(
    'permissions',jsonb_build_object('create',public.has_permission('employee.edit')),
    'page',v_page,
    'page_size',v_size,
    'total',(select count(*) from filtered),
    'pages',greatest(1,ceil((select count(*) from filtered)::numeric/v_size)::integer),
    'summary',jsonb_build_object(
      'total',(select count(*) from filtered),
      'affected_employees',(select count(distinct employee_id) from filtered),
      'power',(select count(*) from filtered where incident_type = 'power_outage'),
      'internet',(select count(*) from filtered where incident_type = 'internet_outage')
    ),
    'country_options',coalesce((
      select jsonb_agg(x.employee_country order by x.employee_country)
      from (
        select distinct coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写') employee_country
        from public.employees e where e.status = 'active'
      ) x
    ),'[]'::jsonb),
    'daily_stats',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc)
      from (select * from daily order by incident_date desc limit 31) x
    ),'[]'::jsonb),
    'rows',coalesce((select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc) from paged x),'[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function employee_ops_private.admin_connectivity_create(p_record jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text := regexp_replace(upper(coalesce(btrim(p_record->>'employee_no'),'')),'[^A-Z0-9]','','g');
  v_date date := nullif(p_record->>'incident_date','')::date;
  v_type text := coalesce(nullif(btrim(p_record->>'incident_type'),''),'internet_outage');
  v_start time := nullif(p_record->>'started_at','')::time;
  v_end time := nullif(p_record->>'ended_at','')::time;
  v_start_ts timestamp;
  v_end_ts timestamp;
  v_duration integer;
  v_attachments jsonb := coalesce(p_record->'attachments','[]'::jsonb);
  v_id bigint;
  v_full_name text;
  v_hire_date date;
  v_country text;
begin
  if v_user is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.edit') then raise exception 'permission_denied'; end if;
  if v_employee_no = '' then raise exception 'employee_id_required'; end if;
  if v_date is null or v_start is null or v_end is null then raise exception 'incident_time_required'; end if;
  if v_type not in ('power_outage','internet_outage') then raise exception 'invalid_incident_type'; end if;
  if jsonb_typeof(v_attachments) <> 'array' or jsonb_array_length(v_attachments) > 3 then raise exception 'invalid_attachments'; end if;
  if exists(
    select 1 from jsonb_array_elements(v_attachments) a
    where btrim(coalesce(a->>'path','')) = ''
      or split_part(a->>'path','/',1) <> v_user::text
      or not (coalesce(a->>'mime','') like 'image/%' or coalesce(a->>'mime','') like 'video/%')
  ) then raise exception 'invalid_attachments'; end if;

  select e.id,e.full_name,e.hire_date,
    coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),''),'未填写')
  into v_employee_id,v_full_name,v_hire_date,v_country
  from public.employees e
  where regexp_replace(upper(e.employee_no),'[^A-Z0-9]','','g') = v_employee_no
  order by case when e.status = 'active' then 0 else 1 end,e.updated_at desc
  limit 1;
  if v_employee_id is null then raise exception 'employee_not_found'; end if;

  v_start_ts := v_date + v_start;
  v_end_ts := v_date + v_end;
  if v_end_ts < v_start_ts then v_end_ts := v_end_ts + interval '1 day'; end if;
  v_duration := ceil(extract(epoch from (v_end_ts-v_start_ts))/60.0)::integer;

  insert into public.employee_connectivity_incidents(
    employee_id,incident_date,incident_type,started_at,ended_at,duration_minutes,
    work_impact,details,evidence_url,attachments,status,recorded_by
  ) values (
    v_employee_id,v_date,v_type,v_start,v_end,v_duration,
    'absent',nullif(btrim(p_record->>'details'),''),null,v_attachments,'reported',v_user
  ) returning id into v_id;

  return jsonb_build_object(
    'id',v_id,
    'employee_id',v_employee_id,
    'employee_no',v_employee_no,
    'full_name',v_full_name,
    'hire_date',v_hire_date,
    'employee_country',v_country,
    'duration_minutes',v_duration
  );
end;
$$;

create or replace function employee_ops_private.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'not_authenticated'; end if;
  if not public.has_permission('employee.view') then raise exception 'permission_denied'; end if;
  if not exists(select 1 from public.employees e where e.id = p_employee_id) then raise exception 'employee_not_found'; end if;
  return jsonb_build_object(
    'total',(select count(*) from public.employee_connectivity_incidents c where c.employee_id = p_employee_id),
    'rows',coalesce((
      select jsonb_agg(to_jsonb(x) order by x.incident_date desc,x.id desc)
      from (
        select c.id,c.incident_date,c.incident_type,c.started_at,c.ended_at,c.duration_minutes,
          c.details,c.evidence_url,c.attachments,c.status,c.created_at,coalesce(u.email,u.id::text) recorded_by_name
        from public.employee_connectivity_incidents c
        left join auth.users u on u.id = c.recorded_by
        where c.employee_id = p_employee_id
        order by c.incident_date desc,c.id desc
        limit 300
      ) x
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function employee_ops_private.admin_connectivity_home(jsonb) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_connectivity_create(jsonb) from public,anon,authenticated;
revoke all on function employee_ops_private.admin_employee_connectivity_history(uuid) from public,anon,authenticated;
grant execute on function employee_ops_private.admin_connectivity_home(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_connectivity_create(jsonb) to authenticated;
grant execute on function employee_ops_private.admin_employee_connectivity_history(uuid) to authenticated;

