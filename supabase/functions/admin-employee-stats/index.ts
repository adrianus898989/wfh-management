import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadEffectiveEmployeeScope,
} from "../_shared/employeeScope.ts";
import {
  canonicalizeConfirmedPresentEmployeeNos,
  confirmedEmployeeIdentityKey,
  prepareConfirmedResignationItems,
  resolveConfirmedResignationItems,
  uniqueConfirmedEmployeeNos,
} from "./confirmedIdentity.js";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json; charset=utf-8"}});
const text=(v:unknown)=>String(v??"").trim();
const ratio=(n:number,d:number)=>d>0?Number((n*100/d).toFixed(2)):0;
const deltaPct=(current:number,previous:number)=>previous===0?(current===0?0:100):Number((((current-previous)/previous)*100).toFixed(1));
const upper=(v:unknown)=>text(v).toUpperCase();
const isIgnoredEmployeeNo=(v:unknown)=>{const n=upper(v);return !n||n==="SYSTEM"||n==="ADMIN"};
const isTestEmployeeNo=(v:unknown)=>upper(v).startsWith("TEST");
function jwtSessionId(token:string){try{const raw=token.split(".")[1]?.replace(/-/g,"+").replace(/_/g,"/")||"";const padded=raw+"=".repeat((4-raw.length%4)%4);return text(JSON.parse(atob(padded))?.session_id);}catch{return "";}}
async function requireCurrentAdminSession(service:any,userId:string,token:string){
  const sessionId=jwtSessionId(token);if(!sessionId) throw new Error("登录会话无效，请重新登录");
  const {data,error}=await service.from("app_session_leases").select("user_id").eq("user_id",userId).eq("session_id",sessionId).eq("portal","admin").gt("lease_expires_at",new Date().toISOString()).maybeSingle();
  if(error||!data?.user_id) throw new Error("此账号未持有当前设备登录权，请重新登录");
}

async function permissionAllowed(service:any,userId:string,access:any,roleCode:string,code:string){
  if(roleCode==="founder") return true;
  const {data:permission}=await service.from("permissions").select("id").eq("code",code).maybeSingle();
  if(!permission?.id) return false;
  const {data:override}=await service.from("user_permission_overrides").select("allowed")
    .eq("auth_user_id",userId).eq("permission_id",permission.id).maybeSingle();
  if(override&&typeof override.allowed==="boolean") return override.allowed;
  const {data:rolePermission}=await service.from("role_permissions").select("role_id")
    .eq("role_id",access.role_id).eq("permission_id",permission.id).maybeSingle();
  return Boolean(rolePermission);
}

function isoAdd(date:string,days:number){
  const d=new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate()+days);
  return d.toISOString().slice(0,10);
}

async function callerAndScope(req:Request,service:any){
  const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();
  if(!token) throw new Error("未登录");
  const {data:userData,error:userError}=await service.auth.getUser(token);
  if(userError||!userData?.user) throw new Error("登录状态无效");
  const userId=userData.user.id;
  await requireCurrentAdminSession(service,userId,token);
  const {data:access,error}=await service.from("user_access").select("auth_user_id,employee_id,role_id,data_scope,active,backend_enabled").eq("auth_user_id",userId).maybeSingle();
  if(error||!access?.active||!access?.backend_enabled) throw new Error("无后台访问权限");
  const {data:role}=await service.from("roles").select("code").eq("id",access.role_id).maybeSingle();
  const roleCode=text(role?.code);
  const mayViewDirectory=await permissionAllowed(service,userId,access,roleCode,"employee.directory.view");
  const mayViewAnalytics=await permissionAllowed(service,userId,access,roleCode,"employee.analytics.view");
  if(!mayViewDirectory&&!mayViewAnalytics) throw new Error("没有查看员工资料分析的权限");
  return await loadEffectiveEmployeeScope(service,userId,access,roleCode);
}
function groupsOf<T>(items:T[],size=150){const groups:T[][]=[];for(let offset=0;offset<items.length;offset+=size)groups.push(items.slice(offset,offset+size));return groups;}
async function resolveConfirmedEmployeeIdentityBatch(service:any,employeeNos:unknown[]){
  const requested=uniqueConfirmedEmployeeNos(employeeNos);
  const rows:any[]=[];
  for(const group of groupsOf(requested,500)){
    const {data,error}=await service.rpc("resolve_employee_identity_batch",{p_employee_nos:group});
    if(error||!Array.isArray(data)) throw new Error("confirmed_employee_identity_resolution_failed");
    rows.push(...data);
  }
  const requestedKeys=new Set(requested.map(confirmedEmployeeIdentityKey));
  const returnedKeys=new Set(rows.map((row:any)=>text(row?.raw_identity_key)).filter(Boolean));
  if(rows.length!==requested.length||returnedKeys.size!==requestedKeys.size
    || [...requestedKeys].some(key=>!returnedKeys.has(key))){
    throw new Error("confirmed_employee_identity_resolution_failed");
  }
  return rows;
}
async function loadReferenceRows(service:any,table:string,selection:string,ids:string[]){
  const rows:any[]=[];
  for(const group of groupsOf([...new Set(ids.filter(Boolean))])){
    const {data,error}=await service.from(table).select(selection).in("id",group);
    if(error) throw error;
    rows.push(...(data||[]));
  }
  return rows;
}

/**
 * Current organization truth is a service-only roster directory. Intersect it
 * with the central effective employee allow-list before loading employee rows;
 * never reconstruct access from employees.team_id / position_id.
 */
async function loadCurrentRosterOrganization(service:any,scope:any){
  const {data,error}=await service.rpc("admin_scope_current_employee_directory");
  if(error) throw new Error("SCOPE_SERVICE_UNAVAILABLE");
  const payload=Array.isArray(data)&&data.length===1&&!data[0]?.employee_id?data[0]:data;
  const effectiveEmployeeIds=scope.mode==="all"?null:new Set(scope.employeeIds||[]);
  const byEmployeeId=new Map<string,{employeeId:string,teamId:string,positionId:string}>();
  for(const item of Array.isArray(payload?.employees)?payload.employees:[]){
    const employeeId=text(item?.employee_id),teamId=text(item?.team_id),positionId=text(item?.position_id);
    if(!employeeId||!teamId||!positionId||item?.position_unmatched===true) continue;
    if(effectiveEmployeeIds&&!effectiveEmployeeIds.has(employeeId)) continue;
    byEmployeeId.set(employeeId,{employeeId,teamId,positionId});
  }
  const directory=[...byEmployeeId.values()];
  const [teamRows,positionRows]=await Promise.all([
    loadReferenceRows(service,"teams","id,name,status",directory.map(row=>row.teamId)),
    loadReferenceRows(service,"positions","id,name,status",directory.map(row=>row.positionId)),
  ]);
  const teamById=new Map(teamRows.filter((row:any)=>text(row.status)==="active").map((row:any)=>[text(row.id),row]));
  const positionById=new Map(positionRows.filter((row:any)=>text(row.status)==="active").map((row:any)=>[text(row.id),row]));
  const resolvedDirectory=directory.filter(row=>teamById.has(row.teamId)&&positionById.has(row.positionId));
  return {
    directory:resolvedDirectory,
    byEmployeeId:new Map(resolvedDirectory.map(row=>[row.employeeId,row])),
    teamById,
    positionById,
  };
}

