import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{
  status,headers:{...corsHeaders,"Content-Type":"application/json; charset=utf-8"}
});
const text=(v:unknown)=>String(v??"").trim();
const nullable=(v:unknown)=>{const s=text(v);return s?s:null;};
const numberOrNull=(v:unknown)=>{if(v===null||v===undefined||v==="")return null;const n=Number(v);return Number.isFinite(n)?n:null;};
const upper=(v:unknown)=>text(v).toUpperCase();
const normName=(v:unknown)=>text(v).replace(/\s+/g," " ).toLowerCase();
const errorText=(e:any)=>e instanceof Error?e.message:text(e?.message||e?.details||e);
const owns=(value:unknown,key:string)=>Boolean(value&&typeof value==="object"&&Object.prototype.hasOwnProperty.call(value,key));
const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==="object"&&!Array.isArray(value));
const MASK_PLACEHOLDER=/(?:\*|•){3,}/;
const GOOGLE_SYNC_TIMEOUT_MS=20_000;
function assertNotMasked(value:unknown,label:string){
  if(typeof value==="string"&&MASK_PLACEHOLDER.test(value)){
    throw new Error(`${label} 不能提交脱敏占位符，请重新打开员工档案后再操作`);
  }
}
function assertFieldsNotMasked(source:unknown,fields:string[],label:string){
  if(!isRecord(source)) return;
  for(const field of fields){
    if(owns(source,field)) assertNotMasked(source[field],`${label}「${field}」`);
  }
}
function assertPayloadNotMasked(value:unknown,path:string){
  if(typeof value==="string") return assertNotMasked(value,path);
  if(Array.isArray(value)){
    value.forEach((item,index)=>assertPayloadNotMasked(item,`${path}[${index}]`));
    return;
  }
  if(isRecord(value)){
    for(const [key,item] of Object.entries(value)) assertPayloadNotMasked(item,`${path}.${key}`);
  }
}
function jwtSessionId(token:string){try{const raw=token.split(".")[1]?.replace(/-/g,"+").replace(/_/g,"/")||"";const padded=raw+"=".repeat((4-raw.length%4)%4);return text(JSON.parse(atob(padded))?.session_id);}catch{return "";}}
async function requireCurrentAdminSession(service:any,userId:string,token:string){
  const sessionId=jwtSessionId(token);if(!sessionId) throw new Error("登录会话无效，请重新登录");
  const {data,error}=await service.from("app_session_leases").select("user_id").eq("user_id",userId).eq("session_id",sessionId).eq("portal","admin").gt("lease_expires_at",new Date().toISOString()).maybeSingle();
  if(error||!data?.user_id) throw new Error("此账号未持有当前设备登录权，请重新登录");
}
// V29.4.6.2: 操作日志只展示此版本启用后的新日志；旧历史同步不再冒充“今天操作”。
const AUDIT_VISIBLE_FROM="2026-08-18T12:40:00.000Z";

async function checkIdentity(service:any,employeeNoRaw:unknown,fullNameRaw:unknown,excludeEmployeeId="",previousEmployeeNoRaw=""){
  const employeeNo=upper(employeeNoRaw);
  const fullName=text(fullNameRaw);
  const previousEmployeeNo=upper(previousEmployeeNoRaw);
  let idConflict:any=null;
  let nameConflict:any=null;

  if(employeeNo){
    const {data:employeeMatches,error:employeeError}=await service.from("employees")
      .select("id,employee_no,full_name,status,resign_date")
      .ilike("employee_no",employeeNo).limit(20);
    if(employeeError) throw employeeError;
    const exact=(employeeMatches||[]).find((x:any)=>upper(x.employee_no)===employeeNo&&text(x.id)!==text(excludeEmployeeId));
    if(exact) idConflict={...exact,source:"employees"};

    // Employee IDs are permanently unique and are never reusable.
    if(!idConflict && employeeNo!==previousEmployeeNo){
      const {data:historyMatches,error:historyError}=await service.from("employee_lifecycle_events")
        .select("employee_id,employee_no,full_name,event_type,effective_date")
        .ilike("employee_no",employeeNo).limit(100);
      if(historyError) throw historyError;
      const hist=(historyMatches||[]).find((x:any)=>{
        if(upper(x.employee_no)!==employeeNo) return false;
        if(text(x.employee_id)===text(excludeEmployeeId)) return false;
        if(previousEmployeeNo && upper(x.employee_no)===previousEmployeeNo) return false;
        return true;
      });
      if(hist) idConflict={
        employee_id:hist.employee_id||null,employee_no:hist.employee_no,full_name:hist.full_name,
        status:hist.event_type==="resign"?"resigned":"historical",
        resign_date:hist.event_type==="resign"?hist.effective_date:null,
        effective_date:hist.effective_date,source:"lifecycle_history"
      };
    }
  }

  const nameMatches:any[]=[];
  if(fullName){
    const wanted=normName(fullName);

    // Names are also permanently unique. Current employees are checked first.
    const {data:employeeNames,error:nameError}=await service.from("employees")
      .select("id,employee_no,full_name,status,resign_date")
      .ilike("full_name",fullName).limit(100);
    if(nameError) throw nameError;

    for(const x of employeeNames||[]){
      if(text(x.id)===text(excludeEmployeeId)||normName(x.full_name)!==wanted) continue;
      const item={...x,source:"employees"};
      nameMatches.push(item);
      if(!nameConflict) nameConflict=item;
    }

    // Historical names are also reserved forever, including hire/resign/restore history.
    const {data:historyNames,error:historyNameError}=await service.from("employee_lifecycle_events")
      .select("employee_id,employee_no,full_name,event_type,effective_date")
      .ilike("full_name",fullName).limit(200);
    if(historyNameError) throw historyNameError;

    for(const x of historyNames||[]){
      if(normName(x.full_name)!==wanted) continue;
      if(text(x.employee_id)===text(excludeEmployeeId)) continue;
      // Historical rows belonging to the employee currently being edited are not conflicts,
      // even if an old event has no employee_id but still carries the employee's previous ID.
      if(previousEmployeeNo && upper(x.employee_no)===previousEmployeeNo) continue;

      const status=x.event_type==="resign"?"resigned":"historical";
      const key=`${upper(x.employee_no)}|${status}|${text(x.effective_date)}`;
      const duplicate=nameMatches.some((m:any)=>
        `${upper(m.employee_no)}|${m.status==="resigned"?"resigned":m.status==="active"?"active":"historical"}|${text(m.resign_date||m.effective_date)}`===key
      );
      const item={
        employee_id:x.employee_id||null,
        employee_no:x.employee_no,
        full_name:x.full_name,
        status,
        resign_date:x.event_type==="resign"?x.effective_date:null,
        effective_date:x.effective_date,
        event_type:x.event_type,
        source:"lifecycle_history"
      };
      if(!duplicate) nameMatches.push(item);
      if(!nameConflict) nameConflict=item;
    }
  }

  nameMatches.sort((a:any,b:any)=>{
    const ar=a.status==="active"?0:a.status==="resigned"?1:2;
    const br=b.status==="active"?0:b.status==="resigned"?1:2;
    return ar-br || text(b.resign_date||b.effective_date).localeCompare(text(a.resign_date||a.effective_date));
  });
  if(nameMatches.length) nameConflict=nameMatches[0];

  return {
    employee_no:{value:employeeNo,available:!idConflict,conflict:idConflict},
    full_name:{
      value:fullName,
      available:!nameConflict,
      conflict:nameConflict,
      matches:nameMatches.slice(0,20),
      has_active:nameMatches.some((x:any)=>x.status==="active"),
      has_resigned:nameMatches.some((x:any)=>x.status==="resigned"),
      has_historical:nameMatches.some((x:any)=>x.status==="historical"),
    },
  };
}

