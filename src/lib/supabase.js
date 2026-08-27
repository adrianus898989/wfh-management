import { createClient } from '@supabase/supabase-js'
import { classifySessionFailure } from './sessionFailure.js'
import { readFunctionResponsePayload } from './functionErrors.js'
const url=import.meta.env.VITE_SUPABASE_URL
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const configured=Boolean(url&&key)
export const SESSION_IDLE_LIMIT_MS=24*60*60*1000
export const APP_SESSION_HEARTBEAT_MS=60*1000
export const APP_SESSION_RPC_TIMEOUT_MS=15*1000
export const SESSION_SETUP_TIMEOUT_MS=25*1000
export const SESSION_LOCAL_SIGNOUT_TIMEOUT_MS=4*1000
const appBasePath=String(import.meta.env.BASE_URL||'/').replace(/\/+$/,'')
const browserPath=typeof window==='undefined'?'':window.location.pathname
const appPath=appBasePath&&(browserPath===appBasePath||browserPath.startsWith(`${appBasePath}/`))
  ?browserPath.slice(appBasePath.length)||'/'
  :browserPath
const portal=appPath==='/admin'||appPath.startsWith('/admin/')?'admin':'staff'
const AUTH_STORAGE_KEY=`wfh-${portal}-auth-token`
const SESSION_ACTIVITY_KEY=`wfh_${portal}_session_last_activity`
const SESSION_NOTICE_KEY=`wfh_${portal}_session_notice`
let lastActivityWrite=0

export const touchSessionActivity=(force=false)=>{
  if(typeof window==='undefined')return
  const now=Date.now()
  if(!force&&now-lastActivityWrite<60*1000)return
  lastActivityWrite=now
  try{window.localStorage.setItem(SESSION_ACTIVITY_KEY,String(now))}catch(_){}
}
export const clearSessionActivity=()=>{
  if(typeof window!=='undefined'){
    try{window.localStorage.removeItem(SESSION_ACTIVITY_KEY)}catch(_){}
  }
  lastActivityWrite=0
}
export const isSessionIdleExpired=()=>{
  if(typeof window==='undefined')return false
  let last=0
  try{last=Number(window.localStorage.getItem(SESSION_ACTIVITY_KEY)||0)}catch(_){return false}
  if(!last){touchSessionActivity(true);return false}
  return Date.now()-last>=SESSION_IDLE_LIMIT_MS
}

export const setAppSessionNotice=(reason,requestedPortal=portal)=>{
  if(typeof window==='undefined')return
  try{window.sessionStorage.setItem(`wfh_${requestedPortal}_session_notice`,String(reason||''))}catch(_){}
}

export const consumeAppSessionNotice=(requestedPortal=portal)=>{
  if(typeof window==='undefined')return ''
  const key=requestedPortal===portal?SESSION_NOTICE_KEY:`wfh_${requestedPortal}_session_notice`
  try{
    const reason=window.sessionStorage.getItem(key)||''
    window.sessionStorage.removeItem(key)
    return reason
  }catch(_){return ''}
}

const authenticatedFetch=async(input,init)=>{
  const response=await fetch(input,init)
  if([400,401,403].includes(response.status)&&typeof window!=='undefined'){
    let body=''
    try{body=await response.clone().text()}catch(_){body=''}
    const failure=classifySessionFailure(response.status,body)
    if(failure.shouldCheck){
      window.dispatchEvent(new CustomEvent('wfh:auth-check-needed',{detail:{terminal:failure.terminal,reason:failure.reason}}))
    }
  }
  return response
}

export const supabase=configured?createClient(url,key,{
  // Admin and staff are often opened in two tabs on the same browser. Keeping
  // separate storage namespaces prevents either login replacing the other JWT.
  auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:AUTH_STORAGE_KEY},
  global:{fetch:authenticatedFetch},
}):null

const timeoutError=code=>Object.assign(new Error(code),{code})

export const withPromiseTimeout=(promise,ms,code='TIMEOUT')=>{
  let timer
  const timeout=new Promise((_,reject)=>{
    timer=globalThis.setTimeout(()=>reject(timeoutError(code)),ms)
  })
  return Promise.race([Promise.resolve(promise),timeout])
    .finally(()=>globalThis.clearTimeout(timer))
}

const timedAppSessionRpc=(client,name,args)=>{
  const controller=new AbortController()
  let timer
  const request=Promise.resolve(client.rpc(name,args).abortSignal(controller.signal))
    .catch(error=>({data:null,error}))
  const timeout=new Promise(resolve=>{
    timer=globalThis.setTimeout(()=>{
      controller.abort()
      resolve({data:null,error:timeoutError('APP_SESSION_TIMEOUT')})
    },APP_SESSION_RPC_TIMEOUT_MS)
  })
  return Promise.race([request,timeout])
    .finally(()=>globalThis.clearTimeout(timer))
}

