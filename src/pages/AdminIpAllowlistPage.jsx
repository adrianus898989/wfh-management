import React, { useEffect, useState } from 'react'
import AdminModuleNav from '../components/AdminModuleNav'
import { useAdminAccess } from '../lib/adminAccess'
import { withAbortTimeout } from '../lib/abortableRequest'
import { readFunctionResponsePayload } from '../lib/functionErrors'
import { supabase } from '../lib/supabase'

const IP_ALLOWLIST_REQUEST_TIMEOUT_MS = 15 * 1000

const blankEntry = () => ({
  id: '',
  ip_network: '',
  label: '',
  notes: '',
  enabled: true,
  portal_scope: 'admin',
})

const dateTime = value => {
  const date = new Date(value || '')
  if (!Number.isFinite(date.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export default function AdminIpAllowlistPage() {
  const access = useAdminAccess()
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modal, setModal] = useState(null)

  const call = async body => {
    try {
      const result = await withAbortTimeout(
        signal => supabase.functions.invoke('admin-ip-allowlist', { body, signal }),
        IP_ALLOWLIST_REQUEST_TIMEOUT_MS,
        'IP_ALLOWLIST_TIMEOUT',
      )
      const payload = await readFunctionResponsePayload(result)
      if (result.error || payload?.error) {
        throw new Error(payload?.error || '白名单服务暂时不可用，请稍后重试')
      }
      return payload
    } catch (requestError) {
      if (requestError?.code === 'IP_ALLOWLIST_TIMEOUT'
        || requestError?.message === 'IP_ALLOWLIST_TIMEOUT') {
        throw new Error(body?.action === 'list'
          ? '读取白名单超时，请重试'
          : '保存响应超时；本次操作可能已经完成，请先刷新确认，未生效再重试')
      }
      if (requestError instanceof Error) throw requestError
      throw new Error('白名单服务连接失败，请稍后重试')
    }
  }

  const load = async ({ background = false } = {}) => {
    if (!background) setLoading(true)
    setError('')
    try {
      setSnapshot(await call({ action: 'list' }))
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      if (!background) setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const mutate = async (body, successMessage) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await call(body)
      if (response?.settings || Array.isArray(response?.entries)) {
        setSnapshot(response)
      } else if (response?.refresh_required) {
        // Mutation responses stay small so saving is released immediately.
        // Reload the canonical, permission-checked snapshot in the background.
        void load({ background: true })
      }
      setNotice(successMessage)
      return { ok: true, error: '' }
    } catch (mutationError) {
      const message = mutationError?.message || '保存失败，请稍后重试'
      setError(message)
      return { ok: false, error: message }
    } finally {
      setSaving(false)
    }
  }

  const settings = snapshot?.settings || {}
  const entries = snapshot?.entries || []
  const currentIpCovered = Boolean(snapshot?.current_ip_coverage?.admin ?? snapshot?.current_ip_covered)
  const currentIpCoveredForStaff = Boolean(snapshot?.current_ip_coverage?.staff)

  const addCurrentIp = async () => {
    if (!snapshot?.current_ip) {
      setError('服务端无法从可信代理读取当前IP，不能自动加入')
      return
    }
    await mutate(
      { action: 'add_current_ip', portal_scope: 'admin' },
      `当前IP ${snapshot.current_ip} 已加入后台范围并启用`,
    )
  }

  const toggleEnforcement = async portal => {
    const isStaff = portal === 'staff'
    const current = isStaff ? settings.staff_enforced : settings.enforced
    const next = !current
    const message = next
      ? isStaff
        ? '开启员工前端限制后，所有现有员工前端会话会退出，并且只有“员工前端/两者”范围的IP可以重新登录。已核对员工全部固定IP/CIDR及备用线路后才可开启。确认开启？'
        : '开启后台限制后，其他尚未验证IP的后台会话会退出。确认开启？'
      : isStaff
        ? '关闭后，员工前端不再限制登录IP。确认关闭？'
        : '关闭后，后台登录不再限制IP。确认关闭？'
    if (!window.confirm(message)) return
    await mutate(
      { action: 'set_enforced', portal, enforced: next },
      next
        ? `${isStaff ? '员工前端' : '后台'}登录IP白名单已开启`
        : `${isStaff ? '员工前端' : '后台'}登录IP白名单已关闭`,
    )
  }

  const saveEntry = async event => {
    event.preventDefault()
    if (!modal) return
    const form = modal.form
    if (!form.ip_network.trim() || !form.label.trim()) {
      setModal(current => ({ ...current, error: 'IP/CIDR 和标签必填' }))
      return
    }
    setModal(current => ({ ...current, saving: true, error: '' }))
    let outcome = { ok: false, error: '保存失败，请稍后重试' }
    try {
      outcome = await mutate({
        action: modal.mode,
        id: form.id || undefined,
        ip_network: form.ip_network,
        label: form.label,
        notes: form.notes,
        enabled: form.enabled,
        portal_scope: form.portal_scope,
      }, modal.mode === 'create' ? '白名单已新增' : '白名单已更新')
      if (outcome.ok) setModal(null)
      else setModal(current => current ? ({ ...current, error: outcome.error }) : current)
    } finally {
      setModal(current => current ? ({ ...current, saving: false }) : current)
    }
  }

  const toggleEntry = async entry => {
    await mutate({ action: 'set_enabled', id: entry.id, enabled: !entry.enabled },
      entry.enabled ? '白名单条目已停用' : '白名单条目已启用')
  }

  const deleteEntry = async entry => {
    if (!window.confirm(`确认删除「${entry.label}」(${entry.ip_network})？`)) return
    await mutate({ action: 'delete', id: entry.id }, '白名单条目已删除')
  }

  const recoveryCommand = "select session_private.founder_recover_admin_ip_allowlist('DISABLE ADMIN IP ALLOWLIST');"
  const staffRecoveryCommand = "select session_private.founder_recover_staff_ip_allowlist('DISABLE STAFF IP ALLOWLIST');"

  return <div className="content-page ip-allowlist-page">
    <div className="page-toolbar">
      <div>
        <div className="module-kicker">ACCESS CONTROL · TRUSTED NETWORKS</div>
        <h1>后台登入IP白名单</h1>
        <p>同一份网络清单可分别用于后台、员工前端或两者；两个入口独立开启，员工前端默认关闭。</p>
      </div>
      <div className="ip-allowlist-head-actions">
        <button type="button" className="secondary-action" onClick={load} disabled={loading || saving}>刷新</button>
        <button type="button" className="secondary-action" onClick={addCurrentIp} disabled={loading || saving || !snapshot?.current_ip}>一键加入当前IP</button>
        <button type="button" className="primary-action" onClick={() => setModal({ mode: 'create', form: blankEntry(), error: '', saving: false })} disabled={saving}>新增白名单</button>
      </div>
    </div>

    <AdminModuleNav />

    {error && <div className="page-error" role="alert">{error}</div>}
    {notice && <div className="ip-allowlist-notice" role="status">{notice}</div>}

    <section className={`ip-enforcement-card ${settings.effective ? 'on' : ''}`}>
      <div className="ip-enforcement-status">
        <span className="ip-status-dot" aria-hidden="true" />
        <div>
          <small>{settings.effective ? '正在强制执行' : settings.enforced ? '拒绝全部 / 配置异常' : '尚未开启'}</small>
          <strong>{settings.effective ? '仅白名单IP可登入后台' : settings.enforced ? '已打开开关，但没有可用条目' : '后台登录暂不限制IP'}</strong>
          <p>
            当前IP：<b>{snapshot?.current_ip || '可信代理未提供'}</b>
            {' · '}启用条目：{settings.enabled_count || 0}
            {' · '}最后设置：{settings.updated_by_label || '系统'} / {dateTime(settings.updated_at)}
          </p>
        </div>
      </div>
      <button type="button" className={`ip-enforcement-toggle ${settings.enforced ? 'on' : ''}`} onClick={() => toggleEnforcement('admin')} disabled={loading || saving}>
        <span>{settings.enforced ? '关闭白名单' : '开启白名单'}</span><i aria-hidden="true" />
      </button>
      {!settings.enforced && <div className="ip-bootstrap-rule">
        开启前请先点击“一键加入当前IP”。服务端会确认当前IP已命中启用条目，否则拒绝开启。
      </div>}
      {settings.enforced && !settings.effective && <div className="ip-bootstrap-rule warning">
        后台限制已开启但没有后台范围条目；服务端会拒绝全部后台访问。请用 Founder 恢复命令关闭后再补充条目。
      </div>}
      {!currentIpCovered && snapshot?.current_ip && !settings.enforced && <div className="ip-bootstrap-rule warning">
        当前IP尚未产生白名单命中记录；建议先一键加入当前IP，再开启。
      </div>}
    </section>

    <section className={`ip-enforcement-card ${settings.staff_effective ? 'on' : ''}`}>
      <div className="ip-enforcement-status">
        <span className="ip-status-dot" aria-hidden="true" />
        <div>
          <small>{settings.staff_effective ? '正在强制执行' : settings.staff_enforced ? '拒绝全部 / 配置异常' : '默认关闭 / 尚未开启'}</small>
          <strong>{settings.staff_effective ? '仅员工范围白名单IP可访问员工前端' : settings.staff_enforced ? '员工限制已开启，但没有可用员工网络' : '员工前端登录暂不限制IP'}</strong>
          <p>
            当前后台操作IP：<b>{snapshot?.current_ip || '可信代理未提供'}</b>
            {' · '}员工范围启用条目：{settings.staff_enabled_count || 0}
            {' · '}最后设置：{settings.staff_updated_by_label || '系统'} / {dateTime(settings.staff_updated_at)}
          </p>
        </div>
      </div>
      <button type="button" className={`ip-enforcement-toggle ${settings.staff_enforced ? 'on' : ''}`} onClick={() => toggleEnforcement('staff')} disabled={loading || saving}>
        <span>{settings.staff_enforced ? '关闭员工限制' : '开启员工限制'}</span><i aria-hidden="true" />
      </button>
      {!settings.staff_enforced && <div className="ip-bootstrap-rule">
        默认关闭，不会因部署此功能而影响员工。请先录入员工实际出口 IPv4/IPv6/CIDR 与备用线路，完成允许/拒绝网络测试后再开启。
      </div>}
      {settings.staff_enforced && !settings.staff_effective && <div className="ip-bootstrap-rule warning">
        员工限制已开启但没有员工范围条目；服务端会拒绝全部员工访问。请用 Founder 恢复命令关闭后再补充条目。
      </div>}
      {currentIpCoveredForStaff && <div className="ip-bootstrap-rule">
        当前后台操作IP也被员工范围覆盖；这只表示网络命中，不会自动为任何员工账号授权。
      </div>}
    </section>

    <section className="data-card ip-allowlist-table-card">
      <header>
        <div><strong>允许的 IP / CIDR</strong><span>支持 IPv4 与 IPv6，例如 203.0.113.8/32、2001:db8::/64</span></div>
        <span>{entries.length} 条</span>
      </header>
      {loading ? <div className="empty-state">读取中…</div> : entries.length === 0
        ? <div className="empty-state">尚无白名单。先“一键加入当前IP”，确认无误后再开启强制执行。</div>
        : <div className="table-scroll"><table className="data-table ip-allowlist-table">
          <thead><tr>
            <th>IP / CIDR</th><th>适用范围</th><th>标签 / 备注</th><th>状态</th><th>创建</th><th>最后命中</th><th>操作</th>
          </tr></thead>
          <tbody>{entries.map(entry => <tr key={entry.id}>
            <td><code>{entry.ip_network}</code></td>
            <td><span className="status-chip">{{ admin: '后台', staff: '员工前端', both: '后台 + 员工' }[entry.portal_scope] || '后台'}</span></td>
            <td><strong>{entry.label}</strong><small>{entry.notes || '—'}</small></td>
            <td><span className={`status-chip ${entry.enabled ? '' : 'off'}`}>{entry.enabled ? '启用' : '停用'}</span></td>
            <td><strong>{entry.created_by_label}</strong><small>{dateTime(entry.created_at)}</small></td>
            <td>{entry.last_hit_at
              ? <><strong>{dateTime(entry.last_hit_at)}</strong><small>{entry.last_hit_ip} · {entry.last_hit_user_label || '未知账号'} · {entry.hit_count || 0} 次</small></>
              : <span>尚未命中</span>}</td>
            <td><div className="ip-row-actions">
              <button type="button" className="table-action" onClick={() => setModal({ mode: 'update', form: { ...entry }, error: '', saving: false })}>编辑</button>
              <button type="button" className="table-action" onClick={() => toggleEntry(entry)} disabled={saving}>{entry.enabled ? '停用' : '启用'}</button>
              <button type="button" className="table-action danger" onClick={() => deleteEntry(entry)} disabled={saving}>删除</button>
            </div></td>
          </tr>)}</tbody>
        </table></div>}
    </section>

    {access.founder && <details className="ip-recovery-card">
      <summary>Founder 锁定恢复方法</summary>
      <p>如果代理配置错误或所有允许网络都不可达，请在 Supabase SQL Editor 以项目所有者身份执行下面的一次性恢复命令。该函数不授予 authenticated / service_role 调用权限。</p>
      <code>{recoveryCommand}</code>
      <button type="button" className="secondary-action" onClick={() => navigator.clipboard?.writeText(recoveryCommand)}>复制恢复命令</button>
      <p>如果只有员工前端范围配置错误，请关闭员工前端限制（不会关闭后台限制）：</p>
      <code>{staffRecoveryCommand}</code>
      <button type="button" className="secondary-action" onClick={() => navigator.clipboard?.writeText(staffRecoveryCommand)}>复制员工前端恢复命令</button>
    </details>}

    {modal && <div className="modal-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !modal.saving) setModal(null) }}>
      <form className="modal-card ip-entry-modal" onSubmit={saveEntry}>
        <div className="modal-head"><h2>{modal.mode === 'create' ? '新增IP白名单' : '编辑IP白名单'}</h2><button type="button" onClick={() => setModal(null)} disabled={modal.saving}>×</button></div>
        {modal.error && <div className="page-error">{modal.error}</div>}
        <div className="form-grid">
          <label>IP / CIDR<input value={modal.form.ip_network} onChange={event => setModal(current => ({ ...current, form: { ...current.form, ip_network: event.target.value } }))} placeholder="203.0.113.8/32" required /></label>
          <label>标签<input value={modal.form.label} maxLength={80} onChange={event => setModal(current => ({ ...current, form: { ...current.form, label: event.target.value } }))} placeholder="办公室固定网络" required /></label>
          <label>适用范围<select value={modal.form.portal_scope || 'admin'} onChange={event => setModal(current => ({ ...current, form: { ...current.form, portal_scope: event.target.value } }))}>
            <option value="admin">仅后台</option>
            <option value="staff">仅员工前端</option>
            <option value="both">后台 + 员工前端</option>
          </select></label>
          <label className="ip-entry-notes">备注<textarea value={modal.form.notes || ''} maxLength={500} onChange={event => setModal(current => ({ ...current, form: { ...current.form, notes: event.target.value } }))} placeholder="线路、负责人或变更原因" /></label>
        </div>
        <label className="ip-entry-enabled"><input type="checkbox" checked={modal.form.enabled !== false} onChange={event => setModal(current => ({ ...current, form: { ...current.form, enabled: event.target.checked } }))} /> 保存后立即启用</label>
        <div className="modal-actions"><button type="button" className="secondary-action" onClick={() => setModal(null)} disabled={modal.saving}>取消</button><button type="submit" className="primary-action" disabled={modal.saving || saving}>{modal.saving || saving ? '保存中…' : '保存'}</button></div>
      </form>
    </div>}
  </div>
}
