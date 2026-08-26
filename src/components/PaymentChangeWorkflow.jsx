import React, { useEffect, useRef, useState } from 'react'
import { useAdminI18n } from '../lib/adminI18n'
import { supabase } from '../lib/supabase'
import '../payment-change-workflow.css'

const BUCKET = 'payment-change-proof'
const MAX_FILE_SIZE = 10 * 1024 * 1024
const ALLOWED_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])

const COPY = {
  zh: {
    title: '修改收款资料', introBank: '菲律宾籍纯居家员工仅可修改银行卡或电子钱包。', introUsdt: '当前员工类型仅可修改 USDT 地址。',
    apply: '提交修改申请', current: '当前资料', noCurrent: '当前收款资料不完整，请联系管理员补齐后再申请。',
    pendingExists: '已有一笔申请尚未完成审核或人工修改，完成前不能重复提交。', old: '系统当前资料（只读）', next: '新资料',
    transfer: '银行 / 钱包名称', accountName: '收款姓名', accountNumber: '银行卡 / 钱包账号', usdt: 'USDT 地址',
    reason: '修改原因', identityProof: '身份证明', paymentProof: '新收款资料截图', fileHint: 'JPG、PNG、WEBP 或 PDF，单个不超过 10MB',
    cancel: '取消', submit: '提交申请', submitting: '提交中…', history: '申请进度', none: '暂无修改申请。',
    statusPending: '待审核', statusApproved: '已通过', statusRejected: '已驳回', statusCancelled: '已取消', rejectReason: '驳回原因',
    submittedAt: '提交时间', reviewedAt: '处理时间', changedTo: '申请修改为', success: '申请已提交，请等待后台审核。', retry: '重试',
    fulfillment: '资料处理', fulfillmentAwaiting: '等待审核', fulfillmentManual: '审核通过，等待助理人工修改', fulfillmentMatched: '资料已更新并匹配', fulfillmentMismatch: '资料已变化，但与申请不一致', fulfillmentNone: '无需处理',
  },
  en: {
    title: 'Change payment details', introBank: 'Pure remote employees in the Philippines can only change bank or e-wallet details.', introUsdt: 'Your employee type can only change the USDT address.',
    apply: 'Request a change', current: 'Current details', noCurrent: 'Your current payment details are incomplete. Contact an administrator before submitting a request.',
    pendingExists: 'A previous request is still under review or awaiting its manual update.', old: 'Current system details (read only)', next: 'New details',
    transfer: 'Bank / wallet name', accountName: 'Account holder name', accountNumber: 'Bank / wallet account', usdt: 'USDT address',
    reason: 'Reason for change', identityProof: 'Identity proof', paymentProof: 'New payment details screenshot', fileHint: 'JPG, PNG, WEBP or PDF; maximum 10 MB each',
    cancel: 'Cancel', submit: 'Submit request', submitting: 'Submitting…', history: 'Request status', none: 'No change requests yet.',
    statusPending: 'Pending', statusApproved: 'Approved', statusRejected: 'Rejected', statusCancelled: 'Cancelled', rejectReason: 'Rejection reason',
    submittedAt: 'Submitted', reviewedAt: 'Reviewed', changedTo: 'Requested details', success: 'Request submitted for review.', retry: 'Retry',
    fulfillment: 'Details update', fulfillmentAwaiting: 'Awaiting review', fulfillmentManual: 'Approved; waiting for manual update', fulfillmentMatched: 'Details updated and matched', fulfillmentMismatch: 'Current details do not match this request', fulfillmentNone: 'No update required',
  },
  vi: {
    title: 'Thay đổi thông tin nhận tiền', introBank: 'Nhân viên làm việc tại nhà người Philippines chỉ có thể đổi tài khoản ngân hàng hoặc ví điện tử.', introUsdt: 'Loại nhân viên hiện tại chỉ có thể đổi địa chỉ USDT.',
    apply: 'Gửi yêu cầu thay đổi', current: 'Thông tin hiện tại', noCurrent: 'Thông tin nhận tiền hiện tại chưa đầy đủ. Vui lòng liên hệ quản trị viên.',
    pendingExists: 'Yêu cầu trước vẫn đang được duyệt hoặc chờ cập nhật thủ công.', old: 'Thông tin hiện tại trong hệ thống (chỉ đọc)', next: 'Thông tin mới',
    transfer: 'Tên ngân hàng / ví', accountName: 'Tên chủ tài khoản', accountNumber: 'Số tài khoản / ví', usdt: 'Địa chỉ USDT',
    reason: 'Lý do thay đổi', identityProof: 'Giấy tờ tùy thân', paymentProof: 'Ảnh thông tin nhận tiền mới', fileHint: 'JPG, PNG, WEBP hoặc PDF; tối đa 10 MB mỗi tệp',
    cancel: 'Hủy', submit: 'Gửi yêu cầu', submitting: 'Đang gửi…', history: 'Trạng thái yêu cầu', none: 'Chưa có yêu cầu thay đổi.',
    statusPending: 'Chờ duyệt', statusApproved: 'Đã duyệt', statusRejected: 'Bị từ chối', statusCancelled: 'Đã hủy', rejectReason: 'Lý do từ chối',
    submittedAt: 'Đã gửi', reviewedAt: 'Đã xử lý', changedTo: 'Thông tin yêu cầu', success: 'Đã gửi yêu cầu để xét duyệt.', retry: 'Thử lại',
    fulfillment: 'Cập nhật thông tin', fulfillmentAwaiting: 'Đang chờ duyệt', fulfillmentManual: 'Đã duyệt; chờ cập nhật thủ công', fulfillmentMatched: 'Thông tin đã cập nhật và khớp', fulfillmentMismatch: 'Thông tin hiện tại không khớp yêu cầu', fulfillmentNone: 'Không cần cập nhật',
  },
  id: {
    title: 'Ubah data pembayaran', introBank: 'Karyawan remote murni Filipina hanya dapat mengubah rekening bank atau e-wallet.', introUsdt: 'Jenis karyawan Anda hanya dapat mengubah alamat USDT.',
    apply: 'Ajukan perubahan', current: 'Data saat ini', noCurrent: 'Data pembayaran saat ini belum lengkap. Hubungi administrator sebelum mengajukan.',
    pendingExists: 'Permintaan sebelumnya masih ditinjau atau menunggu pembaruan manual.', old: 'Data sistem saat ini (hanya baca)', next: 'Data baru',
    transfer: 'Nama bank / dompet', accountName: 'Nama pemilik rekening', accountNumber: 'Rekening bank / dompet', usdt: 'Alamat USDT',
    reason: 'Alasan perubahan', identityProof: 'Bukti identitas', paymentProof: 'Tangkapan layar data pembayaran baru', fileHint: 'JPG, PNG, WEBP atau PDF; maksimum 10 MB per file',
    cancel: 'Batal', submit: 'Kirim permintaan', submitting: 'Mengirim…', history: 'Status permintaan', none: 'Belum ada permintaan perubahan.',
    statusPending: 'Menunggu', statusApproved: 'Disetujui', statusRejected: 'Ditolak', statusCancelled: 'Dibatalkan', rejectReason: 'Alasan penolakan',
    submittedAt: 'Dikirim', reviewedAt: 'Diproses', changedTo: 'Data yang diminta', success: 'Permintaan telah dikirim untuk ditinjau.', retry: 'Coba lagi',
    fulfillment: 'Pembaruan data', fulfillmentAwaiting: 'Menunggu tinjauan', fulfillmentManual: 'Disetujui; menunggu pembaruan manual', fulfillmentMatched: 'Data telah diperbarui dan cocok', fulfillmentMismatch: 'Data saat ini tidak cocok dengan permintaan', fulfillmentNone: 'Tidak perlu diperbarui',
  },
}

