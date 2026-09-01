const text=value=>String(value??'').trim()
const count=value=>Math.max(0,Number(value)||0)

export function employeeTrainingTableRow(person={}){
  return {
    key:text(person.employee_id)||text(person.employee_no)||text(person.employee_name),
    employeeId:text(person.employee_id),
    hireDate:text(person.hire_date),
    employeeNo:text(person.employee_no),
    name:text(person.employee_name),
    team:text(person.team_name),
    position:text(person.position_name),
    trainer:text(person.trainer_name),
    reportCount:count(person.report_count),
    recordedDays:count(person.recorded_days),
    missingDays:count(person.missing_days),
    lastReportDate:text(person.last_report_date),
  }
}

export function trainerTrainingTableRow(trainer={}){
  return {
    key:text(trainer.trainer_key)||text(trainer.trainer_employee_no)||text(trainer.trainer_name),
    employeeId:text(trainer.trainer_employee_id),
    hireDate:text(trainer.trainer_hire_date),
    employeeNo:text(trainer.trainer_employee_no),
    name:text(trainer.trainer_name),
    teams:Array.isArray(trainer.team_names)?trainer.team_names.map(text).filter(Boolean):[],
    positions:Array.isArray(trainer.position_names)?trainer.position_names.map(text).filter(Boolean):[],
    reportCount:count(trainer.report_count),
    recordedDays:count(trainer.recorded_days),
    employeeCount:count(trainer.employee_count),
    lastReportDate:text(trainer.last_report_date),
  }
}

export function trainerIdentityCandidates(trainers=[]){
  const seen=new Set()
  return (Array.isArray(trainers)?trainers:[]).flatMap(trainer=>{
    const trainerKey=text(trainer?.trainer_key)||text(trainer?.trainer_name)
    if(!trainerKey||seen.has(trainerKey))return[]
    seen.add(trainerKey)
    return[{
      trainer_key:trainerKey,
      trainer_employee_no:text(trainer?.trainer_employee_no),
      trainer_name:text(trainer?.trainer_name),
    }]
  })
}

export function mergeTrainerIdentityDirectory(trainers=[],directory=[]){
  const byKey=new Map((Array.isArray(directory)?directory:[]).flatMap(row=>{
    const trainerKey=text(row?.trainer_key)
    return trainerKey?[[trainerKey,row]]:[]
  }))
  return (Array.isArray(trainers)?trainers:[]).map(trainer=>{
    const match=byKey.get(text(trainer?.trainer_key))
    if(!match)return trainer
    return{
      ...trainer,
      trainer_employee_no:text(match.employee_no)||text(trainer.trainer_employee_no),
      trainer_hire_date:text(match.hire_date)||text(trainer.trainer_hire_date),
    }
  })
}

function rowKey(row={}){
  return text(row.id)||text(row.employee_id)||text(row.employee_no)
}

export function selectedTrainingHistoryRow(rows=[],selectedId=''){
  if(!Array.isArray(rows)||!rows.length)return null
  return rows.find(row=>rowKey(row)===text(selectedId))||rows[0]
}

export function employeeTrainerReviewRows(reports=[],employeeId=''){
  const target=text(employeeId)
  return (Array.isArray(reports)?reports:[]).flatMap(report=>(Array.isArray(report.members)?report.members:[])
    .filter(member=>!target||text(member.employee_id)===target)
    .map((member,index)=>({
      key:text(member.id)||`${text(report.id)}:${text(member.employee_id)||text(member.employee_no)||index}`,
      reportId:text(report.id),
      reportDate:text(report.report_date),
      reportTitle:text(report.title),
      submittedAt:text(report.updated_at)||text(report.created_at),
      trainerName:text(member.trainer_name)||text(report.trainer_name)||text(report.author_name),
      attendanceStatus:text(member.attendance_status)||'normal',
      workDetails:text(member.work_details),
      performance:text(member.performance),
      issues:text(member.issues),
      followUp:text(member.follow_up),
      statusNote:text(member.status_note),
      responseTime:text(member.metrics?.response_time),
      reportSummary:text(report.report_summary),
    })))
}
