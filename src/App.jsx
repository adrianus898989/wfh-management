import React, { useEffect, useRef, useState } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import {
  APP_SESSION_HEARTBEAT_MS,
  bootstrapAppSessionAccess,
  clearSessionActivity,
  configured,
  discardLocalAppSession,
  guardPortalAppSession,
  isSessionIdleExpired,
  setAppSessionNotice,
  signOutAppSession,
  supabase,
  touchSessionActivity,
  withPromiseTimeout,
} from './lib/supabase'
import StaffIpPreflightGate from './components/StaffIpPreflightGate'
import AppLayout from './components/AppLayout'
import { AppToastProvider } from './components/AppToastProvider'
import { StaffI18nProvider, useStaffLocale } from './lib/staffI18n'
import { AdminI18nProvider } from './lib/adminI18n'
import {
  APP_RELEASE_ID,
  appReleasePollDelay,
  clearRegisteredAppRelease,
  currentAppReleaseIsRegistered,
  fetchPublishedAppReleaseId,
} from './lib/releaseSession'
import {
  appSessionHeartbeatDelay,
  appSessionVerificationIsFresh,
  markAppSessionVerified,
  runCoalescedAppSessionWake,
} from './lib/appSessionHeartbeatPressure'
import {
  appPortalModeAllowed,
  appPathname,
  defaultAppPortalMode,
  effectivePortalModeFromAppPath,
  portalModeFromAppPath,
  publicPortalTarget,
} from './lib/appBasePath'

// Keep each route behind its own Suspense boundary.  The wrapper is the route
// component, so a lazy child never unmounts the long-lived Protected/AppLayout
// shell (and therefore never repeats access, IP-lease, presence or alert work).
function AdminRouteFallback() {
  return <div className="admin-route-loading" role="status" aria-label="正在打开页面">
    <div className="admin-route-loading-heading"><i/><strong/><span/></div>
    <div className="admin-route-loading-tabs">{Array.from({ length:7 }, (_, index) => <i key={index}/>)}</div>
    <div className="admin-route-loading-filters">{Array.from({ length:5 }, (_, index) => <i key={index}/>)}</div>
    <div className="admin-route-loading-grid"><i/><i/><i/></div>
  </div>
}

const lazyRoute = (loader, exportName = 'default', { contentFallback = false } = {}) => {
  let loadPromise
  const load = () => {
    if (!loadPromise) loadPromise = loader()
      .then(module => ({ default:module[exportName] }))
      .catch(error => { loadPromise = null; throw error })
    return loadPromise
  }
  const LazyPage = React.lazy(load)
  function LazyRoutePage(props) {
    return <React.Suspense fallback={contentFallback?<AdminRouteFallback/>:<div className="center-screen">Loading...</div>}>
      <LazyPage {...props} />
    </React.Suspense>
  }
  LazyRoutePage.preload = load
  return LazyRoutePage
}

const lazyAdminRoute = (loader, exportName = 'default') => lazyRoute(loader, exportName, { contentFallback:true })

const AdminLoginPage = lazyRoute(() => import('./pages/AdminLoginPage'))
const StaffLoginPage = lazyRoute(() => import('./pages/StaffLoginPage'))
const StaffRegisterPage = lazyRoute(() => import('./pages/StaffRegisterPage'))
const MfaPage = lazyRoute(() => import('./pages/MfaPage'))
const AdminEmployeesPage = lazyAdminRoute(() => import('./pages/AdminEmployeesPage'))
const AdminUsersPage = lazyAdminRoute(() => import('./pages/AdminUsersPage'))
const AdminIpAllowlistPage = lazyAdminRoute(() => import('./pages/AdminIpAllowlistPage'))
const AdminAttendancePage = lazyAdminRoute(() => import('./pages/AdminAttendancePage'))
const AdminReportsPage = lazyAdminRoute(() => import('./pages/AdminReportsPage'))
const AdminDailyWorkPage = lazyAdminRoute(() => import('./pages/AdminDailyWorkPage'))
const AdminTrainingPage = lazyAdminRoute(() => import('./pages/AdminTrainingPage'))
const StaffExamPage = lazyRoute(() => import('./pages/StaffExamPage'))
const AdminPayrollPage = lazyAdminRoute(() => import('./pages/AdminPayrollPage'))
const StaffPayrollPage = lazyRoute(() => import('./pages/StaffPayrollPage'))
const AdminPlanningPage = lazyAdminRoute(() => import('./pages/AdminPlanningPage'))
const AdminManualPage = lazyAdminRoute(() => import('./pages/AdminManualPage'))
const AdminActivityLogPage = lazyAdminRoute(() => import('./pages/AdminActivityLogPage'))
const AdminReconciliationPage = lazyAdminRoute(() => import('./pages/AdminReconciliationPage'))
const AdminHome = lazyAdminRoute(() => import('./pages/PortalPage'), 'AdminHome')
const StaffHome = lazyRoute(() => import('./pages/PortalPage'), 'StaffHome')
const ComingSoon = lazyRoute(() => import('./pages/PortalPage'), 'ComingSoon')