const clean = value => String(value ?? '').trim()
const dateTime = (value, locale = 'zh') => {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return clean(value)
  const localeCode = ({ zh: 'zh-CN', en: 'en-US', vi: 'vi-VN', id: 'id-ID' })[locale] || 'en-US'
  return new Intl.DateTimeFormat(localeCode, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}
const safeFileName = file => {
  const extension = clean(file?.name).split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
}
const newUuid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const statusLabel = (status, copy) => copy[`status${clean(status).slice(0, 1).toUpperCase()}${clean(status).slice(1)}`] || status || '—'
const fulfillmentLabel = (status, copy) => ({
  awaiting_review: copy.fulfillmentAwaiting,
  pending_manual: copy.fulfillmentManual,
  matched: copy.fulfillmentMatched,
  mismatch: copy.fulfillmentMismatch,
  not_applicable: copy.fulfillmentNone,
})[clean(status)] || copy.fulfillmentAwaiting
const fulfillmentTone = status => ({ matched: 'matched', mismatch: 'mismatch', pending_manual: 'manual', awaiting_review: 'waiting' })[clean(status)] || 'neutral'
const requestError = error => {
  const message = clean(error?.message || error)
  const code = [
    'not_authenticated', 'staff_profile_unavailable', 'request_id_required', 'invalid_reason', 'pending_request_exists',
    'current_payment_unavailable', 'old_payment_mismatch', 'invalid_new_payment', 'payment_unchanged', 'proof_required',
    'proof_unavailable', 'permission_denied', 'session_not_current', 'invalid_status', 'invalid_decision',
    'review_note_required', 'request_not_found', 'employee_out_of_scope', 'request_already_reviewed', 'employee_not_active',
    'payment_rule_changed', 'current_payment_changed',
  ].find(value => message.includes(value))
  const labels = {
    not_authenticated: '登录会话已失效，请重新登录。', staff_profile_unavailable: '未找到关联的在职员工档案。', request_id_required: '申请编号无效。',
    invalid_reason: '修改原因需填写 5–1000 个字符。', pending_request_exists: '已有一笔申请等待审核，不能重复提交。',
    current_payment_unavailable: '当前收款资料不完整，请联系管理员。', old_payment_mismatch: '旧收款资料与系统记录不一致。',
    invalid_new_payment: '新收款资料不完整或格式无效。', payment_unchanged: '新旧收款资料相同，无需提交。',
    proof_required: '身份证明和新收款资料截图均为必填。', proof_unavailable: '证明文件未成功上传，请重新选择。',
    permission_denied: '当前账号没有此操作权限。', session_not_current: '当前登录会话已失效。', invalid_status: '申请状态筛选无效。',
    invalid_decision: '审核操作无效。', review_note_required: '驳回时必须填写原因。', request_not_found: '申请不存在或已删除。',
    employee_out_of_scope: '该员工不在当前账号的管理范围内。', request_already_reviewed: '该申请已经处理，不能重复审核。',
    employee_not_active: '员工已不在职，不能批准修改。', payment_rule_changed: '员工类型或国籍已变化，请驳回后由员工重新提交。',
    current_payment_changed: '当前收款资料已被其他操作修改，请重新核对。',
  }
  return labels[code] || message || '操作失败，请稍后重试。'
}
const validateFile = file => {
  if (!file) return '请选择文件。'
  if (!ALLOWED_FILE_TYPES.has(file.type)) return '仅支持 JPG、PNG、WEBP 或 PDF。'
  if (file.size > MAX_FILE_SIZE) return '单个文件不能超过 10MB。'
  return ''
}

function PaymentFacts({ kind, value, masked = false }) {
  if (!value) return <span>—</span>
  if (kind === 'usdt') return <span className="payment-change-mono">{value.usdt_address || value.usdt_address_masked || '—'}</span>
  return <span className="payment-change-facts">
    <b>{value.transfer_using || '—'}</b>
    <i>{value.account_name || '—'}</i>
    <code>{value.account_number || value.account_number_masked || (masked ? '—' : '')}</code>
  </span>
}

export function StaffPaymentChangeWorkspace({ locale = 'en', onChanged }) {
  const copy = COPY[locale] || COPY.en
  const [state, setState] = useState({ loading: true, error: '', data: null })
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [form, setForm] = useState({ newTransfer: '', newName: '', newAccount: '', newUsdt: '', reason: '', identity: null, payment: null })
  const identityRef = useRef(null)
  const paymentRef = useRef(null)

  const load = async () => {
    setState(current => ({ ...current, loading: true, error: '' }))
    const { data, error } = await supabase.rpc('staff_payment_change_context')
    setState(error ? { loading: false, error: requestError(error), data: null } : { loading: false, error: '', data: data || null })
  }
  useEffect(() => { load() }, [])

  const kind = state.data?.payment_kind || 'usdt'
  const requests = state.data?.requests || []
  const pending = requests.some(request => request.status === 'pending' || (
    request.status === 'approved'
    && !['matched', 'not_applicable'].includes(clean(request.fulfillment_status))
  ))
  const reset = () => {
    setForm({ newTransfer: '', newName: '', newAccount: '', newUsdt: '', reason: '', identity: null, payment: null })
    if (identityRef.current) identityRef.current.value = ''
    if (paymentRef.current) paymentRef.current.value = ''
  }
  const close = () => { if (!saving) { setOpen(false); setMessage(''); reset() } }
  const submit = async event => {
    event.preventDefault()
    setMessage('')
    const identityError = validateFile(form.identity)
    const paymentError = validateFile(form.payment)
    if (identityError || paymentError) { setMessage(identityError || paymentError); return }
    setSaving(true)
    const uploaded = []
    try {
      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError || !authData?.user?.id) throw authError || new Error('not_authenticated')
      const requestId = newUuid()
      const prefix = `${authData.user.id}/${requestId}`
      const identityPath = `${prefix}/identity-${safeFileName(form.identity)}`
      const paymentPath = `${prefix}/payment-${safeFileName(form.payment)}`
      for (const [path, file] of [[identityPath, form.identity], [paymentPath, form.payment]]) {
        const { error } = await supabase.storage.from(BUCKET).upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type })
        if (error) throw error
        uploaded.push(path)
      }
      const newData = kind === 'bank_wallet'
        ? { transfer_using: clean(form.newTransfer), account_name: clean(form.newName), account_number: clean(form.newAccount) }
        : { usdt_address: clean(form.newUsdt) }
      const { error } = await supabase.rpc('staff_submit_payout_change_request', {
        p_request_id: requestId,
        p_old_data: {},
        p_new_data: newData,
        p_reason: clean(form.reason),
        p_identity_proof_path: identityPath,
        p_payment_proof_path: paymentPath,
      })
      if (error) throw error
      setOpen(false)
      reset()
      setMessage(copy.success)
      await load()
      onChanged?.()
    } catch (error) {
      if (uploaded.length) await supabase.storage.from(BUCKET).remove(uploaded)
      setMessage(requestError(error))
    } finally {
      setSaving(false)
    }
  }

  return <section className="staff-payment-change">
    <header><div><small>PAYMENT CHANGE</small><h3>{copy.title}</h3><p>{kind === 'bank_wallet' ? copy.introBank : copy.introUsdt}</p></div><button type="button" disabled={state.loading || pending || !state.data?.has_current} onClick={() => { setOpen(true); setMessage('') }}>{copy.apply}</button></header>
    {state.error && <div className="payment-change-alert error">{state.error}<button type="button" onClick={load}>{copy.retry}</button></div>}
    {message && <div className={`payment-change-alert ${message === copy.success ? 'success' : 'error'}`}>{message}</div>}
    {!state.loading && state.data && <div className="staff-payment-change-current"><span>{copy.current}</span><PaymentFacts kind={kind} value={state.data.current} masked /></div>}
    {!state.loading && state.data && !state.data.has_current && <div className="payment-change-alert warning">{copy.noCurrent}</div>}
    {pending && <div className="payment-change-alert warning">{copy.pendingExists}</div>}
    <div className="staff-payment-request-history"><h4>{copy.history}</h4>{state.loading ? <div className="payment-change-empty">…</div> : requests.length ? requests.map(request => <article key={request.id}>
      <div className="payment-change-request-head"><span className={`payment-change-status ${request.status}`}>{statusLabel(request.status, copy)}</span><time>{copy.submittedAt} · {dateTime(request.created_at, locale)}</time></div>
      <div className="payment-change-request-body"><div><small>{copy.changedTo}</small><PaymentFacts kind={request.payment_kind || (request.new_payment?.usdt_address || request.new_payment?.usdt_address_masked ? 'usdt' : 'bank_wallet')} value={request.new_payment} masked /></div><p>{request.reason}</p></div>
      {request.status === 'approved' && <div className={`payment-change-fulfillment ${fulfillmentTone(request.fulfillment_status)}`}><b>{copy.fulfillment}</b><span>{fulfillmentLabel(request.fulfillment_status, copy)}</span></div>}
      {request.status === 'rejected' && <div className="payment-change-reject-note"><b>{copy.rejectReason}</b><span>{request.review_note || '—'}</span></div>}
      {request.reviewed_at && <footer>{copy.reviewedAt} · {dateTime(request.reviewed_at, locale)}</footer>}
    </article>) : <div className="payment-change-empty">{copy.none}</div>}</div>
    {open && <div className="payment-change-modal-backdrop" role="presentation" onMouseDown={close}><section className="payment-change-modal staff" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}>
      <header><div><small>PAYMENT CHANGE REQUEST</small><h2>{copy.title}</h2></div><button type="button" disabled={saving} onClick={close}>×</button></header>
      <form onSubmit={submit}>
        <fieldset className="payment-change-current-fieldset"><legend>{copy.old}</legend><div className="payment-change-readonly-current"><PaymentFacts kind={kind} value={state.data?.current} masked /></div></fieldset>
        <fieldset><legend>{copy.next}</legend>{kind === 'bank_wallet' ? <div className="payment-change-form-grid"><label>{copy.transfer}<input required value={form.newTransfer} onChange={event => setForm({ ...form, newTransfer: event.target.value })} /></label><label>{copy.accountName}<input required value={form.newName} onChange={event => setForm({ ...form, newName: event.target.value })} /></label><label className="wide">{copy.accountNumber}<input required value={form.newAccount} onChange={event => setForm({ ...form, newAccount: event.target.value })} /></label></div> : <label>{copy.usdt}<input required value={form.newUsdt} onChange={event => setForm({ ...form, newUsdt: event.target.value })} /></label>}</fieldset>
        <label>{copy.reason}<textarea required minLength={5} maxLength={1000} rows={3} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} /></label>
        <div className="payment-change-proof-grid"><label>{copy.identityProof}<input ref={identityRef} required type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => setForm({ ...form, identity: event.target.files?.[0] || null })} /><span>{form.identity?.name || copy.fileHint}</span></label><label>{copy.paymentProof}<input ref={paymentRef} required type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={event => setForm({ ...form, payment: event.target.files?.[0] || null })} /><span>{form.payment?.name || copy.fileHint}</span></label></div>
        {message && <div className="payment-change-alert error">{message}</div>}
        <footer><button type="button" disabled={saving} onClick={close}>{copy.cancel}</button><button className="primary" disabled={saving} type="submit">{saving ? copy.submitting : copy.submit}</button></footer>
      </form>
    </section></div>}
  </section>
}

