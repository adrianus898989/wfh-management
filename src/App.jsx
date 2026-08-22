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
import AdminTrainingPage from './pages/AdminTrainingPage'
import StaffExamPage from './pages/StaffExamPage'
import { AdminHome, StaffHome, ComingSoon } from './pages/PortalPage'
import AppLayout from './components/AppLayout'

const FOUNDER_AUTH_USER_ID = '567e1c26-9ff7-4df2-a3bd-9b68e26d10c9'
const accessCache = new Map()

function Protected({ children, mode }) {
  const location = useLocation()
  const [state, setState] = useState({ loading:true, session:null, access:null, aal:null, error:'' })
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let alive = true
    let authSubscription
    const freshSession = async (force = false) => {
      const { data, error } = await supabase.auth.getSession()
      let session = data?.session || null
      if (!error && session && (force || Number(session.expires_at || 0) * 1000 - Date.now() < 10 * 60 * 1000)) {
        const refreshed = await supabase.auth.refreshSession(session)
        if (!refreshed.error && refreshed.data?.session) session = refreshed.data.session
      }
      return { session, error }
    }
    const bootstrap = async () => {
      const { session, error: sessionError } = await freshSession()
      if (sessionError) {
        if (alive) setState({ loading:false, session:null, access:null, aal:null, error:'登录状态读取失败，请检查网络后重试。' })
        return
      }
      if (!session) {
        if (alive) setState({ loading:false, session:null, access:null, aal:null, error:'' })
        return
      }
      // Founder 已经由 Supabase Auth 完成密码和用户 ID 校验。Founder 是系统锁定
      // 账号，数据库连接繁忙时不应因 user_access 暂时 503 而被送回登录页。
      let access = accessCache.get(session.user.id)
      if (session.user.id === FOUNDER_AUTH_USER_ID) {
        access = {
          backend_enabled: true,
          employee_portal_enabled: false,
          active: true,
          otp_required: false,
        }
      } else if (!access) {
        const result = await supabase.from('user_access')
          .select('backend_enabled,employee_portal_enabled,active,otp_required')
          .eq('auth_user_id', session.user.id)
          .maybeSingle()
        if (result.error) {
          if (alive) setState({ loading:false, session, access:null, aal:null, error:'权限验证暂时失败，请重试。登录状态仍为你保留。' })
          return
        }
        access = result.data
      }
      if (access) accessCache.set(session.user.id, access)
      let aal = null
      if (mode === 'admin' && access?.otp_required) {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
        aal = data?.currentLevel || null
      }
      if (alive) setState({ loading:false, session, access, aal, error:'' })
    }
    bootstrap()
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return
      if (event === 'SIGNED_OUT') {
        accessCache.clear()
        setState({ loading:false, session:null, access:null, aal:null, error:'' })
      } else if (session) setState(current => ({ ...current, session }))
    })
    authSubscription = data.subscription
    const recover = async () => {
      if (document.hidden || !navigator.onLine) return
      const { session } = await freshSession()
      if (alive && session) setState(current => ({ ...current, session, error:'' }))
    }
    const onVisible = () => { if (!document.hidden) recover() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', recover)
    window.addEventListener('focus', recover)
    return () => {
      alive = false
      authSubscription?.unsubscribe()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', recover)
      window.removeEventListener('focus', recover)
    }
  }, [mode, retryKey])

  if (state.loading) return <div className="center-screen">Loading...</div>
  if (state.error) return <div className="center-screen auth-retry"><div><strong>连接暂时不稳定</strong><p>{state.error}</p><button onClick={() => { setState(s => ({...s,loading:true,error:''})); setRetryKey(x=>x+1) }}>重新验证</button></div></div>
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
    <Route path="/admin/training" element={<Protected mode="admin"><AppLayout mode="admin"><AdminTrainingPage /></AppLayout></Protected>} />
    <Route path="/admin/payroll" element={<Protected mode="admin"><AppLayout mode="admin"><ModulePage module="payroll" /></AppLayout></Protected>} />
    <Route path="/admin/reports" element={<Protected mode="admin"><AppLayout mode="admin"><AdminReportsPage /></AppLayout></Protected>} />
    <Route path="/admin/users" element={<Protected mode="admin"><AppLayout mode="admin"><AdminUsersPage /></AppLayout></Protected>} />
    <Route path="/staff" element={<Protected mode="staff"><AppLayout mode="staff"><StaffHome /></AppLayout></Protected>} />
    <Route path="/staff/schedule" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的排班" /></AppLayout></Protected>} />
    <Route path="/staff/attendance" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的出勤" /></AppLayout></Protected>} />
    <Route path="/staff/payroll" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的工资" /></AppLayout></Protected>} />
    <Route path="/staff/exams" element={<Protected mode="staff"><AppLayout mode="staff"><StaffExamPage /></AppLayout></Protected>} />
    <Route path="/staff/requests" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title="我的申请" /></AppLayout></Protected>} />
    <Route path="*" element={<Navigate to="/staff/login" replace />} />
  </Routes>
}
