import React,{useState} from 'react'
import {supabase} from '../lib/supabase'
export default function MfaPage(){
  const [factor,setFactor]=useState(null),[code,setCode]=useState(''),[msg,setMsg]=useState(''),[error,setError]=useState('')
  const enroll=async()=>{setError('');const {data,error}=await supabase.auth.mfa.enroll({factorType:'totp',friendlyName:'Google Authenticator'});if(error)return setError(error.message);setFactor(data)}
  const verify=async()=>{const {data:challenge,error:ce}=await supabase.auth.mfa.challenge({factorId:factor.id});if(ce)return setError(ce.message);const {error:ve}=await supabase.auth.mfa.verify({factorId:factor.id,challengeId:challenge.id,code});if(ve)return setError('验证码错误');setMsg('Google Authenticator 绑定成功')}
  return <div className="content-page"><div className="page-head"><div><p className="eyebrow">安全设置</p><h1>Google Authenticator</h1><p>扫描二维码后输入6位动态验证码。</p></div></div><div className="panel narrow">{!factor?<button className="primary-btn" onClick={enroll}>开始绑定</button>:<><div className="qr-wrap"><img src={factor.totp.qr_code}/><code>{factor.totp.secret}</code></div><input className="otp-input" value={code} maxLength={6} onChange={e=>setCode(e.target.value.replace(/\D/g,''))}/><button className="primary-btn" disabled={code.length!==6} onClick={verify}>验证并完成</button></>}{error&&<div className="error-box">{error}</div>}{msg&&<div className="success-note">{msg}</div>}</div></div>
}
