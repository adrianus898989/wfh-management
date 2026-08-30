const clean=value=>String(value??'').trim()
const key=value=>clean(value).normalize('NFKC').toLocaleLowerCase()

const inDateRange=(date,filters)=>{
  const normalized=clean(date).slice(0,10)
  if(filters?.dateFrom&&(!normalized||normalized<filters.dateFrom))return false
  if(filters?.dateTo&&(!normalized||normalized>filters.dateTo))return false
  return true
}

const contains=(values,query)=>{
  const needle=key(query)
  if(!needle)return true
  return values.map(clean).join(' ').normalize('NFKC').toLocaleLowerCase().includes(needle)
}

export const filterEmployeeErrorHistory=(rows,filters={})=>(rows||[]).filter(row=>
  inDateRange(row?.qc_date,filters)&&contains([
    row?.qc_date,row?.error_type,row?.error_note,row?.correct_action,row?.qc_person,
    row?.leader_review,row?.qc_result,row?.score,row?.amount,row?.member_order,
  ],filters.query),
)

export const filterEmployeeExamHistory=(rows,filters={})=>(rows||[]).filter(row=>{
  const dates=[row?.started_at,row?.submitted_at,row?.graded_at].filter(Boolean)
  const matchesDate=!filters.dateFrom&&!filters.dateTo||dates.some(date=>inDateRange(date,filters))
  return matchesDate&&contains([
    ...dates,row?.title,row?.source_label,row?.source_system,row?.series_name,row?.team_name,
    row?.position_name,row?.grader_name,row?.status,row?.attempt_no,row?.percentage,
    row?.earned_score,row?.total_score,row?.passed===true?'通过':row?.passed===false?'未通过':'',
  ],filters.query)
})

export const filterEmployeePayrollHistory=(rows,filters={})=>{
  const fromMonth=clean(filters.from||filters.dateFrom).slice(0,7)
  const toMonth=clean(filters.to||filters.dateTo).slice(0,7)
  return (rows||[]).filter(row=>{
    const period=clean(row?.period_start).slice(0,7)
    if(fromMonth&&(!period||period<fromMonth))return false
    if(toMonth&&(!period||period>toMonth))return false
    return contains([
      row?.period_start,period,row?.title,row?.currency,row?.remark,row?.status,
      row?.base_salary,row?.attendance_salary,row?.leave_deduction,row?.late_deduction,
      row?.absence_deduction,row?.performance_adjustment,row?.deposit_adjustment,row?.total_pay,
    ],filters.keyword??filters.query)
  })
}
