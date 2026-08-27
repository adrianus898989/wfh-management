import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadEffectiveEmployeeScope } from "../_shared/employeeScope.ts";

const corsHeaders={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...corsHeaders,"Content-Type":"application/json; charset=utf-8"}});
const text=(v:unknown)=>String(v??"").trim();
function jwtSessionId(token:string){try{const raw=token.split(".")[1]?.replace(/-/g,"+").replace(/_/g,"/")||"";const padded=raw+"=".repeat((4-raw.length%4)%4);return text(JSON.parse(atob(padded))?.session_id);}catch{return "";}}
async function requireCurrentAdminSession(service:any,userId:string,token:string){const sessionId=jwtSessionId(token);if(!sessionId)throw new Error("登录会话无效，请重新登录");const {data,error}=await service.from("app_session_leases").select("user_id").eq("user_id",userId).eq("session_id",sessionId).eq("portal","admin").gt("lease_expires_at",new Date().toISOString()).maybeSingle();if(error||!data?.user_id)throw new Error("此账号未持有当前设备登录权，请重新登录");}

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
  return {userId,access,roleCode:text(role?.code)};
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

async function allowedEmployeeIds(service:any,caller:any,requested:string[]){
  const scope=await loadEffectiveEmployeeScope(service,caller.userId,caller.access,caller.roleCode);
  if(scope.mode==="all") return requested;
  const allowed=new Set(scope.employeeIds);
  return requested.filter(id=>allowed.has(text(id)));
}

const genericActor=(v:unknown)=>{
  const s=text(v);
  return !s||["Google Sheet","Google Sheet（账号不可用）","Google Sheet（未登记操作人）","后台账号","后台历史账号"].includes(s);
};

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:corsHeaders});
  if(req.method!=="POST") return json({error:"Method not allowed"},405);
  const service=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
  try{
    const caller=await getCaller(req,service);
    if(!(await permissionAllowed(service,caller,"employee.directory.view"))) throw new Error("没有查看员工资料的权限");
    const body=await req.json().catch(()=>({}));
    const requested=Array.from(new Set((Array.isArray(body.employee_ids)?body.employee_ids:[]).map(text).filter(Boolean))).slice(0,500) as string[];
    if(!requested.length) return json({rows:[]});
    const ids=await allowedEmployeeIds(service,caller,requested);
    if(!ids.length) return json({rows:[]});

    const [{data:employees,error:employeeError},{data:joins,error:joinError},{data:audits,error:auditError}]=await Promise.all([
      service.from("employees").select("id,source_type,source_sheet,created_at").in("id",ids),
      service.from("employee_lifecycle_events").select("employee_id,created_by,snapshot,source,source_sheet,created_at").in("employee_id",ids).eq("event_type","join").order("created_at",{ascending:true}),
      service.from("employee_audit_logs").select("employee_id,actor_username,action,created_at").in("employee_id",ids).order("created_at",{ascending:false}),
    ]);
    if(employeeError) throw employeeError;
    if(joinError) throw joinError;
    if(auditError) throw auditError;

    const creatorIds=Array.from(new Set((joins||[]).map((x:any)=>text(x.created_by)).filter(Boolean)));
    let userMap=new Map<string,string>();
    if(creatorIds.length){
      const {data:users,error:userError}=await service.from("user_access").select("auth_user_id,login_username").in("auth_user_id",creatorIds.slice(0,500));
      if(userError) throw userError;
      userMap=new Map((users||[]).map((x:any)=>[text(x.auth_user_id),text(x.login_username)]));
    }

    const joinMap=new Map<string,any[]>();
    for(const r of joins||[]){const k=text(r.employee_id);if(!joinMap.has(k))joinMap.set(k,[]);joinMap.get(k)!.push(r);}
    const auditMap=new Map<string,any[]>();
    for(const r of audits||[]){const k=text(r.employee_id);if(!auditMap.has(k))auditMap.set(k,[]);auditMap.get(k)!.push(r);}

    const rows=(employees||[]).map((e:any)=>{
      const id=text(e.id);
      const js=joinMap.get(id)||[];
      const as=auditMap.get(id)||[];
      let actor="";
      let source="";

      const createAudit=as.find((x:any)=>["employee_create","google_employee_create"].includes(text(x.action))&&!genericActor(x.actor_username));
      if(createAudit){actor=text(createAudit.actor_username);source="audit_create";}

      if(!actor){
        const backendJoin=js.find((x:any)=>text(x.created_by)&&text(userMap.get(text(x.created_by))));
        if(backendJoin){actor=text(userMap.get(text(backendJoin.created_by)));source="lifecycle_creator";}
      }

      if(!actor){
        for(const j of js){
          const s=j?.snapshot||{};
          const candidate=text(s.operator_account)||text(s.operator_email)||text(s.last_edited_username);
          if(!genericActor(candidate)){actor=candidate;source="lifecycle_operator";break;}
        }
      }

      if(!actor){
        const recentAudit=as.find((x:any)=>!genericActor(x.actor_username));
        if(recentAudit){actor=text(recentAudit.actor_username);source="latest_audit";}
      }

      if(!actor){
        actor=text(e.source_type)==="backend"?"后台历史账号":"Google Sheet（未登记操作人）";
        source="fallback";
      }
      return {employee_id:id,operator_account:actor,operator_source:source};
    });
    return json({rows});
  }catch(e){
    console.error(e);
    return json({error:e instanceof Error?e.message:String(e)},400);
  }
});
