begin;

-- Every current sidebar child owns a unique view permission.  Action codes are
-- page-owned too, so the role editor never needs to render a linked checkbox.
with permission_rows(code, name) as (values
  ('alert.view','进入预警中心'),('alert.payout_change.view','查看收款资料修改预警'),('alert.resigned_account_active.view','查看离职账号未回收预警'),
  ('alert.today_missing_clock_in.view','查看今日未打卡预警'),('alert.today_missing_daily_report.view','查看今日无日报预警'),('alert.leave_activity.view','查看休假人员操作预警'),
  ('alert.late_timeout_frequency.view','查看迟到超时预警'),('alert.consecutive_rest.view','查看连续公休预警'),('alert.weekly_absence.view','查看一周缺席预警'),('alert.monthly_leave.view','查看月休假超限预警'),
  ('alert.error_spike.view','查看错误频率预警'),('alert.repeated_error.view','查看重复错误预警'),('alert.deduction_frequency.view','查看扣款频率预警'),('alert.exam_failed.view','查看考试不及格预警'),('alert.low_workload_streak.view','查看连续工作量低预警'),
  ('alert.mark_read','标记预警已读'),('alert.follow_up','确认及处理预警'),
  ('employee.directory.view','查看员工档案查询表'),('employee.directory.export','导出员工档案当前筛选'),('employee.directory.resign','在员工档案办理离职'),('employee.directory.reactivate','在员工档案恢复员工'),
  ('employee.directory.compensation.view','查看员工档案内工资设置'),('employee.directory.payroll_history.view','查看员工档案内已发布工资记录'),
  ('employee.resignations.view','查看离职记录表'),('employee.resignations.resign','在离职记录办理离职'),('employee.resignations.reactivate','在离职记录恢复员工'),('employee.change_history.view','查看档案变更记录'),
  ('schedule.roster.view','查看排班表'),
  ('attendance.monthly.view','查看月考勤休假记录表'),('attendance.monthly.edit','编辑月考勤休假记录'),('attendance.monthly.export','导出月考勤休假记录'),
  ('attendance.today.view','查看今日考勤'),('attendance.today.edit','编辑今日考勤'),
  ('attendance.records.view','查看日考勤打卡记录表'),('attendance.records.edit','编辑日考勤打卡记录'),('attendance.records.export','导出日考勤打卡记录'),
  ('attendance.leave.view','查看请假审批记录表'),('attendance.leave.edit','编辑请假记录'),('attendance.leave.approve','审批请假记录'),
  ('report.overview.view','查看汇总表'),('report.overview.export','导出汇总表'),('report.people.view','查看人员分布总表'),('report.people.export','导出人员分布总表'),
  ('report.legacy_schedule.view','查看报表排班明细'),('report.platform.view','查看站点人数报表'),('report.platform.export','导出站点人数报表'),
  ('report.statistics.view','查看统计表'),('report.statistics.export','导出统计表'),('report.errors.view','查看错误记录统计报表'),('report.errors.edit','编辑错误统计记录'),('report.errors.export','导出错误统计报表'),
  ('online_training.report.view','查看线上培训日报记录表'),('online_training.report.submit','提交线上培训日报'),('online_training.report.review','复核线上培训日报'),('online_training.report.manage','管理线上培训日报'),
  ('exam.overview.view','查看考试汇总表'),('exam.records.view','查看考试记录表'),('exam.records.delete','删除考试记录'),('exam.records.export','导出考试记录'),
  ('exam.question_bank.view','查看题库表'),('exam.question_bank.manage','新增及编辑题库'),('exam.question_bank.delete','删除题库内容'),('exam.grading.view','查看人工批改页'),('exam.grading.grade','执行人工批改'),
  ('adjustment.page.view','查看奖惩表'),('adjustment.page.create','新增奖惩记录'),('adjustment.page.approve','审核及编辑奖惩记录'),('adjustment.page.export','导出奖惩记录'),
  ('work.event.view','查看事件跟踪表'),('work.event.submit','提交事件跟踪'),('work.event.manage','管理事件跟踪'),('work.event.edit','编辑事件跟踪'),
  ('work.daily_inspection.view','查看每日巡视项目日报'),('work.daily_inspection.edit','编辑每日巡视项目日报'),('work.quality_inspection.view','查看质检日报'),('work.quality_inspection.edit','编辑质检日报'),
  ('payroll.pending.view','查看待发布工资表'),('payroll.pending.edit','编辑待发布工资'),('payroll.pending.approve','审核待发布工资'),('payroll.pending.publish','发布工资'),('payroll.pending.rule_edit','编辑工资规则'),
  ('payroll.published.view','查看已发布工资表'),('payroll.published.export','导出已发布工资'),('payroll.import_history.view','查看工资导入记录'),('payroll.import_history.edit','维护工资导入记录'),
  ('payroll.change_history.view','查看修改工资信息记录'),('payroll.change_history.review','审核工资信息修改'),
  ('asset.view','查看公司提供资产'),('staff_account.view','查看员工前端账号'),('staff_account.mfa_reset','重置员工前端账号 OTP'),
  ('backend_account.view','查看后台账号'),('backend_account.mfa_reset','重置后台账号 OTP'),('account.ip_allowlist.view','查看后台登录 IP 白名单'),('role.view','查看后台角色权限'),('role.audit.view','查看角色权限变更日志')
)
insert into public.permissions(code,name,category,sensitive)
select code,name,split_part(code,'.',1),
  code ~ '(delete|approve|publish|manage|edit|mfa_reset|follow_up|mark_read|resign|reactivate)$'
from permission_rows
on conflict(code) do update set name=excluded.name, category=excluded.category;

-- Source permissions describe the exact behavior available before this split.
-- Copying role grants preserves every role's current visible pages/actions.
create temporary table granular_permission_map(source_code text, target_code text) on commit drop;
insert into granular_permission_map values
  ('employee.view','employee.directory.view'),('export.general','employee.directory.export'),('employee.resign','employee.directory.resign'),('employee.reactivate','employee.directory.reactivate'),
  ('employee.view','employee.resignations.view'),('employee.resign','employee.resignations.resign'),('employee.reactivate','employee.resignations.reactivate'),('audit.view','employee.change_history.view'),
  ('payroll.view','employee.directory.compensation.view'),('payroll.view','employee.directory.payroll_history.view'),
  ('schedule.view','schedule.roster.view'),
  ('attendance.view','attendance.monthly.view'),('attendance.edit','attendance.monthly.edit'),('export.general','attendance.monthly.export'),
  ('attendance.view','attendance.today.view'),('attendance.edit','attendance.today.edit'),
  ('attendance.view','attendance.records.view'),('attendance.edit','attendance.records.edit'),('export.general','attendance.records.export'),
  ('attendance.view','attendance.leave.view'),('attendance.edit','attendance.leave.edit'),('leave.approve','attendance.leave.approve'),
  ('report.view','report.overview.view'),('export.general','report.overview.export'),('report.view','report.people.view'),('export.general','report.people.export'),
  ('report.view','report.legacy_schedule.view'),('report.view','report.platform.view'),('export.general','report.platform.export'),('report.view','report.statistics.view'),('export.general','report.statistics.export'),
  ('report.view','report.errors.view'),('report.edit','report.errors.edit'),('export.general','report.errors.export'),
  ('online_training.view','online_training.report.view'),('online_training.submit','online_training.report.submit'),('online_training.review','online_training.report.review'),('online_training.manage','online_training.report.manage'),
  ('exam.view','exam.overview.view'),('exam.view','exam.records.view'),('exam.delete','exam.records.delete'),('export.general','exam.records.export'),
  ('exam.view','exam.question_bank.view'),('exam.manage','exam.question_bank.manage'),('exam.delete','exam.question_bank.delete'),('exam.view','exam.grading.view'),('exam.grade','exam.grading.grade'),
  ('adjustment.view','adjustment.page.view'),('adjustment.create','adjustment.page.create'),('adjustment.approve','adjustment.page.approve'),('export.general','adjustment.page.export'),
  ('report.view','work.event.view'),('daily_work.submit','work.event.submit'),('daily_work.manage','work.event.manage'),('report.edit','work.event.edit'),
  ('daily_work.manage','work.daily_inspection.view'),('report.edit','work.daily_inspection.edit'),('report.edit','work.quality_inspection.view'),('report.edit','work.quality_inspection.edit'),
  ('payroll.view','payroll.pending.view'),('payroll.edit','payroll.pending.edit'),('payroll.approve','payroll.pending.approve'),('payroll.publish','payroll.pending.publish'),('payroll.rule.edit','payroll.pending.rule_edit'),
  ('payroll.view','payroll.published.view'),('payroll.export','payroll.published.export'),('payroll.view','payroll.import_history.view'),('payroll.edit','payroll.import_history.edit'),
  ('payroll.payout_change.view','payroll.change_history.view'),('payroll.payout_change.review','payroll.change_history.review'),
  ('user.view','asset.view'),('user.view','staff_account.view'),('account.mfa_reset','staff_account.mfa_reset'),('account.view','backend_account.view'),('account.mfa_reset','backend_account.mfa_reset'),
  ('account.ip_allowlist.manage','account.ip_allowlist.view'),('role.manage','role.view'),('audit.view','role.audit.view');

