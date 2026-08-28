import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadEffectiveEmployeeScope } from "../_shared/employeeScope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });

const text = (v: unknown) => String(v ?? "").trim();
const employeeNoKey = (v: unknown) => text(v).toUpperCase();

class HttpError extends Error {
  status:number;
  code:string;
  retryable:boolean;

  constructor(status:number,code:string,message:string,retryable=false){
    super(message);
    this.name="HttpError";
    this.status=status;
    this.code=code;
    this.retryable=retryable;
  }
}

function errorStatus(value:any){
  const status=Number(value?.status||value?.statusCode||value?.context?.status||0);
  return Number.isFinite(status)?status:0;
}

function errorCode(value:any){
  return text(value?.code||value?.error_code||value?.name).slice(0,80);
}

function isRetryableBackendFailure(value:any){
  const status=errorStatus(value);
  const code=errorCode(value).toUpperCase();
  const message=text(value?.message||value?.error||value).toLowerCase();
  return status>=500
    || code==="57014"
    || code.startsWith("PGRST")&&status>=500
    || /statement timeout|canceling statement|connection|connection reset|connection refused|fetch failed|network|timed? ?out|timeout|upstream|gateway|socket|econn/.test(message);
}

function responseFailure(value:any){
  if(value instanceof HttpError){
    return {status:value.status,code:value.code,retryable:value.retryable,message:value.message};
  }
  if(isRetryableBackendFailure(value)){
    return {status:503,code:"service_temporarily_unavailable",retryable:true,message:"员工资料服务暂时繁忙，请稍后重试。"};
  }
  const status=errorStatus(value);
  if(status===401) return {status:401,code:"not_authenticated",retryable:false,message:"登录状态无效，请重新登录。"};
  if(status===403) return {status:403,code:"permission_denied",retryable:false,message:"没有执行此操作的权限。"};
  const backendCode=errorCode(value);
  if(backendCode&&backendCode!=="Error"){
    return {status:500,code:"internal_error",retryable:false,message:"员工资料服务处理失败，请稍后重试。"};
  }
  const message=value instanceof Error?value.message:text(value?.message||value?.error||value);
  return {status:400,code:"invalid_request",retryable:false,message:message&&!/^\[object /i.test(message)?message:"请求处理失败。"};
}

function employeeRiskKey(value: unknown) {
  const count = Number(value || 0);
  if (count >= 31) return "high";
  if (count >= 16) return "watch";
  if (count >= 9) return "attention";
  if (count >= 1) return "normal";
  return "excellent";
}

function jwtSessionId(token:string){
  try{
    const raw=token.split(".")[1]?.replace(/-/g,"+").replace(/_/g,"/")||"";
    const padded=raw+"=".repeat((4-raw.length%4)%4);
    return text(JSON.parse(atob(padded))?.session_id);
  }catch{return "";}
}
async function requireCurrentAdminSession(service:any,userId:string,token:string){
  const sessionId=jwtSessionId(token);
  if(!sessionId) throw new HttpError(401,"not_authenticated","登录会话无效，请重新登录。");
  const {data,error}=await service.from("app_session_leases").select("user_id")
    .eq("user_id",userId).eq("session_id",sessionId).eq("portal","admin")
    .gt("lease_expires_at",new Date().toISOString()).maybeSingle();
  if(error) throw error;
  if(!data?.user_id) throw new HttpError(401,"session_not_current","此账号未持有当前设备登录权，请重新登录。");
}

const EMPLOYEE_DETAIL_SELECT = `
  id,employee_no,full_name,country,nationality,employment_type,team_id,position_id,shift_id,
  direct_leader_id,trainer_id,hire_date,resign_date,work_tg,work_account,status,rehire_status,
  resign_reason,created_at,updated_at,source_type,profile_status,shift_name,group_name,platform_scope,
  work_content,backend_accounts,source_sheet,leader_name,trainer_name,source_row,official_id_pending,
  market_country,market_position,legacy_shift_name,schedule_position,person_in_charge,on_site_trainer,
  online_leader,online_trainer,last_location,return_date,home_date,
  teams:team_id(id,name,country,status),positions:position_id(id,name,code,status)
`;
const CONTACT_DETAIL_SELECT = "employee_id,work_email,telegram_username,zoom_email,facebook,whatsapp_phone,source_sheet,updated_at";
const PAYMENT_DETAIL_SELECT = "employee_id,payment_mode,payment_mode_source,transfer_using,gcash_account,gcash_name,usdt_address,contact_phone,whatsapp_number,facebook,employee_address,source_sheet,updated_at";
const COMPENSATION_DETAIL_SELECT = "employee_id,base_salary,daily_rate,performance_default,meal_allowance,currency,effective_from,note,updated_by,updated_at";

function typeLabel(v: unknown) {
  const s = text(v);
  const map: Record<string,string> = {
    home_ph: "纯居家菲律宾",
    onsite_to_home: "现场转居家",
    home_vn: "纯居家越南",
    home_id: "纯居家印尼",
    home_mm: "纯居家缅甸",
  };
  return map[s] || s;
}

function maskMiddle(value: unknown) {
  const s = text(value);
  if (!s) return null;
  if (s.length <= 4) return "****";
  if (s.length <= 8) return `${s.slice(0, 2)} **** ${s.slice(-2)}`;
  return `${s.slice(0, 4)} **** ${s.slice(-4)}`;
}

function looksLikeUsdt(value: unknown) {
  const s = text(value);
  return /^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(s);
}

/**
 * 收款方式的真实判断：
 * - 优先数据库 payment_mode（015 已规范化）
 * - TRANSFER USING 写 USDT
 * - 现场转居家：全部走 USDT，包括少数菲律宾
 * - 纯居家印尼/越南/缅甸/马来：USDT
 * - 纯居家菲律宾：银行/钱包
 * - 旧银行表里有 TRON 地址，也识别成 USDT
 */
function resolvePaymentMode(employee: any, payment: any) {
  const stored = text(payment?.payment_mode);
  if (stored && stored !== "unknown") return stored;

  const using = text(payment?.transfer_using).toLowerCase();
  if (using.includes("usdt")) return "usdt";

  const type = typeLabel(employee?.employment_type);
  const country = text(employee?.country || employee?.nationality);

  if (type === "现场转居家") return "usdt";
  if (
    type.includes("纯居家") &&
    ["印尼","印度尼西亚","越南","缅甸","马来","马来西亚"].some(x => country.includes(x))
  ) return "usdt";
  if (type === "纯居家菲律宾" || (type.includes("纯居家") && country.includes("菲律宾"))) {
    return "bank_wallet";
  }

  if (looksLikeUsdt(payment?.gcash_account)) return "usdt";
  if (using) return "bank_wallet";
  return "unknown";
}

function effectivePayment(employee: any, payment: any) {
  const p = payment || {};
  const mode = resolvePaymentMode(employee, p);

  // 兼容 014：部分非菲律宾员工的 USDT 地址来自旧表的 GCASH ACCOUNT 列
  const effectiveUsdt =
    text(p.usdt_address) ||
    (mode === "usdt" ? text(p.gcash_account) : "");

  return {
    mode,
    usdt_address: effectiveUsdt || null,
    bank_wallet_account: mode === "bank_wallet" ? (text(p.gcash_account) || null) : null,
    account_name: text(p.gcash_name) || null,
    transfer_using: text(p.transfer_using) || (mode === "usdt" ? "USDT" : null),
    contact_phone: text(p.contact_phone) || null,
    whatsapp_number: text(p.whatsapp_number) || null,
    facebook: text(p.facebook) || null,
    employee_address: text(p.employee_address) || null,
    source_sheet: text(p.source_sheet) || null,
    has_profile: Boolean(p.employee_id),
  };
}

function missingFields(employee: any, payment: any) {
  const missing: string[] = [];
  const type = typeLabel(employee?.employment_type);
  const country = text(employee?.country || employee?.nationality);

  if (employee?.official_id_pending || text(employee?.employee_no).startsWith("ONSITE-TEMP-")) missing.push("正式员工 ID");
  if (!text(employee?.full_name)) missing.push("姓名");
  if (!country) missing.push("国家 / 国籍");
  if (!type) missing.push("员工类型");
  if (!employee?.team_id) missing.push("团队");
  if (!employee?.position_id) missing.push("岗位");
  if (!text(employee?.shift_name)) missing.push("班次");
  if (!text(employee?.hire_date)) missing.push("入职日期");

  const pay = effectivePayment(employee, payment);

  // 只对真正需要发薪的员工做收款资料完整性判断。
  // 现场管理/排班补录，不在这里强制要求收款资料，避免误报。
  if (type.startsWith("纯居家") || type === "现场转居家") {
    if (!pay.has_profile) {
      missing.push("收款资料待匹配");
    } else if (pay.mode === "usdt") {
      if (!text(pay.usdt_address)) missing.push("USDT 地址");
    } else if (pay.mode === "bank_wallet") {
      if (!text(pay.bank_wallet_account)) missing.push("银行卡 / 钱包账号");
      if (!text(pay.account_name)) missing.push("收款姓名");
    }
  }

  return [...new Set(missing)];
}

async function permissionAllowed(service: any, access: any, userId: string, code: string) {
  const { data: role, error:roleError } = await service.from("roles").select("id,code").eq("id", access.role_id).maybeSingle();
  if(roleError) throw roleError;
  if (role?.code === "founder") return true;

  const { data: perm, error:permissionError } = await service.from("permissions").select("id").eq("code", code).maybeSingle();
  if(permissionError) throw permissionError;
  if (!perm?.id) return false;

  const { data: override, error:overrideError } = await service
    .from("user_permission_overrides")
    .select("allowed")
    .eq("auth_user_id", userId)
    .eq("permission_id", perm.id)
    .maybeSingle();
  if(overrideError) throw overrideError;

  if (override && typeof override.allowed === "boolean") return override.allowed;

  const { data: rolePerm, error:rolePermissionError } = await service
    .from("role_permissions")
    .select("role_id")
    .eq("role_id", access.role_id)
    .eq("permission_id", perm.id)
    .maybeSingle();
  if(rolePermissionError) throw rolePermissionError;

  return Boolean(rolePerm);
}

async function permissionAllowedFirstDefined(service: any, access: any, userId: string, codes: string[]) {
  const { data: role, error:roleError } = await service.from("roles").select("code").eq("id", access.role_id).maybeSingle();
  if(roleError) throw roleError;
  if (role?.code === "founder") return true;
  for (const code of codes) {
    const { data: perm, error: permissionError } = await service.from("permissions").select("id").eq("code", code).maybeSingle();
    if (permissionError) throw permissionError;
    if (!perm?.id) continue;
    const { data: override, error: overrideError } = await service.from("user_permission_overrides")
      .select("allowed").eq("auth_user_id", userId).eq("permission_id", perm.id).maybeSingle();
    if (overrideError) throw overrideError;
    if (override && typeof override.allowed === "boolean") return override.allowed;
    const { data: rolePerm, error: rolePermissionError } = await service.from("role_permissions")
      .select("role_id").eq("role_id", access.role_id).eq("permission_id", perm.id).maybeSingle();
    if (rolePermissionError) throw rolePermissionError;
    return Boolean(rolePerm);
  }
  return false;
}

type PermissionBatchDecision = { defined: boolean; allowed: boolean };

// Employee detail needs several independent capability flags. Resolving each
// flag separately used to repeat the same role, permission and override reads
// dozens of times for a single drawer open. Keep the exact override/role
// precedence, but resolve every requested code in three bounded queries.
async function permissionDecisionBatch(service:any,caller:any,codes:string[]) {
  const uniqueCodes=[...new Set(codes.map(text).filter(Boolean))];
  const decisions=new Map<string,PermissionBatchDecision>();
  if(caller.roleCode==="founder"){
    uniqueCodes.forEach(code=>decisions.set(code,{defined:true,allowed:true}));
    return decisions;
  }

  const {data:permissions,error:permissionError}=await service.from("permissions")
    .select("id,code").in("code",uniqueCodes);
  if(permissionError) throw permissionError;
  const permissionByCode=new Map((permissions||[]).map((row:any)=>[text(row.code),row]));
  const permissionIds=(permissions||[]).map((row:any)=>text(row.id)).filter(Boolean);
  if(!permissionIds.length){
    uniqueCodes.forEach(code=>decisions.set(code,{defined:false,allowed:false}));
    return decisions;
  }

  const [overrideResult,rolePermissionResult]=await Promise.all([
    service.from("user_permission_overrides").select("permission_id,allowed")
      .eq("auth_user_id",caller.userId).in("permission_id",permissionIds),
    service.from("role_permissions").select("permission_id")
      .eq("role_id",caller.access.role_id).in("permission_id",permissionIds),
  ]);
  if(overrideResult.error) throw overrideResult.error;
  if(rolePermissionResult.error) throw rolePermissionResult.error;
  const overrides=new Map((overrideResult.data||[]).map((row:any)=>[text(row.permission_id),Boolean(row.allowed)]));
  const rolePermissionIds=new Set((rolePermissionResult.data||[]).map((row:any)=>text(row.permission_id)));

  uniqueCodes.forEach(code=>{
    const permission:any=permissionByCode.get(code);
    if(!permission?.id){
      decisions.set(code,{defined:false,allowed:false});
      return;
    }
    const permissionId=text(permission.id);
    decisions.set(code,{
      defined:true,
      allowed:overrides.has(permissionId) ? Boolean(overrides.get(permissionId)) : rolePermissionIds.has(permissionId),
    });
  });
  return decisions;
}

function permissionAllowedFromBatch(decisions:Map<string,PermissionBatchDecision>,code:string){
  return Boolean(decisions.get(code)?.allowed);
}

function permissionAllowedFirstDefinedFromBatch(decisions:Map<string,PermissionBatchDecision>,codes:string[]){
  for(const code of codes){
    const decision=decisions.get(code);
    if(decision?.defined) return decision.allowed;
  }
  return false;
}

async function getCaller(req: Request, service: any) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401,"not_authenticated","未登录。");

  const { data: userData, error: userError } = await service.auth.getUser(token);
  if(userError){
    if(isRetryableBackendFailure(userError)) throw userError;
    throw new HttpError(401,"not_authenticated","登录状态无效，请重新登录。");
  }
  if(!userData?.user) throw new HttpError(401,"not_authenticated","登录状态无效，请重新登录。");

  const userId = userData.user.id;
  await requireCurrentAdminSession(service,userId,token);
  const { data: access, error } = await service
    .from("user_access")
    .select("auth_user_id,employee_id,role_id,data_scope,active,backend_enabled,login_username")
    .eq("auth_user_id", userId)
    .maybeSingle();

  if(error) throw error;
  if(!access?.active || !access?.backend_enabled) throw new HttpError(403,"backend_access_denied","无后台访问权限。");

  const { data: role, error:roleError } = await service.from("roles").select("code").eq("id", access.role_id).maybeSingle();
  if(roleError) throw roleError;
  return { userId, access, roleCode: role?.code || "", loginUsername:text(access?.login_username) };
}

