import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import {
  employeeTrainerReviewRows,
  employeeTrainingTableRow,
  mergeTrainerIdentityDirectory,
  selectedTrainingHistoryRow,
  trainerIdentityCandidates,
  trainerTrainingTableRow,
} from './onlineTrainingPresentation.js'

const onlineTrainingPage=readFileSync(new URL('../pages/OnlineTrainingPage.jsx',import.meta.url),'utf8')
const onlineTrainingStyles=readFileSync(new URL('../styles-online-training.css',import.meta.url),'utf8')

test('employee daily-report table keeps the requested employee-first columns',()=>{
  assert.deepEqual(employeeTrainingTableRow({
    employee_id:'uuid-1',hire_date:'2026-01-13',employee_no:'CJ00007',employee_name:'Dohren',
    team_name:'AR印尼',position_name:'彩金',trainer_name:'小王',report_count:'7',recorded_days:'6',
    missing_days:'1',last_report_date:'2026-08-25',
  }),{
    key:'uuid-1',hireDate:'2026-01-13',employeeNo:'CJ00007',name:'Dohren',team:'AR印尼',position:'彩金',
    trainer:'小王',reportCount:7,recordedDays:6,missingDays:1,lastReportDate:'2026-08-25',
  })
})

test('trainer table does not invent an employee id or hire date from trainees',()=>{
  const row=trainerTrainingTableRow({
    trainer_key:'trainer-a',trainer_name:'Trainer A',team_names:['AR印度'],position_names:['线上培训'],
    report_count:2,recorded_days:2,employee_count:5,last_report_date:'2026-08-25',
  })
  assert.equal(row.employeeNo,'')
  assert.equal(row.hireDate,'')
  assert.deepEqual(row.teams,['AR印度'])
})

test('trainer identity lookup is batched by trainer key and keeps trainer fields separate from trainees',()=>{
  assert.deepEqual(trainerIdentityCandidates([
    {trainer_key:'trainer-a',trainer_employee_no:'CJ00007',trainer_name:'Trainer A'},
    {trainer_key:'trainer-a',trainer_employee_no:'TRAINEE-1',trainer_name:'Duplicate group'},
    {trainer_key:'trainer-b',trainer_name:'Trainer B'},
  ]),[
    {trainer_key:'trainer-a',trainer_employee_no:'CJ00007',trainer_name:'Trainer A'},
    {trainer_key:'trainer-b',trainer_employee_no:'',trainer_name:'Trainer B'},
  ])
})

test('authoritative trainer directory fills id and hire date without replacing unresolved fallbacks',()=>{
  const rows=mergeTrainerIdentityDirectory([
    {trainer_key:'trainer-a',trainer_employee_no:'',trainer_hire_date:'',trainer_name:'Trainer A'},
    {trainer_key:'trainer-b',trainer_employee_no:'AUTHOR-1',trainer_hire_date:'',trainer_name:'Trainer B'},
  ],[
    {trainer_key:'trainer-a',employee_no:'CJ00007',hire_date:'2026-01-13'},
    {trainer_key:'trainer-b',employee_no:null,hire_date:null},
  ])
  assert.equal(rows[0].trainer_employee_no,'CJ00007')
  assert.equal(rows[0].trainer_hire_date,'2026-01-13')
  assert.equal(rows[1].trainer_employee_no,'AUTHOR-1')
  assert.equal(rows[1].trainer_hire_date,'')
})

test('history selection keeps a selected row and safely falls back to the latest row',()=>{
  const rows=[{id:'latest',report_date:'2026-08-25'},{id:'older',report_date:'2026-08-24'}]
  assert.equal(selectedTrainingHistoryRow(rows,'older')?.id,'older')
  assert.equal(selectedTrainingHistoryRow(rows,'missing')?.id,'latest')
  assert.equal(selectedTrainingHistoryRow([],''),null)
})

test('teacher review adapter selects the employee and preserves report context',()=>{
  const rows=employeeTrainerReviewRows([{
    id:'report-1',report_date:'2026-08-26',title:'日报 A',author_name:'Trainer A',updated_at:'2026-08-26T12:00:00Z',
    report_summary:'团队整体正常',members:[
      {id:'member-a',employee_id:'employee-a',attendance_status:'normal',work_details:'完成培训',performance:'积极',issues:'无',follow_up:'继续跟进',metrics:{response_time:'12 秒'}},
      {id:'member-b',employee_id:'employee-b',attendance_status:'rest',status_note:'公休'},
    ],
  }],'employee-a')
  assert.equal(rows.length,1)
  assert.equal(rows[0].key,'member-a')
  assert.equal(rows[0].reportDate,'2026-08-26')
  assert.equal(rows[0].trainerName,'Trainer A')
  assert.equal(rows[0].workDetails,'完成培训')
  assert.equal(rows[0].responseTime,'12 秒')
  assert.equal(rows[0].reportSummary,'团队整体正常')
})