function typeLabel(v:unknown){
  const s=text(v);
  const map:Record<string,string>={
    home_ph:"纯居家菲律宾",
    onsite_to_home:"现场转居家",
    home_vn:"纯居家（越南/缅甸/印尼等）",
    home_id:"纯居家（越南/缅甸/印尼等）",
    home_mm:"纯居家（越南/缅甸/印尼等）",
    "纯居家越南":"纯居家（越南/缅甸/印尼等）",
    "纯居家印尼":"纯居家（越南/缅甸/印尼等）",
    "纯居家缅甸":"纯居家（越南/缅甸/印尼等）",
  };
  return map[s]||s;
}

async function getCaller(req:Request,service:any){
  const token=(req.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"").trim();
  if(!token) throw new Error("未登录");
  const {data:userData,error:userError}=await service.auth.getUser(token);
  if(userError||!userData?.user) throw new Error("登录状态无效");
  const userId=userData.user.id;
  await requireCurrentAdminSession(service,userId,token);

  const {data:access,error}=await service.from("user_access")
    .select("auth_user_id,employee_id,role_id,data_scope,active,backend_enabled,login_username")
    .eq("auth_user_id",userId).maybeSingle();
  if(error||!access?.active||!access?.backend_enabled) throw new Error("无后台访问权限");

  const {data:role}=await service.from("roles").select("code").eq("id",access.role_id).maybeSingle();
  return {userId,access,roleCode:text(role?.code),loginUsername:text(access?.login_username)};
}

async function permissionAllowed(service:any,caller:any,code:string){
  if(caller.roleCode==="founder") return true;
  const {data:perm}=await service.from("permissions").select("id").eq("code",code).maybeSingle();
  if(!perm?.id) return false;

  const {data:override}=await service.from("user_permission_overrides")
    .select("allowed").eq("auth_user_id",caller.userId).eq("permission_id",perm.id).maybeSingle();
  if(override&&typeof override.allowed==="boolean") return override.allowed;

  const {data:rolePerm}=await service.from("role_permissions")
    .select("role_id").eq("role_id",caller.access.role_id).eq("permission_id",perm.id).maybeSingle();
  return Boolean(rolePerm);
}
async function permissionAllowedFirstDefined(service:any,caller:any,codes:string[]){
  if(caller.roleCode==="founder") return true;
  for(const code of codes){
    const {data:perm,error:permissionError}=await service.from("permissions").select("id").eq("code",code).maybeSingle();
    if(permissionError) throw permissionError;
    if(!perm?.id) continue;
    const {data:override,error:overrideError}=await service.from("user_permission_overrides")
      .select("allowed").eq("auth_user_id",caller.userId).eq("permission_id",perm.id).maybeSingle();
    if(overrideError) throw overrideError;
    if(override&&typeof override.allowed==="boolean") return override.allowed;
    const {data:rolePerm,error:rolePermissionError}=await service.from("role_permissions")
      .select("role_id").eq("role_id",caller.access.role_id).eq("permission_id",perm.id).maybeSingle();
    if(rolePermissionError) throw rolePermissionError;
    return Boolean(rolePerm);
  }
  return false;
}
async function requirePermission(service:any,caller:any,code:string){
  if(!(await permissionAllowed(service,caller,code))) throw new Error("没有执行此操作的权限");
}

async function canAccessEmployee(service:any,caller:any,employee:any){
  if(caller.roleCode==="founder"||caller.access.data_scope==="all") return true;
  if(caller.access.data_scope==="self") return Boolean(caller.access.employee_id&&caller.access.employee_id===employee.id);
  if(caller.access.data_scope==="assigned_teams"){
    const [{data:ts},{data:es}]=await Promise.all([
      service.from("user_scope_teams").select("team_id").eq("auth_user_id",caller.userId),
      service.from("user_scope_employees").select("employee_id").eq("auth_user_id",caller.userId),
    ]);
    return (ts||[]).some((x:any)=>x.team_id===employee.team_id)||(es||[]).some((x:any)=>x.employee_id===employee.id);
  }
  if(caller.access.data_scope==="own_team"&&caller.access.employee_id){
    const {data:me}=await service.from("employees").select("team_id").eq("id",caller.access.employee_id).maybeSingle();
    return Boolean(me?.team_id&&me.team_id===employee.team_id);
  }
  return false;
}

async function visibleEmployeeConflict(service:any,caller:any,conflict:any){
  const id=text(conflict?.id||conflict?.employee_id);
  if(!id) return null;
  const {data:employee,error}=await service.from("employees")
    .select("id,employee_no,full_name,status,resign_date,team_id")
    .eq("id",id).maybeSingle();
  if(error) throw error;
  return employee&&await canAccessEmployee(service,caller,employee)?conflict:null;
}

async function fetchAllRows(queryFactory:()=>any,batchSize=750,hardLimit=30000){
  const rows:any[]=[];
  for(let offset=0;offset<hardLimit;offset+=batchSize){
    const {data,error}=await queryFactory().range(offset,offset+batchSize-1);
    if(error) throw error;
    const batch=data||[];
    rows.push(...batch);
    if(batch.length<batchSize) break;
  }
  return rows;
}

