import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'

export default function AdminLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    setError('')

    if (!configured) {
      return setError('暂时无法登录')
    }

    setLoading(true)

    const { data, error } = await supabase.functions.invoke('admin-login', {
      body: {
        username: username.trim().toLowerCase(),
        password,
      },
    })

    if (error || !data?.access_token || !data?.refresh_token) {
      setLoading(false)
      return setError(data?.error || '用户名或密码错误')
    }

    const { error: sessionError } = await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    })

    setLoading(false)

    if (sessionError) {
      return setError('登录失败，请重试')
    }

    navigate('/admin')
  }

  return (
    <div className="simple-login-page">
      <div className="simple-login-shell">
        <div className="simple-brand">
          <div className="simple-mark">W</div>
          <span>WFH</span>
        </div>

        <div className="simple-login-card">
          <h1>登录</h1>

          <form onSubmit={submit} className="simple-login-form">
            <label>
              用户名
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck="false"
                required
              />
            </label>

            <label>
              密码
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>

            {error && <div className="simple-login-error">{error}</div>}

            <button disabled={loading}>
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        </div>

        <div className="simple-login-foot">© WFH</div>
      </div>
    </div>
  )
}