test('daily-report member index has a definite desktop scrollport and a mobile height reset',()=>{
  const workspaceRule=onlineTrainingStyles.match(/\.ot-report-detail-workspace\{[^}]+\}/)?.[0]||''
  const memberIndexRule=onlineTrainingStyles.match(/\.ot-member-index\{[^}]+\}/)?.[0]||''
  assert.match(workspaceRule,/height:clamp\(360px,56dvh,620px\)/)
  assert.match(workspaceRule,/grid-template-rows:minmax\(0,1fr\)/)
  assert.match(memberIndexRule,/min-height:0/)
  assert.match(memberIndexRule,/overflow:hidden/)
  assert.match(onlineTrainingStyles,/\.ot-member-index>div,\.ot-history-index>div\{[^}]*flex:1 1 0[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/)
  assert.match(onlineTrainingStyles,/\.ot-report-detail-workspace,\.ot-history-workspace\{display:block;height:auto;max-height:none\}/)
})

test('daily-report delete confirmation preserves its parent until the archive succeeds',()=>{
  const archiveSource=onlineTrainingPage.slice(
    onlineTrainingPage.indexOf('const archiveReport=async()=>'),
    onlineTrainingPage.indexOf('const reviewReport=async'),
  )
  const cancelSource=archiveSource.slice(archiveSource.indexOf('const cancelDelete='))
  assert.match(onlineTrainingPage,/onDelete=\{\(\)=>requestDelete\(viewing\)\}/)
  assert.match(onlineTrainingPage,/HistoryModal[^\n]+onDelete=\{requestDelete\}/)
  assert.doesNotMatch(onlineTrainingPage,/onDelete=\{\(\)=>\{[^}]*closeViewer\(\)[^}]*setDeleteTarget/)
  assert.doesNotMatch(onlineTrainingPage,/onDelete=\{row=>\{[^}]*closeHistory\(\)[^}]*setDeleteTarget/)
  assert.match(archiveSource,/await call\('online_training_archive_report'[^\n]+\)\n\s+if\(deletingViewedReport\)closeViewer\(\)/)
  assert.match(archiveSource,/if\(history\?\.person\)await loadHistory\(history\.person,history\.period,history\.basePeriod\)/)
  assert.match(archiveSource,/if\(openTrainer\)await loadTrainerHistory\(openTrainer\)/)
  assert.match(archiveSource,/catch\(err\)\{setDeleteError\(readableError\(err,'报告删除失败'\)\)\}/)
  assert.doesNotMatch(cancelSource,/close(?:Viewer|History|TrainerHistory)\(/)
  assert.match(onlineTrainingPage,/ConfirmModal saving=\{saving\} title=\{deleteTarget\.title\} error=\{deleteError\} onCancel=\{cancelDelete\}/)
  assert.match(onlineTrainingPage,/className="ot-confirm-error" role="alert"/)
  assert.match(onlineTrainingStyles,/\.ot-confirm-backdrop\{z-index:2500\}/)
})

test('trainer history signs attachment URLs only when one report is opened',()=>{
  const openViewSource=onlineTrainingPage.slice(
    onlineTrainingPage.indexOf('const openView=async'),
    onlineTrainingPage.indexOf('const openEdit=async'),
  )
  const trainerHistorySource=onlineTrainingPage.slice(
    onlineTrainingPage.indexOf('const loadTrainerHistory=async'),
    onlineTrainingPage.indexOf('const closeTrainerHistory='),
  )
  assert.match(openViewSource,/hydrateAttachments\(\[row\]\)/)
  assert.doesNotMatch(trainerHistorySource,/hydrateAttachments/)
  assert.match(trainerHistorySource,/setTrainerHistory\(\{trainer,loading:false,rows:exact,error:''\}\)/)
})

test('trainer landing page uses one bounded server aggregation request per page',()=>{
  const loadListSource=onlineTrainingPage.slice(
    onlineTrainingPage.indexOf('const loadList=async'),
    onlineTrainingPage.indexOf('useEffect(()=>{loadBootstrap'),
  )
  assert.match(loadListSource,/requestedMode==='reports'\?'online_training_search_trainers':'online_training_search_people'/)
  assert.match(loadListSource,/p_page:nextPage/)
  assert.match(loadListSource,/p_page_size:pageSize/)
  assert.doesNotMatch(loadListSource,/Promise\.all|online_training_search_reports|online_training_resolve_trainer_identities|hydrateAttachments|createSignedUrls/)
})

test('training result pages expose bounded page-size choices and one global report summary',()=>{
  assert.match(onlineTrainingPage,/const \[pageSize,setPageSize\]=useState\(20\)/)
  assert.match(onlineTrainingPage,/pageSizeOptions=\{\[20,30,50,100\]\}/)
  const pageControls=readFileSync(new URL('../components/DataPageControls.jsx',import.meta.url),'utf8')
  assert.match(pageControls,/pageSizeOptions=PAGE_SIZE_OPTIONS/)
  assert.match(pageControls,/pageSizeOptions\.map\(n=>/)
  assert.equal((onlineTrainingPage.match(/ot-report-global-summary/g)||[]).length,1)
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260828172000_online_training_page_size_options.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/least\(greatest\(coalesce\(p_page_size, 20\), 1\), 100\)/)
  assert.match(migration,/online_training_page_size_guard_changed/)
  assert.match(migration,/set local lock_timeout = '500ms'/)
})

test('trainer summary RPC preserves session, view, employee-scope and execute boundaries',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260827121500_online_training_trainer_summary_pagination.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/create or replace function public\.online_training_search_trainers/)
  assert.match(migration,/security definer[\s\S]*set search_path = ''/)
  assert.match(migration,/session_private\.current_app_session_is_valid\('admin'\)/)
  assert.match(migration,/online_training\.report\.view/)
  assert.match(migration,/public\.online_training_can_view_module\(\)/)
  assert.match(migration,/public\.backend_employee_in_scope\(employee\.id\)/)
  assert.match(migration,/trainer_assignment_ids/)
  assert.match(migration,/public\.online_training_can_view_report\(report\.id\)/)
  assert.match(migration,/public\.online_training_resolve_trainer_identities\(v_candidates\)/)
  assert.match(migration,/row_number\(\) over/)
  assert.match(migration,/revoke all on function public\.online_training_search_trainers[\s\S]*from public, anon, authenticated, service_role/)
  assert.match(migration,/grant execute on function public\.online_training_search_trainers[\s\S]*to authenticated, service_role/)
  assert.doesNotMatch(migration,/grant execute[\s\S]*to (?:public|anon)/i)
})

