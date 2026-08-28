begin;

-- Applicant portal identifiers are authentication secrets/context, not payroll
-- history.  Keep the scoped review contract while returning only business data.
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
set search_path = ''
as $$
declare
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_search text := lower(btrim(coalesce(p_search,'')));
  v_page integer := greatest(coalesce(p_page,1),1);
  v_size integer := least(greatest(coalesce(p_page_size,20),1),100);
  v_total bigint;
  v_rows jsonb;
  v_auto_apply_enabled boolean := false;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not (
    public.has_permission('payroll.payout_change.view')
    or public.has_permission('payroll.payout_change.review')
  ) then raise exception 'permission_denied'; end if;
  if v_status <> '' and v_status not in ('pending','approved','rejected','cancelled') then
    raise exception 'invalid_status';
  end if;

  select coalesce(setting.auto_apply_enabled,false)
  into v_auto_apply_enabled
  from payment_change_private.workflow_settings setting
  where setting.singleton;

  select count(*) into v_total
  from public.payout_change_requests request
  join public.employees employee on employee.id = request.employee_id
  left join public.teams team on team.id = employee.team_id
  left join public.positions position on position.id = employee.position_id
  where (v_status = '' or request.status = v_status)
    and public.can_manage_employee(request.employee_id)
    and (
      v_search = ''
      or lower(coalesce(employee.employee_no,'')) like '%'||v_search||'%'
      or lower(coalesce(employee.full_name,'')) like '%'||v_search||'%'
      or lower(coalesce(team.name,'')) like '%'||v_search||'%'
      or lower(coalesce(position.name,'')) like '%'||v_search||'%'
      or lower(coalesce(request.reason,'')) like '%'||v_search||'%'
      or lower(coalesce(request.review_note,'')) like '%'||v_search||'%'
    );

  select coalesce(jsonb_agg(to_jsonb(row_data) order by row_data.created_at desc),'[]'::jsonb)
  into v_rows
  from (
    select
      request.id,request.employee_id,employee.employee_no,
      employee.hire_date as employee_hire_date,
      employee.full_name as employee_name,employee.employment_type,
      coalesce(nullif(btrim(employee.country),''),nullif(btrim(employee.nationality),'')) as country,
      employee.status as employee_status,team.name as team_name,position.name as position_name,
      request.payment_kind,request.old_data,request.new_data,request.reason,
      request.identity_proof_path,request.payment_proof_path,request.status,request.review_note,
      request.created_at,request.reviewed_at,request.fulfillment_status,request.fulfilled_at,
      request.fulfillment_checked_at,request.auto_applied,
      case
        when strpos(btrim(coalesce(reviewer.login_username,'')),'@') = 0
          then nullif(btrim(reviewer.login_username),'')
        else null
      end as reviewed_by,
      coalesce(
        case
          when strpos(btrim(coalesce(manual_fulfillment.actor_username,'')),'@') = 0
            then nullif(btrim(manual_fulfillment.actor_username),'')
          else null
        end,
        case
          when strpos(btrim(coalesce(fulfiller.login_username,'')),'@') = 0
            then nullif(btrim(fulfiller.login_username),'')
          else null
        end
      ) as fulfilled_by,
      payment_change_private.profile_match_state(
        request.employee_id,request.payment_kind,request.old_data,request.new_data
      ) as current_match_state
    from public.payout_change_requests request
    join public.employees employee on employee.id = request.employee_id
    left join public.teams team on team.id = employee.team_id
    left join public.positions position on position.id = employee.position_id
    left join public.user_access reviewer on reviewer.auth_user_id = request.reviewed_by
    left join public.user_access fulfiller on fulfiller.auth_user_id = request.fulfilled_by
    left join lateral (
      select audit.actor_username
      from public.employee_audit_logs audit
      where audit.employee_id = request.employee_id
        and request.fulfilled_at is not null
        and audit.created_at between request.fulfilled_at - interval '1 day'
                                 and request.fulfilled_at + interval '1 day'
        and (
          (
            request.payment_kind = 'bank_wallet'
            and (
              audit.changes ? 'payment.transfer_using'
              or audit.changes ? 'payment.gcash_name'
              or audit.changes ? 'payment.gcash_account'
            )
            and (
              not (audit.changes ? 'payment.transfer_using')
              or btrim(coalesce(audit.changes->'payment.transfer_using'->>'after',''))
                = btrim(coalesce(request.new_data->>'transfer_using',''))
            )
            and (
              not (audit.changes ? 'payment.gcash_name')
              or btrim(coalesce(audit.changes->'payment.gcash_name'->>'after',''))
                = btrim(coalesce(request.new_data->>'account_name',''))
            )
            and (
              not (audit.changes ? 'payment.gcash_account')
              or btrim(coalesce(audit.changes->'payment.gcash_account'->>'after',''))
                = btrim(coalesce(request.new_data->>'account_number',''))
            )
          )
          or (
            request.payment_kind = 'usdt'
            and audit.changes ? 'payment.usdt_address'
            and btrim(coalesce(audit.changes->'payment.usdt_address'->>'after',''))
              = btrim(coalesce(request.new_data->>'usdt_address',''))
          )
        )
      order by abs(extract(epoch from (audit.created_at-request.fulfilled_at))),audit.id
      limit 1
    ) manual_fulfillment on true
    where (v_status = '' or request.status = v_status)
      and public.can_manage_employee(request.employee_id)
      and (
        v_search = ''
        or lower(coalesce(employee.employee_no,'')) like '%'||v_search||'%'
        or lower(coalesce(employee.full_name,'')) like '%'||v_search||'%'
        or lower(coalesce(team.name,'')) like '%'||v_search||'%'
        or lower(coalesce(position.name,'')) like '%'||v_search||'%'
        or lower(coalesce(request.reason,'')) like '%'||v_search||'%'
        or lower(coalesce(request.review_note,'')) like '%'||v_search||'%'
      )
    order by request.created_at desc
    limit v_size offset (v_page-1)*v_size
  ) row_data;

  return jsonb_build_object(
    'rows',v_rows,'total',v_total,'page',v_page,'page_size',v_size,
    'pages',greatest(ceil(v_total::numeric/v_size)::integer,1),
    'auto_apply_enabled',v_auto_apply_enabled,
    'fulfillment_mode',case when v_auto_apply_enabled then 'automatic' else 'manual' end
  );
end;
$$;

revoke all on function public.admin_payout_change_requests(text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.admin_payout_change_requests(text,text,integer,integer)
  to authenticated;

comment on function public.admin_payout_change_requests(text,text,integer,integer) is
  'Returns employee-scoped payout-change history without applicant portal identifiers; reviewer and fulfiller expose backend usernames only.';

notify pgrst,'reload schema';

commit;
