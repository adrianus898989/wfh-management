import React, { useCallback, useEffect, useRef, useState } from 'react'
import { configured, supabase } from '../lib/supabase'
import { requestPortalIpPreflight } from '../lib/adminIpPreflight'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'

const initialState = {
  status: 'checking',
  allowed: false,
  enforced: false,
  reason: '',
}

// This gate keeps the staff login/activation components unmounted until the
// server-side preflight succeeds. It is only a privacy/UX layer; admin-login,
// register-employee, the Edge session guard and database session predicates
// independently enforce the same rule.
export default function StaffIpPreflightGate({ children }) {
  const [preflight, setPreflight] = useState(initialState)
  const requestRef = useRef(null)
  const { t } = useStaffLocale()

  const check = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setPreflight(initialState)
    const result = await requestPortalIpPreflight(configured ? supabase : null, 'staff', {
      signal: controller.signal,
    })
    if (!controller.signal.aborted) setPreflight(result)
  }, [])

  useEffect(() => {
    void check()
    return () => requestRef.current?.abort()
  }, [check])

  if (preflight.status === 'allowed') return children

  return <div className="login-page login-page--signin staff-login-page">
    <div className="staff-auth-language"><StaffLanguageSwitcher /></div>
    <main className="login-shell login-shell--signin">
      <div className="login-brand" aria-label="WFH">
        <div className="login-logo" aria-hidden="true">W</div>
      </div>
      <section
        className="login-card login-card--signin login-preflight-card"
        aria-busy={preflight.status === 'checking'}
        role={preflight.status === 'blocked' ? 'alert' : 'status'}
      >
        <h1 className="login-title">{t('auth.staffAccessCheck', '员工前端访问验证')}</h1>
        <p className="login-preflight-state">
          {preflight.status === 'checking'
            ? t('auth.checkingNetwork', '正在确认当前网络是否允许访问…')
            : preflight.status === 'blocked'
              ? t('auth.networkNotAllowed', '当前网络未获准访问员工前端，请联系管理员')
              : t('auth.accessCheckUnavailable', '访问验证暂时不可用，请稍后重试')}
        </p>
        {preflight.status !== 'checking' && <button
          type="button"
          className="login-submit"
          onClick={() => void check()}
        >
          {t('auth.retryAccessCheck', '重新检查')}
        </button>}
      </section>
    </main>
  </div>
}
