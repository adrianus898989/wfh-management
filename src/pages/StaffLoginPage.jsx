import React, { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  configured,
  consumeAppSessionNotice,
  setAppSession,
  supabase,
  touchSessionActivity,
} from '../lib/supabase'
import { readFunctionResponsePayload } from '../lib/functionErrors'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'
import { registerCurrentAppRelease } from '../lib/releaseSession'
import { publicPortalTarget } from '../lib/appBasePath'
import { withAbortableRequestTimeout } from '../lib/abortableRequestTimeout'

export default function StaffLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [sessionNotice, setSessionNotice] = useState(() => consumeAppSessionNotice('staff'))
  const [loading, setLoading] = useState(false)
  const submitInFlight = useRef(false)
  const navigate = useNavigate()
  const { t, resetLocale } = useStaffLocale()
  const passwordChangedNotice = sessionNotice === 'password_changed'
  const loginErrorMessage = response => ({
    INVALID_REQUEST: t('auth.invalidRequest','Invalid request format'),
    INVALID_EMAIL: t('auth.invalidEmail','Invalid email format'),
    PASSWORD_REQUIRED: t('auth.passwordRequired','Please enter your password'),
    EMAIL_NOT_FOUND: t('auth.accountNotFound','Account does not exist'),
    ACCOUNT_NOT_FOUND: t('auth.accountNotFound','Account does not exist'),
    STAFF_ACCOUNT_NOT_FOUND: t('auth.accountNotFound','Account does not exist'),
    PASSWORD_INCORRECT: t('auth.passwordIncorrect','Incorrect password'),
    ACCOUNT_LOCKED: t('auth.accountLocked','This account is locked after {count} incorrect password attempts. Contact an administrator to unlock it.')
      .replace('{count}', String(Number(response?.lock_threshold || 5))),
    ACCOUNT_UNAVAILABLE: t('auth.accountNotFound','Account does not exist'),
    TOO_MANY_ATTEMPTS: t('auth.tooManyAttempts','Too many attempts. Please try again later.'),
    LOGIN_SERVICE_UNAVAILABLE: t('auth.loginUnavailable','Sign in is temporarily unavailable'),
    SESSION_CHECK_UNAVAILABLE: t('auth.sessionCheckFailed','Unable to verify this browser session. Please try again.'),
    ACTIVE_SESSION_EXISTS: t('auth.sessionTakeoverFailed','Unable to replace the previous session. Please try signing in again.'),
    SESSION_REJECTED: t('auth.accountNotFound','Account does not exist'),
    STAFF_IP_NOT_ALLOWED: t('auth.networkNotAllowed','This network is not allowed to access the staff portal. Please contact an administrator.'),
    CLIENT_IP_UNAVAILABLE: t('auth.accessCheckUnavailable','Access verification is temporarily unavailable. Please try again later.'),
  }[response?.code] || t('auth.loginFailed','Sign in failed. Please try again.'))

  const submit = async (e) => {
    e.preventDefault()
    if (submitInFlight.current) return
    submitInFlight.current = true
    setError('')
    setSessionNotice('')

    if (!configured) {
      submitInFlight.current = false
      return setError(t('auth.loginUnavailable','暂时无法登录'))
    }

    setLoading(true)

    try {
      const functionResult = await withAbortableRequestTimeout(
        signal => supabase.functions.invoke('admin-login', {
          body: { email: email.trim().toLowerCase(), password, mode: 'staff' },
          signal,
        }),
        25_000,
      )

      const { error } = functionResult
      const responseData = await readFunctionResponsePayload(functionResult)

      if (error || !responseData?.access_token || !responseData?.refresh_token) {
        return setError(loginErrorMessage(responseData))
      }

      const { data: sessionData, error: sessionError } = await setAppSession({
        access_token: responseData.access_token,
        refresh_token: responseData.refresh_token,
      })
      if (sessionError || !sessionData?.user) {
        return setError(t('auth.loginFailed','登录失败，请重试'))
      }

      registerCurrentAppRelease('staff')
      touchSessionActivity(true)
      // admin-login already verifies active staff-portal access and atomically
      // claims the candidate session. Protected revalidates through the narrow
      // self-only bootstrap RPC after navigation, so no duplicate RLS read is
      // needed here.
      resetLocale()
      navigate(publicPortalTarget('staff'), { replace: true })
    } catch (requestError) {
      setError(requestError?.message === 'TIMEOUT'
        ? t('auth.loginTimeout','Sign in timed out. Please try again.')
        : t('auth.loginUnavailable','Sign in is temporarily unavailable'))
    } finally {
      submitInFlight.current = false
      setLoading(false)
    }
  }

  return (
    <div className="login-page login-page--signin staff-login-page">
      <div className="staff-auth-language"><StaffLanguageSwitcher /></div>
      <div className="staff-auth-atmosphere" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <main className="login-shell login-shell--signin">
        <div className="login-brand" aria-label="WFH">
          <div className="login-logo" aria-hidden="true">W</div>
        </div>

        <form className="login-card login-card--signin" onSubmit={submit} aria-busy={loading}>
          <h1 className="login-title">{t('auth.staffLogin','WFH 登录')}</h1>

          <label className="login-field">
            {t('auth.email','邮箱')}
            <div className="login-input">
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck="false"
                required
              />
            </div>
          </label>

          <label className="login-field">
            {t('auth.password','密码')}
            <div className="login-input">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" aria-label={showPassword ? t('common.hide','隐藏') : t('auth.show','显示')} onClick={() => setShowPassword(v => !v)}>
                {showPassword ? t('common.hide','隐藏') : t('auth.show','显示')}
              </button>
            </div>
          </label>

          {(error || sessionNotice) && <div
            className="login-error"
            role={passwordChangedNotice ? 'status' : 'alert'}
            style={passwordChangedNotice ? {borderColor:'#b9e4cc',background:'#effaf4',color:'#26714c'} : undefined}
          >{error || (
            sessionNotice === 'active_elsewhere'
              ? t('auth.sessionEndedElsewhere','Your session ended because this account is active in another browser.')
              : sessionNotice === 'system_updated'
                ? t('auth.systemUpdated','The system has been updated. Please sign in again.')
              : sessionNotice === 'account_not_found'
                ? t('auth.accountNotFound','Account does not exist')
              : sessionNotice === 'ip_not_allowed'
                ? t('auth.networkNotAllowed','This network is not allowed to access the staff portal. Please contact an administrator.')
              : sessionNotice === 'account_locked'
                ? t('auth.accountLockedWithoutCount','This account is locked after too many incorrect password attempts. Contact an administrator to unlock it.')
              : sessionNotice === 'password_changed'
                ? t('passwordChange.success','Password changed. Sign in again with your new password.')
              : sessionNotice === 'password_changed_finalize_pending'
                ? t('passwordChange.finalizePending','Your password changed, but session cleanup is still finishing. Try the new password shortly or contact an administrator.')
              : sessionNotice === 'password_change_outcome_unknown'
                ? t('passwordChange.outcomeUnknown','The result could not be confirmed. Try your new password first; if it does not work, try the old one or contact an administrator.')
              : t('auth.sessionEnded','This sign-in session has ended. Please sign in again.')
          )}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? t('auth.signingIn','登录中...') : t('auth.signIn','登录')}
          </button>
          <div className="login-foot">
            <div>{t('auth.firstTime','首次使用？')} <Link to={publicPortalTarget('staff','register')}>{t('auth.activate','激活账号')}</Link></div>
            <div style={{marginTop:8}}>{t('auth.forgotPasswordContactAdmin','Forgot your password? Contact an administrator to reset it.')}</div>
          </div>
        </form>
      </main>
    </div>
  )
}
