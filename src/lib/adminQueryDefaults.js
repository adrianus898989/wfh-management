export const ADMIN_BUSINESS_TIME_ZONE='Asia/Manila'

export const businessTodayIso=(now=new Date())=>{
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{
      timeZone:ADMIN_BUSINESS_TIME_ZONE,
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
    }).formatToParts(now)
    const value=Object.fromEntries(parts.map(part=>[part.type,part.value]))
    return `${value.year}-${value.month}-${value.day}`
  }catch{
    return now.toISOString().slice(0,10)
  }
}

export const businessMonthIso=(now=new Date())=>businessTodayIso(now).slice(0,7)

export const businessTodayRange=(now=new Date())=>{
  const date=businessTodayIso(now)
  return {date_from:date,date_to:date}
}

export const businessRecentRange=(days=30,now=new Date())=>{
  const dateTo=businessTodayIso(now)
  const [year,month,day]=dateTo.split('-').map(Number)
  const dateFrom=new Date(Date.UTC(year,month-1,day))
  const windowDays=Number.isFinite(Number(days))?Math.max(1,Math.trunc(Number(days))):30
  dateFrom.setUTCDate(dateFrom.getUTCDate()-windowDays+1)
  return {date_from:dateFrom.toISOString().slice(0,10),date_to:dateTo}
}
