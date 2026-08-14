import React,{useState} from 'react'
import {Link,useNavigate} from 'react-router-dom'
import {supabase,configured} from '../lib/supabase'
import AuthShell from '../components/AuthShell'
export default function LoginPage(){
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false); const navigate=useNavigate()
  const submit=async e=>{e.preventDefault();setError('');if(!configured)return setError('Supabase 尚未连接');setLoading(true)
    const {data,error}=await supabase.auth.signInWithPassword({email:email.trim().toLowerCase(),password})
    if(error){setLoading(false);return setError('邮箱或密码错误')}
    const {data:access}=await supabase.from('user_access').select('backend_enabled,employee_portal_enabled,active').eq('auth_user_id',data.user.id).single()
    setLoading(false)
    if(!access?.active){await supabase.auth.signOut();return setError('账号未启用')}
    if(access.backend_enabled)navigate('/admin'); else if(access.employee_portal_enabled)navigate('/staff'); else setError('账号未开启入口')
  }
  return <AuthShell title="登录" subtitle="使用邮箱与密码登录。"><form onSubmit={submit} className="auth-form"><label>邮箱<input type="email" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>密码<input type="password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div className="error-box">{error}</div>}<button className="primary-btn full" disabled={loading}>{loading?'登录中...':'登录'}</button><div className="auth-links"><span>还没有账号？</span><Link to="/register">员工注册</Link></div><div className="helper">忘记密码请联系有“重置密码”权限的管理人员。</div></form></AuthShell>
}
