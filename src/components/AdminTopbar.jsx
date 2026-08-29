import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAdminI18n } from '../lib/adminI18n'
import { AdminAlertBell } from './AdminAlertCenter'
import { PERMISSIONS } from '../config/permissions'
import '../styles-admin-topbar.css'

const emptyPresence = {
  loading:true,
  countError:'',
  refreshedAt:'',
  countOnly:true,
  admin:{ count:null, rows:[], page:1, pages:1, total:0, detailLoading:false, detailError:'', detailLoadedAt:'' },
  staff:{ count:null, rows:[], page:1, pages:1, total:0, detailLoading:false, detailError:'', detailLoadedAt:'' },
}

const clean = value => String(value ?? '').trim()
const PRESENCE_COUNT_REFRESH_MS = 3 * 60 * 1000
const PRESENCE_INITIAL_JITTER_MS = 15 * 1000
const PRESENCE_POLL_JITTER_MS = 30 * 1000
const PRESENCE_MAX_BACKOFF_MS = 15 * 60 * 1000
const PRESENCE_PAGE_SIZE = 20
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
  const countRequestRef = useRef(0)
  const detailRequestRef = useRef(0)
  const mountedRef = useRef(false)
  const countFlightRef = useRef(null)
  const detailFlightRef = useRef(null)
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

  const loadCounts = ({ quiet=false, force=false } = {}) => {
    if (!enabled || !canPresence) return Promise.resolve(false)
    const lastCompletedAt = lastCountAtRef.current
    const freshness = PRESENCE_COUNT_REFRESH_MS
    if (!force && lastCompletedAt && Date.now() - lastCompletedAt < freshness) {
      return Promise.resolve(true)
    }

    const currentFlight = countFlightRef.current
    if (currentFlight) {
      return currentFlight.promise
    }

    const requestId = ++countRequestRef.current
    const controller = new AbortController()
    if (!quiet) setPresence(current => ({ ...current, loading:true, countError:'' }))
    const entry = { controller, promise:null }
    const promise = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('admin-accounts', {
          body:{ action:'online_presence' },
          signal:controller.signal,
          timeout:12000,
        })
        if (error || data?.error) throw new Error(data?.error || error?.message || 'ONLINE_PRESENCE_FAILED')
        if (!mountedRef.current || requestId !== countRequestRef.current) return false
        const completedAt = Date.now()
        lastCountAtRef.current = completedAt
        failureCountRef.current = 0
        setPresence(current => ({
          loading:false,
          countError:'',
          refreshedAt:data?.refreshed_at || new Date(completedAt).toISOString(),
          countOnly:data?.count_only !== false,
          admin:{
            ...current.admin,
            count:Number(data?.admin?.count || 0),
          },
          staff:{
            ...current.staff,
            count:Number(data?.staff?.count || 0),
          },
        }))
        return true
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current || requestId !== countRequestRef.current) return false
        failureCountRef.current = Math.min(3, failureCountRef.current + 1)
        setPresence(current => ({
          ...current,
          loading:false,
          countError:locale === 'en' ? 'Unable to refresh online counts.' : '在线人数刷新失败，已保留上次结果。',
        }))
        return false
      } finally {
        if (countFlightRef.current === entry) countFlightRef.current = null
      }
    })()
    entry.promise = promise
    countFlightRef.current = entry
    return promise
  }

  const loadRows = (portal, { page=1 } = {}) => {
    if (!enabled || !canPresence || !['admin', 'staff'].includes(portal)) return Promise.resolve(false)
    const requestedPage = Math.max(1, Math.floor(Number(page) || 1))
    const currentFlight = detailFlightRef.current
    if (currentFlight?.portal === portal && currentFlight?.page === requestedPage) {
      return currentFlight.promise
    }
    currentFlight?.controller.abort()

    const requestId = ++detailRequestRef.current
    const controller = new AbortController()
    setPresence(current => ({
      ...current,
      [portal]:{
        ...current[portal],
        detailLoading:true,
        detailError:'',
      },
    }))
    const entry = { portal, page:requestedPage, controller, promise:null }
    const promise = (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('admin-accounts', {
          body:{
            action:'online_presence',
            include_rows:true,
            portal,
            page:requestedPage,
            page_size:PRESENCE_PAGE_SIZE,
          },
          signal:controller.signal,
          timeout:6500,
        })
        if (error || data?.error) throw new Error(data?.error || error?.message || 'ONLINE_PRESENCE_DETAIL_FAILED')
        const pageResult = data?.[portal]
        if (!pageResult || !Array.isArray(pageResult.rows)) throw new Error('ONLINE_PRESENCE_DETAIL_INVALID')
        if (!mountedRef.current || requestId !== detailRequestRef.current) return false

        const total = Math.max(0, Number(pageResult.total || 0))
        const pages = Math.max(1, Number(pageResult.pages || 1))
        const resolvedPage = Math.min(pages, Math.max(1, Number(pageResult.page || requestedPage)))
        setPresence(current => ({
          ...current,
          countOnly:false,
          [portal]:{
            ...current[portal],
            count:current[portal].count == null ? total : current[portal].count,
            rows:pageResult.rows,
            page:resolvedPage,
            pages,
            total,
            detailLoading:false,
            detailError:'',
            detailLoadedAt:data?.refreshed_at || new Date().toISOString(),
          },
        }))
        return true
      } catch (error) {
        if (controller.signal.aborted || !mountedRef.current || requestId !== detailRequestRef.current) return false
        setPresence(current => ({
          ...current,
          [portal]:{
            ...current[portal],
            detailLoading:false,
            detailError:locale === 'en'
              ? 'Unable to load this list. Counts were kept; retry when ready.'
              : '在线名单读取失败，人数与上次名单已保留，可重试。',
          },
        }))
        return false
      } finally {
        if (detailFlightRef.current === entry) detailFlightRef.current = null
      }
    })()
    entry.promise = promise
    detailFlightRef.current = entry
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
        await loadCounts({ quiet:true })
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
        countFlightRef.current?.controller.abort()
        detailFlightRef.current?.controller.abort()
      }
    }
    resume()
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      stopped = true
      mountedRef.current = false
      countRequestRef.current += 1
      detailRequestRef.current += 1
      clearTimer()
      countFlightRef.current?.controller.abort()
      detailFlightRef.current?.controller.abort()
      countFlightRef.current = null
      detailFlightRef.current = null
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
  const selectedPresence = presence[section]
  const rows = selectedPresence?.rows || []
  const selectSection = value => {
    setSection(value)
    setOpen(true)
    loadRows(value, { page:1 })
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
            <button type="button" onClick={() => loadRows(section, { page:selectedPresence.page })} disabled={selectedPresence.detailLoading}>{selectedPresence.detailLoading ? (locale === 'en' ? 'Loading…' : '读取中…') : (locale === 'en' ? 'Refresh list' : '刷新名单')}</button>
          </header>
          {presence.countError && <p className="admin-presence-warning">{presence.countError}</p>}
          {selectedPresence.detailError && <p className="admin-presence-error">{selectedPresence.detailError}</p>}
          {selectedPresence.detailLoading && !rows.length
            ? <p className="admin-presence-empty">{locale === 'en' ? 'Loading this page…' : '正在读取本页名单…'}</p>
            : !rows.length && !selectedPresence.detailError
            ? <p className="admin-presence-empty">{locale === 'en' ? 'No one is online in this portal.' : '当前没有在线账号。'}</p>
            : rows.length > 0
            ? <ul aria-busy={selectedPresence.detailLoading}>{rows.map((row, index) => <PresenceRow key={`${row.portal}-${row.employee_no || row.username || index}`} row={row} locale={locale} />)}</ul>
            : null}
          {(selectedPresence.detailLoadedAt || selectedPresence.total > 0) && <nav className="admin-presence-pagination" aria-label={locale === 'en' ? 'Online list pages' : '在线名单分页'}>
            <button type="button" disabled={selectedPresence.detailLoading || selectedPresence.page <= 1} onClick={() => loadRows(section, { page:selectedPresence.page - 1 })}>{locale === 'en' ? 'Previous' : '上一页'}</button>
            <span>{locale === 'en' ? `${selectedPresence.page} / ${selectedPresence.pages} · ${selectedPresence.total}` : `第 ${selectedPresence.page} / ${selectedPresence.pages} 页 · 共 ${selectedPresence.total} 人`}</span>
            <button type="button" disabled={selectedPresence.detailLoading || selectedPresence.page >= selectedPresence.pages} onClick={() => loadRows(section, { page:selectedPresence.page + 1 })}>{locale === 'en' ? 'Next' : '下一页'}</button>
          </nav>}
          <footer><span className="admin-presence-live-dot" aria-hidden="true" />{locale === 'en' ? 'Counts refresh about every 3 minutes; lists load only when opened; offline after 5 minutes without a heartbeat.' : '人数约每 3 分钟更新；名单只在展开时读取；连续 5 分钟没有心跳即显示离线。'}</footer>
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
