import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'

export default function StaffLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { t, resetLocale } = useStaffLocale()

  const submit = async (e) => {
    e.preventDefault()
    setError('')

    if (!configured) return setError(t('auth.loginUnavailable','暂时无法登录'))

    setLoading(true)

    const { data, error } = await supabase.functions.invoke('admin-login', {
      body: { username: username.trim().toLowerCase(), password, mode: 'staff' },
    })

    if (error || !data?.access_token || !data?.refresh_token) {
      setLoading(false)
      return setError(data?.error || t('auth.invalidCredentials','用户名或密码错误'))
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    })
    if (sessionError || !sessionData.user) {
      setLoading(false)
      return setError(t('auth.loginFailed','登录失败，请重试'))
    }

    const { data: access, error: accessError } = await supabase
      .from('user_access')
      .select('employee_portal_enabled,active')
      .eq('auth_user_id', sessionData.user.id)
      .single()

    setLoading(false)

    if (accessError) {
      resetLocale()
      navigate('/staff', { replace: true })
      return
    }

    if (!access?.active || !access?.employee_portal_enabled) {
      await supabase.auth.signOut()
      return setError(t('auth.accountUnavailable','账号不可用'))
    }

    resetLocale()
    navigate('/staff', { replace: true })
  }

  return (
    <div className="login-page staff-login-page">
      <div className="login-shell">
        <div className="login-brand">
          <div className="login-logo">W</div>
          <span>WFH</span>
        </div>

        <form className="login-card" onSubmit={submit}>
          <div className="auth-language-row"><StaffLanguageSwitcher /></div>
          <div className="login-title">{t('auth.staffLogin','员工登录')}</div>

          <label className="login-field">
            {t('auth.email','邮箱')}
            <div className="login-input">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                type="email"
                autoComplete="email"
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
              <button type="button" onClick={() => setShowPassword(v => !v)}>
                {showPassword ? t('common.hide','隐藏') : t('auth.show','显示')}
              </button>
            </div>
          </label>

          {error && <div className="login-error">{error}</div>}

          <button className="login-submit" disabled={loading}>
            {loading ? t('auth.signingIn','登录中...') : t('auth.signIn','登录')}
          </button>

          <div className="login-foot">
            {t('auth.firstTime','首次使用？')} <Link to="/staff/register">{t('auth.activate','激活账号')}</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
