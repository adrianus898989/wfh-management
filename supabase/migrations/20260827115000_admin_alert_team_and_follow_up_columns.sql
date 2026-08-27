begin;

-- Keep the granular page wrapper as the only browser-callable alert reader.
-- Its private implementation already applies alert-type and employee-scope
-- filtering; enrich only those already-scoped rows with the employee's latest
-- team so this join cannot introduce an otherwise invisible employee.
create or replace function public.admin_alert_center(
  p_filters jsonb default '{}'::jsonb,
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
  v_result jsonb;
  v_rows jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('alert.view') then
    raise exception 'permission_denied';
  end if;

  -- alert.view grants the page shell only. Preserve the existing fail-closed
  -- behavior when the account has no permission for any individual alert type.
  if not (
    alerts_private.caller_can_view_alert_type('payout_change')
    or alerts_private.caller_can_view_alert_type('resigned_account_active')
    or alerts_private.caller_can_view_alert_type('today_missing_clock_in')
    or alerts_private.caller_can_view_alert_type('today_missing_daily_report')
    or alerts_private.caller_can_view_alert_type('leave_activity')
    or alerts_private.caller_can_view_alert_type('late_timeout_frequency')
    or alerts_private.caller_can_view_alert_type('consecutive_rest')
    or alerts_private.caller_can_view_alert_type('weekly_absence')
    or alerts_private.caller_can_view_alert_type('monthly_leave')
    or alerts_private.caller_can_view_alert_type('error_spike')
    or alerts_private.caller_can_view_alert_type('repeated_error')
    or alerts_private.caller_can_view_alert_type('deduction_frequency')
    or alerts_private.caller_can_view_alert_type('exam_failed')
    or alerts_private.caller_can_view_alert_type('low_workload_streak')
  ) then
    return jsonb_build_object(
      'page', least(greatest(coalesce(p_page, 1), 1), 1000000),
      'page_size', least(greatest(coalesce(p_page_size, 30), 1), 100),
      'total', 0,
      'pages', 1,
      'active_total', 0,
      'unread_total', 0,
      'type_counts', '{}'::jsonb,
      'rows', '[]'::jsonb
    );
  end if;

  v_result := public.admin_alert_center_page_v1(
    p_filters,
    p_page,
    p_page_size
  );

  select coalesce(
    jsonb_agg(
      item.row_data || jsonb_build_object(
        'team_name', coalesce(
          nullif(btrim(team.name), ''),
          nullif(btrim(employee.group_name), ''),
          ''
        )
      )
      order by item.ordinality
    ),
    '[]'::jsonb
  )
  into v_rows
  from jsonb_array_elements(
    coalesce(v_result->'rows', '[]'::jsonb)
  ) with ordinality as item(row_data, ordinality)
  left join public.employees employee
    on employee.id::text = nullif(item.row_data->>'employee_id', '')
  left join public.teams team
    on team.id = employee.team_id;

  return jsonb_set(v_result, '{rows}', v_rows, true);
end;
$$;

revoke all on function public.admin_alert_center(jsonb, integer, integer)
  from public, anon;
grant execute on function public.admin_alert_center(jsonb, integer, integer)
  to authenticated, service_role;

comment on function public.admin_alert_center(jsonb, integer, integer) is
  'Returns granularly authorized alert rows enriched with the current employee team; readers and follow-up handling remain separate fields.';

-- Keep the granular workflow implementation as the state-transition owner,
-- then record every successful confirmation/handling in the shared backend
-- audit stream. The insert intentionally has no exception-swallowing block:
-- an audit failure rolls the follow-up change back in the same transaction.
create or replace function public.admin_alert_update_follow_up(
  p_alert_id uuid,
  p_action text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_user_id uuid := auth.uid();
  v_action text := lower(btrim(coalesce(p_action,'')));
  v_result jsonb;
  v_employee_id uuid;
  v_actor_name text;
  v_result_summary text;
begin
  if v_user_id is null then raise exception 'not_authenticated'; end if;
  if not session_private.current_app_session_is_valid('admin') then
    raise exception 'session_not_current';
  end if;
  if not public.has_permission('alert.follow_up') then
    raise exception 'permission_denied';
  end if;

  -- page_v1 retains action validation, alert-type permission, employee scope,
  -- row locking, confirmation ordering and note-length enforcement.
  v_result := public.admin_alert_update_follow_up_page_v1(
    p_alert_id,p_action,p_note
  );

  select event.employee_id into v_employee_id
  from public.admin_alert_events event
  where event.id = p_alert_id;
  select coalesce(
    nullif(btrim(access.login_username),''),
    nullif(btrim(access.login_email),''),
    left(v_user_id::text,8)
  ) into v_actor_name
  from public.user_access access
  where access.auth_user_id = v_user_id;
  v_actor_name := coalesce(v_actor_name,left(v_user_id::text,8));
  v_result_summary := left(coalesce(
    nullif(btrim(v_result#>>'{follow_up,handling_note}'),''),
    case when v_action = 'confirm' then '确认接手跟进' else '已完成跟进' end
  ),500);

  insert into public.audit_logs(
    actor_user_id,employee_id,module,action,record_id,
    old_data,new_data,reason
  ) values (
    v_user_id,v_employee_id,'alerts',
    case when v_action = 'confirm' then 'follow_up_confirm' else 'follow_up_handle' end,
    p_alert_id::text,null,
    jsonb_build_object(
      'actor',v_actor_name,
      'status',v_result#>>'{follow_up,status}',
      'result_summary',v_result_summary
    ),
    v_result_summary
  );

  return v_result;
end;
$$;

revoke all on function public.admin_alert_update_follow_up(uuid,text,text)
  from public,anon;
grant execute on function public.admin_alert_update_follow_up(uuid,text,text)
  to authenticated,service_role;

comment on function public.admin_alert_update_follow_up(uuid,text,text) is
  'Runs the granular alert follow-up transition and atomically records it in audit_logs.';

notify pgrst, 'reload schema';

commit;
