begin;

set local lock_timeout='500ms';
set local statement_timeout='10s';

-- Employee drawer history readers intentionally use separate RPC names from
-- the legacy first-load readers.  This avoids changing existing callers while
-- making date/search predicates, totals and pagination one atomic DB read.
create or replace function attendance_private.admin_employee_attendance_history_filtered(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='3s'
as $$
declare
  v_page integer := least(greatest(coalesce(p_page,1),1),1000000);
  v_page_size integer := coalesce(p_page_size,20);
  v_search text := lower(left(nullif(btrim(coalesce(p_search,'')),''),200));
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('attendance.records.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if p_date_from is not null and p_date_to is not null
     and p_date_from>p_date_to then
    raise exception 'invalid_date_range';
  end if;
  if v_page_size not in (20,30,50,100) then
    raise exception 'invalid_page_size';
  end if;

  with normalized as materialized (
    select
      x.*,
      case
        when x.kind='resignation'
          or lower(coalesce(x.event_kind,''))='resignation'
          then 'resignation'
        when lower(coalesce(x.event_kind,''))='absent' then 'absence'
        else lower(coalesce(x.event_kind,''))
      end normalized_event_kind
    from attendance_private.attendance_enriched_records x
    where x.employee_id=p_employee_id
      and x.kind in ('attendance','resignation')
      and not x.is_mirror
      and (
        x.kind='resignation'
        or lower(coalesce(x.event_kind,'')) in (
          'public_holiday','home_leave','leave','half_day',
          'absence','absent','resignation'
        )
      )
  ), history as materialized (
    select
      n.id,
      n.event_date,
      n.normalized_event_kind event_kind,
      (
        jsonb_build_object(
          'id',n.id,
          'event_date',n.event_date,
          'event_kind',n.normalized_event_kind,
          'reason',n.reason,
          'note',n.note
        )
        || case
          when n.normalized_event_kind='resignation'
            and nullif(btrim(coalesce(n.reason,'')),'') is null
          then jsonb_build_object(
            'reason_code','attendance.synthetic.resignation'
          )
          else '{}'::jsonb
        end
        || case
          when n.normalized_event_kind='resignation'
            and nullif(btrim(coalesce(n.note,'')),'') is null
          then jsonb_build_object(
            'note_code','attendance.synthetic.resignationFromDate'
          )
          else '{}'::jsonb
        end
      ) row_json
    from normalized n
    where (p_date_from is null or n.event_date>=p_date_from)
      and (p_date_to is null or n.event_date<=p_date_to)
      and (
        v_search is null
        or lower(coalesce(n.normalized_event_kind,'')) like '%'||v_search||'%'
        or lower(coalesce(n.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(n.note,'')) like '%'||v_search||'%'
        or lower(coalesce(n.raw_amount,'')) like '%'||v_search||'%'
        or lower(coalesce(n.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(n.full_name,'')) like '%'||v_search||'%'
        or case n.normalized_event_kind
          when 'public_holiday' then '公休'
          when 'home_leave' then '回家'
          when 'leave' then '请假'
          when 'half_day' then '半天'
          when 'absence' then '缺席'
          when 'resignation' then '离职'
          else ''
        end like '%'||v_search||'%'
      )
  ), paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last,h.id desc
    limit v_page_size
    offset ((v_page::bigint-1)*v_page_size)
  )
  select jsonb_build_object(
    'employee',(
      select to_jsonb(e)
      from (
        select e.id,e.employee_no,e.full_name,e.hire_date,
          e.employment_type,e.employment_type employee_type,e.status,
          e.country,e.nationality,e.platform_scope platform,
          t.name team_name,pos.name position_name
        from public.employees e
        left join public.teams t on t.id=e.team_id
        left join public.positions pos on pos.id=e.position_id
        where e.id=p_employee_id
      ) e
    ),
    'filters',jsonb_build_object(
      'date_from',p_date_from,'date_to',p_date_to,'search',v_search
    ),
    'page',v_page,
    'page_size',v_page_size,
    'total',(select count(*) from history),
    'pages',greatest(
      1,ceil((select count(*) from history)::numeric/v_page_size)::integer
    ),
    'summary',(
      select jsonb_build_object(
        'total',count(*),
        'first_event_date',min(event_date),
        'last_event_date',max(event_date),
        'public_holiday',count(*) filter(where event_kind='public_holiday'),
        'home_leave',count(*) filter(where event_kind='home_leave'),
        'leave',count(*) filter(where event_kind='leave'),
        'half_day',count(*) filter(where event_kind='half_day'),
        'absence',count(*) filter(where event_kind='absence'),
        'resignation',count(*) filter(where event_kind='resignation')
      ) from history
    ),
    'rows',coalesce((
      select jsonb_agg(
        p.row_json order by p.event_date desc nulls last,p.id desc
      ) from paged p
    ),'[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

create or replace function attendance_private.admin_employee_adjustment_history_filtered(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='3s'
as $$
declare
  v_page integer := least(greatest(coalesce(p_page,1),1),1000000);
  v_page_size integer := coalesce(p_page_size,20);
  v_search text := lower(left(nullif(btrim(coalesce(p_search,'')),''),200));
  v_can_bonus boolean := false;
  v_can_deduction boolean := false;
  v_result jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  v_can_bonus:=public.has_permission('adjustment.bonus.view');
  v_can_deduction:=public.has_permission('adjustment.deduction.view');
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('adjustment.page.view')
     or not (v_can_bonus or v_can_deduction) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  if p_date_from is not null and p_date_to is not null
     and p_date_from>p_date_to then
    raise exception 'invalid_date_range';
  end if;
  if v_page_size not in (20,30,50,100) then
    raise exception 'invalid_page_size';
  end if;

  with visible as materialized (
    select x.*,
      attendance_private.adjustment_visibility_kind(
        x.event_kind,x.amount
      ) visibility_kind
    from attendance_private.attendance_enriched_records x
    where x.employee_id=p_employee_id
      and x.kind='adjustment'
      and not x.is_mirror
      and (
        (v_can_bonus and v_can_deduction)
        or attendance_private.adjustment_visibility_kind(
          x.event_kind,x.amount
        )=case when v_can_bonus then 'bonus' else 'deduction' end
      )
  ), history as materialized (
    select v.*
    from visible v
    where (p_date_from is null or v.event_date>=p_date_from)
      and (p_date_to is null or v.event_date<=p_date_to)
      and (
        v_search is null
        or lower(coalesce(v.event_kind,'')) like '%'||v_search||'%'
        or lower(coalesce(v.visibility_kind,'')) like '%'||v_search||'%'
        or lower(coalesce(v.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(v.note,'')) like '%'||v_search||'%'
        or lower(coalesce(v.raw_amount,'')) like '%'||v_search||'%'
        or lower(coalesce(v.amount::text,'')) like '%'||v_search||'%'
        or lower(coalesce(v.currency,'')) like '%'||v_search||'%'
        or lower(coalesce(v.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(v.full_name,'')) like '%'||v_search||'%'
        or case v.visibility_kind
          when 'bonus' then '奖金'
          when 'deduction' then '扣款'
          else '未分类'
        end like '%'||v_search||'%'
      )
  ), currency_stats as materialized (
    select
      h.currency,
      count(*) filter(where h.visibility_kind='bonus') bonus_count,
      coalesce(sum(h.amount) filter(where h.visibility_kind='bonus'),0)
        bonus_total,
      count(*) filter(where h.visibility_kind='deduction') deduction_count,
      abs(coalesce(sum(h.amount) filter(
        where h.visibility_kind='deduction'
      ),0)) deduction_total,
      coalesce(sum(h.amount) filter(
        where h.visibility_kind='deduction'
      ),0) deduction_total_signed,
      coalesce(sum(h.amount),0) net_amount,
      count(*) filter(where h.amount is null) incomplete
    from history h
    where h.currency is not null
    group by h.currency
  ), paged as materialized (
    select h.*
    from history h
    order by h.event_date desc nulls last,h.id desc
    limit v_page_size
    offset ((v_page::bigint-1)*v_page_size)
  )
  select jsonb_build_object(
    'employee',(
      select to_jsonb(e)
      from (
        select e.id,e.employee_no,e.full_name,e.hire_date,
          e.employment_type,e.employment_type employee_type,e.status,
          e.country,e.nationality,e.platform_scope platform,
          t.name team_name,pos.name position_name
        from public.employees e
        left join public.teams t on t.id=e.team_id
        left join public.positions pos on pos.id=e.position_id
        where e.id=p_employee_id
      ) e
    ),
    'filters',jsonb_build_object(
      'date_from',p_date_from,'date_to',p_date_to,'search',v_search
    ),
    'permissions',jsonb_build_object(
      'bonus',v_can_bonus,'deduction',v_can_deduction
    ),
    'page',v_page,
    'page_size',v_page_size,
    'total',(select count(*) from history),
    'pages',greatest(
      1,ceil((select count(*) from history)::numeric/v_page_size)::integer
    ),
    'summary',(
      select
        jsonb_build_object(
          'total',count(*),
          'first_event_date',min(h.event_date),
          'last_event_date',max(h.event_date),
          'incomplete',count(*) filter(where h.amount is null),
          'currency_review_count',count(*) filter(where h.currency is null),
          'money_totals_scope','all_filtered_visible_rows',
          'currencies',coalesce((
            select jsonb_object_agg(
              cs.currency,
              jsonb_build_object('incomplete',cs.incomplete)
              || case when v_can_bonus then jsonb_build_object(
                'bonus_count',cs.bonus_count,
                'bonus_total',cs.bonus_total
              ) else '{}'::jsonb end
              || case when v_can_deduction then jsonb_build_object(
                'deduction_count',cs.deduction_count,
                'deduction_total',cs.deduction_total,
                'deduction_total_signed',cs.deduction_total_signed
              ) else '{}'::jsonb end
              || case when v_can_bonus and v_can_deduction
                then jsonb_build_object('net_amount',cs.net_amount)
                else '{}'::jsonb end
              order by cs.currency
            ) from currency_stats cs
          ),'{}'::jsonb)
        )
        || case when v_can_bonus then jsonb_build_object(
          'bonus_count',count(*) filter(where h.visibility_kind='bonus')
        ) else '{}'::jsonb end
        || case when v_can_deduction then jsonb_build_object(
          'deduction_count',count(*) filter(
            where h.visibility_kind='deduction'
          )
        ) else '{}'::jsonb end
      from history h
    ),
    'rows',coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id',p.id,
          'employee_no',p.employee_no,
          'full_name',p.full_name,
          'event_date',p.event_date,
          'event_kind',p.event_kind,
          'amount',p.amount,
          'raw_amount',p.raw_amount,
          'currency',p.currency,
          'reason',p.reason,
          'note',p.note,
          'category',nullif(btrim(coalesce(
            p.raw_values->>'category',''
          )),'')
        )
        order by p.event_date desc nulls last,p.id desc
      ) from paged p
    ),'[]'::jsonb)
  ) into v_result;

  return v_result;
end
$$;

revoke all on function attendance_private.admin_employee_attendance_history_filtered(
  uuid,date,date,text,integer,integer
) from public,anon,authenticated,service_role;
revoke all on function attendance_private.admin_employee_adjustment_history_filtered(
  uuid,date,date,text,integer,integer
) from public,anon,authenticated,service_role;

create or replace function public.admin_employee_attendance_history_filtered(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
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
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('attendance.records.view') then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  return attendance_private.admin_employee_attendance_history_filtered(
    p_employee_id,p_date_from,p_date_to,p_search,p_page,p_page_size
  );
end
$$;

create or replace function public.admin_employee_adjustment_history_filtered(
  p_employee_id uuid,
  p_date_from date default null,
  p_date_to date default null,
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
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated';
  end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('employee.directory.view')
     or not public.has_permission('adjustment.page.view')
     or not (
       public.has_permission('adjustment.bonus.view')
       or public.has_permission('adjustment.deduction.view')
     ) then
    raise exception 'permission_denied';
  end if;
  if not public.can_manage_employee(p_employee_id) then
    raise exception 'employee_out_of_scope';
  end if;
  return attendance_private.admin_employee_adjustment_history_filtered(
    p_employee_id,p_date_from,p_date_to,p_search,p_page,p_page_size
  );
end
$$;

revoke all on function public.admin_employee_attendance_history_filtered(
  uuid,date,date,text,integer,integer
) from public,anon,authenticated,service_role;
revoke all on function public.admin_employee_adjustment_history_filtered(
  uuid,date,date,text,integer,integer
) from public,anon,authenticated,service_role;
grant execute on function public.admin_employee_attendance_history_filtered(
  uuid,date,date,text,integer,integer
) to authenticated;
grant execute on function public.admin_employee_adjustment_history_filtered(
  uuid,date,date,text,integer,integer
) to authenticated;

comment on function public.admin_employee_attendance_history_filtered(
  uuid,date,date,text,integer,integer
) is 'Exact-employee attendance history with server date/search filters and bounded pagination.';
comment on function public.admin_employee_adjustment_history_filtered(
  uuid,date,date,text,integer,integer
) is 'Exact-employee adjustment history filtered and summarized only after category permission enforcement.';

notify pgrst,'reload schema';

commit;
