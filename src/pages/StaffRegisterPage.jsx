import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, configured } from '../lib/supabase'
import { StaffLanguageSwitcher, useStaffLocale } from '../lib/staffI18n'
import { publicPortalTarget } from '../lib/appBasePath'

const tests = [
  ['register.passwordLength', '10位以上', p => p.length >= 10],
  ['register.passwordUpper', '大写字母', p => /[A-Z]/.test(p)],
  ['register.passwordLower', '小写字母', p => /[a-z]/.test(p)],
  ['register.passwordNumber', '数字', p => /[0-9]/.test(p)],
  ['register.passwordSymbol', '特殊符号', p => /[^A-Za-z0-9]/.test(p)],
]

export default function StaffRegisterPage() {
  const [form, setForm] = useState({ email: '', password: '', confirm: '', code: '' })
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const { t } = useStaffLocale()

  const checks = useMemo(
    () => tests.map(([key, fallback, fn]) => ({ key, label:t(key,fallback), ok:fn(form.password) })),
    [form.password, t]
  )

  const valid =
    checks.every(x => x.ok) &&
    form.password === form.confirm &&
    form.email &&
    form.code

  const submit = async (e) => {
    e.preventDefault()
    setError('')

    if (!configured) return setError(t('register.unavailable','暂时无法注册'))
    if (!valid) return setError(t('register.completeRequirements','请完成密码要求'))

    setLoading(true)

    const { data, error } = await supabase.functions.invoke('register-employee', {
      body: {
        email: form.email.trim().toLowerCase(),
        password: form.password,
        activation_code: form.code.trim().toUpperCase(),
      },
    })

    setLoading(false)

    if (error) {
      let detail = ''
      try { detail = (await error.context?.json())?.error || '' } catch {}
      return setError(detail || data?.error || t('register.failed','注册失败，请检查激活码'))
    }
    if (data?.error) return setError(data.error)
    setResult(data)
  }

  if (result) {
    return (
      <div className="login-page staff-login-page">
        <div className="login-shell">
          <div className="login-brand">
            <div className="login-logo">W</div>
            <span>WFH</span>
          </div>
          <div className="login-card register-success">
            <div className="auth-language-row"><StaffLanguageSwitcher /></div>
            <div className="success-check">✓</div>
            <div className="login-title">{t('register.success','注册成功')}</div>
            <div className="register-result">{result.employee_id} · {result.employee_name}</div>
            <Link className="login-submit login-link-button" to={publicPortalTarget('staff','login')}>{t('register.goLogin','去登录')}</Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="login-page staff-login-page">
      <div className="login-shell register-shell">
        <div className="login-brand">
          <div className="login-logo">W</div>
          <span>WFH</span>
        </div>

        <form className="login-card" onSubmit={submit}>
          <div className="auth-language-row"><StaffLanguageSwitcher /></div>
          <div className="login-title">{t('register.title','激活账号')}</div>

          <label className="login-field">
            {t('auth.email','邮箱')}
            <div className="login-input">
              <input
                type="email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                required
              />
            </div>
          </label>

          <label className="login-field">
            {t('auth.password','密码')}
            <div className="login-input">
              <input
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                required
              />
            </div>
          </label>

          <label className="login-field">
            {t('register.confirmPassword','确认密码')}
            <div className="login-input">
              <input
                type="password"
                value={form.confirm}
                onChange={e => setForm({ ...form, confirm: e.target.value })}
                required
              />
            </div>
          </label>

          <div className="password-checks">
            {checks.map(x => (
              <span className={x.ok ? 'pass' : ''} key={x.key}>
                {x.ok ? '✓' : '○'} {x.label}
              </span>
            ))}
          </div>

          <label className="login-field">
            {t('register.activationCode','激活码')}
            <div className="login-input">
              <input
                value={form.code}
                onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })}
                autoCapitalize="characters"
                required
              />
            </div>
          </label>

          {error && <div className="login-error">{error}</div>}

          <button className="login-submit" disabled={!valid || loading}>
            {loading ? t('register.processing','处理中...') : t('register.create','创建账号')}
          </button>

          <div className="login-foot">
            <Link to={publicPortalTarget('staff','login')}>{t('register.back','返回登录')}</Link>
          </div>
        </form>
      </div>
    </div>
  )
}
