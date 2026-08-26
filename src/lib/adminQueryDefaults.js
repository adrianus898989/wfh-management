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