async function allEmployees(service:any,organization:any,includeTest=false){
  const rows:any[]=[];
  for(const group of groupsOf(organization.directory.map((row:any)=>row.employeeId))){
    const {data,error}=await service.from("employees")
      .select("id,employee_no,full_name,status,hire_date,country,nationality,employment_type,work_tg,platform_scope,shift_name,updated_at,source_type")
      .in("id",group);
    if(error) throw error;
    rows.push(...(data||[]));
  }
  const currentRows=rows.map((employee:any)=>{
    const current=organization.byEmployeeId.get(text(employee.id));
    const team=current?organization.teamById.get(current.teamId):null;
    const position=current?organization.positionById.get(current.positionId):null;
    return {
      ...employee,
      team_id:current?.teamId||null,
      position_id:current?.positionId||null,
      teams:team||null,
      positions:position||null,
    };
  }).filter((employee:any)=>employee.team_id&&employee.position_id);
  // Production KPI remains clean by default. TEST rows are included only when a caller
  // explicitly asks for validation detail (e.g. clicking the 待入职 bucket while testing).
  return currentRows.filter((r:any)=>
    !isIgnoredEmployeeNo(r.employee_no) &&
    (includeTest || !isTestEmployeeNo(r.employee_no)) &&
    text(r.status)!=="suspended" &&
    text(r.source_type)!=="google_deleted"
  );
}
function splitPlatforms(v:unknown){return Array.from(new Set(text(v).split(/[\/，,；;\n\r]+/).map(text).filter(Boolean)));}
function breakdown(map:Map<string,number>,den:number){return Array.from(map.entries()).map(([name,count])=>({name,count,share:ratio(count,den)})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));}
function tenureKey(hire:unknown,today:string){
  const h=text(hire).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(h)) return "unknown";
  if(h>today)return "prepare";
  const days=Math.floor((Date.parse(`${today}T12:00:00Z`)-Date.parse(`${h}T12:00:00Z`))/86400000);
  if(days<=7)return "within_7";
  if(days<=14)return "days_8_14";
  if(days<=30)return "days_15_30";
  if(days<=60)return "days_31_60";
  if(days<=180)return "days_61_180";
  if(days<=365)return "months_6_12";
  if(days<=730)return "years_1_2";
  if(days<=1095)return "years_2_3";
  return "years_3_plus";
}
function isActiveEmploymentStatus(status:unknown){
  const value=text(status).toLowerCase();
  return value==="active"||value==="probation";
}
function isEffectiveActiveEmployee(employee:any,today:string){
  if(!isActiveEmploymentStatus(employee?.status)) return false;
  const hireDate=text(employee?.hire_date).slice(0,10);
  if(!hireDate) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(hireDate)&&hireDate<=today;
}
function isFutureHireEmployee(employee:any,today:string){
  const hireDate=text(employee?.hire_date).slice(0,10);
  return isActiveEmploymentStatus(employee?.status)&&/^\d{4}-\d{2}-\d{2}$/.test(hireDate)&&hireDate>today;
}
function isTenureEmployee(employee:any,today:string){
  return isEffectiveActiveEmployee(employee,today)||isFutureHireEmployee(employee,today);
}

async function lifecycleRows(service:any,start:string){
  const rows:any[]=[];let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employee_lifecycle_events")
      .select("employee_id,employee_no,event_type,effective_date,created_at")
      .in("event_type",["join","resign"])
      .gte("effective_date",start)
      .range(offset,offset+batch-1);
    if(error) throw error;
    rows.push(...(data||[]));
    if((data||[]).length<batch) break;
    offset+=batch;if(offset>20000) break;
  }
  return rows;
}
function lifecycleKpis(events:any[],eligibleNos:Set<string>,today:string){
  const normalized:any[]=[];
  const seen=new Set<string>();
  for(const r of events){
    const no=upper(r.employee_no), type=text(r.event_type), date=text(r.effective_date).slice(0,10);
    if(!no||!eligibleNos.has(no)||!date||(type!=="join"&&type!=="resign")) continue;
    const key=`${no}|${type}|${date}`;
    if(seen.has(key)) continue;
    seen.add(key);normalized.push({no,type,date});
  }
  const count=(type:string,from:string,to:string)=>{
    const people=new Set<string>();
    for(const r of normalized) if(r.type===type&&r.date>=from&&r.date<=to) people.add(r.no);
    return people.size;
  };
  const yesterday=isoAdd(today,-1);
  const from7=isoAdd(today,-6),previous7From=isoAdd(today,-13),previous7To=isoAdd(today,-7),from30=isoAdd(today,-29);
  const todayJoin=count("join",today,today),yesterdayJoin=count("join",yesterday,yesterday);
  const todayResign=count("resign",today,today),yesterdayResign=count("resign",yesterday,yesterday);
  const join7=count("join",from7,today),previousJoin7=count("join",previous7From,previous7To);
  const resign7=count("resign",from7,today),previousResign7=count("resign",previous7From,previous7To);
  const join30=count("join",from30,today),resign30=count("resign",from30,today);
  return {
    today_join:todayJoin,
    today_resign:todayResign,
    yesterday_join:yesterdayJoin,
    yesterday_resign:yesterdayResign,
    today_join_delta:todayJoin-yesterdayJoin,
    today_resign_delta:todayResign-yesterdayResign,
    join_7d:join7,
    resign_7d:resign7,
    join_7d_delta_pct:deltaPct(join7,previousJoin7),
    resign_7d_delta_pct:deltaPct(resign7,previousResign7),
    join_30d:join30,
    resign_30d:resign30,
    net_30d:join30-resign30,
  };
}

async function fetchPresenceCandidates(service:any,sheetName:string,mode:string){
  const rows:any[]=[];let offset=0;const batch=1000;
  while(true){
    let q=service.from("employees").select("id,employee_no,status,source_sheet,source_type").eq("source_sheet",sheetName);
    if(mode==="test") q=q.ilike("employee_no","TEST%");
    else q=q.not("employee_no","ilike","TEST%");
    const {data,error}=await q.range(offset,offset+batch-1);
    if(error) throw error;
    rows.push(...(data||[]));
    if((data||[]).length<batch) break;
    offset+=batch;if(offset>20000) break;
  }
  return rows.filter((r:any)=>!isIgnoredEmployeeNo(r.employee_no)&&(mode==="test"?isTestEmployeeNo(r.employee_no):!isTestEmployeeNo(r.employee_no)));
}

