const text=value=>String(value??'').trim()
const count=value=>Math.max(0,Number(value)||0)

export function employeeTrainingTableRow(person={}){
  return {
    key:text(person.employee_id)||text(person.employee_no)||text(person.employee_name),
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

function rowKey(row={}){
  return text(row.id)||text(row.employee_id)||text(row.employee_no)
}

export function selectedTrainingHistoryRow(rows=[],selectedId=''){
  if(!Array.isArray(rows)||!rows.length)return null
  return rows.find(row=>rowKey(row)===text(selectedId))||rows[0]
}