async function scopedEmployeeIds(service:any,caller:any){
  if(caller.roleCode==="founder"||caller.access.data_scope==="all") return null;
  if(caller.access.data_scope==="self"){
    return new Set(caller.access.employee_id?[caller.access.employee_id]:[]);
  }
  if(caller.access.data_scope==="own_team"&&caller.access.employee_id){
    const {data:me,error}=await service.from("employees").select("team_id").eq("id",caller.access.employee_id).maybeSingle();
    if(error) throw error;
    if(!me?.team_id) return new Set<string>();
    const rows=await fetchAllRows(()=>service.from("employees").select("id").eq("team_id",me.team_id).order("id"));
    return new Set(rows.map((row:any)=>row.id));
  }
  if(caller.access.data_scope==="assigned_teams"){
    const [{data:teamRows,error:teamError},{data:employeeRows,error:employeeError}]=await Promise.all([
      service.from("user_scope_teams").select("team_id").eq("auth_user_id",caller.userId),
      service.from("user_scope_employees").select("employee_id").eq("auth_user_id",caller.userId),
    ]);
    if(teamError) throw teamError;
    if(employeeError) throw employeeError;
    const ids=new Set<string>((employeeRows||[]).map((row:any)=>row.employee_id));
    const teamIds=(teamRows||[]).map((row:any)=>row.team_id).filter(Boolean);
    if(teamIds.length){
      const rows=await fetchAllRows(()=>service.from("employees").select("id").in("team_id",teamIds).order("id"));
      for(const row of rows) ids.add(row.id);
    }
    return ids;
  }
  return new Set<string>();
}

async function assertTargetTeamAllowed(service:any,caller:any,targetTeamId:string,existingEmployee:any=null){
  if(caller.roleCode==="founder"||caller.access.data_scope==="all") return;
  if(caller.access.data_scope==="self") throw new Error("仅本人范围不能新增或编辑员工档案");
  if(!targetTeamId) throw new Error("当前管理范围要求员工必须归属可管理团队");
  if(caller.access.data_scope==="own_team"&&caller.access.employee_id){
    const {data:me,error}=await service.from("employees").select("team_id").eq("id",caller.access.employee_id).maybeSingle();
    if(error) throw error;
    if(!me?.team_id||me.team_id!==targetTeamId) throw new Error("不能把员工新增或移动到负责团队之外");
    return;
  }
  if(caller.access.data_scope==="assigned_teams"){
    const [{data:team},{data:explicitEmployee}]=await Promise.all([
      service.from("user_scope_teams").select("team_id").eq("auth_user_id",caller.userId).eq("team_id",targetTeamId).maybeSingle(),
      existingEmployee?.id
        ? service.from("user_scope_employees").select("employee_id").eq("auth_user_id",caller.userId).eq("employee_id",existingEmployee.id).maybeSingle()
        : Promise.resolve({data:null}),
    ]);
    const explicitlyAssignedAndUnmoved=Boolean(explicitEmployee?.employee_id&&existingEmployee?.team_id===targetTeamId);
    if(!team?.team_id&&!explicitlyAssignedAndUnmoved) throw new Error("不能把员工新增或移动到指定范围之外");
    return;
  }
  throw new Error("当前账号没有员工数据范围");
}

export function teamWriteDecision(value:unknown){
  const patch=isRecord(value)?value:{};
  const provided=owns(patch,"team_id");
  return {provided,teamId:provided?text(patch.team_id):""};
}

async function resolveTeamForWrite(service:any,caller:any,id:unknown,existingEmployee:any=null){
  const tid=text(id);
  if(!tid){
    await assertTargetTeamAllowed(service,caller,"",existingEmployee);
    return null;
  }
  const {data:team,error}=await service.from("teams").select("id,name").eq("id",tid).maybeSingle();
  if(error) throw error;
  if(!team?.id) throw new Error("请选择已经存在且在负责范围内的团队");
  await assertTargetTeamAllowed(service,caller,team.id,existingEmployee);
  return team;
}

async function findOrCreatePosition(service:any,id:unknown,name:unknown){
  const pid=text(id);
  if(pid){
    const {data:byId,error}=await service.from("positions").select("id,name").eq("id",pid).maybeSingle();
    if(error) throw error;
    if(byId?.id) return byId;
  }
  const n=text(name);if(!n)return null;
  const {data:found,error:fe}=await service.from("positions").select("id,name").ilike("name",n).limit(1).maybeSingle();
  if(fe) throw fe;
  if(found?.id) return found;
  const {data:created,error:ce}=await service.from("positions").insert({name:n,status:"active"}).select("id,name").single();
  if(ce) throw ce;
  return created;
}

const EMPLOYEE_FIELDS="id,employee_no,full_name,country,nationality,employment_type,team_id,position_id,status,market_country,market_position,shift_name,legacy_shift_name,work_tg,backend_accounts,hire_date,resign_date,last_location,return_date,home_date,source_type,source_sheet,profile_status,official_id_pending";
const CONTACT_FIELDS="employee_id,work_email,telegram_username,zoom_email,facebook,whatsapp_phone,source_sheet,updated_at";
const COMP_FIELDS="employee_id,base_salary,daily_rate,performance_default,meal_allowance,currency,effective_from,note,updated_by,updated_at";
const PAYMENT_FIELDS="employee_id,payment_mode,payment_mode_source,transfer_using,gcash_account,gcash_name,usdt_address,contact_phone,whatsapp_number,employee_address,source_sheet,updated_at";

async function getRawBundle(service:any,employeeId:string){
  const [{data:employee,error:ee},{data:contact},{data:compensation},{data:payment}]=await Promise.all([
    service.from("employees").select(EMPLOYEE_FIELDS).eq("id",employeeId).maybeSingle(),
    service.from("employee_contact_profiles").select(CONTACT_FIELDS).eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_compensation_settings").select(COMP_FIELDS).eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_payment_profiles").select(PAYMENT_FIELDS).eq("employee_id",employeeId).maybeSingle(),
  ]);
  if(ee) throw ee;
  return {employee,contact,compensation,payment};
}

async function restoreProfile(service:any,table:string,employeeId:string,before:any){
  if(before){
    const {error}=await service.from(table).upsert(before,{onConflict:"employee_id"});
    if(error) throw error;
  }else{
    const {error}=await service.from(table).delete().eq("employee_id",employeeId);
    if(error) throw error;
  }
}

async function rollbackUpdate(service:any,before:any,eventSourceKey:string){
  const e=before.employee;
  if(e){
    const {id,...patch}=e;
    const {error}=await service.from("employees").update(patch).eq("id",id);
    if(error) throw error;
    await Promise.all([
      restoreProfile(service,"employee_contact_profiles",id,before.contact),
      restoreProfile(service,"employee_compensation_settings",id,before.compensation),
      restoreProfile(service,"employee_payment_profiles",id,before.payment),
    ]);
  }
  if(eventSourceKey){
    await service.from("employee_lifecycle_events").delete().eq("source_key",eventSourceKey);
  }
}

async function rollbackCreate(service:any,employeeId:string){
  for(const table of ["employee_contact_profiles","employee_payment_profiles","employee_compensation_settings","employee_lifecycle_events","user_scope_employees"]){
    const {error}=await service.from(table).delete().eq("employee_id",employeeId);
    if(error) throw error;
  }
  const {error}=await service.from("employees").delete().eq("id",employeeId);
  if(error) throw error;
}

