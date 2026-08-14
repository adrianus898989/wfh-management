import React from 'react'
import {Link,useNavigate} from 'react-router-dom'
import {supabase} from '../lib/supabase'
export default function AppLayout({mode,children}){const navigate=useNavigate();const logout=async()=>{await supabase.auth.signOut();navigate('/login')};return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">HS</div><div><strong>居家员工管理系统</strong><small>{mode==='admin'?'ADMIN BACK OFFICE':'EMPLOYEE PORTAL'}</small></div></div><nav><Link to={mode==='admin'?'/admin':'/staff'}>首页</Link>{mode==='admin'&&<Link to="/admin/employees">员工 / 激活码</Link>}<Link to="/security/mfa">Google Authenticator</Link></nav><button className="logout-btn" onClick={logout}>退出登录</button></aside><main className="main">{children}</main></div>}
