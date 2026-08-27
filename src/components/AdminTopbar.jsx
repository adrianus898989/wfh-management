import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminI18n } from '../lib/adminI18n'
import { AdminAlertBell } from './AdminAlertCenter'
import { PERMISSIONS } from '../config/permissions'
import '../styles-admin-topbar.css'

const emptyPresence = {
  loading:true,
  error:'',
  refreshedAt:'',
  admin:{ count:null, rows:[] },
  staff:{ count:null, rows:[] },
}

const clean = value => String(value ?? '').trim()

function relativeActivity(value, locale) {
  const timestamp = Date.parse(value || '')
  if (!Number.isFinite(timestamp)) return locale === 'en' ? 'Online' : '在线'
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 75) return locale === 'en' ? 'Active now' : '刚刚活跃'
  const minutes = Math.max(1, Math.floor(seconds / 60))
  return locale === 'en' ? `Active ${minutes} min ago` : `${minutes} 分钟前活跃`
}

function PresenceRow({ row, locale }) {
  const metadata = [row.employee_no, row.team, row.position].map(clean).filter(Boolean).join(' · ')
  return <li>
    <span className="admin-presence-live-dot" aria-hidden="true" />
    <span className="admin-presence-person">
      <span><strong data-admin-i18n-skip>{row.name || row.username || '—'}</strong>{row.current && <em>{locale === 'en' ? 'You' : '当前账号'}</em>}</span>
      <small data-admin-i18n-skip>{metadata || row.username || (locale === 'en' ? 'Backend account' : '后台账号')}</small>
    </span>
    <time dateTime={row.last_seen_at || undefined}>{relativeActivity(row.last_seen_at, locale)}</time>
  </li>
}

export default function AdminTopbar({ access }) {
  const { locale } = useAdminI18n()
  const rootRef = useRef(null)
  const requestRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState('admin')
  const [presence, setPresence] = useState(emptyPresence)
  const enabled = Boolean(access && !access.loading && !access.error)
  const canPresence = Boolean(access?.founder || access?.permissions?.includes('*') || [
    PERMISSIONS.BACKEND_ACCOUNT_VIEW,
    PERMISSIONS.STAFF_ACCOUNT_VIEW,
    PERMISSIONS.EMPLOYEE_DIRECTORY_VIEW,
  ].some(code => access?.permissions?.includes(code)))

  const load = async ({ quiet=false } = {}) => {
    if (!enabled || !canPresence) return
    const requestId = ++requestRef.current
    if (!quiet) setPresence(current => ({ ...current, loading:true, error:'' }))
    try {
      const { data, error } = await supabase.functions.invoke('admin-accounts', { body:{ action:'online_presence' } })
      if (error || data?.error) throw new Error(data?.error || error?.message || 'ONLINE_PRESENCE_FAILED')
      if (requestId !== requestRef.current) return
      setPresence({
        loading:false,
        error:'',
        refreshedAt:data?.refreshed_at || new Date().toISOString(),
        admin:{ count:Number(data?.admin?.count || 0), rows:Array.isArray(data?.admin?.rows) ? data.admin.rows : [] },
        staff:{ count:Number(data?.staff?.count || 0), rows:Array.isArray(data?.staff?.rows) ? data.staff.rows : [] },
      })
    } catch (error) {
      if (requestId !== requestRef.current) return
      setPresence(current => ({
        ...current,
        loading:false,
        error:locale === 'en' ? 'Unable to load online users.' : '在线人员读取失败，请稍后重试。',
      }))
    }
  }

  useEffect(() => {
    if (!enabled || !canPresence) return undefined
    load()
    const refresh = () => {
      if (document.visibilityState === 'visible') load({ quiet:true })
    }
    const timer = window.setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      requestRef.current += 1
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [enabled, canPresence, locale])

  useEffect(() => {
    if (!open) return undefined
    const closeOutside = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    const closeEscape = event => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeEscape)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeEscape)
    }
  }, [open])

  if (!enabled) return null

  const login = clean(access.loginUsername) || clean(access.loginEmail) || (locale === 'en' ? 'Backend account' : '后台账号')
  const accountName = clean(access.fullName) || login
  const accountMeta = clean(access.fullName) && login !== accountName ? login : clean(access.roleCode)
  const rows = presence[section]?.rows || []
  const selectSection = value => {
    setSection(value)
    setOpen(true)
    load({ quiet:true })
  }

  return <header className="admin-global-topbar">
    <div className="admin-global-topbar-spacer" />
    <div className="admin-global-topbar-actions">
      {canPresence && <div className="admin-presence-control" ref={rootRef}>
        <div className="admin-presence-chips" aria-label={locale === 'en' ? 'Online users' : '在线人数'}>
          <button type="button" className={open && section === 'admin' ? 'active' : ''} onClick={() => selectSection('admin')} aria-expanded={open && section === 'admin'}>
            <i aria-hidden="true" />
            <span>{locale === 'en' ? 'Backend online' : '后台在线'}</span>
            <strong>{presence.admin.count == null ? '…' : presence.admin.count}</strong>
          </button>
          <button type="button" className={open && section === 'staff' ? 'active' : ''} onClick={() => selectSection('staff')} aria-expanded={open && section === 'staff'}>
            <i aria-hidden="true" />
            <span>{locale === 'en' ? 'Staff online' : '员工在线'}</span>
            <strong>{presence.staff.count == null ? '…' : presence.staff.count}</strong>
          </button>
        </div>

        {open && <section className="admin-presence-popover" role="dialog" aria-modal="false" aria-label={locale === 'en' ? 'Online user list' : '在线人员列表'}>
          <header>
            <div><strong>{section === 'admin' ? (locale === 'en' ? 'Backend users online' : '后台在线人员') : (locale === 'en' ? 'Staff online' : '员工端在线人员')}</strong><small>{locale === 'en' ? 'Based on the current app session' : '按当前系统登录会话判断'}</small></div>
            <button type="button" onClick={() => load()} disabled={presence.loading}>{presence.loading ? (locale === 'en' ? 'Loading…' : '读取中…') : (locale === 'en' ? 'Refresh' : '刷新')}</button>
          </header>
          {presence.error && <p className="admin-presence-error">{presence.error}</p>}
          {!rows.length && !presence.loading
            ? <p className="admin-presence-empty">{locale === 'en' ? 'No one is online in this portal.' : '当前没有在线账号。'}</p>
            : <ul>{rows.map((row, index) => <PresenceRow key={`${row.portal}-${row.employee_no || row.username || index}`} row={row} locale={locale} />)}</ul>}
          <footer><span className="admin-presence-live-dot" aria-hidden="true" />{locale === 'en' ? 'Updated every minute; offline after 5 minutes without a heartbeat.' : '每分钟更新；连续 5 分钟没有心跳即显示离线。'}</footer>
        </section>}
      </div>}

      <Link className="admin-topbar-help" to="/admin/manual" aria-label={locale === 'en' ? 'Backend feature manual' : '后台功能用途手册'} title={locale === 'en' ? 'Backend feature manual' : '后台功能用途手册'}><span aria-hidden="true">?</span><b>{locale === 'en' ? 'Manual' : '功能手册'}</b></Link>
      <div className="admin-topbar-alert"><AdminAlertBell access={access} /></div>
      <div className="admin-topbar-account" title={login}>
        <span aria-hidden="true">{accountName.slice(0,1).toUpperCase()}</span>
        <div><strong data-admin-i18n-skip>{accountName}</strong><small data-admin-i18n-skip>{accountMeta || (locale === 'en' ? 'Backend account' : '后台账号')}</small></div>
      </div>
    </div>
  </header>
}