async function saveProfiles(service:any,caller:any,employee:any,body:any,options:{before:any}){
  const contact=isRecord(body.contact)?body.contact:{};
  const comp=isRecord(body.compensation)?body.compensation:{};
  const payment=isRecord(body.payment)?body.payment:{};
  const before=options.before||{};
  const now=new Date().toISOString();
  const jobs:any[]=[];

  const contactFields=["work_email","telegram_username","zoom_email","facebook","whatsapp_phone"];
  const contactKeys=contactFields.filter(k=>owns(contact,k));
  assertFieldsNotMasked(contact,contactFields,"联系方式");
  if(contactKeys.length){
    const canEditContact=await permissionAllowedFirstDefined(service,caller,["sensitive.employee.edit","sensitive.employee.view"]);
    if(!canEditContact) throw new Error("没有修改员工敏感联系方式的权限");
    const contactRow:any={employee_id:employee.id,source_sheet:"WFH后台",updated_at:now};
    for(const key of contactKeys) contactRow[key]=nullable(contact[key]);
    jobs.push(service.from("employee_contact_profiles").upsert(contactRow,{onConflict:"employee_id"}));
  }

  const type=typeLabel(employee.employment_type);
  const phpHome=type==="纯居家菲律宾";
  const onsite=type==="现场转居家";
  const compFields=["base_salary","daily_rate","performance_default","meal_allowance","note"];
  const compKeys=compFields.filter(k=>owns(comp,k));
  assertFieldsNotMasked(comp,compFields,"工资资料");
  if(compKeys.length){
    const canEditCompensation=await permissionAllowed(service,caller,"employee.compensation.edit");
    if(!canEditCompensation) throw new Error("没有修改员工工资资料的权限");
    const current=before.compensation||{};
    const monthly=owns(comp,"base_salary")?numberOrNull(comp.base_salary):numberOrNull(current.base_salary);
    const daily=owns(comp,"daily_rate")?numberOrNull(comp.daily_rate):numberOrNull(current.daily_rate);
    if(phpHome&&monthly!==null&&daily!==null) throw new Error("纯居家菲律宾工资只能选择月薪制或日薪制，不能同时填写");

    const compRow:any={
      employee_id:employee.id,
      currency:phpHome?"PHP":"USD",
      effective_from:employee.hire_date||null,
      updated_by:caller.userId,
      updated_at:now,
    };
    if(owns(comp,"base_salary")) compRow.base_salary=numberOrNull(comp.base_salary);
    if(owns(comp,"daily_rate")) compRow.daily_rate=phpHome?numberOrNull(comp.daily_rate):null;
    if(owns(comp,"performance_default")) compRow.performance_default=phpHome?null:numberOrNull(comp.performance_default);
    if(owns(comp,"meal_allowance")) compRow.meal_allowance=onsite?numberOrNull(comp.meal_allowance):null;
    if(owns(comp,"note")) compRow.note=nullable(comp.note);
    jobs.push(service.from("employee_compensation_settings").upsert(compRow,{onConflict:"employee_id"}));
  }

  const paymentFields=["mode","payment_mode","transfer_using","bank_wallet_account","account_name","usdt_address","contact_phone","whatsapp_number","employee_address"];
  const paymentKeys=paymentFields.filter(k=>owns(payment,k));
  assertFieldsNotMasked(payment,paymentFields,"收款资料");
  if(paymentKeys.length){
    const allowed=await permissionAllowedFirstDefined(service,caller,["sensitive.payout.edit","sensitive.payment.edit"]);
    if(!allowed) throw new Error("没有修改敏感收款资料的权限");

    const current=before.payment||{};
    const modeProvided=owns(payment,"mode")||owns(payment,"payment_mode");
    const mode=modeProvided
      ? (text(owns(payment,"mode")?payment.mode:payment.payment_mode)||"unknown")
      : (text(current.payment_mode)||"unknown");
    const paymentRow:any={
      employee_id:employee.id,
      payment_mode_source:"WFH后台",
      // 现场转居家的收款资料属于「现场转居家」本页；其他居家类型仍属于「银行信息」。
      source_sheet:onsite?"现场转居家":"银行信息",
      updated_at:now,
    };
    if(modeProvided) paymentRow.payment_mode=mode;
    if(owns(payment,"transfer_using")) paymentRow.transfer_using=nullable(payment.transfer_using);
    if(owns(payment,"bank_wallet_account")) paymentRow.gcash_account=mode==="bank_wallet"?nullable(payment.bank_wallet_account):null;
    if(owns(payment,"account_name")) paymentRow.gcash_name=mode==="bank_wallet"?nullable(payment.account_name):null;
    if(owns(payment,"usdt_address")) paymentRow.usdt_address=mode==="usdt"?nullable(payment.usdt_address):null;
    if(owns(payment,"contact_phone")) paymentRow.contact_phone=nullable(payment.contact_phone);
    if(owns(payment,"whatsapp_number")) paymentRow.whatsapp_number=nullable(payment.whatsapp_number);
    if(owns(payment,"employee_address")) paymentRow.employee_address=nullable(payment.employee_address);
    if(modeProvided&&mode==="bank_wallet") paymentRow.usdt_address=null;
    if(modeProvided&&mode==="usdt"){
      paymentRow.gcash_account=null;
      paymentRow.gcash_name=null;
    }
    jobs.push(service.from("employee_payment_profiles").upsert(paymentRow,{onConflict:"employee_id"}));
  }

  const settled=await Promise.all(jobs);
  for(const r of settled) if(r.error) throw r.error;
}

async function buildSheetPayload(service:any,employeeId:string,changeAction:string,previousFullName:string,previousEmployeeNo:string){
  const [{data:e,error:ee},{data:c},{data:comp},{data:p},{data:teamRow},{data:positionRow}]=await Promise.all([
    service.from("employees").select(EMPLOYEE_FIELDS).eq("id",employeeId).single(),
    service.from("employee_contact_profiles").select(CONTACT_FIELDS).eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_compensation_settings").select(COMP_FIELDS).eq("employee_id",employeeId).maybeSingle(),
    service.from("employee_payment_profiles").select(PAYMENT_FIELDS).eq("employee_id",employeeId).maybeSingle(),
    service.from("employees").select("teams:team_id(name)").eq("id",employeeId).single(),
    service.from("employees").select("positions:position_id(name)").eq("id",employeeId).single(),
  ]);
  if(ee) throw ee;

  return {
    action:"upsert_employee",
    change_action:changeAction,
    previous_employee_no:previousEmployeeNo||"",
    previous_full_name:previousFullName||"",
    employee:{
      employee_no:e.employee_no,
      full_name:e.full_name,
      country:e.country,
      nationality:e.nationality,
      employment_type:e.employment_type,
      status:e.status,
      market_country:e.market_country,
      market_position:e.market_position,
      position:positionRow?.positions?.name||null,
      team:teamRow?.teams?.name||null,
      shift_name:e.shift_name,
      hire_date:e.hire_date,
      resign_date:e.resign_date,
      work_tg:e.work_tg,
      backend_accounts:e.backend_accounts,
      last_location:e.last_location,
      return_date:e.return_date,
      home_date:e.home_date,
    },
    contact:c||{},
    compensation:comp||{},
    payment:{
      ...(p||{}),
      mode:text(p?.payment_mode),
      bank_wallet_account:text(p?.gcash_account),
      account_name:text(p?.gcash_name),
    },
    resign_reason:null,
  };
}

