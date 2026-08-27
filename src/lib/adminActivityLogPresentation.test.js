import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {
  ACTIVITY_LOG_MODULE_OPTIONS,
  activityActionLabel,
  activityCategoryLabel,
  activityModuleLabel,
  activitySourceLabel,
  buildActivityLogRpcParams,
  formatActivityTime,
} from './adminActivityLogPresentation.js'

const pageSource=readFileSync(new URL('../pages/AdminActivityLogPage.jsx',import.meta.url),'utf8')
const migrationSource=readFileSync(new URL('../../supabase/migrations/20260827143000_admin_activity_log_search.sql',import.meta.url),'utf8')

test('activity log RPC params trim filters and clamp pagination',()=>{
  assert.deepEqual(buildActivityLogRpcParams({
    dateFrom:' 2026-08-01 ',dateTo:'',actor:' founder ',module:'auth',action:'delete',object:' WD0001 ',
  },0,999),{
    p_date_from:'2026-08-01',p_date_to:null,p_actor:'founder',p_module:'auth',p_action:'delete',p_object:'WD0001',p_page:1,p_page_size:20,
  })
  assert.equal(buildActivityLogRpcParams({},3,100).p_page_size,100)
})

test('activity log labels preserve raw audit meaning without exposing payloads',()=>{
  assert.equal(activityModuleLabel('access_control'),'账号与权限')
  assert.equal(activityCategoryLabel('delete'),'删除 / 归档 / 撤销')
  assert.equal(activityActionLabel('role_permissions_update','update'),'编辑角色权限')
  assert.equal(activitySourceLabel('employee_attendance_records'),'考勤 / 奖惩记录补位')
  assert.deepEqual(ACTIVITY_LOG_MODULE_OPTIONS.find(([value])=>value==='alerts'),['alerts','预警中心'])
  assert.notEqual(formatActivityTime('2026-08-27T08:00:00Z'),'—')
  assert.equal(formatActivityTime('not-a-time'),'—')
})

test('activity log query pushes date bounds into every source and normalizes module families',()=>{
  assert.ok((migrationSource.match(/p_date_from is null/g)||[]).length>=5)
  assert.ok((migrationSource.match(/p_date_to is null/g)||[]).length>=5)
  assert.match(migrationSource,/audit\.module='exam' or audit\.module like 'exam_%'[\s\S]+then 'exam'/)
  assert.match(migrationSource,/audit\.module in \('alerts','alert','warning','warning_center'\) then 'alerts'/)
  assert.match(migrationSource,/delete\|archive\|cancel\|remove\|void\|revoke\|close\|deactivate/)
  assert.match(migrationSource,/entry\.source='payroll_audit_log'[\s\S]+entry\.employee_id is null/)
  assert.match(migrationSource,/audit\.actor_user_id=coalesce\(record\.updated_by,record\.created_by\)/)
})

test('activity log UI consumes only redacted RPC fields and explains source limitations',()=>{
  assert.match(pageSource,/admin_activity_log_search/)
  assert.match(pageSource,/数据库从未记录的历史不会自动补出/)
  assert.match(pageSource,/默认读取最近 30 天/)
  assert.match(pageSource,/非全部数据范围仅显示本人操作/)
  assert.doesNotMatch(pageSource,/row\.(?:old_data|new_data|changes|metadata|detail|raw_values)/)
  for(const key of ['created_at','actor_name','module','action','action_category','object_id','object_name','summary','source']){
    assert.match(migrationSource,new RegExp(`'${key}'\\s*,paged\\.${key}`))
  }
  assert.doesNotMatch(migrationSource,/'(?:old_data|new_data|changes|metadata|detail|raw_values)'\s*,paged\./)
})