async function scopeInfo(service: any, caller: any) {
  const allMode=caller.roleCode === "founder" || caller.access.data_scope === "all";
  const [{data:directory,error:directoryError},effective]=await Promise.all([
    service.rpc("admin_scope_current_employee_directory"),
    allMode
      ? Promise.resolve({mode:"all",employeeIds:[]})
      : loadEffectiveEmployeeScope(service,caller.userId,caller.access,caller.roleCode),
  ]);
  if(directoryError) throw directoryError;
  const currentRows=Array.isArray(directory?.employees)?directory.employees:[];
  const employeeIds=allMode?[]:effective.employeeIds.map(text).filter(Boolean);
  const allowed=allMode?null:new Set(employeeIds);
  const visibleCurrentRows=allowed
    ? currentRows.filter((row:any)=>allowed.has(text(row.employee_id)))
    : currentRows;
  const teamIds=[...new Set(visibleCurrentRows.map((row:any)=>text(row.team_id)).filter(Boolean))];
  const positionIds=[...new Set(visibleCurrentRows.map((row:any)=>text(row.position_id)).filter(Boolean))];
  const [teamResult,positionResult]=await Promise.all([
    teamIds.length
      ? service.from("teams").select("id,name,country,status").in("id",teamIds)
      : Promise.resolve({data:[],error:null}),
    positionIds.length
      ? service.from("positions").select("id,name,code,status").in("id",positionIds)
      : Promise.resolve({data:[],error:null}),
  ]);
  if(teamResult.error) throw teamResult.error;
  if(positionResult.error) throw positionResult.error;
  const teamById=new Map((teamResult.data||[]).map((row:any)=>[text(row.id),row]));
  const positionById=new Map((positionResult.data||[]).map((row:any)=>[text(row.id),row]));
  const currentOrganizationByEmployeeId=new Map(visibleCurrentRows.map((row:any)=>[
    text(row.employee_id),
    {
      teamId:text(row.team_id),
      positionId:text(row.position_id),
      onlineTrainer:text(row.online_trainer),
    },
  ]));
  return {
    mode:allMode?"all":caller.access.data_scope==="self"?"self":"limited",
    teamIds,
    positionIds,
    employeeIds,
    employeeIdSet:allowed,
    currentOrganizationByEmployeeId,
    teamById,
    positionById,
  };
}

function overlayCurrentOrganization(employee:any,scope:any){
  if(!employee?.id) return employee;
  const organization=scope.currentOrganizationByEmployeeId?.get(text(employee.id));
  if(organization){
    // Current roster is authoritative for the online-training teacher too.
    // Copy the same value into the legacy trainer_name compatibility field so
    // older UI fallbacks cannot resurrect a stale teacher when roster is blank.
    const onlineTrainer=organization.onlineTrainer||null;
    return {
      ...employee,
      team_id:organization.teamId||null,
      position_id:organization.positionId||null,
      teams:scope.teamById?.get(organization.teamId)||null,
      positions:scope.positionById?.get(organization.positionId)||null,
      online_trainer:onlineTrainer,
      trainer_name:onlineTrainer,
      organization_source:"current_roster",
    };
  }
  // An active row missing from the strict current roster must not present its
  // historical employee master organization as if it were current. Inactive
  // archive rows retain their last-known organization for history screens.
  if(employee.status==="active"){
    return {
      ...employee,
      team_id:null,
      position_id:null,
      teams:null,
      positions:null,
      online_trainer:null,
      trainer_name:null,
      organization_source:"current_roster_unmatched",
    };
  }
  // An archive row has no current roster teacher. Keep its last organization
  // for historical context, but never present a historical trainer as current.
  return {
    ...employee,
    online_trainer:null,
    trainer_name:null,
    organization_source:"archive",
  };
}

function currentRosterEmployeeIdsForOrganizationFilters(
  scope:any,teamName:string,positionName:string,teacherName:string,
){
  const wantedTeam=text(teamName).toLowerCase();
  const wantedPosition=text(positionName).toLowerCase();
  const wantedTeacher=text(teacherName).toLowerCase();
  if(!wantedTeam&&!wantedPosition&&!wantedTeacher) return null;
  const ids:string[]=[];
  for(const [employeeId,organization] of scope.currentOrganizationByEmployeeId||[]){
    const team=text(scope.teamById?.get(organization.teamId)?.name).toLowerCase();
    const position=text(scope.positionById?.get(organization.positionId)?.name).toLowerCase();
    const teacher=text(organization.onlineTrainer).toLowerCase();
    if(wantedTeam&&team!==wantedTeam) continue;
    if(wantedPosition&&position!==wantedPosition) continue;
    if(wantedTeacher&&!teacher.includes(wantedTeacher)) continue;
    ids.push(employeeId);
  }
  return ids;
}

function applyScope(query: any, scope: any) {
  if (scope.mode === "all") return query;
  return scope.employeeIds.length
    ? query.in("id",scope.employeeIds)
    : query.eq("id", "00000000-0000-0000-0000-000000000000");
}

async function requireEmployeeInScope(service:any,scope:any,employeeId:string){
  if(!employeeId) throw new Error("缺少 employee_id");
  let query=service.from("employees").select("id").eq("id",employeeId);
  query=applyScope(query,scope);
  const {data,error}=await query.maybeSingle();
  if(error) throw error;
  if(!data?.id) throw new Error("找不到员工或无操作权限");
}

async function countScoped(service: any, scope: any, mutate?: (q:any)=>any) {
  let q = service.from("employees").select("id", { count:"exact", head:true });
  q = applyScope(q, scope);
  if (mutate) q = mutate(q);
  const { count,error } = await q;
  if(error) throw error;
  return count || 0;
}


function nullable(v: unknown) {
  const s = text(v);
  return s ? s : null;
}

function numberOrNull(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function requirePermission(service: any, caller: any, code: string) {
  if (caller.roleCode === "founder") return true;
  const allowed = await permissionAllowed(service, caller.access, caller.userId, code);
  if (!allowed) throw new HttpError(403,"permission_denied","没有执行此操作的权限。");
  return true;
}
async function requireAnyPermission(service: any, caller: any, codes: string[]) {
  if (caller.roleCode === "founder") return true;
  for (const code of codes) {
    if (await permissionAllowed(service, caller.access, caller.userId, code)) return true;
  }
  throw new HttpError(403,"permission_denied","没有执行此操作的权限。");
}
async function permissionAllowedAny(service:any,access:any,userId:string,codes:string[]){
  for(const code of codes) if(await permissionAllowed(service,access,userId,code)) return true;
  return false;
}

type PlatformRef = { platform:string; country:string; series:string };

function normPlatform(v: unknown) {
  return text(v).replace(/\s+/g,"").toUpperCase();
}

async function fetchPlatformMapFromSchedule(): Promise<PlatformRef[]> {
  const url=Deno.env.get("GOOGLE_STAFF_SYNC_URL")||"";
  const secret=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!url||!secret) return [];
  try{
    const resp=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"get_platform_map",secret}),signal:AbortSignal.timeout(2500)});
    if(!resp.ok) return [];
    const body=await resp.json().catch(()=>({}));
    return Array.isArray(body?.rows)?body.rows:[];
  }catch{return [];}
}

function findPlatformRef(rows: PlatformRef[], raw: unknown): PlatformRef | null {
  const key = normPlatform(raw);
  if (!key) return null;
  return rows.find(x => normPlatform(x.platform) === key) || null;
}
function scheduleMap(snapshot:any){return new Map((Array.isArray(snapshot?.assignments)?snapshot.assignments:[]).map((x:any)=>[text(x.employee_no).toUpperCase(),x]).filter((x:any)=>x[0]));}
function scheduleMatches(a:any,f:any){if(text(f.team)&&text(a?.team)!==text(f.team))return false;if(text(f.position)&&text(a?.position)!==text(f.position))return false;if(text(f.shift_name)&&text(a?.shift)!==text(f.shift_name))return false;if(text(f.leader)&&text(a?.leader)!==text(f.leader))return false;return true;}

async function findOrCreateTeamBySeries(service:any, series:unknown) {
  const name=text(series);
  if(!name) return null;
  const {data:found,error:findError}=await service
    .from("teams").select("id").ilike("name",name).limit(1).maybeSingle();
  if(findError) throw findError;
  if(found?.id) return found.id;
  const {data:created,error}=await service
    .from("teams").insert({name,status:"active"}).select("id").single();
  if(error) throw error;
  return created.id;
}

async function removeEmployeeFromSheet(employeeNo:string,fullName:string){const url=Deno.env.get("GOOGLE_STAFF_SYNC_URL")||"",secret=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";if(!url||!secret)return {skipped:true};try{const resp=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"remove_employee",secret,employee_no:employeeNo,full_name:fullName})});const body=await resp.json().catch(()=>({}));return {ok:resp.ok,...body};}catch(e){return {ok:false,error:String(e)}}}

async function sendSheetSync(payload: any) {
  const url = Deno.env.get("GOOGLE_STAFF_SYNC_URL") || "";
  const secret = Deno.env.get("STAFF_SHEET_SYNC_SECRET") || "";
  if (!url || !secret) return { ok:false, skipped:true, reason:"not_configured" };
  try {
    const resp = await fetch(url, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ ...payload, secret }),
    });
    const body = await resp.json().catch(()=>({}));
    return { ok:resp.ok, status:resp.status, body };
  } catch (e) {
    return { ok:false, error:e instanceof Error ? e.message : String(e) };
  }
}

async function getEmployeeBundle(service: any, employeeId: string) {
  const [{ data:employee }, { data:contact }, { data:payment }, { data:compensation }] = await Promise.all([
    service.from("employees").select(`
      *,
      teams:team_id(id,name,country,status),
      positions:position_id(id,name,code,status)
    `).eq("id",employeeId).maybeSingle(),
    service.from("employee_contact_profiles").select("*").eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_payment_profiles").select("*").eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_compensation_settings").select("*").eq("employee_id",employeeId).maybeSingle(),
  ]);
  return { employee, contact, payment, compensation };
}

async function saveProfiles(service: any, caller: any, employee: any, payload: any) {
  const contact = payload.contact || {};
  const compensation = payload.compensation || {};
  const payment = payload.payment || {};

  if (Object.keys(contact).length) {
    await service.from("employee_contact_profiles").upsert({
      employee_id:employee.id,
      work_email:nullable(contact.work_email),
      telegram_username:nullable(contact.telegram_username),
      zoom_email:nullable(contact.zoom_email),
      facebook:nullable(contact.facebook),
      whatsapp_phone:nullable(contact.whatsapp_phone),
      source_sheet:"WFH后台",
      updated_at:new Date().toISOString(),
    }, { onConflict:"employee_id" });
  }

  const hasComp = ["base_salary","daily_rate","performance_default","meal_allowance","note"]
    .some(k => text(compensation[k]));
  if (hasComp) {
    await requirePermission(service, caller, "employee.compensation.edit");

    const employeeType=typeLabel(employee.employment_type);
    const phpHome=employeeType==="纯居家菲律宾";
    const onsiteToHome=employeeType==="现场转居家";

    const phpMonthly = phpHome ? numberOrNull(compensation.base_salary) : null;
    const phpDaily = phpHome ? numberOrNull(compensation.daily_rate) : null;
    if (phpHome && phpMonthly && phpDaily) {
      throw new Error("纯居家菲律宾工资只能选择月薪制或日薪制，不能同时填写");
    }

    await service.from("employee_compensation_settings").upsert({
      employee_id:employee.id,
      base_salary:phpHome ? phpMonthly : numberOrNull(compensation.base_salary),
      daily_rate:phpHome ? phpDaily : null,
      performance_default:phpHome ? null : numberOrNull(compensation.performance_default),
      meal_allowance:onsiteToHome ? numberOrNull(compensation.meal_allowance) : null,
      currency:phpHome ? "PHP" : "USD",
      effective_from:employee.hire_date || null,
      note:nullable(compensation.note),
      updated_by:caller.userId,
      updated_at:new Date().toISOString(),
    }, { onConflict:"employee_id" });
  }

  const hasPayment = ["mode","transfer_using","bank_wallet_account","account_name","usdt_address","contact_phone","whatsapp_number","employee_address"]
    .some(k => text(payment[k]) && text(payment[k]) !== "unknown");
  if (hasPayment) {
    const canEdit = caller.roleCode === "founder" ||
      await permissionAllowed(service, caller.access, caller.userId, "sensitive.payment.edit");
    if (!canEdit) throw new Error("没有修改敏感收款资料的权限");

    const mode = nullable(payment.mode);
    const row:any = {
      employee_id:employee.id,
      payment_mode:mode,
      payment_mode_source:"WFH后台",
      transfer_using:nullable(payment.transfer_using),
      gcash_account:mode === "bank_wallet" ? nullable(payment.bank_wallet_account) : null,
      gcash_name:mode === "bank_wallet" ? nullable(payment.account_name) : null,
      usdt_address:mode === "usdt" ? nullable(payment.usdt_address) : null,
      contact_phone:nullable(payment.contact_phone),
      whatsapp_number:nullable(payment.whatsapp_number),
      employee_address:nullable(payment.employee_address),
      source_sheet:"WFH后台",
      updated_at:new Date().toISOString(),
    };
    await service.from("employee_payment_profiles").upsert(row, { onConflict:"employee_id" });
  }
}

