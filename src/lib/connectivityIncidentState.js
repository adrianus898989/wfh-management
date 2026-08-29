export function calculatedConnectivityDuration(start,end){
  if(!start||!end)return 0
  const [sh,sm]=String(start).split(':').map(Number)
  const [eh,em]=String(end).split(':').map(Number)
  if(![sh,sm,eh,em].every(Number.isFinite))return 0
  const from=sh*60+sm
  const to=eh*60+em
  return to>=from?to-from:24*60-from+to
}

export function normaliseConnectivityStatus(status,end){
  const value=['reported','verified','resolved','rejected'].includes(status)?status:'reported'
  if(!end&&value==='resolved')return 'reported'
  if(end&&['reported','verified'].includes(value))return 'resolved'
  return value
}
