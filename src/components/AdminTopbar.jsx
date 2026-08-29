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
  countOnly:true,
  admin:{ count:null, rows:[] },
  staff:{ count:null, rows:[] },
}

const clean = value => String(value ?? '').trim()
const PRESENCE_COUNT_REFRESH_MS = 3 * 60 * 1000
const PRESENCE_INITIAL_JITTER_MS = 15 * 1000
const PRESENCE_POLL_JITTER_MS = 30 * 1000
const PRESENCE_MAX_BACKOFF_MS = 15 * 60 * 1000
const presenceJitter = maximum => Math.floor(Math.random() * Math.max(1, maximum))
const presencePollDelay = failures => Math.min(
  PRESENCE_MAX_BACKOFF_MS,
  PRESENCE_COUNT_REFRESH_MS * (2 ** Math.min(3, Math.max(0, failures))),
) + presenceJitter(PRESENCE_POLL_JITTER_MS)

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
  const mountedRef = useRef(false)
  const flightRef = useRef(null)
  const lastCountAtRef = useRef(0)
  const failureCountRef = useRef(0)
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState('admin')
  const [presence, setPresence] = useState(emptyPresence)
  const enabled = Boolean(access && !access.loading && !access.error)
  const canPresence = Boolean(
    access?.founder ||
    access?.permissions?.includes('*') ||
    access?.permissions?.includes(PERMISSIONS.ACCOUNT_ONLINE_PRESENCE_VIEW)
  )
  const canManual = Boolean(access?.founder || access?.permissions?.includes('*') || access?.permissions?.includes(PERMISSIONS.ACCOUNT_MANUAL_VIEW))

  const load = ({ quiet=false, force=false } = {}) => {
    if (!enabled || !canPresence) return Promise.resolve(false)
    const lastCompletedAt = lastCountAtRef.current
    const freshness = PRESENCE_COUNT_REFRESH_MS
    if (!force && lastCompletedAt && Date.now() - lastCompletedAt < freshness) {
      return Promise.resolve(true)
    }

    const currentFlight = flightRef.current
    if (currentFlight) {
      return currentFlight.promise
    }

    const requestId = ++requestRef.current
    const controller = new AbortController()
    if (!quiet) setPresence(current => ({ ...current, loading:true, error:'' }))
    const entry = { controller, promise:null }
    const promise = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('admin-accounts', {
          body:{ action:'online_presence' },
          signal:controller.signal,
          timeout:12000,
        })
        if (error || data?.error) throw new Error(data?.error || error?.message || 'ONLINE_PRESENCE_FAILED')
        if (!mountedRef.current || requestId !== requestRef.current) return false
        const completedAt = Date.now()
        lastCountAtRef.current = completedAt
        failureCountRef.current = 0
        setPresence(current => ({
          loading:false,
          error:'',
          refreshedAt:data?.refreshed_at || new Date(completedAt).toISOString(),
          countOnly:data?.degraded === true,
          admin:{
            count:Number(data?.admin?.count || 0),
            rows:Array.isArray(data?.admin?.rows) ? data.admin.rows : current.admin.rows,
          },
          staff:{
            count:Number(data?.staff?.count || 0),
            rows:Array.isArray(data?.staff?.rows) ? data.staff.rows : current.staff.rows,
          },
        }))
        return true
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current || requestId !== requestRef.current) return false
        failureCountRef.current = Math.min(3, failureCountRef.current + 1)
        setPresence(current => ({
          ...current,
          loading:false,
          error:locale === 'en' ? 'Unable to load online users.' : '在线人员读取失败，请稍后重试。',
        }))
        return false
      } finally {
        if (flightRef.current === entry) flightRef.current = null
      }
    })()
    entry.promise = promise
    flightRef.current = entry
    return promise
  }

  useEffect(() => {
    if (!enabled || !canPresence) return undefined
    mountedRef.current = true
    let timer = 0
    let stopped = false
    const clearTimer = () => {
      window.clearTimeout(timer)
      timer = 0
    }
    const schedule = delay => {
      clearTimer()
      if (stopped || document.visibilityState !== 'visible') return
      timer = window.setTimeout(async () => {
        if (stopped || document.visibilityState !== 'visible') return
        await load({ quiet:true })
        if (!stopped) schedule(presencePollDelay(failureCountRef.current))
      }, Math.max(0, delay))
    }
    const resume = () => {
      if (document.visibilityState !== 'visible') return
      const age = Date.now() - lastCountAtRef.current
      const dueIn = lastCountAtRef.current
        ? Math.max(0, PRESENCE_COUNT_REFRESH_MS - age) + presenceJitter(PRESENCE_INITIAL_JITTER_MS)
        : presenceJitter(PRESENCE_INITIAL_JITTER_MS)
      schedule(dueIn)
    }
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') resume()
      else {
        clearTimer()
        flightRef.current?.controller.abort()
      }
    }
    resume()
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      stopped = true
      mountedRef.current = false
      requestRef.current += 1
      clearTimer()
      flightRef.current?.controller.abort()
      flightRef.current = null
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', visibilityChanged)
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
            <button type="button" onClick={() => load({force:true})} disabled={presence.loading}>{presence.loading ? (locale === 'en' ? 'Loading…' : '读取中…') : (locale === 'en' ? 'Refresh' : '刷新')}</button>
          </header>
          {presence.error && <p className="admin-presence-error">{presence.error}</p>}
          {presence.countOnly && !presence.loading
            ? <p className="admin-presence-empty">{locale === 'en' ? 'Recovery mode currently shows counts only; the user list remains paused to protect database capacity.' : '稳定恢复期间仅显示人数；人员名单继续暂停，避免增加数据库压力。'}</p>
            : !rows.length && !presence.loading
            ? <p className="admin-presence-empty">{locale === 'en' ? 'No one is online in this portal.' : '当前没有在线账号。'}</p>
            : <ul>{rows.map((row, index) => <PresenceRow key={`${row.portal}-${row.employee_no || row.username || index}`} row={row} locale={locale} />)}</ul>}
          <footer><span className="admin-presence-live-dot" aria-hidden="true" />{locale === 'en' ? 'Counts refresh about every 3 minutes; offline after 5 minutes without a heartbeat.' : '人数约每 3 分钟更新；连续 5 分钟没有心跳即显示离线。'}</footer>
        </section>}
      </div>}

      {canManual && <Link className="admin-topbar-help" to="/admin/manual" aria-label={locale === 'en' ? 'Backend feature manual' : '后台功能用途手册'} title={locale === 'en' ? 'Backend feature manual' : '后台功能用途手册'}><span aria-hidden="true">?</span><b>{locale === 'en' ? 'Manual' : '功能手册'}</b></Link>}
      <div className="admin-topbar-alert"><AdminAlertBell access={access} /></div>
      <div className="admin-topbar-account" title={login}>
        <span aria-hidden="true">{accountName.slice(0,1).toUpperCase()}</span>
        <div><strong data-admin-i18n-skip>{accountName}</strong><small data-admin-i18n-skip>{accountMeta || (locale === 'en' ? 'Backend account' : '后台账号')}</small></div>
      </div>
    </div>
  </header>
}