export function AdminPayoutChangeWorkspace({ mode = 'pending', canReview = false }) {
  const { locale, t: adminT } = useAdminI18n()
  const adminCopy = locale === 'en' ? COPY.en : COPY.zh
  const [filters, setFilters] = useState({ status: mode === 'pending' ? 'pending' : '', search: '' })
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [state, setState] = useState({ loading: true, error: '', data: { rows: [], total: 0, pages: 1 } })
  const [detail, setDetail] = useState(null)
  const [review, setReview] = useState(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  const load = async () => {
    setState(current => ({ ...current, loading: true, error: '' }))
    const status = mode === 'pending' ? 'pending' : filters.status
    const { data, error } = await supabase.rpc('admin_payout_change_requests', { p_status: status || null, p_search: appliedSearch || null, p_page: page, p_page_size: pageSize })
    setState(error ? { loading: false, error: adminT(requestError(error)), data: { rows: [], total: 0, pages: 1 } } : { loading: false, error: '', data: data || { rows: [], total: 0, pages: 1 } })
  }
  useEffect(() => { setPage(1); setFilters(current => ({ ...current, status: mode === 'pending' ? 'pending' : '' })) }, [mode])
  useEffect(() => { load() }, [mode, filters.status, appliedSearch, page, pageSize])

  const submitSearch = event => {
    event.preventDefault()
    const nextSearch = clean(filters.search)
    if (page === 1 && nextSearch === appliedSearch) load()
    else { setPage(1); setAppliedSearch(nextSearch) }
  }
  const resetFilters = () => {
    const nextStatus = mode === 'pending' ? 'pending' : ''
    const alreadyReset = page === 1 && appliedSearch === '' && filters.search === '' && filters.status === nextStatus
    setFilters({ status: nextStatus, search: '' })
    setAppliedSearch('')
    setPage(1)
    if (alreadyReset) load()
  }
  const decide = async (decision, note = '') => {
    if (!review?.id) return
    setSaving(true); setMessage('')
    const { error } = await supabase.rpc('admin_review_payout_change_request', { p_request_id: review.id, p_decision: decision, p_review_note: clean(note) || null })
    setSaving(false)
    if (error) { setMessage(adminT(requestError(error))); return }
    setMessage(adminT(decision === 'approved' ? '申请已审核通过；自动修改已关闭，请助理人工核对并修改实际收款资料。' : '申请已驳回，员工可在前端查看原因。'))
    setReview(null); setDetail(null); await load()
  }
  const rows = state.data?.rows || []
  const pages = Math.max(1, Number(state.data?.pages || 1))
  return <section className="admin-payment-change">
    <header className="admin-payment-change-head"><div><small>PAYMENT CHANGE REVIEW</small><h2>{adminT(mode === 'pending' ? '收款资料待审核' : '修改工资信息记录')}</h2><p>{adminT(state.data?.auto_apply_enabled ? '自动修改已启用；批准后系统会写入实际收款资料。' : '自动修改：关闭。批准只记录审核结果，由助理人工修改实际资料。')}</p></div><strong>{locale === 'en' ? `${Number(state.data?.total || 0).toLocaleString()} records` : `${Number(state.data?.total || 0).toLocaleString()} 条`}</strong></header>
    <form className="admin-payment-change-filters" onSubmit={submitSearch}><label className="admin-payment-change-search"><span>{adminT('综合搜索')}</span><input value={filters.search} onChange={event => setFilters({ ...filters, search: event.target.value })} placeholder={adminT('员工ID、姓名、申请账号、团队、岗位或修改原因')} /></label>{mode !== 'pending' && <label><span>{adminT('状态')}</span><select value={filters.status} onChange={event => { setPage(1); setFilters({ ...filters, status: event.target.value }) }}><option value="">{adminT('全部状态')}</option><option value="approved">{adminT('已通过')}</option><option value="rejected">{adminT('已驳回')}</option><option value="pending">{adminT('待审核')}</option><option value="cancelled">{adminT('已取消')}</option></select></label>}<button className="primary" type="submit">{adminT('查询')}</button><button type="button" onClick={resetFilters}>{adminT('重置')}</button></form>
    {state.error && <div className="payment-change-alert error">{state.error}<button type="button" onClick={load}>{adminT('重试')}</button></div>}
    {message && <div className="payment-change-alert success">{message}</div>}
    <div className="admin-payment-change-table"><table><thead><tr><th>{adminT('员工ID')}</th><th>{adminT('入职日期')}</th><th>{adminT('姓名')}</th><th>{adminT('申请人 / 时间')}</th><th>{adminT('员工类型 / 国家')}</th><th>{adminT('团队 / 岗位')}</th><th>{adminT('修改项目')}</th><th>{adminT('原因')}</th><th>{adminT('审核结果')}</th><th>{adminT('实际资料处理')}</th><th>{adminT('操作')}</th></tr></thead><tbody>{state.loading ? <tr><td colSpan="11"><div className="payment-change-empty">{adminT('正在读取申请…')}</div></td></tr> : rows.length ? rows.map(row => <tr key={row.id}><td><b>{row.employee_no || '—'}</b></td><td><b>{row.employee_hire_date || '—'}</b></td><td><b>{row.employee_name || '—'}</b></td><td><b>{row.requested_by || adminT('员工本人')}</b><span>{dateTime(row.created_at, locale)}</span></td><td><b>{row.employment_type || '—'}</b><span>{row.country || '—'} · {row.employee_status || '—'}</span></td><td><b>{row.team_name || '—'}</b><span>{row.position_name || '—'}</span></td><td>{adminT(row.payment_kind === 'bank_wallet' ? '银行卡 / 钱包' : 'USDT 地址')}</td><td className="admin-payment-change-reason"><span title={row.reason}>{row.reason}</span></td><td><i className={`payment-change-status ${row.status}`}>{statusLabel(row.status, adminCopy)}</i><span>{row.reviewed_at ? `${row.reviewed_by || adminT('后台账号')} · ${dateTime(row.reviewed_at, locale)}` : adminT('尚未审核')}</span></td><td><i className={`payment-change-fulfillment-pill ${fulfillmentTone(row.fulfillment_status)}`}>{adminT(fulfillmentLabel(row.fulfillment_status, adminCopy))}</i><span>{row.fulfilled_at ? `${row.fulfilled_by || adminT('系统 / 外部同步')} · ${dateTime(row.fulfilled_at, locale)}` : adminT('自动修改已关闭')}</span></td><td><div className="admin-payment-change-actions"><button type="button" onClick={() => setDetail(row)}>{adminT('详情')}</button>{row.status === 'pending' && canReview && <button className="primary" type="button" onClick={() => { setMessage(''); setReview({ ...row, decision: 'approved', note: '' }) }}>{adminT('审核')}</button>}</div></td></tr>) : <tr><td colSpan="11"><div className="payment-change-empty">{adminT('暂无符合条件的申请。')}</div></td></tr>}</tbody></table></div>
    <footer className="admin-payment-change-pager"><label>{adminT('每页')}<select value={pageSize} onChange={event => { setPage(1); setPageSize(Number(event.target.value)) }}><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label><span>{locale === 'en' ? `Page ${page} / ${pages}` : `第 ${page} / ${pages} 页`}</span><button disabled={page <= 1 || state.loading} onClick={() => setPage(value => Math.max(1, value - 1))}>{adminT('上一页')}</button><button disabled={page >= pages || state.loading} onClick={() => setPage(value => value + 1)}>{adminT('下一页')}</button></footer>
    {detail && <PaymentChangeDetail request={detail} canReview={canReview} onClose={() => setDetail(null)} onReview={() => { setMessage(''); setReview({ ...detail, decision: 'approved', note: '' }); setDetail(null) }} />}
    {review && <div className="payment-change-modal-backdrop" role="presentation" onMouseDown={() => !saving && setReview(null)}><section className="payment-change-modal review" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><header><div><small>REVIEW REQUEST</small><h2>{adminT('审核')} · {review.employee_no}</h2></div><button disabled={saving} onClick={() => setReview(null)}>×</button></header><div className="payment-change-manual-warning"><b>{adminT('自动修改：关闭')}</b><span>{adminT('批准只记录审核通过，不会自动修改银行卡、钱包账号或 USDT 地址。')}</span></div><div className="payment-change-review-summary"><PaymentFacts kind={review.payment_kind} value={review.new_data} /><p>{review.reason}</p></div><label>{adminT('审核备注')}<textarea rows={4} maxLength={1000} value={review.note} onChange={event => setReview({ ...review, note: event.target.value })} placeholder={adminT('批准可选填；驳回时必须填写明确原因，员工会看到此内容。')} /></label>{message && <div className="payment-change-alert error">{message}</div>}<footer><button disabled={saving} onClick={() => setReview(null)}>{adminT('取消')}</button><button className="danger" disabled={saving || clean(review.note).length === 0} onClick={() => decide('rejected', review.note)}>{adminT('驳回')}</button><button className="primary" disabled={saving} onClick={() => decide('approved', review.note)}>{adminT(saving ? '处理中…' : '审核通过')}</button></footer></section></div>}
  </section>
}

function PaymentChangeDetail({ request, canReview, onClose, onReview }) {
  const { locale, t: adminT } = useAdminI18n()
  const adminCopy = locale === 'en' ? COPY.en : COPY.zh
  const [proofs, setProofs] = useState([])
  const [preview, setPreview] = useState(null)
  const proofDefinitions = [
    { key: 'identity', path: request.identity_proof_path, label: adminT('身份证明') },
    { key: 'payment', path: request.payment_proof_path, label: adminT('新收款资料截图') },
  ]
  const loadProof = async (proof, cancelled = () => false) => {
    if (!clean(proof.path)) return { ...proof, loading: false, error: adminT('该历史申请没有保存此证明文件。'), url: '' }
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(proof.path, 120)
    if (cancelled()) return null
    return error
      ? { ...proof, loading: false, error: adminT(requestError(error)), url: '' }
      : { ...proof, loading: false, error: '', url: data?.signedUrl || '' }
  }
  useEffect(() => {
    let stopped = false
    const pending = proofDefinitions.map(proof => ({ ...proof, loading: Boolean(clean(proof.path)), error: clean(proof.path) ? '' : adminT('该历史申请没有保存此证明文件。'), url: '' }))
    setProofs(pending)
    Promise.all(pending.map(proof => loadProof(proof, () => stopped))).then(results => {
      if (!stopped) setProofs(results.filter(Boolean))
    })
    return () => { stopped = true }
  }, [request.id, request.identity_proof_path, request.payment_proof_path, locale])
  const retryProof = async proof => {
    setProofs(current => current.map(item => item.key === proof.key ? { ...item, loading: true, error: '' } : item))
    const result = await loadProof(proof)
    if (result) setProofs(current => current.map(item => item.key === proof.key ? result : item))
  }
  const previewIsPdf = clean(preview?.path).toLowerCase().endsWith('.pdf')
  return <div className="payment-change-modal-backdrop" role="presentation" onMouseDown={onClose}><section className="payment-change-modal detail" role="dialog" aria-modal="true" onMouseDown={event => event.stopPropagation()}><header><div><small>PAYMENT CHANGE DETAIL</small><h2>{request.employee_no} · {request.employee_name}</h2></div><button onClick={onClose}>×</button></header><div className="payment-change-detail-grid"><div><span>{adminT('员工')}</span><strong>{request.employee_no} · {request.employee_name}</strong><small>{adminT('入职日期')} · {request.employee_hire_date || '—'}</small></div><div><span>{adminT('组织')}</span><strong>{request.team_name || '—'} · {request.position_name || '—'}</strong><small>{request.employment_type || '—'} · {request.country || '—'} · {request.employee_status || '—'}</small></div><div><span>{adminT('申请人 / 时间')}</span><strong>{request.requested_by || adminT('员工本人')}</strong><small>{dateTime(request.created_at, locale)}</small></div><div><span>{adminT('审核人 / 时间')}</span><strong>{request.reviewed_by || (request.reviewed_at ? adminT('后台账号') : adminT('尚未审核'))}</strong><small>{request.reviewed_at ? dateTime(request.reviewed_at, locale) : '—'}</small></div><div><span>{adminT('审核结果')}</span><i className={`payment-change-status ${request.status}`}>{statusLabel(request.status, adminCopy)}</i><small>{request.status === 'rejected' ? adminT('拒绝时间') : request.status === 'approved' ? adminT('通过时间') : adminT('提交时间')} · {dateTime(request.reviewed_at || request.created_at, locale)}</small></div><div><span>{adminT('实际资料处理')}</span><i className={`payment-change-fulfillment-pill ${fulfillmentTone(request.fulfillment_status)}`}>{adminT(fulfillmentLabel(request.fulfillment_status, adminCopy))}</i><small>{request.fulfilled_at ? `${request.fulfilled_by || adminT('系统 / 外部同步')} · ${dateTime(request.fulfilled_at, locale)}` : adminT('自动修改已关闭')}</small></div></div><div className="payment-change-compare"><div><small>{adminT('旧资料')}</small><PaymentFacts kind={request.payment_kind} value={request.old_data} /></div><span>→</span><div><small>{adminT('新资料')}</small><PaymentFacts kind={request.payment_kind} value={request.new_data} /></div></div><div className="payment-change-detail-reason"><small>{adminT('修改原因')}</small><p>{request.reason}</p></div>{request.review_note && <div className="payment-change-reject-note"><b>{adminT('审核备注')}</b><span>{request.review_note}</span></div>}<div className="payment-change-proof-gallery">{proofs.map(proof => {
    const isPdf = clean(proof.path).toLowerCase().endsWith('.pdf')
    return <article key={proof.key}><header><b>{proof.label}</b><span>{proof.url ? adminT('点击放大') : '—'}</span></header>{proof.loading ? <div className="payment-change-proof-loading">{adminT('正在安全读取文件…')}</div> : proof.error ? <div className="payment-change-proof-error"><span>{proof.error}</span>{clean(proof.path) && <button type="button" onClick={() => retryProof(proof)}>{adminT('重试')}</button>}</div> : isPdf ? <button type="button" className="payment-change-proof-pdf" onClick={() => setPreview(proof)}><b>PDF</b><span>{adminT('点击放大查看证明文件')}</span></button> : <button type="button" className="payment-change-proof-thumbnail" onClick={() => setPreview(proof)}><img src={proof.url} alt={proof.label} /></button>}</article>
  })}</div>{preview && <div className="payment-change-proof-lightbox" role="presentation" onMouseDown={() => setPreview(null)}><section role="dialog" aria-modal="true" aria-label={preview.label} onMouseDown={event => event.stopPropagation()}><header><b>{preview.label}</b><button type="button" aria-label={adminT('关闭预览')} onClick={() => setPreview(null)}>×</button></header>{previewIsPdf ? <iframe title={preview.label} src={preview.url} /> : <img src={preview.url} alt={preview.label} />}</section></div>}<footer><button onClick={onClose}>{locale === 'en' ? 'Close' : '关闭'}</button>{request.status === 'pending' && canReview && <button className="primary" onClick={onReview}>{adminT('开始审核')}</button>}</footer></section></div>
}