function reconcileSafety(candidates:any[],missing:any[],present:Set<string>,label:string){
  if(!missing.length) return null;
  const candidateNos=new Set(candidates.map((row:any)=>upper(row.employee_no)).filter(Boolean));
  let matched=0;
  for(const employeeNo of candidateNos) if(present.has(employeeNo)) matched+=1;
  const coverage=candidateNos.size?matched/candidateNos.size:1;
  const changeRatio=candidates.length?missing.length/candidates.length:0;
  const maxChanges=Math.max(10,Math.ceil(candidates.length*0.08));
  if(coverage<0.85||missing.length>maxChanges){
    return {
      ok:true,
      skipped:"destructive_reconcile_guard",
      label,
      present:present.size,
      candidates:candidates.length,
      matched,
      coverage:Number((coverage*100).toFixed(2)),
      proposed_changes:missing.length,
      max_allowed_changes:maxChanges,
      message:"来源数据与数据库重合度异常或拟删除/停用数量过大；本次未修改任何员工资料。",
    };
  }
  return null;
}

async function reconcileSheetPresence(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  const given=text(body.secret);
  if(!expected||given!==expected) return json({error:"invalid sync secret"},401);

  const sheetName=text(body.sheet_name);
  const mode=text(body.mode)==="test"?"test":"production";
  if(!["在职名单 Current Staff List","现场转居家"].includes(sheetName)) return json({error:"unsupported presence sheet"},400);

  const rawPresent=(Array.isArray(body.present_ids)?body.present_ids:[])
    .map(upper)
    .filter((n:string)=>Boolean(n)&&n!=="SYSTEM"&&n!=="ADMIN"&&(mode==="test"?n.startsWith("TEST"):!n.startsWith("TEST")));
  let present=new Set<string>(rawPresent);
  if(mode==="production"){
    const identityRows=await resolveConfirmedEmployeeIdentityBatch(service,rawPresent);
    const canonicalPresence=canonicalizeConfirmedPresentEmployeeNos(rawPresent,identityRows);
    if(canonicalPresence.conflicts.length){
      return json({
        ok:false,
        error:"confirmed_employee_identity_conflict",
        retryable:true,
        conflicts:canonicalPresence.conflicts.map((conflict:any)=>({
          employee_no:upper(conflict.rawEmployeeNo),
          reason:text(conflict.reason),
        })),
      },409);
    }
    present=canonicalPresence.presentEmployeeNos;
  }
  // Safety: never mass-suspend a production sheet if the scan unexpectedly came back tiny/empty.
  if(mode==="production"&&present.size<100) return json({ok:true,skipped:"production_presence_list_too_small",present:present.size});
  if(mode==="test"&&present.size===0&&body.confirm_empty!==true) return json({error:"empty TEST presence list requires confirm_empty=true"},400);

  const candidates=await fetchPresenceCandidates(service,sheetName,mode);
  const missing=candidates.filter((r:any)=>!present.has(upper(r.employee_no))&&(mode==="test"||r.status!=="suspended"));
  const ids=missing.map((r:any)=>r.id).filter(Boolean);
  const employeeNos=missing.map((r:any)=>text(r.employee_no)).filter(Boolean);

  if(mode==="production"){
    const guard=reconcileSafety(candidates,missing,present,`sheet:${sheetName}`);
    if(guard) return json(guard);
  }

  if(mode==="test"){
    // TEST workbook is disposable by design: deleting a TEST row should really remove its TEST record
    // and its TEST lifecycle noise, so today/7d analytics do not keep ghost test people.
    for(let i=0;i<employeeNos.length;i+=100){
      const group=employeeNos.slice(i,i+100);
      const {error:eventError}=await service.from("employee_lifecycle_events").delete().in("employee_no",group);
      if(eventError) throw eventError;
    }
    for(let i=0;i<ids.length;i+=100){
      const group=ids.slice(i,i+100);
      const {error:deleteError}=await service.from("employees").delete().in("id",group);
      if(deleteError) throw deleteError;
    }
    return json({ok:true,mode,sheet_name:sheetName,present:present.size,candidates:candidates.length,deleted:missing.length,employee_nos:employeeNos});
  }

  const now=new Date().toISOString();
  for(let i=0;i<ids.length;i+=200){
    const group=ids.slice(i,i+200);
    const {error}=await service.from("employees").update({status:"suspended",updated_at:now}).in("id",group);
    if(error) throw error;
  }
  return json({ok:true,mode,sheet_name:sheetName,present:present.size,candidates:candidates.length,suspended:missing.length,employee_nos:employeeNos});
}


