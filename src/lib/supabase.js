import { createClient } from '@supabase/supabase-js'
const url=import.meta.env.VITE_SUPABASE_URL
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const configured=Boolean(url&&key)
export const SESSION_IDLE_LIMIT_MS=24*60*60*1000
const portal=typeof window!=='undefined'&&window.location.pathname.startsWith('/admin')?'admin':'staff'
const SESSION_ACTIVITY_KEY=`wfh_${portal}_session_last_activity`
let lastActivityWrite=0

export const touchSessionActivity=(force=false)=>{
  if(typeof window==='undefined')return
  const now=Date.now()
  if(!force&&now-lastActivityWrite<60*1000)return
  lastActivityWrite=now
  window.localStorage.setItem(SESSION_ACTIVITY_KEY,String(now))
}
export const clearSessionActivity=()=>{
  if(typeof window!=='undefined')window.localStorage.removeItem(SESSION_ACTIVITY_KEY)
  lastActivityWrite=0
}
export const isSessionIdleExpired=()=>{
  if(typeof window==='undefined')return false
  const last=Number(window.localStorage.getItem(SESSION_ACTIVITY_KEY)||0)
  if(!last){touchSessionActivity(true);return false}
  return Date.now()-last>=SESSION_IDLE_LIMIT_MS
}

const authenticatedFetch=async(input,init)=>{
  const response=await fetch(input,init)
  if(response.status===401&&typeof window!=='undefined'){
    let body=''
    try{body=await response.clone().text()}catch(_){body=''}
    const terminal=/invalid\s*(jwt|token)|jwt\s*(expired|malformed)|refresh\s*token|session\s*(missing|expired)|not\s*authenticated|no\s*authorization/i.test(body)
    window.dispatchEvent(new CustomEvent('wfh:auth-check-needed',{detail:{terminal}}))
  }
  return response
}

export const supabase=configured?createClient(url,key,{
  // Admin and staff are often opened in two tabs on the same browser. Keeping
  // separate storage namespaces prevents either login replacing the other JWT.
  auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:`wfh-${portal}-auth-token`},
  global:{fetch:authenticatedFetch},
}):null
