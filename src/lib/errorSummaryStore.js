import { supabase } from './supabase'

const text=value=>String(value??'').trim()
const upper=value=>text(value).toUpperCase()
const PAGE_SIZE=1000
const CACHE_MS=15000
const SELECT_FIELDS='employee_no,month_key,month_error_count,last_30d_error_count,total_error_count,last_error_date,main_error_type,risk_level'

let cache={at:0,map:new Map()}
let pending=null

async function readAllSummaries(){
  const rows=[]
  for(let offset=0;offset<50000;offset+=PAGE_SIZE){
    const {data,error}=await supabase
      .from('employee_error_summary')
      .select(SELECT_FIELDS)
      .order('employee_no',{ascending:true})
      .range(offset,offset+PAGE_SIZE-1)
    if(error)throw error
    const page=data||[]
    rows.push(...page)
    if(page.length<PAGE_SIZE)break
  }
  return new Map(rows.map(row=>[upper(row.employee_no),row]))
}

export async function getAllErrorSummaryMap(force=false){
  const now=Date.now()
  if(!force&&cache.map.size&&now-cache.at<CACHE_MS)return cache.map
  if(pending)return pending
  pending=(async()=>{
    const map=await readAllSummaries()
    cache={at:Date.now(),map}
    return map
  })()
  try{return await pending}
  catch(error){
    if(cache.map.size)return cache.map
    throw error
  }finally{pending=null}
}

export function expireErrorSummaryCache(){
  cache.at=0
}
