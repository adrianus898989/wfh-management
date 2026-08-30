begin;

-- The adjustment page and employee drawer already filter bonus/deduction rows.
-- Apply the identical category boundary to the operator-entry audit so an
-- account that may see only deductions cannot recover bonus details from the
-- audit surface (and vice versa).  Filtering happens before count/pagination.
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
  v_can_bonus boolean:=false;
  v_can_deduction boolean:=false;
  v_rows jsonb;
  v_total bigint;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('audit.view') then
    raise exception 'permission_denied';
  end if;
  if v_category not in ('adjustment','attendance') then
    raise exception 'invalid_category';
  end if;

  if v_category='adjustment' then
    v_can_bonus:=public.has_permission('adjustment.bonus.view');
    v_can_deduction:=public.has_permission('adjustment.deduction.view');
    if not public.has_permission('adjustment.page.view')
       or not (v_can_bonus or v_can_deduction) then
      raise exception 'permission_denied';
    end if;
  end if;
  if v_category='attendance'
     and not (
       public.has_permission('attendance.monthly.view')
       or public.has_permission('attendance.today.view')
       or public.has_permission('attendance.records.view')
       or public.has_permission('attendance.leave.view')
     ) then
    raise exception 'permission_denied';
  end if;

  with entries as (
    select
      'audit:'||audit.id::text as id,
      audit.created_at,
      audit.actor_user_id,
      audit.employee_id,
      case
        when audit.action='create_adjustment' then 'create'
        when audit.action='update_adjustment' then 'update'
        else audit.action
      end as action,
      audit.record_id,
      record.event_date,
      coalesce(record.event_kind,audit.new_data->>'event_kind') as event_kind,
      coalesce(
        record.amount,
        case
          when coalesce(audit.new_data->>'amount','')
            ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
          then (audit.new_data->>'amount')::numeric
          else null
        end
      ) as amount,
      coalesce(record.currency,audit.new_data->>'currency') as currency,
      coalesce(record.reason,audit.reason,audit.new_data->>'reason') as reason,
      coalesce(record.note,audit.new_data->>'note') as note,
      coalesce(record.sync_origin,'backend') as source,
      coalesce(record.raw_values->>'google_sync_state','saved') as sync_state
    from public.audit_logs audit
    left join public.employee_attendance_records record
      on record.id::text=audit.record_id
    where (
      (v_category='adjustment' and audit.module='attendance_adjustment')
      or (
        v_category='attendance'
        and audit.module in ('attendance','attendance_entry','leave')
      )
    )

    union all

    select
      'record:'||record.id::text as id,
      record.updated_at,
      coalesce(record.updated_by,record.created_by),
      record.employee_id,
      case
        when record.updated_by is not null
         and record.updated_by<>record.created_by then 'update'
        else 'create'
      end,
      record.id::text,
      record.event_date,
      record.event_kind,
      record.amount,
      record.currency,
      record.reason,
      record.note,
      coalesce(record.sync_origin,'backend'),
      coalesce(record.raw_values->>'google_sync_state','saved')
    from public.employee_attendance_records record
    where (
      (v_category='adjustment' and record.kind='adjustment')
      or (v_category='attendance' and record.kind='attendance')
    )
      and coalesce(record.updated_by,record.created_by) is not null
      and not exists (
        select 1
        from public.audit_logs audit
        where audit.record_id=record.id::text
          and (
            (
              v_category='adjustment'
              and audit.module='attendance_adjustment'
            )
            or (
              v_category='attendance'
              and audit.module in ('attendance','attendance_entry','leave')
            )
          )
      )
  ), scoped as (
    select
      entry.*,
      employee.employee_no,
      employee.full_name,
      coalesce(
        nullif(access.login_username,''),
        nullif(access.login_email,''),
        '系统 / 外部同步'
      ) as actor_name
    from entries entry
    join public.employees employee on employee.id=entry.employee_id
    left join public.user_access access
      on access.auth_user_id=entry.actor_user_id
    where public.can_manage_employee(entry.employee_id)
      and (
        v_category<>'adjustment'
        or (v_can_bonus and v_can_deduction)
        or attendance_private.adjustment_visibility_kind(
          entry.event_kind,entry.amount
        )=case when v_can_bonus then 'bonus' else 'deduction' end
      )
  ), filtered as materialized (
    select *
    from scoped entry
    where (p_date_from is null or entry.created_at>=p_date_from::timestamptz)
      and (p_date_to is null or entry.created_at<(p_date_to+1)::timestamptz)
      and (
        v_search=''
        or lower(coalesce(entry.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(entry.full_name,'')) like '%'||v_search||'%'
        or lower(coalesce(entry.actor_name,'')) like '%'||v_search||'%'
        or lower(coalesce(entry.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(entry.note,'')) like '%'||v_search||'%'
      )
  ), paged as (
    select entry.*
    from filtered entry
    order by entry.created_at desc,entry.id desc
    limit v_size offset (v_page-1)*v_size
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(to_jsonb(paged) order by created_at desc,id desc)
      from paged
    ),'[]'::jsonb)
  into v_total,v_rows;

  return jsonb_build_object(
    'category',v_category,
    'rows',v_rows,
    'total',v_total,
    'page',v_page,
    'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1)
  );
end;
$$;

revoke all on function public.admin_data_entry_logs(
  text,text,date,date,integer,integer
) from public,anon,authenticated,service_role;
grant execute on function public.admin_data_entry_logs(
  text,text,date,date,integer,integer
) to authenticated;

comment on function public.admin_data_entry_logs(
  text,text,date,date,integer,integer
) is
  'Returns scoped entry logs and filters adjustment categories before aggregation and pagination.';

-- Editor lookup data is itself sensitive: a caller needs a mutation permission
-- and at least one adjustment category.  This is UX hardening only; the write
-- RPC below remains the final authorization boundary.
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
begin
  if not (
       public.has_permission('adjustment.page.create')
       or public.has_permission('adjustment.page.edit')
     )
     or not (
       public.has_permission('adjustment.bonus.view')
       or public.has_permission('adjustment.deduction.view')
     ) then
    raise exception 'permission_denied';
  end if;
  return public.admin_adjustment_editor_options_page_v1(p_search,p_limit);
end;
$$;

-- Reject unauthorized categories before invoking the legacy transactional
-- writer.  The wrapper performs SELECT-only validation, so every rejection
-- happens before a business row, audit row or outbox item can be written.
-- Editing requires both the current category and the requested target
-- category.  Therefore changing bonus <-> deduction requires both grants.
create or replace function public.admin_adjustment_upsert(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_id_text text;
  v_id uuid;
  v_target_amount numeric;
  v_target_kind text;
  v_current_kind text;
  v_can_bonus boolean:=public.has_permission('adjustment.bonus.view');
  v_can_deduction boolean:=public.has_permission('adjustment.deduction.view');
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'invalid_payload';
  end if;

  v_id_text:=nullif(btrim(coalesce(p_payload->>'id','')),'');
  if v_id_text is null then
    if not public.has_permission('adjustment.page.create') then
      raise exception 'permission_denied';
    end if;
  elsif not public.has_permission('adjustment.page.edit') then
    raise exception 'permission_denied';
  end if;

  begin
    v_target_amount:=round((p_payload->>'amount')::numeric,2);
  exception when others then
    raise exception 'invalid_amount';
  end;
  if v_target_amount is null
     or v_target_amount=0
     or abs(v_target_amount)>100000000 then
    raise exception 'invalid_amount';
  end if;
  v_target_kind:=case when v_target_amount>0 then 'bonus' else 'deduction' end;

  if (v_target_kind='bonus' and not v_can_bonus)
     or (v_target_kind='deduction' and not v_can_deduction) then
    raise exception 'permission_denied';
  end if;

  if v_id_text is not null then
    begin
      v_id:=v_id_text::uuid;
    exception when invalid_text_representation then
      raise exception 'invalid_record_id';
    end;

    select attendance_private.adjustment_visibility_kind(
      record.event_kind,record.amount
    )
    into v_current_kind
    from public.employee_attendance_records record
    where record.id=v_id
      and record.kind='adjustment';

    if v_current_kind is null then
      -- A category-limited caller must not learn whether an arbitrary UUID is
      -- absent or belongs to the hidden category.
      if not (v_can_bonus and v_can_deduction) then
        raise exception 'permission_denied';
      end if;
    elsif (v_current_kind='bonus' and not v_can_bonus)
       or (v_current_kind='deduction' and not v_can_deduction)
       or (v_current_kind='unclassified' and not (v_can_bonus and v_can_deduction)) then
      raise exception 'permission_denied';
    end if;
  end if;

  return public.admin_adjustment_upsert_page_v1(p_payload);
end;
$$;

revoke all on function public.admin_adjustment_editor_options(text,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.admin_adjustment_upsert(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.admin_adjustment_editor_options(text,integer)
  to authenticated,service_role;
grant execute on function public.admin_adjustment_upsert(jsonb)
  to authenticated,service_role;

comment on function public.admin_adjustment_editor_options(text,integer) is
  'Returns adjustment editor options only to a writer with at least one visible category.';
comment on function public.admin_adjustment_upsert(jsonb) is
  'Creates or edits a managed adjustment after checking generic write plus current and target category permissions.';

notify pgrst,'reload schema';

commit;
