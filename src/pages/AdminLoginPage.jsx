import React, { useState } from 'react'
import {
  configured,
  consumeAppSessionNotice,
  setAppSession,
  supabase,
  touchSessionActivity,
} from '../lib/supabase'
import { readFunctionResponsePayload } from '../lib/functionErrors'

function withTimeout(promise, ms = 25000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

const LOGIN_ERROR_MESSAGES = {
  INVALID_REQUEST: '请求格式不正确',
  INVALID_USERNAME: '账号格式不正确',
  PASSWORD_REQUIRED: '请输入密码',
  USERNAME_NOT_FOUND: '账号不存在',
  PASSWORD_INCORRECT: '密码错误',
  ACCOUNT_UNAVAILABLE: '账号不可用，请联系管理员',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后重试',
  LOGIN_SERVICE_UNAVAILABLE: '登录服务暂不可用，请稍后重试',
  SESSION_CHECK_UNAVAILABLE: '登录会话验证暂不可用，请稍后重试',
  ACTIVE_SESSION_EXISTS: '旧会话接管未完成，请重新登录',
  SESSION_REJECTED: '登录会话已失效，请重试',
}

const loginErrorMessage = response => LOGIN_ERROR_MESSAGES[response?.code]
  || '登录失败，请稍后重试'

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
      const functionResult = await withTimeout(
        supabase.functions.invoke('admin-login', {
          body: {
            username: username.trim().toLowerCase(),
            password,
            mode: 'admin',
          },
        })
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
    <div className="login-page login-page--signin admin-login-page">
      <main className="login-shell login-shell--signin">
        <div className="login-brand" aria-label="WFH">
          <div className="login-logo" aria-hidden="true">W</div>
        </div>

        <form className="login-card login-card--signin" onSubmit={submit} aria-busy={loading}>
          <h1 className="login-title">WFH 登录</h1>

          <label className="login-field">
            账号
            <div className="login-input">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                inputMode="text"
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
              <button type="button" aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(v => !v)}>
                {showPassword ? '隐藏' : '显示'}
              </button>
            </div>
          </label>

          {error && <div className="login-error" role="alert">{error}</div>}

          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </main>
    </div>
  )
}
