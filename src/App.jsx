import React, { useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import {
  Menu, ChevronDown, Languages, Bell, Search, ShieldCheck,
  Eye, EyeOff, Save, CheckCircle2, XCircle, KeyRound
} from 'lucide-react'
import { adminNavigation, staffNavigation } from './config/navigation'
import {
  DATA_SCOPE_LABELS, PERMISSION_GROUPS, PERMISSIONS,
  ROLE_LABELS, ROLE_TEMPLATES, ROLES,
  canAccessBackend, canAccessEmployeePortal, hasPermission
} from './config/permissions'
import { employeeProfile, mockUsers, payoutRequests } from './data/mock'
import { displayPayout, maskPhone, maskText } from './lib/privacy'

function filterAdminNav(user) {
  return adminNavigation
    .map(item => {
      if (!item.children) return item
      const children = item.children.filter(child => !child.permission || hasPermission(user, child.permission))
      return children.length ? { ...item, children } : null
    })
    .filter(Boolean)
}

function Sidebar({ mode, user }) {
  const location = useLocation()
  const navigate = useNavigate()
  const nav = mode === 'admin' ? filterAdminNav(user) : staffNavigation
  const [openGroups, setOpenGroups] = useState(new Set(['人员与团队', '排班与考勤', '系统管理']))

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">HS</div>
        <div>
          <div className="brand-title">居家员工管理系统</div>
          <div className="brand-sub">{mode === 'admin' ? 'ADMIN BACK OFFICE' : 'EMPLOYEE PORTAL'}</div>
        </div>
      </div>

      <nav className="nav">
        {nav.map(item => {
          const Icon = item.icon
          if (!item.children) {
            return (
              <button key={item.path} className={`nav-item ${location.pathname === item.path ? 'active' : ''}`} onClick={() => navigate(item.path)}>
                <Icon size={18}/><span>{item.label}</span>
              </button>
            )
          }

          const opened = openGroups.has(item.label)
          const activeGroup = item.children.some(x => location.pathname === x.path)
          return (
            <div key={item.label}>
              <button className={`nav-item ${activeGroup ? 'group-active' : ''}`} onClick={() => {
                const next = new Set(openGroups)
                opened ? next.delete(item.label) : next.add(item.label)
                setOpenGroups(next)
              }}>
                <Icon size={18}/><span>{item.label}</span><ChevronDown size={15} className={opened ? 'rotate' : ''}/>
              </button>
              {opened && <div className="nav-children">
                {item.children.map(child => (
                  <button key={child.path} className={`nav-child ${location.pathname === child.path ? 'active' : ''}`} onClick={() => navigate(child.path)}>
                    {child.label}
                  </button>
                ))}
              </div>}
            </div>
          )
        })}
      </nav>
    </aside>
  )
}

function Topbar({ user, mode, setPreviewUser, setMode }) {
  const availableModes = []
  if (canAccessBackend(user)) availableModes.push('admin')
  if (canAccessEmployeePortal(user)) availableModes.push('staff')

  return (
    <header className="topbar">
      <div className="top-search"><Search size={17}/><input placeholder="搜索员工、团队、功能..."/></div>
      <div className="top-actions">
        <button className="chip"><Languages size={16}/> 中文 / English</button>
        {availableModes.length > 1 && (
          <button className="mode-switch" onClick={() => setMode(mode === 'admin' ? 'staff' : 'admin')}>
            {mode === 'admin' ? '员工前端预览' : '返回后台'}
          </button>
        )}
        <select className="preview-select" value={user.id} onChange={e => setPreviewUser(e.target.value)}>
          {mockUsers.map(u => <option value={u.id} key={u.id}>{u.name} · {ROLE_LABELS[u.role]}</option>)}
        </select>
      </div>
    </header>
  )
}

function Guard({ user, mode, children }) {
  if (mode === 'admin' && !canAccessBackend(user)) {
    return <Navigate to="/staff" replace />
  }
  if (mode === 'staff' && !canAccessEmployeePortal(user)) {
    return <div className="blocked"><ShieldCheck size={42}/><h2>员工前端未开启</h2><p>此账号目前没有员工前端访问权限。</p></div>
  }
  return children
}