function canonicalizeGooglePayload(value:unknown,stripEnvelope=false):unknown{
  if(Array.isArray(value)) return value.map(item=>canonicalizeGooglePayload(item));
  if(!isRecord(value)) return value;
  const result:Record<string,unknown>={};
  for(const key of Object.keys(value).sort()){
    if((stripEnvelope&&(key==="request_id"||key==="idempotency_key"))||value[key]===undefined) continue;
    result[key]=canonicalizeGooglePayload(value[key]);
  }
  return result;
}

export async function googleSyncIdempotencyKey(payload:unknown){
  const encoded=new TextEncoder().encode(JSON.stringify(canonicalizeGooglePayload(payload,true)));
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoded));
  const hex=Array.from(digest,byte=>byte.toString(16).padStart(2,"0")).join("");
  return `staff-sheet-v1:${hex}`;
}

export function buildGoogleSyncEnvelope(payload:unknown,requestId:string,idempotencyKey:string){
  const base=isRecord(payload)?canonicalizeGooglePayload(payload,true) as Record<string,unknown>:{};
  return {...base,request_id:requestId,idempotency_key:idempotencyKey};
}

async function sendSheet(payload:any){
  const url=Deno.env.get("GOOGLE_STAFF_SYNC_URL")||"";
  const secret=Deno.env.get("STAFF_SHEET_SYNC_SECRET")||"";
  if(!url||!secret) return {ok:false,skipped:true,error:"Google staff sync is not configured"};
  const requestId=crypto.randomUUID();
  const idempotencyKey=await googleSyncIdempotencyKey(payload);
  const requestBody=buildGoogleSyncEnvelope(payload,requestId,idempotencyKey);
  const controller=new AbortController();
  const timeoutId=setTimeout(()=>controller.abort(),GOOGLE_SYNC_TIMEOUT_MS);
  try{
    const resp=await fetch(url,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({...requestBody,secret}),
      signal:controller.signal,
    });
    const body=await resp.json().catch(()=>({}));
    const ok=resp.ok&&body?.ok===true&&!body?.error;
    return {ok,status:resp.status,body,error:ok?null:text(body?.error),request_id:requestId,idempotency_key:idempotencyKey};
  }catch(e){
    const timedOut=e instanceof Error&&e.name==="AbortError";
    return {ok:false,error:timedOut?"google_sync_timeout":e instanceof Error?e.message:String(e),request_id:requestId,idempotency_key:idempotencyKey};
  }finally{
    clearTimeout(timeoutId);
  }
}

function auditBundleView(bundle:any):Record<string,unknown>{
  const e=bundle?.employee||{};
  const c=bundle?.contact||{};
  const comp=bundle?.compensation||{};
  const pay=bundle?.payment||{};
  return {
    employee_no:e.employee_no??null,
    full_name:e.full_name??null,
    country:e.country??null,
    employment_type:e.employment_type??null,
    team_id:e.team_id??null,
    position_id:e.position_id??null,
    market_country:e.market_country??null,
    market_position:e.market_position??null,
    shift_name:e.shift_name??null,
    work_tg:e.work_tg??null,
    backend_accounts:e.backend_accounts??null,
    hire_date:e.hire_date??null,
    resign_date:e.resign_date??null,
    "contact.work_email":c.work_email??null,
    "contact.telegram_username":c.telegram_username??null,
    "contact.zoom_email":c.zoom_email??null,
    "contact.facebook":c.facebook??null,
    "contact.whatsapp_phone":c.whatsapp_phone??null,
    "compensation.base_salary":comp.base_salary??null,
    "compensation.daily_rate":comp.daily_rate??null,
    "compensation.performance_default":comp.performance_default??null,
    "compensation.meal_allowance":comp.meal_allowance??null,
    "payment.mode":pay.payment_mode??null,
    "payment.transfer_using":pay.transfer_using??null,
    "payment.gcash_account":pay.gcash_account??null,
    "payment.gcash_name":pay.gcash_name??null,
    "payment.usdt_address":pay.usdt_address??null,
    "payment.contact_phone":pay.contact_phone??null,
    "payment.whatsapp_number":pay.whatsapp_number??null,
    "payment.employee_address":pay.employee_address??null,
  };
}

function auditChanges(beforeBundle:any,afterBundle:any){
  const before=auditBundleView(beforeBundle||{});
  const after=auditBundleView(afterBundle||{});
  const keys=Array.from(new Set([...Object.keys(before),...Object.keys(after)]));
  const changes:any={};
  for(const key of keys){
    const a=before[key]??null,b=after[key]??null;
    if(JSON.stringify(a)!==JSON.stringify(b)) changes[key]={before:a,after:b};
  }
  return changes;
}

async function writeAudit(service:any,caller:any,row:any){
  try{
    const {error}=await service.from("employee_audit_logs").insert({
      employee_id:row.employee_id||null,
      employee_no:text(row.employee_no)||null,
      full_name:text(row.full_name)||null,
      action:text(row.action)||"update",
      source:text(row.source)||"backend",
      actor_user_id:caller?.userId||null,
      actor_username:text(caller?.loginUsername)||text(row.actor_username)||"后台账号",
      changes:row.changes||{},
      metadata:row.metadata||{},
      created_at:new Date().toISOString(),
    });
    if(error){console.error("audit log write failed",error);return false;}
    return true;
  }catch(e){console.error("audit log write failed",e);return false;}
}

