import React, { useEffect, useMemo, useState } from 'react'
import { useAdminI18n } from '../lib/adminI18n'
import { supabase } from '../lib/supabase'
import '../data-entry-logs.css'

const clean = value => String(value ?? '').trim()

const formatDateTime = (value, locale) => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return clean(value) || '—'
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

const eventLabel = (kind, t) => ({
  bonus: t('奖金'), deduction: t('扣款'), public_holiday: t('公休'),
  home_leave: t('回家'), leave: t('请假'), half_day: t('半天'),
  absence: t('缺席'), resignation: t('离职'),
})[clean(kind).toLowerCase()] || clean(kind) || '—'

const actionLabel = (action, t) => clean(action).toLowerCase() === 'update' ? t('修改') : t('新增')

const amountLabel = row => {
  if (row.amount === null || row.amount === undefined || row.amount === '') return '—'
  const amount = Number(row.amount)
  const formatted = Number.isFinite(amount) ? amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) : clean(row.amount)
  return `${clean(row.currency) || '—'} ${formatted}`
}

/**
 * Reusable business panel for the two operator audit subpages.
 * Navigation is intentionally owned by the admin shell, so this component can be
 * mounted under either the workforce log group or the attendance/reward group.
 */
export default function AdminDataEntryLogs({ category = 'adjustment' }) {
  const { locale, t } = useAdminI18n()
  const normalizedCategory = category === 'attendance' ? 'attendance' : 'adjustment'
  const title = normalizedCategory === 'attendance' ? t('出勤录入日志') : t('奖金扣款录入日志')
  const [filters, setFilters] = useState({ search: '', dateFrom: '', dateTo: '' })
  const [applied, setApplied] = useState({ search: '', dateFrom: '', dateTo: '' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [state, setState] = useState({ loading: true, error: '', data: { rows: [], total: 0, pages: 1 } })

  const load = async () => {
    setState(current => ({ ...current, loading: true, error: '' }))
    const { data, error } = await supabase.rpc('admin_data_entry_logs', {
      p_category: normalizedCategory,
      p_search: clean(applied.search) || null,
      p_date_from: applied.dateFrom || null,
      p_date_to: applied.dateTo || null,
      p_page: page,
      p_page_size: pageSize,
    })
    if (error) {
      const message = clean(error.message)
      setState({
        loading: false,
        error: message.includes('permission_denied') ? t('当前账号没有查看此日志的权限。') : t('录入日志读取失败，请稍后重试。'),
        data: { rows: [], total: 0, pages: 1 },
      })
      return
    }
    setState({ loading: false, error: '', data: data || { rows: [], total: 0, pages: 1 } })
  }

  useEffect(() => { setPage(1) }, [normalizedCategory])
  useEffect(() => { load() }, [normalizedCategory, applied, page, pageSize])

  const rows = Array.isArray(state.data?.rows) ? state.data.rows : []
  const pages = Math.max(1, Number(state.data?.pages || 1))
  const total = Number(state.data?.total || 0)
  const subtitle = useMemo(() => normalizedCategory === 'attendance'
    ? t('仅显示后台账号录入或修改的出勤记录；Google 表格同步记录不冒充人工录入。')
    : t('显示后台新增或修改的奖金、扣款记录，以及系统保存的录入账号。'), [normalizedCategory, t])

  const submit = event => {
    event.preventDefault()
    const next = {
      search: clean(filters.search),
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    }
    if (page === 1 && JSON.stringify(next) === JSON.stringify(applied)) load()
    else { setPage(1); setApplied(next) }
  }

  const reset = () => {
    const empty = { search: '', dateFrom: '', dateTo: '' }
    const alreadyEmpty = page === 1 && JSON.stringify(applied) === JSON.stringify(empty)
    setFilters(empty)
    setApplied(empty)
    setPage(1)
    if (alreadyEmpty) load()
  }

  return <section className="admin-entry-logs">
    <header className="admin-entry-logs-head">
      <div><small>DATA ENTRY AUDIT</small><h2>{title}</h2><p>{subtitle}</p></div>
      <strong>{locale === 'en' ? `${total.toLocaleString()} records` : `${total.toLocaleString()} 条`}</strong>
    </header>
    <form className="admin-entry-log-filters" onSubmit={submit}>
      <label><span>{t('员工 / 录入账号 / 原因')}</span><input value={filters.search} onChange={event => setFilters(current => ({ ...current, search: event.target.value }))} placeholder={t('输入员工ID、姓名、录入账号或原因')} /></label>
      <label><span>{t('开始日期')}</span><input type="date" value={filters.dateFrom} onChange={event => setFilters(current => ({ ...current, dateFrom: event.target.value }))} /></label>
      <label><span>{t('结束日期')}</span><input type="date" value={filters.dateTo} onChange={event => setFilters(current => ({ ...current, dateTo: event.target.value }))} /></label>
      <button className="primary" type="submit">{t('查询')}</button>
      <button type="button" onClick={reset}>{t('重置')}</button>
    </form>
    {state.error && <div className="admin-entry-log-error"><span>{state.error}</span><button type="button" onClick={load}>{t('重试')}</button></div>}
    <div className="admin-entry-log-table"><table>
      <thead><tr><th>{t('录入 / 更新时间')}</th><th>{t('录入账号')}</th><th>{t('员工')}</th><th>{t('记录日期')}</th><th>{t('记录类型')}</th>{normalizedCategory === 'adjustment' && <th>{t('金额')}</th>}<th>{t('原因 / 备注')}</th><th>{t('数据来源 / 同步')}</th></tr></thead>
      <tbody>{state.loading ? <tr><td colSpan={normalizedCategory === 'adjustment' ? 8 : 7}><div className="admin-entry-log-empty">{t('正在读取录入日志…')}</div></td></tr> : rows.length ? rows.map(row => <tr key={row.id}>
        <td><b>{actionLabel(row.action, t)}</b><span>{formatDateTime(row.created_at, locale)}</span></td>
        <td><b>{row.actor_name || t('系统 / 外部同步')}</b><span>{row.actor_user_id || '—'}</span></td>
        <td><b>{row.employee_no || '—'}</b><span>{row.full_name || '—'}</span></td>
        <td>{row.event_date || '—'}</td>
        <td><i className={`entry-kind ${clean(row.event_kind).toLowerCase()}`}>{eventLabel(row.event_kind, t)}</i></td>
        {normalizedCategory === 'adjustment' && <td><b className={Number(row.amount) < 0 || clean(row.event_kind).toLowerCase() === 'deduction' ? 'entry-amount negative' : 'entry-amount positive'}>{amountLabel(row)}</b></td>}
        <td className="entry-log-reason"><b>{row.reason || '—'}</b><span>{row.note || '—'}</span></td>
        <td><b>{row.source || '—'}</b><span>{row.sync_state || '—'}</span></td>
      </tr>) : <tr><td colSpan={normalizedCategory === 'adjustment' ? 8 : 7}><div className="admin-entry-log-empty">{t('暂无符合条件的录入日志。')}</div></td></tr>}</tbody>
    </table></div>
    <footer className="admin-entry-log-pager">
      <label>{t('每页')}<select value={pageSize} onChange={event => { setPage(1); setPageSize(Number(event.target.value)) }}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label>
      <span>{locale === 'en' ? `Page ${page} / ${pages}` : `第 ${page} / ${pages} 页`}</span>
      <button type="button" disabled={state.loading || page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>{t('上一页')}</button>
      <button type="button" disabled={state.loading || page >= pages} onClick={() => setPage(value => value + 1)}>{t('下一页')}</button>
    </footer>
  </section>
}
