import React,{useMemo,useState} from 'react'
import {Link} from 'react-router-dom'
import {supabase,configured} from '../lib/supabase'
import AuthShell from '../components/AuthShell'
const tests=[['至少10个字符',p=>p.length>=10],['至少1个大写字母',p=>/[A-Z]/.test(p)],['至少1个小写字母',p=>/[a-z]/.test(p)],['至少1个数字',p=>/[0-9]/.test(p)],['至少1个特殊符号',p=>/[^A-Za-z0-9]/.test(p)]]
export default function RegisterPage(){
  const [f,setF]=useState({email:'',password:'',confirm:'',code:''}),[error,setError]=useState(''),[result,setResult]=useState(null),[loading,setLoading]=useState(false)
  const checks=useMemo(()=>tests.map(([label,fn])=>({label,ok:fn(f.password)})),[f.password]); const valid=checks.every(x=>x.ok)&&f.password===f.confirm&&f.email&&f.code
  const submit=async e=>{e.preventDefault();setError('');if(!configured)return setError('Supabase 尚未连接');if(!valid)return setError('请先完成密码要求');setLoading(true)
    const {data,error}=await supabase.functions.invoke('register-employee',{body:{email:f.email.trim().toLowerCase(),password:f.password,activation_code:f.code.trim().toUpperCase()}})
    setLoading(false); if(error)return setError('注册失败，请检查激活码'); if(data?.error)return setError(data.error); setResult(data)
  }
  if(result)return <AuthShell title="注册成功" subtitle="账号已绑定后台员工ID。"><div className="success-box"><div className="success-icon">✓</div><p><b>{result.employee_id}</b> · {result.employee_name}</p><Link className="primary-btn full" to="/login">去登录</Link></div></AuthShell>
  return <AuthShell title="员工注册" subtitle="填写邮箱、密码和专属激活码。"><form onSubmit={submit} className="auth-form"><label>登录邮箱<input type="email" value={f.email} onChange={e=>setF({...f,email:e.target.value})} required/></label><label>密码<input type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})} required/></label><label>确认密码<input type="password" value={f.confirm} onChange={e=>setF({...f,confirm:e.target.value})} required/></label><div className="password-rules">{checks.map(x=><div className={x.ok?'ok':'no'} key={x.label}>{x.ok?'✓':'○'} {x.label}</div>)}</div><label>员工激活码<input value={f.code} onChange={e=>setF({...f,code:e.target.value.toUpperCase()})} placeholder="A1B2C3-D4E5F6" required/></label><div className="helper">激活码自动匹配后台员工ID，无需自行填写员工ID。</div>{error&&<div className="error-box">{error}</div>}<button className="primary-btn full" disabled={!valid||loading}>{loading?'注册中...':'创建账号'}</button><div className="auth-links"><Link to="/login">返回登录</Link></div></form></AuthShell>
}