test('hire-date migration only projects the authoritative candidate value',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260826151000_online_training_hire_date_output.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/pg_get_functiondef\(v_function\)/)
  assert.match(migration,/candidate\.trainer_name,[\\n\s]+candidate\.hire_date,[\\n\s]+candidate\.is_current_roster/)
  assert.doesNotMatch(migration,/\b(?:grant|revoke)\b/i)
  assert.doesNotMatch(migration,/alter\s+function|rename\s+to/i)
  assert.doesNotMatch(migration,/period_from\s+(?:as\s+)?hire_date/i)
  const sqlRegression=readFileSync(new URL(
    '../../supabase/tests/online_training_hire_date_output.sql',
    import.meta.url,
  ),'utf8')
  assert.match(sqlRegression,/candidate\.hire_date/)
  assert.match(sqlRegression,/current_app_session_is_valid/)
  assert.match(sqlRegression,/has_function_privilege\('authenticated'/)
})

test('trainer identity migration keeps the resolver bounded and enforces a nonblank report summary',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260826164800_online_training_trainer_identity_summary_guard.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/online_training_resolve_trainer_identities/)
  assert.match(migration,/jsonb_array_length\(p_candidates\) > 200/)
  assert.match(migration,/employee_lifecycle_events/)
  assert.match(migration,/online_training_identity_key\(employee\.employee_no\)/)
  assert.match(migration,/online_training_identity_key\(employee\.full_name\)/)
  assert.match(migration,/count\(distinct lifecycle\.employee_id\) = 1/)
  assert.match(migration,/count\(distinct public\.online_training_identity_key/)
  assert.match(migration,/online_training_report_summary_required/)
  assert.match(migration,/nullif\(btrim\(coalesce\(p_report->>'report_summary'/)
  assert.match(migration,/online_training_employee_in_scope/)
  assert.match(migration,/online_training_save_report_scope_legacy/)
  const sqlRegression=readFileSync(new URL(
    '../../supabase/tests/online_training_trainer_identity_summary_guard.sql',
    import.meta.url,
  ),'utf8')
  assert.match(sqlRegression,/has_function_privilege/)
  assert.match(sqlRegression,/current_app_session_is_valid/)
  assert.match(sqlRegression,/online_training_report_summary_required/)
})

test('trainer identity resolver only returns employees inside the caller online-training scope',()=>{
  const migration=readFileSync(new URL(
    '../../supabase/migrations/20260826210354_scope_online_training_trainer_identity_resolver.sql',
    import.meta.url,
  ),'utf8')
  assert.match(migration,/security definer/)
  assert.match(migration,/set search_path = ''/)
  assert.match(migration,/current_app_session_is_valid\('admin'\)/)
  assert.match(migration,/online_training_can_view_module\(\)/)
  assert.match(migration,/online_training_employee_in_scope\(directory\.employee_id\)/)
  assert.match(migration,/from public, anon, authenticated/)
  assert.match(migration,/to authenticated/)
  assert.doesNotMatch(migration,/grant execute[\s\S]*to (?:public|anon)/i)
})
