import React, { useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import {
  APP_SESSION_HEARTBEAT_MS,
  bootstrapAppSessionAccess,
  claimAppSession,
  clearSessionActivity,
  configured,
  discardLocalAppSession,
  heartbeatAppSession,
  isSessionIdleExpired,
  setAppSessionNotice,
  signOutAppSession,
  supabase,
  touchSessionActivity,
} from './lib/supabase'
import AdminLoginPage from './pages/AdminLoginPage'
import StaffLoginPage from './pages/StaffLoginPage'
import StaffRegisterPage from './pages/StaffRegisterPage'
import MfaPage from './pages/MfaPage'
import AdminEmployeesPage from './pages/AdminEmployeesPage'
import AdminUsersPage from './pages/AdminUsersPage'
import AdminAttendancePage from './pages/AdminAttendancePage'
import AdminReportsPage from './pages/AdminReportsPage'
import AdminDailyWorkPage from './pages/AdminDailyWorkPage'
import AdminTrainingPage from './pages/AdminTrainingPage'
import StaffExamPage from './pages/StaffExamPage'
import AdminPayrollPage from './pages/AdminPayrollPage'
import StaffPayrollPage from './pages/StaffPayrollPage'
import { AdminHome, StaffHome, ComingSoon } from './pages/PortalPage'
import AppLayout from './components/AppLayout'
import { StaffI18nProvider, useStaffLocale } from './lib/staffI18n'

const SESSION_VERIFICATION_FAILURE_LIMIT = 3
const SESSION_VERIFICATION_RETRY_BASE_MS = 1500

function Protected({ children, mode }) {
  const location = useLocation()
  const { t } = useStaffLocale()
  const [state, setState] = useState({ loading:true, session:null, access:null, aal:null, error:'' })
  const [retryKey, setRetryKey] = useState(0)
  const verificationFailures = useRef(0)
  const redirectingToLogin = useRef(false)

  useEffect(() => {
    let alive = true
    let authSubscription
    let bootstrapTimer
    let verificationTimer
    let leaseCheckPromise = null
    let bootstrapPromise = null
    let signOutPromise = null
    let redirectAfterSignOut = false
    let leaseOwned = false
    let leaseEligible = false
    const sessionCheckMessage = mode==='staff'
      ? t('auth.sessionCheckFailed','无法验证当前浏览器会话，请稍后重试。')
      : '无法验证当前浏览器会话，请稍后重试。'
    const replaceWithLogin = () => {
      if (redirectingToLogin.current || typeof window === 'undefined') return
      redirectingToLogin.current = true
      const base = new URL(import.meta.env.BASE_URL || '/', window.location.origin)
      window.location.replace(new URL(`${mode}/login`, base).href)
    }
    const localSignOut = ({ release=true, notice='', redirect=false } = {}) => {
      if (notice) setAppSessionNotice(notice, mode)
      if (redirect) redirectAfterSignOut = true
      if (signOutPromise) return signOutPromise
      signOutPromise = (async () => {
        leaseOwned = false
        leaseEligible = false
        if (release) await signOutAppSession()
        else await discardLocalAppSession()
        if (alive) setState({ loading:false, session:null, access:null, aal:null, error:'' })
      })().finally(() => {
        signOutPromise = null
        if (redirectAfterSignOut) replaceWithLogin()
      })
      return signOutPromise
    }
    const terminalAuthError = error => /refresh[_\s-]*token|invalid.*token|jwt|(?:auth[_\s-]*)?session.*missing|not[_\s-]*authenticated/i.test(error?.message || '')
    const freshSession = async (force = false) => {
      if (isSessionIdleExpired()) {
        await localSignOut({ release:true, redirect:true })
        return { session:null, error:null }
      }
      const { data, error } = await supabase.auth.getSession()
      if (terminalAuthError(error)) {
        await localSignOut({ release:false, notice:'session_ended', redirect:true })
        return { session:null, error:null }
      }
      let session = data?.session || null
      if (!error && session && (force || Number(session.expires_at || 0) * 1000 - Date.now() < 10 * 60 * 1000)) {
        const refreshed = await supabase.auth.refreshSession(session)
        if (!refreshed.error && refreshed.data?.session) session = refreshed.data.session
        else if (terminalAuthError(refreshed.error)) {
          await localSignOut({ release:false, notice:'session_ended', redirect:true })
          return { session:null, error:null }
        }
      }
      return { session, error }
    }
    const checkLease = (method = 'claim') => {
      if (leaseCheckPromise) return leaseCheckPromise
      leaseCheckPromise = Promise.resolve(
        method === 'heartbeat' ? heartbeatAppSession() : claimAppSession(mode),
      ).catch(error => ({ data:null, error }))
        .finally(() => { leaseCheckPromise = null })
      return leaseCheckPromise
    }
    const acceptLease = async (result) => {
      if (result?.error) return false
      if (!result?.data?.ok) {
        const reason = result?.data?.reason
        if (reason === 'mfa_required') return false
        await localSignOut({
          release:false,
          notice:mode==='staff' && (reason==='staff_account_not_found'||reason==='staff_account_missing')
            ? 'account_not_found'
            : reason==='active_elsewhere'||reason==='not_owner'
              ? 'active_elsewhere'
              : 'session_ended',
          redirect:true,
        })
        return false
      }
      leaseOwned = leaseEligible
      return true
    }
    const scheduleVerificationRetry = () => {
      window.clearTimeout(verificationTimer)
      if (!navigator.onLine) return
      const delay = Math.min(
        5000,
        SESSION_VERIFICATION_RETRY_BASE_MS * Math.max(1, verificationFailures.current),
      )
      verificationTimer = window.setTimeout(() => {
        if (alive && navigator.onLine) bootstrap(true)
      }, delay)
    }
    const markVerificationFailure = async message => {
      if (!alive) return
      if (!navigator.onLine) {
        setState(current => ({ ...current, loading:false, error:message }))
        return
      }
      verificationFailures.current += 1
      if (verificationFailures.current >= SESSION_VERIFICATION_FAILURE_LIMIT) {
        await localSignOut({ release:false, notice:'session_ended', redirect:true })
        return
      }
      setState(current => ({ ...current, loading:false, error:message }))
      scheduleVerificationRetry()
    }
    const bootstrap = (force = false) => {
      if (bootstrapPromise) return bootstrapPromise
      bootstrapPromise = (async () => {
        const { session, error: sessionError } = await freshSession(force)
        if (sessionError) {
          await markVerificationFailure(mode==='staff'?t('auth.readFailed','登录状态读取失败，请检查网络后重试。'):'登录状态读取失败，请检查网络后重试。')
          return
        }
        if (!session) {
          if (alive) setState({ loading:false, session:null, access:null, aal:null, error:'' })
          return
        }

        leaseEligible = false
        leaseOwned = false
        touchSessionActivity()

        // user_access is intentionally protected by the current-browser lease.
        // Use the narrow self-only bootstrap RPC before a lease exists, then
        // require MFA before an admin lease can be claimed.
        const accessResult = await bootstrapAppSessionAccess()
        if (accessResult?.error) {
          await markVerificationFailure(mode==='staff'?t('auth.accessFailed','权限验证暂时失败，请重试。登录状态仍为你保留。'):'权限验证暂时失败，请重试。登录状态仍为你保留。')
          return
        }
        if (!accessResult?.data?.ok) {
          await localSignOut({
            release:false,
            notice:mode==='staff' && (accessResult?.data?.reason==='staff_account_not_found'||accessResult?.data?.reason==='staff_account_missing')
              ? 'account_not_found'
              : accessResult?.data?.reason === 'auth_session_missing' ? 'session_ended' : '',
            redirect:true,
          })
          return
        }
        const access = accessResult.data.access || null

        if (mode==='staff' && access?.staff_account_exists===false) {
          await localSignOut({ release:false, notice:'account_not_found', redirect:true })
          return
        }

        const entryEnabled = mode==='admin'
          ? access?.backend_enabled
          : access?.employee_portal_enabled
        if (!access?.active || !entryEnabled) {
          await localSignOut({ release:false, redirect:true })
          return
        }

        let aal = null
        if (mode === 'admin' && access?.otp_required) {
          const aalResult = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
          if (aalResult.error) {
            await markVerificationFailure('安全验证状态读取失败，请重试。')
            return
          }
          aal = aalResult.data?.currentLevel || null
          if (aal !== 'aal2') {
            verificationFailures.current = 0
            if (alive) setState({ loading:false, session, access, aal, error:'' })
            return
          }
        }

        leaseEligible = true
        const leaseResult = await checkLease('claim')
        if (!(await acceptLease(leaseResult))) {
          leaseEligible = false
          leaseOwned = false
          if (leaseResult?.error || leaseResult?.data?.reason === 'mfa_required') {
            await markVerificationFailure(sessionCheckMessage)
          }
          return
        }
        verificationFailures.current = 0
        redirectingToLogin.current = false
        if (alive) setState({ loading:false, session, access, aal, error:'' })
      })().finally(() => { bootstrapPromise = null })
      return bootstrapPromise
    }
    bootstrap()
    const scheduleBootstrap = () => {
      window.clearTimeout(bootstrapTimer)
      // Avoid awaiting Supabase calls inside its auth callback. Re-run the full
      // access check on the next task so stale permissions never stay visible.
      bootstrapTimer = window.setTimeout(() => { bootstrap() }, 0)
    }
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return
      if (event === 'SIGNED_OUT') {
        leaseOwned = false
        leaseEligible = false
        clearSessionActivity()
        setState({ loading:false, session:null, access:null, aal:null, error:'' })
      } else if (session) {
        if (event === 'SIGNED_IN') touchSessionActivity(true)
        scheduleBootstrap()
      }
    })
    authSubscription = data.subscription
    const recover = (force = false) => {
      if (document.hidden || !navigator.onLine) return
      return bootstrap(force)
    }
    const heartbeat = async () => {
      if (!alive || !leaseEligible || !leaseOwned || !navigator.onLine) return
      const result = await checkLease('heartbeat')
      if (!leaseEligible) return
      if (!(await acceptLease(result)) && result?.error) {
        await markVerificationFailure(sessionCheckMessage)
      }
    }
    const onVisible = () => { if (!document.hidden) recover() }
    const onOnline = () => recover()
    const onFocus = () => recover()
    const onActivity = () => touchSessionActivity()
    const onAuthCheck = event => event?.detail?.terminal
      ? localSignOut({ release:false, notice:'session_ended', redirect:true })
      : recover(true)
    const heartbeatTimer = window.setInterval(heartbeat, APP_SESSION_HEARTBEAT_MS)
    const idleTimer = window.setInterval(() => { if (isSessionIdleExpired()) localSignOut({ release:true, redirect:true }) }, 60*1000)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('focus', onFocus)
    ;['pointerdown','keydown','input','touchstart','scroll'].forEach(name=>window.addEventListener(name,onActivity,{passive:true}))
    window.addEventListener('wfh:auth-check-needed', onAuthCheck)
    return () => {
      alive = false
      window.clearTimeout(bootstrapTimer)
      window.clearTimeout(verificationTimer)
      authSubscription?.unsubscribe()
      window.clearInterval(heartbeatTimer)
      window.clearInterval(idleTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('focus', onFocus)
      ;['pointerdown','keydown','input','touchstart','scroll'].forEach(name=>window.removeEventListener(name,onActivity))
      window.removeEventListener('wfh:auth-check-needed', onAuthCheck)
    }
  }, [mode, retryKey])

  if (state.loading) return <div className="center-screen">{mode==='staff'?t('common.loading','读取中…'):'Loading...'}</div>
  if (state.error) return <div className="center-screen auth-retry"><div><strong>{mode==='staff'?t('auth.connectionUnstable','连接暂时不稳定'):'连接暂时不稳定'}</strong><p>{state.error}</p><button onClick={() => { setState(s => ({...s,loading:true,error:''})); setRetryKey(x=>x+1) }}>{mode==='staff'?t('common.retry','重新验证'):'重新验证'}</button></div></div>
  const login = mode === 'admin' ? '/admin/login' : '/staff/login'
  if (!state.session || !state.access?.active) return <Navigate to={login} replace />
  if (mode === 'admin' && !state.access.backend_enabled) return <Navigate to="/admin/login" replace />
  if (mode === 'staff' && !state.access.employee_portal_enabled) return <Navigate to="/staff/login" replace />
  if (mode === 'admin' && state.access.otp_required && state.aal !== 'aal2' && location.pathname !== '/admin/mfa') return <Navigate to="/admin/mfa" replace />
  return children
}

