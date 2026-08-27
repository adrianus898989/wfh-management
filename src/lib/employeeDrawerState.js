export const EMPLOYEE_DETAIL_TIMEOUT_MS = 12000

const hasValue = value => value !== null && value !== undefined && String(value).trim() !== ''

export function employeeMetricCountLabel(value,unit){
  if(!hasValue(value)) return '—'
  const count=Number(value)
  if(!Number.isFinite(count)) return '—'
  return `${count} ${unit}`
}

export function employeeRiskGradeFromTotal(value){
  if(!hasValue(value)) return '—'
  const total=Number(value)
  if(!Number.isFinite(total)) return '—'
  if(total>=31)return '高频'
  if(total>=16)return '重点'
  if(total>=9)return '注意'
  if(total>=1)return '正常'
  return '优秀'
}

export function employeeProfileMetricSeed(employee={}){
  return {
    employee_id:employee.id||'',
    month_records:hasValue(employee.month_error_count)?Number(employee.month_error_count):null,
    total_errors:hasValue(employee.total_error_count)?Number(employee.total_error_count):null,
  }
}

export function mergeEmployeeDetailRefresh(previous={},incoming={}){
  const previousEmployee=previous?.employee||{}
  const incomingEmployee=incoming?.employee||{}
  const partialSections=new Set(
    (Array.isArray(incoming?.partial_errors)?incoming.partial_errors:[])
      .map(value=>String(value??'').trim())
      .filter(Boolean),
  )
  const merged={
    ...incoming,
    employee:{
      ...incomingEmployee,
      month_error_count:hasValue(previousEmployee.month_error_count)
        ? previousEmployee.month_error_count
        : incomingEmployee.month_error_count,
      total_error_count:hasValue(previousEmployee.total_error_count)
        ? previousEmployee.total_error_count
        : incomingEmployee.total_error_count,
      risk_level:hasValue(previousEmployee.risk_level)
        ? previousEmployee.risk_level
        : incomingEmployee.risk_level,
    },
    resignation_reason:String(previous?.resignation_reason||incoming?.resignation_reason||'').trim(),
  }
  if(partialSections.has('联系方式')&&previous?.contact!==undefined) merged.contact=previous.contact
  if(partialSections.has('收款资料')&&previous?.payment!==undefined) merged.payment=previous.payment
  if(partialSections.has('工资设置')&&previous?.compensation!==undefined) merged.compensation=previous.compensation
  return merged
}

export function withEmployeeDetailTimeout(promise,timeoutMs=EMPLOYEE_DETAIL_TIMEOUT_MS){
  let timer
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      const error=new Error('完整档案读取超时，已保留当前可见资料。')
      error.code='employee_detail_timeout'
      reject(error)
    },timeoutMs)
  })
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer))
}