function sheetPayload(bundle: any, action: string, extra: any = {}) {
  const e = bundle.employee || {};
  return {
    action:"upsert_employee",
    change_action:action,
    employee:{
      employee_no:e.employee_no,
      full_name:e.full_name,
      country:e.country,
      nationality:e.nationality,
      employment_type:e.employment_type,
      status:e.status,
      market_country:e.market_country,
      market_position:e.market_position,
      position:e.positions?.name || null,
      shift_name:e.shift_name,
      hire_date:e.hire_date,
      resign_date:e.resign_date,
      work_tg:e.work_tg,
      backend_accounts:e.backend_accounts,
      last_location:e.last_location,
      return_date:e.return_date,
      home_date:e.home_date,
      platform_scope:e.platform_scope,
    },
    contact:bundle.contact || {},
    compensation:bundle.compensation || {},
    payment:bundle.payment || {},
    resign_reason:Object.prototype.hasOwnProperty.call(extra,'resign_reason') ? extra.resign_reason : null,
  };
}


async function collectEmployeeOptions(service:any, scope:any, includeInactive=false) {
  const keys = [
    "country","nationality","employment_type","shift_name","group_name",
    "leader_name","trainer_name","market_country","market_position","platform_scope",
    "person_in_charge","on_site_trainer","online_leader","online_trainer"
  ];

  const sets:Record<string,Set<string>> = {};
  keys.forEach(k => sets[k]=new Set<string>());
  sets.teams=new Set<string>();
  sets.positions=new Set<string>();

  let offset=0;
  const batch=1000;

  while(true){
    // Filter controls are a live projection of the current employee archive,
    // not a dump of historical dimension/master rows.  In particular this
    // keeps retired combined teams/countries out of the controls as soon as no
    // active employee references them, while the top-level teams/positions
    // payload remains available to the create/edit forms.
    let q=service.from("employees").select([
      "id","status",
      ...keys,
      "teams:team_id(id,name)",
      "positions:position_id(id,name)",
    ].join(","))
      .or("source_type.is.null,source_type.neq.google_deleted");
    if(!includeInactive) q=q.eq("status","active");
    q=applyScope(q,scope);
    const {data,error}=await q.range(offset,offset+batch-1);
    if(error) throw error;

    const rows=data||[];
    rows.map((r:any)=>overlayCurrentOrganization(r,scope)).forEach((r:any)=>{
      keys.forEach(k=>{
        const v=text(r[k]);
        if(v) sets[k].add(v);
      });
      const team=text(r.teams?.name);
      const position=text(r.positions?.name);
      if(team) sets.teams.add(team);
      if(position) sets.positions.add(position);
    });

    if(rows.length<batch) break;
    offset+=batch;
    if(offset>10000) break;
  }

  const sorted=(s:Set<string>)=>Array.from(s).sort((a,b)=>a.localeCompare(b,"zh-CN"));

  return {
    teams:sorted(sets.teams),
    positions:sorted(sets.positions),
    countries:sorted(sets.country),
    nationalities:sorted(sets.nationality),
    employment_types:sorted(sets.employment_type),
    shifts:sorted(sets.shift_name),
    groups:sorted(sets.group_name),
    leaders:sorted(new Set([
      ...sets.leader_name,
      ...sets.person_in_charge,
      ...sets.online_leader,
    ])),
    trainers:sorted(sets.online_trainer),
    market_countries:sorted(sets.market_country),
    market_positions:sorted(sets.market_position),
    platforms:sorted(sets.platform_scope),
  };
}

function isoDateLocal(v:any){const s=text(v);return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:new Date().toISOString().slice(0,10);}
function addDaysIso(date:string,days:number){const d=new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);}
function monthStartIso(date:string){return `${date.slice(0,7)}-01`;}
function previousMonthSamePeriod(date:string){const d=new Date(`${date}T12:00:00Z`);const day=d.getUTCDate();const y=d.getUTCFullYear(),m=d.getUTCMonth();const prev=new Date(Date.UTC(y,m-1,1,12));const py=prev.getUTCFullYear(),pm=prev.getUTCMonth();const daysInPrev=new Date(Date.UTC(py,pm+1,0,12)).getUTCDate();const endDay=Math.min(day,daysInPrev);const start=`${py}-${String(pm+1).padStart(2,"0")}-01`;const end=`${py}-${String(pm+1).padStart(2,"0")}-${String(endDay).padStart(2,"0")}`;return {start,end};}
function ratioPercent(n:number,d:number){return d>0?Number(((n/d)*100).toFixed(2)):0;}
function deltaPct(current:number,previous:number){if(previous===0)return current===0?0:100;return Number((((current-previous)/previous)*100).toFixed(1));}
function eventSnapshotValue(snapshot:any,keys:string[]){for(const k of keys){const v=text(snapshot?.[k]);if(v)return v;}return "";}
async function fetchAllScopedEmployees(service:any,scope:any){const all:any[]=[];let offset=0;const batch=1000;while(true){let q=service.from("employees").select(`id,employee_no,full_name,status,country,nationality,employment_type,team_id,position_id,shift_name,leader_name,trainer_name,online_trainer,work_tg,backend_accounts,hire_date,resign_date,teams:team_id(id,name),positions:position_id(id,name)`);q=applyScope(q,scope);const {data,error}=await q.range(offset,offset+batch-1);if(error)throw error;const rows=(data||[]).map((row:any)=>overlayCurrentOrganization(row,scope));all.push(...rows);if(rows.length<batch)break;offset+=batch;if(offset>10000)break;}return all;}
async function fetchLifecycleEvents(service:any,scope:any,employees:any[],kind:"recent"|"resign",startDate=""){
  const columns="employee_id,employee_no,event_type,effective_date,snapshot,reason,created_at,note";
  const fetchPages=async(ids:string[]|null)=>{
    const rows:any[]=[];
    for(let offset=0;offset<=20000;offset+=1000){
      let query=service.from("employee_lifecycle_events").select(columns)
        .or("note.is.null,note.neq.__VOIDED__")
        .order("effective_date",{ascending:true}).order("created_at",{ascending:true});
      query=kind==="resign"?query.eq("event_type","resign"):query.in("event_type",["join","resign"]).gte("effective_date",startDate);
      if(ids) query=query.in("employee_id",ids);
      const {data,error}=await query.range(offset,offset+999);
      if(error) throw error;
      rows.push(...(data||[]));
      if((data||[]).length<1000) break;
    }
    return rows;
  };
  if(scope.mode==="all") return await fetchPages(null);
  const ids=employees.map((employee:any)=>text(employee.id)).filter(Boolean);
  if(!ids.length) return [];
  const rows:any[]=[];
  for(let index=0;index<ids.length;index+=300) rows.push(...await fetchPages(ids.slice(index,index+300)));
  return rows;
}
async function fetchRecentLifecycleEvents(service:any,scope:any,employees:any[],startDate:string){return await fetchLifecycleEvents(service,scope,employees,"recent",startDate);}
async function fetchAllResignEvents(service:any,scope:any,employees:any[]){return await fetchLifecycleEvents(service,scope,employees,"resign");}
function increment(map:Map<string,number>,name:any,amount=1){const key=text(name)||"未分类";map.set(key,(map.get(key)||0)+amount);}
function sortedBreakdown(map:Map<string,number>,denominator:number){return Array.from(map.entries()).map(([name,count])=>({name,count,share:ratioPercent(count,denominator)})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));}
function eventDims(ev:any,byId:Map<string,any>,byNo:Map<string,any>,teamById:Map<string,string>,positionById:Map<string,string>){const emp=(ev.employee_id&&byId.get(ev.employee_id))||byNo.get(text(ev.employee_no).toUpperCase())||null;const snap=ev.snapshot||{};const team=eventSnapshotValue(snap,["team","team_name","团队","盘口国家","market_country","series"])||teamById.get(text(snap.team_id))||text(emp?.teams?.name)||"未分类";const position=eventSnapshotValue(snap,["position","position_name","岗位"])||positionById.get(text(snap.position_id))||text(emp?.positions?.name)||"未分类";const country=eventSnapshotValue(snap,["country","员工国家","国家 country","国家","nationality"])||text(emp?.country||emp?.nationality)||"未分类";const shift=eventSnapshotValue(snap,["shift_name","班次","shift"])||text(emp?.shift_name)||"未分类";return {team,position,country,shift};}
function inDateRange(date:any,start:string,end:string){const d=text(date);return Boolean(d&&d>=start&&d<=end);}
function hireTenureBucket(hireDate:any,today:string){
  const h=text(hireDate).slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(h))return "unknown";
  if(h>today)return "prepare";
  const days=Math.floor((Date.parse(`${today}T12:00:00Z`)-Date.parse(`${h}T12:00:00Z`))/86400000);
  if(days<=7)return "within_7";
  if(days<=14)return "days_7_14";
  if(days<=30)return "days_15_30";
  if(days<=60)return "days_30_60";
  return "days_60_plus";
}

async function buildEmployeeMeta(service:any,caller:any,scope:any){
  let teamQuery=service.from("teams").select("id,name,country,status").order("name");
  if(scope.mode!=="all"){
    const visibleTeamIds=new Set<string>(scope.teamIds||[]);
    teamQuery=visibleTeamIds.size
      ? teamQuery.in("id",Array.from(visibleTeamIds))
      : teamQuery.eq("id","00000000-0000-0000-0000-000000000000");
  }
  let positionQuery=service.from("positions").select("id,name,code,status").order("name");
  if(scope.mode!=="all"){
    positionQuery=(scope.positionIds||[]).length
      ? positionQuery.in("id",scope.positionIds)
      : positionQuery.eq("id","00000000-0000-0000-0000-000000000000");
  }
  const permissionCodes=[
    "employee.create","employee.edit","user.activation.generate",
    "sensitive.employee.view","sensitive.employee.edit",
    "sensitive.payout.edit","sensitive.payment.edit","employee.compensation.edit",
  ];
  const [
    teamResult,positionResult,total,active,noTeam,officialPending,options,platformMap,permissionDecisions,
  ]=await Promise.all([
    teamQuery,positionQuery,countScoped(service,scope),
    countScoped(service,scope,q=>q.eq("status","active")),
    countScoped(service,scope,q=>q.eq("status","active").is("team_id",null)),
    countScoped(service,scope,q=>q.eq("status","active").eq("official_id_pending",true)),
    collectEmployeeOptions(service,scope),fetchPlatformMapFromSchedule(),
    permissionDecisionBatch(service,caller,permissionCodes),
  ]);
  if(teamResult.error) throw teamResult.error;
  if(positionResult.error) throw positionResult.error;
  const teams=teamResult.data||[];
  const positions=positionResult.data||[];
  const founder=caller.roleCode==="founder";
  const canCreate=(founder||permissionAllowedFromBatch(permissionDecisions,"employee.create"))&&scope.mode!=="self";
  const canEdit=(founder||permissionAllowedFromBatch(permissionDecisions,"employee.edit"))&&scope.mode!=="self";
  const canGenerateActivation=founder||permissionAllowedFromBatch(permissionDecisions,"user.activation.generate");
  const canViewEmployeeSensitive=founder||permissionAllowedFromBatch(permissionDecisions,"sensitive.employee.view");
  const canEditEmployeeSensitive=founder||permissionAllowedFromBatch(permissionDecisions,"sensitive.employee.edit");
  const canEditPayment=founder||permissionAllowedFirstDefinedFromBatch(
    permissionDecisions,["sensitive.payout.edit","sensitive.payment.edit"],
  );
  const canEditCompensation=founder||permissionAllowedFromBatch(permissionDecisions,"employee.compensation.edit");
  const visibleTeamNames=new Set(teams.map((row:any)=>text(row.name).toLowerCase()));
  const visiblePlatformMap=scope.mode==="all"
    ? (platformMap||[])
    : (platformMap||[]).filter((row:any)=>visibleTeamNames.has(text(row.series).toLowerCase()));
  return {
    total,active,no_team:noTeam,official_id_pending:officialPending,teams,positions,options,platform_map:visiblePlatformMap,
    permissions:{
      sensitive_employee_view:canViewEmployeeSensitive,
      sensitive_employee_edit:canEditEmployeeSensitive,
      sensitive_payment_edit:canEditPayment,
      compensation_edit:canEditCompensation,
    },
    actions:{
      can_create:canCreate,
      can_edit:canEdit,
      can_generate_activation_code:canGenerateActivation,
      can_create_sensitive_employee:canCreate&&canEditEmployeeSensitive,
      can_create_payment:canCreate&&canEditPayment,
      can_create_compensation:canCreate&&canEditCompensation,
    },
  };
}