function AdminDashboard({ user }) {
  return (
    <>
      <PageHead eyebrow="后台管理端" title="控制台 Dashboard" desc="菜单会根据账号权限自动显示，没有权限的功能不会出现。" />
      <section className="metric-grid">
        <Metric label="当前角色" value={ROLE_LABELS[user.role]} note={DATA_SCOPE_LABELS[user.dataScope]} />
        <Metric label="后台访问" value={user.backendEnabled ? '已开启' : '未开启'} note="账号级开关" />
        <Metric label="员工前端" value={user.employeePortalEnabled ? '已开启' : '未开启'} note="与后台分开控制" />
        <Metric label="OTP" value={user.otpRequired ? '开启' : '关闭'} note="敏感操作可强制二次验证" />
      </section>
      <div className="panel">
        <h3>权限设计已经生效</h3>
        <p className="muted">左侧菜单会根据账号权限隐藏。正式接入 Supabase 后，数据库 RLS 还会再做第二层限制，不只是“隐藏按钮”。</p>
      </div>
    </>
  )
}

function Metric({ label, value, note }) {
  return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
}

function PageHead({ eyebrow, title, desc, right }) {
  return <div className="page-head">
    <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{desc}</p></div>
    {right}
  </div>
}

function UserPermissionsPage({ currentUser }) {
  const [users, setUsers] = useState(mockUsers)
  const [selectedId, setSelectedId] = useState('U002')
  const selected = users.find(x => x.id === selectedId)

  const updateSelected = patch => {
    setUsers(list => list.map(x => x.id === selectedId ? { ...x, ...patch } : x))
  }

  const applyRoleTemplate = role => {
    const template = ROLE_TEMPLATES[role]
    updateSelected({
      role,
      ...template,
      permissions: [...template.permissions]
    })
  }

  const togglePermission = p => {
    const set = new Set(selected.permissions || [])
    set.has(p) ? set.delete(p) : set.add(p)
    updateSelected({ permissions: [...set] })
  }

  return (
    <>
      <PageHead
        eyebrow="系统管理"
        title="用户与权限 / OTP"
        desc="角色只作为默认模板，最终以每个账号实际勾选的权限为准。Employee 默认没有后台。"
      />

      <div className="permission-layout">
        <aside className="panel account-list">
          <div className="panel-title">账号列表</div>
          {users.map(u => (
            <button key={u.id} onClick={() => setSelectedId(u.id)} className={`account-row ${u.id === selectedId ? 'active' : ''}`}>
              <div className="avatar-small">{u.name.slice(0,1)}</div>
              <div><strong>{u.name}</strong><small>{ROLE_LABELS[u.role]}</small></div>
            </button>
          ))}
        </aside>

        <section className="panel">
          <div className="form-grid two">
            <label>姓名<input value={selected.name} onChange={e => updateSelected({name:e.target.value})}/></label>
            <label>员工ID<input value={selected.employeeId} onChange={e => updateSelected({employeeId:e.target.value})}/></label>

            <label>角色
              <select value={selected.role} onChange={e => applyRoleTemplate(e.target.value)}>
                {Object.entries(ROLE_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>

            <label>数据范围
              <select value={selected.dataScope} onChange={e => updateSelected({dataScope:e.target.value})}>
                {Object.entries(DATA_SCOPE_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>

          <div className="switch-grid">
            <Toggle
              label="员工前端访问"
              checked={selected.employeePortalEnabled}
              onChange={v => updateSelected({employeePortalEnabled:v})}
              hint="工资 / 出勤 / 排班 / 考试 / 申请 / 个人资料"
            />
            <Toggle
              label="后台管理访问"
              checked={selected.backendEnabled}
              disabled={selected.role === ROLES.EMPLOYEE}
              onChange={v => updateSelected({backendEnabled:v})}
              hint={selected.role === ROLES.EMPLOYEE ? 'Employee 角色默认禁止后台' : '开启后才可进入后台'}
            />
            <Toggle
              label="登录 OTP"
              checked={selected.otpRequired}
              onChange={v => updateSelected({otpRequired:v})}
              hint="也可只在敏感操作时强制 OTP"
            />
          </div>

          <div className="permission-note">
            <ShieldCheck size={18}/>
            <span>敏感资料权限与普通查看权限分开。没有 <b>“查看完整收款资料”</b> 权限时，只显示遮罩。</span>
          </div>

          <div className="permission-groups">
            {PERMISSION_GROUPS.map(group => (
              <div className="permission-group" key={group.title}>
                <h4>{group.title}</h4>
                <div className="checkbox-grid">
                  {group.items.map(([key,label]) => (
                    <label className="check-row" key={key}>
                      <input
                        type="checkbox"
                        checked={selected.role === ROLES.FOUNDER || selected.permissions?.includes(key)}
                        disabled={selected.role === ROLES.FOUNDER}
                        onChange={() => togglePermission(key)}
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="footer-actions">
            <button className="secondary-btn">取消</button>
            <button className="primary-btn"><Save size={16}/> 保存账号权限</button>
          </div>
        </section>
      </div>
    </>
  )
}

function Toggle({ label, hint, checked, disabled, onChange }) {
  return <label className={`toggle-card ${disabled ? 'disabled' : ''}`}>
    <div><strong>{label}</strong><small>{hint}</small></div>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}/>
  </label>
}

function SensitiveExamplePage({ user }) {
  const canView = hasPermission(user, PERMISSIONS.SENSITIVE_PAYOUT_VIEW)
  return (
    <>
      <PageHead eyebrow="权限演示" title="员工敏感资料" desc="同一份资料，不同权限账号看到的内容不同。" />
      <div className="panel">
        <div className="sensitive-head">
          <div>
            <h3>Jodie Reyes · JA525122101</h3>
            <p className="muted">PH客服支持组 · 纯居家菲律宾</p>
          </div>
          <span className={`visibility-pill ${canView ? 'full' : 'masked'}`}>
            {canView ? <><Eye size={15}/> 已授权完整查看</> : <><EyeOff size={15}/> 敏感信息已遮罩</>}
          </span>
        </div>

        <div className="info-grid">
          <Info label="收款方式" value="GCash" />
          <Info label="账户姓名" value={canView ? employeeProfile.payout.accountName : 'J**** R****'} />
          <Info label="账号" value={canView ? employeeProfile.payout.accountNumber : maskPhone(employeeProfile.payout.accountNumber)} />
          <Info label="修改权限" value={hasPermission(user, PERMISSIONS.SENSITIVE_PAYOUT_EDIT) ? '允许' : '禁止'} />
        </div>
      </div>
    </>
  )
}

function Info({label,value}) {
  return <div className="info-box"><span>{label}</span><strong>{value}</strong></div>
}

function PayoutRequestPage() {
  const [step, setStep] = useState(1)
  const [method, setMethod] = useState('GCash')
  const [form, setForm] = useState({
    accountName: 'JODIE REYES',
    accountNumber: '',
    bankName: '',
    network: 'TRC20',
    address: '',
    confirmAddress: '',
    reason: '',
    note: ''
  })

  const isPureHomePH = employeeProfile.employeeType === 'pure_home_ph'
  const allowedMethods = isPureHomePH ? ['GCash', 'Maya', 'Bank'] : ['USDT']

  return (
    <>
      <PageHead eyebrow="员工前端" title="申请修改收款信息" desc="修改必须填写完整信息和原因，并通过 OTP 后才可提交审核。" />
      <div className="request-shell">
        <div className="panel">
          <div className="steps">
            {['填写新资料','OTP 验证','提交申请','等待审核'].map((x,i) => (
              <div className={step >= i+1 ? 'step active' : 'step'} key={x}><span>{i+1}</span>{x}</div>
            ))}
          </div>

          {step === 1 && (
            <>
              <div className="current-payout">
                <span>当前收款方式</span><strong>{employeeProfile.payout.method}</strong>
                <span>当前账号</span><strong>{maskPhone(employeeProfile.payout.accountNumber)}</strong>
              </div>

              <div className="method-tabs">
                {allowedMethods.map(x => <button className={method===x?'active':''} onClick={() => setMethod(x)} key={x}>{x}</button>)}
              </div>

              <div className="form-grid two">
                {method === 'USDT' ? <>
                  <label>Network *<select value={form.network} onChange={e=>setForm({...form,network:e.target.value})}><option>TRC20</option></select></label>
                  <label>USDT Address *<input value={form.address} onChange={e=>setForm({...form,address:e.target.value})}/></label>
                  <label className="span2">再次输入 USDT Address *<input value={form.confirmAddress} onChange={e=>setForm({...form,confirmAddress:e.target.value})}/></label>
                </> : <>
                  {method === 'Bank' && <label>银行名称 *<input value={form.bankName} onChange={e=>setForm({...form,bankName:e.target.value})}/></label>}
                  <label>Account Name *<input value={form.accountName} onChange={e=>setForm({...form,accountName:e.target.value})}/></label>
                  <label>Account Number *<input value={form.accountNumber} onChange={e=>setForm({...form,accountNumber:e.target.value})}/></label>
                </>}

                <label className="span2">修改原因 *<textarea value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} placeholder="必须写清楚为什么需要修改，例如：旧账号已停用、银行卡遗失、钱包无法使用..."/></label>
                <label className="span2">备注（可选）<textarea value={form.note} onChange={e=>setForm({...form,note:e.target.value})}/></label>
              </div>

              <div className="footer-actions">
                <button className="primary-btn" onClick={()=>setStep(2)}><KeyRound size={16}/> 下一步：OTP 验证</button>
              </div>
            </>
          )}

          {step === 2 && <OtpMock onBack={()=>setStep(1)} onNext={()=>setStep(3)} />}
          {step === 3 && (
            <div className="success-state">
              <CheckCircle2 size={54}/>
              <h3>OTP 验证成功</h3>
              <p>确认提交后，旧收款资料不会立即被覆盖，必须等待后台审核。</p>
              <button className="primary-btn" onClick={()=>setStep(4)}>确认提交申请</button>
            </div>
          )}
          {step === 4 && (
            <div className="success-state waiting">
              <ShieldCheck size={54}/>
              <h3>申请已提交，等待审核</h3>
              <p>审核通过后，新收款资料才会正式生效。</p>
            </div>
          )}
        </div>

        <aside className="panel rules-panel">
          <h3>收款方式规则</h3>
          <ul>
            <li><b>纯居家菲律宾</b>：GCash / Maya / Bank</li>
            <li><b>现场转居家</b>：USDT</li>
            <li><b>纯居家越南</b>：USDT</li>
            <li><b>纯居家印尼</b>：USDT</li>
            <li><b>纯居家缅甸</b>：USDT</li>
            <li><b>其他菲律宾方案</b>：USDT</li>
          </ul>
          <div className="warning-box">所有收款资料修改必须写原因并通过 OTP。</div>
        </aside>
      </div>
    </>
  )
}

function OtpMock({onBack,onNext}) {
  const [otp,setOtp] = useState('')
  return <div className="otp-box">
    <KeyRound size={42}/>
    <h3>OTP 身份验证</h3>
    <p>请输入您本人绑定的 OTP 验证码。正式版会由 Supabase MFA 校验。</p>
    <input className="otp-input" maxLength={6} value={otp} onChange={e=>setOtp(e.target.value.replace(/\D/g,''))} placeholder="000000"/>
    <div className="footer-actions center">
      <button className="secondary-btn" onClick={onBack}>上一步</button>
      <button className="primary-btn" disabled={otp.length!==6} onClick={onNext}>验证并继续</button>
    </div>
  </div>
}

function PayoutApprovalPage({ user }) {
  const canView = hasPermission(user, PERMISSIONS.SENSITIVE_PAYOUT_VIEW)
  const [selected, setSelected] = useState(payoutRequests[0])

  const renderValue = payout => {
    if (payout.method === 'USDT') return canView ? payout.address : maskText(payout.address,5,5)
    return canView ? payout.accountNumber : maskPhone(payout.accountNumber)
  }

  return (
    <>
      <PageHead eyebrow="系统管理" title="收款资料修改审核" desc="只有被授予审核权限的人才会看到此页面；完整敏感信息还需要额外的查看权限。" />

      <div className="approval-grid">
        <div className="panel">
          <table>
            <thead><tr><th>员工</th><th>团队</th><th>原方式</th><th>新方式</th><th>OTP</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {payoutRequests.map(r => (
                <tr key={r.id}>
                  <td><strong>{r.employeeName}</strong><small className="cell-sub">{r.employeeId}</small></td>
                  <td>{r.team}</td>
                  <td>{r.oldPayout.method}<small className="cell-sub">{renderValue(r.oldPayout)}</small></td>
                  <td>{r.newPayout.method}<small className="cell-sub">{renderValue(r.newPayout)}</small></td>
                  <td>{r.otpVerified ? '✅ 已验证' : '❌'}</td>
                  <td><span className="status orange">审核中</span></td>
                  <td><button className="link-btn" onClick={()=>setSelected(r)}>查看</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <aside className="panel approval-detail">
          <h3>申请详情</h3>
          <p className="muted">{selected.id}</p>

          <div className="compare-box">
            <div><span>原收款资料</span><strong>{selected.oldPayout.method}</strong><code>{renderValue(selected.oldPayout)}</code></div>
            <div><span>新收款资料</span><strong>{selected.newPayout.method}</strong><code>{renderValue(selected.newPayout)}</code></div>
          </div>

          <div className="detail-row"><span>修改原因</span><strong>{selected.reason}</strong></div>
          <div className="detail-row"><span>备注</span><strong>{selected.note || '-'}</strong></div>
          <div className="detail-row"><span>OTP</span><strong>{selected.otpVerified ? '已验证' : '未验证'}</strong></div>
          <div className="detail-row"><span>提交时间</span><strong>{selected.submittedAt}</strong></div>

          {!canView && <div className="permission-note"><EyeOff size={18}/> 当前账号没有“查看完整收款资料”权限，所以详细账号已遮罩。</div>}

          <div className="footer-actions">
            <button className="danger-btn"><XCircle size={16}/> 驳回</button>
            <button className="primary-btn"><CheckCircle2 size={16}/> 审核通过</button>
          </div>
        </aside>
      </div>
    </>
  )
}

function StaffHome() {
  return <>
    <PageHead eyebrow="员工前端" title={`Hi, ${employeeProfile.name}`} desc="这里只显示你自己的数据。" />
    <section className="metric-grid">
      <Metric label="今日班次" value="夜班" note="20:00 - 06:00"/>
      <Metric label="本月出勤" value="96.8%" note="仅本人"/>
      <Metric label="最新工资" value="USDT 1,350" note="已发布"/>
      <Metric label="待考试" value="2" note="查看考试"/>
    </section>
  </>
}

function ProfilePage() {
  const navigate = useNavigate()
  return <>
    <PageHead eyebrow="员工前端" title="我的资料" desc="员工只能查看自己的资料，敏感资料默认遮罩。" />
    <div className="panel">
      <div className="info-grid">
        <Info label="姓名" value={employeeProfile.name}/>
        <Info label="员工ID" value={employeeProfile.employeeId}/>
        <Info label="团队" value={employeeProfile.team}/>
        <Info label="岗位" value={employeeProfile.position}/>
        <Info label="直属组长" value={employeeProfile.directLeader}/>
        <Info label="培训老师" value={employeeProfile.trainer}/>
        <Info label="收款方式" value={employeeProfile.payout.method}/>
        <Info label="收款账号" value={maskPhone(employeeProfile.payout.accountNumber)}/>
      </div>
      <div className="footer-actions">
        <button className="primary-btn" onClick={()=>navigate('/staff/payout-change')}>申请修改收款信息</button>
      </div>
    </div>
  </>
}

function Placeholder({title,desc}) {
  return <>
    <PageHead eyebrow="页面骨架" title={title} desc={desc}/>
    <div className="panel placeholder"><h3>这一页下一阶段接 Supabase 数据。</h3></div>
  </>
}

function App() {
  const [previewUserId, setPreviewUserId] = useState('U001')
  const user = mockUsers.find(x=>x.id===previewUserId)
  const location = useLocation()
  const navigate = useNavigate()
  const [mode,setModeState] = useState(location.pathname.startsWith('/staff') ? 'staff':'admin')

  const setMode = next => {
    setModeState(next)
    navigate(next === 'admin' ? '/admin':'/staff')
  }

  return <Guard user={user} mode={mode}>
    <div className="app-shell">
      <Sidebar mode={mode} user={user}/>
      <main className="main">
        <Topbar user={user} mode={mode} setMode={setMode} setPreviewUser={setPreviewUserId}/>
        <div className="content">
          <Routes>
            <Route path="/" element={<Navigate to={canAccessBackend(user)?'/admin':'/staff'} replace/>}/>
            <Route path="/admin" element={<AdminDashboard user={user}/>}/>
            <Route path="/admin/users" element={<UserPermissionsPage currentUser={user}/>}/>
            <Route path="/admin/payout-approvals" element={<PayoutApprovalPage user={user}/>}/>
            <Route path="/admin/employees" element={<SensitiveExamplePage user={user}/>}/>
            <Route path="/admin/*" element={<Placeholder title="后台模块" desc="菜单和权限骨架已经完成，下一步逐页接 Supabase。"/>}/>

            <Route path="/staff" element={<StaffHome/>}/>
            <Route path="/staff/profile" element={<ProfilePage/>}/>
            <Route path="/staff/payout-change" element={<PayoutRequestPage/>}/>
            <Route path="/staff/*" element={<Placeholder title="员工前端模块" desc="员工只能看到自己的数据。"/>}/>
          </Routes>
        </div>
      </main>
    </div>
  </Guard>
}

export default App