-- Preserve the old per-type visibility exactly. The common action permissions
-- do not confer visibility by themselves; mark/follow-up re-check the type.
insert into granular_permission_map values
  ('payroll.payout_change.review','alert.payout_change.view'),('account.view','alert.resigned_account_active.view'),('user.view','alert.resigned_account_active.view'),
  ('attendance.view','alert.today_missing_clock_in.view'),('daily_work.manage','alert.today_missing_daily_report.view'),('attendance.view','alert.leave_activity.view'),
  ('adjustment.view','alert.late_timeout_frequency.view'),('attendance.view','alert.consecutive_rest.view'),('attendance.view','alert.weekly_absence.view'),('attendance.view','alert.monthly_leave.view'),
  ('report.view','alert.error_spike.view'),('report.view','alert.repeated_error.view'),('adjustment.view','alert.deduction_frequency.view'),('exam.view','alert.exam_failed.view'),('daily_work.manage','alert.low_workload_streak.view');
insert into granular_permission_map(source_code,target_code)
select source_code,target_code from (values
  ('payroll.payout_change.review'),('report.view'),('adjustment.view'),('attendance.view'),('daily_work.manage'),('exam.view'),('account.view'),('user.view')
) source(source_code) cross join (values ('alert.view'),('alert.mark_read'),('alert.follow_up')) target(target_code);

insert into public.role_permissions(role_id,permission_id)
select distinct source_grant.role_id,target.id
from public.role_permissions source_grant
join public.permissions source on source.id=source_grant.permission_id
join granular_permission_map mapping on mapping.source_code=source.code
join public.permissions target on target.code=mapping.target_code
on conflict(role_id,permission_id) do nothing;

-- Reconstruct each user's old effective result (override first, role second),
-- then store only the target override needed to differ from the migrated role.
with users_and_targets as (
  select access.auth_user_id,access.role_id,mapping.target_code
  from public.user_access access cross join (select distinct target_code from granular_permission_map) mapping
  where access.backend_enabled
), effective as (
  select pair.auth_user_id,pair.role_id,pair.target_code,
    bool_or(coalesce(override.allowed,source_role.permission_id is not null)) effective_allowed
  from users_and_targets pair
  join granular_permission_map mapping on mapping.target_code=pair.target_code
  join public.permissions source on source.code=mapping.source_code
  left join public.role_permissions source_role on source_role.role_id=pair.role_id and source_role.permission_id=source.id
  left join public.user_permission_overrides override on override.auth_user_id=pair.auth_user_id and override.permission_id=source.id
  group by pair.auth_user_id,pair.role_id,pair.target_code
), target_state as (
  select effective.*,target.id target_id,(target_role.permission_id is not null) role_allowed
  from effective join public.permissions target on target.code=effective.target_code
  left join public.role_permissions target_role on target_role.role_id=effective.role_id and target_role.permission_id=target.id
)
insert into public.user_permission_overrides(auth_user_id,permission_id,allowed)
select auth_user_id,target_id,effective_allowed from target_state
where effective_allowed is distinct from role_allowed
on conflict(auth_user_id,permission_id) do nothing;

-- New alert permissions are enforced at the database boundary. Existing type
-- scope remains employee-scoped, but alert.view now owns type visibility.
create or replace function alerts_private.caller_can_view_alert_type(p_alert_type text)
returns boolean language sql stable security definer set search_path='' as $$
  select public.has_permission('alert.view') and case lower(btrim(coalesce(p_alert_type,'')))
    when 'payout_change' then public.has_permission('alert.payout_change.view')
    when 'resigned_account_active' then public.has_permission('alert.resigned_account_active.view')
    when 'today_missing_clock_in' then public.has_permission('alert.today_missing_clock_in.view')
    when 'today_missing_daily_report' then public.has_permission('alert.today_missing_daily_report.view')
    when 'leave_activity' then public.has_permission('alert.leave_activity.view')
    when 'late_timeout_frequency' then public.has_permission('alert.late_timeout_frequency.view')
    when 'consecutive_rest' then public.has_permission('alert.consecutive_rest.view')
    when 'weekly_absence' then public.has_permission('alert.weekly_absence.view')
    when 'monthly_leave' then public.has_permission('alert.monthly_leave.view')
    when 'error_spike' then public.has_permission('alert.error_spike.view')
    when 'repeated_error' then public.has_permission('alert.repeated_error.view')
    when 'deduction_frequency' then public.has_permission('alert.deduction_frequency.view')
    when 'exam_failed' then public.has_permission('alert.exam_failed.view')
    when 'low_workload_streak' then public.has_permission('alert.low_workload_streak.view')
    else false end;
$$;
revoke all on function alerts_private.caller_can_view_alert_type(text) from public,anon,authenticated;

alter function public.admin_alert_center(jsonb,integer,integer) rename to admin_alert_center_page_v1;
revoke all on function public.admin_alert_center_page_v1(jsonb,integer,integer) from public,anon,authenticated;
do $alert_permission_bridge$
declare
  v_definition text;
  v_old text := $guard$
  if not (
    public.has_permission('payroll.payout_change.review')
    or public.has_permission('report.view')
    or public.has_permission('adjustment.view')
    or public.has_permission('attendance.view')
    or public.has_permission('daily_work.manage')
    or public.has_permission('exam.view')
    or public.has_permission('account.view')
    or public.has_permission('user.view')
  ) then raise exception 'permission_denied'; end if;$guard$;
begin
  select pg_get_functiondef('public.admin_alert_center_page_v1(jsonb,integer,integer)'::regprocedure)
    into v_definition;
  if strpos(v_definition,v_old) = 0 then
    raise exception 'admin_alert_center_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,v_old,
    E'\n  if not public.has_permission(''alert.view'') then raise exception ''permission_denied''; end if;');