const ADMIN_ROUTE_PAGES = [
  AdminHome, AdminEmployeesPage, AdminAttendancePage, AdminReportsPage,
  AdminDailyWorkPage, AdminTrainingPage, AdminPayrollPage, AdminUsersPage,
  AdminIpAllowlistPage, AdminPlanningPage, AdminActivityLogPage, AdminManualPage,
  AdminReconciliationPage,
]

function AdminRouteChunkWarmup() {
  useEffect(() => {
    let cancelled = false
    let timer = 0
    let idleHandle = 0
    const preload = async () => {
      for (const RoutePage of ADMIN_ROUTE_PAGES) {
        if (cancelled) return
        try { await RoutePage.preload() } catch (_) { /* Runtime recovery owns stale or unavailable assets. */ }
      }
    }
    if (typeof window.requestIdleCallback === 'function') {
      idleHandle = window.requestIdleCallback(() => { void preload() }, { timeout:2500 })
    } else {
      timer = window.setTimeout(() => { void preload() }, 1200)
    }
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (idleHandle) window.cancelIdleCallback?.(idleHandle)
    }
  }, [])
  return null
}

const SESSION_VERIFICATION_FAILURE_BACKOFF_CAP = 6
const SESSION_VERIFICATION_RETRY_BASE_MS = 1500
const SESSION_VERIFICATION_RETRY_MAX_MS = 60 * 1000
const AUTH_CHECK_DEBOUNCE_MS = 2000
const RELEASE_SESSION_READ_TIMEOUT_MS = 4 * 1000

