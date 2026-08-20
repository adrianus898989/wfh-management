import React, { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'

function withTimeout(promise, ms = 20000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

export default function AdminLoginPage() {
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState(location.state?.passwordReset ? '密码已经更新，请使用新密码登录。' : '')
  const [loading, setLoading] = useState(false)
  const [resetting, setResetting] = useState(false)
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setMessage('')

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

      if (error || !data?.access_token || !data?.refresh_token) {
        return setError(data?.error || '用户名或密码错误')
      }

      const { error: sessionError } = await withTimeout(supabase.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
      }))

      if (sessionError) return setError('登录失败，请重试')
      navigate('/admin', { replace: true })
    } catch (requestError) {
      setError(requestError?.message === 'TIMEOUT'
        ? '登录服务响应超时，请稍后重试'
        : '登录服务暂不可用，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  const requestPasswordReset = async () => {
    const email = window.prompt('请输入这个后台账号绑定的邮箱')
    if (!email) return
    setError('')
    setMessage('')
    setResetting(true)
    try {
      const redirectTo = new URL('admin/reset-password', `${window.location.origin}${import.meta.env.BASE_URL}`).href
      const { error } = await withTimeout(
        supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo })
      )
      if (error) throw error
      setMessage('重置邮件已发送。请打开邮箱中的链接设置新密码。')
    } catch (requestError) {
      setError(requestError?.message === 'TIMEOUT'
        ? '发送超时，请稍后再试'
        : '暂时无法发送重置邮件，请稍后再试')
    } finally {
      setResetting(false)
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
          {message && <div className="login-message">{message}</div>}

          <button className="login-submit" disabled={loading}>
            {loading ? '登录中...' : '登录'}
          </button>

          <button
            className="login-reset-button"
            type="button"
            disabled={loading || resetting}
            onClick={requestPasswordReset}
          >
            {resetting ? '正在发送重置邮件…' : '忘记密码？'}
          </button>
        </form>
      </div>
    </div>
  )
}