function redactAuditObject(value:any,canViewContact:boolean,canViewPayroll:boolean,canViewPayment:boolean,keyHint=""):any{
  const pathSegments=keyHint.split(".").map(segment=>segment.trim()).filter(Boolean);
  const contactSensitive=pathSegments.includes("contact")||pathSegments.includes("work_tg")||pathSegments.includes("backend_accounts");
  const payrollSensitive=pathSegments.includes("compensation");
  const paymentSensitive=pathSegments.includes("payment");
  if(contactSensitive&&!canViewContact) return "***";
  if(payrollSensitive&&!canViewPayroll) return "***";
  if(paymentSensitive&&!canViewPayment) return "***";
  if(value===null||value===undefined) return value;
  if(Array.isArray(value)) return value.map((item)=>redactAuditObject(item,canViewContact,canViewPayroll,canViewPayment,keyHint));
  if(typeof value!=="object") return value;
  const out:any={};
  for(const [key,item] of Object.entries(value)){
    const nextHint=keyHint?`${keyHint}.${key}`:key;
    out[key]=redactAuditObject(item,canViewContact,canViewPayroll,canViewPayment,nextHint);
  }
  return out;
}

function applyAuditFilters(q:any,f:any){
  if(text(f.employee_no)) q=q.ilike("employee_no",`%${text(f.employee_no)}%`);
  if(text(f.full_name)) q=q.ilike("full_name",`%${text(f.full_name)}%`);
  if(text(f.action)) q=q.ilike("action",`%${text(f.action)}%`);
  if(text(f.actor)) q=q.ilike("actor_username",`%${text(f.actor)}%`);
  if(text(f.date_from)) q=q.gte("created_at",`${text(f.date_from)}T00:00:00`);
  if(text(f.date_to)) q=q.lte("created_at",`${text(f.date_to)}T23:59:59.999`);
  return q;
}

async function auditList(service:any,caller:any,body:any){
  const canView=caller.roleCode==="founder"
    || await permissionAllowed(service,caller,"employee.change_history.view");
  if(!canView) throw new Error("没有查看操作日志的权限");

  const page=Math.max(1,Number(body.page||1));
  const allowed=[20,50,100];
  const requested=Number(body.page_size||20);
  const pageSize=allowed.includes(requested)?requested:20;
  const from=(page-1)*pageSize;
  const to=from+pageSize-1;
  const f=body.filters||{};

  const fields="id,employee_id,employee_no,full_name,action,source,actor_user_id,actor_username,changes,metadata,created_at";
  const allowedIds=await scopedEmployeeIds(service,caller);
  let data:any[]=[];
  let count=0;
  if(allowedIds===null){
    let q=service.from("employee_audit_logs").select(fields,{count:"exact"}).gte("created_at",AUDIT_VISIBLE_FROM);
    q=applyAuditFilters(q,f);
    const result=await q.order("created_at",{ascending:false}).range(from,to);
    if(result.error) throw result.error;
    data=result.data||[];
    count=result.count||0;
  }else if(allowedIds.size){
    const scoped=await fetchAllRows(()=>{
      let q=service.from("employee_audit_logs").select(fields).gte("created_at",AUDIT_VISIBLE_FROM);
      q=applyAuditFilters(q,f);
      return q.order("created_at",{ascending:false}).order("id",{ascending:false});
    },750,30000);
    const filtered=scoped.filter((row:any)=>row.employee_id&&allowedIds.has(row.employee_id));
    count=filtered.length;
    data=filtered.slice(from,to+1);
  }

  const [canViewContact,canViewPayroll,canViewPayment]=await Promise.all([
    caller.roleCode==="founder"?true:permissionAllowed(service,caller,"sensitive.employee.view"),
    caller.roleCode==="founder"?true:permissionAllowed(service,caller,"employee.directory.compensation.view"),
    caller.roleCode==="founder"?true:permissionAllowed(service,caller,"sensitive.payment.view"),
  ]);
  data=data.map((row:any)=>({
    ...row,
    changes:redactAuditObject(row.changes,canViewContact,canViewPayroll,canViewPayment),
    metadata:redactAuditObject(row.metadata,canViewContact,canViewPayroll,canViewPayment),
  }));

  return {
    rows:data,
    total:count,
    page,
    page_size:pageSize,
    pages:Math.max(1,Math.ceil((count||0)/pageSize)),
  };
}

async function cancelNewHireAnyState(service:any,caller:any,body:any){
  await requirePermission(service,caller,"employee.delete");
  const employeeId=text(body.employee_id);
  const confirmNo=upper(body.confirm_employee_no);
  if(!employeeId) throw new Error("缺少 employee_id");

  const before=await getRawBundle(service,employeeId);
  const employee=before.employee;
  if(!employee) throw new Error("找不到员工");
  if(!(await canAccessEmployee(service,caller,employee))) throw new Error("找不到员工或无操作权限");
  if(upper(employee.employee_no)!==confirmNo) throw new Error("员工ID确认不一致");

  // 撤销入职的安全边界：
  // 1) 后台新增员工；或
  // 2) 入职日期仍是今天/未来（尚未正式开始上班），即使旧同步把 source_type 改成 google_sheet 也允许撤销。
  // 已经正式工作过的历史导入员工仍然禁止直接删除。
  let backendOrigin=text(employee.source_type)==="backend";
  if(!backendOrigin){
    const {data:backendJoin,error:backendJoinError}=await service.from("employee_lifecycle_events")
      .select("id")
      .eq("employee_id",employeeId)
      .eq("event_type","join")
      .eq("source","backend")
      .limit(1)
      .maybeSingle();
    if(backendJoinError) throw backendJoinError;
    backendOrigin=Boolean(backendJoin?.id);
  }
  const today=new Date().toISOString().slice(0,10);
  const hireDate=text(employee.hire_date).slice(0,10);
  const pendingHire=Boolean(/^\d{4}-\d{2}-\d{2}$/.test(hireDate)&&hireDate>=today);
  if(!backendOrigin&&!pendingHire){
    throw new Error("只有后台新增员工或尚未到入职日的新员工可以撤销入职；已正式工作的历史员工请保留离职档案。");
  }
  if(!["active","resigned"].includes(text(employee.status))){
    throw new Error("当前状态不允许撤销入职");
  }

  const {data:accessRows,error:accessError}=await service.from("user_access")
    .select("auth_user_id,employee_portal_enabled,active")
    .eq("employee_id",employeeId);
  if(accessError) throw accessError;
  if((accessRows||[]).length){
    throw new Error("该员工已经存在登录账号/权限记录，请先处理账号后再撤销入职");
  }

  const sheet=await sendSheet({
    action:"remove_employee",
    employee_no:employee.employee_no,
    full_name:employee.full_name,
  });
  if(!sheet.ok){
    throw new Error(`Google Sheet 删除失败，本次撤销没有执行：${text(sheet.error||sheet.body?.error||"unknown")}`);
  }

  await writeAudit(service,caller,{
    employee_id:employee.id,
    employee_no:employee.employee_no,
    full_name:employee.full_name,
    action:"cancel_hire",
    source:"backend",
    changes:{employee:{before:auditBundleView(before),after:null}},
    metadata:{previous_status:employee.status,google_sheet_removed:true,backend_origin:backendOrigin,pending_hire:pendingHire,hire_date:hireDate||null},
  });

  for(const table of [
    "employee_contact_profiles",
    "employee_payment_profiles",
    "employee_compensation_settings",
    "employee_compensation_legacy",
    "employee_lifecycle_events",
    "user_scope_employees"
  ]){
    const {error}=await service.from(table).delete().eq("employee_id",employeeId);
    if(error) throw error;
  }
  const {error:deleteError}=await service.from("employees").delete().eq("id",employeeId);
  if(deleteError) throw deleteError;

  return {ok:true,sheet};
}

