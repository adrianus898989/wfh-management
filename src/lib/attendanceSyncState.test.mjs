import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import {
  ATTENDANCE_AUTO_REFRESH_MS,
  attendanceSyncMeta,
  attendanceVisibleRefreshDue,
} from './attendanceSyncState.js'

test('large-delete guard is presented as protected data instead of a database outage',()=>{
  const state=attendanceSyncMeta({
    sources:[{
      status:'failed',
      synced_at:'2026-09-05T04:04:59Z',
      error_message:'large_delete_requires_manual_override',
    }],
  })
  assert.equal(state.status,'protected')
  assert.equal(state.label,'同步受保护')
  assert.equal(state.last,'2026-09-05T04:04:59Z')
  assert.equal(state.lastLabel,'保护触发')
  assert.match(state.detail,/没有删除既有记录/)
})

test('ordinary transport or database failures remain real sync errors',()=>{
  const state=attendanceSyncMeta({latest_sync:{status:'failed',synced_at:'2026-09-05T05:00:00Z',error_message:'database_timeout'}})
  assert.equal(state.status,'error')
  assert.equal(state.lastLabel,'失败时间')
  assert.match(state.detail,/保留并展示/)
})

test('successful sync exposes a neutral latest-sync timestamp',()=>{
  const state=attendanceSyncMeta({latest_sync:{status:'success',synced_at:'2026-09-05T05:01:00Z'}})
  assert.deepEqual(
    {status:state.status,label:state.label,last:state.last,lastLabel:state.lastLabel},
    {status:'success',label:'已同步',last:'2026-09-05T05:01:00Z',lastLabel:'最近同步'},
  )
})

test('legacy attendance page payloads keep their last_synced_at compatibility',()=>{
  const state=attendanceSyncMeta({sync_status:{status:'success',last_synced_at:'2026-09-05T05:02:00Z'}})
  assert.equal(state.status,'success')
  assert.equal(state.last,'2026-09-05T05:02:00Z')
})

test('attendance auto refresh runs only for a visible idle view after the bounded interval',()=>{
  const common={lastAttemptAt:1_000,now:1_000+ATTENDANCE_AUTO_REFRESH_MS}
  assert.equal(attendanceVisibleRefreshDue({...common,visibilityState:'hidden'}),false)
  assert.equal(attendanceVisibleRefreshDue({...common,visibilityState:'visible',loading:true}),false)
  assert.equal(attendanceVisibleRefreshDue({...common,visibilityState:'visible',now:common.now-1}),false)
  assert.equal(attendanceVisibleRefreshDue({...common,visibilityState:'visible'}),true)
})

test('edge sync classifies guarded snapshots as non-retryable 422 responses',async()=>{
  const edge=await readFile(new URL('../../supabase/functions/attendance-sheet-sync/index.ts',import.meta.url),'utf8')
  assert.match(edge,/large_delete_requires_manual_override/)
  assert.match(edge,/deterministicRejection[\s\S]+jsonResponse\(data, 422\)/)
})

test('admin and staff attendance views refresh on a bounded timer and retain prior staff data on failure',async()=>{
  const [admin,staff]=await Promise.all([
    readFile(new URL('../pages/AdminAttendancePage.jsx',import.meta.url),'utf8'),
    readFile(new URL('../pages/PortalPage.jsx',import.meta.url),'utf8'),
  ])
  for(const source of [admin,staff]){
    assert.match(source,/useVisibleDataRefresh/)
    assert.match(source,/intervalMs:ATTENDANCE_AUTO_REFRESH_MS/)
    assert.match(source,/lastCompletedAt:\(\)=>lastRefreshAttemptRef\.current/)
    assert.match(source,/attendanceVisibleRefreshDue/)
  }
  assert.match(admin,/AttendanceSyncNotice sync=\{state\.sync\}/)
  assert.match(staff,/setView\(current=>\(\{\.\.\.current,loading:false,error:reason\}\)\)/)
})

test('heavy background jobs retain their frequency but start at separate minutes',async()=>{
  const migration=await readFile(
    new URL('../../supabase/migrations/20260905194500_stagger_heavy_background_jobs.sql',import.meta.url),
    'utf8',
  )
  assert.match(migration,/wfh-exam-sheet-sync-every-minute[\s\S]+2,7,12,17,22,27,32,37,42,47,52,57 \* \* \* \*/)
  assert.match(migration,/admin-alert-refresh-attendance[\s\S]+4,14,24,34,44,54 \* \* \* \*/)
  assert.match(migration,/select command[\s\S]+into exam_command/)
  assert.match(migration,/select command[\s\S]+into attendance_command/)
  assert.match(migration,/background_job_stagger_verification_failed/)
})

test('report fallback retains the promised five-minute cadence without colliding with exam sync',async()=>{
  const migration=await readFile(
    new URL('../../supabase/migrations/20260905195000_restore_five_minute_report_fallback.sql',import.meta.url),
    'utf8',
  )
  assert.match(migration,/wfh-report-sheet-sync-every-minute/)
  assert.match(migration,/0,5,10,15,20,25,30,35,40,45,50,55 \* \* \* \*/)
  assert.match(migration,/cron\.alter_job/)
  assert.match(migration,/report_sync_five_minute_cadence_verification_failed/)
})