function AppRoutes() {
  const location = useLocation()
  const { t } = useStaffLocale()
  if (!configured) return <div className="center-screen">{location.pathname.startsWith('/staff')?t('auth.unavailable','暂时无法连接'):'暂时无法连接'}</div>
  return <Routes>
    <Route path="/" element={<Navigate to="/staff/login" replace />} />
    <Route path="/admin/login" element={<AdminLoginPage />} />
    <Route path="/staff/login" element={<StaffLoginPage />} />
    <Route path="/staff/register" element={<StaffRegisterPage />} />
    <Route path="/admin/mfa" element={<Protected mode="admin"><MfaPage /></Protected>} />
    <Route path="/admin" element={<Protected mode="admin"><AppLayout mode="admin"><AdminHome /></AppLayout></Protected>} />
    <Route path="/admin/employees" element={<Protected mode="admin"><AppLayout mode="admin"><AdminEmployeesPage /></AppLayout></Protected>} />
    <Route path="/admin/schedule" element={<Protected mode="admin"><AppLayout mode="admin"><AdminAttendancePage /></AppLayout></Protected>} />
    <Route path="/admin/daily" element={<Protected mode="admin"><AppLayout mode="admin"><AdminDailyWorkPage /></AppLayout></Protected>} />
    <Route path="/admin/training" element={<Protected mode="admin"><AppLayout mode="admin"><AdminTrainingPage /></AppLayout></Protected>} />
    <Route path="/admin/payroll" element={<Protected mode="admin"><AppLayout mode="admin"><AdminPayrollPage /></AppLayout></Protected>} />
    <Route path="/admin/reports" element={<Protected mode="admin"><AppLayout mode="admin"><AdminReportsPage /></AppLayout></Protected>} />
    <Route path="/admin/users" element={<Protected mode="admin"><AppLayout mode="admin"><AdminUsersPage /></AppLayout></Protected>} />
    <Route path="/staff" element={<Protected mode="staff"><AppLayout mode="staff"><StaffHome /></AppLayout></Protected>} />
    <Route path="/staff/schedule" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title={t('nav.schedule','我的排班')} /></AppLayout></Protected>} />
    <Route path="/staff/attendance" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title={t('nav.attendance','我的出勤')} /></AppLayout></Protected>} />
    <Route path="/staff/payroll" element={<Protected mode="staff"><AppLayout mode="staff"><StaffPayrollPage /></AppLayout></Protected>} />
    <Route path="/staff/exams" element={<Protected mode="staff"><AppLayout mode="staff"><StaffExamPage /></AppLayout></Protected>} />
    <Route path="/staff/requests" element={<Protected mode="staff"><AppLayout mode="staff"><ComingSoon title={t('nav.requests','我的申请')} /></AppLayout></Protected>} />
    <Route path="*" element={<Navigate to="/staff/login" replace />} />
  </Routes>
}

export default function App() {
  return <StaffI18nProvider><AppRoutes /></StaffI18nProvider>
}
