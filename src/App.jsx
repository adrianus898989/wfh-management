import React,{useEffect,useState} from 'react'
import {Navigate,Route,Routes} from 'react-router-dom'
import {supabase,configured} from './lib/supabase'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import MfaPage from './pages/MfaPage'
import AdminEmployeesPage from './pages/AdminEmployeesPage'
import {AdminHome,StaffHome} from './pages/PortalPage'
import AppLayout from './components/AppLayout'

function Protected({children,requireBackend=false,requireStaff=false}){
 const [s,setS]=useState({loading:true,session:null,access:null})
 useEffect(()=>{let m=true;(async()=>{const {data:{session}}=await supabase.auth.getSession();if(!session){if(m)setS({loading:false,session:null,access:null});return}const {data:access}=await supabase.from('user_access').select('backend_enabled,employee_portal_enabled,active').eq('auth_user_id',session.user.id).single();if(m)setS({loading:false,session,access})})();return()=>{m=false}},[])
 if(s.loading)return <div className="center-screen">Loading...</div>
 if(!s.session)return <Navigate to="/login" replace/>
 if(!s.access?.active)return <Navigate to="/login" replace/>
 if(requireBackend&&!s.access.backend_enabled)return <Navigate to="/staff" replace/>
 if(requireStaff&&!s.access.employee_portal_enabled)return <Navigate to="/admin" replace/>
 return children
}
export default function App(){
 if(!configured)return <div className="center-screen"><div className="config-box"><h2>Supabase 尚未连接</h2><p>下一步配置 Project URL 与 Publishable Key。</p></div></div>
 return <Routes>
  <Route path="/" element={<Navigate to="/login" replace/>}/>
  <Route path="/login" element={<LoginPage/>}/>
  <Route path="/register" element={<RegisterPage/>}/>
  <Route path="/admin" element={<Protected requireBackend><AppLayout mode="admin"><AdminHome/></AppLayout></Protected>}/>
  <Route path="/admin/employees" element={<Protected requireBackend><AppLayout mode="admin"><AdminEmployeesPage/></AppLayout></Protected>}/>
  <Route path="/staff" element={<Protected requireStaff><AppLayout mode="staff"><StaffHome/></AppLayout></Protected>}/>
  <Route path="/security/mfa" element={<Protected><AppLayout mode="staff"><MfaPage/></AppLayout></Protected>}/>
  <Route path="*" element={<Navigate to="/login" replace/>}/>
 </Routes>
}
