import React, { useEffect, useState } from 'react'
import AdminModuleNav from '../components/AdminModuleNav'
import { useAdminAccess } from '../lib/adminAccess'
import { readFunctionResponsePayload } from '../lib/functionErrors'
import { supabase } from '../lib/supabase'

const blankEntry = () => ({
  id: '',
  ip_network: '',
  label: '',
  notes: '',
  enabled: true,
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
    const result = await supabase.functions.invoke('admin-ip-allowlist', { body })
    const payload = await readFunctionResponsePayload(result)
    if (result.error || payload?.error) {
      throw new Error(payload?.error || result.error?.message || '操作失败')
    }
    return payload
  }

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setSnapshot(await call({ action: 'list' }))
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const mutate = async (body, successMessage) => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      setSnapshot(await call(body))
      setNotice(successMessage)
      return true
    } catch (mutationError) {
      setError(mutationError.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  const settings = snapshot?.settings || {}
  const entries = snapshot?.entries || []
  const currentIpCovered = Boolean(snapshot?.current_ip_covered)

  const addCurrentIp = async () => {
    if (!snapshot?.current_ip) {
      setError('服务端无法从可信代理读取当前IP，不能自动加入')
      return
    }
    await mutate(
      { action: 'add_current_ip' },
      `当前IP ${snapshot.current_ip} 已加入并启用`,
    )
  }

  const toggleEnforcement = async () => {
    const next = !settings.enforced
    const message = next
      ? '开启后，其他尚未验证IP的后台会话会退出。确认开启？'
      : '关闭后，后台登录不再限制IP。确认关闭？'
    if (!window.confirm(message)) return
    await mutate(
      { action: 'set_enforced', enforced: next },
      next ? '后台登录IP白名单已开启' : '后台登录IP白名单已关闭',
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
    const ok = await mutate({
      action: modal.mode,
      id: form.id || undefined,
      ip_network: form.ip_network,
      label: form.label,
      notes: form.notes,
      enabled: form.enabled,
    }, modal.mode === 'create' ? '白名单已新增' : '白名单已更新')
    if (ok) setModal(null)
    else setModal(current => current ? ({ ...current, saving: false, error: '保存失败，请查看页面提示' }) : current)
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

  return <div className="content-page ip-allowlist-page">
    <div className="page-toolbar">
      <div>
        <div className="module-kicker">ACCESS CONTROL · TRUSTED NETWORKS</div>
        <h1>后台登入IP白名单</h1>
        <p>只限制后台账号登录与持续会话；员工前端不受影响。</p>
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
          <small>{settings.effective ? '正在强制执行' : settings.enforced ? '安全暂停' : '尚未开启'}</small>
          <strong>{settings.effective ? '仅白名单IP可登入后台' : settings.enforced ? '已打开开关，但没有可用条目' : '后台登录暂不限制IP'}</strong>
          <p>
            当前IP：<b>{snapshot?.current_ip || '可信代理未提供'}</b>
            {' · '}启用条目：{settings.enabled_count || 0}
            {' · '}最后设置：{settings.updated_by_label || '系统'} / {dateTime(settings.updated_at)}
          </p>
        </div>
      </div>
      <button type="button" className={`ip-enforcement-toggle ${settings.enforced ? 'on' : ''}`} onClick={toggleEnforcement} disabled={loading || saving}>
        <span>{settings.enforced ? '关闭白名单' : '开启白名单'}</span><i aria-hidden="true" />
      </button>
      {!settings.enforced && <div className="ip-bootstrap-rule">
        开启前请先点击“一键加入当前IP”。服务端会确认当前IP已命中启用条目，否则拒绝开启。
      </div>}
      {settings.enforced && !settings.effective && <div className="ip-bootstrap-rule warning">
        零条启用记录时自动进入 bootstrap 安全暂停，不会锁死全部后台账号；请立即补充条目或关闭开关。
      </div>}
      {!currentIpCovered && snapshot?.current_ip && !settings.enforced && <div className="ip-bootstrap-rule warning">
        当前IP尚未产生白名单命中记录；建议先一键加入当前IP，再开启。
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
            <th>IP / CIDR</th><th>标签 / 备注</th><th>状态</th><th>创建</th><th>最后命中</th><th>操作</th>
          </tr></thead>
          <tbody>{entries.map(entry => <tr key={entry.id}>
            <td><code>{entry.ip_network}</code></td>
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
    </details>}

    {modal && <div className="modal-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !modal.saving) setModal(null) }}>
      <form className="modal-card ip-entry-modal" onSubmit={saveEntry}>
        <div className="modal-head"><h2>{modal.mode === 'create' ? '新增IP白名单' : '编辑IP白名单'}</h2><button type="button" onClick={() => setModal(null)} disabled={modal.saving}>×</button></div>
        {modal.error && <div className="page-error">{modal.error}</div>}
        <div className="form-grid">
          <label>IP / CIDR<input value={modal.form.ip_network} onChange={event => setModal(current => ({ ...current, form: { ...current.form, ip_network: event.target.value } }))} placeholder="203.0.113.8/32" required /></label>
          <label>标签<input value={modal.form.label} maxLength={80} onChange={event => setModal(current => ({ ...current, form: { ...current.form, label: event.target.value } }))} placeholder="办公室固定网络" required /></label>
          <label className="ip-entry-notes">备注<textarea value={modal.form.notes || ''} maxLength={500} onChange={event => setModal(current => ({ ...current, form: { ...current.form, notes: event.target.value } }))} placeholder="线路、负责人或变更原因" /></label>
        </div>
        <label className="ip-entry-enabled"><input type="checkbox" checked={modal.form.enabled !== false} onChange={event => setModal(current => ({ ...current, form: { ...current.form, enabled: event.target.checked } }))} /> 保存后立即启用</label>
        <div className="modal-actions"><button type="button" className="secondary-action" onClick={() => setModal(null)} disabled={modal.saving}>取消</button><button type="submit" className="primary-action" disabled={modal.saving || saving}>{modal.saving || saving ? '保存中…' : '保存'}</button></div>
      </form>
    </div>}
  </div>
}
