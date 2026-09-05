import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../../supabase/migrations/20260827113000_granular_admin_page_permissions.sql', import.meta.url), 'utf8')
const examHome = await readFile(new URL('../../supabase/migrations/20260828052000_exam_overview_single_rpc.sql', import.meta.url), 'utf8')
const payroll = await readFile(new URL('../../supabase/migrations/20260827113100_payroll_page_permission_boundaries.sql', import.meta.url), 'utf8')
const payrollCorrections = await readFile(new URL('../../supabase/migrations/20260827140000_payroll_batch_correction_workflow.sql', import.meta.url), 'utf8')
const payrollCoexistence = await readFile(new URL('../../supabase/migrations/20260830153000_payroll_published_stream_isolation.sql', import.meta.url), 'utf8')
const training = await readFile(new URL('../../supabase/migrations/20260827113200_online_training_page_permission_boundaries.sql', import.meta.url), 'utf8')
const adjustmentAlignment = await readFile(new URL('../../supabase/migrations/20260827113300_adjustment_edit_permission_alignment.sql', import.meta.url), 'utf8')
const adjustmentFilters = await readFile(new URL('../../supabase/migrations/20260829041328_preserve_admin_adjustment_currency_filter.sql', import.meta.url), 'utf8')
const adjustmentVisibility = await readFile(new URL('../../supabase/migrations/20260829110546_split_adjustment_visibility_permissions.sql', import.meta.url), 'utf8')
const adjustmentCategoryClosure = await readFile(new URL('../../supabase/migrations/20260830062228_close_adjustment_category_permissions.sql', import.meta.url), 'utf8')
const adjustmentCategoryCatalog = await readFile(new URL('../../supabase/migrations/20260830112000_clarify_adjustment_category_permission_scope.sql', import.meta.url), 'utf8')
const accounts = await readFile(new URL('../../supabase/functions/admin-accounts/index.ts', import.meta.url), 'utf8')
const employees = await readFile(new URL('../../supabase/functions/admin-employees/index.ts', import.meta.url), 'utf8')
const employeeWrite = await readFile(new URL('../../supabase/functions/admin-employee-write/index.ts', import.meta.url), 'utf8')
const reports = await readFile(new URL('../../supabase/functions/admin-reports/index.ts', import.meta.url), 'utf8')
const payrollPage = await readFile(new URL('../pages/AdminPayrollPage.jsx', import.meta.url), 'utf8')
const reportsPage = await readFile(new URL('../pages/AdminReportsPage.jsx', import.meta.url), 'utf8')
const attendancePage = await readFile(new URL('../pages/AdminAttendancePage.jsx', import.meta.url), 'utf8')
const employeePage = await readFile(new URL('../pages/AdminEmployeesPage.jsx', import.meta.url), 'utf8')
const attendanceRecords = await readFile(new URL('../components/AttendanceRecords.jsx', import.meta.url), 'utf8')
const permissionConfig = await readFile(new URL('../config/permissions.js', import.meta.url), 'utf8')
const adminPagePermissions = await readFile(new URL('../config/adminPagePermissions.js', import.meta.url), 'utf8')
const trainingPage = await readFile(new URL('../pages/AdminTrainingPage.jsx', import.meta.url), 'utf8')
const examSessionStorageCleanup = await readFile(new URL('./examSessionStorageCleanup.js', import.meta.url), 'utf8')
const onlineTrainingPage = await readFile(new URL('../pages/OnlineTrainingPage.jsx', import.meta.url), 'utf8')

