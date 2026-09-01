export const MONTHLY_ATTENDANCE_LOCK_RETRY_DELAY_MS=1000

const errorText=error=>[
  error?.message,
  error?.details,
  error?.hint,
].filter(Boolean).join(' ')

export const isMonthlyAttendanceLockTimeout=error=>{
  const code=String(error?.code||'').trim().toUpperCase()
  return code==='55P03'||/\block timeout\b/i.test(errorText(error))
}

const waitFor=delayMs=>new Promise(resolve=>globalThis.setTimeout(resolve,delayMs))

export const withMonthlyAttendanceLockRetry=async(read,{delayMs=MONTHLY_ATTENDANCE_LOCK_RETRY_DELAY_MS,wait=waitFor}={})=>{
  try{
    return await read()
  }catch(error){
    if(!isMonthlyAttendanceLockTimeout(error))throw error
    await wait(delayMs)
    return read()
  }
}
