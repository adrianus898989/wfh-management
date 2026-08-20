import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'

function withTimeout(promise, ms = 20000) {
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
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

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
