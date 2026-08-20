import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const tests = [
  ['至少 10 个字符', p => p.length >= 10],
  ['包含大写字母', p => /[A-Z]/.test(p)],
  ['包含小写字母', p => /[a-z]/.test(p)],
  ['包含数字', p => /[0-9]/.test(p)],
  ['包含特殊符号', p => /[^A-Za-z0-9]/.test(p)],
]

function withTimeout(promise, ms = 20000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

export default function AdminResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [ready, setReady] = useState(false)
  const [checking, setChecking] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const checks = useMemo(() => tests.map(([label, test]) => ({ label, ok: test(password) })), [password])
  const valid = checks.every(item => item.ok) && password === confirm

  useEffect(() => {
    let alive = true
    const finish = session => {
      if (!alive) return
      setReady(Boolean(session))
      setChecking(false)
    }
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || session) finish(session)
    })
    supabase.auth.getSession().then(({ data }) => {
      if (data?.session) finish(data.session)
    })
    const timer = window.setTimeout(() => {
      if (alive) setChecking(false)
    }, 8000)
    return () => {
      alive = false
      window.clearTimeout(timer)
      listener?.subscription?.unsubscribe()
    }
  }, [])

  const submit = async e => {
    e.preventDefault()
    setError('')
    if (!valid) return setError(password !== confirm ? '两次输入的密码不一致' : '新密码还没有符合全部安全要求')
    setLoading(true)
    try {
      const { error: updateError } = await withTimeout(supabase.auth.updateUser({ password }))
      if (updateError) throw updateError
      await supabase.auth.signOut()
      navigate('/admin/login', { replace: true, state: { passwordReset: true } })
    } catch (requestError) {
      setError(requestError?.message === 'TIMEOUT'
        ? '更新密码超时，请稍后再试'
        : '重置链接可能已失效，请重新发送重置邮件')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="login-brand"><div className="login-logo">W</div><span>WFH</span></div>
        <form className="login-card" onSubmit={submit}>
          <div className="login-title">设置新密码</div>
          {checking && <div className="login-message">正在验证重置链接…</div>}
          {!checking && !ready && <>
            <div className="login-error">重置链接无效或已经过期，请返回登录页重新发送。</div>
            <button type="button" className="login-submit" onClick={() => navigate('/admin/login', { replace: true })}>返回登录</button>
          </>}
          {!checking && ready && <>
            <label className="login-field">新密码
              <div className="login-input">
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
                <button type="button" onClick={() => setShowPassword(value => !value)}>{showPassword ? '隐藏' : '显示'}</button>
              </div>
            </label>
            <label className="login-field">确认新密码
              <div className="login-input"><input type={showPassword ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required /></div>
            </label>
            <div className="password-checks">{checks.map(item => <span className={item.ok ? 'pass' : ''} key={item.label}>{item.ok ? '✓' : '○'} {item.label}</span>)}</div>
            {error && <div className="login-error">{error}</div>}
            <button className="login-submit" disabled={loading || !valid}>{loading ? '正在更新…' : '确认新密码'}</button>
          </>}
        </form>
      </div>
    </div>
  )
}