export const claimAppSession=(requestedPortal=portal)=>timedAppSessionRpc(
  supabase,
  'app_session_claim',
  {p_portal:requestedPortal==='admin'?'admin':'staff'},
)

export const bootstrapAppSessionAccess=()=>timedAppSessionRpc(
  supabase,
  'app_session_bootstrap_access',
)

export const heartbeatAppSession=()=>timedAppSessionRpc(supabase,'app_session_heartbeat')

// Admin claims and heartbeats cross the Edge trust boundary so the gateway IP
// can refresh a five-minute session attestation before the database renews the
// matching five-minute lease. A temporary Edge outage returns a retryable
// error: it never actively revokes the local/Auth session, but it also cannot
// renew the server lease forever. Staff never calls this function.
export const guardAdminAppSession=async(method='claim')=>{
  let result
  try{
    result=await withPromiseTimeout(
      supabase.functions.invoke('admin-ip-guard',{
        body:{action:method==='claim'?'claim':'heartbeat'},
      }),
      APP_SESSION_RPC_TIMEOUT_MS,
      'APP_SESSION_TIMEOUT',
    )
  }catch(error){return {data:null,error}}

  const payload=await readFunctionResponsePayload(result)
  if(payload&&typeof payload.ok==='boolean')return {data:payload,error:null}
  return {data:null,error:result?.error||timeoutError('ADMIN_IP_GUARD_INVALID_RESPONSE')}
}

export const releaseAppSession=()=>timedAppSessionRpc(supabase,'app_session_release')

// Candidate cleanup is session-id scoped. With last-login-wins semantics the
// server normally accepts the new session and revokes the previous browser;
// this path remains for setup/network failures before a candidate is usable.
export const discardLocalAppSession=async()=>{
  clearSessionActivity()
  let result={error:null}
  try{
    result=await withPromiseTimeout(
      supabase.auth.signOut({scope:'local'}),
      SESSION_LOCAL_SIGNOUT_TIMEOUT_MS,
      'LOCAL_SIGNOUT_TIMEOUT',
    )
  }catch(error){
    result={error}
  }finally{
    // A network failure must not leave a rejected JWT trapped in a redirect
    // loop. The server session/lease expires independently; remove only this
    // portal's namespaced browser token.
    if(typeof window!=='undefined'){
      try{window.localStorage.removeItem(AUTH_STORAGE_KEY)}catch(_){}
    }
  }
  return result
}

export const signOutAppSession=async()=>{
  let releaseError=null
  try{
    const result=await releaseAppSession()
    releaseError=result.error||null
  }catch(error){releaseError=error}
  const signOutResult=await discardLocalAppSession()
  return {error:signOutResult?.error||null,releaseError}
}

const jwtSessionId=token=>{
  try{
    const encoded=String(token||'').split('.')[1]||''
    const padded=encoded.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(encoded.length/4)*4,'=')
    return JSON.parse(globalThis.atob(padded))?.session_id||''
  }catch(_){return ''}
}

// Uses the candidate JWT as a custom access token, so cleanup cannot release
// a different session already stored by this browser. The local session is
// cleared only after an exact session_id match.
export const cleanupCandidateAppSession=async accessToken=>{
  if(!configured||!accessToken)return {data:null,error:null}
  let releaseResult={data:null,error:null}
  try{
    const candidateClient=createClient(url,key,{accessToken:async()=>accessToken})
    releaseResult=await timedAppSessionRpc(candidateClient,'app_session_release')
  }catch(error){releaseResult={data:null,error}}

  const candidateSessionId=jwtSessionId(accessToken)
  if(candidateSessionId){
    try{
      const current=await withPromiseTimeout(supabase.auth.getSession(),2000,'SESSION_READ_TIMEOUT')
      if(jwtSessionId(current?.data?.session?.access_token)===candidateSessionId){
        await discardLocalAppSession()
      }
    }catch(_){}
  }
  return releaseResult
}

export const setAppSession=async tokens=>{
  const request=supabase.auth.setSession(tokens)
  try{
    const result=await withPromiseTimeout(request,SESSION_SETUP_TIMEOUT_MS,'SESSION_SETUP_TIMEOUT')
    if(result?.error||!result?.data?.session){
      await cleanupCandidateAppSession(tokens?.access_token)
    }
    return result
  }catch(error){
    // Auth does not expose an AbortSignal for setSession. If it finishes after
    // our deadline, run the same session_id-scoped cleanup once more.
    void request.then(
      ()=>cleanupCandidateAppSession(tokens?.access_token),
      ()=>cleanupCandidateAppSession(tokens?.access_token),
    ).catch(()=>{})
    await cleanupCandidateAppSession(tokens?.access_token)
    return {data:{session:null,user:null},error}
  }
}
