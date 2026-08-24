import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const ROSTER_URL='https://opensheet.elk.sh/1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA/填表'
const ACCOUNT_URL='https://opensheet.elk.sh/1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA/账号'
const EFFICIENCY_SHEET_ID='1TEp-YzwjFKjorR4Xpmrb6UiKq2maMmawIW6oYQI75qM'
const ORDER_SHEETS=['工作表4','填表']
const MISTAKE_URL=`https://opensheet.elk.sh/${EFFICIENCY_SHEET_ID}/员工错误`
const cache=new Map<string,{at:number,value:any}>()
const text=(v:any)=>String(v??'').trim()
const upper=(v:any)=>text(v).toUpperCase()
const lower=(v:any)=>text(v).toLowerCase()
const uniq=(arr:any[])=>[...new Set((arr||[]).map(text).filter(Boolean))]
const json=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,'Content-Type':'application/json; charset=utf-8'}})
const pick=(r:any,keys:string[])=>{for(const k of keys){const v=text(r?.[k]);if(v)return v}return ''}
function jwtSessionId(authorization:string){const token=authorization.slice('Bearer '.length).trim(),payload=token.split('.')[1]||'';if(!payload)return '';try{const normalized=payload.replace(/-/g,'+').replace(/_/g,'/'),padded=normalized.padEnd(Math.ceil(normalized.length/4)*4,'='),sessionId=text(JSON.parse(atob(padded))?.session_id);return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)?sessionId:''}catch{return ''}}
async function assertCurrentAdminLease(userId:string,authorization:string){const sessionId=jwtSessionId(authorization);if(!sessionId)throw new Error('SESSION_NOT_CURRENT');const service=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}}),{data:lease,error}=await service.from('app_session_leases').select('session_id,portal,lease_expires_at').eq('user_id',userId).maybeSingle();if(error)throw new Error('SESSION_SERVICE_UNAVAILABLE');if(!lease||lease.session_id!==sessionId||lease.portal!=='admin'||!lease.lease_expires_at||new Date(lease.lease_expires_at).getTime()<=Date.now())throw new Error('SESSION_NOT_CURRENT')}
type ReportScope={mode:'all'|'limited',employeeNos:Set<string>}
async function permissionAllowed(service:any,userId:string,roleId:string,code:string){const {data:permission,error:permissionError}=await service.from('permissions').select('id').eq('code',code).maybeSingle();if(permissionError)throw new Error('PERMISSION_SERVICE_UNAVAILABLE');if(!permission?.id)return false;const [{data:override,error:overrideError},{data:rolePermission,error:rolePermissionError}]=await Promise.all([service.from('user_permission_overrides').select('allowed').eq('auth_user_id',userId).eq('permission_id',permission.id).maybeSingle(),service.from('role_permissions').select('role_id').eq('role_id',roleId).eq('permission_id',permission.id).maybeSingle()]);if(overrideError||rolePermissionError)throw new Error('PERMISSION_SERVICE_UNAVAILABLE');if(override&&typeof override.allowed==='boolean')return override.allowed;return Boolean(rolePermission)}
async function employeeNosForIds(service:any,ids:string[]){const out:string[]=[];for(let i=0;i<ids.length;i+=300){const {data,error}=await service.from('employees').select('employee_no').in('id',ids.slice(i,i+300));if(error)throw new Error('SCOPE_SERVICE_UNAVAILABLE');out.push(...(data||[]).map((row:any)=>upper(row.employee_no)).filter(Boolean))}return out}
async function employeeNosForTeams(service:any,teamIds:string[]){const out:string[]=[];for(let i=0;i<teamIds.length;i+=200){for(let offset=0;offset<50000;offset+=1000){const {data,error}=await service.from('employees').select('employee_no').in('team_id',teamIds.slice(i,i+200)).range(offset,offset+999);if(error)throw new Error('SCOPE_SERVICE_UNAVAILABLE');out.push(...(data||[]).map((row:any)=>upper(row.employee_no)).filter(Boolean));if((data||[]).length<1000)break}}return out}
async function resolveReportScope(service:any,userId:string,access:any,roleCode:string):Promise<ReportScope>{if(roleCode==='founder'||access.data_scope==='all')return{mode:'all',employeeNos:new Set()};if(access.data_scope==='self'){return{mode:'limited',employeeNos:new Set(access.employee_id?await employeeNosForIds(service,[access.employee_id]):[])}}if(access.data_scope==='own_team'){if(!access.employee_id)return{mode:'limited',employeeNos:new Set()};const {data:employee,error}=await service.from('employees').select('team_id').eq('id',access.employee_id).maybeSingle();if(error)throw new Error('SCOPE_SERVICE_UNAVAILABLE');return{mode:'limited',employeeNos:new Set(employee?.team_id?await employeeNosForTeams(service,[employee.team_id]):[])}}if(access.data_scope==='assigned_teams'){const [{data:teams,error:teamError},{data:employees,error:employeeError}]=await Promise.all([service.from('user_scope_teams').select('team_id').eq('auth_user_id',userId),service.from('user_scope_employees').select('employee_id').eq('auth_user_id',userId)]);if(teamError||employeeError)throw new Error('SCOPE_SERVICE_UNAVAILABLE');const [teamNos,directNos]=await Promise.all([employeeNosForTeams(service,(teams||[]).map((row:any)=>row.team_id).filter(Boolean)),employeeNosForIds(service,(employees||[]).map((row:any)=>row.employee_id).filter(Boolean))]);return{mode:'limited',employeeNos:new Set([...teamNos,...directNos])}}return{mode:'limited',employeeNos:new Set()}}
function applyReportScope(query:any,scope:ReportScope,column='employee_id'){if(scope.mode==='all')return query;const ids=[...scope.employeeNos];return ids.length?query.in(column,ids):query.eq(column,'__NO_AUTHORIZED_EMPLOYEE__')}
async function fetchJson(url:string,key:string,ttl=60000){const hit=cache.get(key);if(hit&&Date.now()-hit.at<ttl)return hit.value;const res=await fetch(url,{cache:'no-store',headers:{'User-Agent':'WFH-Reports/29.7.0'}});const raw=await res.text();if(!res.ok)throw new Error(`数据源读取失败 ${res.status}`);const data=JSON.parse(raw);if(!Array.isArray(data))throw new Error('数据源格式异常');cache.set(key,{at:Date.now(),value:data});return data}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
function orderCsvUrl(sheet:string){const url=new URL(`https://docs.google.com/spreadsheets/d/${EFFICIENCY_SHEET_ID}/gviz/tq`);url.searchParams.set('tqx','out:csv');url.searchParams.set('sheet',sheet);url.searchParams.set('range','A:D');return url.toString()}
async function fetchOrderCsv(sheet:string){let last:unknown;for(let attempt=0;attempt<3;attempt++){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65000);try{const res=await fetch(orderCsvUrl(sheet),{cache:'no-store',signal:controller.signal,headers:{'User-Agent':'WFH-Reports/29.8.0'}}),raw=await res.text();if(!res.ok)throw new Error(`效率表「${sheet}」读取失败 ${res.status}`);if(!raw||/^\s*</.test(raw))throw new Error(`效率表「${sheet}」返回格式异常`);return raw}catch(e){last=e;if(attempt<2)await delay(700*(attempt+1))}finally{clearTimeout(timer)}}throw last instanceof Error?last:new Error(`效率表「${sheet}」读取失败`)}
function eachCsvRow(raw:string,visit:(row:string[])=>void){let row:string[]=[],cell='',quoted=false;for(let i=0;i<raw.length;i++){const ch=raw[i];if(quoted){if(ch==='"'){if(raw[i+1]==='"'){cell+='"';i++}else quoted=false}else cell+=ch;continue}if(ch==='"'){quoted=true;continue}if(ch===','){row.push(cell);cell='';continue}if(ch==='\n'){row.push(cell);visit(row);row=[];cell='';continue}if(ch!=='\r')cell+=ch}if(cell||row.length){row.push(cell);visit(row)}}
function mergeOrderCsv(raw:string,target:Map<string,any>){let header=true,rowCount=0;eachCsvRow(raw,row=>{if(header){header=false;return}const d=normalizeDate(row[0]),a=lower(row[1]);if(!d||!a)return;const key=`${d}|${a}`,cur=target.get(key)||{date:d,account:a,processed:0,rejected:0};cur.processed+=asNumber(row[2]);cur.rejected+=asNumber(row[3]);target.set(key,cur);rowCount++});return rowCount}
function normalizeDate(v:any){let s=text(v);if(!s)return '';s=s.split(/[\r\n]+/)[0].trim();if(/^\d{5}(\.\d+)?$/.test(s)){const d=new Date(Date.UTC(1899,11,30)+Math.floor(Number(s))*86400000);return d.toISOString().slice(0,10)}let m=s.match(/(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/);if(m)return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;m=s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);if(m){let a=+m[1],b=+m[2],day,month;if(a>12){day=a;month=b}else if(b>12){month=a;day=b}else{day=a;month=b}return `${m[3]}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`};const d=new Date(s);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10)}
function asNumber(v:any){const n=Number(text(v).replace(/,/g,''));return Number.isFinite(n)?n:0}
function validName(v:any){const s=text(v);return Boolean(s&&!['null','undefined'].includes(s.toLowerCase())&&s.replace(/\s/g,''))}
function groupStats(rows:any[],getter:(r:any)=>string){const m=new Map<string,Set<string>>();rows.forEach(r=>{const k=text(getter(r))||'未填写';if(!m.has(k))m.set(k,new Set());m.get(k)!.add(text(r.name))});const total=new Set(rows.map(r=>text(r.name)).filter(Boolean)).size||1;return [...m].map(([name,set])=>({name,count:set.size,share:set.size/total*100})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN'))}
async function recordSnapshot(service:any,source:string,payload:any[]|null,rowCount:number,note:string){const body:any={source,row_count:rowCount,synced_at:new Date().toISOString(),note};if(payload)body.payload=payload;const {error}=await service.from('report_sheet_snapshots').upsert(body,{onConflict:'source'});if(error)console.error('report snapshot',source,error.message)}
async function getSnapshot(service:any,source:string,maxAgeMs=300000){const {data}=await service.from('report_sheet_snapshots').select('payload,synced_at,row_count').eq('source',source).maybeSingle();if(!data?.synced_at||!Array.isArray(data.payload)||!data.payload.length)return null;const age=Date.now()-new Date(data.synced_at).getTime();return age<=maxAgeMs?data.payload:null}
async function getChunkedSnapshot(service:any,source:string){const {data,error}=await service.from('report_sheet_snapshot_chunks').select('payload,chunk_index').eq('source',source).order('chunk_index');if(error||!data?.length)return null;return data.flatMap((row:any)=>Array.isArray(row.payload)?row.payload:[])}
async function syncState(service:any){const {data}=await service.from('report_sheet_snapshots').select('source,row_count,synced_at,note').order('source');const out:any={};(data||[]).forEach((x:any)=>out[x.source]=x);return out}
function normalizeRoster(raw:any[]){return raw.map((r:any,i:number)=>({key:`roster-${i+2}`,source_row:i+2,responsible:pick(r,['负责人','負責人','Owner']),onsite_trainer:pick(r,['现场培训','現場培訓','Onsite Training']),online_leader:pick(r,['线上组长','線上組長','Online Leader','组长','組長']),online_trainer:pick(r,['线上培训','線上培訓','Online Training']),group:pick(r,['组别','組別','Group']),team:pick(r,['团队','團隊','Team']),name:pick(r,['姓名','员工姓名','員工姓名','Name']),employee_id:pick(r,['ID','员工ID','員工ID']).toUpperCase(),shift:pick(r,['班次','Shift']),country:pick(r,['国家','國家','Country']),position:pick(r,['岗位','崗位','Position']),platform:pick(r,['盘口','盤口','ID WORKFOLIO','Workfolio','盘口ID']),work_content:pick(r,['工作内容','工作內容','Work Content','Job Content','Content'])})).filter(r=>validName(r.name))}
async function loadRoster(service:any){const snap=await getSnapshot(service,'居家排班表/填表',Number.POSITIVE_INFINITY);if(!snap)throw new Error('员工资料尚未同步到 Supabase，请稍后刷新');return snap.map((r:any,i:number)=>({...r,key:r.key||`roster-${r.source_row||i+2}`}))}
function splitAccounts(raw:any){return text(raw).split(/[\/,;、\s]+/).map(a=>a.replace(/^[^0-9a-zA-Z]+|[^0-9a-zA-Z]+$/g,'').trim().toLowerCase()).filter(Boolean)}
async function loadAccountDirectory(service:any){const normalized=await getSnapshot(service,'居家排班表/账号',Number.POSITIVE_INFINITY);if(!normalized)throw new Error('员工账号资料尚未同步到 Supabase，请稍后刷新');const byId=new Map<string,any>(),accountToId=new Map<string,string>(),idToAccounts=new Map<string,string[]>();normalized.forEach((x:any)=>{byId.set(x.employee_id,x);const accounts=uniq([...splitAccounts(x.backend_accounts),lower(x.employee_id)]);idToAccounts.set(x.employee_id,accounts);accounts.forEach(acc=>{if(!accountToId.has(acc))accountToId.set(acc,x.employee_id)})});return {byId,accountToId,idToAccounts}}
function normalizeOrders(raw:any[]){const m=new Map<string,any>();raw.forEach((r:any)=>{const d=normalizeDate(pick(r,['日期','date','Date'])),a=lower(pick(r,['后台账号','後台賬號','account']));if(!d||!a)return;const key=`${d}|${a}`,cur=m.get(key)||{date:d,account:a,processed:0,rejected:0};cur.processed+=asNumber(pick(r,['已处理','已處理','processed']));cur.rejected+=asNumber(pick(r,['驳回','駁回','reject','rejected']));m.set(key,cur)});return [...m.values()].sort((a,b)=>a.date.localeCompare(b.date))}
let ordersLoading:Promise<any[]>|null=null
async function loadAllOrders(service:any){const key='orders-combined-v298',hit=cache.get(key);if(hit&&Date.now()-hit.at<300000)return hit.value;if(ordersLoading)return ordersLoading;ordersLoading=(async()=>{try{const csv=await Promise.all(ORDER_SHEETS.map(fetchOrderCsv)),merged=new Map<string,any>();let sourceRows=0;csv.forEach(raw=>{sourceRows+=mergeOrderCsv(raw,merged)});const out=[...merged.values()].sort((a,b)=>a.date.localeCompare(b.date));cache.set(key,{at:Date.now(),value:out});await recordSnapshot(service,'效率表/网站数据',null,sourceRows,'直接合并 Google 效率表「工作表4 + 填表」；按后台账号与日期汇总，不再读取不存在的「网站数据」工作表');return out}catch(e){if(hit?.value?.length)return hit.value;throw e}finally{ordersLoading=null}})();return ordersLoading}
async function loadSyncedOrderSummary(service:any,dateFrom:string,dateTo:string,accounts:string[],defaultDays=7){
  let lastError:any=null
  for(let attempt=1;attempt<=2;attempt++){
    const {data,error}=await service.rpc('report_order_account_summary_v2',{
      p_date_from:dateFrom||null,
      p_date_to:dateTo||null,
      p_accounts:accounts,
      p_default_days:defaultDays,
    })
    if(!error)return data||{available_from:'',available_to:'',dates:[],rows:[]}
    lastError=error
    console.error(`[admin-reports] order summary attempt ${attempt}`,{
      code:error.code,
      message:error.message,
      details:error.details,
      hint:error.hint,
    })
    if(attempt<2)await delay(300)
  }
  throw new Error(`Supabase 订单统计读取失败: ${lastError?.hint||lastError?.details||lastError?.message||'未知错误'}`)
}
async function loadMistakeCounts(service:any,dateFrom:string,dateTo:string,employeeNos:string[]|null=null){
  if(employeeNos===null){
    const {data,error}=await service.rpc('report_error_counts_by_employee',{
      p_date_from:dateFrom||null,
      p_date_to:dateTo||null,
    })
    if(error)throw new Error(`Supabase 错误次数读取失败: ${error.message}`)
    return new Map((data||[]).map((row:any)=>[upper(row.employee_no),Number(row.error_count||0)]))
  }
  const counts=new Map<string,number>()
  if(!employeeNos.length)return counts
  for(let offset=0;offset<50000;offset+=1000){
    let query=service.from('report_employee_error_rows').select('employee_no,review_date')
      .in('employee_no',employeeNos).not('review_date','is',null)
    if(dateFrom)query=query.gte('review_date',dateFrom)
    if(dateTo)query=query.lte('review_date',dateTo)
    const {data,error}=await query.range(offset,offset+999)
    if(error)throw new Error(`Supabase 错误次数读取失败: ${error.message}`)
    for(const row of data||[]){const id=upper(row.employee_no);if(id)counts.set(id,(counts.get(id)||0)+1)}
    if((data||[]).length<1000)break
  }
  return counts
}
function normalizeErrors(raw:any[]){return raw.map((r:any,i:number)=>({key:`err-${i+2}`,record_key:text(r.record_key),source_row:Number(r.source_row||i+2),employee_id:pick(r,['employee_id','ID']).toUpperCase(),member_order:pick(r,['member_order','会员/id /订单号','會員/id /訂單號']),amount:pick(r,['amount','金额','金額']),error_note:pick(r,['error_note','错误备注','錯誤備註']),correct_action:pick(r,['correct_action','正确操作方式','正確操作方式']),error_type:pick(r,['error_type','错误类型','錯誤類型']),score:pick(r,['score','扣分']),qc_person:pick(r,['qc_person','质检人','質檢人']),qc_date:normalizeDate(pick(r,['qc_date','质检时间','質檢時間'])),leader_review:pick(r,['leader_review','小组长复审','小組長複審']),qc_result:pick(r,['qc_result','质检人对错','质检人对/错','質檢人對錯']),review_date:normalizeDate(pick(r,['review_date','复检时间','複檢時間']))})).filter(r=>r.employee_id&&(r.qc_date||r.review_date||r.error_type||r.error_note))}
async function loadAllErrors(service:any){const chunks=await getChunkedSnapshot(service,'效率表/员工错误');if(chunks?.length)return normalizeErrors(chunks);const snap=await getSnapshot(service,'效率表/员工错误',Number.POSITIVE_INFINITY);if(snap)return normalizeErrors(snap);throw new Error('错误统计尚未同步到 Supabase，请稍后刷新')}
function mapOrdersToEmployees(allOrders:any[],directory:any,rosterById:Map<string,any>){const out:any[]=[];allOrders.forEach(o=>{const id=directory.accountToId.get(o.account)||'';if(id&&rosterById.has(id))out.push({...o,employee_id:id})});return out}
function between(date:string,from:string,to:string){if(!date)return false;if(from&&date<from)return false;if(to&&date>to)return false;return true}
async function buildContext(service:any,scope:ReportScope){const [loadedRoster,directory]=await Promise.all([loadRoster(service),loadAccountDirectory(service)]);const roster=scope.mode==='all'?loadedRoster:loadedRoster.filter((r:any)=>scope.employeeNos.has(upper(r.employee_id)));const enriched=roster.map((r:any)=>({...r,employee_id:upper(r.employee_id),hire_date:r.employee_id?(directory.byId.get(upper(r.employee_id))?.hire_date||''):''}));const rosterById=new Map(enriched.filter((r:any)=>r.employee_id).map((r:any)=>[r.employee_id,r]));return {roster:enriched,directory,rosterById}}
async function overview(service:any,scope:ReportScope){const ctx=await buildContext(service,scope),roster=ctx.roster,states=await syncState(service);return {updated_at:new Date().toISOString(),version:'V30.1.0',sources:{roster:'Supabase 定时快照 ← 居家排班表 / 填表',account:'Supabase 定时快照 ← 居家排班表 / 账号',efficiency:['Supabase 索引明细 ← Google 效率表：工作表4 + 填表','员工错误读取 Supabase 索引明细']},sync_state:states,roster,order_summary:{},recent_order_dates:[],recent_orders:{},options:{shifts:uniq(roster.map((r:any)=>r.shift)).sort(),teams:uniq(roster.map((r:any)=>r.team)).sort(),groups:uniq(roster.map((r:any)=>r.group)).sort(),positions:uniq(roster.map((r:any)=>r.position)).sort(),countries:uniq(roster.map((r:any)=>r.country)).sort(),platforms:uniq(roster.map((r:any)=>r.platform)).sort(),supervisors:uniq(roster.flatMap((r:any)=>[r.responsible,r.onsite_trainer,r.online_leader,r.online_trainer])).sort()},stats:{people:new Set(roster.map((r:any)=>text(r.name)).filter(Boolean)).size,rows:roster.length,team_stats:groupStats(roster,(r:any)=>r.team),position_stats:groupStats(roster,(r:any)=>r.position),shift_stats:groupStats(roster,(r:any)=>r.shift),country_stats:groupStats(roster,(r:any)=>r.country)}}}
async function orders(service:any,body:any,scope:ReportScope){
  const ctx=await buildContext(service,scope)
  let from=normalizeDate(body.date_from),to=normalizeDate(body.date_to)
  if(from&&to&&from>to)[from,to]=[to,from]
  const hasEmployeeFilter=Array.isArray(body.employee_ids)
  const requestedIds=hasEmployeeFilter?body.employee_ids.map((x:any)=>upper(x)).filter(Boolean):[]
  const visibleIds=new Set(ctx.rosterById.keys())
  const allowedIds=new Set(hasEmployeeFilter?requestedIds.filter((id:string)=>visibleIds.has(id)):[...visibleIds])
  const accounts=uniq([...allowedIds].flatMap(id=>ctx.directory.idToAccounts.get(id)||[])).map(lower)
  if(!accounts.length)return {updated_at:new Date().toISOString(),from:from||'',to:to||'',dates:[],available_from:'',available_to:'',rows:[],options:{positions:[]},sync_state:await syncState(service)}
  const summary=await loadSyncedOrderSummary(service,from,to,accounts,body.all_history===true?0:7)
  const activeDates=(summary.dates||[]).map(text).filter(Boolean).sort()
  const byId=new Map<string,any>()
  ;(summary.rows||[]).forEach((accountRow:any)=>{
    const id=ctx.directory.accountToId.get(lower(accountRow.account))||''
    if(!id||!allowedIds.has(id))return
    const person=ctx.rosterById.get(id)
    if(!person)return
    const cur=byId.get(id)||{...person,total:0,valid_days:new Set<string>(),daily:{}}
    const directEmployeeId=lower(accountRow.account)===lower(id)
    Object.entries(accountRow.daily||{}).forEach(([date,value]:any)=>{
      const day=cur.daily[date]||{success:0,reject:0,direct:false}
      // Newer efficiency rows can already contain the employee ID as a fully
      // consolidated daily total. Prefer that row for the date; otherwise sum
      // the employee's historical backend-account aliases.
      if(directEmployeeId){
        cur.daily[date]={success:Number(value?.success||0),reject:Number(value?.reject||0),direct:true}
      }else if(!day.direct){
        day.success+=Number(value?.success||0);day.reject+=Number(value?.reject||0)
        cur.daily[date]=day
      }
    })
    byId.set(id,cur)
  })
  byId.forEach(person=>{Object.entries(person.daily).forEach(([date,value]:any)=>{delete value.direct;const dayTotal=Number(value.success||0)+Number(value.reject||0);if((!person.hire_date||date>=person.hire_date)&&dayTotal>0){person.total+=dayTotal;person.valid_days.add(date)}})})
  const mistakeCount=await loadMistakeCounts(service,activeDates[0]||'',activeDates[activeDates.length-1]||'',scope.mode==='all'&&!hasEmployeeFilter?null:[...allowedIds])
  const rows=[...byId.values()].map(r=>({key:`order-${r.employee_id}`,employee_id:r.employee_id,name:r.name,team:r.team,shift:r.shift,country:r.country,position:r.position,platform:r.platform,hire_date:r.hire_date,total:r.total,avg:r.valid_days.size?Math.round(r.total/r.valid_days.size):0,mistake_count:mistakeCount.get(r.employee_id)||0,daily:r.daily})).sort((a,b)=>b.total-a.total||a.employee_id.localeCompare(b.employee_id))
  return {updated_at:new Date().toISOString(),source:'supabase_order_rows_indexed',from:summary.from||from||'',to:summary.to||to||'',dates:activeDates,available_from:summary.available_from||'',available_to:summary.available_to||'',rows,options:{positions:uniq([...allowedIds].map(id=>ctx.rosterById.get(id)?.position)).sort()},sync_state:await syncState(service)}
}
async function errors(service:any,body:any,scope:ReportScope){
  let from=normalizeDate(body.date_from),to=normalizeDate(body.date_to)
  if(from&&to&&from>to)[from,to]=[to,from]
  const employeeFilter=upper(body.employee_id),basis=text(body.date_basis)==='review'?'review':'qc',basisColumn=basis==='review'?'review_basis_date':'qc_date'
  if(scope.mode==='limited'&&employeeFilter&&!scope.employeeNos.has(employeeFilter))return{updated_at:new Date().toISOString(),source:'supabase_error_rows_indexed',from:from||'',to:to||'',available_from:'',available_to:'',rows:[],options:{},sync_state:await syncState(service)}
  const applyFilters=(query:any)=>{query=applyReportScope(query,scope);if(employeeFilter)query=query.eq('employee_id',employeeFilter);if(from)query=query.gte(basisColumn,from);if(to)query=query.lte(basisColumn,to);return query}
  let query=applyFilters(service.from('report_employee_error_admin_v').select('*')).order('qc_date',{ascending:false,nullsFirst:false}).order('source_row',{ascending:false}).limit(500)
  if(scope.mode==='all'){
    const [{data:rows,error},{data:stats,error:statsError}]=await Promise.all([query,service.rpc('report_error_query_stats',{p_filters:{date_from:from,date_to:to,date_basis:basis,employee_id:employeeFilter}})])
    if(error)throw new Error(`错误记录读取失败: ${error.message}`)
    if(statsError)throw new Error(`错误记录统计失败: ${statsError.message}`)
    return{updated_at:new Date().toISOString(),source:'supabase_error_rows_indexed',from:from||'',to:to||'',available_from:stats?.available_from||'',available_to:stats?.available_to||'',rows:rows||[],options:stats?.options||{},sync_state:await syncState(service)}
  }
  const countQuery=applyFilters(service.from('report_employee_error_admin_v').select('record_key',{count:'exact',head:true}))
  const optionQuery=applyReportScope(service.from('report_employee_error_admin_v').select('error_type,qc_person,shift,team,group_name,position,country,manager_search,platform,qc_date'),scope).limit(10000)
  const [{data:rows,error},{count,error:countError},{data:optionRows,error:optionError}]=await Promise.all([query,countQuery,optionQuery])
  if(error)throw new Error(`错误记录读取失败: ${error.message}`)
  if(countError||optionError)throw new Error(`错误记录统计失败: ${(countError||optionError)?.message||'未知错误'}`)
  const values=(key:string)=>uniq((optionRows||[]).map((row:any)=>row[key])).filter(value=>value!=='-').sort((a,b)=>a.localeCompare(b,'zh-CN'))
  const dates=(optionRows||[]).map((row:any)=>text(row.qc_date).slice(0,10)).filter(Boolean).sort()
  const options={error_types:values('error_type'),qc_people:values('qc_person'),shifts:values('shift'),teams:values('team'),groups:values('group_name'),positions:values('position'),countries:values('country'),managers:uniq((optionRows||[]).flatMap((row:any)=>text(row.manager_search).split('|'))).sort(),platforms:values('platform')}
  return{updated_at:new Date().toISOString(),source:'supabase_error_rows_indexed',from:from||'',to:to||'',available_from:dates[0]||'',available_to:dates.at(-1)||'',total:Number(count||0),rows:rows||[],options,sync_state:await syncState(service)}
}
async function authorize(req:Request){
  const auth=req.headers.get('Authorization')||''
  if(!auth.startsWith('Bearer '))throw new Error('UNAUTHORIZED')
  const client=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_ANON_KEY')||'',{global:{headers:{Authorization:auth}}})
  const {data:{user},error}=await client.auth.getUser()
  if(error||!user)throw new Error('UNAUTHORIZED')
  await assertCurrentAdminLease(user.id,auth)
  const service=createClient(Deno.env.get('SUPABASE_URL')||'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:access,error:accessError}=await service.from('user_access').select('employee_id,role_id,data_scope,backend_enabled,active').eq('auth_user_id',user.id).maybeSingle()
  if(accessError)throw new Error('ACCESS_SERVICE_UNAVAILABLE')
  if(!access?.active||!access?.backend_enabled)throw new Error('FORBIDDEN')
  const {data:role,error:roleError}=await service.from('roles').select('code').eq('id',access.role_id).maybeSingle()
  if(roleError)throw new Error('PERMISSION_SERVICE_UNAVAILABLE')
  if(role?.code!=='founder'&&!(await permissionAllowed(service,user.id,access.role_id,'report.view')))throw new Error('REPORT_VIEW_DENIED')
  return{service,scope:await resolveReportScope(service,user.id,access,text(role?.code))}
}
Deno.serve(async req=>{if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});if(req.method!=='POST')return json({error:'仅支持 POST 请求'},405);let action='overview';try{const {service,scope}=await authorize(req);const body=await req.json().catch(()=>({}));action=text(body.action)||'overview';if(action==='overview')return json(await overview(service,scope));if(action==='orders'||action==='efficiency')return json(await orders(service,body,scope));if(action==='errors')return json(await errors(service,body,scope));return json({error:'未知操作'},400)}catch(e){const msg=e instanceof Error?e.message:String(e);if(msg==='UNAUTHORIZED'||msg==='SESSION_NOT_CURRENT')return json({error:msg==='SESSION_NOT_CURRENT'?'此账号已在其他设备登录或会话已过期，请重新登录':'登录已失效，请重新登录'},401);if(msg==='FORBIDDEN')return json({error:'当前账号没有后台访问权限'},403);if(msg==='REPORT_VIEW_DENIED')return json({error:'当前账号没有统计报表查看权限'},403);if(['SESSION_SERVICE_UNAVAILABLE','ACCESS_SERVICE_UNAVAILABLE','PERMISSION_SERVICE_UNAVAILABLE','SCOPE_SERVICE_UNAVAILABLE'].includes(msg))return json({error:'权限或会话服务暂时不可用，请稍后重试'},503);console.error(`[admin-reports] action=${action}`,e);return json({error:msg||'统计数据读取失败'},500)}})