export async function handleRequest(req:Request){
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json({error:"Method not allowed"},405);

  const service=createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {auth:{persistSession:false}}
  );

  try{
    const caller=await getCaller(req,service);
    const body=await req.json().catch(()=>({}));
    const action=text(body.action);

    if(action==="check_identity"){
      const canCheck=caller.roleCode==="founder"
        || await permissionAllowed(service,caller,"employee.directory.view")
        || await permissionAllowed(service,caller,"employee.create")
        || await permissionAllowed(service,caller,"employee.edit");
      if(!canCheck) throw new Error("没有查看员工重复检查的权限");
      let previousEmployeeNo=text(body.previous_employee_no);
      const employeeId=text(body.employee_id);
      if(employeeId){
        const {data:current,error:currentError}=await service.from("employees").select("id,employee_no,team_id").eq("id",employeeId).maybeSingle();
        if(currentError) throw currentError;
        if(!current||!(await canAccessEmployee(service,caller,current))) throw new Error("找不到员工或无查看权限");
        previousEmployeeNo=text(current?.employee_no);
      }
      const result=await checkIdentity(service,body.employee_no,body.full_name,employeeId,previousEmployeeNo);
      const idConflict=await visibleEmployeeConflict(service,caller,result.employee_no.conflict);
      const nameMatches=(await Promise.all((result.full_name.matches||[]).map((item:any)=>visibleEmployeeConflict(service,caller,item)))).filter(Boolean);
      const nameConflict=nameMatches[0]||null;
      result.employee_no.conflict=idConflict;
      result.full_name.conflict=nameConflict;
      result.full_name.matches=nameMatches;
      // Preserve duplicate prevention without exposing another team's identity.
      if(!result.employee_no.available&&!idConflict) result.employee_no.conflict={source:"reserved",status:"reserved"};
      if(!result.full_name.available&&!nameConflict) result.full_name.conflict={source:"reserved",status:"reserved"};
      result.full_name.has_active=nameMatches.some((item:any)=>item.status==="active");
      result.full_name.has_resigned=nameMatches.some((item:any)=>item.status==="resigned");
      result.full_name.has_historical=nameMatches.some((item:any)=>item.status==="historical");
      return json({ok:true,...result});
    }

    if(action==="get_master_position_options"){
      const canView=caller.roleCode==="founder"
        || await permissionAllowed(service,caller,"employee.directory.view")
        || await permissionAllowed(service,caller,"employee.create")
        || await permissionAllowed(service,caller,"employee.edit");
      if(!canView) throw new Error("没有读取岗位候选的权限");

      const sync=await sendSheet({action:"get_master_position_options"});
      if(!sync.ok) throw new Error(`正式 Google Sheet 岗位读取失败：${text(sync.error||sync.body?.error||"unknown")}`);

      const seen=new Set<string>();
      const rows:string[]=[];
      for(const raw of (Array.isArray(sync.body?.rows)?sync.body.rows:[])){
        const display=text(raw).replace(/\s+/g," ");
        const key=display.replace(/\s+/g,"").toUpperCase();
        if(!key||seen.has(key)) continue;
        seen.add(key);
        rows.push(display);
      }
      rows.sort((a,b)=>a.localeCompare(b,"zh-CN"));
      return json({ok:true,rows});
    }

    if(action==="audit_list") return json(await auditList(service,caller,body));
    if(action==="cancel_new_hire_any_state") return json(await cancelNewHireAnyState(service,caller,body));

    const create=action==="create_employee_full";
    const update=action==="update_employee_full";
    if(!create&&!update) return json({error:"unsupported action"},400);

    for(const section of ["employee","contact","compensation","payment"]){
      if(owns(body,section)) assertPayloadNotMasked(body[section],section);
    }

    await requirePermission(service,caller,create?"employee.create":"employee.edit");
    if(caller.roleCode!=="founder"&&caller.access.data_scope==="self"){
      throw new Error("仅本人范围不能新增或编辑员工档案");
    }

    const p=isRecord(body.employee)?body.employee:{};
    let before:any=null;
    let employeeId=text(body.employee_id);
    let previousEmployeeNo="";
    if(update){
      if(!employeeId) throw new Error("缺少 employee_id");
      before=await getRawBundle(service,employeeId);
      if(!before.employee) throw new Error("找不到员工");
      if(!(await canAccessEmployee(service,caller,before.employee))) throw new Error("找不到员工或无编辑权限");
      previousEmployeeNo=upper(before.employee.employee_no);
    }

    const employeeNo=upper(owns(p,"employee_no")?p.employee_no:before?.employee?.employee_no);
    const fullName=text(owns(p,"full_name")?p.full_name:before?.employee?.full_name);
    if(!employeeNo||!fullName) throw new Error("员工ID和姓名不能为空");
    if(employeeNo==="SYSTEM"||employeeNo==="ADMIN") throw new Error("SYSTEM / ADMIN 是系统保留ID");

    const identity=await checkIdentity(service,employeeNo,fullName,update?employeeId:"",previousEmployeeNo);
    if(identity.employee_no.conflict){
      const c=identity.employee_no.conflict;
      const visible=await visibleEmployeeConflict(service,caller,c);
      if(!visible) throw new Error(`员工ID ${employeeNo} 已被系统保留，不能重复。`);
      const history=c.source==="lifecycle_history"?"（历史记录）":"";
      throw new Error(`员工ID ${employeeNo} 已被 ${text(c.full_name)||"其他员工"} 使用${history}，不能重复。`);
    }
    if(identity.full_name.conflict){
      const c=identity.full_name.conflict;
      const visible=await visibleEmployeeConflict(service,caller,c);
      if(!visible) throw new Error(`姓名「${fullName}」已被系统保留，不能重复。`);
      const history=c.source==="lifecycle_history"||c.status==="historical"?"（历史记录）":c.status==="resigned"?"（离职记录）":"";
      const usedBy=text(c.employee_no)||"其他员工";
      throw new Error(`姓名「${fullName}」已被员工 ${usedBy} 使用${history}，姓名必须唯一，不能保存。`);
    }

    const teamDecision=teamWriteDecision(p);
    const teamProvided=teamDecision.provided;
    const positionProvided=create||owns(p,"position_id")||owns(p,"position_name");
    let team:any=null;
    let position:any=null;
    if(teamProvided){
      team=await resolveTeamForWrite(service,caller,teamDecision.teamId,before?.employee||null);
    }else if(create){
      // Scoped creators still need an explicit, existing team. Global writers may
      // leave it blank until the authoritative schedule sync assigns the team.
      await assertTargetTeamAllowed(service,caller,"",null);
    }else if(before?.employee?.team_id){
      const {data,error}=await service.from("teams").select("id,name").eq("id",before.employee.team_id).maybeSingle();
      if(error) throw error;
      team=data;
    }
    if(positionProvided){
      position=await findOrCreatePosition(service,p.position_id,p.position_name);
    }else if(before?.employee?.position_id){
      const {data,error}=await service.from("positions").select("id,name").eq("id",before.employee.position_id).maybeSingle();
      if(error) throw error;
      position=data;
    }

    const employeePatch:any={source_sheet:"WFH后台",updated_at:new Date().toISOString()};
    if(create||owns(p,"employee_no")) employeePatch.employee_no=employeeNo;
    if(create||owns(p,"full_name")) employeePatch.full_name=fullName;
    if(create||owns(p,"country")) employeePatch.country=nullable(p.country);
    if(create||owns(p,"nationality")||owns(p,"country")){
      employeePatch.nationality=nullable(owns(p,"nationality")?p.nationality:p.country);
    }
    for(const key of ["employment_type","market_position","hire_date","last_location","return_date","home_date"]){
      if(create||owns(p,key)) employeePatch[key]=nullable(p[key]);
    }
    if(teamProvided){
      employeePatch.team_id=team?.id||null;
    }
    if(create||owns(p,"market_country")) employeePatch.market_country=nullable(p.market_country);
    if(positionProvided) employeePatch.position_id=position?.id||null;

    const sensitiveEmployeeFields=["work_tg","backend_accounts"];
    const sensitiveEmployeeKeys=sensitiveEmployeeFields.filter(k=>owns(p,k));
    assertFieldsNotMasked(p,sensitiveEmployeeFields,"员工敏感资料");
    if(sensitiveEmployeeKeys.length){
      const allowed=await permissionAllowedFirstDefined(service,caller,["sensitive.employee.edit","sensitive.employee.view"]);
      if(!allowed) throw new Error("没有修改员工敏感资料的权限");
      for(const key of sensitiveEmployeeKeys) employeePatch[key]=nullable(p[key]);
    }

    let employee:any;
    if(create){
      const {data,error}=await service.from("employees").insert({
        employee_no:employeeNo,
        ...employeePatch,
        status:"active",
        shift_name:null,
        legacy_shift_name:null,
        source_type:"backend",
        profile_status:"backend_created",
        official_id_pending:false,
      }).select(EMPLOYEE_FIELDS).single();
      if(error) throw error;
      employee=data;employeeId=data.id;
    }else{
      const {data,error}=await service.from("employees").update(employeePatch).eq("id",employeeId).select(EMPLOYEE_FIELDS).single();
      if(error) throw error;
      employee=data;
    }

    let eventSourceKey="";
    try{
      await saveProfiles(service,caller,employee,body,{before});

      if(create&&employee.hire_date){
        eventSourceKey=`backend:${employee.id}:join:${employee.hire_date}`;
        const {error}=await service.from("employee_lifecycle_events").upsert({
          employee_id:employee.id,
          employee_no:employee.employee_no,
          full_name:employee.full_name,
          event_type:"join",
          effective_date:employee.hire_date,
          source:"backend",
          source_key:eventSourceKey,
          created_by:caller.userId,
          snapshot:{...employeePatch,position:position?.name||null,team:team?.name||null},
        },{onConflict:"source_key"});
        if(error) throw error;
      }

      if(update){
        eventSourceKey=`backend:${employee.id}:profile_update:${Date.now()}`;
        const {error}=await service.from("employee_lifecycle_events").insert({
          employee_id:employee.id,
          employee_no:employee.employee_no,
          full_name:employee.full_name,
          event_type:"profile_update",
          effective_date:new Date().toISOString().slice(0,10),
          source:"backend",
          source_key:eventSourceKey,
          created_by:caller.userId,
          snapshot:{...employeePatch,position:position?.name||null,team:team?.name||null},
        });
        if(error) throw error;
      }

      const sheetPayload=await buildSheetPayload(service,employee.id,create?"create":"update",text(body.previous_full_name),previousEmployeeNo);
      const sync=await sendSheet(sheetPayload);
      if(!sync.ok){
        if(create) await rollbackCreate(service,employee.id);
        else await rollbackUpdate(service,before,eventSourceKey);
        return json({
          error:`正式 Google Sheet 写入失败，${create?"本次新增已自动撤销":"本次修改已自动回滚"}：${text(sync.error||sync.body?.error||"unknown")}`,
          rolled_back:true,
          sync,
        },400);
      }

      let history_id_sync_warning=null;
      if(update&&previousEmployeeNo&&previousEmployeeNo!==employeeNo){
        const {error:historyIdError}=await service.from("employee_lifecycle_events")
          .update({employee_no:employeeNo}).eq("employee_id",employee.id);
        if(historyIdError){
          history_id_sync_warning=errorText(historyIdError);
          console.error("lifecycle employee_no normalization failed",historyIdError);
        }
      }

      const after=await getRawBundle(service,employee.id);
      await writeAudit(service,caller,{
        employee_id:employee.id,
        employee_no:employee.employee_no,
        full_name:employee.full_name,
        action:create?"employee_create":(previousEmployeeNo&&previousEmployeeNo!==employeeNo?"employee_id_edit":"employee_update"),
        source:"backend",
        changes:create?{employee:{before:null,after:auditBundleView(after)}}:auditChanges(before,after),
        metadata:{
          previous_employee_no:previousEmployeeNo||null,
          google_sheet_synced:true,
          google_status:sync?.status||200,
        },
      });

      return json({ok:true,employee_id:employee.id,sync,identity_warning:identity.full_name.matches||[],history_id_sync_warning});
    }catch(inner){
      try{
        if(create&&employee?.id) await rollbackCreate(service,employee.id);
        else if(update&&before) await rollbackUpdate(service,before,eventSourceKey);
      }catch(rollbackError){
        console.error("rollback failed",rollbackError);
      }
      throw inner;
    }
  }catch(e){
    console.error(e);
    return json({error:e instanceof Error?e.message:String(e)},400);
  }
}

if(import.meta.main) Deno.serve(handleRequest);
