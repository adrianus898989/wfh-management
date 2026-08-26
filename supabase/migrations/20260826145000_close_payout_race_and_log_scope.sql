-- One employee may have only one unfinished payment-details change. Approval
-- does not finish a manual workflow: the request stays open until the saved
-- profile matches the approved values. This prevents two approved requests
-- from racing and producing a false mismatch warning.

drop index if exists public.payout_change_requests_one_pending_per_employee_idx;

create unique index if not exists payout_change_requests_one_open_per_employee_idx
  on public.payout_change_requests(employee_id)
  where status = 'pending'
     or (
       status = 'approved'
       and fulfillment_status in ('awaiting_review', 'pending_manual', 'mismatch')
     );

create or replace function payment_change_private.guard_one_open_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (
    new.status = 'pending'
    or (
      new.status = 'approved'
      and new.fulfillment_status in ('awaiting_review', 'pending_manual', 'mismatch')
    )
  ) and exists (
    select 1
    from public.payout_change_requests request
    where request.employee_id = new.employee_id
      and request.id is distinct from new.id
      and (
        request.status = 'pending'
        or (
          request.status = 'approved'
          and request.fulfillment_status in (
            'awaiting_review', 'pending_manual', 'mismatch'
          )
        )
      )
  ) then
    raise exception 'pending_request_exists';
  end if;

  return new;
end;
$$;

revoke all on function payment_change_private.guard_one_open_request()
  from public, anon, authenticated;

drop trigger if exists payout_change_one_open_request_guard
  on public.payout_change_requests;
create trigger payout_change_one_open_request_guard
before insert or update of employee_id, status, fulfillment_status
on public.payout_change_requests
for each row execute function payment_change_private.guard_one_open_request();

comment on function public.staff_submit_payout_change_request(
  uuid, jsonb, jsonb, text, text, text
) is
  'Validates payout details and private proofs, then creates at most one request that remains open through manual fulfillment.';

-- Re-issue the audit RPC with strict employee scope. Records without an
-- employee_id cannot be proven to belong to a restricted manager and are
-- deliberately excluded for every caller, including broad accounts.
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
set search_path = ''
as $$
declare
  v_category text := lower(btrim(coalesce(p_category, '')));
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
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
  if v_category not in ('adjustment', 'attendance') then
    raise exception 'invalid_category';
  end if;
  if v_category = 'adjustment'
     and not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;
  if v_category = 'attendance'
     and not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;

  with entries as (
    select
      'audit:' || audit.id::text as id,
      audit.created_at,
      audit.actor_user_id,
      audit.employee_id,
      case
        when audit.action = 'create_adjustment' then 'create'
        when audit.action = 'update_adjustment' then 'update'
        else audit.action
      end as action,
      audit.record_id,
      record.event_date,
      coalesce(record.event_kind, audit.new_data->>'event_kind') as event_kind,
      coalesce(
        record.amount,
        case
          when coalesce(audit.new_data->>'amount', '')
            ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$'
          then (audit.new_data->>'amount')::numeric
          else null
        end
      ) as amount,
      coalesce(record.currency, audit.new_data->>'currency') as currency,
      coalesce(record.reason, audit.reason, audit.new_data->>'reason') as reason,
      coalesce(record.note, audit.new_data->>'note') as note,
      coalesce(record.sync_origin, 'backend') as source,
      coalesce(record.raw_values->>'google_sync_state', 'saved') as sync_state
    from public.audit_logs audit
    left join public.employee_attendance_records record
      on record.id::text = audit.record_id
    where (
      (v_category = 'adjustment' and audit.module = 'attendance_adjustment')
      or (
        v_category = 'attendance'
        and audit.module in ('attendance', 'attendance_entry', 'leave')
      )
    )

    union all

    select
      'record:' || record.id::text as id,
      record.updated_at,
      coalesce(record.updated_by, record.created_by),
      record.employee_id,
      case
        when record.updated_by is not null
         and record.updated_by <> record.created_by then 'update'
        else 'create'
      end,
      record.id::text,
      record.event_date,
      record.event_kind,
      record.amount,
      record.currency,
      record.reason,
      record.note,
      coalesce(record.sync_origin, 'backend'),
      coalesce(record.raw_values->>'google_sync_state', 'saved')
    from public.employee_attendance_records record
    where (
      (v_category = 'adjustment' and record.kind = 'adjustment')
      or (v_category = 'attendance' and record.kind = 'attendance')
    )
      and coalesce(record.updated_by, record.created_by) is not null
      and not exists (
        select 1
        from public.audit_logs audit
        where audit.record_id = record.id::text
          and (
            (
              v_category = 'adjustment'
              and audit.module = 'attendance_adjustment'
            )
            or (
              v_category = 'attendance'
              and audit.module in ('attendance', 'attendance_entry', 'leave')
            )
          )
      )
  ), scoped as (
    select
      entry.*,
      employee.employee_no,
      employee.full_name,
      coalesce(
        nullif(access.login_username, ''),
        nullif(access.login_email, ''),
        '系统 / 外部同步'
      ) as actor_name
    from entries entry
    join public.employees employee on employee.id = entry.employee_id
    left join public.user_access access
      on access.auth_user_id = entry.actor_user_id
    where public.can_manage_employee(entry.employee_id)
  ), filtered as materialized (
    select *
    from scoped entry
    where (p_date_from is null or entry.created_at >= p_date_from::timestamptz)
      and (p_date_to is null or entry.created_at < (p_date_to + 1)::timestamptz)
      and (
        v_search = ''
        or lower(coalesce(entry.employee_no, '')) like '%' || v_search || '%'
        or lower(coalesce(entry.full_name, '')) like '%' || v_search || '%'
        or lower(coalesce(entry.actor_name, '')) like '%' || v_search || '%'
        or lower(coalesce(entry.reason, '')) like '%' || v_search || '%'
        or lower(coalesce(entry.note, '')) like '%' || v_search || '%'
      )
  ), paged as (
    select entry.*
    from filtered entry
    order by entry.created_at desc, entry.id desc
    limit v_size offset (v_page - 1) * v_size
  )
  select
    (select count(*) from filtered),
    coalesce((
      select jsonb_agg(to_jsonb(paged) order by created_at desc, id desc)
      from paged
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object(
    'category', v_category,
    'rows', v_rows,
    'total', v_total,
    'page', v_page,
    'page_size', v_size,
    'pages', greatest(ceil(v_total::numeric / v_size)::integer, 1)
  );
end;
$$;

revoke all on function public.admin_data_entry_logs(
  text, text, date, date, integer, integer
) from public, anon, authenticated;
grant execute on function public.admin_data_entry_logs(
  text, text, date, date, integer, integer
) to authenticated;

comment on function public.admin_data_entry_logs(
  text, text, date, date, integer, integer
) is
  'Returns only employee-linked backend entry logs inside the caller management scope.';

notify pgrst, 'reload schema';