test('attendance and exam wrappers constrain filters, payloads and grading status', () => {
  assert.match(migration, /admin_attendance_page_filters[\s\S]+include_mirrors',false/)
  assert.match(migration, /admin_attendance_page_projection[\s\S]+sync_protocol/)
  assert.match(migration, /admin_exam_project_session_search[\s\S]+admin_exam_project_session_detail/)
  assert.match(migration, /admin_exam_grading_search[\s\S]+p_position,'pending'/)
  assert.match(migration, /session_not_pending_grading/)
  assert.doesNotMatch(migration, /p_payload \? 'id'/)
})

test('exam overview, question-bank and mutations enforce the current data scope', () => {
  assert.match(migration, /create function session_private\.exam_team_in_scope\(p_team_name text\)[\s\S]+if public\.is_founder\(\) then return true[\s\S]+if v_scope='all' then return true[\s\S]+v_scope='own_team'[\s\S]+v_scope='assigned_teams'[\s\S]+user_scope_teams/)
  assert.doesNotMatch(migration.match(/create function session_private\.exam_team_in_scope[\s\S]+?revoke all on function session_private\.exam_team_in_scope/)?.[0] || '', /exam_employee_in_scope/)
  assert.match(migration, /create function session_private\.exam_assignment_target_in_scope\(p_team_name text,p_employee_id uuid\)[\s\S]+when p_employee_id is null then session_private\.exam_team_in_scope\(p_team_name\)[\s\S]+else session_private\.exam_employee_in_scope\(p_employee_id\)/)
  assert.match(migration, /admin_exam_overview_dashboard[\s\S]+source_system='current'[\s\S]+session_private\.exam_employee_in_scope\(scoped\.employee_id\)/)
  assert.match(migration, /admin_exam_overview_analytics[\s\S]+from public\.admin_exam_combined_sessions_v combined[\s\S]+session_private\.exam_employee_in_scope\(combined\.employee_id\)/)
  assert.match(migration, /admin_exam_overview_legacy[\s\S]+source_system='legacy'[\s\S]+session_private\.exam_employee_in_scope\(scoped\.employee_id\)/)
  assert.match(migration, /admin_exam_question_bank_dashboard[\s\S]+session_private\.exam_team_in_scope\(question\.team_name\)/)
  assert.match(examHome, /exam_private\.admin_exam_overview_scope[\s\S]+v_allowed_employee_ids uuid\[\][\s\S]+admin_scope_effective_employee_ids\(v_user_id\)/)
  assert.equal(examHome.match(/from exam_private\.admin_exam_overview_scope\(\) scope/g)?.length, 5)
  assert.match(examHome, /question_scopes as materialized[\s\S]+user_scope_team_filters[\s\S]+user_scope_position_filters/)
  assert.match(examHome, /scope\.position_key is null[\s\S]+scope\.position_key = public\.exam_norm\(question\.position_name\)/)
  assert.doesNotMatch(examHome, /exam_employee_in_scope|can_manage_employee/)

  assert.match(migration, /admin_exam_save_question\(p_question jsonb\)[\s\S]+exam_team_in_scope\(v_old_team\)[\s\S]+exam_team_in_scope\(p_question->>'team_name'\)/)
  assert.match(migration, /admin_exam_delete_question\(p_question_id uuid\)[\s\S]+exam_team_in_scope\(v_team\)/)
  assert.match(migration, /admin_exam_grade_answer\(p_answer_id uuid[\s\S]+join public\.exam_sessions exam_session[\s\S]+exam_employee_in_scope\(v_employee_id\)/)
  assert.match(migration, /admin_exam_save_assignment\(p_data jsonb\)[\s\S]+exam_assignment_target_in_scope\(v_old_team,v_old_employee_id\)[\s\S]+exam_assignment_target_in_scope\(p_data->>'team_name',v_employee_id\)/)
  assert.match(migration, /admin_exam_delete_assignment\(p_assignment_id uuid\)[\s\S]+exam_assignment_target_in_scope\(v_team,v_employee_id\)/)
  assert.match(migration, /admin_exam_employee_options[\s\S]+session_private\.exam_employee_in_scope\(employee\.id\)/)
  assert.match(migration, /admin_exam_preview_questions[\s\S]+session_private\.exam_team_in_scope\(p_team\)/)

  assert.match(migration, /revoke all on function public\.admin_exam_analytics_v2\(\) from public,anon,authenticated/)
  assert.match(migration, /revoke all on function public\.admin_exam_sessions_search\(text,text,text,text,text,date,date,integer,integer\) from public,anon,authenticated/)
  assert.match(migration, /revoke all on function public\.admin_exam_sessions_search_v2\(text,text,text,text,text,text,text,date,date,integer,integer\) from public,anon,authenticated/)
  assert.doesNotMatch(migration, /admin_exam_analytics_v2_permission_guard_prerequisite_changed/)
  assert.doesNotMatch(migration, /admin_exam_sessions_search_v2_permission_guard_prerequisite_changed/)
  for (const rpc of [
    'admin_exam_overview_home',
    'admin_exam_overview_analytics_summary','admin_exam_overview_analytics_dimensions',
    'admin_exam_overview_analytics_activity','admin_exam_overview_analytics_leaderboard',
    'admin_exam_question_bank_dashboard','admin_exam_records_search','admin_exam_grading_search',
    'admin_exam_save_question','admin_exam_delete_question','admin_exam_grade_answer_with_feedback_images','admin_exam_delete_current_session',
  ]) assert.ok(`${trainingPage}\n${examSessionStorageCleanup}`.includes(`'${rpc}'`), `AdminTrainingPage should keep using ${rpc}`)
})

test('attendance private helpers cannot bypass granular wrappers or employee drawer gates', () => {
  for (const signature of [
    'attendance_private.admin_attendance_home(jsonb)',
    'attendance_private.admin_attendance_monthly(jsonb)',
    'attendance_private.admin_employee_attendance_history(uuid,integer,integer)',
    'attendance_private.admin_employee_adjustment_history(uuid,integer,integer)',
  ]) assert.ok(migration.includes(signature))
  assert.match(migration, /revoke all on function attendance_private\.admin_attendance_home\(jsonb\) from public,anon,authenticated/)
  assert.match(migration, /revoke all on function attendance_private\.admin_attendance_monthly\(jsonb\) from public,anon,authenticated/)
  assert.match(migration, /revoke all on function employee_ops_private\.admin_employee_profile_summary\(uuid\)[\s\S]+attendance_private\.admin_employee_attendance_history\(uuid,integer,integer\)[\s\S]+from public,anon,authenticated/)
  assert.match(attendancePage, /if\(!canViewEmployeeDirectory\|\|!row\.employee_id\)return/)
  assert.match(attendancePage, /onEmployee=\{canViewEmployeeDirectory\?openEmployee:null\}/)
  assert.match(reportsPage, /canViewEmployeeDirectory\?<button className="rp-link rp-employee-profile-link"/)
  assert.match(reportsPage, /canViewEmployeeDirectory&&employeeNo&&<ReportEmployeeDrawer/)
})

test('employee entry logs bridge legacy audit guards to exact current page permissions', () => {
  assert.match(migration, /data_entry_log_permission_bridge/)
  assert.match(migration, /admin_data_entry_logs\(text,text,date,date,integer,integer\)/)
  assert.match(migration, /employee\.change_history\.view/)
  assert.match(migration, /v_category = 'adjustment'[\s\S]+adjustment\.page\.view/)
  for (const code of ['attendance.monthly.view','attendance.today.view','attendance.records.view','attendance.leave.view']) assert.ok(migration.includes(code))
})

test('payroll pages use direct status-scoped readers and projected import details', () => {
  assert.match(payroll, /admin_payroll_granular_page\([\s\S]+where \(p_status is null or batch\.status = p_status\)/)
  assert.doesNotMatch(payroll, /jsonb_array_elements\(coalesce\(v->'batches'/)
  assert.match(payroll, /admin_payroll_pending_page[\s\S]+admin_payroll_granular_page\('draft',p_batch_id,true\)/)
  assert.match(payroll, /admin_payroll_published_page[\s\S]+admin_payroll_granular_page\('published',p_batch_id,true\)/)
  assert.match(payroll, /admin_payroll_import_history_page[\s\S]+p_batch_id is not null and p_batch_id > 0/)
  assert.doesNotMatch(payroll, /'identity_match_source',payslip\.identity_match_source/)
})

test('payroll readers scope batch selection, aggregates and rows to manageable employees', () => {
  assert.match(payroll, /create function payroll_private\.admin_payroll_has_full_scope\(\)[\s\S]+current_app_session_is_valid\('admin'\)[\s\S]+public\.is_founder\(\)[\s\S]+access\.data_scope[\s\S]+v_scope = 'all'/)
  const batchSelectionScopes = payroll.match(/visible_payslip\.identity_match_state <> 'unmatched'\s+and visible_payslip\.employee_id is not null\s+and public\.can_manage_employee\(visible_payslip\.employee_id\)/g) ?? []
  const aggregateAndRowScopes = payroll.match(/payslip\.identity_match_state <> 'unmatched'\s+and\s+payslip\.employee_id is not null\s+and public\.can_manage_employee\(payslip\.employee_id\)/g) ?? []
  assert.equal(batchSelectionScopes.length, 2)
  assert.equal(aggregateAndRowScopes.length, 3)
  assert.match(payroll, /from public\.payroll_payslips visible_payslip[\s\S]+visible_payslip\.identity_match_state <> 'unmatched'[\s\S]+visible_payslip\.employee_id is not null[\s\S]+public\.can_manage_employee\(visible_payslip\.employee_id\)/)
  assert.match(payroll, /left join public\.payroll_payslips payslip[\s\S]+v_full_scope[\s\S]+payslip\.identity_match_state <> 'unmatched'[\s\S]+payslip\.employee_id is not null[\s\S]+public\.can_manage_employee\(payslip\.employee_id\)[\s\S]+and \(v_full_scope or payslip\.id is not null\)/)
  assert.match(payroll, /where payslip\.batch_id = v_selected[\s\S]+v_full_scope[\s\S]+payslip\.identity_match_state <> 'unmatched'[\s\S]+payslip\.employee_id is not null[\s\S]+public\.can_manage_employee\(payslip\.employee_id\)/)
  assert.match(payroll, /revoke all on function payroll_private\.admin_payroll_has_full_scope\(\)[\s\S]+from public,anon,authenticated/)
})

test('payroll mutations reject overwrite payloads, force upload source and lock deletes', () => {
  assert.match(payroll, /import_batch_id_not_allowed/)
  assert.match(payroll, /'source_type','upload'/)
  assert.match(payroll, /select batch\.status into v_status[\s\S]+for update/)
  assert.match(payroll, /return jsonb_build_object\([\s\S]+'batch_id',v_result->'batch_id'/)
})

test('whole-batch payroll mutations require Founder or all data scope', () => {
  const scopeGuards = payroll.match(/if not payroll_private\.admin_payroll_has_full_scope\(\) then raise exception 'payroll_all_scope_required'; end if;/g) ?? []
  assert.equal(scopeGuards.length, 3)
  assert.match(payroll, /admin_payroll_import\(p_batch jsonb,p_rows jsonb\)[\s\S]+payroll_all_scope_required/)
  assert.match(payroll, /admin_payroll_publish\(p_batch_id bigint\)[\s\S]+payroll_all_scope_required/)
  assert.match(payroll, /admin_payroll_delete\(p_batch_id bigint\)[\s\S]+payroll_all_scope_required/)
})

test('limited payroll viewers never receive or render whole-batch actions', () => {
  assert.match(payroll, /'edit',v_full_scope and public\.has_permission\('payroll\.pending\.edit'\)/)
  assert.match(payroll, /'publish',v_full_scope and public\.has_permission\('payroll\.pending\.publish'\)/)
  assert.match(payroll, /'edit',v_full_scope and public\.has_permission\('payroll\.import_history\.edit'\)/)
  assert.match(payrollPage, /const canMutateWholePayroll=access\.founder\|\|access\.dataScope==='all'/)
  assert.match(payrollPage, /canMutateWholePayroll&&access\.hasPermission\(PERMISSIONS\.PAYROLL_IMPORT_HISTORY_EDIT\)/)
})

test('payroll UI opens import details safely and only navigates to permitted target tabs', () => {
  assert.doesNotMatch(payrollPage, /supabase\.rpc\(tab===/)
  assert.match(payrollPage, /supabase\.rpc\('admin_payroll_import_history_page',\{p_batch_id:batch\.id\}\)/)
  assert.match(payrollPage, /hasPermission\(PERMISSIONS\.PAYROLL_PENDING_VIEW\)[\s\S]+setTabState\('待发布'\)/)
  assert.match(payrollPage, /hasPermission\(PERMISSIONS\.PAYROLL_PUBLISHED_VIEW\)[\s\S]+setTabState\('已发布'\)/)
})

test('payroll correction lifecycle is recoverable, guarded and fully audited', () => {
  for (const column of ['updated_by','updated_by_name','voided_at','voided_by_name','void_reason','voided_prior_status','correction_of_batch_id']) {
    assert.ok(payrollCorrections.includes(`add column if not exists ${column}`), `missing payroll batch column ${column}`)
  }
  for (const rpc of [
    'admin_payroll_update_batch','admin_payroll_delete','admin_payroll_void_batch',
    'admin_payroll_restore_batch','admin_payroll_clone_correction',
  ]) {
    const start=payrollCorrections.indexOf(`function public.${rpc}`)
    assert.notEqual(start,-1,`missing ${rpc}`)
    const body=payrollCorrections.slice(start,start+9000)
    assert.match(body,/current_app_session_is_valid\('admin'\)/)
    assert.match(body,/admin_payroll_has_full_scope\(\)[\s\S]{0,80}payroll_all_scope_required/)
  }
  assert.doesNotMatch(payrollCorrections,/delete from public\.payroll_batches/)
  assert.match(payrollCorrections,/admin_payroll_update_batch[\s\S]+v_before\.status not in \('draft','archived'\)[\s\S]+title = btrim\(p_title\),notes =/)
  assert.match(payrollCorrections,/admin_payroll_delete[\s\S]+set status = 'archived'[\s\S]+voided_prior_status = 'draft'/)
  assert.match(payrollCorrections,/admin_payroll_restore_batch[\s\S]+v_restore_status[\s\S]+voided_at = null/)
  assert.match(payrollCorrections,/admin_payroll_clone_correction[\s\S]+correction_of_batch_id[\s\S]+insert into public\.payroll_payslips/)
  for (const action of ['update_batch','void_batch','restore_batch','clone_correction','correction_draft_created','auto_archive']) {
    assert.ok(payrollCorrections.includes(`'${action}'`), `missing payroll audit action ${action}`)
  }
})

test('payroll readers expose actor snapshots and explain published coexistence or missing state', () => {
  assert.match(payrollCorrections,/admin_payroll_actor_name[\s\S]+login_username[\s\S]+login_email/)
  assert.match(payrollCorrections,/admin_payroll_batch_metadata[\s\S]+created_by_name[\s\S]+updated_by_name[\s\S]+published_by_name/)
  assert.match(payrollCorrections,/admin_payroll_enrich_page[\s\S]+admin_payroll_granular_page/)
  assert.match(payrollCorrections,/当前无有效发布批次，最近批次已删除\/作废/)
  assert.match(payrollCoexistence,/Publishes one draft without archiving any other batch\. All uploaded published batches coexist\./)
  assert.match(payrollCoexistence,/correction_of_batch_id source/)
  assert.match(payrollPage,/文档批次 \/ 导入时间[\s\S]+上传人[\s\S]+selected\?\.created_by_name[\s\S]+最近操作人[\s\S]+selected\?\.updated_by_name/)
  assert.match(payrollPage,/selected\?\.published_by_name/)
  assert.match(payrollPage,/admin_payroll_update_batch/)
  assert.match(payrollPage,/admin_payroll_void_batch/)
  assert.match(payrollPage,/admin_payroll_restore_batch/)
  assert.match(payrollPage,/admin_payroll_clone_correction/)
  assert.match(payrollPage,/\['draft','archived'\]\.includes\(selected\.status\)[\s\S]+保存名称\/备注/)
  assert.match(payrollPage,/已发布批次的金额保持只读；可创建纠正草稿，或经加强确认后撤下并移入“已删除”/)
  assert.match(payrollPage,/每次已发布的工资上传都会独立保留并对对应员工可见/)
  assert.doesNotMatch(payrollPage,/同月份的新批次发布后，旧发布批次会自动归档/)
})

test('training and employee mutations enforce current page permissions', () => {
  for (const code of ['online_training.report.view','online_training.report.submit','online_training.report.review','online_training.report.manage']) assert.ok(training.includes(code))
  for (const signature of [
    'admin_exam_create_assignment(jsonb)',
    'admin_exam_save_assignment(jsonb)',
    'admin_exam_delete_assignment(uuid)',
    'admin_exam_employee_options(text,integer)',
    'admin_exam_preview_questions(text,text,jsonb)',
    'admin_exam_analytics_v2()',
    'admin_exam_sessions_search_v2(text,text,text,text,text,text,text,date,date,integer,integer)',
  ]) assert.ok(migration.includes(signature))
  assert.match(migration, /admin_exam_save_assignment_permission_guard_prerequisite_changed[\s\S]+exam\.question_bank\.manage/)
  assert.match(migration, /admin_exam_delete_assignment_permission_guard_prerequisite_changed[\s\S]+exam\.question_bank\.delete/)
  assert.match(employees, /employee\.directory\.resign[\s\S]+employee\.resignations\.resign/)
  assert.match(employeeWrite, /employee\.change_history\.view/)
  assert.match(employeeWrite, /employee\.directory\.view/)
  assert.match(onlineTrainingPage, /canViewEmployeeDirectory=access\.hasPermission\(PERMISSIONS\.EMPLOYEE_DIRECTORY_VIEW\)/)
  assert.match(onlineTrainingPage, /if\(!canViewEmployeeDirectory\)return/)
  assert.match(onlineTrainingPage, /canOpenProfile=\{canViewEmployeeDirectory\}/)
  assert.match(employees, /else \{[\s\S]+requirePermission\(service, caller, "employee\.directory\.view"\)/)
  assert.match(employees, /if \(action === "detail"\)[\s\S]+q = applyScope\(q,scope\)/)
})

test('adjustment edits use their own selectable permission instead of approval', () => {
  assert.match(adjustmentAlignment, /'adjustment\.page\.edit','编辑奖惩记录'/)
  assert.match(adjustmentAlignment, /admin_adjustment_editor_options_page_v1[\s\S]+admin_adjustment_upsert_without_category[\s\S]+replace\(v_definition,'''adjustment\.page\.approve''','''adjustment\.page\.edit'''\)/)
  assert.match(adjustmentAlignment, /admin_adjustment_upsert\(p_payload jsonb\)[\s\S]+p_payload->>'id'[\s\S]+adjustment\.page\.edit/)
  assert.match(attendancePage, /canEditAdjustment=access\.hasPermission\(PERMISSIONS\.ADJUSTMENT_PAGE_EDIT\)/)
  assert.doesNotMatch(attendancePage, /canEditAdjustment=access\.hasPermission\(PERMISSIONS\.ADJUSTMENT_PAGE_APPROVE\)/)
})

test('adjustment currency and search filters survive the granular wrapper', () => {
  assert.match(adjustmentFilters, /create or replace function public\.admin_attendance_page_filters/)
  for (const key of ['search','employee_status','currency','match_status']) {
    assert.ok(adjustmentFilters.includes(`'${key}',p_filters->'${key}'`), `missing whitelisted ${key} filter`)
  }
  assert.match(adjustmentFilters, /jsonb_strip_nulls[\s\S]+\|\| coalesce\(p_forced,'\{\}'::jsonb\)[\s\S]+include_mirrors',false/)
  assert.match(attendancePage, /currency:''/)
  assert.match(attendancePage, /tab==='奖金 \/ 扣款'[\s\S]+<span>币种<\/span>[\s\S]+全部币种（USD \+ PHP）[\s\S]+value="USD"[\s\S]+value="PHP"/)
  assert.match(attendancePage, /admin_adjustment_page/)
})

test('bonus and deduction visibility is independently configurable on both admin surfaces', () => {
  assert.match(permissionConfig, /ADJUSTMENT_BONUS_VIEW:\s*'adjustment\.bonus\.view'/)
  assert.match(permissionConfig, /ADJUSTMENT_DEDUCTION_VIEW:\s*'adjustment\.deduction\.view'/)
  assert.match(adminPagePermissions, /adjustments:[\s\S]+ADJUSTMENT_BONUS_VIEW[\s\S]+ADJUSTMENT_DEDUCTION_VIEW/)

  assert.match(attendancePage, /canViewAdjustments=access\.hasPermission\(PERMISSIONS\.ADJUSTMENT_PAGE_VIEW\)&&\(canViewAdjustmentBonus\|\|canViewAdjustmentDeduction\)/)
  assert.match(attendancePage, /if\(value==='奖金 \/ 扣款'\)return canViewAdjustments/)
  assert.match(attendancePage, /allowedKinds=tab==='奖金 \/ 扣款'\?new Set\(\[canViewAdjustmentBonus&&'bonus',canViewAdjustmentDeduction&&'deduction'\]/)
  assert.match(attendancePage, /canViewAdjustmentBonus\?\[\['USD 奖金'/)
  assert.match(attendancePage, /canViewAdjustmentDeduction\?\[\['USD 扣款'/)

  assert.match(employeePage, /canViewAdjustments=adminAccess\.hasPermission\(PERMISSIONS\.ADJUSTMENT_PAGE_VIEW\)&&\(canViewAdjustmentBonus\|\|canViewAdjustmentDeduction\)/)
  assert.match(employeePage, /\['penalties','奖金 \/ 扣款',canViewAdjustments\]/)
  assert.match(employeePage, /EmployeeAdjustmentPanel employeeId=\{e\.id\}[\s\S]+canViewBonus=\{canViewAdjustmentBonus\}[\s\S]+canViewDeduction=\{canViewAdjustmentDeduction\}/)
  assert.match(employeePage, /EmployeeAdjustmentPanel[\s\S]+canViewBonus=\{canViewAdjustmentBonus\}[\s\S]+canViewDeduction=\{canViewAdjustmentDeduction\}/)
  assert.match(employeePage, /canViewAdjustmentLogs=canViewAudit[\s\S]+ADJUSTMENT_PAGE_VIEW[\s\S]+hasAnyPermission\(\[PERMISSIONS\.ADJUSTMENT_BONUS_VIEW,PERMISSIONS\.ADJUSTMENT_DEDUCTION_VIEW\]\)/)
  assert.match(attendanceRecords, /EmployeeAdjustmentPanel\(\{employeeId,canViewBonus=false,canViewDeduction=false\}\)/)
  assert.match(attendanceRecords, /useEmployeeHistoryRpc\('admin_employee_adjustment_history_filtered',employeeId,canViewBonus\|\|canViewDeduction\)/)
  assert.match(attendanceRecords, /summaryItems=\[\.\.\.\(canViewBonus[\s\S]+\.\.\.\(canViewDeduction/)
  assert.match(attendanceRecords, /adjustmentVisibilityKind[\s\S]+categoryAllowed=kind==='bonus'\?canViewBonus:kind==='deduction'\?canViewDeduction:canViewBonus&&canViewDeduction/)

  assert.match(adjustmentCategoryCatalog, /查看奖金记录（奖惩表 \/ 员工档案）/)
  assert.match(adjustmentCategoryCatalog, /查看扣款记录（奖惩表 \/ 员工档案）/)
  assert.match(adjustmentCategoryCatalog, /sensitive=true/)
  assert.doesNotMatch(adjustmentCategoryCatalog, /insert into public\.role_permissions|insert into public\.user_permission_overrides/)
})

test('bonus and deduction rows are filtered by both private server readers before aggregation', () => {
  for (const code of ['adjustment.bonus.view','adjustment.deduction.view']) {
    assert.ok(adjustmentVisibility.includes(`'${code}'`), `missing ${code}`)
  }
  assert.match(adjustmentVisibility, /from public\.role_permissions source[\s\S]+source\.permission_id=ids\.page_view_id[\s\S]+on conflict\(role_id,permission_id\) do nothing/)
  assert.match(adjustmentVisibility, /from public\.user_permission_overrides source[\s\S]+source\.permission_id=ids\.page_view_id[\s\S]+do update set allowed=excluded\.allowed/)
  assert.match(adjustmentVisibility, /create or replace function attendance_private\.adjustment_visibility_kind\([\s\S]+when p_event_kind='bonus' then 'bonus'[\s\S]+when p_event_kind='deduction' then 'deduction'[\s\S]+p_amount>0 then 'bonus'[\s\S]+p_amount<0 then 'deduction'[\s\S]+else 'unclassified'/)

  const homePatch = adjustmentVisibility.slice(adjustmentVisibility.indexOf('do $adjustment_home_visibility$'), adjustmentVisibility.indexOf('do $employee_adjustment_visibility$'))
  const employeePatch = adjustmentVisibility.slice(adjustmentVisibility.indexOf('do $employee_adjustment_visibility$'), adjustmentVisibility.indexOf('revoke all on function attendance_private.admin_attendance_home'))
  assert.match(homePatch, /admin_attendance_home\(jsonb\)/)
  assert.match(homePatch, /v_can_bonus[\s\S]+v_can_deduction[\s\S]+adjustment_visibility_kind\(x\.event_kind,x\.amount\)/)
  assert.match(employeePatch, /admin_employee_adjustment_history\(uuid,integer,integer\)/)
  assert.match(employeePatch, /v_can_bonus[\s\S]+v_can_deduction[\s\S]+adjustment_visibility_kind\(x\.event_kind,x\.amount\)/)
  assert.match(adjustmentVisibility, /create or replace function public\.admin_adjustment_page[\s\S]+adjustment\.page\.view[\s\S]+adjustment\.bonus\.view[\s\S]+adjustment\.deduction\.view/)
  assert.match(adjustmentVisibility, /create or replace function public\.admin_employee_adjustment_history[\s\S]+employee\.directory\.view[\s\S]+adjustment\.page\.view[\s\S]+adjustment\.bonus\.view[\s\S]+adjustment\.deduction\.view[\s\S]+can_manage_employee/)
  assert.match(adjustmentVisibility, /revoke all on function attendance_private\.admin_attendance_home\(jsonb\)[\s\S]+from public,anon,authenticated,service_role/)
  assert.match(adjustmentVisibility, /revoke all on function attendance_private\.admin_employee_adjustment_history\(uuid,integer,integer\)[\s\S]+from public,anon,authenticated,service_role/)
  assert.doesNotMatch(adjustmentVisibility, /jsonb_array_elements\([^\n]+rows/)
})

test('adjustment audit and mutations close the category permission boundary before writes', () => {
  const logs = adjustmentCategoryClosure.slice(
    adjustmentCategoryClosure.indexOf('create or replace function public.admin_data_entry_logs'),
    adjustmentCategoryClosure.indexOf('create or replace function public.admin_adjustment_editor_options'),
  )
  const editor = adjustmentCategoryClosure.slice(
    adjustmentCategoryClosure.indexOf('create or replace function public.admin_adjustment_editor_options'),
    adjustmentCategoryClosure.indexOf('create or replace function public.admin_adjustment_upsert'),
  )
  const upsert = adjustmentCategoryClosure.slice(
    adjustmentCategoryClosure.indexOf('create or replace function public.admin_adjustment_upsert'),
    adjustmentCategoryClosure.indexOf('revoke all on function public.admin_adjustment_editor_options'),
  )

  assert.match(logs, /adjustment\.bonus\.view[\s\S]+adjustment\.deduction\.view/)
  assert.match(logs, /scoped as \([\s\S]+adjustment_visibility_kind\([\s\S]+filtered as materialized/)
  assert.ok(logs.indexOf('adjustment_visibility_kind(') < logs.indexOf('filtered as materialized'))

  assert.match(editor, /adjustment\.page\.create[\s\S]+adjustment\.page\.edit/)
  assert.match(editor, /adjustment\.bonus\.view[\s\S]+adjustment\.deduction\.view/)

  assert.match(upsert, /v_target_kind[\s\S]+adjustment\.bonus\.view[\s\S]+adjustment\.deduction\.view/)
  assert.match(upsert, /select attendance_private\.adjustment_visibility_kind\([\s\S]+v_current_kind='unclassified'/)
  assert.match(upsert, /v_current_kind is null[\s\S]+not \(v_can_bonus and v_can_deduction\)[\s\S]+permission_denied/)
  assert.equal((upsert.match(/admin_adjustment_upsert_page_v1\(p_payload\)/g) ?? []).length, 1)
  assert.doesNotMatch(upsert, /\binsert\s+into\b|\bupdate\s+public\.|\bdelete\s+from\b/i)
  assert.ok(upsert.indexOf("v_current_kind='unclassified'") < upsert.indexOf('admin_adjustment_upsert_page_v1(p_payload)'))

  assert.match(attendancePage, /canCreateAdjustment=access\.hasPermission\(PERMISSIONS\.ADJUSTMENT_PAGE_CREATE\)&&\(canViewAdjustmentBonus\|\|canViewAdjustmentDeduction\)/)
  assert.match(attendancePage, /AdjustmentEditorModal record=\{adjustmentEditor\.row\} canViewBonus=\{canViewAdjustmentBonus\} canViewDeduction=\{canViewAdjustmentDeduction\}/)
  assert.match(attendancePage, /numericAmount>0&&!canViewBonus[\s\S]+numericAmount<0&&!canViewDeduction/)
})

test('account overview payloads omit sensitive employee contact fields', () => {
  assert.match(accounts, /function employeeWithoutSensitiveContact\(employee: any\)[\s\S]+const \{ work_tg: _workTg, \.\.\.safeEmployee \} = employee/)
  const sanitizedLists = accounts.match(/employees: employees\.map\((?:employeeWithoutSensitiveContact|decorateScopeEmployee)\)/g) ?? []
  assert.equal(sanitizedLists.length, 1)
  assert.match(accounts, /const decorateScopeEmployee = \(employee: any\) => employee[\s\S]+employeeWithoutSensitiveContact\(employee\)/)
  assert.match(accounts, /employees: employees\.map\(decorateScopeEmployee\)/)
  assert.match(accounts, /employee: x\.employee_id[\s\S]+decorateScopeEmployee\(scope\.employeeMap\.get\(x\.employee_id\)\)/)
})

test('directory-owned restore permission reaches the shared reactivation mutation', () => {
  const restoreGuards = employees.match(/requireAnyPermission\(service, caller, \[\s*"employee\.directory\.reactivate",\s*"employee\.resignations\.reactivate",\s*\]\)/g) ?? []
  assert.equal(restoreGuards.length, 2)
  assert.match(employees, /\["undo_resignation", "reactivate_employee"\]\.includes\(action\)/)
  assert.match(employees, /if \(action === "undo_resignation" \|\| action === "reactivate_employee"\)/)
})

test('payout proof storage follows the granular change-history permission', () => {
  assert.match(payroll, /payment_change_admin_can_read_object\(text\)/)
  assert.match(payroll, /payment_change_admin_object_permission_guard_prerequisite_changed/)
  assert.match(payroll, /payroll\.payout_change\.view'[\s\S]+payroll\.change_history\.view/)
  assert.match(payroll, /payroll\.payout_change\.review'[\s\S]+payroll\.change_history\.review/)
})

test('report roster pages do not execute overview or order-metric loaders', () => {
  const rosterPageBlock = reports.slice(reports.indexOf('async function rosterPage'), reports.indexOf('function splitAccounts'))
  assert.ok(rosterPageBlock.length > 0)
  assert.doesNotMatch(rosterPageBlock, /overview|buildContext|loadAccountDirectory|loadSyncedOrderSummary|order_metrics|order_summary|recent_orders/)
  assert.match(reports, /if\(action==='overview'\)return json\(await overview\(service,scope\)\)/)
  for (const action of ['people','legacy_schedule','platform','statistics_context']) {
    assert.ok(reports.includes(`if(action==='${action}')return json(await rosterPage(service,scope,'${action}'))`))
  }
  assert.doesNotMatch(reports, /\['overview','people','legacy_schedule','platform','statistics_context'\]\.includes\(action\)/)
})

test('report roster page projections expose only fields required by each UI', () => {
  const platformProjection = reports.slice(reports.indexOf('function platformRosterRow'), reports.indexOf('function statisticsRosterRow'))
  for (const field of ['key','team','name','employee_id','shift','country','position','platform']) assert.ok(platformProjection.includes(`${field}:`))
  for (const field of ['responsible','onsite_trainer','online_leader','online_trainer','group','work_content','hire_date','source_row']) assert.ok(!platformProjection.includes(`${field}:`))

  const fullProjection = reports.slice(reports.indexOf('function fullRosterRow'), reports.indexOf('function platformRosterRow'))
  for (const field of ['responsible','onsite_trainer','online_leader','online_trainer','group','team','name','employee_id','shift','country','position','platform','work_content']) assert.ok(fullProjection.includes(`${field}:`))

  const statisticsProjection = reports.slice(reports.indexOf('function statisticsRosterRow'), reports.indexOf('function rosterOptions'))
  for (const field of ['responsible','onsite_trainer','online_leader','online_trainer','group','team','name','employee_id','country','position','platform']) assert.ok(statisticsProjection.includes(`${field}:`))
  for (const field of ['hire_date','source_row','backend_accounts']) assert.ok(!statisticsProjection.includes(`${field}:`))
})

test('platform report uses a compact modal that matches its minimal Edge projection', () => {
  const platformsComponent = reportsPage.slice(reportsPage.indexOf('function Platforms'), reportsPage.indexOf('function Orders('))
  assert.match(platformsComponent, /<PlatformRosterModal title=\{modal\.title\}/)
  assert.doesNotMatch(platformsComponent, /<RosterModal title=\{modal\.title\}/)

  const table = reportsPage.slice(reportsPage.indexOf('function PlatformRosterTable'), reportsPage.indexOf('function PlatformRosterModal'))
  for (const field of ['team','name','employee_id','country','shift','position','platform']) assert.ok(table.includes(`r.${field}`))
  for (const field of ['responsible','onsite_trainer','online_leader','online_trainer','group','work_content']) assert.ok(!table.includes(`r.${field}`))
})

test('role saves discard client-supplied hidden legacy ids before deriving dependencies', () => {
  assert.match(accounts, /hiddenLegacyCodes/)
  assert.match(accounts, /permissionIds = visiblePermissions\.map/)
  assert.match(accounts, /for \(const permission of visiblePermissions\)/)
  assert.doesNotMatch(accounts, /code === 'alert\.[^']+'\) add\(/)
  assert.match(migration, /admin_alert_center_permission_guard_prerequisite_changed/)
  assert.match(migration, /alert\.view grants the page shell only[\s\S]+type_counts','\{\}'::jsonb,'rows','\[\]'::jsonb/)
})
