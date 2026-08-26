const cleanText=value=>String(value??'').trim()

export const onlineTrainingIdentityKey=value=>cleanText(value)
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu,'')

export function onlineTrainingReportTrainerName(report){
  const reportTrainer=cleanText(report?.trainer_name)
  if(reportTrainer)return reportTrainer

  const memberTrainers=new Map()
  ;(report?.members||[]).forEach(member=>{
    const name=cleanText(member?.trainer_name)
    const key=onlineTrainingIdentityKey(name)
    if(key&&!memberTrainers.has(key))memberTrainers.set(key,name)
  })
  if(memberTrainers.size===1)return [...memberTrainers.values()][0]

  return cleanText(report?.author_name)||cleanText(report?.author_employee_no)
}

export function onlineTrainingReportMatchesTrainer(report,trainer){
  const trainerKey=onlineTrainingIdentityKey(trainer)
  return Boolean(trainerKey)&&onlineTrainingIdentityKey(
    onlineTrainingReportTrainerName(report)
  )===trainerKey
}