function lifecycleSourcePriority(v:unknown){
  const s=text(v);
  if(s==='backend') return 40;
  if(s==='google_sheet_live') return 30;
  if(s==='google_sheet_history') return 20;
  return 10;
}
async function cleanupLifecycleDuplicatesInternal(service:any){
  const rows:any[]=[];let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employee_lifecycle_events")
      .select("id,employee_id,employee_no,event_type,effective_date,source,created_at,note")
      .in("event_type",["join","resign"])
      .or("note.is.null,note.neq.__VOIDED__")
      .order("created_at",{ascending:true})
      .range(offset,offset+batch-1);
    if(error) throw error;
    rows.push(...(data||[]));
    if((data||[]).length<batch) break;
    offset+=batch;if(offset>30000)break;
  }
  const groups=new Map<string,any[]>();
  for(const r of rows){
    const no=upper(r.employee_no), type=text(r.event_type), date=text(r.effective_date).slice(0,10);
    if(!no||!date) continue;
    const key=`${no}|${type}|${date}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key)!.push(r);
  }
  const losers:string[]=[];let duplicateGroups=0;
  for(const list of groups.values()){
    if(list.length<2) continue;
    duplicateGroups++;
    list.sort((a:any,b:any)=>{
      const pa=lifecycleSourcePriority(a.source),pb=lifecycleSourcePriority(b.source);
      if(pb!==pa) return pb-pa;
      if(Boolean(b.employee_id)!==Boolean(a.employee_id)) return Number(Boolean(b.employee_id))-Number(Boolean(a.employee_id));
      return text(b.created_at).localeCompare(text(a.created_at));
    });
    for(const r of list.slice(1)) losers.push(r.id);
  }
  for(let i=0;i<losers.length;i+=200){
    const {error}=await service.from("employee_lifecycle_events").update({note:"__VOIDED__"}).in("id",losers.slice(i,i+200));
    if(error) throw error;
  }
  return {duplicate_groups:duplicateGroups,voided:losers.length};
}
async function cleanupLifecycleDuplicates(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!expected||text(body.secret)!==expected) return json({error:"invalid sync secret"},401);
  return json({ok:true,...await cleanupLifecycleDuplicatesInternal(service)});
}
async function cleanupRetiredTestRecords(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!expected||text(body.secret)!==expected) return json({error:"invalid sync secret"},401);
  const {data:rows,error}=await service.from("employees").select("id,employee_no").ilike("employee_no","TEST%");
  if(error) throw error;
  const ids=(rows||[]).map((x:any)=>x.id).filter(Boolean), nos=(rows||[]).map((x:any)=>text(x.employee_no)).filter(Boolean);
  for(let i=0;i<nos.length;i+=100){const {error:e}=await service.from("employee_lifecycle_events").delete().in("employee_no",nos.slice(i,i+100));if(e)throw e;}
  for(let i=0;i<ids.length;i+=100){const {error:e}=await service.from("employees").delete().in("id",ids.slice(i,i+100));if(e)throw e;}
  return json({ok:true,deleted:(rows||[]).length,employee_nos:nos});
}

async function syncResignEvents(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!expected||text(body.secret)!==expected) return json({error:"invalid sync secret"},401);

  const raw=Array.isArray(body.items)?body.items:[];
  if(raw.length>500) return json({error:"too many resignation items; max 500"},400);

  const items=raw.map((x:any)=>({
    employee_no:upper(x.employee_no),
    employee_name:text(x.employee_name),
    resign_date:text(x.resign_date).slice(0,10),
    reason:text(x.reason),
    source_sheet:text(x.source_sheet),
    row_number:Number(x.row_number||0),
  })).filter((x:any)=>x.employee_no&&/^\d{4}-\d{2}-\d{2}$/.test(x.resign_date)&&!isIgnoredEmployeeNo(x.employee_no));

  if(!items.length) return json({ok:true,processed:0,inserted:0,updated:0,employee_updates:0,missing_employee:0,skipped_voided:0});

  const identityRows=await resolveConfirmedEmployeeIdentityBatch(
    service,items.map((item:any)=>item.employee_no),
  );
  const identity=resolveConfirmedResignationItems(items,identityRows);
  if(identity.conflicts.length){
    return json({
      ok:false,
      error:"confirmed_employee_alias_name_conflict",
      retryable:true,
      conflicts:identity.conflicts.map((conflict:any)=>({
        employee_no:upper(conflict.item?.employee_no),
        source_sheet:text(conflict.item?.source_sheet),
        row_number:Number(conflict.item?.row_number||0),
        reason:text(conflict.reason),
      })),
    },409);
  }

  if(identity.missing.length){
    return json({
      ok:false,
      error:"employee_identity_not_ready",
      retryable:true,
      missing:identity.missing.map((missing:any)=>({
        employee_no:upper(missing.item?.employee_no),
        source_sheet:text(missing.item?.source_sheet),
        row_number:Number(missing.item?.row_number||0),
        reason:text(missing.reason),
      })),
    },409);
  }

  const preparedIdentity=prepareConfirmedResignationItems(identity.resolved);
  if(preparedIdentity.conflicts.length){
    return json({
      ok:false,
      error:"conflicting_resignation_dates",
      retryable:true,
      conflicts:preparedIdentity.conflicts,
    },409);
  }
  const resolvedItems=preparedIdentity.items;

  const employeeIds=Array.from(new Set(resolvedItems.map((item:any)=>item.employeeId)));
  const employees:any[]=[];
  for(let i=0;i<employeeIds.length;i+=200){
    const {data,error}=await service.from("employees")
      .select("id,employee_no,full_name,status,resign_date")
      .in("id",employeeIds.slice(i,i+200));
    if(error) throw error;
    employees.push(...(data||[]));
  }
  const empById=new Map(employees.map((x:any)=>[text(x.id),x]));
  if(resolvedItems.some((item:any)=>!empById.has(item.employeeId))){
    throw new Error("confirmed_employee_identity_resolution_failed");
  }
  const ids=employees.map((x:any)=>x.id).filter(Boolean);

  const existing:any[]=[];
  for(let i=0;i<ids.length;i+=200){
    const {data,error}=await service.from("employee_lifecycle_events")
      .select("id,employee_id,employee_no,effective_date,reason,note,source,snapshot,created_at")
      .eq("event_type","resign")
      .in("employee_id",ids.slice(i,i+200));
    if(error) throw error;
    existing.push(...(data||[]));
  }

  const existingByKey=new Map<string,any[]>();
  for(const ev of existing){
    const key=`${text(ev.employee_id)}|${text(ev.effective_date).slice(0,10)}`;
    if(!existingByKey.has(key)) existingByKey.set(key,[]);
    existingByKey.get(key)!.push(ev);
  }

  const pendingInsertByKey=new Map<string,any>();
  const toUpdate:any[]=[];
  const employeeUpdates=new Map<string,any>();
  let missingEmployee=0,skippedVoided=0;

  for(const resolvedItem of resolvedItems){
    const item=resolvedItem.item;
    const emp=empById.get(resolvedItem.employeeId);

    const key=`${emp.id}|${item.resign_date}`;
    const same=existingByKey.get(key)||[];
    const active=same.find((x:any)=>text(x.note)!=="__VOIDED__");
    const voided=same.find((x:any)=>text(x.note)==="__VOIDED__");

    if(!active&&voided){
      skippedVoided++;
      continue;
    }

    if(text(emp.status)!=="resigned"||text(emp.resign_date).slice(0,10)!==item.resign_date){
      employeeUpdates.set(emp.id,{id:emp.id,resign_date:item.resign_date});
    }

    if(active){
      toUpdate.push({
        id:active.id,
        reason:item.reason||text(active.reason)||null,
        source_sheet:item.source_sheet||null,
        source_row:item.row_number||null,
        snapshot:{
          ...(active.snapshot||{}),
          auto_reconciled:true,
          source_row:item.row_number||null,
          source_employee_no:resolvedItem.sourceEmployeeNo,
          source_employee_name:item.employee_name||null,
          canonical_employee_no:emp.employee_no,
          confirmed_employee_alias:resolvedItem.isConfirmedAlias,
        },
      });
    }else{
      const pending=pendingInsertByKey.get(key);
      if(pending){
        pending.reason=item.reason||pending.reason;
        pending.source_sheet=item.source_sheet||pending.source_sheet;
        pending.source_row=item.row_number||pending.source_row;
        continue;
      }
      pendingInsertByKey.set(key,{
        employee_id:emp.id,
        employee_no:emp.employee_no,
        full_name:text(emp.full_name)||emp.employee_no,
        event_type:"resign",
        effective_date:item.resign_date,
        reason:item.reason||null,
        note:null,
        source:"google_sheet_live",
        source_sheet:item.source_sheet||null,
        source_row:item.row_number||null,
        source_key:`sheet:auto_resign:${emp.id}:${item.resign_date}`,
        snapshot:{
          auto_reconciled:true,
          source_row:item.row_number||null,
          source_employee_no:resolvedItem.sourceEmployeeNo,
          source_employee_name:item.employee_name||null,
          canonical_employee_no:emp.employee_no,
          confirmed_employee_alias:resolvedItem.isConfirmedAlias,
        },
      });
    }
  }

  const runConcurrent=async(arr:any[],limit:number,fn:(x:any)=>Promise<any>)=>{
    for(let i=0;i<arr.length;i+=limit) await Promise.all(arr.slice(i,i+limit).map(fn));
  };

  await runConcurrent([...employeeUpdates.values()],20,async(x:any)=>{
    const {error}=await service.from("employees")
      .update({status:"resigned",resign_date:x.resign_date,updated_at:new Date().toISOString()})
      .eq("id",x.id);
    if(error) throw error;
  });

  await runConcurrent(toUpdate,20,async(x:any)=>{
    const {id,...patch}=x;
    const {error}=await service.from("employee_lifecycle_events").update(patch).eq("id",id);
    if(error) throw error;
  });

  const toInsert=[...pendingInsertByKey.values()];
  if(toInsert.length){
    const {error}=await service.from("employee_lifecycle_events").insert(toInsert);
    if(error) throw error;
  }

  return json({
    ok:true,
    processed:items.length,
    inserted:toInsert.length,
    updated:toUpdate.length,
    employee_updates:employeeUpdates.size,
    missing_employee:missingEmployee,
    confirmed_aliases:resolvedItems.filter((item:any)=>item.isConfirmedAlias).length,
    skipped_voided:skippedVoided,
  });
}

async function reconcileProductionPresence(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  const given=text(body.secret);
  if(!expected||given!==expected) return json({error:"invalid sync secret"},401);

  // Formal Google is the authoritative HR presence list.
  // TEST-prefixed IDs are allowed in the FORMAL workbook for controlled workflow testing,
  // so presence reconciliation includes them. They remain excluded from KPI analytics.
  const rawPresent=(Array.isArray(body.present_ids)?body.present_ids:[])
    .map(upper)
    .filter((n:string)=>Boolean(n)&&n!=="SYSTEM"&&n!=="ADMIN");
  const identityRows=await resolveConfirmedEmployeeIdentityBatch(service,rawPresent);
  const canonicalPresence=canonicalizeConfirmedPresentEmployeeNos(rawPresent,identityRows);
  if(canonicalPresence.conflicts.length){
    return json({
      ok:false,
      error:"confirmed_employee_identity_conflict",
      retryable:true,
      conflicts:canonicalPresence.conflicts.map((conflict:any)=>({
        employee_no:upper(conflict.rawEmployeeNo),
        reason:text(conflict.reason),
      })),
    },409);
  }
  const present=canonicalPresence.presentEmployeeNos;

  if(present.size<500){
    // A tiny/partial Google read must never turn into a destructive reconcile or a failed trigger.
    return json({ok:true,skipped:"production_presence_list_too_small",present:present.size});
  }

  const candidates:any[]=[];
  let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employees")
      .select("id,employee_no,status,source_sheet,source_type")
      .range(offset,offset+batch-1);
    if(error) throw error;

    const rows=(data||[]).filter((r:any)=>{
      if(isIgnoredEmployeeNo(r.employee_no)) return false;
      const formal=["在职名单 Current Staff List","现场转居家"].includes(text(r.source_sheet));
      const backend=text(r.source_type)==="backend" || text(r.source_sheet)==="WFH后台";
      return formal||backend;
    });
    candidates.push(...rows);

    if((data||[]).length<batch) break;
    offset+=batch;if(offset>20000)break;
  }

  const missing=candidates.filter((r:any)=>
    !present.has(upper(r.employee_no)) &&
    text(r.source_type)!=="google_deleted"
  );

  const guard=reconcileSafety(candidates,missing,present,"production_hr_presence");
  if(guard) return json(guard);

  if(!missing.length){
    return json({ok:true,mode:"production",present:present.size,candidates:candidates.length,hidden:0,lifecycle_voided:0});
  }

  const ids=missing.map((r:any)=>r.id).filter(Boolean);
  const employeeNos=Array.from(new Set(missing.map((r:any)=>text(r.employee_no)).filter(Boolean)));

  // V29.1 SAFE DELETE SEMANTICS:
  // Never query payout_accounts/payroll/finance tables here.
  // Google deletion means "remove from HR system view", while the DB UUID stays for FK/audit safety.
  // This avoids the current payout_accounts permission-denied 400.
  let lifecycleVoided=0;
  for(let i=0;i<employeeNos.length;i+=100){
    const group=employeeNos.slice(i,i+100);
    const {data,error}=await service.from("employee_lifecycle_events")
      .update({note:"__VOIDED__"})
      .in("employee_no",group)
      .or("note.is.null,note.neq.__VOIDED__")
      .select("id");
    if(error) throw error;
    lifecycleVoided+=(data||[]).length;
  }

  const now=new Date().toISOString();
  for(let i=0;i<ids.length;i+=200){
    const {error}=await service.from("employees").update({
      status:"suspended",
      source_type:"google_deleted",
      source_sheet:"正式Google已删除",
      updated_at:now,
    }).in("id",ids.slice(i,i+200));
    if(error) throw error;
  }

  return json({
    ok:true,mode:"production",present:present.size,candidates:candidates.length,
    hidden:ids.length,lifecycle_voided:lifecycleVoided,employee_nos:employeeNos
  });
}

async function productionSyncSnapshot(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  const given=text(body.secret);
  if(!expected||given!==expected) return json({error:"invalid sync secret"},401);

  const rows:any[]=[];let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employees")
      .select("employee_no,status,resign_date,source_sheet")
      .range(offset,offset+batch-1);
    if(error) throw error;
    rows.push(...(data||[]));
    if((data||[]).length<batch) break;
    offset+=batch;
    if(offset>20000) break;
  }

  const employees=rows.filter((r:any)=>!isIgnoredEmployeeNo(r.employee_no)&&!isTestEmployeeNo(r.employee_no));
  const resignedNos=employees.filter((r:any)=>r.status==="resigned").map((r:any)=>upper(r.employee_no)).filter(Boolean);
  const latestResign=new Map<string,any>();

  for(let i=0;i<resignedNos.length;i+=200){
    const group=resignedNos.slice(i,i+200);
    const {data,error}=await service.from("employee_lifecycle_events")
      .select("employee_no,effective_date,reason,created_at,source")
      .eq("event_type","resign")
      .in("employee_no",group)
      .order("created_at",{ascending:false});
    if(error) throw error;
    for(const r of (data||[])){
      const no=upper(r.employee_no);
      if(no&&!latestResign.has(no)) latestResign.set(no,r);
    }
  }

  return json({
    ok:true,
    employees:employees.map((r:any)=>{
      const no=upper(r.employee_no);
      const ev=latestResign.get(no);
      return {
        employee_no:no,
        status:text(r.status),
        resign_date:text(r.resign_date||ev?.effective_date).slice(0,10)||null,
        resign_reason:text(ev?.reason)||null,
        resign_source:text(ev?.source)||null,
        source_sheet:text(r.source_sheet)||null,
      };
    }),
  });
}


function baselineDateOnly(v:unknown){
  const s=text(v);
  if(!s) return null;
  const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const zh=s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if(zh) return `${zh[1]}-${String(zh[2]).padStart(2,"0")}-${String(zh[3]).padStart(2,"0")}`;
  return null;
}
function baselineInferHomeType(country:string){
  return country.includes("菲律宾")?"纯居家菲律宾":"纯居家（越南/缅甸/印尼等）";
}
const baselineNormName=(v:unknown)=>text(v).replace(/\s+/g," ").toLowerCase();

async function baselineReferenceMaps(service:any){
  const [{data:teams,error:te},{data:positions,error:pe}]=await Promise.all([
    service.from("teams").select("id,name"),
    service.from("positions").select("id,name"),
  ]);
  if(te) throw te;if(pe) throw pe;
  return {
    teams:new Map((teams||[]).map((x:any)=>[baselineNormName(x.name),x.id])),
    positions:new Map((positions||[]).map((x:any)=>[baselineNormName(x.name),x.id])),
  };
}
async function baselineEnsureTeam(service:any,cache:any,name:unknown){
  const n=text(name);if(!n)return null;
  const k=baselineNormName(n);if(cache.teams.has(k))return cache.teams.get(k);
  const {data:found,error:fe}=await service.from("teams").select("id").ilike("name",n).limit(1).maybeSingle();
  if(fe) throw fe;
  if(found?.id){cache.teams.set(k,found.id);return found.id;}
  const {data:created,error:ce}=await service.from("teams").insert({name:n,status:"active"}).select("id").single();
  if(ce) throw ce;cache.teams.set(k,created.id);return created.id;
}
async function baselineEnsurePosition(service:any,cache:any,name:unknown){
  const n=text(name);if(!n)return null;
  const k=baselineNormName(n);if(cache.positions.has(k))return cache.positions.get(k);
  const {data:found,error:fe}=await service.from("positions").select("id").ilike("name",n).limit(1).maybeSingle();
  if(fe) throw fe;
  if(found?.id){cache.positions.set(k,found.id);return found.id;}
  const {data:created,error:ce}=await service.from("positions").insert({name:n,status:"active"}).select("id").single();
  if(ce) throw ce;cache.positions.set(k,created.id);return created.id;
}

async function productionBaselineUpsert(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  const given=text(body.secret);
  if(!expected||given!==expected) return json({error:"invalid sync secret"},401);
  const raw=Array.isArray(body.items)?body.items:[];
  if(!raw.length) return json({ok:true,count:0,upserted:0,skipped:0});
  if(raw.length>250) return json({error:"baseline batch too large; max 250"},400);

  const items=raw.filter((item:any)=>{
    const no=upper(item?.row?.ID);
    return !isIgnoredEmployeeNo(no)&&!isTestEmployeeNo(no)&&["在职名单 Current Staff List","现场转居家"].includes(text(item?.sheet_name));
  });
  const nos=Array.from(new Set(items.map((x:any)=>upper(x?.row?.ID)).filter(Boolean)));
  const existingRows:any[]=[];
  for(let i=0;i<nos.length;i+=200){
    const group=nos.slice(i,i+200);
    const {data,error}=await service.from("employees").select("id,employee_no,status,team_id,position_id,shift_name,platform_scope").in("employee_no",group);
    if(error) throw error;
    existingRows.push(...(data||[]));
  }
  const existing=new Map(existingRows.map((x:any)=>[upper(x.employee_no),x]));
  const refs=await baselineReferenceMaps(service);
  const now=new Date().toISOString();
  const payloadMap=new Map<string,any>();
  const meta=new Map<string,any>();
  let skippedHistoricalResigned=0;

  for(const item of items){
    const row=item.row||{};
    const sheet=text(item.sheet_name);
    const rowNumber=Number(item.row_number||0);
    const no=upper(row.ID);
    if(!no) continue;
    if(sheet==="在职名单 Current Staff List"){
      const country=text(row["国家 country"]);
      const hireDate=baselineDateOnly(row["入职日期 hiredate Y/M/D"]);
      const resignDate=baselineDateOnly(row["离职日期"]);
      const backend=text(row["后台账号"]);
      const resigned=Boolean(resignDate)||backend==="辞职";
      if(resigned&&!existing.has(no)){skippedHistoricalResigned++;continue;}
      const ex=existing.get(no);
      const teamId=ex?.team_id || await baselineEnsureTeam(service,refs,row["盘口国家"]);
      const positionId=ex?.position_id || await baselineEnsurePosition(service,refs,row["岗位"]);
      payloadMap.set(no,{
        employee_no:no,
        full_name:text(row["名字 Name"])||no,
        country:country||null,
        nationality:country||null,
        employment_type:baselineInferHomeType(country),
        position_id:positionId,
        team_id:teamId,
        status:resigned?"resigned":"active",
        market_country:text(row["盘口国家"])||null,
        market_position:text(row["盘口岗位 Platform position"])||null,
        shift_name:ex?.shift_name || text(row["班次"])||null,
        legacy_shift_name:ex?.shift_name || text(row["班次"])||null,
        work_tg:text(row["工作飞机 Work TG"])||null,
        backend_accounts:resigned?"辞职":(backend||null),
        hire_date:hireDate,
        resign_date:resignDate,
        source_type:"google_sheet",
        source_sheet:sheet,
        source_row:rowNumber,
        profile_status:"sheet_synced",
        updated_at:now,
      });
      meta.set(no,{sheet,rowNumber,row,hireDate,resignDate,resigned});
    }else{
      const country=text(row["员工国家"]);
      const hireDate=baselineDateOnly(row["入职时间"]);
      const resignDate=baselineDateOnly(row["离职时间"]);
      const backend=text(row["后台账号"]);
      const resigned=Boolean(resignDate)||backend==="辞职";
      if(resigned&&!existing.has(no)){skippedHistoricalResigned++;continue;}
      const ex=existing.get(no);
      const positionId=ex?.position_id || await baselineEnsurePosition(service,refs,row["岗位"]);
      payloadMap.set(no,{
        employee_no:no,
        full_name:text(row["名字"])||no,
        country:country||null,
        nationality:country||null,
        employment_type:"现场转居家",
        position_id:positionId,
        status:resigned?"resigned":"active",
        market_country:text(row["国家"])||null,
        platform_scope:ex?.platform_scope || text(row["盘口"])||null,
        last_location:text(row["最后的地点"])||null,
        hire_date:hireDate,
        return_date:baselineDateOnly(row["回去时间"]),
        home_date:baselineDateOnly(row["居家时间"]),
        resign_date:resignDate,
        backend_accounts:resigned?"辞职":(backend||null),
        source_type:"google_sheet",
        source_sheet:sheet,
        source_row:rowNumber,
        profile_status:"sheet_synced",
        updated_at:now,
      });
      meta.set(no,{sheet,rowNumber,row,hireDate,resignDate,resigned});
    }
  }

  const payloads=Array.from(payloadMap.values());
  if(!payloads.length) return json({ok:true,count:items.length,upserted:0,skipped_historical_resigned:skippedHistoricalResigned});

  const {data:upserted,error:ue}=await service.from("employees")
    .upsert(payloads,{onConflict:"employee_no"})
    .select("id,employee_no,full_name");
  if(ue) throw ue;
  const empMap=new Map<string,any>((upserted||[]).map((x:any)=>[upper(x.employee_no),x]));

  const joinEvents:any[]=[];
  for(const p of payloads){
    const no=upper(p.employee_no),m=meta.get(no),emp=empMap.get(no);
    if(!m?.hireDate||!emp?.id) continue;
    const prefix=m.sheet==="在职名单 Current Staff List"?"current":"onsite";
    joinEvents.push({
      employee_id:emp.id,
      employee_no:no,
      full_name:p.full_name,
      event_type:"join",
      effective_date:m.hireDate,
      reason:null,
      note:null,
      source:"google_sheet_live",
      source_sheet:m.sheet,
      source_row:m.rowNumber,
      source_key:`sheet:${prefix}:${m.rowNumber}:${no}:join`,
      snapshot:m.row,
    });
  }
  if(joinEvents.length){
    const {error:je}=await service.from("employee_lifecycle_events").upsert(joinEvents,{onConflict:"source_key"});
    if(je) throw je;
  }

  const onsitePayloads=payloads.filter((x:any)=>x.source_sheet==="现场转居家");
  if(onsitePayloads.length){
    const contacts:any[]=[],comp:any[]=[],payments:any[]=[];
    const num=(v:unknown)=>{const ss=text(v);if(ss==="")return null;const n=Number(ss.replace(/,/g,""));return Number.isFinite(n)?n:null;};
    for(const p of onsitePayloads){
      const no=upper(p.employee_no),m=meta.get(no),emp=empMap.get(no);
      if(!m||!emp?.id) continue;
      const row=m.row;
      contacts.push({
        employee_id:emp.id,
        work_email:text(row["WORKFOLIO邮箱"])||null,
        telegram_username:text(row["telegram 用户名"])||null,
        zoom_email:text(row["ZOOM邮箱"])||null,
        facebook:text(row["Facebook"])||null,
        whatsapp_phone:text(row["WhatsApp/或者手机号"])||null,
        source_sheet:"现场转居家",
        updated_at:now,
      });
      comp.push({
        employee_id:emp.id,
        base_salary:num(row["居家底薪工资"]),
        performance_default:num(row["绩效"]),
        meal_allowance:num(row["餐补"]),
        currency:"USD",
        effective_from:baselineDateOnly(row["居家时间"]),
        note:"Google Sheet 现场转居家同步",
        updated_at:now,
      });
      payments.push({
        employee_id:emp.id,
        payment_mode:"usdt",
        payment_mode_source:"现场转居家",
        transfer_using:"USDT",
        usdt_address:text(row["USDT地址"])||null,
        source_sheet:"现场转居家",
        updated_at:now,
      });
    }
    if(contacts.length){const {error}=await service.from("employee_contact_profiles").upsert(contacts,{onConflict:"employee_id"});if(error)throw error;}
    if(comp.length){const {error}=await service.from("employee_compensation_settings").upsert(comp,{onConflict:"employee_id"});if(error)throw error;}
    if(payments.length){const {error}=await service.from("employee_payment_profiles").upsert(payments,{onConflict:"employee_id"});if(error)throw error;}
  }

  return json({ok:true,count:items.length,upserted:(upserted||[]).length,skipped_historical_resigned:skippedHistoricalResigned});
}

async function productionBaselineSnapshot(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  const given=text(body.secret);
  if(!expected||given!==expected) return json({error:"invalid sync secret"},401);
  const rows:any[]=[];let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employees")
      .select("id,employee_no,full_name,status,hire_date,resign_date,country,nationality,employment_type,work_tg,backend_accounts,market_country,market_position,platform_scope,shift_name,source_sheet,source_row,team_id,position_id,teams:team_id(name),positions:position_id(name),updated_at")
      .range(offset,offset+batch-1);
    if(error) throw error;
    rows.push(...(data||[]));
    if((data||[]).length<batch) break;
    offset+=batch;if(offset>20000)break;
  }
  return json({ok:true,employees:rows.filter((r:any)=>!isIgnoredEmployeeNo(r.employee_no)&&!isTestEmployeeNo(r.employee_no))});
}

async function reconcileBankPresence(service:any,body:any){
  const expected=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!expected||text(body.secret)!==expected) return json({error:"invalid sync secret"},401);

  const rawPresentNos=(Array.isArray(body.present_employee_nos)?body.present_employee_nos:[])
    .map(upper).filter((x:string)=>Boolean(x)&&x!=="SYSTEM"&&x!=="ADMIN");
  const identityRows=await resolveConfirmedEmployeeIdentityBatch(service,rawPresentNos);
  const canonicalPresence=canonicalizeConfirmedPresentEmployeeNos(rawPresentNos,identityRows);
  if(canonicalPresence.conflicts.length){
    return json({
      ok:false,
      error:"confirmed_employee_identity_conflict",
      retryable:true,
      conflicts:canonicalPresence.conflicts.map((conflict:any)=>({
        employee_no:upper(conflict.rawEmployeeNo),
        reason:text(conflict.reason),
      })),
    },409);
  }
  const presentNos=canonicalPresence.presentEmployeeNos;
  const presentNames=new Set((Array.isArray(body.present_names)?body.present_names:[])
    .map((x:any)=>text(x).replace(/\s+/g," ").toLowerCase()).filter(Boolean));

  // Safety first: 银行信息 normally has many rows. A tiny/empty scan is treated as a read failure, not a delete request.
  if(presentNos.size<20 && presentNames.size<50){
    return json({ok:true,skipped:"bank_presence_list_too_small",present_employee_nos:presentNos.size,present_names:presentNames.size});
  }

  const profiles:any[]=[];let offset=0;const batch=1000;
  while(true){
    const {data,error}=await service.from("employee_payment_profiles")
      .select("employee_id,source_sheet")
      .eq("source_sheet","银行信息")
      .range(offset,offset+batch-1);
    if(error) throw error;
    profiles.push(...(data||[]));
    if((data||[]).length<batch)break;
    offset+=batch;if(offset>20000)break;
  }
  if(!profiles.length) return json({ok:true,profiles:0,deleted:0});

  const ids=Array.from(new Set(profiles.map((x:any)=>x.employee_id).filter(Boolean)));
  const employees:any[]=[];
  for(let i=0;i<ids.length;i+=200){
    const {data,error}=await service.from("employees").select("id,employee_no,full_name").in("id",ids.slice(i,i+200));
    if(error) throw error; employees.push(...(data||[]));
  }
  const em=new Map(employees.map((x:any)=>[x.id,x]));
  const missing:string[]=[];
  for(const p of profiles){
    const e=em.get(p.employee_id);
    if(!e) continue;
    const no=upper(e.employee_no),name=text(e.full_name).replace(/\s+/g," ").toLowerCase();
    // Hidden stable employee ID is definitive. Existing unbound legacy rows are preserved by exact name.
    if((no&&presentNos.has(no))||(name&&presentNames.has(name))) continue;
    missing.push(p.employee_id);
  }
  if(missing.length){
    const matched=profiles.length-missing.length;
    const coverage=profiles.length?matched/profiles.length:1;
    const maxChanges=Math.max(10,Math.ceil(profiles.length*0.08));
    if(coverage<0.85||missing.length>maxChanges){
      return json({
        ok:true,
        skipped:"destructive_reconcile_guard",
        label:"bank_profiles",
        profiles:profiles.length,
        matched,
        coverage:Number((coverage*100).toFixed(2)),
        proposed_changes:missing.length,
        max_allowed_changes:maxChanges,
        message:"银行资料来源重合度异常或拟删除数量过大；本次未删除任何收款资料。",
      });
    }
  }
  for(let i=0;i<missing.length;i+=100){
    const {error}=await service.from("employee_payment_profiles").delete().in("employee_id",missing.slice(i,i+100));
    if(error) throw error;
  }
  return json({ok:true,profiles:profiles.length,present_employee_nos:presentNos.size,present_names:presentNames.size,deleted:missing.length});
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json({error:"Method not allowed"},405);
  try{
    const service=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
    const body=await req.json().catch(()=>({}));
    if(text(body.action)==="sync_resign_events") return await syncResignEvents(service,body);
    if(text(body.action)==="cleanup_lifecycle_duplicates") return await cleanupLifecycleDuplicates(service,body);
    if(text(body.action)==="cleanup_retired_test_records") return await cleanupRetiredTestRecords(service,body);
    if(text(body.action)==="production_baseline_upsert") return await productionBaselineUpsert(service,body);
    if(text(body.action)==="production_baseline_snapshot") return await productionBaselineSnapshot(service,body);
    if(text(body.action)==="production_sync_snapshot") return await productionSyncSnapshot(service,body);
    if(text(body.action)==="reconcile_production_presence") return await reconcileProductionPresence(service,body);
    if(text(body.action)==="reconcile_bank_presence") return await reconcileBankPresence(service,body);
    if(text(body.action)==="reconcile_sheet_presence"){
      // Backward compatibility with V28 while V28.2 Apps Script is being installed.
      // TEST mode is retired: only production requests are accepted.
      if(text(body.mode)==="test") return json({ok:true,retired:true,mode:"test",message:"TEST sync retired in V28.2"});
      return await reconcileSheetPresence(service,{...body,mode:"production"});
    }

    const scope=await callerAndScope(req,service);
    const organization=await loadCurrentRosterOrganization(service,scope);
    const today=/^\d{4}-\d{2}-\d{2}$/.test(text(body.today))?text(body.today):new Date().toISOString().slice(0,10);

    if(text(body.action)==="tenure_details"){
      const bucket=text(body.bucket);
      const includeTest=body.include_test===true;
      const all=await allEmployees(service,organization,includeTest);
      const rows=all
        .filter((x:any)=>isTenureEmployee(x,today)&&tenureKey(x.hire_date,today)===bucket)
        .map((x:any)=>({
          id:`tenure:${text(x.id)}`,
          employee_id:x.id,
          employee_no:text(x.employee_no),
          full_name:text(x.full_name),
          employment_type:text(x.employment_type),
          date:text(x.hire_date).slice(0,10),
          event_type:"active",
          reason:"",
          team:text(x.teams?.name)||"未分类",
          position:text(x.positions?.name)||"未分类",
          country:text(x.country||x.nationality)||"未分类",
          shift:text(x.shift_name)||"未分类",
          created_at:null,
          is_test:isTestEmployeeNo(x.employee_no),
        }))
        .sort((a:any,b:any)=>text(a.date).localeCompare(text(b.date))||text(a.employee_no).localeCompare(text(b.employee_no)));
      const test_count=rows.filter((x:any)=>x.is_test).length;
      return json({
        rows,total:rows.length,bucket,today,include_test:includeTest,
        production_total:rows.length-test_count,test_count
      });
    }

    const all=await allEmployees(service,organization);
    const active=all.filter((x:any)=>isEffectiveActiveEmployee(x,today));
    const futureHires=all.filter((x:any)=>isFutureHireEmployee(x,today));
    const tenureEmployees=[...active,...futureHires];
    const positions=new Map<string,number>(),countries=new Map<string,number>(),platforms=new Map<string,number>(),teams=new Map<string,number>(),shifts=new Map<string,number>();
    const tenureCounts:any={
      prepare:0,within_7:0,days_8_14:0,days_15_30:0,days_31_60:0,
      days_61_180:0,months_6_12:0,years_1_2:0,years_2_3:0,years_3_plus:0,unknown:0
    };
    let latest="";
    for(const r of all){if(text(r.updated_at)>latest)latest=text(r.updated_at);}
    for(const r of active){
      const inc=(m:Map<string,number>,v:unknown,fallback:string)=>{const k=text(v)||fallback;m.set(k,(m.get(k)||0)+1)};
      inc(positions,r.positions?.name,"未设置岗位");inc(countries,r.country||r.nationality,"未分类");inc(teams,r.teams?.name,"未匹配团队");inc(shifts,r.shift_name,"未设置班次");
      const ps=splitPlatforms(r.platform_scope);if(ps.length)ps.forEach(p=>inc(platforms,p,"未设置盘口"));else inc(platforms,"未设置盘口","未设置盘口");
    }
    for(const r of tenureEmployees){
      const tk=tenureKey(r.hire_date,today);tenureCounts[tk]=(tenureCounts[tk]||0)+1;
    }
    const tenureDefs=[
      ["prepare","待入职"],
      ["within_7","入职 ≤7天"],
      ["days_8_14","入职 8–14天"],
      ["days_15_30","入职 15–30天"],
      ["days_31_60","入职 31–60天"],
      ["days_61_180","入职 61天–6个月"],
      ["months_6_12","入职 6个月–1年"],
      ["years_1_2","入职 1–2年"],
      ["years_2_3","入职 2–3年"],
      ["years_3_plus","入职 3年以上"],
      ["unknown","入职日期未知"],
    ];
    const eligibleNos=new Set(all.filter((x:any)=>x.status!=="suspended").map((x:any)=>upper(x.employee_no)).filter(Boolean));
    const events=await lifecycleRows(service,isoAdd(today,-60));
    const eventKpis=lifecycleKpis(events,eligibleNos,today);
    return json({
      as_of:today,total:all.length,active:active.length,future_hires:futureHires.length,latest_updated_at:latest,
      kpis:{active:active.length,future_hires:futureHires.length,total_profiles:all.filter((x:any)=>x.status!=="suspended").length,...eventKpis},
      tenure:tenureDefs.map(([key,name])=>({key,name,count:tenureCounts[key]||0,share:ratio(tenureCounts[key]||0,tenureEmployees.length)})),
      positions:breakdown(positions,active.length),countries:breakdown(countries,active.length),platforms:breakdown(platforms,active.length),teams:breakdown(teams,active.length),shifts:breakdown(shifts,active.length),
    });
  }catch(e){
    console.error(e);
    const message=e instanceof Error?e.message:String(e);
    if(message==="confirmed_employee_identity_resolution_failed"){
      return json({error:message,retryable:true},503);
    }
    return json({error:message},400);
  }
});
