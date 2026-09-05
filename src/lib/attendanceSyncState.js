const text=value=>String(value??'').trim()

export const ATTENDANCE_AUTO_REFRESH_MS=2*60*1000

const PROTECTED_SYNC_CODES=new Set([
  'empty_snapshot_requires_manual_override',
  'large_delete_requires_manual_override',
  'stale_snapshot',
])

const timestamp=(...values)=>values.map(text).find(Boolean)||''
const latestTimestamp=values=>values.map(text).filter(Boolean).sort().at(-1)||''

export const attendanceSyncProtectionCode=value=>{
  const candidate=text(value)
  if(!candidate)return ''
  for(const code of PROTECTED_SYNC_CODES){
    if(candidate.includes(code))return code
  }
  return ''
}

export const attendanceVisibleRefreshDue=({
  visibilityState,
  loading=false,
  lastAttemptAt=0,
  now=Date.now(),
  intervalMs=ATTENDANCE_AUTO_REFRESH_MS,
}={})=>visibilityState==='visible'
  &&!loading
  &&Number(now)-Number(lastAttemptAt||0)>=Math.max(1,Number(intervalMs)||ATTENDANCE_AUTO_REFRESH_MS)

export const attendanceSyncMeta=payload=>{
  const sourcePayload=payload&&typeof payload==='object'&&!Array.isArray(payload)?payload:{}
  const nested=[sourcePayload.sync,sourcePayload.sync_status,sourcePayload.source_sync,sourcePayload.sync_state,sourcePayload.latest_sync]
    .find(value=>value&&typeof value==='object'&&!Array.isArray(value))||{}
  const sources=[sourcePayload.sources,sourcePayload.source_statuses,nested.sources].find(Array.isArray)||[]
  const failedSources=sources.filter(source=>['failed','error'].includes(text(source?.status||source?.sync_status).toLowerCase()))
  const sourceAttemptTimes=sources.map(source=>timestamp(source?.attempted_at,source?.last_synced_at,source?.synced_at,source?.refreshed_at))
  const sourceSuccessTimes=sources.map(source=>timestamp(source?.last_success_at,source?.last_successful_sync_at))
  const status=text(nested.status||sourcePayload.sync_status||sourcePayload.status).toLowerCase()
  const errors=[
    nested.error,nested.error_code,nested.error_message,
    sourcePayload.error,sourcePayload.error_code,sourcePayload.error_message,
    ...failedSources.flatMap(source=>[source?.error,source?.error_code,source?.error_message]),
  ]
  const protectionCode=errors.map(attendanceSyncProtectionCode).find(Boolean)||''
  const attemptedAt=timestamp(
    nested.attempted_at,nested.last_synced_at,nested.synced_at,nested.refreshed_at,
    sourcePayload.last_synced_at,sourcePayload.last_sync_at,sourcePayload.latest_sync_at,sourcePayload.synced_at,sourcePayload.refreshed_at,
    latestTimestamp(sourceAttemptTimes),
  )
  const lastSuccessAt=timestamp(
    nested.last_success_at,nested.last_successful_sync_at,
    sourcePayload.last_success_at,sourcePayload.last_successful_sync_at,
    latestTimestamp(sourceSuccessTimes),
  )

  if(protectionCode){
    const stale=protectionCode==='stale_snapshot'
    return {
      status:'protected',
      label:stale?'已忽略过期同步':'同步受保护',
      last:attemptedAt,
      lastLabel:stale?'忽略时间':'保护触发',
      lastSuccessAt,
      issueCode:protectionCode,
      detail:stale
        ?'收到的 Google 快照早于当前资料，系统已忽略；Supabase 中的现有数据保持不变。'
        :'本次 Google 快照触发资料完整性保护，Supabase 没有删除既有记录；当前继续展示已保存的数据。',
    }
  }

  const sourceFailed=failedSources.length>0
  const failed=sourceFailed||['failed','error'].includes(status)
  const last=attemptedAt||lastSuccessAt
  if(failed)return {
    status:'error',label:'同步异常',last,lastLabel:'失败时间',lastSuccessAt,issueCode:'',
    detail:'Google 同步未成功；当前页面仍保留并展示 Supabase 中最后读取成功的数据。',
  }
  if(status==='syncing')return {status:'syncing',label:'同步中',last,lastLabel:'开始时间',lastSuccessAt,issueCode:'',detail:'Google 数据正在写入 Supabase。'}
  if(last||status==='success')return {status:'success',label:'已同步',last,lastLabel:'最近同步',lastSuccessAt:lastSuccessAt||last,issueCode:'',detail:'页面数据来自 Supabase。'}
  return {status:'idle',label:'等待同步状态',last:'',lastLabel:'',lastSuccessAt:'',issueCode:'',detail:'等待后端返回同步状态。'}
}
