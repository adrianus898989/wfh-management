import React, { useState } from 'react'
import {
  claimAppSession,
  configured,
  consumeAppSessionNotice,
  discardLocalAppSession,
  setAppSession,
  signOutAppSession,
  supabase,
  touchSessionActivity,
} from '../lib/supabase'

function withTimeout(promise, ms = 25000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

export default function AdminLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(() => {
    const notice = consumeAppSessionNotice('admin')
    return notice === 'active_elsewhere'
      ? '当前会话已结束：该账号正在另一浏览器使用'
      : notice === 'session_ended'
        ? '登录会话已失效，请重新登录'
        : ''
  })
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')

    if (!configured) return setError('暂时无法登录')

    setLoading(true)
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('admin-login', {
          body: {
            username: username.trim().toLowerCase(),
            password,
          },
        })
      )

      let responseData = data
      if (error && !responseData?.error) {
        try { responseData = await error.context?.json() } catch (_) {}
      }

      if (error || !responseData?.access_token || !responseData?.refresh_token) {
        return setError(responseData?.error || '用户名或密码错误')
      }

      const { data: sessionData, error: sessionError } = await setAppSession({
        access_token: responseData.access_token,
        refresh_token: responseData.refresh_token,
      })

      if (sessionError || !sessionData?.session) {
        return setError(sessionError?.code==='SESSION_SETUP_TIMEOUT'
          ? '登录状态设置超时，请重试'
          : '登录失败，请重试')
      }

      if (responseData.mfa_required) {
        touchSessionActivity(true)
        window.location.replace(`${window.location.origin}${import.meta.env.BASE_URL}admin/mfa`)
        return
      }

      const { data: lease, error: leaseError } = await claimAppSession('admin')
      if (leaseError) {
        await signOutAppSession()
        return setError('登录会话验证暂不可用，请稍后重试')
      }
      if (!lease?.ok) {
        await discardLocalAppSession()
        return setError(lease?.reason === 'active_elsewhere'
          ? '该账号已在另一浏览器登录，请先退出原会话后重试'
          : '登录会话已失效，请重试')
      }

      touchSessionActivity(true)
      window.location.replace(`${window.location.origin}${import.meta.env.BASE_URL}admin`)
    } catch (requestError) {
      setError(requestError?.message === 'TIMEOUT'
        ? '登录服务响应超时，请稍后重试'
        : '登录服务暂不可用，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-brand">
          <div className="login-logo">W</div>
          <span>WFH</span>
        </div>

        <form className="login-card" onSubmit={submit}>
          <div className="login-title">登录</div>

          <label className="login-field">
            用户名
            <div className="login-input">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                required
              />
            </div>
          </label>

          <label className="login-field">
            密码
            <div className="login-input">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button type="button" onClick={() => setShowPassword(v => !v)}>
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>

          {error && <div className="login-error">{error}</div>}

          <button className="login-submit" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