function ReleaseSessionBoundary({ children }) {
  const location = useLocation()
  const portal = effectivePortalModeFromAppPath(location.pathname)
  const [ready, setReady] = useState(false)
  const terminating = useRef(false)

  useEffect(() => {
    let alive = true
    let manifestCheckPromise = null

    if (!configured) {
      setReady(true)
      return () => { alive = false }
    }

    setReady(false)
    const replaceWithLogin = () => {
      window.location.replace(appPathname(publicPortalTarget(portal, 'login')))
    }
    const terminateForRelease = async () => {
      if (terminating.current) return
      terminating.current = true
      setAppSessionNotice('system_updated', portal)
      clearRegisteredAppRelease(portal)
      await discardLocalAppSession()
      if (alive) replaceWithLogin()
    }
    const verifyStoredRelease = async () => {
      try {
        const { data, error } = await withPromiseTimeout(
          supabase.auth.getSession(),
          RELEASE_SESSION_READ_TIMEOUT_MS,
          'RELEASE_SESSION_READ_TIMEOUT',
        )
        if (!alive) return
        if (!error && data?.session && !currentAppReleaseIsRegistered(portal)) {
          await terminateForRelease()
          return
        }
      } catch (_) {
        // Session bootstrap below owns transient Auth/storage error handling.
      } finally {
        if (alive && !terminating.current) setReady(true)
      }
    }
    const checkPublishedRelease = () => {
      if (!alive || manifestCheckPromise || !navigator.onLine || terminating.current) {
        return manifestCheckPromise
      }
      manifestCheckPromise = (async () => {
        const publishedReleaseId = await fetchPublishedAppReleaseId()
        if (!alive || !publishedReleaseId || publishedReleaseId === APP_RELEASE_ID) return
        try {
          const { data, error } = await withPromiseTimeout(
            supabase.auth.getSession(),
            RELEASE_SESSION_READ_TIMEOUT_MS,
            'RELEASE_SESSION_READ_TIMEOUT',
          )
          if (!error && data?.session) await terminateForRelease()
        } catch (_) {
          // Never convert a transient Auth/storage read into a destructive logout.
        }
      })().finally(() => { manifestCheckPromise = null })
      return manifestCheckPromise
    }

    void verifyStoredRelease().then(() => checkPublishedRelease())
    let manifestTimer = 0
    const scheduleManifestCheck = () => {
      window.clearTimeout(manifestTimer)
      if (!alive || terminating.current) return
      manifestTimer = window.setTimeout(async () => {
        await checkPublishedRelease()
        scheduleManifestCheck()
      }, appReleasePollDelay())
    }
    scheduleManifestCheck()
    const onVisible = () => { if (!document.hidden) checkPublishedRelease() }
    const onFocus = () => checkPublishedRelease()
    const onOnline = () => checkPublishedRelease()
    const onReleaseRegistered = event => {
      if (event?.detail?.portal === portal) checkPublishedRelease()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    window.addEventListener('wfh:app-release-registered', onReleaseRegistered)

    return () => {
      alive = false
      window.clearTimeout(manifestTimer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('wfh:app-release-registered', onReleaseRegistered)
    }
  }, [portal])

  if (!ready) return <div className="center-screen">Loading...</div>
  return children
}

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
    let lastAuthCheckAt = 0
    const sessionCheckMessage = mode==='staff'
      ? t('auth.sessionCheckFailed','无法验证当前浏览器会话，请稍后重试。')
      : '无法验证当前浏览器会话，请稍后重试。'
    const replaceWithLogin = () => {
      if (redirectingToLogin.current || typeof window === 'undefined') return
      redirectingToLogin.current = true
      window.location.replace(appPathname(publicPortalTarget(mode, 'login')))
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
    const terminalLeaseReason = reason => [
      'auth_session_missing',
      'active_elsewhere',
      'staff_account_not_found',
      'staff_account_missing',
      'ip_not_allowed',
      'account_locked',
      'release_updated',
    ].includes(reason)
    const terminalBootstrapReason = reason => [
      'auth_session_missing',
      'access_missing',
      'staff_account_not_found',
      'staff_account_missing',
      'release_updated',
    ].includes(reason)
    const freshSession = async () => {
      if (isSessionIdleExpired()) {
        await localSignOut({ release:true, redirect:true })
        return { session:null, error:null }
      }
      const { data, error } = await supabase.auth.getSession()
      if (terminalAuthError(error)) {
        await localSignOut({ release:false, notice:'session_ended', redirect:true })
        return { session:null, error:null }
      }
      // The browser client already serializes refresh-token rotation and
      // refreshes ahead of expiry. Explicitly calling refreshSession here made
      // every auth callback start another rotation when the project's JWT
      // lifetime was shorter than the old ten-minute safety window. That
      // produced refresh/revoke storms and unnecessary permission checks.
      return { session:data?.session || null, error }
    }
    const checkLease = (method = 'claim') => {
      if (leaseCheckPromise) return leaseCheckPromise
      leaseCheckPromise = Promise.resolve(
        guardPortalAppSession(mode, method),
      ).catch(error => ({ data:null, error }))
        .finally(() => { leaseCheckPromise = null })
      return leaseCheckPromise
    }
    const acceptLease = async (result) => {
      if (result?.error || !result?.data || typeof result.data.ok !== 'boolean') return false
      if (!result.data.ok) {
        const reason = result?.data?.reason
        if (reason === 'mfa_required') return false
        // Only server-defined terminal states may destroy a valid local
        // session. Empty, malformed, or newly introduced responses are
        // treated as transient and retried without a login/logout loop.
        if (!terminalLeaseReason(reason)) return false
        await localSignOut({
          release:false,
          notice:reason==='release_updated'
            ? 'system_updated'
            : mode==='staff' && (reason==='staff_account_not_found'||reason==='staff_account_missing')
              ? 'account_not_found'
            : reason==='ip_not_allowed'
              ? 'ip_not_allowed'
            : reason==='account_locked'
              ? 'account_locked'
            : reason==='active_elsewhere'||reason==='not_owner'
              ? 'active_elsewhere'
              : 'session_ended',
          redirect:true,
        })
        return false
      }
      leaseOwned = leaseEligible
      // A coalesced heartbeat means another tab owns the in-flight request.
      // Only the tab that received a real server decision publishes freshness.
      if (!result.data.coalesced) markAppSessionVerified({ portal:mode })
      return true
    }
    const scheduleVerificationRetry = () => {
      window.clearTimeout(verificationTimer)
      if (!navigator.onLine) return
      const delay = Math.min(
        SESSION_VERIFICATION_RETRY_MAX_MS,
        SESSION_VERIFICATION_RETRY_BASE_MS * (2 ** Math.max(0, verificationFailures.current - 1)),
      )
      verificationTimer = window.setTimeout(() => {
        if (alive && navigator.onLine) bootstrap(true)
      }, delay)
    }
    const markVerificationFailure = async message => {
      if (!alive) return
      if (!navigator.onLine) {
        setState(current => current.session && current.access
          ? ({ ...current, loading:false, error:'' })
          : ({ ...current, loading:false, error:message }))
        return
      }
      // A timeout or temporary Edge/RPC outage is not proof that the JWT or
      // browser lease is invalid. Keep the authenticated session and retry;
      // definitive lease/auth failures are handled separately by acceptLease
      // and terminalAuthError.
      verificationFailures.current = Math.min(
        SESSION_VERIFICATION_FAILURE_BACKOFF_CAP,
        verificationFailures.current + 1,
      )
      // Once access was proven, a single timeout must not replace the whole
      // application with a blocking error page. Keep the last verified view
      // while retrying. A definitive server reason still reaches
      // acceptLease/terminalBootstrapReason and signs out immediately.
      setState(current => current.session && current.access
        ? ({ ...current, loading:false, error:'' })
        : ({ ...current, loading:false, error:message }))
      scheduleVerificationRetry()
    }
    const bootstrap = (force = false) => {
      if (bootstrapPromise) return bootstrapPromise
      bootstrapPromise = (async () => {
        const { session, error: sessionError } = await freshSession()
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
        if (!accessResult?.data || typeof accessResult.data.ok !== 'boolean') {
          await markVerificationFailure(mode==='staff'?t('auth.accessFailed','权限验证暂时失败，请重试。登录状态仍为你保留。'):'权限验证暂时失败，请重试。登录状态仍为你保留。')
          return
        }
        if (!accessResult.data.ok) {
          const reason = accessResult.data.reason
          if (!terminalBootstrapReason(reason)) {
            await markVerificationFailure(mode==='staff'?t('auth.accessFailed','权限验证暂时失败，请重试。登录状态仍为你保留。'):'权限验证暂时失败，请重试。登录状态仍为你保留。')
            return
          }
          await localSignOut({
            release:false,
            notice:reason==='release_updated'
              ? 'system_updated'
              : mode==='staff' && (reason==='staff_account_not_found'||reason==='staff_account_missing')
                ? 'account_not_found'
              : reason === 'auth_session_missing' ? 'session_ended' : '',
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
          const reason = leaseResult?.data?.reason
          if (leaseResult?.error || reason === 'mfa_required' || !terminalLeaseReason(reason)) {
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
    const sessionVerificationIsFresh = () =>
      leaseEligible && leaseOwned && appSessionVerificationIsFresh({ portal:mode })
    const scheduleBootstrap = ({ skipIfFresh = false } = {}) => {
      window.clearTimeout(bootstrapTimer)
      // Avoid awaiting Supabase calls inside its auth callback. Re-run the full
      // access check on the next task so stale permissions never stay visible.
      bootstrapTimer = window.setTimeout(() => {
        if (skipIfFresh && sessionVerificationIsFresh()) return
        bootstrap()
      }, 0)
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
        // TOKEN_REFRESHED is normal Supabase maintenance. Re-running access +
        // IP claim for every rotation multiplies Edge/Auth load across tabs;
        // retain the freshly rotated token and let the staggered heartbeat
        // renew the existing five-minute lease. Actual login/initial-session
        // events still bootstrap when this shell has not been verified.
        if (event === 'TOKEN_REFRESHED') {
          setState(current => current.access ? ({ ...current, session }) : current)
          return
        }
        scheduleBootstrap({
          skipIfFresh:event === 'INITIAL_SESSION' || event === 'SIGNED_IN',
        })
      }
    })
    authSubscription = data.subscription
    const recover = ({ skipIfFresh = false } = {}) => {
      if (document.hidden || !navigator.onLine) return
      if (!skipIfFresh) return bootstrap()
      return runCoalescedAppSessionWake({
        portal:mode,
        isFresh:sessionVerificationIsFresh,
        run:bootstrap,
      })
    }
    const heartbeat = async () => {
      if (!alive || document.hidden || !leaseEligible || !leaseOwned || !navigator.onLine) return
      const result = await checkLease('heartbeat')
      if (!leaseEligible) return
      const accepted = await acceptLease(result)
      const reason = result?.data?.reason
      if (!accepted && (result?.error || !terminalLeaseReason(reason))) {
        await markVerificationFailure(sessionCheckMessage)
      }
    }
    let heartbeatTimer = 0
    const clearHeartbeatTimer = () => {
      window.clearTimeout(heartbeatTimer)
      heartbeatTimer = 0
    }
    const scheduleHeartbeat = () => {
      clearHeartbeatTimer()
      if (!alive || document.hidden || !navigator.onLine) return
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = 0
        if (!alive || document.hidden || !navigator.onLine) return
        // Schedule from dispatch time. Even if one Edge request consumes its
        // full timeout, two maximum 135-second cycles stay inside the
        // five-minute lease and keep the existing cross-tab guard effective.
        scheduleHeartbeat()
        void heartbeat()
      }, appSessionHeartbeatDelay(APP_SESSION_HEARTBEAT_MS))
    }
    const onVisibilityChanged = () => {
      if (document.hidden) {
        clearHeartbeatTimer()
        return
      }
      recover({ skipIfFresh:true })
      scheduleHeartbeat()
    }
    const onOnline = () => {
      recover()
      scheduleHeartbeat()
    }
    const onOffline = () => clearHeartbeatTimer()
    const onFocus = () => {
      recover({ skipIfFresh:true })
      if (!heartbeatTimer) scheduleHeartbeat()
    }
    const onActivity = () => touchSessionActivity()
    // Edge responses can arrive after a token refresh or a new login.  Never
    // let one late response destroy the newer valid browser session.  Re-read
    // Auth and the current lease first; bootstrap performs the definitive
    // sign-out only when the current session is actually gone or disabled.
    const onAuthCheck = event => {
      // A retry timer already owns recovery after a transient verification
      // failure. Ignore the cascade of 401 responses from page requests until
      // that backoff fires instead of hammering bootstrap every two seconds.
      if (verificationFailures.current > 0) return
      const now = Date.now()
      if (now - lastAuthCheckAt < AUTH_CHECK_DEBOUNCE_MS) return
      lastAuthCheckAt = now
      // Generic/recoverable 401s may be a late response from an old request.
      // Reuse a recent completed verification (and the cross-tab wake lock)
      // instead of starting another full bootstrap. Explicit terminal Auth
      // reasons still force an immediate server recheck.
      recover({ skipIfFresh:event?.detail?.terminal !== true })
    }
    const idleTimer = window.setInterval(() => { if (isSessionIdleExpired()) localSignOut({ release:true, redirect:true }) }, 60*1000)
    scheduleHeartbeat()
    document.addEventListener('visibilitychange', onVisibilityChanged)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('focus', onFocus)
    ;['pointerdown','keydown','input','touchstart','scroll'].forEach(name=>window.addEventListener(name,onActivity,{passive:true}))
    window.addEventListener('wfh:auth-check-needed', onAuthCheck)
    return () => {
      alive = false
      window.clearTimeout(bootstrapTimer)
      window.clearTimeout(verificationTimer)
      authSubscription?.unsubscribe()
      clearHeartbeatTimer()
      window.clearInterval(idleTimer)
      document.removeEventListener('visibilitychange', onVisibilityChanged)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('focus', onFocus)
      ;['pointerdown','keydown','input','touchstart','scroll'].forEach(name=>window.removeEventListener(name,onActivity))
      window.removeEventListener('wfh:auth-check-needed', onAuthCheck)
    }
  }, [mode, retryKey])

  if (state.loading) return <div className="center-screen">{mode==='staff'?t('common.loading','读取中…'):'Loading...'}</div>
  if (state.error) return <div className="center-screen auth-retry"><div><strong>{mode==='staff'?t('auth.connectionUnstable','连接暂时不稳定'):'连接暂时不稳定'}</strong><p>{state.error}</p><button onClick={() => { setState(s => ({...s,loading:true,error:''})); setRetryKey(x=>x+1) }}>{mode==='staff'?t('common.retry','重新验证'):'重新验证'}</button></div></div>
  const login = publicPortalTarget(mode, 'login')
  if (!state.session || !state.access?.active) return <Navigate to={login} replace />
  if (mode === 'admin' && !state.access.backend_enabled) return <Navigate to={publicPortalTarget('admin','login')} replace />
  if (mode === 'staff' && !state.access.employee_portal_enabled) return <Navigate to={publicPortalTarget('staff','login')} replace />
  if (mode === 'admin' && state.access.otp_required && state.aal !== 'aal2' && location.pathname !== publicPortalTarget('admin','mfa')) return <Navigate to={publicPortalTarget('admin','mfa')} replace />
  return children
}

// Keep session verification, IP attestation, access loading, presence polling,
// and the sidebar mounted while users move between pages. When every route
// owned a separate Protected/AppLayout pair, a quick series of navigation
// clicks remounted all of those effects and produced concurrent guard and
// admin-accounts requests.
function PortalShell({ mode }) {
  return <Protected mode={mode}>
    <>
      {mode==='admin'&&<AdminRouteChunkWarmup/>}
      <AppLayout mode={mode}><Outlet /></AppLayout>
    </>
  </Protected>
}

function LegacyPortalRedirect() {
  const location = useLocation()
  return <Navigate
    to={publicPortalTarget(`${location.pathname}${location.search}${location.hash}`)}
    replace
  />
}

function AppRoutes() {
  const location = useLocation()
  const { t } = useStaffLocale()
  const requestedPortal = portalModeFromAppPath(location.pathname)
  const defaultPortal = defaultAppPortalMode()
  if (requestedPortal && !appPortalModeAllowed(requestedPortal)) {
    return <Navigate to={publicPortalTarget(defaultPortal, 'login')} replace />
  }
  if (publicPortalTarget(location.pathname) !== location.pathname) return <LegacyPortalRedirect />
  if (!configured) return <div className="center-screen">{(requestedPortal || defaultPortal)==='staff'?t('auth.unavailable','暂时无法连接'):'暂时无法连接'}</div>
  return <Routes>
    <Route path="/" element={<Navigate to={publicPortalTarget(defaultPortal,'login')} replace />} />
    <Route path="/admin/*" element={<LegacyPortalRedirect />} />
    <Route path="/staff/*" element={<LegacyPortalRedirect />} />
    <Route path="/workspace/login" element={<AdminLoginPage />} />
    <Route path="/portal/login" element={<StaffIpPreflightGate><StaffLoginPage /></StaffIpPreflightGate>} />
    <Route path="/portal/register" element={<StaffIpPreflightGate><StaffRegisterPage /></StaffIpPreflightGate>} />
    <Route path="/workspace/mfa" element={<Protected mode="admin"><MfaPage /></Protected>} />
    <Route path="/workspace" element={<PortalShell mode="admin" />}>
      <Route index element={<AdminHome />} />
      <Route path="employees" element={<AdminEmployeesPage />} />
      <Route path="schedule" element={<AdminAttendancePage />} />
      <Route path="daily" element={<AdminDailyWorkPage />} />
      <Route path="training" element={<AdminTrainingPage />} />
      <Route path="payroll" element={<AdminPayrollPage />} />
      <Route path="reports" element={<AdminReportsPage />} />
      <Route path="users" element={<AdminUsersPage />} />
      <Route path="ip-allowlist" element={<AdminIpAllowlistPage />} />
      <Route path="work-execution" element={<AdminPlanningPage section="work-execution" />} />
      <Route path="account-usage" element={<AdminPlanningPage section="account-usage" />} />
      <Route path="activity-log" element={<AdminActivityLogPage />} />
      <Route path="reconciliation" element={<AdminReconciliationPage />} />
      <Route path="manual" element={<AdminManualPage />} />
      <Route path="*" element={<Navigate to={publicPortalTarget('admin')} replace />} />
    </Route>
    <Route path="/portal" element={<PortalShell mode="staff" />}>
      <Route index element={<StaffHome />} />
      <Route path="rewards" element={<StaffHome mode="rewards" />} />
      <Route path="schedule" element={<ComingSoon title={t('nav.schedule','我的排班')} />} />
      <Route path="attendance" element={<ComingSoon title={t('nav.attendance','我的出勤')} />} />
      <Route path="payroll" element={<StaffPayrollPage />} />
      <Route path="exams" element={<StaffExamPage />} />
      <Route path="requests" element={<ComingSoon title={t('nav.requests','我的申请')} />} />
      <Route path="*" element={<Navigate to={publicPortalTarget('staff')} replace />} />
    </Route>
    <Route path="*" element={<Navigate to={publicPortalTarget(defaultPortal,'login')} replace />} />
  </Routes>
}

export default function App() {
  return <AdminI18nProvider><StaffI18nProvider><AppToastProvider><ReleaseSessionBoundary><AppRoutes /></ReleaseSessionBoundary></AppToastProvider></StaffI18nProvider></AdminI18nProvider>
}