const genericEmployeeOperator=(value:any)=>{
  const actor=text(value);
  return !actor||[
    "Google Sheet","Google Sheet（账号不可用）","Google Sheet（未登记操作人）",
    "后台账号","后台历史账号",
  ].includes(actor);
};

async function loadEmployeeOperatorAccounts(service:any,employees:any[]){
  const ids=employees.map((row:any)=>text(row.id)).filter(Boolean);
  const fallback=new Map<string,string>(employees.map((row:any)=>[
    text(row.id),
    text(row.source_type)==="backend"?"后台历史账号":"Google Sheet（未登记操作人）",
  ]));
  if(!ids.length)return fallback;
  const joinLimit=Math.min(Math.max(ids.length*4,20),2000);
  const auditLimit=Math.min(Math.max(ids.length*10,50),5000);

  let joinResult:any,auditResult:any;
  try{
    [joinResult,auditResult]=await Promise.all([
      service.from("employee_lifecycle_events")
        .select("employee_id,created_by,snapshot,source,source_sheet,created_at")
        .in("employee_id",ids).eq("event_type","join").order("created_at",{ascending:true}).limit(joinLimit),
      service.from("employee_audit_logs")
        .select("employee_id,actor_username,action,created_at")
        .in("employee_id",ids).order("created_at",{ascending:false}).limit(auditLimit),
    ]);
  }catch(error){
    console.error(JSON.stringify({function:"admin-employees",event:"operator_enrichment_skipped",code:errorCode(error)||"fetch_failed"}));
    return fallback;
  }
  if(joinResult.error||auditResult.error){
    const enrichmentError=joinResult.error||auditResult.error;
    console.error(JSON.stringify({function:"admin-employees",event:"operator_enrichment_skipped",code:errorCode(enrichmentError)||"query_failed"}));
    return fallback;
  }

  const joins=joinResult.data||[],audits=auditResult.data||[];
  const creatorIds=Array.from(new Set(joins.map((row:any)=>text(row.created_by)).filter(Boolean)));
  let userMap=new Map<string,string>();
  if(creatorIds.length){
    try{
      const {data,error}=await service.from("user_access")
        .select("auth_user_id,login_username").in("auth_user_id",creatorIds.slice(0,500));
      if(error){
        console.error(JSON.stringify({function:"admin-employees",event:"operator_actor_lookup_skipped",code:errorCode(error)||"query_failed"}));
      }else{
        userMap=new Map((data||[]).map((row:any)=>[text(row.auth_user_id),text(row.login_username)]));
      }
    }catch(error){
      console.error(JSON.stringify({function:"admin-employees",event:"operator_actor_lookup_skipped",code:errorCode(error)||"fetch_failed"}));
    }
  }

  const joinMap=new Map<string,any[]>(),auditMap=new Map<string,any[]>();
  for(const row of joins){const id=text(row.employee_id);if(!joinMap.has(id))joinMap.set(id,[]);joinMap.get(id)!.push(row);}
  for(const row of audits){const id=text(row.employee_id);if(!auditMap.has(id))auditMap.set(id,[]);auditMap.get(id)!.push(row);}

  const result=new Map<string,string>(fallback);
  for(const employee of employees){
    const id=text(employee.id),employeeJoins=joinMap.get(id)||[],employeeAudits=auditMap.get(id)||[];
    let actor="";
    const createAudit=employeeAudits.find((row:any)=>
      ["employee_create","google_employee_create"].includes(text(row.action))&&!genericEmployeeOperator(row.actor_username)
    );
    if(createAudit)actor=text(createAudit.actor_username);
    if(!actor){
      const backendJoin=employeeJoins.find((row:any)=>text(row.created_by)&&text(userMap.get(text(row.created_by))));
      if(backendJoin)actor=text(userMap.get(text(backendJoin.created_by)));
    }
    if(!actor){
      for(const row of employeeJoins){
        const snapshot=row?.snapshot||{};
        const candidate=text(snapshot.operator_account)||text(snapshot.operator_email)||text(snapshot.last_edited_username);
        if(!genericEmployeeOperator(candidate)){actor=candidate;break;}
      }
    }
    if(!actor){
      const recentAudit=employeeAudits.find((row:any)=>!genericEmployeeOperator(row.actor_username));
      if(recentAudit)actor=text(recentAudit.actor_username);
    }
    if(!actor)actor=text(employee.source_type)==="backend"?"后台历史账号":"Google Sheet（未登记操作人）";
    result.set(id,actor);
  }
  return result;
}

