import React, { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { supabase, configured } from './lib/supabase'
import AdminLoginPage from './pages/AdminLoginPage'
import StaffLoginPage from './pages/StaffLoginPage'
import StaffRegisterPage from './pages/StaffRegisterPage'
import MfaPage from './pages/MfaPage'
import AdminEmployeesPage from './pages/AdminEmployeesPage'
import AdminUsersPage from './pages/AdminUsersPage'
import ModulePage from './pages/ModulePage'
import AdminReportsPage from './pages/AdminReportsPage'
import AdminDailyWorkPage from './pages/AdminDailyWorkPage'
import { AdminHome, StaffHome, ComingSoon } from './pages/PortalPage'
import AppLayout from './components/AppLayout'

function Protected({ children, mode }) {
  const location = useLocation()
  const [state, setState] = useState({ loading:true, session:null, access:null, aal:null })

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data:{ session } } = await supabase.auth.getSession()
      if (!session) {
        if (alive) setState({ loading:false, session:null, access:null, aal:null })
        return
      }
      const { data:access } = await supabase.from('user_access')
        .select('backend_enabled,employee_portal_enabled,active,otp_required')
        .eq('auth_user_id', session.user.id)
        .single()
      let aal = null
      if (mode === 'admin' && access?.otp_required) {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        aal = data?.currentLevel || null
      }
      if (alive) setState({ loading:false, session, access, aal })
    })()
    return () => { alive = false }
  }, [mode, location.pathname])

  if (state.loading) return <div className="center-screen">Loading...</div>
  const login = mode === 'admin' ? '/admin/login' : '/staff/login'
  if (!state.session || !state.access?.active) return <Navigate to={login} replace />
  if (mode === 'admin' && !state.access.backend_enabled) return <Navigate to="/admin/login" replace />
  if (mode === 'staff' && !state.access.employee_portal_enabled) return <Navigate to="/staff/login" replace />
  if (mode === 'admin' && state.access.otp_required && state.aal !== 'aal2' && location.pathname !== '/admin/mfa') return <Navigate to="/admin/mfa" replace />
  return children
}

export default function App() {
  if (!configured) return <div className="center-screen">暂时无法连接</div>
  return <Routes>
    <Route path="/" element={<Navigate to="/staff/login" replace />} />
    <Route path="/admin/login" element={<AdminLoginPage />} />
    <Route path="/staff/login" element={<StaffLoginPage />} />
    <Route path="/staff/register" element={<StaffRegisterPage />} />
    <Route path="/admin/mfa" element={<Protected mode="admin"><MfaPage /></Protected>} />
    <Route path="/admin" element={<Protected mode="admin"><AppLayout mode="admin"><AdminHome /></AppLayout></Protected>} />
    <Route path="/admin/employees" element={<Protected mode="admin"><AppLayout mode="admin"><AdminEmployeesPage /></AppLayout></Protected>} />
    <Route path="/admin/schedule" element={<Protected mode="admin"><AppLayout mode="admin"><ModulePage module="schedule" /></AppLayout></Protected>} />
    <Route path="/admin/daily" element={<Protected mode="admin"><AppLayout mode="admin"><AdminDailyWorkPage /></AppLayout></Protected>} />
    <Route path="/admin/training" element={<Protected mode="admin"><AppLayout mode="admin"><ModulePage module="training" /></AppLayout></Protected>} />
    <Route path="/admin/payroll" element={<Protected mode="admin"><AppLayout mode="admin"><ModulePage module="payroll" /></AppLayout></Protected>} />
    <Route path="/admin/reports" element={<Protected mode="admin"><AppLayout mode="admin"><AdminReportsPage /></AppLayout></Protected>} />
    <Route path="/admin/users" element={<Protected mode="admin"><AppLayout mode="admin"><AdminUsersPage /></AppLayout></Protected>} />
    <Route path="/staff" element={<Protected mode="staff"><AppLayout mode="staff"><StaffHome /></AppLayout></Protected>} />
    <Route path="/staff/schedule" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的排班" /></AppLayout></Protected>} />
    <Route path="/staff/attendance" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的出勤" /></AppLayout></Protected>} />
    <Route path="/staff/payroll" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的工资" /></AppLayout></Protected>} />
    <Route path="/staff/exams" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的考试" /></AppLayout></Protected>} />
    <Route path="/staff/requests" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的申请" /></AppLayout></Protected>} />
    <Route path="*" element={<Navigate to="/staff/login" replace />} />
  </Routes>
}
