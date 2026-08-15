import React, { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function MfaPage() {
  const [loading, setLoading] = useState(true)
  const [required, setRequired] = useState(true)
  const [mode, setMode] = useState('verify')
  const [factor, setFactor] = useState(null)
  const [qr, setQr] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true

    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        if (alive) setLoading(false)
        return
      }

      const { data: access } = await supabase
        .from('user_access')
        .select('otp_required,backend_enabled,active')
        .eq('auth_user_id', session.user.id)
        .single()

      if (!alive) return

      if (!access?.active || !access?.backend_enabled) {
        setLoading(false)
        return
      }

      if (!access.otp_required) {
        setRequired(false)
        setLoading(false)
        navigate('/admin', { replace: true })
        return
      }

      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (aal?.currentLevel === 'aal2') {
        setLoading(false)
        navigate('/admin', { replace: true })
        return
      }

      const { data: factors } = await supabase.auth.mfa.listFactors()
      const verified = factors?.totp?.find(x => x.status === 'verified')

      if (verified) {
        setFactor(verified)
        setMode('verify')
        setLoading(false)
        return
      }

      for (const item of factors?.totp || []) {
        if (item.status !== 'verified') {
          await supabase.auth.mfa.unenroll({ factorId: item.id })
        }
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'WFH',
      })

      if (enrollError) {
        setError('暂时无法绑定验证器')
        setLoading(false)
        return
      }

      setFactor(enrolled)
      setQr(enrolled?.totp?.qr_code || '')
      setMode('setup')
      setLoading(false)
    })()

    return () => { alive = false }
  }, [navigate])

  const verify = async () => {
    setError('')
    if (!factor?.id || code.length !== 6) return

    const { data: challenge, error: challengeError } =
      await supabase.auth.mfa.challenge({ factorId: factor.id })

    if (challengeError) return setError('验证失败')

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: factor.id,
      challengeId: challenge.id,
      code,
    })

    if (verifyError) return setError('验证码错误')
    navigate('/admin', { replace: true })
  }

  if (loading) return <div className="mfa-page"><div className="mfa-card">Loading...</div></div>
  if (!required) return <Navigate to="/admin" replace />

  return (
    <div className="mfa-page">
      <div className="mfa-card">
        <div className="login-logo mfa-logo">W</div>
        <div className="mfa-title">{mode === 'setup' ? '绑定验证器' : '安全验证'}</div>

        {mode === 'setup' && qr && (
          <div className="mfa-qr">
            <img src={qr} alt="Authenticator QR" />
          </div>
        )}

        <input
          className="mfa-code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          autoFocus
        />

        {error && <div className="login-error">{error}</div>}

        <button className="login-submit" onClick={verify} disabled={code.length !== 6}>
          确认
        </button>
      </div>
    </div>
  )
}
