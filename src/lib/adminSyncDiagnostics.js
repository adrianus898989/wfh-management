const clean=value=>String(value??'').trim()
const numeric=value=>Number.isFinite(Number(value))?Number(value):0

export const ADMIN_SYNC_DIAGNOSTIC_META=Object.freeze({
  cross_source_name_mismatch:{zh:'两份员工来源姓名不一致',en:'Employee names differ between sources'},
  home_resigned_but_still_scheduled:{zh:'居家名单已离职，但排班仍存在',en:'Resigned in home roster but still scheduled'},
  pending_manual_review:{zh:'两份当前名单均找不到，等待人工确认',en:'Missing from both current sources; manual review required'},
  schedule_only_missing_onsite_marker:{zh:'只在排班出现，且没有现场转居家标记',en:'Schedule-only row without onsite-to-home marker'},
  schedule_duplicate_employee_id_quarantined:{zh:'排班内员工 ID 重复，已隔离未覆盖资料',en:'Duplicate schedule employee ID quarantined'},
  temporary_and_official_records_both_exist:{zh:'临时 ID 与正式 ID 记录同时存在',en:'Temporary and official employee records both exist'},
  source_sync_failed:{zh:'来源同步失败',en:'Source synchronization failed'},
  source_sync_partial:{zh:'来源仅部分同步',en:'Source synchronization partially completed'},
  source_error_rows:{zh:'来源含错误行',en:'Source contains error rows'},
  source_ambiguous_identity:{zh:'有记录匹配到多名员工',en:'Some rows match multiple employees'},
  source_unmatched_identity:{zh:'有记录无法匹配员工',en:'Some rows could not match an employee'},
  source_parse_warning:{zh:'来源格式解析需要核对',en:'Source parsing needs review'},
})

export function adminSyncDiagnosticLabel(code,locale='zh'){
  return ADMIN_SYNC_DIAGNOSTIC_META[clean(code)]?.[locale]||clean(code)||'—'
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
  if(clean(detail.reason))parts.push(clean(detail.reason))
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