end;
$alert_permission_bridge$;
create function public.admin_alert_center(p_filters jsonb default '{}'::jsonb,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('alert.view') then raise exception 'permission_denied'; end if;
  -- alert.view grants the page shell only. If no alert type is selected, avoid
  -- entering the legacy reader's broad prerequisite and return an empty page.
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
    if auth.uid() is null then raise exception 'not_authenticated'; end if;
    if not session_private.current_app_session_is_valid('admin') then raise exception 'session_not_current'; end if;
    return jsonb_build_object(
      'page',least(greatest(coalesce(p_page,1),1),1000000),
      'page_size',least(greatest(coalesce(p_page_size,30),1),100),
      'total',0,'pages',1,'active_total',0,'unread_total',0,
      'type_counts','{}'::jsonb,'rows','[]'::jsonb
    );
  end if;
  return public.admin_alert_center_page_v1(p_filters,p_page,p_page_size);
end $$;
revoke all on function public.admin_alert_center(jsonb,integer,integer) from public,anon;
grant execute on function public.admin_alert_center(jsonb,integer,integer) to authenticated,service_role;

alter function public.admin_alert_mark_read(uuid) rename to admin_alert_mark_read_page_v1;
revoke all on function public.admin_alert_mark_read_page_v1(uuid) from public,anon,authenticated;
create function public.admin_alert_mark_read(p_alert_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.has_permission('alert.mark_read') then raise exception 'permission_denied'; end if;
  return public.admin_alert_mark_read_page_v1(p_alert_id);
end $$;
revoke all on function public.admin_alert_mark_read(uuid) from public,anon;
grant execute on function public.admin_alert_mark_read(uuid) to authenticated,service_role;

alter function public.admin_alert_update_follow_up(uuid,text,text) rename to admin_alert_update_follow_up_page_v1;
revoke all on function public.admin_alert_update_follow_up_page_v1(uuid,text,text) from public,anon,authenticated;
create function public.admin_alert_update_follow_up(p_alert_id uuid,p_action text,p_note text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.has_permission('alert.follow_up') then raise exception 'permission_denied'; end if;
  return public.admin_alert_update_follow_up_page_v1(p_alert_id,p_action,p_note);
end $$;
revoke all on function public.admin_alert_update_follow_up(uuid,text,text) from public,anon;
grant execute on function public.admin_alert_update_follow_up(uuid,text,text) to authenticated,service_role;

-- The roster reader keeps the identity matching and query-performance work
-- delivered by the earlier schedule migration. Rename that implementation and
-- put the new page permission at the only browser-callable boundary.
alter function public.admin_attendance_schedule(jsonb) rename to admin_attendance_schedule_page_v1;
revoke all on function public.admin_attendance_schedule_page_v1(jsonb) from public,anon,authenticated;
do $schedule_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_attendance_schedule_page_v1(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'''schedule.view''')=0 then
    raise exception 'admin_attendance_schedule_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,'''schedule.view''','''schedule.roster.view''');
end
$schedule_permission_bridge$;
create function public.admin_attendance_schedule(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('schedule.roster.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_schedule_page_v1(p_filters);
end $$;
revoke all on function public.admin_attendance_schedule(jsonb) from public,anon;
grant execute on function public.admin_attendance_schedule(jsonb) to authenticated,service_role;

-- Attendance list readers previously shared admin_attendance_home. Remove its
-- browser grant and expose one permission-checked RPC per current page.
revoke all on function public.admin_attendance_home(jsonb) from public,anon,authenticated;
do $attendance_permission_bridge$
declare
  v_definition text;
  v_old_attendance text := $guard$if v_scope='attendance' and not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_new_attendance text := $guard$if v_scope='attendance' and not (
    public.has_permission('attendance.today.view')
    or public.has_permission('attendance.records.view')
    or public.has_permission('attendance.leave.view')
  ) then
    raise exception 'permission_denied';
  end if;$guard$;
  v_old_adjustment text := $guard$if v_scope='adjustment' and not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_new_adjustment text := $guard$if v_scope='adjustment' and not public.has_permission('adjustment.page.view') then
    raise exception 'permission_denied';
  end if;$guard$;
begin
  select pg_get_functiondef('attendance_private.admin_attendance_home(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,v_old_attendance)=0 or strpos(v_definition,v_old_adjustment)=0 then
    raise exception 'admin_attendance_home_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,v_old_attendance,v_new_attendance),v_old_adjustment,v_new_adjustment);
end
$attendance_permission_bridge$;
revoke all on function attendance_private.admin_attendance_home(jsonb) from public,anon,authenticated;
create function public.admin_attendance_page_filters(p_filters jsonb,p_forced jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'employee_no',p_filters->'employee_no','employee_name',p_filters->'employee_name','full_name',p_filters->'full_name',
    'status',p_filters->'status','source_group',p_filters->'source_group','team',p_filters->'team','position',p_filters->'position',
    'country',p_filters->'country','platform',p_filters->'platform','manager',p_filters->'manager','event_kind',p_filters->'event_kind',
    'date_from',p_filters->'date_from','date_to',p_filters->'date_to','page',p_filters->'page','page_size',p_filters->'page_size'
  )) || coalesce(p_forced,'{}'::jsonb) || jsonb_build_object('include_mirrors',false);
$$;
create function public.admin_attendance_page_projection(p_result jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r->'id','employee_id',r->'employee_id','employee_no',r->'employee_no','employee_code',r->'employee_code',
      'full_name',r->'full_name','employee_name',r->'employee_name','employee_status',r->'employee_status',
      'hire_date',r->'hire_date','country',r->'country','nationality',r->'nationality','employment_type',r->'employment_type','source_group',r->'source_group',
      'team_name',r->'team_name','group_name',r->'group_name','position_name',r->'position_name','shift_name',r->'shift_name',
      'shift_display',r->'shift_display','shift_bucket',r->'shift_bucket','platform',r->'platform','manager',r->'manager','responsible',r->'responsible',
      'event_date',r->'event_date','event_kind',r->'event_kind','amount',r->'amount','raw_amount',r->'raw_amount',
      'reason',r->'reason','note',r->'note','needs_review',r->'needs_review','sync_revision',r->'sync_revision',
      'raw_values',jsonb_strip_nulls(jsonb_build_object('sync_protocol',r#>'{raw_values,sync_protocol}','external_id',r#>'{raw_values,external_id}',
        'google_sync_state',r#>'{raw_values,google_sync_state}','revision',r#>'{raw_values,revision}','currency',r#>'{raw_values,currency}',
        'workbook_key',r#>'{raw_values,workbook_key}','source_month',r#>'{raw_values,source_month}','category',r#>'{raw_values,category}'))
    )) from jsonb_array_elements(coalesce(p_result->'rows','[]'::jsonb)) r),'[]'::jsonb),
    'total',coalesce(p_result->'total','0'::jsonb),'page',coalesce(p_result->'page','1'::jsonb),'pages',coalesce(p_result->'pages','1'::jsonb),
    'page_size',coalesce(p_result->'page_size','30'::jsonb),'scope',p_result->'scope','summary',coalesce(p_result->'summary','{}'::jsonb),
    'options',coalesce(p_result->'options','{}'::jsonb),'sync_status',p_result->'sync_status','last_synced_at',p_result->'last_synced_at','refreshed_at',p_result->'refreshed_at'
  );
$$;
revoke all on function public.admin_attendance_page_filters(jsonb,jsonb),public.admin_attendance_page_projection(jsonb) from public,anon,authenticated;
create function public.admin_attendance_today_page(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('attendance.today.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_page_projection(public.admin_attendance_home(public.admin_attendance_page_filters(coalesce(p_filters,'{}'::jsonb),jsonb_build_object('scope','attendance','date_from',(now() at time zone 'Asia/Manila')::date,'date_to',(now() at time zone 'Asia/Manila')::date))));
end $$;
create function public.admin_attendance_records_page(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('attendance.records.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_page_projection(public.admin_attendance_home(public.admin_attendance_page_filters(coalesce(p_filters,'{}'::jsonb),jsonb_build_object('scope','attendance'))));
end $$;
create function public.admin_attendance_leave_page(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('attendance.leave.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_page_projection(public.admin_attendance_home(public.admin_attendance_page_filters(coalesce(p_filters,'{}'::jsonb),jsonb_build_object('scope','attendance','event_kind','leave'))));
end $$;
create function public.admin_adjustment_page(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('adjustment.page.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_page_projection(public.admin_attendance_home(public.admin_attendance_page_filters(coalesce(p_filters,'{}'::jsonb),jsonb_build_object('scope','adjustment'))));
end $$;
revoke all on function public.admin_attendance_today_page(jsonb),public.admin_attendance_records_page(jsonb),public.admin_attendance_leave_page(jsonb),public.admin_adjustment_page(jsonb) from public,anon,authenticated;
grant execute on function public.admin_attendance_today_page(jsonb),public.admin_attendance_records_page(jsonb),public.admin_attendance_leave_page(jsonb),public.admin_adjustment_page(jsonb) to authenticated,service_role;

revoke all on function public.admin_attendance_monthly(jsonb) from public,anon,authenticated;
do $attendance_monthly_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('attendance_private.admin_attendance_monthly(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'''attendance.view''')=0 then
    raise exception 'admin_attendance_monthly_permission_guard_prerequisite_changed';
  end if;
  execute replace(v_definition,'''attendance.view''','''attendance.monthly.view''');
end
$attendance_monthly_permission_bridge$;
revoke all on function attendance_private.admin_attendance_monthly(jsonb) from public,anon,authenticated;
create function public.admin_attendance_monthly_page(p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('attendance.monthly.view') then raise exception 'permission_denied'; end if;
  return public.admin_attendance_monthly(p_filters);
end $$;
revoke all on function public.admin_attendance_monthly_page(jsonb) from public,anon,authenticated;
grant execute on function public.admin_attendance_monthly_page(jsonb) to authenticated,service_role;

-- Employee archive entry logs are subordinate to change history and the exact
-- attendance or adjustment page that supplies the logged data.
do $data_entry_log_permission_bridge$
declare
  v_definition text;
  v_old_audit text := $guard$if not public.has_permission('audit.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_new_audit text := $guard$if not public.has_permission('employee.change_history.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_old_adjustment text := $guard$if v_category = 'adjustment'
     and not public.has_permission('adjustment.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_new_adjustment text := $guard$if v_category = 'adjustment'
     and not public.has_permission('adjustment.page.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_old_attendance text := $guard$if v_category = 'attendance'
     and not public.has_permission('attendance.view') then
    raise exception 'permission_denied';
  end if;$guard$;
  v_new_attendance text := $guard$if v_category = 'attendance'
     and not (
       public.has_permission('attendance.monthly.view')
       or public.has_permission('attendance.today.view')
       or public.has_permission('attendance.records.view')
       or public.has_permission('attendance.leave.view')
     ) then
    raise exception 'permission_denied';
  end if;$guard$;
begin
  select pg_get_functiondef('public.admin_data_entry_logs(text,text,date,date,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,v_old_audit)=0 or strpos(v_definition,v_old_adjustment)=0 or strpos(v_definition,v_old_attendance)=0 then
    raise exception 'admin_data_entry_logs_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(replace(v_definition,v_old_audit,v_new_audit),v_old_adjustment,v_new_adjustment),v_old_attendance,v_new_attendance);
end
$data_entry_log_permission_bridge$;

alter function public.admin_adjustment_editor_options(text,integer) rename to admin_adjustment_editor_options_page_v1;
revoke all on function public.admin_adjustment_editor_options_page_v1(text,integer) from public,anon,authenticated;
do $adjustment_editor_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_adjustment_editor_options_page_v1(text,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'''adjustment.create''')=0 or strpos(v_definition,'''adjustment.approve''')=0 then
    raise exception 'admin_adjustment_editor_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,'''adjustment.create''','''adjustment.page.create'''),'''adjustment.approve''','''adjustment.page.approve''');
end
$adjustment_editor_permission_bridge$;
create function public.admin_adjustment_editor_options(p_search text default '',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not (public.has_permission('adjustment.page.create') or public.has_permission('adjustment.page.approve')) then raise exception 'permission_denied'; end if;
  return public.admin_adjustment_editor_options_page_v1(p_search,p_limit);
end $$;
revoke all on function public.admin_adjustment_editor_options(text,integer) from public,anon,authenticated;
grant execute on function public.admin_adjustment_editor_options(text,integer) to authenticated,service_role;

alter function public.admin_adjustment_upsert(jsonb) rename to admin_adjustment_upsert_page_v1;
revoke all on function public.admin_adjustment_upsert_page_v1(jsonb) from public,anon,authenticated;
do $adjustment_upsert_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_adjustment_upsert_without_category(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'''adjustment.create''')=0 or strpos(v_definition,'''adjustment.approve''')=0 then
    raise exception 'admin_adjustment_upsert_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,'''adjustment.create''','''adjustment.page.create'''),'''adjustment.approve''','''adjustment.page.approve''');
  revoke all on function public.admin_adjustment_upsert_without_category(jsonb) from public,anon,authenticated;
end
$adjustment_upsert_permission_bridge$;
create function public.admin_adjustment_upsert(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$ begin
  if (nullif(btrim(p_payload->>'id'),'') is not null and not public.has_permission('adjustment.page.approve'))
     or (nullif(btrim(p_payload->>'id'),'') is null and not public.has_permission('adjustment.page.create')) then
    raise exception 'permission_denied';
  end if;
  return public.admin_adjustment_upsert_page_v1(p_payload);
end $$;
revoke all on function public.admin_adjustment_upsert(jsonb) from public,anon,authenticated;
grant execute on function public.admin_adjustment_upsert(jsonb) to authenticated,service_role;

-- Employee-drawer panels are subordinate to the employee directory and, for
-- cross-module data, also require that module's precise current page. None of
-- these readers may be opened by a broad legacy grant after migration.
do $employee_drawer_private_permission_bridges$
declare
  v_definition text;
begin
  select pg_get_functiondef('employee_ops_private.admin_employee_profile_summary(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 then raise exception 'employee_profile_summary_private_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'''employee.view''','''employee.directory.view''');

  select pg_get_functiondef('employee_ops_private.admin_employee_connectivity_history(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 then raise exception 'employee_connectivity_history_private_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'''employee.view''','''employee.directory.view''');

  select pg_get_functiondef('attendance_private.admin_employee_attendance_history(uuid,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 or strpos(v_definition,'''attendance.view''')=0 then raise exception 'employee_attendance_history_private_guard_prerequisite_changed'; end if;
  execute replace(replace(v_definition,'''employee.view''','''employee.directory.view'''),'''attendance.view''','''attendance.records.view''');

  select pg_get_functiondef('attendance_private.admin_employee_adjustment_history(uuid,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'''adjustment.view''')=0 then raise exception 'employee_adjustment_history_private_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'''adjustment.view''','''adjustment.page.view''');
end
$employee_drawer_private_permission_bridges$;

create or replace function public.admin_employee_profile_summary(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_profile_summary(p_employee_id);
end $$;
create or replace function public.admin_employee_connectivity_history(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') or not public.has_permission('connectivity.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return employee_ops_private.admin_employee_connectivity_history(p_employee_id);
end $$;
create or replace function public.admin_employee_attendance_history(p_employee_id uuid,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') or not public.has_permission('attendance.records.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_attendance_history(p_employee_id,p_page,p_page_size);
end $$;
create or replace function public.admin_employee_adjustment_history(p_employee_id uuid,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') or not public.has_permission('adjustment.page.view') then raise exception 'permission_denied'; end if;
  if not public.can_manage_employee(p_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return attendance_private.admin_employee_adjustment_history(p_employee_id,p_page,p_page_size);
end $$;
revoke all on function employee_ops_private.admin_employee_profile_summary(uuid),employee_ops_private.admin_employee_connectivity_history(uuid),attendance_private.admin_employee_attendance_history(uuid,integer,integer),attendance_private.admin_employee_adjustment_history(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.admin_employee_profile_summary(uuid),public.admin_employee_connectivity_history(uuid),public.admin_employee_attendance_history(uuid,integer,integer),public.admin_employee_adjustment_history(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.admin_employee_profile_summary(uuid),public.admin_employee_connectivity_history(uuid),public.admin_employee_attendance_history(uuid,integer,integer),public.admin_employee_adjustment_history(uuid,integer,integer) to authenticated,service_role;

alter function public.admin_employee_error_history(uuid,integer,integer) rename to admin_employee_error_history_page_v1;
revoke all on function public.admin_employee_error_history_page_v1(uuid,integer,integer) from public,anon,authenticated;
do $employee_error_history_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_employee_error_history_page_v1(uuid,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 or strpos(v_definition,'''report.view''')=0 or strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then
    raise exception 'admin_employee_error_history_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(replace(v_definition,'''employee.view''','''employee.directory.view'''),'''report.view''','''report.errors.view'''),'public.exam_is_admin(''exam.view'')','public.has_permission(''report.errors.view'')');
end
$employee_error_history_permission_bridge$;
create function public.admin_employee_error_history(p_employee_id uuid,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') or not public.has_permission('report.errors.view') then raise exception 'permission_denied'; end if;
  return public.admin_employee_error_history_page_v1(p_employee_id,p_page,p_page_size);
end $$;
revoke all on function public.admin_employee_error_history(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.admin_employee_error_history(uuid,integer,integer) to authenticated,service_role;

alter function public.admin_employee_payroll_history(uuid) rename to admin_employee_payroll_history_page_v1;
revoke all on function public.admin_employee_payroll_history_page_v1(uuid) from public,anon,authenticated;
do $employee_payroll_history_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_employee_payroll_history_page_v1(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''payroll.view''')=0 then raise exception 'admin_employee_payroll_history_public_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'''payroll.view''','''employee.directory.payroll_history.view''');
  select pg_get_functiondef('payroll_private.admin_employee_payroll_history(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''payroll.view''')=0 then raise exception 'admin_employee_payroll_history_private_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'''payroll.view''','''employee.directory.payroll_history.view''');
  revoke all on function payroll_private.admin_employee_payroll_history(uuid) from public,anon,authenticated;
end
$employee_payroll_history_permission_bridge$;
create function public.admin_employee_payroll_history(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_result jsonb;
  v_rows jsonb;
  v_total integer;
begin
  if not public.has_permission('employee.directory.view') or not public.has_permission('employee.directory.payroll_history.view') then raise exception 'permission_denied'; end if;
  v_result:=public.admin_employee_payroll_history_page_v1(p_employee_id);
  select count(*)::integer,coalesce(jsonb_agg(row_item.value order by row_item.value->>'period_start' desc),'[]'::jsonb)
  into v_total,v_rows
  from jsonb_array_elements(coalesce(v_result->'rows','[]'::jsonb)) row_item(value)
  where row_item.value->>'status'='published';
  return jsonb_build_object('total',v_total,'rows',v_rows);
end $$;
revoke all on function public.admin_employee_payroll_history(uuid) from public,anon,authenticated;
grant execute on function public.admin_employee_payroll_history(uuid) to authenticated,service_role;

-- Exam readers used three broad RPCs on every tab. Keep their proven scope
-- logic behind page-specific, non-bypassable wrappers.
do $$ begin
  if to_regprocedure('public.admin_exam_dashboard(text,text,text,integer,integer)') is null
     or to_regprocedure('public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer)') is null
     or to_regprocedure('public.admin_exam_session_detail(uuid)') is null
     or to_regprocedure('public.admin_legacy_exam_session_detail(uuid)') is null
     or to_regprocedure('public.admin_exam_analytics_v3()') is null
     or to_regprocedure('public.admin_legacy_exam_overview()') is null then
    raise exception 'exam_admin_rpc_prerequisite_missing: apply the checked-in exam SQL prerequisites before granular permissions';
  end if;
end $$;
do $exam_reader_permission_bridges$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_exam_dashboard(text,text,text,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_exam_dashboard_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','(public.has_permission(''exam.overview.view'') or public.has_permission(''exam.question_bank.view''))');

  select pg_get_functiondef('public.admin_exam_analytics_v3()'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_exam_analytics_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','public.has_permission(''exam.overview.view'')');

  select pg_get_functiondef('public.admin_legacy_exam_overview()'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_legacy_exam_overview_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','public.has_permission(''exam.overview.view'')');

  select pg_get_functiondef('public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_exam_search_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','(public.has_permission(''exam.records.view'') or public.has_permission(''exam.grading.view''))');

  select pg_get_functiondef('public.admin_exam_session_detail(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 or strpos(v_definition,'public.exam_is_admin(''exam.grade'')')=0 then raise exception 'admin_exam_detail_permission_guard_prerequisite_changed'; end if;
  execute replace(replace(v_definition,'public.exam_is_admin(''exam.view'')','(public.has_permission(''exam.records.view'') or public.has_permission(''employee.directory.view''))'),'public.exam_is_admin(''exam.grade'')','public.has_permission(''exam.grading.view'')');

  select pg_get_functiondef('public.admin_legacy_exam_session_detail(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_legacy_exam_detail_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','(public.has_permission(''exam.records.view'') or public.has_permission(''exam.grading.view'') or public.has_permission(''employee.directory.view''))');
end
$exam_reader_permission_bridges$;
revoke all on function public.admin_exam_dashboard(text,text,text,integer,integer),public.admin_exam_analytics_v3(),public.admin_legacy_exam_overview(),public.admin_exam_sessions_search_v3(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_session_detail(uuid),public.admin_legacy_exam_session_detail(uuid) from public,anon,authenticated;
create function session_private.exam_team_in_scope(p_team_name text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare
  v_user_id uuid:=auth.uid();
  v_scope text;
begin
  if v_user_id is null
     or nullif(btrim(p_team_name),'') is null
     or not session_private.current_app_session_is_valid('admin') then
    return false;
  end if;
  if public.is_founder() then return true; end if;
  select access.data_scope into v_scope
  from public.user_access access
  where access.auth_user_id=v_user_id
    and access.active=true
    and access.backend_enabled=true
  order by access.updated_at desc
  limit 1;
  if v_scope='all' then return true; end if;
  if v_scope='own_team' then
    return exists(
      select 1
      from public.user_access access
      join public.employees employee on employee.id=access.employee_id
      join public.teams team on team.id=employee.team_id
      where access.auth_user_id=v_user_id
        and access.active=true
        and access.backend_enabled=true
        and public.exam_norm(team.name)=public.exam_norm(p_team_name)
    );
  end if;
  if v_scope='assigned_teams' then
    return exists(
      select 1
      from public.user_scope_teams scoped_team
      join public.teams team on team.id=scoped_team.team_id
      where scoped_team.auth_user_id=v_user_id
        and public.exam_norm(team.name)=public.exam_norm(p_team_name)
    );
  end if;
  return false;
end $$;
revoke all on function session_private.exam_team_in_scope(text) from public,anon,authenticated;
create function session_private.exam_assignment_target_in_scope(p_team_name text,p_employee_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select case
    when p_employee_id is null then session_private.exam_team_in_scope(p_team_name)
    else session_private.exam_employee_in_scope(p_employee_id)
  end;
$$;
revoke all on function session_private.exam_assignment_target_in_scope(text,uuid) from public,anon,authenticated;
create function public.admin_exam_project_session_search(p_result jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(jsonb_build_object(
      'source_system',r->'source_system','source_label',r->'source_label','id',r->'id','employee_id',r->'employee_id',
      'employee_no',r->'employee_no','employee_name',r->'employee_name','employee_match_status',r->'employee_match_status',
      'team_name',r->'team_name','position_name',r->'position_name','title',r->'title','attempt_no',r->'attempt_no',
      'status',r->'status','started_at',r->'started_at','submitted_at',r->'submitted_at','graded_at',r->'graded_at',
      'earned_score',r->'earned_score','total_score',r->'total_score','percentage',r->'percentage','passed',r->'passed',
      'correct_count',r->'correct_count','partial_count',r->'partial_count','wrong_count',r->'wrong_count','pending_count',r->'pending_count',
      'total_question_count',r->'total_question_count','unanswered_count',r->'unanswered_count','answer_detail_count',r->'answer_detail_count','answer_detail_available',r->'answer_detail_available',
      'grader_name',r->'grader_name','read_only',r->'read_only'
    )) from jsonb_array_elements(coalesce(p_result->'rows','[]'::jsonb)) r),'[]'::jsonb),
    'total',coalesce(p_result->'total','0'::jsonb),'page',coalesce(p_result->'page','1'::jsonb),
    'page_size',coalesce(p_result->'page_size','30'::jsonb),'pages',coalesce(p_result->'pages','1'::jsonb)
  );
$$;
create function public.admin_exam_project_session_detail(p_result jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object(
    'session',jsonb_build_object(
      'source_system',p_result->'session'->'source_system','source_label',p_result->'session'->'source_label','id',p_result->'session'->'id',
      'employee_id',p_result->'session'->'employee_id','employee_no',p_result->'session'->'employee_no','employee_name',p_result->'session'->'employee_name',
      'team_name',p_result->'session'->'team_name','position_name',p_result->'session'->'position_name','title',p_result->'session'->'title',
      'attempt_no',p_result->'session'->'attempt_no','status',p_result->'session'->'status','pass_score',p_result->'session'->'pass_score',
      'started_at',p_result->'session'->'started_at','submitted_at',p_result->'session'->'submitted_at','graded_at',p_result->'session'->'graded_at',
      'earned_score',p_result->'session'->'earned_score','total_score',p_result->'session'->'total_score','percentage',p_result->'session'->'percentage','passed',p_result->'session'->'passed',
      'answer_detail_count',coalesce(p_result->'session'->'answer_detail_count',to_jsonb(jsonb_array_length(coalesce(p_result->'answers','[]'::jsonb)))),
      'total_question_count',coalesce(p_result->'session'->'total_question_count',to_jsonb(jsonb_array_length(coalesce(p_result->'answers','[]'::jsonb)))),
      'unanswered_count',coalesce(p_result->'session'->'unanswered_count','0'::jsonb),
      'correct_count',p_result->'session'->'correct_count','partial_count',p_result->'session'->'partial_count','wrong_count',p_result->'session'->'wrong_count','pending_count',p_result->'session'->'pending_count',
      'grader_name',p_result->'session'->'grader_name','answer_detail_available',coalesce(p_result->'session'->'answer_detail_available','true'::jsonb),
      'read_only',coalesce(p_result->'session'->'read_only','false'::jsonb)
    ),
    'answers',coalesce((select jsonb_agg(jsonb_build_object(
      'answer_id',a->'answer_id','question_id',a->'question_id','ordinality',a->'ordinality','external_key',a->'external_key',
      'question_zh',a->'question_zh','question_en',a->'question_en','question_vi',a->'question_vi','points',a->'points',
      'image_urls',a->'image_urls','answer_text',a->'answer_text','attachments',a->'attachments','grade_status',a->'grade_status',
      'awarded_score',a->'awarded_score','grader_feedback',a->'grader_feedback','graded_at',a->'graded_at','grader_name',a->'grader_name','read_only',a->'read_only'
    )) from jsonb_array_elements(coalesce(p_result->'answers','[]'::jsonb)) a),'[]'::jsonb)
  );
$$;
create function public.admin_exam_filter_options()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'teams',coalesce((select jsonb_agg(name order by name) from (
      select distinct btrim(u.team_name) name from public.admin_exam_combined_sessions_v u
      where session_private.exam_employee_in_scope(u.employee_id) and nullif(btrim(u.team_name),'') is not null
    ) scoped_teams),'[]'::jsonb),
    'positions',coalesce((select jsonb_agg(name order by name) from (
      select distinct btrim(u.position_name) name from public.admin_exam_combined_sessions_v u
      where session_private.exam_employee_in_scope(u.employee_id) and nullif(btrim(u.position_name),'') is not null
    ) scoped_positions),'[]'::jsonb)
  );
$$;
revoke all on function public.admin_exam_project_session_search(jsonb),public.admin_exam_project_session_detail(jsonb),public.admin_exam_filter_options() from public,anon,authenticated;
create function public.admin_exam_overview_dashboard(p_search text default '',p_team text default '',p_position text default '',p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_rows jsonb;
begin
  if not public.has_permission('exam.overview.view') then raise exception 'permission_denied'; end if;
  select coalesce(jsonb_agg(to_jsonb(recent) order by recent.started_at desc),'[]'::jsonb)
  into v_rows
  from (
    select scoped.*
    from public.admin_exam_combined_sessions_v scoped
    where scoped.source_system='current'
      and session_private.exam_employee_in_scope(scoped.employee_id)
    order by scoped.started_at desc
    limit 12
  ) recent;
  return jsonb_build_object(
    'counts',jsonb_build_object(
      'questions',(select count(*) from public.exam_questions question where question.active and session_private.exam_team_in_scope(question.team_name)),
      'total_sessions',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='current' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'pending_grading',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='current' and scoped.status in ('submitted','grading') and session_private.exam_employee_in_scope(scoped.employee_id)),
      'completed',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='current' and scoped.status='graded' and session_private.exam_employee_in_scope(scoped.employee_id))
    ),
    'sessions',public.admin_exam_project_session_search(jsonb_build_object('rows',v_rows))->'rows',
    'last_sync',coalesce((select jsonb_build_object('status',sync_run.status) from public.exam_sync_runs sync_run order by sync_run.started_at desc limit 1),'{}'::jsonb)
  );
end $$;
create function public.admin_exam_question_bank_dashboard(p_search text default '',p_team text default '',p_position text default '',p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_page integer:=greatest(coalesce(p_page,1),1);
  v_size integer:=least(greatest(coalesce(p_page_size,30),1),100);
  v_total bigint;
  v_questions jsonb;
begin
  if not public.has_permission('exam.question_bank.view') then raise exception 'permission_denied'; end if;
  with filtered as materialized (
    select question.id,question.external_key,question.series_name,question.team_name,question.position_name,
      question.question_en,question.question_zh,question.question_vi,question.points,question.difficulty,
      question.image_urls,question.active,question.revision,question.source,question.sync_status,question.backend_updated_at
    from public.exam_questions question
    where question.active
      and session_private.exam_team_in_scope(question.team_name)
      and (btrim(coalesce(p_search,''))='' or question.external_key ilike '%'||btrim(p_search)||'%' or question.question_en ilike '%'||btrim(p_search)||'%' or question.question_zh ilike '%'||btrim(p_search)||'%' or question.question_vi ilike '%'||btrim(p_search)||'%')
      and (btrim(coalesce(p_team,''))='' or public.exam_norm(question.team_name)=public.exam_norm(p_team))
      and (btrim(coalesce(p_position,''))='' or public.exam_norm(question.position_name)=public.exam_norm(p_position))
  )
  select count(*),coalesce((select jsonb_agg(to_jsonb(page_row) order by page_row.external_key) from (
    select * from filtered order by external_key limit v_size offset (v_page-1)*v_size
  ) page_row),'[]'::jsonb)
  into v_total,v_questions
  from filtered;
  return jsonb_build_object(
    'questions',v_questions,'total',v_total,'page',v_page,'page_size',v_size,
    'teams',coalesce((select jsonb_agg(value order by value) from (select distinct btrim(question.team_name) value from public.exam_questions question where question.active and nullif(btrim(question.team_name),'') is not null and session_private.exam_team_in_scope(question.team_name)) names),'[]'::jsonb),
    'series',coalesce((select jsonb_agg(value order by value) from (select distinct btrim(question.series_name) value from public.exam_questions question where question.active and nullif(btrim(question.series_name),'') is not null and session_private.exam_team_in_scope(question.team_name)) names),'[]'::jsonb),
    'positions',coalesce((select jsonb_agg(value order by value) from (select distinct btrim(question.position_name) value from public.exam_questions question where question.active and nullif(btrim(question.position_name),'') is not null and session_private.exam_team_in_scope(question.team_name)) names),'[]'::jsonb),
    'last_sync',coalesce((select jsonb_build_object('status',sync_run.status) from public.exam_sync_runs sync_run order by sync_run.started_at desc limit 1),'{}'::jsonb)
  );
end $$;
create function public.admin_exam_overview_analytics()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_result jsonb;
begin
  if not public.has_permission('exam.overview.view') then raise exception 'permission_denied'; end if;
  with scoped as materialized (
    select combined.*,extract(epoch from(combined.submitted_at-combined.started_at)) duration_seconds
    from public.admin_exam_combined_sessions_v combined
    where session_private.exam_employee_in_scope(combined.employee_id)
  )
  select jsonb_build_object(
    'summary',(select jsonb_build_object(
      'total_attempts',count(*),'graded_attempts',count(*) filter(where status='graded'),
      'pass_count',count(*) filter(where status='graded' and passed),'fail_count',count(*) filter(where status='graded' and not passed),
      'avg_score',round(avg(percentage) filter(where status='graded'),1),
      'pass_rate',round(100.0*count(*) filter(where status='graded' and passed)/nullif(count(*) filter(where status='graded'),0),1),
      'avg_duration_seconds',round(avg(duration_seconds) filter(where duration_seconds>=0)),
      'correct_count',coalesce(sum(correct_count) filter(where source_system='current'),0),
      'partial_count',coalesce(sum(partial_count) filter(where source_system='current'),0),
      'wrong_count',coalesce(sum(wrong_count) filter(where source_system='current'),0),
      'pending_count',coalesce(sum(pending_count) filter(where source_system='current'),0),
      'current_attempts',count(*) filter(where source_system='current'),
      'legacy_attempts',count(*) filter(where source_system='legacy'),
      'legacy_pending',count(*) filter(where source_system='legacy' and status in ('submitted','in_progress')),
      'legacy_correct_count',coalesce(sum(correct_count) filter(where source_system='legacy'),0),
      'legacy_partial_count',coalesce(sum(partial_count) filter(where source_system='legacy'),0),
      'legacy_wrong_count',coalesce(sum(wrong_count) filter(where source_system='legacy'),0),
      'legacy_answer_pending_count',coalesce(sum(pending_count) filter(where source_system='legacy'),0)
    ) from scoped),
    'series',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.average desc,metric.name),'[]'::jsonb) from (select coalesce(nullif(series_name,''),'未分类') name,round(avg(percentage),1) average,count(*) attempts from scoped where status='graded' group by 1) metric),
    'positions',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.average desc,metric.name),'[]'::jsonb) from (select coalesce(nullif(position_name,''),'未分类') name,round(avg(percentage),1) average,count(*) attempts from scoped where status='graded' group by 1) metric),
    'teams',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.average desc,metric.name),'[]'::jsonb) from (select coalesce(nullif(team_name,''),'未分类') name,round(avg(percentage),1) average,count(*) attempts from scoped where status='graded' group by 1) metric),
    'score_bands',(select jsonb_build_object('excellent',count(*) filter(where percentage>=90),'good',count(*) filter(where percentage>=80 and percentage<90),'pass',count(*) filter(where percentage>=60 and percentage<80),'fail',count(*) filter(where percentage<60)) from scoped where status='graded'),
    'trend',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.trend_day),'[]'::jsonb) from (select submitted_at::date trend_day,round(avg(percentage),1) average,count(*) attempts from scoped where status='graded' and submitted_at>=current_date-interval '29 days' group by 1) metric),
    'daily_activity',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.activity_day),'[]'::jsonb) from (select submitted_at::date activity_day,count(*) submitted,count(*) filter(where status='graded') graded,count(*) filter(where status in ('submitted','in_progress')) pending,count(*) filter(where source_system='current') current_submitted,count(*) filter(where source_system='legacy') legacy_submitted,round(avg(percentage) filter(where status='graded'),1) average_score from scoped where submitted_at is not null and submitted_at>=current_date-interval '29 days' group by 1) metric),
    'leaderboard',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.rank_no,metric.employee_name),'[]'::jsonb) from (select dense_rank() over(order by avg(percentage) desc,max(percentage) desc,count(*) desc) rank_no,min(employee_id::text)::uuid employee_id,employee_no,max(employee_name) employee_name,coalesce(max(team_name),'—') team_name,count(*) attempts,round(avg(percentage),1) average_score,max(percentage) best_score,count(*) filter(where passed) pass_count,max(submitted_at) last_exam_at,count(*) filter(where source_system='legacy') legacy_attempts from scoped where status='graded' group by employee_no order by rank_no,employee_name) metric),
    'sources',(select coalesce(jsonb_agg(to_jsonb(metric) order by metric.source_system),'[]'::jsonb) from (select source_system,count(*) attempts,count(*) filter(where status='graded') graded,count(*) filter(where status in ('submitted','in_progress')) pending,round(avg(percentage) filter(where status='graded'),1) average from scoped group by source_system) metric)
  ) into v_result;
  return v_result;
end $$;
create function public.admin_exam_overview_legacy()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_rows jsonb;
begin
  if not public.has_permission('exam.overview.view') then raise exception 'permission_denied'; end if;
  select coalesce(jsonb_agg(to_jsonb(recent) order by recent.started_at desc),'[]'::jsonb)
  into v_rows
  from (
    select scoped.*
    from public.admin_exam_combined_sessions_v scoped
    where scoped.source_system='legacy'
      and session_private.exam_employee_in_scope(scoped.employee_id)
    order by scoped.started_at desc
    limit 12
  ) recent;
  return jsonb_build_object(
    'counts',jsonb_build_object(
      'total_sessions',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'pending_grading',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and scoped.status='submitted' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'in_progress',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and scoped.status='in_progress' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'completed',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and scoped.status='graded' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'matched',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and scoped.employee_match_status='matched' and session_private.exam_employee_in_scope(scoped.employee_id)),
      'unmatched',(select count(*) from public.admin_exam_combined_sessions_v scoped where scoped.source_system='legacy' and scoped.employee_match_status<>'matched' and session_private.exam_employee_in_scope(scoped.employee_id))
    ),
    'sessions',public.admin_exam_project_session_search(jsonb_build_object('rows',v_rows))->'rows',
    'sync_state',coalesce((select jsonb_build_object('status',sync_state.status,'last_success_at',sync_state.last_success_at,'last_error',sync_state.last_error,'updated_at',sync_state.updated_at) from public.legacy_exam_sync_state sync_state order by sync_state.updated_at desc limit 1),'{}'::jsonb)
  );
end $$;

create function public.admin_exam_records_search(p_employee_no text default '',p_employee_name text default '',p_exam text default '',p_team text default '',p_position text default '',p_status text default '',p_grader text default '',p_source text default '',p_date_from date default null,p_date_to date default null,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('exam.records.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_search(public.admin_exam_sessions_search_v3(p_employee_no,p_employee_name,p_exam,p_team,p_position,p_status,p_grader,p_source,p_date_from,p_date_to,p_page,p_page_size))||public.admin_exam_filter_options(); end $$;
create function public.admin_exam_grading_search(p_employee_no text default '',p_employee_name text default '',p_exam text default '',p_team text default '',p_position text default '',p_status text default '',p_grader text default '',p_source text default '',p_date_from date default null,p_date_to date default null,p_page integer default 1,p_page_size integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('exam.grading.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_search(public.admin_exam_sessions_search_v3(p_employee_no,p_employee_name,p_exam,p_team,p_position,'pending',p_grader,p_source,p_date_from,p_date_to,p_page,p_page_size))||public.admin_exam_filter_options(); end $$;
create function public.admin_exam_records_session_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('exam.records.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_detail(public.admin_exam_session_detail(p_session_id)); end $$;
create function public.admin_exam_records_legacy_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('exam.records.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_detail(public.admin_legacy_exam_session_detail(p_session_id)); end $$;
create function public.admin_exam_grading_session_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare v jsonb; begin if not public.has_permission('exam.grading.view') then raise exception 'permission_denied'; end if; v:=public.admin_exam_session_detail(p_session_id); if coalesce(v#>>'{session,status}','') not in ('submitted','grading') then raise exception 'session_not_pending_grading'; end if; return public.admin_exam_project_session_detail(v); end $$;
create function public.admin_exam_grading_legacy_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ declare v jsonb; begin if not public.has_permission('exam.grading.view') then raise exception 'permission_denied'; end if; v:=public.admin_legacy_exam_session_detail(p_session_id); if coalesce(v#>>'{session,status}','') not in ('submitted','grading') then raise exception 'session_not_pending_grading'; end if; return public.admin_exam_project_session_detail(v); end $$;
create function public.admin_employee_exam_session_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('employee.directory.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_detail(public.admin_exam_session_detail(p_session_id)); end $$;
create function public.admin_employee_exam_legacy_detail(p_session_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$ begin if not public.has_permission('employee.directory.view') then raise exception 'permission_denied'; end if; return public.admin_exam_project_session_detail(public.admin_legacy_exam_session_detail(p_session_id)); end $$;
revoke all on function public.admin_exam_overview_dashboard(text,text,text,integer,integer),public.admin_exam_question_bank_dashboard(text,text,text,integer,integer),public.admin_exam_overview_analytics(),public.admin_exam_overview_legacy(),public.admin_exam_records_search(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_grading_search(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_records_session_detail(uuid),public.admin_exam_records_legacy_detail(uuid),public.admin_exam_grading_session_detail(uuid),public.admin_exam_grading_legacy_detail(uuid),public.admin_employee_exam_session_detail(uuid),public.admin_employee_exam_legacy_detail(uuid) from public,anon,authenticated;
grant execute on function public.admin_exam_overview_dashboard(text,text,text,integer,integer),public.admin_exam_question_bank_dashboard(text,text,text,integer,integer),public.admin_exam_overview_analytics(),public.admin_exam_overview_legacy(),public.admin_exam_records_search(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_grading_search(text,text,text,text,text,text,text,text,date,date,integer,integer),public.admin_exam_records_session_detail(uuid),public.admin_exam_records_legacy_detail(uuid),public.admin_exam_grading_session_detail(uuid),public.admin_exam_grading_legacy_detail(uuid),public.admin_employee_exam_session_detail(uuid),public.admin_employee_exam_legacy_detail(uuid) to authenticated,service_role;

-- The employee archive owns its embedded exam history. It must not inherit the
-- broad exam-record page just because the old implementation accepted it.
alter function public.admin_employee_exam_history(uuid) rename to admin_employee_exam_history_page_v1;
revoke all on function public.admin_employee_exam_history_page_v1(uuid) from public,anon,authenticated;
do $employee_exam_history_permission_bridge$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_employee_exam_history_page_v1(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'''employee.view''')=0 or strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then
    raise exception 'admin_employee_exam_history_permission_guard_prerequisite_changed';
  end if;
  execute replace(replace(v_definition,'''employee.view''','''employee.directory.view'''),'public.exam_is_admin(''exam.view'')','public.has_permission(''employee.directory.view'')');
end
$employee_exam_history_permission_bridge$;
create function public.admin_employee_exam_history(p_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
  if not public.has_permission('employee.directory.view') then raise exception 'permission_denied'; end if;
  return public.admin_employee_exam_history_page_v1(p_employee_id);
end $$;
revoke all on function public.admin_employee_exam_history(uuid) from public,anon,authenticated;
grant execute on function public.admin_employee_exam_history(uuid) to authenticated,service_role;

-- Page-owned exam mutations wrap the existing transactional implementations.
do $exam_mutation_permission_bridges$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.admin_exam_save_question(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_save_question_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.manage'')');

  select pg_get_functiondef('public.admin_exam_delete_question(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_delete_question_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.delete'')');

  select pg_get_functiondef('public.admin_exam_grade_answer(uuid,text,numeric,text)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.grade'')')=0 then raise exception 'admin_exam_grade_answer_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.grade'')','public.has_permission(''exam.grading.grade'')');

  select pg_get_functiondef('public.admin_exam_delete_current_session(uuid,text)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 or strpos(v_definition,'public.exam_is_admin(''exam.delete'')')=0 then raise exception 'admin_exam_delete_session_permission_guard_prerequisite_changed'; end if;
  execute replace(replace(v_definition,'public.exam_is_admin(''exam.view'')','public.has_permission(''exam.records.delete'')'),'public.exam_is_admin(''exam.delete'')','public.has_permission(''exam.records.delete'')');

  -- Keep the assignment/editor helpers coherent with the visible question-bank
  -- actions. These are callable RPCs even when their dialog is not mounted.
  select pg_get_functiondef('public.admin_exam_create_assignment(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_create_assignment_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.manage'')');

  select pg_get_functiondef('public.admin_exam_save_assignment(jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_save_assignment_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.manage'')');

  select pg_get_functiondef('public.admin_exam_delete_assignment(uuid)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_delete_assignment_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.delete'')');

  select pg_get_functiondef('public.admin_exam_employee_options(text,integer)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.manage'')')=0 then raise exception 'admin_exam_employee_options_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.manage'')','public.has_permission(''exam.question_bank.manage'')');

  select pg_get_functiondef('public.admin_exam_preview_questions(text,text,jsonb)'::regprocedure) into v_definition;
  if strpos(v_definition,'public.exam_is_admin(''exam.view'')')=0 then raise exception 'admin_exam_preview_questions_permission_guard_prerequisite_changed'; end if;
  execute replace(v_definition,'public.exam_is_admin(''exam.view'')','public.has_permission(''exam.question_bank.view'')');

end
$exam_mutation_permission_bridges$;
do $revoke_unsafe_legacy_exam_readers$
begin
  if to_regprocedure('public.admin_exam_analytics_v2()') is not null then
    execute 'revoke all on function public.admin_exam_analytics_v2() from public,anon,authenticated';
  end if;
  if to_regprocedure('public.admin_exam_sessions_search(text,text,text,text,text,date,date,integer,integer)') is not null then
    execute 'revoke all on function public.admin_exam_sessions_search(text,text,text,text,text,date,date,integer,integer) from public,anon,authenticated';
  end if;
  if to_regprocedure('public.admin_exam_sessions_search_v2(text,text,text,text,text,text,text,date,date,integer,integer)') is not null then
    execute 'revoke all on function public.admin_exam_sessions_search_v2(text,text,text,text,text,text,text,date,date,integer,integer) from public,anon,authenticated';
  end if;
end
$revoke_unsafe_legacy_exam_readers$;
alter function public.admin_exam_create_assignment(jsonb) rename to admin_exam_create_assignment_page_v1;
alter function public.admin_exam_save_assignment(jsonb) rename to admin_exam_save_assignment_page_v1;
alter function public.admin_exam_delete_assignment(uuid) rename to admin_exam_delete_assignment_page_v1;
alter function public.admin_exam_preview_questions(text,text,jsonb) rename to admin_exam_preview_questions_page_v1;
revoke all on function public.admin_exam_create_assignment_page_v1(jsonb),public.admin_exam_save_assignment_page_v1(jsonb),public.admin_exam_delete_assignment_page_v1(uuid),public.admin_exam_preview_questions_page_v1(text,text,jsonb),public.admin_exam_employee_options(text,integer) from public,anon,authenticated;
create function public.admin_exam_create_assignment(p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_employee_id uuid:=nullif(btrim(p_data->>'employee_id'),'')::uuid;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if not session_private.exam_assignment_target_in_scope(p_data->>'team_name',v_employee_id) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_create_assignment_page_v1(p_data);
end $$;
create function public.admin_exam_save_assignment(p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_id uuid:=nullif(btrim(p_data->>'id'),'')::uuid;
  v_employee_id uuid:=nullif(btrim(p_data->>'employee_id'),'')::uuid;
  v_old_team text;
  v_old_employee_id uuid;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if v_id is not null then
    select assignment.team_name,assignment.employee_id into v_old_team,v_old_employee_id
    from public.exam_assignments assignment where assignment.id=v_id for update;
    if not found then raise exception 'assignment_not_found'; end if;
    if not session_private.exam_assignment_target_in_scope(v_old_team,v_old_employee_id) then raise exception 'assignment_target_out_of_scope'; end if;
  end if;
  if not session_private.exam_assignment_target_in_scope(p_data->>'team_name',v_employee_id) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_save_assignment_page_v1(p_data);
end $$;
create function public.admin_exam_delete_assignment(p_assignment_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_team text;
  v_employee_id uuid;
begin
  if not public.has_permission('exam.question_bank.delete') then raise exception 'permission_denied'; end if;
  select assignment.team_name,assignment.employee_id into v_team,v_employee_id
  from public.exam_assignments assignment where assignment.id=p_assignment_id for update;
  if not found then raise exception 'assignment_not_found'; end if;
  if not session_private.exam_assignment_target_in_scope(v_team,v_employee_id) then raise exception 'assignment_target_out_of_scope'; end if;
  return public.admin_exam_delete_assignment_page_v1(p_assignment_id);
end $$;
create or replace function public.admin_exam_employee_options(p_search text default '',p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  return coalesce((select jsonb_agg(to_jsonb(option_row) order by option_row.employee_no) from (
    select employee.id,employee.employee_no,employee.full_name,team.name team_name,position.name position_name
    from public.employees employee
    left join public.teams team on team.id=employee.team_id
    left join public.positions position on position.id=employee.position_id
    where employee.status='active'
      and employee.resign_date is null
      and session_private.exam_employee_in_scope(employee.id)
      and (coalesce(p_search,'')='' or employee.employee_no ilike '%'||p_search||'%' or employee.full_name ilike '%'||p_search||'%')
    order by employee.employee_no
    limit greatest(1,least(50,coalesce(p_limit,20)))
  ) option_row),'[]'::jsonb);
end $$;
create function public.admin_exam_preview_questions(p_team text,p_position text,p_rules jsonb default '{"5":10,"10":3,"20":1}')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.has_permission('exam.question_bank.view') then raise exception 'permission_denied'; end if;
  if not session_private.exam_team_in_scope(p_team) then raise exception 'team_out_of_scope'; end if;
  return public.admin_exam_preview_questions_page_v1(p_team,p_position,p_rules);
end $$;
revoke all on function public.admin_exam_create_assignment(jsonb),public.admin_exam_save_assignment(jsonb),public.admin_exam_delete_assignment(uuid),public.admin_exam_employee_options(text,integer),public.admin_exam_preview_questions(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_exam_create_assignment(jsonb),public.admin_exam_save_assignment(jsonb),public.admin_exam_delete_assignment(uuid),public.admin_exam_employee_options(text,integer),public.admin_exam_preview_questions(text,text,jsonb) to authenticated,service_role;
alter function public.admin_exam_save_question(jsonb) rename to admin_exam_save_question_page_v1;
revoke all on function public.admin_exam_save_question_page_v1(jsonb) from public,anon,authenticated;
create function public.admin_exam_save_question(p_question jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_id uuid:=nullif(btrim(p_question->>'id'),'')::uuid;
  v_old_team text;
begin
  if not public.has_permission('exam.question_bank.manage') then raise exception 'permission_denied'; end if;
  if v_id is not null then
    select question.team_name into v_old_team
    from public.exam_questions question where question.id=v_id for update;
    if not found then raise exception 'question_not_found'; end if;
    if not session_private.exam_team_in_scope(v_old_team) then raise exception 'team_out_of_scope'; end if;
  end if;
  if not session_private.exam_team_in_scope(p_question->>'team_name') then raise exception 'team_out_of_scope'; end if;
  return public.admin_exam_save_question_page_v1(p_question);
end $$;
alter function public.admin_exam_delete_question(uuid) rename to admin_exam_delete_question_page_v1;
revoke all on function public.admin_exam_delete_question_page_v1(uuid) from public,anon,authenticated;
create function public.admin_exam_delete_question(p_question_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_team text;
begin
  if not public.has_permission('exam.question_bank.delete') then raise exception 'permission_denied'; end if;
  select question.team_name into v_team
  from public.exam_questions question where question.id=p_question_id for update;
  if not found then raise exception 'question_not_found'; end if;
  if not session_private.exam_team_in_scope(v_team) then raise exception 'team_out_of_scope'; end if;
  return public.admin_exam_delete_question_page_v1(p_question_id);
end $$;
alter function public.admin_exam_grade_answer(uuid,text,numeric,text) rename to admin_exam_grade_answer_page_v1;
revoke all on function public.admin_exam_grade_answer_page_v1(uuid,text,numeric,text) from public,anon,authenticated;
create function public.admin_exam_grade_answer(p_answer_id uuid,p_status text,p_score numeric,p_feedback text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_employee_id uuid;
begin
  if not public.has_permission('exam.grading.grade') then raise exception 'permission_denied'; end if;
  select exam_session.employee_id into v_employee_id
  from public.exam_answers exam_answer
  join public.exam_sessions exam_session on exam_session.id=exam_answer.session_id
  where exam_answer.id=p_answer_id
  for update of exam_answer,exam_session;
  if not found then raise exception 'answer_not_found'; end if;
  if not session_private.exam_employee_in_scope(v_employee_id) then raise exception 'employee_out_of_scope'; end if;
  return public.admin_exam_grade_answer_page_v1(p_answer_id,p_status,p_score,p_feedback);
end $$;
alter function public.admin_exam_delete_current_session(uuid,text) rename to admin_exam_delete_current_session_page_v1;
revoke all on function public.admin_exam_delete_current_session_page_v1(uuid,text) from public,anon,authenticated;
create function public.admin_exam_delete_current_session(p_session_id uuid,p_confirmation text) returns jsonb language plpgsql security definer set search_path='' as $$ begin if not public.has_permission('exam.records.delete') then raise exception 'permission_denied'; end if; return public.admin_exam_delete_current_session_page_v1(p_session_id,p_confirmation); end $$;
revoke all on function public.admin_exam_save_question(jsonb),public.admin_exam_delete_question(uuid),public.admin_exam_grade_answer(uuid,text,numeric,text),public.admin_exam_delete_current_session(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_exam_save_question(jsonb),public.admin_exam_delete_question(uuid),public.admin_exam_grade_answer(uuid,text,numeric,text),public.admin_exam_delete_current_session(uuid,text) to authenticated,service_role;

notify pgrst,'reload schema';
commit;