async function buildEmployeeList(service:any,caller:any,scope:any,body:any){
  const canViewEmployeeSensitive=caller.roleCode==="founder"
    || await permissionAllowed(service,caller.access,caller.userId,"sensitive.employee.view");
  const page=Math.max(1,Number(body.page||1));
  const allowed=[20,30,50,100,500];
  const requested=Number(body.page_size||20);
  const pageSize=allowed.includes(requested)?requested:20;
  const from=(page-1)*pageSize;
  const to=from+pageSize-1;
  const f=body.filters||{};
  const organizationEmployeeIds=currentRosterEmployeeIdsForOrganizationFilters(
    scope,text(f.team),text(f.position),text(f.teacher || f.leader),
  );
  if(organizationEmployeeIds&&organizationEmployeeIds.length===0){
    return {rows:[],total:0,page,page_size:pageSize,pages:1};
  }

  let q=service.from("employees").select(`
    id,employee_no,full_name,country,nationality,employment_type,status,
    team_id,position_id,shift_name,group_name,platform_scope,work_content,
    work_tg,backend_accounts,hire_date,resign_date,leader_name,trainer_name,online_trainer,
    profile_status,official_id_pending,source_type,source_sheet,created_at,
    teams:team_id(id,name,country,status),
    positions:position_id(id,name,code,status)
  `,{count:"exact"});

  q=organizationEmployeeIds?q.in("id",organizationEmployeeIds):applyScope(q,scope);
  if(text(f.employee_no)) q=q.ilike("employee_no",`%${text(f.employee_no)}%`);
  if(text(f.full_name)) q=q.ilike("full_name",`%${text(f.full_name)}%`);
  if(canViewEmployeeSensitive&&text(f.work_tg)) q=q.ilike("work_tg",`%${text(f.work_tg)}%`);
  if(canViewEmployeeSensitive&&text(f.backend_account)) q=q.ilike("backend_accounts",`%${text(f.backend_account)}%`);
  const keyword=text(f.keyword);
  if(keyword){
    const k=keyword.replace(/[%_,()]/g," ");
    const keywordFields=[
      `employee_no.ilike.%${k}%`,`full_name.ilike.%${k}%`,
      `leader_name.ilike.%${k}%`,`platform_scope.ilike.%${k}%`,
    ];
    if(canViewEmployeeSensitive) keywordFields.push(`work_tg.ilike.%${k}%`,`backend_accounts.ilike.%${k}%`);
    q=q.or(keywordFields.join(","));
  }
  if(text(f.country)) q=q.ilike("country",`%${text(f.country)}%`);
  if(text(f.status)) q=q.eq("status",f.status);
  if(text(f.employment_type)) q=q.ilike("employment_type",`%${text(f.employment_type)}%`);
  if(text(f.shift_name)) q=q.ilike("shift_name",`%${text(f.shift_name)}%`);
  if(text(f.profile_status)) q=q.eq("profile_status",f.profile_status);
  if(text(f.hire_from)) q=q.gte("hire_date",f.hire_from);
  if(text(f.hire_to)) q=q.lte("hire_date",f.hire_to);

  const {data:rawRows,count,error}=await q.order("employee_no").range(from,to);
  if(error) throw error;
  const rows=(rawRows||[]).map((row:any)=>overlayCurrentOrganization(row,scope));
  const ids=rows.map((row:any)=>row.id);
  const employeeNos=rows.map((row:any)=>employeeNoKey(row.employee_no)).filter(Boolean);
  const emptyRelated={data:[],error:null};
  const [
    {data:pays,error:paysError},
    {data:contacts,error:contactsError},
    {data:accountRows,error:accountRowsError},
    {data:errorSummaries,error:errorSummaryError},
    operatorMap,
  ]=ids.length?await Promise.all([
    service.from("employee_payment_profiles").select("*").in("employee_id",ids),
    service.from("employee_contact_profiles").select("employee_id,telegram_username").in("employee_id",ids),
    service.from("user_access").select("employee_id,employee_portal_enabled,active").in("employee_id",ids),
    employeeNos.length
      ? service.from("employee_error_summary").select("employee_no,month_error_count,total_error_count").in("employee_no",employeeNos)
      : Promise.resolve(emptyRelated),
    loadEmployeeOperatorAccounts(service,rows),
  ]):[emptyRelated,emptyRelated,emptyRelated,emptyRelated,new Map<string,string>()];
  if(paysError) throw paysError;
  if(contactsError) throw contactsError;
  if (accountRowsError) throw accountRowsError;
  if(errorSummaryError) throw errorSummaryError;

  const payMap=new Map((pays||[]).map((row:any)=>[row.employee_id,row]));
  const contactMap=new Map((contacts||[]).map((row:any)=>[row.employee_id,row]));
  const errorSummaryMap=new Map((errorSummaries||[]).map((row:any)=>[employeeNoKey(row.employee_no),row]));
  const portalAccountRows=(accountRows||[]).filter((row:any)=>row.employee_portal_enabled);
  const accountSet=new Set(portalAccountRows.map((row:any)=>row.employee_id));
  const activeAccountSet=new Set(portalAccountRows.filter((row:any)=>row.active===true).map((row:any)=>row.employee_id));
  const result=rows.map((row:any)=>{
    const merged={...row,telegram_username:contactMap.get(row.id)?.telegram_username};
    const missing=missingFields(merged,payMap.get(row.id));
    const summary=errorSummaryMap.get(employeeNoKey(row.employee_no));
    const monthErrorCount=Number(summary?.month_error_count||0);
    const totalErrorCount=Number(summary?.total_error_count||0);
    return {
      ...row,
      work_tg:canViewEmployeeSensitive?row.work_tg:(row.work_tg?"****":null),
      backend_accounts:canViewEmployeeSensitive?row.backend_accounts:(row.backend_accounts?"****":null),
      month_error_count:monthErrorCount,total_error_count:totalErrorCount,
      risk_level:employeeRiskKey(totalErrorCount),missing_fields:missing,missing_count:missing.length,
      account_opened:accountSet.has(row.id),account_active:activeAccountSet.has(row.id),
      operator_account:operatorMap.get(text(row.id))||"",
    };
  });
  return {rows:result,total:count||0,page,page_size:pageSize,pages:Math.max(1,Math.ceil((count||0)/pageSize))};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers:corsHeaders });
  if (req.method !== "POST") return json({ error:"Method not allowed" }, 405);

  let requestAction = "unknown";
  const requestId=crypto.randomUUID();
  const requestStartedAt=performance.now();
  let stageStartedAt=requestStartedAt;
  const stageMs:Record<string,number>={};
  const finishStage=(name:string)=>{
    const now=performance.now();
    stageMs[name]=Math.round((now-stageStartedAt)*10)/10;
    stageStartedAt=now;
  };
  const respond=(body:unknown,status=200,code=status<400?"ok":"request_failed",retryable=false)=>{
    finishStage("handler");
    const log={
      function:"admin-employees",event:"request_complete",request_id:requestId,
      action:requestAction,status,code,retryable,
      total_ms:Math.round((performance.now()-requestStartedAt)*10)/10,stages_ms:stageMs,
    };
    (status>=400?console.error:console.info)(JSON.stringify(log));
    return json(body,status);
  };
  try {
    let body:any;
    try{
      body=await req.json();
    }catch{
      requestAction="invalid";
      return respond({error:"请求格式无效。",code:"invalid_json",retryable:false,action:requestAction},400,"invalid_json",false);
    }
    finishStage("parse_body");
    const requestedAction=text(body?.action||"list");
    requestAction=/^[a-z_]{1,64}$/.test(requestedAction)?requestedAction:"invalid";

    const service = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth:{ persistSession:false } },
    );
    finishStage("create_client");

    const caller = await getCaller(req, service);
    finishStage("authenticate");
    const action=requestAction;
    if (action === "analytics" || action === "analytics_event_details") {
      await requirePermission(service, caller, "employee.analytics.view");
    } else if (action === "history_list") {
      await requirePermission(service, caller, "employee.resignations.view");
    } else if (action === "filter_options") {
      await requireAnyPermission(service, caller, [
        "employee.directory.view",
        "employee.analytics.view",
        "employee.resignations.view",
        "employee.change_history.view",
      ]);
    } else if (action === "resign_employee") {
      await requirePermission(service, caller, "employee.directory.resign");
    } else if (action === "update_resignation") {
      await requirePermission(service, caller, "employee.resignations.resign");
    } else if (action === "cancel_new_hire") {
      await requirePermission(service, caller, "employee.delete");
    } else if (["undo_resignation", "reactivate_employee"].includes(action)) {
      await requireAnyPermission(service, caller, [
        "employee.directory.reactivate",
        "employee.resignations.reactivate",
      ]);
    } else {
      await requirePermission(service, caller, "employee.directory.view");
    }
    if (body.export === true) await requirePermission(service,caller,"employee.directory.export");
    finishStage("authorize");

    // These retired mutations must not pay the scope-resolution cost merely to
    // return their fixed 410 response.
    if (action === "create_employee_full" || action === "update_employee_full") {
      return respond({ error:"此旧写入接口已停用，请通过员工档案的正式保存流程操作。" },410,"legacy_write_disabled",false);
    }

    const scope = await scopeInfo(service, caller);
    finishStage("scope");

    if(action==="meta") return respond(await buildEmployeeMeta(service,caller,scope));
    if(action==="bootstrap"){
      const [meta,list]=await Promise.all([
        buildEmployeeMeta(service,caller,scope),
        buildEmployeeList(service,caller,scope,body),
      ]);
      return respond({meta,list});
    }

    if (action === "filter_options") {
      const scopedEmployees=await fetchAllScopedEmployees(service,scope);
      const teamMap=new Map<string,string>();
      const positionMap=new Map<string,string>();
      for(const employee of scopedEmployees){
        if(employee.team_id&&text(employee.teams?.name)) teamMap.set(employee.team_id,text(employee.teams.name));
        if(employee.position_id&&text(employee.positions?.name)) positionMap.set(employee.position_id,text(employee.positions.name));
      }
      return respond({
        options:await collectEmployeeOptions(service, scope, body.include_inactive===true),
        teams:Array.from(teamMap,([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")),
        positions:Array.from(positionMap,([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")),
      });
    }

    if (action === "analytics") {
      await requirePermission(service,caller,"employee.analytics.view");
      const filter=body.filters||{};
      const canFilterSensitive=caller.roleCode==="founder"||await permissionAllowed(service,caller.access,caller.userId,"sensitive.employee.view");
      const today=isoDateLocal(body.today),yesterday=addDaysIso(today,-1),dayBeforeYesterday=addDaysIso(today,-2),start14=addDaysIso(today,-13),start30=addDaysIso(today,-29),start60=addDaysIso(today,-59),start7=addDaysIso(today,-6),prev7Start=addDaysIso(today,-13),prev7End=addDaysIso(today,-7);
      const monthStart=monthStartIso(today),prevMonth=previousMonthSamePeriod(today);
      const rawFrom=text(filter.date_from),rawTo=text(filter.date_to),periodActive=Boolean(rawFrom||rawTo);
      let periodFrom=rawFrom||rawTo||today,periodTo=rawTo||rawFrom||today;
      if(periodFrom>periodTo){const swap=periodFrom;periodFrom=periodTo;periodTo=swap;}
      const fetchStart=periodActive&&periodFrom<start60?periodFrom:start60;
      const trendEnd=periodActive?periodTo:today;
      const requestedTrendStart=periodActive?periodFrom:start14;
      const sixtyDayFloor=addDaysIso(trendEnd,-59);
      const trendStart=requestedTrendStart<sixtyDayFloor?sixtyDayFloor:requestedTrendStart;
      const periodDays=Math.max(1,Math.floor((Date.parse(`${periodTo}T12:00:00Z`)-Date.parse(`${periodFrom}T12:00:00Z`))/86400000)+1);
      const allEmployees=await fetchAllScopedEmployees(service,scope);
      const allById=new Map(allEmployees.map((x:any)=>[x.id,x])),allByNo=new Map(allEmployees.map((x:any)=>[text(x.employee_no).toUpperCase(),x]));
      const employeeMatches=(r:any)=>{
        if(!r)return false;
        if(text(filter.team)&&!text(r.teams?.name).toLowerCase().includes(text(filter.team).toLowerCase()))return false;
        if(text(filter.position)&&!text(r.positions?.name).toLowerCase().includes(text(filter.position).toLowerCase()))return false;
        if(text(filter.country)&&!text(r.country||r.nationality).toLowerCase().includes(text(filter.country).toLowerCase()))return false;
        if(text(filter.shift_name)&&!text(r.shift_name).toLowerCase().includes(text(filter.shift_name).toLowerCase()))return false;
        if(text(filter.employee_no)&&!text(r.employee_no).toLowerCase().includes(text(filter.employee_no).toLowerCase()))return false;
        if(text(filter.full_name)&&!text(r.full_name).toLowerCase().includes(text(filter.full_name).toLowerCase()))return false;
        if(canFilterSensitive&&text(filter.work_tg)&&!text(r.work_tg).toLowerCase().includes(text(filter.work_tg).toLowerCase()))return false;
        const keyword=text(filter.keyword).toLowerCase();
        if(keyword){
          const hay=[r.employee_no,r.full_name,...(canFilterSensitive?[r.work_tg,r.backend_accounts]:[]),r.teams?.name,r.positions?.name,r.country,r.nationality,r.shift_name].map(text).join(" ").toLowerCase();
          if(!hay.includes(keyword))return false;
        }
        return true;
      };
      const employees=allEmployees.filter(employeeMatches),activeRows=employees.filter((x:any)=>x.status==="active");
      const [rawEvents,rawAllResigns]=await Promise.all([
        fetchRecentLifecycleEvents(service,scope,allEmployees,fetchStart),
        fetchAllResignEvents(service,scope,allEmployees),
      ]);
      const [{data:teamRows},{data:positionRows}]=await Promise.all([service.from("teams").select("id,name"),service.from("positions").select("id,name")]);
      const teamById=new Map((teamRows||[]).map((x:any)=>[text(x.id),text(x.name)])),positionById=new Map((positionRows||[]).map((x:any)=>[text(x.id),text(x.name)]));
      const eventMatches=(ev:any,dims:any)=>{
        const emp=(ev.employee_id&&allById.get(ev.employee_id))||allByNo.get(text(ev.employee_no).toUpperCase())||null;
        if(scope.mode!=="all"&&!emp)return false;
        if(text(filter.team)&&!text(dims.team).toLowerCase().includes(text(filter.team).toLowerCase()))return false;
        if(text(filter.position)&&!text(dims.position).toLowerCase().includes(text(filter.position).toLowerCase()))return false;
        if(text(filter.country)&&!text(dims.country).toLowerCase().includes(text(filter.country).toLowerCase()))return false;
        if(text(filter.shift_name)&&!text(dims.shift).toLowerCase().includes(text(filter.shift_name).toLowerCase()))return false;
        if(text(filter.employee_no)&&!text(emp?.employee_no||ev.employee_no).toLowerCase().includes(text(filter.employee_no).toLowerCase()))return false;
        if(text(filter.full_name)&&!text(emp?.full_name||ev.full_name||ev.snapshot?.full_name||ev.snapshot?.name).toLowerCase().includes(text(filter.full_name).toLowerCase()))return false;
        if(canFilterSensitive&&text(filter.work_tg)&&!text(emp?.work_tg||ev.snapshot?.work_tg).toLowerCase().includes(text(filter.work_tg).toLowerCase()))return false;
        if(text(filter.reason)){
          if(text(ev.event_type)!=="resign")return false;
          if(!text(ev.reason).toLowerCase().includes(text(filter.reason).toLowerCase()))return false;
        }
        const keyword=text(filter.keyword).toLowerCase();
        if(keyword){
          const snap=ev.snapshot||{};
          const hay=[ev.employee_no,ev.full_name,emp?.employee_no,emp?.full_name,...(canFilterSensitive?[emp?.work_tg,emp?.backend_accounts,snap.work_tg,snap.backend_accounts]:[]),dims.team,dims.position,dims.country,dims.shift].map(text).join(" ").toLowerCase();
          if(!hay.includes(keyword))return false;
        }
        return true;
      };
      const dayMap=new Map<string,{join:number,resign:number}>();for(let d=trendStart;d<=trendEnd;d=addDaysIso(d,1))dayMap.set(d,{join:0,resign:0});
      const eventMetrics:any[]=[];
      for(const ev of rawEvents){
        const date=text(ev.effective_date),type=text(ev.event_type),dims=eventDims(ev,allById,allByNo,teamById,positionById);
        if(!eventMatches(ev,dims))continue;
        eventMetrics.push({...ev,date,type,...dims});
        if(dayMap.has(date)&&(type==="join"||type==="resign")){const d=dayMap.get(date)!;d[type]+=1;}
      }
      const allResignMetrics:any[]=[];
      for(const ev of rawAllResigns){
        const date=text(ev.effective_date),dims=eventDims(ev,allById,allByNo,teamById,positionById);
        if(!eventMatches(ev,dims))continue;
        allResignMetrics.push({...ev,date,type:"resign",...dims});
      }
      const countEvents=(type:string,start:string,end:string,field?:string,value?:string)=>eventMetrics.filter((e:any)=>e.type===type&&inDateRange(e.date,start,end)&&(!field||text(e[field])===text(value))).length;
      const countAllResigns=(field?:string,value?:string)=>allResignMetrics.filter((e:any)=>(!field||text(e[field])===text(value))).length;
      const countAllResignsRange=(start:string,end:string,field?:string,value?:string)=>allResignMetrics.filter((e:any)=>inDateRange(e.date,start,end)&&(!field||text(e[field])===text(value))).length;
      const teamActive=new Map<string,any[]>(),positionActive=new Map<string,any[]>(),countryActive=new Map<string,any[]>(),shiftActive=new Map<string,any[]>();
      for(const r of activeRows){const team=text(r.teams?.name)||"未匹配团队",position=text(r.positions?.name)||"未设置岗位",country=text(r.country||r.nationality)||"未分类",shift=text(r.shift_name)||"未设置班次";if(!teamActive.has(team))teamActive.set(team,[]);if(!positionActive.has(position))positionActive.set(position,[]);if(!countryActive.has(country))countryActive.set(country,[]);if(!shiftActive.has(shift))shiftActive.set(shift,[]);teamActive.get(team)!.push(r);positionActive.get(position)!.push(r);countryActive.get(country)!.push(r);shiftActive.get(shift)!.push(r);}
      const activeTotal=activeRows.length;
      const teamMetric=(name:string,rows:any[])=>{
        const ps=new Map<string,number>(),ss=new Map<string,number>(),cs=new Map<string,number>();
        rows.forEach((r:any)=>{increment(ps,r.positions?.name||"未设置岗位");increment(ss,r.shift_name||"未设置班次");increment(cs,r.country||r.nationality||"未分类");});
        const j7=countEvents("join",start7,today,"team",name),r7=countEvents("resign",start7,today,"team",name),j30=countEvents("join",start30,today,"team",name),r30=countEvents("resign",start30,today,"team",name);
        const pj=periodActive?countEvents("join",periodFrom,periodTo,"team",name):0,pr=periodActive?countEvents("resign",periodFrom,periodTo,"team",name):0;
        const rt=countAllResignsRange(today,today,"team",name),ry=countAllResignsRange(yesterday,yesterday,"team",name),rby=countAllResignsRange(dayBeforeYesterday,dayBeforeYesterday,"team",name);
        const rp7=countAllResignsRange(prev7Start,prev7End,"team",name),rm=countAllResignsRange(monthStart,today,"team",name),rpm=countAllResignsRange(prevMonth.start,prevMonth.end,"team",name),rall=countAllResigns("team",name);
        return {
          name,count:rows.length,share:ratioPercent(rows.length,activeTotal),
          join_7d:j7,resign_7d:r7,prev_resign_7d:rp7,resign_7d_delta_pct:deltaPct(r7,rp7),
          join_30d:j30,resign_30d:r30,net_30d:j30-r30,resign_rate_30:ratioPercent(r30,rows.length+r30),
          today_resign:rt,yesterday_resign:ry,day_before_yesterday_resign:rby,
          today_resign_delta_pct:deltaPct(rt,ry),yesterday_resign_delta_pct:deltaPct(ry,rby),
          month_resign:rm,prev_month_resign:rpm,month_resign_delta_pct:deltaPct(rm,rpm),resign_total:rall,
          period_join:pj,period_resign:pr,period_net:pj-pr,period_resign_rate:ratioPercent(pr,rows.length+pr),
          positions:sortedBreakdown(ps,rows.length),shifts:sortedBreakdown(ss,rows.length),countries:sortedBreakdown(cs,rows.length)
        };
      };
      const teams=Array.from(teamActive.entries()).map(([name,rows])=>teamMetric(name,rows)).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));

      const positionMetric=(name:string,rows:any[])=>{
        const ts=new Map<string,number>(),ss=new Map<string,number>(),cs=new Map<string,number>();
        rows.forEach((r:any)=>{increment(ts,r.teams?.name||"未匹配团队");increment(ss,r.shift_name||"未设置班次");increment(cs,r.country||r.nationality||"未分类");});
        const j7=countEvents("join",start7,today,"position",name),r7=countEvents("resign",start7,today,"position",name),j30=countEvents("join",start30,today,"position",name),r30=countEvents("resign",start30,today,"position",name);
        const pj=periodActive?countEvents("join",periodFrom,periodTo,"position",name):0,pr=periodActive?countEvents("resign",periodFrom,periodTo,"position",name):0;
        const rm=countAllResignsRange(monthStart,today,"position",name),rpm=countAllResignsRange(prevMonth.start,prevMonth.end,"position",name),rall=countAllResigns("position",name);
        return {name,count:rows.length,share:ratioPercent(rows.length,activeTotal),join_7d:j7,resign_7d:r7,join_30d:j30,resign_30d:r30,net_30d:j30-r30,resign_rate_30:ratioPercent(r30,rows.length+r30),month_resign:rm,prev_month_resign:rpm,month_resign_delta_pct:deltaPct(rm,rpm),resign_total:rall,period_join:pj,period_resign:pr,period_net:pj-pr,period_resign_rate:ratioPercent(pr,rows.length+pr),teams:sortedBreakdown(ts,rows.length),shifts:sortedBreakdown(ss,rows.length),countries:sortedBreakdown(cs,rows.length)};
      };
      const positions=Array.from(positionActive.entries()).map(([name,rows])=>positionMetric(name,rows)).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));

      const countries=Array.from(countryActive.entries()).map(([name,rows])=>{
        const tenure={prepare:0,within_7:0,days_7_14:0,days_15_30:0,days_30_60:0,days_60_plus:0,unknown:0};
        rows.forEach((r:any)=>{const bucket=hireTenureBucket(r.hire_date,today);(tenure as any)[bucket]=((tenure as any)[bucket]||0)+1;});
        const tjc=countEvents("join",today,today,"country",name),yjc=countEvents("join",yesterday,yesterday,"country",name);
        const trc=countAllResignsRange(today,today,"country",name),yrc=countAllResignsRange(yesterday,yesterday,"country",name);
        const j7=countEvents("join",start7,today,"country",name),pj7=countEvents("join",prev7Start,prev7End,"country",name);
        const r7=countEvents("resign",start7,today,"country",name),pr7=countAllResignsRange(prev7Start,prev7End,"country",name);
        const j30=countEvents("join",start30,today,"country",name),r30=countEvents("resign",start30,today,"country",name);
        const mj=countEvents("join",monthStart,today,"country",name),pmj=countEvents("join",prevMonth.start,prevMonth.end,"country",name);
        const pj=periodActive?countEvents("join",periodFrom,periodTo,"country",name):0,pr=periodActive?countEvents("resign",periodFrom,periodTo,"country",name):0;
        const rm=countAllResignsRange(monthStart,today,"country",name),rpm=countAllResignsRange(prevMonth.start,prevMonth.end,"country",name),rall=countAllResigns("country",name);
        return {
          name,count:rows.length,share:ratioPercent(rows.length,activeTotal),
          today_join:tjc,yesterday_join:yjc,today_join_delta_pct:deltaPct(tjc,yjc),
          today_resign:trc,yesterday_resign:yrc,today_resign_delta_pct:deltaPct(trc,yrc),
          join_7d:j7,prev_join_7d:pj7,join_7d_delta_pct:deltaPct(j7,pj7),
          resign_7d:r7,prev_resign_7d:pr7,resign_7d_delta_pct:deltaPct(r7,pr7),net_7d:j7-r7,
          join_30d:j30,resign_30d:r30,net_30d:j30-r30,resign_rate_30:ratioPercent(r30,rows.length+r30),
          month_join:mj,prev_month_join:pmj,month_join_delta_pct:deltaPct(mj,pmj),
          month_resign:rm,prev_month_resign:rpm,month_resign_delta_pct:deltaPct(rm,rpm),resign_total:rall,
          prepare_join:tenure.prepare,hire_7d:tenure.within_7,hire_7_14:tenure.days_7_14,hire_15_30:tenure.days_15_30,hire_30_60:tenure.days_30_60,hire_60_plus:tenure.days_60_plus,tenure_unknown:tenure.unknown,
          lifetime_resign_rate:ratioPercent(rall,rows.length+rall),
          period_join:pj,period_resign:pr,period_net:pj-pr,period_resign_rate:ratioPercent(pr,rows.length+pr)
        };
      }).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));
      const shifts=Array.from(shiftActive.entries()).map(([name,rows])=>({name,count:rows.length,share:ratioPercent(rows.length,activeTotal)})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));

      const tj=countEvents("join",today,today),yj=countEvents("join",yesterday,yesterday),tr=countEvents("resign",today,today),yr=countEvents("resign",yesterday,yesterday),rby=countAllResignsRange(dayBeforeYesterday,dayBeforeYesterday),j7=countEvents("join",start7,today),pj7=countEvents("join",prev7Start,prev7End),r7=countEvents("resign",start7,today),pr7=countAllResignsRange(prev7Start,prev7End),j30=countEvents("join",start30,today),r30=countEvents("resign",start30,today);
      const monthResign=countAllResignsRange(monthStart,today),prevMonthResign=countAllResignsRange(prevMonth.start,prevMonth.end),resignTotal=countAllResigns();
      const resignHistoryFrom=allResignMetrics.length?allResignMetrics.map((x:any)=>x.date).filter(Boolean).sort()[0]:today;
      const periodJoin=periodActive?countEvents("join",periodFrom,periodTo):0,periodResign=periodActive?countEvents("resign",periodFrom,periodTo):0;
      const periodLabel=periodFrom===periodTo?periodFrom:`${periodFrom} 至 ${periodTo}`;
      return respond({
        as_of:today,
        filters:filter,
        period:{active:periodActive,from:periodFrom,to:periodTo,label:periodLabel,days:periodDays,join:periodJoin,resign:periodResign,net:periodJoin-periodResign,resign_rate:ratioPercent(periodResign,activeTotal+periodResign),trend_truncated:periodActive&&periodFrom<trendStart},
        resignation:{
          history_from:resignHistoryFrom,
          history_to:today,
          month_from:monthStart,
          month_to:today,
          prev_month_from:prevMonth.start,
          prev_month_to:prevMonth.end,
        },
        kpis:{
          total_profiles:employees.length,active:activeTotal,
          today_join:tj,yesterday_join:yj,today_join_delta:tj-yj,
          today_resign:tr,yesterday_resign:yr,day_before_yesterday_resign:rby,
          today_resign_delta:tr-yr,today_resign_delta_pct:deltaPct(tr,yr),
          yesterday_resign_delta:yr-rby,yesterday_resign_delta_pct:deltaPct(yr,rby),
          join_7d:j7,prev_join_7d:pj7,join_7d_delta_pct:deltaPct(j7,pj7),
          resign_7d:r7,prev_resign_7d:pr7,resign_7d_delta_pct:deltaPct(r7,pr7),
          month_resign:monthResign,prev_month_resign:prevMonthResign,month_resign_delta_pct:deltaPct(monthResign,prevMonthResign),
          resign_total:resignTotal,
          join_30d:j30,resign_30d:r30,net_30d:j30-r30,
          resign_rate_30:ratioPercent(r30,activeTotal+r30),
        },
        trend:Array.from(dayMap.entries()).map(([date,v])=>({date,...v})),
        teams,positions,countries,shifts
      });
    }

    if (action === "analytics_event_details") {
      await requirePermission(service,caller,"employee.analytics.view");
      const canFilterSensitive=caller.roleCode==="founder"||await permissionAllowed(service,caller.access,caller.userId,"sensitive.employee.view");
      const today=isoDateLocal(body.date_to||body.today),dateFrom=text(body.date_from)||addDaysIso(today,-29),dateTo=text(body.date_to)||today;
      const eventType=text(body.event_type)||"all",dimension=text(body.dimension),value=text(body.value),limit=Math.min(2000,Math.max(1,Number(body.limit||500)));
      const filter=body.filters||{};
      const employees=await fetchAllScopedEmployees(service,scope),byId=new Map(employees.map((x:any)=>[x.id,x])),byNo=new Map(employees.map((x:any)=>[text(x.employee_no).toUpperCase(),x]));
      const [{data:teamRows},{data:positionRows}]=await Promise.all([service.from("teams").select("id,name"),service.from("positions").select("id,name")]);
      const teamById=new Map((teamRows||[]).map((x:any)=>[text(x.id),text(x.name)])),positionById=new Map((positionRows||[]).map((x:any)=>[text(x.id),text(x.name)]));
      if(eventType==="active"){
        const result:any[]=[];
        const tenureBucket=text(filter.tenure_bucket);
        for(const emp of employees){
          if(text(emp.status)!=="active")continue;
          const dims={
            team:text(emp.teams?.name)||"未分类",
            position:text(emp.positions?.name)||"未分类",
            country:text(emp.country||emp.nationality)||"未分类",
            shift:text(emp.shift_name)||"未分类",
          };
          if(dimension&&text((dims as any)[dimension])!==value)continue;
          if(text(filter.team)&&!text(dims.team).toLowerCase().includes(text(filter.team).toLowerCase()))continue;
          if(text(filter.position)&&!text(dims.position).toLowerCase().includes(text(filter.position).toLowerCase()))continue;
          if(text(filter.country)&&!text(dims.country).toLowerCase().includes(text(filter.country).toLowerCase()))continue;
          if(text(filter.shift_name)&&!text(dims.shift).toLowerCase().includes(text(filter.shift_name).toLowerCase()))continue;
          if(text(filter.employee_no)&&!text(emp.employee_no).toLowerCase().includes(text(filter.employee_no).toLowerCase()))continue;
          if(text(filter.full_name)&&!text(emp.full_name).toLowerCase().includes(text(filter.full_name).toLowerCase()))continue;
          if(canFilterSensitive&&text(filter.work_tg)&&!text(emp.work_tg).toLowerCase().includes(text(filter.work_tg).toLowerCase()))continue;
          if(tenureBucket&&hireTenureBucket(emp.hire_date,today)!==tenureBucket)continue;
          const keyword=text(filter.keyword).toLowerCase();
          if(keyword){
            const hay=[emp.employee_no,emp.full_name,...(canFilterSensitive?[emp.work_tg,emp.backend_accounts]:[]),dims.team,dims.position,dims.country,dims.shift].map(text).join(" ").toLowerCase();
            if(!hay.includes(keyword))continue;
          }
          result.push({
            id:`active:${text(emp.id)}`,
            employee_id:emp.id,
            employee_no:text(emp.employee_no),
            full_name:text(emp.full_name),
            employment_type:text(emp.employment_type),
            date:text(emp.hire_date).slice(0,10),
            event_type:"active",
            reason:"",
            team:dims.team,
            position:dims.position,
            country:dims.country,
            shift:dims.shift,
            created_at:null,
          });
        }
        result.sort((a,b)=>text(b.date).localeCompare(text(a.date))||text(a.employee_no).localeCompare(text(b.employee_no)));
        return respond({rows:result.slice(0,limit),total:result.length,date_from:"",date_to:"",event_type:eventType,dimension,value});
      }
      const rawEvents=await fetchRecentLifecycleEvents(service,scope,employees,dateFrom);
      const result:any[]=[];
      for(const ev of rawEvents){
        const type=text(ev.event_type);
        if(eventType!=="all"&&type!==eventType)continue;
        const date=text(ev.effective_date);
        if(!inDateRange(date,dateFrom,dateTo))continue;
        const dims=eventDims(ev,byId,byNo,teamById,positionById);
        const emp=(ev.employee_id&&byId.get(ev.employee_id))||byNo.get(text(ev.employee_no).toUpperCase())||null;
        if(scope.mode!=="all"&&!emp)continue;
        if(dimension&&text((dims as any)[dimension])!==value)continue;
        if(text(filter.team)&&!text(dims.team).toLowerCase().includes(text(filter.team).toLowerCase()))continue;
        if(text(filter.position)&&!text(dims.position).toLowerCase().includes(text(filter.position).toLowerCase()))continue;
        if(text(filter.country)&&!text(dims.country).toLowerCase().includes(text(filter.country).toLowerCase()))continue;
        if(text(filter.shift_name)&&!text(dims.shift).toLowerCase().includes(text(filter.shift_name).toLowerCase()))continue;
        if(text(filter.employee_no)&&!text(emp?.employee_no||ev.employee_no).toLowerCase().includes(text(filter.employee_no).toLowerCase()))continue;
        if(text(filter.full_name)&&!text(emp?.full_name||ev.full_name||ev.snapshot?.full_name||ev.snapshot?.name).toLowerCase().includes(text(filter.full_name).toLowerCase()))continue;
        if(canFilterSensitive&&text(filter.work_tg)&&!text(emp?.work_tg||ev.snapshot?.work_tg).toLowerCase().includes(text(filter.work_tg).toLowerCase()))continue;
        if(text(filter.reason)&&type==="resign"&&!text(ev.reason).toLowerCase().includes(text(filter.reason).toLowerCase()))continue;
        if(text(filter.reason)&&type!=="resign")continue;
        const keyword=text(filter.keyword).toLowerCase();
        if(keyword){
          const hay=[ev.employee_no,ev.full_name,emp?.employee_no,emp?.full_name,...(canFilterSensitive?[emp?.work_tg,emp?.backend_accounts]:[]),dims.team,dims.position,dims.country,dims.shift].map(text).join(" ").toLowerCase();
          if(!hay.includes(keyword))continue;
        }
        result.push({
          id:`${text(ev.employee_id)||text(ev.employee_no)}:${date}:${type}:${result.length}`,
          employee_id:emp?.id||ev.employee_id||null,
          employee_no:text(emp?.employee_no||ev.employee_no),
          full_name:text(emp?.full_name||ev.full_name||ev.snapshot?.full_name||ev.snapshot?.name),
          employment_type:text(emp?.employment_type||ev.snapshot?.employment_type),
          date,
          event_type:type,
          reason:text(ev.reason),
          team:dims.team,
          position:dims.position,
          country:dims.country,
          shift:dims.shift,
          created_at:ev.created_at,
        });
      }
      result.sort((a,b)=>text(b.date).localeCompare(text(a.date))||text(a.employee_no).localeCompare(text(b.employee_no)));
      return respond({rows:result.slice(0,limit),total:result.length,date_from:dateFrom,date_to:dateTo,event_type:eventType,dimension,value});
    }

    if(action==="list") return respond(await buildEmployeeList(service,caller,scope,body));

    if (action === "detail") {
      const employeeId = text(body.employee_id);
      if (!employeeId) throw new Error("缺少 employee_id");

      let q = service.from("employees").select(EMPLOYEE_DETAIL_SELECT).eq("id",employeeId);
      q = applyScope(q,scope);

      const { data:rawEmployee, error } = await q.maybeSingle();
      if (error) throw error;
      if (!rawEmployee) return respond({ error:"找不到员工或无查看权限" },404,"employee_not_found",false);
      const employee=overlayCurrentOrganization(rawEmployee,scope);

      const detailPermissionCodes=[
        "sensitive.employee.view","sensitive.employee.edit",
        "sensitive.payout.view","sensitive.payment.view",
        "employee.directory.compensation.view","employee.edit",
        "employee.directory.resign","employee.directory.reactivate","employee.delete",
        "sensitive.payout.edit","sensitive.payment.edit","employee.compensation.edit",
      ];
      const [contactResult,paymentResult,compensationResult,legacyCompResult,portalResult,permissionDecisions] = await Promise.all([
        service.from("employee_contact_profiles").select(CONTACT_DETAIL_SELECT).eq("employee_id",employeeId).maybeSingle(),
        service.from("employee_payment_profiles").select(PAYMENT_DETAIL_SELECT).eq("employee_id",employeeId).maybeSingle(),
        service.from("employee_compensation_settings").select(COMPENSATION_DETAIL_SELECT).eq("employee_id",employeeId).maybeSingle(),
        service.from("employee_compensation_legacy").select("*").eq("employee_id",employeeId).maybeSingle(),
        service.from("user_access").select("auth_user_id,employee_portal_enabled,active").eq("employee_id",employeeId),
        permissionDecisionBatch(service,caller,detailPermissionCodes),
      ]);
      const contact=contactResult.data;
      const payment=paymentResult.data;
      const compensation=compensationResult.data;
      const legacyComp=legacyCompResult.data;
      const portalRows=portalResult.error?null:portalResult.data;
      const partialErrors=[...new Set([
        contactResult.error?"联系方式":null,
        paymentResult.error?"收款资料":null,
        compensationResult.error||legacyCompResult.error?"工资设置":null,
        portalResult.error?"员工账号状态":null,
      ].filter(Boolean))];

      const [
        canViewEmployeeSensitiveRaw,
        canEditEmployeeSensitiveRaw,
        canViewSensitiveRaw,
        canViewCompensationRaw,
        canEditRaw,
        canResignRaw,
        canReactivateRaw,
        canDeleteRaw,
        canEditPaymentRaw,
        canEditCompensationRaw,
      ] = [
        permissionAllowedFromBatch(permissionDecisions,"sensitive.employee.view"),
        permissionAllowedFirstDefinedFromBatch(permissionDecisions,["sensitive.employee.edit","sensitive.employee.view"]),
        permissionAllowedFirstDefinedFromBatch(permissionDecisions,["sensitive.payout.view","sensitive.payment.view"]),
        permissionAllowedFromBatch(permissionDecisions,"employee.directory.compensation.view"),
        permissionAllowedFromBatch(permissionDecisions,"employee.edit"),
        permissionAllowedFromBatch(permissionDecisions,"employee.directory.resign"),
        permissionAllowedFromBatch(permissionDecisions,"employee.directory.reactivate"),
        permissionAllowedFromBatch(permissionDecisions,"employee.delete"),
        permissionAllowedFirstDefinedFromBatch(permissionDecisions,["sensitive.payout.edit","sensitive.payment.edit"]),
        permissionAllowedFromBatch(permissionDecisions,"employee.compensation.edit"),
      ];
      const founder=caller.roleCode==="founder";
      const canViewEmployeeSensitive = founder || canViewEmployeeSensitiveRaw;
      const canViewSensitive = founder || canViewSensitiveRaw;
      const canViewCompensation = founder || canViewCompensationRaw;
      const canEditEmployee = (founder || canEditRaw) && scope.mode!=="self";
      // Explicit edit permission may replace a hidden value without revealing
      // it. The client submits only fields actually changed, never masks.
      const canEditEmployeeSensitive = canEditEmployee && (founder || canEditEmployeeSensitiveRaw);
      const canEditPayment = canEditEmployee && (founder || canEditPaymentRaw);
      const canEditCompensation = canEditEmployee && (founder || canEditCompensationRaw);
      const canResignEmployee = founder || canResignRaw;
      const canReactivateEmployee = founder || canReactivateRaw;
      const canDeleteEmployee = founder || canDeleteRaw;

      const resolved = effectivePayment(employee,payment);
      const employeeView = canViewEmployeeSensitive ? employee : {
        ...employee,
        work_tg:employee.work_tg ? "****" : null,
        work_account:employee.work_account ? "****" : null,
        backend_accounts:employee.backend_accounts ? "****" : null,
      };
      const contactView = !contact ? null : canViewEmployeeSensitive ? contact : {
        ...contact,
        work_email:contact.work_email ? maskMiddle(contact.work_email) : null,
        telegram_username:contact.telegram_username ? maskMiddle(contact.telegram_username) : null,
        zoom_email:contact.zoom_email ? maskMiddle(contact.zoom_email) : null,
        facebook:contact.facebook ? "****" : null,
        whatsapp_phone:contact.whatsapp_phone ? maskMiddle(contact.whatsapp_phone) : null,
      };
      const paymentView = {
        mode:resolved.mode,
        transfer_using:resolved.transfer_using,
        usdt_address:canViewSensitive ? resolved.usdt_address : maskMiddle(resolved.usdt_address),
        bank_wallet_account:canViewSensitive ? resolved.bank_wallet_account : maskMiddle(resolved.bank_wallet_account),
        account_name:canViewSensitive ? resolved.account_name : (resolved.account_name ? "****" : null),
        contact_phone:canViewSensitive ? resolved.contact_phone : maskMiddle(resolved.contact_phone),
        whatsapp_number:canViewSensitive ? resolved.whatsapp_number : maskMiddle(resolved.whatsapp_number),
        facebook:canViewSensitive ? resolved.facebook : (resolved.facebook ? "****" : null),
        employee_address:canViewSensitive ? resolved.employee_address : (resolved.employee_address ? "**** ****" : null),
        source_sheet:resolved.source_sheet,
      };

      const merged = { ...employee, telegram_username:contact?.telegram_username };
      const missing = missingFields(merged,payment);

      return respond({
        employee:employeeView,
        contact:contactView,
        payment:paymentView,
        compensation:canViewCompensation ? (compensation || legacyComp || null) : null,
        permissions:{
          sensitive_employee_view:canViewEmployeeSensitive,
          sensitive_payment_view:canViewSensitive,
          compensation_view:canViewCompensation,
          sensitive_employee_edit:canEditEmployeeSensitive,
          sensitive_payment_edit:canEditPayment,
          compensation_edit:canEditCompensation,
        },
        actions:{
          can_edit:canEditEmployee,
          can_edit_sensitive_employee:canEditEmployeeSensitive,
          can_edit_payment:canEditPayment,
          can_edit_compensation:canEditCompensation,
          can_resign:canResignEmployee,
          can_reactivate:canReactivateEmployee,
          can_delete:canDeleteEmployee,
          can_cancel_hire:canDeleteEmployee && employee.status==="active" && employee.source_type==="backend" && !portalResult.error && !(portalRows||[]).length,
        },
        missing_fields:missing,
        partial_errors:partialErrors,
      });
    }


    if (action === "history_list") {
      await requirePermission(service, caller, "employee.resignations.view");

      const page = Math.max(1, Number(body.page || 1));
      const allowed = [20,30,50,100,500];
      const requested = Number(body.page_size || 20);
      const pageSize = allowed.includes(requested) ? requested : 20;
      const f = body.filters || {};

      const fetchHistoryBatch=async(from:number,to:number)=>{
        let q = service.from("employee_lifecycle_events")
          .select("*")
          .eq("event_type","resign")
          .or("note.is.null,note.neq.__VOIDED__");
        if (text(f.employee_no)) q = q.ilike("employee_no",`%${text(f.employee_no)}%`);
        if (text(f.full_name)) q = q.ilike("full_name",`%${text(f.full_name)}%`);
        const keyword = text(f.keyword);
        if (keyword) {
          const k = keyword.replace(/[%_,()]/g, " ");
          q = q.or(`employee_no.ilike.%${k}%,full_name.ilike.%${k}%`);
        }
        if (text(f.reason)) q = q.ilike("reason",`%${text(f.reason)}%`);
        if (text(f.date_from)) q = q.gte("effective_date", f.date_from);
        if (text(f.date_to)) q = q.lte("effective_date", f.date_to);
        return await q
          .order("effective_date", { ascending:false, nullsFirst:false })
          .order("created_at", { ascending:false })
          .range(from,to);
      };

      const eventRows:any[]=[];
      let historyOffset=0;
      const historyBatch=1000;
      while(true){
        const {data,error}=await fetchHistoryBatch(historyOffset,historyOffset+historyBatch-1);
        if(error)throw error;
        const batchRows=data||[];
        eventRows.push(...batchRows);
        if(batchRows.length<historyBatch)break;
        historyOffset+=historyBatch;
        if(historyOffset>20000)break;
      }
      const scopedEmployees=await fetchAllScopedEmployees(service,scope);
      const employeeMap=new Map((scopedEmployees||[]).map((e:any)=>[e.id,e]));
      const employeeNoMap=new Map((scopedEmployees||[]).map((e:any)=>[text(e.employee_no).toUpperCase(),e]));

      const actorIds=Array.from(new Set(eventRows.flatMap((r:any)=>[
        text(r.created_by),
        text(r.snapshot?.last_edited_by),
      ]).filter(Boolean)));
      let actorMap=new Map<string,string>();
      if(actorIds.length){
        const {data:actorRows,error:actorError}=await service
          .from("user_access")
          .select("auth_user_id,login_username")
          .in("auth_user_id",actorIds.slice(0,500));
        if(actorError) throw actorError;
        actorMap=new Map((actorRows||[]).map((x:any)=>[text(x.auth_user_id),text(x.login_username)||"后台账号"]));
      }

      const teamFilter=text(f.team).toLowerCase(),positionFilter=text(f.position).toLowerCase(),countryFilter=text(f.country).toLowerCase();
      const enrichedAll=eventRows.map((r:any)=>{
        const e=employeeMap.get(r.employee_id) || employeeNoMap.get(text(r.employee_no).toUpperCase());
        if(scope.mode!=="all"&&!e)return null;
        const lastActor=text(r.snapshot?.last_edited_by)||text(r.created_by);
        const sourceLabel=r.source==="backend"?"后台":(r.source_sheet||r.source||"历史导入");
        const operatorAccount=actorMap.get(lastActor)
          || (r.source==="backend" ? "后台历史账号" : "Google Sheet");
        const teamName=text(r.snapshot?.team || r.snapshot?.team_name || r.snapshot?.market_country || r.snapshot?.series || e?.teams?.name);
        const positionName=text(r.snapshot?.position || r.snapshot?.position_name || e?.positions?.name);
        const countryName=text(r.snapshot?.country || r.snapshot?.nationality || e?.country || e?.nationality);
        if(teamFilter&&!teamName.toLowerCase().includes(teamFilter))return null;
        if(positionFilter&&!positionName.toLowerCase().includes(positionFilter))return null;
        if(countryFilter&&!countryName.toLowerCase().includes(countryFilter))return null;
        return {
          ...r,
          employee_type:e?.employment_type || r.snapshot?.employment_type || null,
          employee_country:countryName || null,
          team_name:teamName || null,
          position_name:positionName || null,
          employee_status:e?.status || null,
          source_label:sourceLabel,
          operator_account:operatorAccount,
          operation_time:r.snapshot?.last_edited_at || r.created_at,
        };
      }).filter(Boolean);

      const total=enrichedAll.length;
      const from=(page-1)*pageSize;
      const enriched=enrichedAll.slice(from,from+pageSize);

      const [canEditRaw,canRestoreRaw,canDeleteRaw]=await Promise.all([
        permissionAllowed(service,caller.access,caller.userId,"employee.resignations.resign"),
        permissionAllowed(service,caller.access,caller.userId,"employee.resignations.reactivate"),
        Promise.resolve(false),
      ]);
      const founder=caller.roleCode==="founder";

      return respond({
        rows:enriched,
        total,
        page,
        page_size:pageSize,
        pages:Math.max(1,Math.ceil(total/pageSize)),
        permissions:{
          can_edit:founder || canEditRaw,
          can_restore:founder || canRestoreRaw,
          can_delete:founder || canDeleteRaw,
        },
      });
    }

    if (action === "create_employee_full") {
      await requirePermission(service, caller, "employee.create");
      const p = body.employee || {};
      const employeeNo = text(p.employee_no).toUpperCase();
      const fullName = text(p.full_name);
      if (!employeeNo || !fullName) throw new Error("员工ID和姓名不能为空");

      const { data:exists } = await service.from("employees").select("id").eq("employee_no",employeeNo).maybeSingle();
      if (exists?.id) throw new Error("员工ID已经存在");

      const platformMap=await fetchPlatformMapFromSchedule();
      const platformRef=findPlatformRef(platformMap,p.market_position);
      const derivedTeamId=platformRef?.series
        ? await findOrCreateTeamBySeries(service,platformRef.series)
        : nullable(p.team_id);

      const employeeRow:any = {
        employee_no:employeeNo,
        full_name:fullName,
        country:nullable(p.country),
        nationality:nullable(p.country),
        employment_type:nullable(p.employment_type),
        team_id:derivedTeamId,
        position_id:null,
        status:"active",
        market_country:nullable(platformRef?.series || p.market_country),
        market_position:nullable(p.market_position),
        shift_name:null,
        legacy_shift_name:null,
        work_tg:nullable(p.work_tg),
        backend_accounts:nullable(p.backend_accounts),
        hire_date:nullable(p.hire_date),
        last_location:nullable(p.last_location),
        return_date:nullable(p.return_date),
        home_date:nullable(p.home_date),
        source_type:"backend",
        source_sheet:"WFH后台",
        profile_status:"backend_created",
        official_id_pending:false,
      };

      const { data:employee, error } = await service.from("employees").insert(employeeRow).select("*").single();
      if (error) throw error;

      await saveProfiles(service,caller,employee,body);

      if (employee.hire_date) {
        await service.from("employee_lifecycle_events").insert({
          employee_id:employee.id,
          employee_no:employee.employee_no,
          full_name:employee.full_name,
          event_type:"join",
          effective_date:employee.hire_date,
          source:"backend",
          source_key:`backend:${employee.id}:join:${employee.hire_date}`,
          created_by:caller.userId,
          snapshot:employeeRow,
        });
      }

      const bundle = await getEmployeeBundle(service,employee.id);
      const sync = await sendSheetSync(sheetPayload(bundle,"create"));
      return respond({ ok:true, employee_id:employee.id, sync });
    }

    if (action === "update_employee_full") {
      await requirePermission(service, caller, "employee.edit");
      const employeeId = text(body.employee_id);
      if (!employeeId) throw new Error("缺少 employee_id");
      await requireEmployeeInScope(service,scope,employeeId);

      const p = body.employee || {};
      const platformMap=await fetchPlatformMapFromSchedule();
      const platformRef=findPlatformRef(platformMap,p.market_position);
      const derivedTeamId=platformRef?.series
        ? await findOrCreateTeamBySeries(service,platformRef.series)
        : nullable(p.team_id);

      const updateRow:any = {
        full_name:nullable(p.full_name),
        country:nullable(p.country),
        nationality:nullable(p.country),
        employment_type:nullable(p.employment_type),
        market_country:nullable(platformRef?.series || p.market_country),
        market_position:nullable(p.market_position),
        work_tg:nullable(p.work_tg),
        backend_accounts:nullable(p.backend_accounts),
        hire_date:nullable(p.hire_date),
        last_location:nullable(p.last_location),
        return_date:nullable(p.return_date),
        home_date:nullable(p.home_date),
        source_sheet:"WFH后台",
      };

      const { data:employee, error } = await service.from("employees")
        .update(updateRow).eq("id",employeeId).select("*").single();
      if (error) throw error;

      await saveProfiles(service,caller,employee,body);

      await service.from("employee_lifecycle_events").insert({
        employee_id:employee.id,
        employee_no:employee.employee_no,
        full_name:employee.full_name,
        event_type:"profile_update",
        effective_date:new Date().toISOString().slice(0,10),
        source:"backend",
        source_key:`backend:${employee.id}:profile_update:${Date.now()}`,
        created_by:caller.userId,
        note:nullable(body.note),
        snapshot:updateRow,
      });

      const bundle = await getEmployeeBundle(service,employee.id);
      const sync = await sendSheetSync(sheetPayload(bundle,"update"));
      return respond({ ok:true, sync });
    }


    async function recoverBackendAccount(employeeId:string,currentValue:unknown){
      const current=text(currentValue);
      if(current && current!=="辞职") return current;

      const {data:events,error}=await service
        .from("employee_lifecycle_events")
        .select("snapshot,event_type,created_at")
        .eq("employee_id",employeeId)
        .in("event_type",["profile_update","join","reactivate"])
        .order("created_at",{ascending:false})
        .limit(30);
      if(error) throw error;

      for(const ev of events||[]){
        const candidate=text(ev?.snapshot?.backend_accounts);
        if(candidate && candidate!=="辞职") return candidate;
      }
      return null;
    }

    if (action === "cancel_new_hire") {
      await requirePermission(service, caller, "employee.delete");const employeeId=text(body.employee_id),confirmNo=text(body.confirm_employee_no);if(!employeeId)throw new Error("缺少 employee_id");await requireEmployeeInScope(service,scope,employeeId);const {data:employee,error:employeeError}=await service.from("employees").select("*").eq("id",employeeId).single();if(employeeError)throw employeeError;if(text(employee.employee_no)!==confirmNo)throw new Error("员工ID确认不一致");if(employee.status!=="active")throw new Error("只有当前在职的新员工可以撤销入职");if(employee.source_type!=="backend")throw new Error("导入的历史员工不能使用撤销入职，请使用正式离职流程");const {data:accessRows,error:accessError}=await service.from("user_access").select("auth_user_id,employee_portal_enabled").eq("employee_id",employeeId);if(accessError)throw accessError;if((accessRows||[]).length)throw new Error("该员工已经存在登录账号/权限记录，请先处理账号后再撤销入职");const sheetResult=await removeEmployeeFromSheet(employee.employee_no,employee.full_name);for(const table of ["employee_contact_profiles","employee_payment_profiles","employee_compensation_settings","employee_compensation_legacy","employee_lifecycle_events"]){const {error}=await service.from(table).delete().eq("employee_id",employeeId);if(error)throw error;}const {error:deleteError}=await service.from("employees").delete().eq("id",employeeId);if(deleteError)throw deleteError;return respond({ok:true,sheet:sheetResult,sheet_warning:sheetResult?.ok===false?`员工档案已撤销，但 TEST Google Sheet 删除失败：${sheetResult.error||"unknown"}`:null});
    }

    if (action === "update_resignation") {
      await requirePermission(service, caller, "employee.resignations.resign");
      const eventId=text(body.event_id);
      const employeeId=text(body.employee_id);
      const resignDate=text(body.resign_date);
      const reason=text(body.reason);
      if(!eventId || !resignDate || !reason) throw new Error("离职记录、离职日期和离职原因必须填写");

      const {data:event,error:eventError}=await service
        .from("employee_lifecycle_events")
        .select("*")
        .eq("id",eventId)
        .eq("event_type","resign")
        .maybeSingle();
      if(eventError) throw eventError;
      if(!event) throw new Error("找不到离职记录");
      if(text(event.note)==="__VOIDED__") throw new Error("这条离职记录已经撤销，不能继续编辑");
      if(employeeId && text(event.employee_id)!==employeeId) throw new Error("离职记录与员工不匹配");
      if(!event.employee_id) throw new Error("离职记录没有对应员工，无法确认操作范围");
      await requireEmployeeInScope(service,scope,text(event.employee_id));

      const editedAt=new Date().toISOString();
      const nextSnapshot={
        ...(event.snapshot||{}),
        last_edited_by:caller.userId,
        last_edited_at:editedAt,
        last_edited_username:caller.loginUsername||null,
      };

      const {error:updateEventError}=await service
        .from("employee_lifecycle_events")
        .update({
          effective_date:resignDate,
          reason,
          snapshot:nextSnapshot,
        })
        .eq("id",eventId);
      if(updateEventError) throw updateEventError;

      let sync:any={skipped:true,reason:"employee_not_found_or_not_currently_resigned"};
      if(event.employee_id){
        const {data:employee,error:employeeError}=await service
          .from("employees")
          .select("*")
          .eq("id",event.employee_id)
          .maybeSingle();
        if(employeeError) throw employeeError;
        if(employee?.status==="resigned"){
          const {error:updateEmployeeError}=await service
            .from("employees")
            .update({resign_date:resignDate})
            .eq("id",employee.id);
          if(updateEmployeeError) throw updateEmployeeError;

          const bundle=await getEmployeeBundle(service,employee.id);
          sync=await sendSheetSync(sheetPayload(bundle,"resign",{resign_reason:reason}));
        }
      }

      return respond({ok:true,sync});
    }

    if (action === "resign_employee") {
      await requirePermission(service, caller, "employee.directory.resign");
      const employeeId = text(body.employee_id);
      const resignDate = text(body.resign_date);
      const reason = text(body.reason);
      if (!employeeId || !resignDate || !reason) throw new Error("离职日期和离职原因必须填写");

      await requireEmployeeInScope(service,scope,employeeId);

      const { data:employee, error } = await service.from("employees")
        .update({ status:"resigned", resign_date:resignDate })
        .eq("id",employeeId).select("*").single();
      if (error) throw error;

      if (body.disable_portal !== false) {
        await service.from("user_access")
          .update({ active:false })
          .eq("employee_id",employeeId)
          .eq("employee_portal_enabled",true)
          .eq("backend_enabled",false);
      }

      const bundle = await getEmployeeBundle(service,employee.id);

      await service.from("employee_lifecycle_events").upsert({
        employee_id:employee.id,
        employee_no:employee.employee_no,
        full_name:employee.full_name,
        event_type:"resign",
        effective_date:resignDate,
        reason,
        note:null,
        source:"backend",
        source_key:`backend:${employee.id}:resign:${resignDate}`,
        created_by:caller.userId,
        snapshot:{
          employment_type:employee.employment_type,
          country:employee.country,
          team_id:employee.team_id,
          position_id:employee.position_id,
          position:bundle.employee?.positions?.name || null,
          portal_disabled:body.disable_portal !== false,
          backend_accounts:employee.backend_accounts || null,
          last_edited_by:caller.userId,
          last_edited_at:new Date().toISOString(),
          last_edited_username:caller.loginUsername||null,
        },
      }, { onConflict:"source_key" });

      const sync = await sendSheetSync(sheetPayload(bundle,"resign",{resign_reason:reason}));
      return respond({ ok:true, sync });
    }

    if (action === "undo_resignation" || action === "reactivate_employee") {
      await requireAnyPermission(service, caller, [
        "employee.directory.reactivate",
        "employee.resignations.reactivate",
      ]);
      const employeeId = text(body.employee_id);
      if(!employeeId) throw new Error("缺少 employee_id");
      await requireEmployeeInScope(service,scope,employeeId);

      const {data:before,error:beforeError}=await service
        .from("employees")
        .select("*")
        .eq("id",employeeId)
        .single();
      if(beforeError) throw beforeError;

      const restoredBackend=await recoverBackendAccount(employeeId,before.backend_accounts);

      const { data:employee, error } = await service.from("employees")
        .update({
          status:"active",
          resign_date:null,
          backend_accounts:restoredBackend,
        })
        .eq("id",employeeId).select("*").single();
      if (error) throw error;

      const {data:lastResign,error:lastResignError}=await service
        .from("employee_lifecycle_events")
        .select("id,effective_date,reason,snapshot,created_at")
        .eq("employee_id",employeeId)
        .eq("event_type","resign")
        .or("note.is.null,note.neq.__VOIDED__")
        .order("created_at",{ascending:false})
        .limit(1)
        .maybeSingle();
      if(lastResignError) throw lastResignError;

      if(lastResign?.id){
        const {error:voidError}=await service
          .from("employee_lifecycle_events")
          .update({note:"__VOIDED__"})
          .eq("id",lastResign.id);
        if(voidError) throw voidError;
      }

      if(body.restore_portal===true){
        await service.from("user_access")
          .update({active:true})
          .eq("employee_id",employeeId)
          .eq("employee_portal_enabled",true)
          .eq("backend_enabled",false);
      }

      await service.from("employee_lifecycle_events").insert({
        employee_id:employee.id,
        employee_no:employee.employee_no,
        full_name:employee.full_name,
        event_type:"reactivate",
        effective_date:new Date().toISOString().slice(0,10),
        reason:"撤销误操作离职",
        note:lastResign?.reason ? `原离职原因：${lastResign.reason}` : null,
        source:"backend",
        source_key:`backend:${employee.id}:undo_resign:${Date.now()}`,
        created_by:caller.userId,
        snapshot:{
          employment_type:employee.employment_type,
          country:employee.country,
          backend_accounts:restoredBackend,
          voided_resign_event_id:lastResign?.id || null,
          voided_resign_date:lastResign?.effective_date || null,
        },
      });

      const bundle = await getEmployeeBundle(service,employee.id);
      const sync = await sendSheetSync(sheetPayload(bundle,"reactivate",{resign_reason:""}));
      return respond({ ok:true, sync });
    }

    return respond({ error:"未知 action",code:"unknown_action",retryable:false,action:requestAction },400,"unknown_action",false);
  } catch (e) {
    const failure=responseFailure(e);
    return respond(
      {error:failure.message,code:failure.code,retryable:failure.retryable,action:requestAction},
      failure.status,failure.code,failure.retryable,
    );
  }
});
