const clean=value=>String(value??'').trim()
const numeric=value=>Number.isFinite(Number(value))?Number(value):0

export const ADMIN_SYNC_DIAGNOSTIC_META=Object.freeze({
  cross_source_name_mismatch:{zh:'两份员工来源姓名不一致',en:'Employee names differ between sources'},
  home_only_missing_schedule:{zh:'员工主表已有，等待排班分配',en:'Employee exists in the master roster and is awaiting schedule assignment'},
  home_resigned_but_still_scheduled:{zh:'居家名单已离职，但排班仍存在',en:'Resigned in home roster but still scheduled'},
  pending_manual_review:{zh:'员工状态或名单需人工复核',en:'Employee status or roster needs manual review'},
  schedule_only_missing_onsite_marker:{zh:'排班身份或现场标记需核对',en:'Schedule identity or onsite marker needs review'},
  schedule_duplicate_employee_id_quarantined:{zh:'排班内员工 ID 重复，已隔离未覆盖资料',en:'Duplicate schedule employee ID quarantined'},
  temporary_and_official_records_both_exist:{zh:'临时 ID 与正式 ID 记录同时存在',en:'Temporary and official employee records both exist'},
  source_sync_failed:{zh:'来源同步失败',en:'Source synchronization failed'},
  source_sync_partial:{zh:'来源仅部分同步',en:'Source synchronization partially completed'},
  source_error_rows:{zh:'来源含错误行',en:'Source contains error rows'},
  source_ambiguous_identity:{zh:'有记录匹配到多名员工',en:'Some rows match multiple employees'},
  source_unmatched_identity:{zh:'有记录无法匹配员工',en:'Some rows could not match an employee'},
  source_parse_warning:{zh:'来源格式解析需要核对',en:'Source parsing needs review'},
})

export const ADMIN_SYNC_DIAGNOSTIC_STATUS_META=Object.freeze({
  failed:{zh:'同步失败',en:'Failed',tone:'failed'},
  partial:{zh:'部分完成',en:'Partial',tone:'partial'},
  needs_review:{zh:'待核对',en:'Needs review',tone:'review'},
  resolved:{zh:'已处理',en:'Resolved',tone:'resolved'},
})

const ADMIN_SYNC_DIAGNOSTIC_REASON_META=Object.freeze({
  active_home_employee_not_yet_scheduled:{zh:'员工主表已有，当前排班尚未分配',en:'The employee exists in the master roster but has not yet been assigned to the schedule'},
  canonical_name_mismatch:{zh:'同一员工 ID 在员工主表与排班中的姓名不一致',en:'The same employee ID has different names in the master roster and schedule'},
  future_resignation_removed_from_schedule_early:{zh:'离职日期尚未生效，但已提前从排班移除',en:'The resignation date is not yet effective, but the employee was removed from the schedule early'},
  home_source_resigned_profile_still_active:{zh:'离职日期已生效/缺失，但员工档案仍在职',en:'The resignation date is effective or missing, but the employee profile is still active'},
  missing_onsite_marker:{zh:'排班中有此人，但没有现场人员确认标记',en:'The employee appears in the schedule without a confirmed onsite marker'},
})

export function adminSyncDiagnosticLabel(code,locale='zh'){
  return ADMIN_SYNC_DIAGNOSTIC_META[clean(code)]?.[locale]||clean(code)||'—'
}

export function adminSyncDiagnosticStatus(row,locale='zh'){
  const explicit=clean(row?.diagnostic_status)
  const fallback=row?.issue_code==='source_sync_failed'?'failed':row?.issue_code==='source_sync_partial'?'partial':'needs_review'
  const code=ADMIN_SYNC_DIAGNOSTIC_STATUS_META[explicit]?explicit:fallback
  return {code,...ADMIN_SYNC_DIAGNOSTIC_STATUS_META[code],label:ADMIN_SYNC_DIAGNOSTIC_STATUS_META[code][locale]}
}

export function adminSyncDiagnosticEvidence(row,locale='zh'){
  const detail=row?.details||{}
  const parts=[]
  if(detail.home_name||detail.schedule_name)parts.push(locale==='en'
    ? `Home: ${clean(detail.home_name)||'—'} · Schedule: ${clean(detail.schedule_name)||'—'}`
    : `居家名单：${clean(detail.home_name)||'—'} · 排班：${clean(detail.schedule_name)||'—'}`)
  if(numeric(detail.unmatched_count)>0)parts.push(locale==='en'?`${numeric(detail.unmatched_count)} unmatched of ${numeric(detail.row_count)} rows`:`${numeric(detail.row_count)} 行中有 ${numeric(detail.unmatched_count)} 行未匹配`)
  if(numeric(detail.ambiguous_count)>0)parts.push(locale==='en'?`${numeric(detail.ambiguous_count)} ambiguous matches`:`${numeric(detail.ambiguous_count)} 行匹配到多名员工`)
  if(numeric(detail.error_count)>0)parts.push(locale==='en'?`${numeric(detail.error_count)} error rows`:`${numeric(detail.error_count)} 行错误`)
  if(numeric(detail.parse_warning_count)>0)parts.push(locale==='en'?`${numeric(detail.parse_warning_count)} parse warnings`:`${numeric(detail.parse_warning_count)} 个格式警告`)
  if(numeric(detail.missing_streak)>0)parts.push(locale==='en'?`Missing checks: ${numeric(detail.missing_streak)}`:`连续 ${numeric(detail.missing_streak)} 次未在当前来源找到`)
  if(clean(detail.reason))parts.push(ADMIN_SYNC_DIAGNOSTIC_REASON_META[clean(detail.reason)]?.[locale]||clean(detail.reason))
  if(clean(detail.error_message))parts.push(clean(detail.error_message))
  const sourceRows=Array.isArray(detail.source_rows)?detail.source_rows.filter(Boolean):[]
  if(sourceRows.length)parts.push(locale==='en'?`Source rows: ${sourceRows.join(', ')}`:`来源行：${sourceRows.join('、')}`)
  return parts.length?parts:(locale==='en'?['Open the source rows shown below for verification.']:['请按下方来源行号核对。'])
}

export function adminSyncDiagnosticSourceRows(row,locale='zh'){
  const values=[]
  if(row?.home_source_row)values.push(`${locale==='en'?'Home row':'居家名单行'} ${row.home_source_row}`)
  if(row?.schedule_source_row)values.push(`${locale==='en'?'Schedule row':'排班行'} ${row.schedule_source_row}`)
  return values.join(' · ')||'—'
}
