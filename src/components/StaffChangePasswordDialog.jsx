import React, { useEffect, useMemo, useRef, useState } from 'react'
import { configured, supabase } from '../lib/supabase'
import { readFunctionResponsePayload } from '../lib/functionErrors'
import { useStaffLocale } from '../lib/staffI18n'

export const STAFF_PASSWORD_RULES = [
  ['register.passwordLength', 'At least 10 characters', value => value.length >= 10],
  ['register.passwordUpper', 'Uppercase letter', value => /[A-Z]/.test(value)],
  ['register.passwordLower', 'Lowercase letter', value => /[a-z]/.test(value)],
  ['register.passwordNumber', 'Number', value => /[0-9]/.test(value)],
  ['register.passwordSymbol', 'Special character', value => /[^A-Za-z0-9]/.test(value)],
]

function withTimeout(promise, ms = 30_000) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error('PASSWORD_CHANGE_TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

function PasswordField({ label, value, onChange, autoComplete, shown, onToggle, inputRef, maxLength = 128, t }) {
  return <label className="login-field">
    {label}
    <div className="login-input">
      <input
        ref={inputRef}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={event => onChange(event.target.value)}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required
      />
      <button type="button" onClick={onToggle} aria-label={shown ? t('common.hide', 'Hide') : t('auth.show', 'Show')}>
        {shown ? t('common.hide', 'Hide') : t('auth.show', 'Show')}
      </button>
    </div>
  </label>
}

export default function StaffChangePasswordDialog({ open, onClose, onPasswordChanged }) {
  const { t } = useStaffLocale()
  const currentInputRef = useRef(null)
  const loadingRef = useRef(false)
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [shown, setShown] = useState({ current: false, next: false, confirm: false })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const checks = useMemo(() => STAFF_PASSWORD_RULES.map(([key, fallback, validate]) => ({
    key,
    label: t(key, fallback),
    ok: validate(form.newPassword),
  })), [form.newPassword, t])
  const valid = Boolean(
    form.currentPassword
    && checks.every(check => check.ok)
    && form.newPassword.length <= 128
    && form.newPassword !== form.currentPassword
    && form.newPassword === form.confirmPassword
  )

  const reset = () => {
    loadingRef.current = false
    setForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    setShown({ current: false, next: false, confirm: false })
    setError('')
    setLoading(false)
  }

  useEffect(() => {
    if (!open) return undefined
    reset()
    const focusTimer = window.setTimeout(() => currentInputRef.current?.focus(), 0)
    const onKeyDown = event => {
      if (event.key === 'Escape' && !loadingRef.current) onClose?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    loadingRef.current = loading
  }, [loading])

  if (!open) return null

  const messageFor = payload => ({
    INVALID_REQUEST: t('passwordChange.invalidRequest', 'Invalid request. Please reopen this dialog and try again.'),
    CURRENT_PASSWORD_REQUIRED: t('passwordChange.currentRequired', 'Enter your current password.'),
    NEW_PASSWORD_INVALID: t('passwordChange.requirements', 'Complete all new-password requirements.'),
    PASSWORD_REUSE: t('passwordChange.reuse', 'Choose a password different from your current password.'),
    PASSWORD_INCORRECT: t('passwordChange.incorrect', 'The current password is incorrect.'),
    ACCOUNT_LOCKED: t('passwordChange.locked', 'This account is locked. Contact an administrator.'),
    ACCOUNT_UNAVAILABLE: t('passwordChange.accountUnavailable', 'This staff account is no longer available.'),
    SESSION_ENDED: t('passwordChange.sessionEnded', 'Your session has ended. Sign in again.'),
    SESSION_CHECK_UNAVAILABLE: t('passwordChange.sessionCheckFailed', 'Unable to verify this session right now. Try again later.'),
    STAFF_IP_NOT_ALLOWED: t('passwordChange.networkDenied', 'This network is not allowed to change the staff password.'),
    CLIENT_IP_UNAVAILABLE: t('passwordChange.sessionCheckFailed', 'Unable to verify this session right now. Try again later.'),
    TOO_MANY_ATTEMPTS: t('passwordChange.tooManyAttempts', 'Too many attempts. Try again later.'),
    PASSWORD_CHANGE_UNAVAILABLE: t('passwordChange.unavailable', 'Password change is temporarily unavailable. Try again later.'),
  }[payload?.code] || t('passwordChange.failed', 'Unable to change the password. Try again.'))

  const submit = async event => {
    event.preventDefault()
    if (loading) return
    setError('')
    if (!configured) return setError(t('passwordChange.unavailable', 'Password change is temporarily unavailable. Try again later.'))
    if (!form.currentPassword) return setError(t('passwordChange.currentRequired', 'Enter your current password.'))
    if (!checks.every(check => check.ok) || form.newPassword.length > 128) {
      return setError(t('passwordChange.requirements', 'Complete all new-password requirements.'))
    }
    if (form.newPassword === form.currentPassword) {
      return setError(t('passwordChange.reuse', 'Choose a password different from your current password.'))
    }
    if (form.newPassword !== form.confirmPassword) {
      return setError(t('passwordChange.mismatch', 'The new passwords do not match.'))
    }

    loadingRef.current = true
    setLoading(true)
    try {
      const result = await withTimeout(supabase.functions.invoke('staff-change-password', {
        body: {
          current_password: form.currentPassword,
          new_password: form.newPassword,
        },
      }))
      const payload = await readFunctionResponsePayload(result)
      const sessionMustEnd = [
        'ACCOUNT_LOCKED',
        'ACCOUNT_UNAVAILABLE',
        'SESSION_ENDED',
        'STAFF_IP_NOT_ALLOWED',
      ].includes(payload?.code)
      if (payload?.password_changed || payload?.password_change_outcome_unknown || sessionMustEnd) {
        reset()
        await onPasswordChanged?.(payload)
        return
      }
      if (result?.error || !payload?.ok) {
        setError(messageFor(payload))
        return
      }
      reset()
      await onPasswordChanged?.(payload)
    } catch (requestError) {
      if (requestError?.message === 'PASSWORD_CHANGE_TIMEOUT') {
        reset()
        await onPasswordChanged?.({
          code: 'PASSWORD_CHANGE_OUTCOME_UNKNOWN',
          password_change_outcome_unknown: true,
        })
        return
      }
      setError(t('passwordChange.unavailable', 'Password change is temporarily unavailable. Try again later.'))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  const close = () => {
    if (loading) return
    reset()
    onClose?.()
  }

  return <div className="modal-mask" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget) close()
  }}>
    <form
      className="modal-card"
      style={{ width: 'min(480px, 96vw)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="staff-change-password-title"
      aria-describedby="staff-change-password-description"
      onMouseDown={event => event.stopPropagation()}
      onSubmit={submit}
    >
      <div className="modal-head">
        <div>
          <h2 id="staff-change-password-title">{t('passwordChange.title', 'Change password')}</h2>
          <p id="staff-change-password-description" style={{ margin: '6px 0 0', color: '#718096', fontSize: 11, lineHeight: 1.55 }}>
            {t('passwordChange.description', 'Verify your current password. All signed-in sessions will end after the change.')}
          </p>
        </div>
        <button type="button" disabled={loading} aria-label={t('common.close', 'Close')} onClick={close}>×</button>
      </div>

      <PasswordField
        label={t('passwordChange.current', 'Current password')}
        value={form.currentPassword}
        onChange={value => setForm(current => ({ ...current, currentPassword: value }))}
        autoComplete="current-password"
        maxLength={256}
        shown={shown.current}
        onToggle={() => setShown(current => ({ ...current, current: !current.current }))}
        inputRef={currentInputRef}
        t={t}
      />
      <PasswordField
        label={t('passwordChange.next', 'New password')}
        value={form.newPassword}
        onChange={value => setForm(current => ({ ...current, newPassword: value }))}
        autoComplete="new-password"
        shown={shown.next}
        onToggle={() => setShown(current => ({ ...current, next: !current.next }))}
        t={t}
      />
      <PasswordField
        label={t('passwordChange.confirm', 'Confirm new password')}
        value={form.confirmPassword}
        onChange={value => setForm(current => ({ ...current, confirmPassword: value }))}
        autoComplete="new-password"
        shown={shown.confirm}
        onToggle={() => setShown(current => ({ ...current, confirm: !current.confirm }))}
        t={t}
      />

      <div className="password-checks" aria-label={t('passwordChange.rules', 'New password requirements')}>
        {checks.map(check => <span className={check.ok ? 'pass' : ''} key={check.key}>
          {check.ok ? '✓' : '○'} {check.label}
        </span>)}
      </div>
      {form.confirmPassword && form.newPassword !== form.confirmPassword && <div className="login-error" role="alert">
        {t('passwordChange.mismatch', 'The new passwords do not match.')}
      </div>}
      {error && <div className="login-error" role="alert">{error}</div>}

      <div className="modal-actions">
        <button type="button" className="secondary-action" disabled={loading} onClick={close}>
          {t('common.close', 'Close')}
        </button>
        <button type="submit" className="primary-action" disabled={!valid || loading}>
          {loading ? t('passwordChange.saving', 'Changing…') : t('passwordChange.submit', 'Change password')}
        </button>
      </div>
    </form>
  </div>
}
