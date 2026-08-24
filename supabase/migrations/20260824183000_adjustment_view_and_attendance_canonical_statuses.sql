-- Separate adjustment-read permission from attendance-read permission and
-- canonicalize attendance reads to the six supported exceptional statuses.

insert into public.permissions(code,name,category,sensitive)
values ('adjustment.view','查看出错 / 扣款 / 奖金','adjustment',false)
on conflict(code) do update set
  name=excluded.name,
  category=excluded.category,
  sensitive=excluded.sensitive;

-- Preserve access for roles that already had an adjustment mutation right.
-- Roles that only had attendance.view do not inherit financial-record access.
insert into public.role_permissions(role_id,permission_id)
select distinct rp.role_id,target.id
from public.role_permissions rp
join public.permissions source_permission on source_permission.id=rp.permission_id
  and source_permission.code in ('adjustment.create','adjustment.approve')
join public.permissions target on target.code='adjustment.view'
on conflict do nothing;


create or replace function attendance_private.admin_attendance_home(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_scope text := lower(btrim(coalesce(p_filters->>'scope', 'attendance')));
  v_search text := lower(btrim(coalesce(p_filters->>'search', '')));
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no', '')));
  v_full_name text := lower(btrim(coalesce(p_filters->>'full_name', p_filters->>'employee_name', '')));
  v_date_from date := nullif(p_filters->>'date_from', '')::date;
  v_date_to date := nullif(p_filters->>'date_to', '')::date;
  v_source_month text := btrim(coalesce(p_filters->>'source_month', ''));
  v_source_group text := btrim(coalesce(p_filters->>'source_group', ''));
  v_source_key text := btrim(coalesce(p_filters->>'source_key', p_filters->>'source', ''));
  v_event_kind text := btrim(coalesce(p_filters->>'event_kind', ''));
  v_employee_status text := btrim(coalesce(p_filters->>'employee_status', p_filters->>'status', ''));
  v_employment_type text := btrim(coalesce(p_filters->>'employment_type', p_filters->>'employee_type', ''));
  v_team text := btrim(coalesce(p_filters->>'team', ''));
  v_position text := btrim(coalesce(p_filters->>'position', ''));
  v_country text := btrim(coalesce(p_filters->>'country', ''));
  v_platform text := btrim(coalesce(p_filters->>'platform', ''));
  v_manager text := btrim(coalesce(p_filters->>'manager', p_filters->>'responsible', ''));
  v_match_status text := btrim(coalesce(p_filters->>'match_status', ''));
  v_currency text := upper(btrim(coalesce(p_filters->>'currency', '')));
  v_include_mirrors boolean := lower(btrim(coalesce(p_filters->>'include_mirrors', 'false'))) in ('true','1','yes');
  v_page integer := least(greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1),1000000);
  v_page_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size','')::integer,30),1),100);
  v_access_scope text;
  v_current_employee uuid;
  v_current_employee_no text;
  v_current_team uuid;
  v_current_team_name text;
  v_all boolean := false;
  v_result jsonb;
  v_swap_date date;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if v_scope not in ('attendance','adjustment') then raise exception 'invalid_scope'; end if;
  if v_scope='attendance' and not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;
  if v_scope='adjustment' and not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;
  if v_currency <> '' and v_currency not in ('USD','PHP') then raise exception 'invalid_currency'; end if;
  if v_date_from is not null and v_date_to is not null and v_date_from > v_date_to then
    v_swap_date:=v_date_from; v_date_from:=v_date_to; v_date_to:=v_swap_date;
  end if;

  select ua.data_scope,ua.employee_id,e.employee_no,e.team_id,t.name
  into v_access_scope,v_current_employee,v_current_employee_no,v_current_team,v_current_team_name
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  left join public.teams t on t.id=e.team_id
  where ua.auth_user_id=v_user_id and ua.active=true and ua.backend_enabled=true
  order by ua.updated_at desc limit 1;
  v_all := public.is_founder() or v_access_scope='all';

  with base as materialized (
    -- Put selective predicates in the first query against the security-barrier
    -- view. This lets Postgres use the kind/date indexes before enrichment.
    select x.*
    from attendance_private.attendance_enriched_records x
    left join public.employees scope_employee on scope_employee.id=x.employee_id
    where ((v_scope='adjustment' and x.kind='adjustment')
        or (v_scope='attendance' and x.kind in ('attendance','resignation')
          and (
            x.kind='resignation'
            or lower(coalesce(x.event_kind,'')) in (
              'public_holiday','home_leave','leave','half_day','absence','absent','resignation'
            )
          )))
      and (v_include_mirrors or not x.is_mirror)
      and (v_date_from is null or x.event_date>=v_date_from)
      and (v_date_to is null or x.event_date<=v_date_to)
      and (v_source_month='' or x.source_month=v_source_month)
      and (v_source_group='' or public.exam_norm(x.source_group)=public.exam_norm(v_source_group))
      and (v_source_key='' or x.source_key=v_source_key)
      and (
        v_all
        or x.employee_id=v_current_employee
        or (x.employee_id is null and v_current_employee_no is not null
          and upper(btrim(x.employee_no))=upper(btrim(v_current_employee_no)))
        or (v_access_scope='own_team' and (
          scope_employee.team_id=v_current_team
          or (scope_employee.id is null and public.exam_norm(x.team_name)=public.exam_norm(v_current_team_name))
        ))
        or (v_access_scope='assigned_teams' and (
          exists(select 1 from public.user_scope_employees se
            where se.auth_user_id=v_user_id and se.employee_id=x.employee_id)
          or exists(select 1 from public.user_scope_teams st
            where st.auth_user_id=v_user_id and st.team_id=scope_employee.team_id)
          or exists(select 1 from public.user_scope_teams st
            join public.teams stt on stt.id=st.team_id
            where st.auth_user_id=v_user_id
              and public.exam_norm(stt.name)=public.exam_norm(x.team_name))
        ))
      )
  ), filtered as materialized (
    select x.*,
      case when lower(coalesce(x.event_kind,''))='absent' then 'absence'
        else lower(coalesce(x.event_kind,'')) end normalized_event_kind
    from base x
    where (v_search='' or lower(concat_ws(' ',x.employee_no,x.full_name,x.employee_no_raw,
      x.employee_name_raw,x.reason,x.note,x.event_kind,x.hire_date,x.employment_type,
      x.employee_status,x.team_name,x.position_name,x.country,x.platform,x.manager)) like '%'||v_search||'%')
      and (v_employee_no='' or lower(coalesce(x.employee_no,x.employee_no_raw,'')) like '%'||v_employee_no||'%')
      and (v_full_name='' or lower(coalesce(x.full_name,x.employee_name_raw,'')) like '%'||v_full_name||'%')
      and (v_event_kind='' or
        case when lower(coalesce(x.event_kind,''))='absent' then 'absence'
          else lower(coalesce(x.event_kind,'')) end =
        case when lower(v_event_kind)='absent' then 'absence' else lower(v_event_kind) end)
      and (v_employment_type='' or public.exam_norm(x.employment_type)=public.exam_norm(v_employment_type))
      and (v_employee_status='' or
        (v_employee_status='unmatched' and x.needs_review) or
        (v_employee_status<>'unmatched' and lower(coalesce(x.employee_status,''))=lower(v_employee_status)))
      and (v_team='' or public.exam_norm(x.team_name)=public.exam_norm(v_team))
      and (v_position='' or public.exam_norm(x.position_name)=public.exam_norm(v_position))
      and (v_country='' or public.exam_norm(x.country)=public.exam_norm(v_country))
      and (v_platform='' or public.exam_norm(x.platform)=public.exam_norm(v_platform))
      and (v_manager='' or lower(coalesce(x.manager,'')) like '%'||lower(v_manager)||'%')
      and (v_match_status='' or (v_match_status='unmatched' and x.needs_review)
        or x.effective_match_status=v_match_status)
      and (v_currency='' or x.currency=v_currency)
  ), currency_stats as materialized (
    select f.currency,
      count(*) filter(where f.event_kind='bonus' or (f.event_kind not in ('bonus','deduction') and f.amount>0)) bonus_count,
      coalesce(sum(f.amount) filter(where f.amount>0),0) bonus_total,
      count(*) filter(where f.event_kind='deduction' or (f.event_kind not in ('bonus','deduction') and f.amount<0)) deduction_count,
      abs(coalesce(sum(f.amount) filter(where f.amount<0),0)) deduction_total,
      coalesce(sum(f.amount),0) net_amount,
      count(*) filter(where f.amount is null) incomplete
    from filtered f where f.scope='adjustment' and f.currency is not null group by f.currency
  ), paged as materialized (
    select f.* from filtered f
    order by f.event_date desc nulls last,f.hire_date asc nulls last,f.employee_no,f.id desc
    limit v_page_size offset ((v_page::bigint-1)*v_page_size)
  )
  select jsonb_build_object(
    'scope',v_scope,'page',v_page,'page_size',v_page_size,
    'total',(select count(*) from filtered),
    'pages',greatest(1,ceil((select count(*) from filtered)::numeric/v_page_size)::integer),
    'summary',case when v_scope='adjustment' then (
      select jsonb_build_object(
        'total',count(*),'matched',count(*) filter(where not f.needs_review),
        'unmatched',count(*) filter(where f.needs_review),
        'employees',count(distinct coalesce(f.employee_id::text,'history:'||f.historical_employee_no)),
        'bonus_count',count(*) filter(where f.event_kind='bonus' or (f.event_kind not in ('bonus','deduction') and f.amount>0)),
        'deduction_count',count(*) filter(where f.event_kind='deduction' or (f.event_kind not in ('bonus','deduction') and f.amount<0)),
        'incomplete',count(*) filter(where f.amount is null),
        'currency_review_count',count(*) filter(where f.currency is null),
        'mixed_currency',(select count(*) from currency_stats)>1,
        'currency',case when (select count(*) from currency_stats)=1 then (select min(currency) from currency_stats) end,
        'bonus_total',case when (select count(*) from currency_stats)=1 then (select min(bonus_total) from currency_stats) end,
        'deduction_total',case when (select count(*) from currency_stats)=1 then (select min(deduction_total) from currency_stats) end,
        'net_amount',case when (select count(*) from currency_stats)=1 then (select min(net_amount) from currency_stats) end,
        'currencies',coalesce((select jsonb_object_agg(cs.currency,jsonb_build_object(
          'bonus_count',cs.bonus_count,'bonus_total',cs.bonus_total,
          'deduction_count',cs.deduction_count,'deduction_total',cs.deduction_total,
          'net_amount',cs.net_amount,'incomplete',cs.incomplete)) from currency_stats cs),'{}'::jsonb),
        'money_totals_scope','all_filtered_rows') from filtered f
    ) else (
      select jsonb_build_object('total',count(*),'matched',count(*) filter(where not f.needs_review),
        'unmatched',count(*) filter(where f.needs_review),
        'employees',count(distinct coalesce(f.employee_id::text,'history:'||f.historical_employee_no)),
        'public_holiday',count(*) filter(where f.normalized_event_kind='public_holiday'),
        'home_leave',count(*) filter(where f.normalized_event_kind='home_leave'),
        'leave',count(*) filter(where f.normalized_event_kind='leave'),
        'half_day',count(*) filter(where f.normalized_event_kind='half_day'),
        'absence',count(*) filter(where f.normalized_event_kind='absence'),
        'resignation',count(*) filter(where f.kind='resignation' or f.normalized_event_kind='resignation')) from filtered f
    ) end,
    'options',jsonb_build_object(
      'source_months',(select coalesce(jsonb_agg(v order by v desc),'[]'::jsonb) from (select distinct source_month v from base where nullif(source_month,'') is not null)o),
      'source_groups',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct source_group v from base where nullif(source_group,'') is not null)o),
      'event_kinds',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (
        select distinct case when lower(event_kind)='absent' then 'absence' else lower(event_kind) end v
        from base where nullif(event_kind,'') is not null)o),
      'employee_statuses',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct employee_status v from base where nullif(employee_status,'') is not null)o),
      'employment_types',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct employment_type v from base where nullif(employment_type,'') is not null)o),
      'teams',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct team_name v from base where nullif(team_name,'') is not null)o),
      'positions',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct position_name v from base where nullif(position_name,'') is not null)o),
      'countries',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct country v from base where nullif(country,'') is not null)o),
      'platforms',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct platform v from base where nullif(platform,'') is not null)o),
      'managers',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct manager v from base where nullif(manager,'') is not null)o),
      'currencies',case when v_scope='adjustment' then jsonb_build_array('PHP','USD') else '[]'::jsonb end,
      'match_statuses',jsonb_build_array('matched','historical_resigned','historical_matched','resignation_unlinked','unmatched','ambiguous')
    ),
    'sources',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'source_key',s.source_key,
      'source_name',s.source_name,'source_group',s.source_group,'source_month',s.source_month,
      'status',s.status,'row_count',s.row_count,'matched_count',s.matched_count,
      'unmatched_count',s.unmatched_count,'synced_at',s.synced_at,'error_message',s.error_message)
      order by s.source_month desc nulls last,s.source_group,s.source_name),'[]'::jsonb)
      from public.attendance_sheet_sources s where s.scope in (v_scope,'mixed')),
    'latest_sync',(select jsonb_build_object('id',s.id,'source_name',s.source_name,
      'source_group',s.source_group,'source_month',s.source_month,'status',s.status,
      'row_count',s.row_count,'matched_count',s.matched_count,'unmatched_count',s.unmatched_count,
      'synced_at',s.synced_at,'error_message',s.error_message)
      from public.attendance_sheet_sources s where s.scope in (v_scope,'mixed') and s.synced_at is not null
      order by s.synced_at desc,s.id desc limit 1),
    'rows',coalesce((select jsonb_agg((to_jsonb(p)-'normalized_event_kind')
      ||jsonb_build_object('event_kind',p.normalized_event_kind) order by p.event_date desc nulls last,
      p.hire_date asc nulls last,p.employee_no,p.id desc) from paged p),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function attendance_private.admin_employee_adjustment_history(
  p_employee_id uuid,
  p_page integer default 1,
  p_page_size integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := least(greatest(coalesce(p_page, 1), 1), 1000000);
  v_page_size integer := least(greatest(coalesce(p_page_size, 30), 1), 100);
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;
  if not exists (
    select 1 from public.employees e where e.id = p_employee_id
  ) then
    raise exception 'employee_not_found';
  end if;

  with history as materialized (
    select x.*
    from attendance_private.attendance_enriched_records x
    where x.employee_id = p_employee_id
      and x.kind = 'adjustment'
      and not x.is_mirror
  ), currency_stats as materialized (
    select
      h.currency,
      count(*) filter (
        where h.event_kind = 'bonus'
          or (h.event_kind not in ('bonus', 'deduction') and h.amount > 0)
      ) bonus_count,
      coalesce(sum(h.amount) filter (where h.amount > 0), 0) bonus_total,
      count(*) filter (
        where h.event_kind = 'deduction'
          or (h.event_kind not in ('bonus', 'deduction') and h.amount < 0)
      ) deduction_count,
      abs(coalesce(sum(h.amount) filter (where h.amount < 0), 0)) deduction_total,
      coalesce(sum(h.amount) filter (where h.amount < 0), 0) deduction_total_signed,
      coalesce(sum(h.amount), 0) net_amount,
      count(*) filter (where h.amount is null) incomplete
    from history h
    where h.currency is not null
    group by h.currency
  ), paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last, h.id desc
    limit v_page_size
    offset ((v_page::bigint - 1) * v_page_size)
  )
  select jsonb_build_object(
    'employee', (
      select to_jsonb(x)
      from (
        select
          e.id,
          e.employee_no,
          e.full_name,
          e.hire_date,
          e.employment_type,
          e.employment_type employee_type,
          e.status,
          e.country,
          e.nationality,
          e.platform_scope platform,
          t.name team_name,
          pos.name position_name,
          nullif(concat_ws(
            ' / ',
            nullif(btrim(e.person_in_charge), ''),
            nullif(btrim(e.leader_name), ''),
            nullif(btrim(e.online_leader), ''),
            nullif(btrim(e.online_trainer), ''),
            nullif(btrim(e.on_site_trainer), ''),
            nullif(btrim(e.trainer_name), '')
          ), '') manager
        from public.employees e
        left join public.teams t on t.id = e.team_id
        left join public.positions pos on pos.id = e.position_id
        where e.id = p_employee_id
      ) x
    ),
    'page', v_page,
    'page_size', v_page_size,
    'total', (select count(*) from history),
    'pages', greatest(
      1,
      ceil((select count(*) from history)::numeric / v_page_size)::integer
    ),
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'first_event_date', min(h.event_date),
        'last_event_date', max(h.event_date),
        'mirror_count', count(*) filter (where h.is_mirror),
        'bonus_count', count(*) filter (
          where h.event_kind = 'bonus'
            or (h.event_kind not in ('bonus', 'deduction') and h.amount > 0)
        ),
        'deduction_count', count(*) filter (
          where h.event_kind = 'deduction'
            or (h.event_kind not in ('bonus', 'deduction') and h.amount < 0)
        ),
        'incomplete', count(*) filter (where h.amount is null),
        'currency_review_count', count(*) filter (where h.currency is null),
        'currency', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.currency) from currency_stats cs)
        end,
        'mixed_currency', (select count(*) from currency_stats) > 1,
        'bonus_total', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.bonus_total) from currency_stats cs)
        end,
        'deduction_total', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.deduction_total) from currency_stats cs)
        end,
        'deduction_total_signed', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.deduction_total_signed) from currency_stats cs)
        end,
        'net_amount', case
          when (select count(*) from currency_stats) = 1
            then (select min(cs.net_amount) from currency_stats cs)
        end,
        'currencies', coalesce(
          (
            select jsonb_object_agg(
              cs.currency,
              jsonb_build_object(
                'bonus_count', cs.bonus_count,
                'bonus_total', cs.bonus_total,
                'deduction_count', cs.deduction_count,
                'deduction_total', cs.deduction_total,
                'deduction_total_signed', cs.deduction_total_signed,
                'net_amount', cs.net_amount,
                'incomplete', cs.incomplete
              )
              order by cs.currency
            )
            from currency_stats cs
          ),
          '{}'::jsonb
        ),
        'money_totals_scope', 'all_employee_history_rows'
      )
      from history h
    ),
    'rows', coalesce(
      (
        select jsonb_agg(
          to_jsonb(p)
          order by p.event_date desc nulls last, p.id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
  )
  into v_result;

  return v_result;
end;
$$;

create or replace function public.admin_employee_adjustment_history(
  p_employee_id uuid,p_page integer default 1,p_page_size integer default 30
)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
begin
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_adjustment_history(p_employee_id,p_page,p_page_size);
end;
$$;

create or replace function attendance_private.staff_attendance_home(
  p_month text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_employee_id uuid;
  v_employee_no text;
  v_full_name text;
  v_hire_date date;
  v_resign_date date;
  v_return_date date;
  v_month text := coalesce(
    nullif(btrim(p_month), ''),
    to_char((now() at time zone 'Asia/Manila')::date, 'YYYY-MM')
  );
  v_month_start date;
  v_month_end date;
  v_today date := (now() at time zone 'Asia/Manila')::date;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('staff') then
    raise exception 'session_not_current';
  end if;
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid_month';
  end if;

  select
    e.id,
    e.employee_no,
    e.full_name,
    e.hire_date,
    e.resign_date,
    e.return_date
  into
    v_employee_id,
    v_employee_no,
    v_full_name,
    v_hire_date,
    v_resign_date,
    v_return_date
  from public.user_access ua
  join public.employees e on e.id = ua.employee_id
  where ua.auth_user_id = v_user_id
    and ua.active = true
    and ua.employee_portal_enabled = true
  order by ua.updated_at desc
  limit 1;

  if v_employee_id is null then
    raise exception 'staff_profile_not_linked';
  end if;

  v_month_start := (v_month || '-01')::date;
  v_month_end := (v_month_start + interval '1 month')::date;

  with raw_events as materialized (
    select
      x.id,
      x.event_date,
      case
        when x.kind = 'resignation'
          or lower(coalesce(x.event_kind, '')) = 'resignation'
          then 'resignation'
        when lower(coalesce(x.event_kind, '')) = 'absent'
          then 'absence'
        when lower(coalesce(x.event_kind, '')) in (
          'public_holiday', 'home_leave', 'leave', 'half_day', 'absence'
        ) then lower(x.event_kind)
        else null
      end event_kind,
      x.kind,
      x.reason,
      x.note,
      x.employee_status,
      x.effective_match_status
    from attendance_private.attendance_enriched_records x
    where x.kind in ('attendance', 'resignation')
      and not x.is_mirror
      and (
        x.employee_id = v_employee_id
        or (
          x.employee_id is null
          and nullif(btrim(v_employee_no), '') is not null
          and upper(btrim(x.employee_no)) = upper(btrim(v_employee_no))
        )
      )
  ), actual_events as materialized (
    select * from raw_events where event_kind is not null
  ), lifecycle as materialized (
    select
      coalesce(
        v_resign_date,
        min(event_date) filter (where event_kind = 'resignation')
      ) resign_date,
      v_return_date return_date
    from actual_events
  ), month_actual as materialized (
    select
      e.event_date,
      e.event_kind,
      jsonb_build_object(
        'id', e.id,
        'event_kind', e.event_kind,
        'kind', e.kind,
        'reason', e.reason,
        'note', e.note,
        'status', e.employee_status,
        'effective_match_status', e.effective_match_status,
        'synthetic', false
      ) event
    from actual_events e
    where e.event_date >= v_month_start
      and e.event_date < v_month_end
  ), month_resignation_fill as materialized (
    select
      d::date event_date,
      'resignation'::text event_kind,
      jsonb_build_object(
        'event_kind', 'resignation',
        'kind', 'resignation',
        'reason', '离职',
        'note', '离职日期起自动标记',
        'reason_code', 'attendance.synthetic.resignation',
        'note_code', 'attendance.synthetic.resignationFromDate',
        'status', 'resigned',
        'effective_match_status', 'matched',
        'synthetic', true
      ) event
    from lifecycle l
    cross join lateral generate_series(
      greatest(v_month_start, l.resign_date),
      least(v_month_end - 1, coalesce(l.return_date - 1, v_month_end - 1)),
      interval '1 day'
    ) d
    where l.resign_date is not null
      and l.resign_date < v_month_end
      and (l.return_date is null or l.return_date > l.resign_date)
      and not exists (
        select 1
        from month_actual a
        where a.event_date = d::date
          and a.event_kind = 'resignation'
      )
  ), month_combined as materialized (
    select * from month_actual
    union all
    select * from month_resignation_fill
  ), month_event_lists as materialized (
    select
      event_date,
      jsonb_agg(
        event
        order by case event_kind
          when 'resignation' then 1
          when 'absence' then 2
          when 'leave' then 3
          when 'home_leave' then 4
          when 'public_holiday' then 5
          when 'half_day' then 6
          else 9
        end
      ) events
    from month_combined
    group by event_date
  ), month_days as materialized (
    select coalesce(
      jsonb_object_agg(extract(day from event_date)::integer::text, events order by event_date),
      '{}'::jsonb
    ) days
    from month_event_lists
  ), month_primary as materialized (
    select distinct on (event_date)
      event_date,
      event_kind
    from month_combined
    order by
      event_date,
      case event_kind
        when 'resignation' then 1
        when 'absence' then 2
        when 'leave' then 3
        when 'home_leave' then 4
        when 'public_holiday' then 5
        when 'half_day' then 6
        else 9
      end
  ), cumulative_resignation_fill as materialized (
    select
      d::date event_date,
      'resignation'::text event_kind
    from lifecycle l
    cross join lateral generate_series(
      l.resign_date,
      least(v_today, coalesce(l.return_date - 1, v_today)),
      interval '1 day'
    ) d
    where l.resign_date is not null
      and l.resign_date <= v_today
      and (l.return_date is null or l.return_date > l.resign_date)
  ), cumulative_combined as materialized (
    select event_date, event_kind from actual_events
    union all
    select event_date, event_kind from cumulative_resignation_fill
  ), cumulative_primary as materialized (
    select distinct on (event_date)
      event_date,
      event_kind
    from cumulative_combined
    where event_date <= v_today
    order by
      event_date,
      case event_kind
        when 'resignation' then 1
        when 'absence' then 2
        when 'leave' then 3
        when 'home_leave' then 4
        when 'public_holiday' then 5
        when 'half_day' then 6
        else 9
      end
  ), month_stats as materialized (
    select
      count(*) filter (where event_kind = 'public_holiday')::integer public_holiday,
      count(*) filter (where event_kind = 'home_leave')::integer home_leave,
      count(*) filter (where event_kind = 'leave')::integer leave_days,
      count(*) filter (where event_kind = 'half_day')::integer half_day,
      count(*) filter (where event_kind = 'absence')::integer absence,
      count(*) filter (where event_kind = 'resignation')::integer resignation,
      coalesce(sum(case when event_kind = 'half_day' then 0.5 else 1 end), 0)::numeric total_days
    from month_primary
  ), cumulative_stats as materialized (
    select
      count(*) filter (where event_kind = 'public_holiday')::integer public_holiday,
      count(*) filter (where event_kind = 'home_leave')::integer home_leave,
      count(*) filter (where event_kind = 'leave')::integer leave_days,
      count(*) filter (where event_kind = 'half_day')::integer half_day,
      count(*) filter (where event_kind = 'absence')::integer absence,
      count(*) filter (where event_kind = 'resignation')::integer resignation,
      coalesce(sum(case when event_kind = 'half_day' then 0.5 else 1 end), 0)::numeric total_days
    from cumulative_primary
  )
  select jsonb_build_object(
    'employee', jsonb_build_object(
      'id', v_employee_id,
      'employee_no', v_employee_no,
      'full_name', v_full_name,
      'hire_date', v_hire_date
    ),
    'month', v_month,
    'month_start', v_month_start,
    'month_end_exclusive', v_month_end,
    'days_in_month', extract(day from (v_month_end - 1))::integer,
    'days', (select days from month_days),
    'month_summary', jsonb_build_object(
      'public_holiday', coalesce(ms.public_holiday, 0),
      'home_leave', coalesce(ms.home_leave, 0),
      'leave', coalesce(ms.leave_days, 0),
      'half_day', coalesce(ms.half_day, 0),
      'absence', coalesce(ms.absence, 0),
      'resignation', coalesce(ms.resignation, 0),
      'total_days', coalesce(ms.total_days, 0)
    ),
    'all_time_summary', jsonb_build_object(
      'public_holiday', coalesce(cs.public_holiday, 0),
      'home_leave', coalesce(cs.home_leave, 0),
      'leave', coalesce(cs.leave_days, 0),
      'half_day', coalesce(cs.half_day, 0),
      'absence', coalesce(cs.absence, 0),
      'resignation', coalesce(cs.resignation, 0),
      'total_days', coalesce(cs.total_days, 0)
    ),
    -- Backward-compatible summary names used by the dashboard metrics.
    'summary', jsonb_build_object(
      'rest', coalesce(ms.public_holiday, 0),
      'leave', coalesce(ms.leave_days, 0) + coalesce(ms.home_leave, 0),
      'absent', coalesce(ms.absence, 0),
      'month_absent', coalesce(ms.absence, 0),
      'month_leave', coalesce(ms.public_holiday, 0)
        + coalesce(ms.home_leave, 0)
        + coalesce(ms.leave_days, 0)
        + coalesce(ms.half_day, 0)
    ),
    'total', (select count(*) from actual_events),
    'selected_month_total', (select count(*) from month_primary),
    'first_record_date', (select min(event_date) from actual_events),
    'last_record_date', (select max(event_date) from actual_events)
  )
  into v_result
  from month_stats ms
  cross join cumulative_stats cs;

  return v_result;
end;
$$;

create or replace function attendance_private.admin_attendance_monthly(
  p_filters jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_month text := btrim(coalesce(p_filters->>'month',''));
  v_search text := lower(btrim(coalesce(p_filters->>'search','')));
  v_employee_no text := lower(btrim(coalesce(p_filters->>'employee_no','')));
  v_full_name text := lower(btrim(coalesce(p_filters->>'full_name',p_filters->>'employee_name','')));
  v_team text := btrim(coalesce(p_filters->>'team',''));
  v_position text := btrim(coalesce(p_filters->>'position',''));
  v_country text := btrim(coalesce(p_filters->>'country',''));
  v_platform text := btrim(coalesce(p_filters->>'platform',''));
  v_manager text := lower(btrim(coalesce(p_filters->>'manager',p_filters->>'responsible','')));
  v_employee_status text := lower(btrim(coalesce(p_filters->>'employee_status',p_filters->>'status','')));
  v_employment_type text := btrim(coalesce(p_filters->>'employment_type',p_filters->>'employee_type',''));
  v_source_group text := lower(btrim(coalesce(p_filters->>'source_group','')));
  v_page integer := least(greatest(coalesce(nullif(p_filters->>'page','')::integer,1),1),1000000);
  v_page_size integer := least(greatest(coalesce(nullif(p_filters->>'page_size','')::integer,30),1),100);
  v_month_start date;
  v_month_end date;
  v_days_in_month integer;
  v_access_scope text;
  v_current_employee uuid;
  v_current_employee_no text;
  v_current_team uuid;
  v_current_team_name text;
  v_all boolean := false;
  v_result jsonb;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
  if not public.has_permission('attendance.view') then raise exception 'permission_denied'; end if;
  if v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'invalid_month'; end if;
  if v_source_group<>'' and v_source_group not in ('home','onsite_to_home') then
    raise exception 'invalid_source_group';
  end if;

  v_month_start := (v_month||'-01')::date;
  v_month_end := (v_month_start+interval '1 month')::date;
  v_days_in_month := extract(day from (v_month_end-1))::integer;

  select ua.data_scope,ua.employee_id,e.employee_no,e.team_id,t.name
  into v_access_scope,v_current_employee,v_current_employee_no,v_current_team,v_current_team_name
  from public.user_access ua
  left join public.employees e on e.id=ua.employee_id
  left join public.teams t on t.id=e.team_id
  where ua.auth_user_id=v_user_id and ua.active=true and ua.backend_enabled=true
  order by ua.updated_at desc limit 1;
  v_all := public.is_founder() or v_access_scope='all';

  with scoped_events as materialized (
    select x.*,
      case
        when x.employee_id is not null then 'employee:'||x.employee_id::text
        when x.historical_employee_no is not null then 'history:'||upper(btrim(x.historical_employee_no))
        when x.effective_match_status='resignation_unlinked' then 'resignation:'||coalesce(
          nullif(upper(btrim(x.employee_no_raw)),''),
          nullif(coalesce(nullif(x.source_key,''),'unknown')||':'||public.exam_norm(x.employee_name_raw),'unknown:'),
          'record:'||x.id::text)
        when nullif(btrim(x.employee_no_raw),'') is not null then 'review:employee_no:'||upper(btrim(x.employee_no_raw))
        when nullif(public.exam_norm(x.employee_name_raw),'') is not null then
          'review:name:'||coalesce(nullif(x.source_group,''),'unknown')||':'||public.exam_norm(x.employee_name_raw)
        else 'review:record:'||x.id::text
      end identity_key
    from attendance_private.attendance_enriched_records x
    left join public.employees scope_employee on scope_employee.id=x.employee_id
    where x.kind in ('attendance','resignation') and not x.is_mirror
      -- Only resignation history is needed before this month; selected-month
      -- attendance still retains every raw row for the detail dialog.
      and x.event_date<v_month_end
      and (x.event_date>=v_month_start or x.kind='resignation'
        or lower(coalesce(x.event_kind,''))='resignation')
      and (
        v_all or x.employee_id=v_current_employee
        or (x.employee_id is null and v_current_employee_no is not null
          and upper(btrim(x.employee_no))=upper(btrim(v_current_employee_no)))
        or (v_access_scope='own_team' and (scope_employee.team_id=v_current_team
          or (scope_employee.id is null and public.exam_norm(x.team_name)=public.exam_norm(v_current_team_name))))
        or (v_access_scope='assigned_teams' and (
          exists(select 1 from public.user_scope_employees se
            where se.auth_user_id=v_user_id and se.employee_id=x.employee_id)
          or exists(select 1 from public.user_scope_teams st
            where st.auth_user_id=v_user_id and st.team_id=scope_employee.team_id)
          or exists(select 1 from public.user_scope_teams st join public.teams stt on stt.id=st.team_id
            where st.auth_user_id=v_user_id and public.exam_norm(stt.name)=public.exam_norm(x.team_name))
        ))
      )
  ), month_events as materialized (
    select * from scoped_events where event_date>=v_month_start
  ), resignation_dates as materialized (
    -- Keep the full history and the earliest resignation in the current
    -- employment cycle separately. A historical return date must not cancel
    -- a newer resignation after the employee was rehired.
    select e.identity_key,
      min(e.event_date) filter(where e.kind='resignation'
        or lower(coalesce(e.event_kind,''))='resignation') resign_date,
      min(e.event_date) filter(where (e.kind='resignation'
        or lower(coalesce(e.event_kind,''))='resignation')
        and (master_employee.hire_date is null
          or e.event_date>=master_employee.hire_date)
        and (master_employee.return_date is null
          or e.event_date>=master_employee.return_date)) current_resign_date
    from scoped_events e
    left join public.employees master_employee
      on e.identity_key='employee:'||master_employee.id::text
    group by e.identity_key
  ), current_people_base as materialized (
    select 'employee:'||e.id::text identity_key,e.id employee_id,e.employee_no,
      e.employee_no employee_no_sort,e.full_name,e.hire_date,e.status,e.employment_type,
      coalesce(nullif(btrim(e.country),''),nullif(btrim(e.nationality),'')) country,
      e.platform_scope platform,pos.name position_name,t.name team_name,
      nullif(concat_ws(' / ',nullif(btrim(e.person_in_charge),''),nullif(btrim(e.leader_name),''),
        nullif(btrim(e.online_leader),''),nullif(btrim(e.online_trainer),''),
        nullif(btrim(e.on_site_trainer),''),nullif(btrim(e.trainer_name),'')),'') manager,
      e.resign_date,e.return_date,'current' identity_kind,'matched' effective_match_status
    from public.employees e
    left join public.teams t on t.id=e.team_id
    left join public.positions pos on pos.id=e.position_id
    where (e.hire_date is null or e.hire_date<v_month_end)
      and (
        v_all or e.id=v_current_employee
        or (v_access_scope='own_team' and e.team_id=v_current_team)
        or (v_access_scope='assigned_teams' and (
          exists(select 1 from public.user_scope_employees se where se.auth_user_id=v_user_id and se.employee_id=e.id)
          or exists(select 1 from public.user_scope_teams st where st.auth_user_id=v_user_id and st.team_id=e.team_id)
        ))
      )
  ), current_people as materialized (
    select cp.identity_key,cp.employee_id,cp.employee_no,cp.employee_no_sort,cp.full_name,
      cp.hire_date,case when lifecycle.resign_date is not null
        and lifecycle.resign_date<v_month_end
        and (lifecycle.return_date is null or lifecycle.return_date>=v_month_end)
        then 'resigned' else cp.status end status,
      cp.employment_type,cp.country,cp.platform,cp.position_name,
      cp.team_name,cp.manager,
      lifecycle.resign_date,lifecycle.return_date,
      cp.identity_kind,cp.effective_match_status
    from current_people_base cp
    left join resignation_dates rd on rd.identity_key=cp.identity_key
    cross join lateral (
      select
        (select min(candidate_date) from (values
          (case when (cp.hire_date is null or cp.resign_date>=cp.hire_date)
            and (cp.return_date is null or cp.resign_date>=cp.return_date)
            then cp.resign_date end),
          (rd.current_resign_date)
        ) active_candidates(candidate_date)) active_resign_date,
        (select min(candidate_date) from (values
          (cp.resign_date),(rd.resign_date)
        ) all_candidates(candidate_date)) any_resign_date
    ) candidates
    cross join lateral (
      select coalesce(candidates.active_resign_date,
          case when cp.return_date>candidates.any_resign_date
            then candidates.any_resign_date end) resign_date,
        case when candidates.active_resign_date is null
          and cp.return_date>candidates.any_resign_date
          then cp.return_date else null::date end return_date
    ) lifecycle
    where cp.status in ('active','probation','suspended')
      or exists(select 1 from month_events me where me.employee_id=cp.employee_id)
      or (lifecycle.resign_date is not null and lifecycle.resign_date<v_month_end
        and (lifecycle.return_date is null or lifecycle.return_date>=v_month_start))
  ), event_people as materialized (
    select distinct on (e.identity_key)
      e.identity_key,e.employee_id,e.employee_no,e.employee_no employee_no_sort,e.full_name,e.hire_date,
      case when coalesce(rd.current_resign_date,rd.resign_date)<v_month_end
        then 'resigned' else e.employee_status end status,
      e.employment_type,e.country,e.platform,e.position_name,e.team_name,e.manager,
      coalesce(rd.current_resign_date,rd.resign_date) resign_date,null::date return_date,
      case when e.employee_id is not null then 'current'
        when e.historical_employee_no is not null then 'historical'
        when e.effective_match_status='resignation_unlinked' then 'resignation_unlinked' else 'review' end identity_kind,
      e.effective_match_status
    -- Unlinked/historical identities enter the selected month only when they
    -- actually have a row in that month. Older resignation history is used to
    -- extend matched employee lifecycles, not to inflate every later roster.
    from month_events e left join resignation_dates rd on rd.identity_key=e.identity_key
    order by e.identity_key,(e.kind='resignation' or lower(coalesce(e.event_kind,''))='resignation') desc,
      e.event_date desc nulls last,e.id desc
  ), people as materialized (
    select * from current_people
    union all
    select ep.* from event_people ep
    where not exists(select 1 from current_people cp where cp.identity_key=ep.identity_key)
  ), filtered_people as materialized (
    select p.* from people p
    where (v_search='' or lower(concat_ws(' ',p.employee_no,p.full_name,p.hire_date,p.status,
      p.employment_type,p.country,p.platform,p.position_name,p.team_name,p.manager)) like '%'||v_search||'%')
      and (v_employee_no='' or lower(coalesce(p.employee_no,'')) like '%'||v_employee_no||'%')
      and (v_full_name='' or lower(coalesce(p.full_name,'')) like '%'||v_full_name||'%')
      and (v_team='' or public.exam_norm(p.team_name)=public.exam_norm(v_team))
      and (v_position='' or public.exam_norm(p.position_name)=public.exam_norm(v_position))
      and (v_country='' or public.exam_norm(p.country)=public.exam_norm(v_country))
      and (v_platform='' or public.exam_norm(p.platform)=public.exam_norm(v_platform))
      and (v_manager='' or lower(coalesce(p.manager,'')) like '%'||v_manager||'%')
      and (v_employee_status='' or lower(coalesce(p.status,''))=v_employee_status)
      and (v_employment_type='' or public.exam_norm(p.employment_type)=public.exam_norm(v_employment_type))
      and (v_source_group='' or
        (v_source_group='onsite_to_home' and public.exam_norm(p.employment_type) like '%现场转居家%') or
        (v_source_group='home' and public.exam_norm(coalesce(p.employment_type,'')) not like '%现场转居家%'))
  ), paged_people as materialized (
    select p.* from filtered_people p
    order by p.hire_date asc nulls last,p.employee_no_sort,p.full_name,p.identity_key
    limit v_page_size offset ((v_page::bigint-1)*v_page_size)
  ), actual_day_events as materialized (
    select e.identity_key,e.event_date,
      case when e.kind='resignation' then 'resignation'
        when lower(coalesce(e.event_kind,''))='absent' then 'absence'
        else lower(coalesce(e.event_kind,'')) end event_kind,
      jsonb_build_object('event_kind',case when e.kind='resignation' then 'resignation'
          when lower(coalesce(e.event_kind,''))='absent' then 'absence'
          else lower(coalesce(e.event_kind,'')) end,
        'kind',e.kind,'reason',e.reason,'note',e.note,'status',e.employee_status,
        'effective_match_status',e.effective_match_status,'synthetic',false) event
    from month_events e join filtered_people p on p.identity_key=e.identity_key
    where e.kind='resignation'
      or lower(coalesce(e.event_kind,'')) in (
        'public_holiday','home_leave','leave','half_day','absence','absent','resignation'
      )
  ), synthetic_resignation_events as materialized (
    select p.identity_key,d::date event_date,'resignation'::text event_kind,
      jsonb_build_object('event_kind','resignation','kind','resignation','reason','离职',
        'note','离职日期起自动标记',
        'reason_code','attendance.synthetic.resignation',
        'note_code','attendance.synthetic.resignationFromDate','status','resigned',
        'effective_match_status',p.effective_match_status,'synthetic',true) event
    from filtered_people p
    cross join lateral generate_series(greatest(v_month_start,p.resign_date),
      least(v_month_end-1,coalesce(p.return_date-1,v_month_end-1)),interval '1 day') d
    where p.resign_date is not null and p.resign_date<v_month_end
      and (p.return_date is null or p.return_date>p.resign_date)
      and not exists(select 1 from actual_day_events a
        where a.identity_key=p.identity_key and a.event_date=d::date and a.event_kind='resignation')
  ), combined_day_events as materialized (
    -- Original same-day rows stay available for the detail dialog.
    select * from actual_day_events union all select * from synthetic_resignation_events
  ), effective_candidates as materialized (
    -- A rehire/return date ends resignation for counting and display, while
    -- any stale raw sheet row remains in combined_day_events for audit/detail.
    select e.*
    from combined_day_events e
    join filtered_people p on p.identity_key=e.identity_key
    where not (e.event_kind='resignation' and p.return_date is not null and e.event_date>=p.return_date)
  ), primary_days as materialized (
    select distinct on (e.identity_key,e.event_date)
      e.identity_key,e.event_date,e.event_kind,e.event
    from effective_candidates e
    order by e.identity_key,e.event_date,case e.event_kind when 'resignation' then 1
      when 'absence' then 2 when 'leave' then 3 when 'home_leave' then 4
      when 'public_holiday' then 5 when 'half_day' then 6 else 9 end
  ), page_day_event_lists as materialized (
    select e.identity_key,extract(day from e.event_date)::integer day_no,
      jsonb_agg(e.event order by case e.event_kind when 'resignation' then 1 when 'absence' then 2
        when 'leave' then 3 when 'home_leave' then 4 when 'public_holiday' then 5
        when 'half_day' then 6 else 9 end) events
    from combined_day_events e join paged_people p on p.identity_key=e.identity_key
    group by e.identity_key,extract(day from e.event_date)::integer
  ), person_days as materialized (
    select identity_key,jsonb_object_agg(day_no::text,events order by day_no) days
    from page_day_event_lists group by identity_key
  ), page_effective_day_lists as materialized (
    select d.identity_key,extract(day from d.event_date)::integer day_no,jsonb_build_array(d.event) events
    from primary_days d join paged_people p on p.identity_key=d.identity_key
  ), person_effective_days as materialized (
    select identity_key,jsonb_object_agg(day_no::text,events order by day_no) effective_days
    from page_effective_day_lists group by identity_key
  ), person_stats as materialized (
    select d.identity_key,
      count(*) filter(where d.event_kind='public_holiday') public_holiday,
      count(*) filter(where d.event_kind='home_leave') home_leave,
      count(*) filter(where d.event_kind='leave') leave_days,
      count(*) filter(where d.event_kind='half_day') half_day,
      count(*) filter(where d.event_kind='absence') absence,
      count(*) filter(where d.event_kind='resignation') resignation,
      coalesce(sum(case when d.event_kind='half_day' then 0.5
        when d.event_kind in ('public_holiday','home_leave','leave','absence','resignation') then 1
        else 0 end),0)::numeric total_days
    from primary_days d group by d.identity_key
  ), overview_monthly as materialized (
    select d.event_kind,coalesce(sum(case when d.event_kind='half_day' then 0.5 else 1 end),0)::numeric days,
      count(distinct d.identity_key)::integer people
    from primary_days d
    where d.event_kind in ('public_holiday','home_leave','leave','half_day','absence','resignation')
    group by d.event_kind
  ), overview_daily as materialized (
    select extract(day from d.event_date)::integer day_no,d.event_kind,
      count(distinct d.identity_key)::integer people
    from primary_days d
    where d.event_kind in ('public_holiday','home_leave','leave','half_day','absence','resignation')
    group by extract(day from d.event_date)::integer,d.event_kind
  )
  select jsonb_build_object(
    'month',v_month,'month_start',v_month_start,'month_end_exclusive',v_month_end,
    'days_in_month',v_days_in_month,'page',v_page,'page_size',v_page_size,
    'total',(select count(*) from filtered_people),
    'pages',greatest(1,ceil((select count(*) from filtered_people)::numeric/v_page_size)::integer),
    'overview',jsonb_build_object('scope','filtered',
      'total_days',coalesce((select sum(days) from overview_monthly),0),
      'total_people',coalesce((select count(distinct identity_key) from primary_days
        where event_kind in ('public_holiday','home_leave','leave','half_day','absence','resignation')),0),
      'monthly',coalesce((select jsonb_object_agg(event_kind,
        jsonb_build_object('days',days,'people',people)) from overview_monthly),'{}'::jsonb),
      'daily',coalesce((select jsonb_object_agg(day_no::text,values_by_day) from (
        select day_no,jsonb_object_agg(event_kind,people) values_by_day
        from overview_daily group by day_no) grouped),'{}'::jsonb)),
    'overview_scope','filtered',
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'row_key',p.identity_key,'employee_id',p.employee_id,'employee_no',p.employee_no,'no',p.employee_no,
      'full_name',p.full_name,'name',p.full_name,'hire_date',p.hire_date,'status',p.status,
      'employment_type',p.employment_type,'employee_type',p.employment_type,'country',p.country,
      'platform',p.platform,'position_name',p.position_name,'position',p.position_name,
      'team_name',p.team_name,'team',p.team_name,'manager',p.manager,'identity_kind',p.identity_kind,
      'effective_match_status',p.effective_match_status,'resign_date',p.resign_date,'return_date',p.return_date,
      'days',coalesce(pd.days,'{}'::jsonb),'effective_days',coalesce(ped.effective_days,'{}'::jsonb),
      'summary',jsonb_build_object('public_holiday',coalesce(ps.public_holiday,0),
        'home_leave',coalesce(ps.home_leave,0),'leave',coalesce(ps.leave_days,0),
        'half_day',coalesce(ps.half_day,0),'absence',coalesce(ps.absence,0),
        'resignation',coalesce(ps.resignation,0),'total_days',coalesce(ps.total_days,0)),
      'total_days',coalesce(ps.total_days,0))
      order by p.hire_date asc nulls last,p.employee_no_sort,p.full_name,p.identity_key)
      from paged_people p
      left join person_days pd on pd.identity_key=p.identity_key
      left join person_effective_days ped on ped.identity_key=p.identity_key
      left join person_stats ps on ps.identity_key=p.identity_key),'[]'::jsonb),
    'options',jsonb_build_object(
      'teams',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct team_name v from people where nullif(team_name,'') is not null)o),
      'positions',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct position_name v from people where nullif(position_name,'') is not null)o),
      'countries',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct country v from people where nullif(country,'') is not null)o),
      'platforms',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct platform v from people where nullif(platform,'') is not null)o),
      'employment_types',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct employment_type v from people where nullif(employment_type,'') is not null)o),
      'employee_statuses',(select coalesce(jsonb_agg(v order by v),'[]'::jsonb) from (select distinct status v from people where nullif(status,'') is not null)o),
      'source_groups',jsonb_build_array('home','onsite_to_home'))
  ) into v_result;
  return v_result;
end;
$$;


revoke all on function attendance_private.admin_attendance_home(jsonb)
  from public,anon,authenticated;
grant execute on function attendance_private.admin_attendance_home(jsonb)
  to authenticated;

revoke all on function attendance_private.admin_employee_adjustment_history(uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function attendance_private.admin_employee_adjustment_history(uuid,integer,integer)
  to service_role;

revoke all on function public.admin_employee_adjustment_history(uuid,integer,integer)
  from public,anon,authenticated;
grant execute on function public.admin_employee_adjustment_history(uuid,integer,integer)
  to authenticated;

revoke all on function attendance_private.staff_attendance_home(text)
  from public,anon,authenticated;
grant execute on function attendance_private.staff_attendance_home(text)
  to service_role;

revoke all on function attendance_private.admin_attendance_monthly(jsonb)
  from public,anon,authenticated;

notify pgrst,'reload schema';
