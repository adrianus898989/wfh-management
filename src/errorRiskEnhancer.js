import { supabase } from './lib/supabase'

const text = v => String(v ?? '').trim()
const upper = v => text(v).toUpperCase()
const riskCfg = count => {
  const n = Number(count || 0)
  if (n >= 10) return { key:'high', label:'高频', full:'高频错误', color:'#b42334', bg:'#fff1f2', border:'#fecdd3' }
  if (n >= 6) return { key:'watch', label:'重点', full:'重点观察', color:'#c2410c', bg:'#fff7ed', border:'#fed7aa' }
  if (n >= 4) return { key:'attention', label:'注意', full:'注意', color:'#a16207', bg:'#fffbeb', border:'#fde68a' }
  return { key:'normal', label:'正常', full:'正常', color:'#39734a', bg:'#f0fdf4', border:'#bbf7d0' }
}
const monthLabel = key => {
  const m=text(key).match(/^(\d{4})-(\d{1,2})$/)
  return m ? `${m[1]}年${Number(m[2])}月` : (text(key)||'本月')
}
const formatDateTime = v => {
  if(!v) return '未记录'
  const d=new Date(v)
  return Number.isNaN(d.getTime()) ? text(v) : d.toLocaleString('zh-CN',{hour12:false})
}
const statusName = v => ({active:'在职',resigned:'离职',probation:'试用',suspended:'停用',inactive:'停用'}[text(v)]||text(v)||'—')

const cache = new Map()
let scheduled = false
let stopped = false

function addStyles(){
  if(document.getElementById('wfh-error-risk-enhancer-style')) return
  const style=document.createElement('style')
  style.id='wfh-error-risk-enhancer-style'
  style.textContent=`
    .wfh-risk-col-head,.wfh-risk-col-cell{width:72px!important;min-width:72px!important;max-width:72px!important;text-align:center!important;white-space:nowrap!important}
    .wfh-risk-level{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:48px;height:22px;padding:0 7px;border:1px solid var(--risk-border);border-radius:999px;background:var(--risk-bg);color:var(--risk-color);font-size:9px;font-weight:850;line-height:1;white-space:nowrap;vertical-align:middle}
    .wfh-risk-level:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--risk-color);flex:0 0 auto}
    .wfh-risk-level.is-clickable{cursor:pointer;transition:transform .14s,box-shadow .14s}.wfh-risk-level.is-clickable:hover{transform:translateY(-1px);box-shadow:0 4px 10px rgba(35,61,98,.12)}
    .wfh-employee-risk-banner{margin:0 16px 12px;padding:10px 12px;border:1px solid var(--risk-border);border-radius:10px;background:var(--risk-bg);color:var(--risk-color);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    .wfh-employee-risk-banner strong{display:block;font-size:12px}.wfh-employee-risk-banner span{font-size:10px}.wfh-risk-history-btn{height:30px;padding:0 10px;border:1px solid var(--risk-border);border-radius:8px;background:#fff;color:var(--risk-color);font-size:10px;font-weight:800;cursor:pointer;white-space:nowrap}.wfh-risk-history-btn:hover{filter:brightness(.98)}
    .wfh-error-audit-card{margin:0 16px 16px;padding:12px;border:1px solid #dfe7f2;border-radius:10px;background:#fbfdff;color:#405974}
    .wfh-error-audit-card h4{margin:0 0 8px;font-size:11px;color:#203a5b}.wfh-error-audit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .wfh-error-audit-grid>div{padding:8px;border:1px solid #e6ecf4;border-radius:8px;background:#fff;min-width:0}.wfh-error-audit-grid b{display:block;margin-bottom:4px;color:#8393a8;font-size:8px}.wfh-error-audit-grid span{display:block;font-size:10px;word-break:break-word}
    .wfh-history-mask{position:fixed;inset:0;z-index:1900;background:rgba(15,29,49,.58);display:flex;align-items:center;justify-content:center;padding:22px}.wfh-history-modal{width:min(1120px,94vw);max-height:90vh;background:#fff;border-radius:15px;box-shadow:0 28px 80px rgba(7,23,46,.35);overflow:hidden;display:flex;flex-direction:column;color:#203a5b}.wfh-history-modal.narrow{width:min(820px,92vw)}
    .wfh-history-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:16px 18px;border-bottom:1px solid #e6edf5}.wfh-history-head small{display:block;color:#7b8da6;font-size:8px;letter-spacing:1.4px;font-weight:850;margin-bottom:4px}.wfh-history-head h3{margin:0;font-size:18px}.wfh-history-close{width:34px;height:34px;border:0;border-radius:9px;background:#eff3f8;color:#667d9a;font-size:20px;cursor:pointer}.wfh-history-body{overflow:auto;padding:14px 16px 18px}
    .wfh-history-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:10px}.wfh-history-summary>div{border:1px solid #e0e8f2;border-radius:10px;padding:10px;background:#fbfdff}.wfh-history-summary span{display:block;color:#8495aa;font-size:8px;font-weight:800}.wfh-history-summary strong{display:block;margin-top:4px;font-size:15px;color:#203a5b}
    .wfh-months{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}.wfh-months span{padding:5px 8px;border-radius:999px;background:#f1f6fd;color:#506b8c;font-size:9px;font-weight:750}
    .wfh-history-table-wrap{width:100%;overflow:auto;border:1px solid #e4ebf4;border-radius:10px}.wfh-history-table{width:100%;min-width:760px;border-collapse:collapse;font-size:10px}.wfh-history-table th{background:#f5f8fc;color:#667b97;text-align:left;padding:9px 10px;white-space:nowrap}.wfh-history-table td{padding:9px 10px;border-top:1px solid #edf1f6;color:#344d6a;white-space:nowrap}.wfh-history-table tr:hover td{background:#fbfdff}.wfh-history-view{height:28px;padding:0 9px;border:1px solid #bcd0ef;border-radius:7px;background:#fff;color:#155bd7;font-size:9px;font-weight:800;cursor:pointer}
    .wfh-record-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.wfh-record-grid>div{border:1px solid #e3eaf3;border-radius:9px;padding:9px;background:#fbfdff;min-width:0}.wfh-record-grid>div.wide{grid-column:1/-1}.wfh-record-grid b{display:block;color:#8293a8;font-size:8px;margin-bottom:4px}.wfh-record-grid p{margin:0;color:#314b68;font-size:10px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
    .rp-errors-table{width:100%!important;min-width:1380px!important}.rp-errors-table th:last-child,.rp-errors-table td:last-child{width:150px!important;max-width:150px!important}.rp-errors-scroll{width:100%!important;max-width:100%!important}.wfh-error-actions{display:flex;align-items:center;gap:5px;white-space:nowrap}.wfh-employee-open-btn{height:28px;padding:0 8px;border:1px solid #d1ddea;border-radius:7px;background:#fff;color:#4c6482;font-size:9px;font-weight:800;cursor:pointer}.wfh-employee-open-btn:hover{border-color:#9cb6dd;background:#f7faff;color:#155bd7}.wfh-error-id-button{font-weight:850!important}
    .wfh-profile-mask{position:fixed;inset:0;z-index:2000;background:rgba(13,27,48,.55);display:flex;justify-content:flex-end}.wfh-profile-drawer{width:min(720px,92vw);height:100vh;background:#f7f9fc;box-shadow:-22px 0 60px rgba(8,25,49,.25);overflow:hidden;display:flex;flex-direction:column;color:#203a5b}.wfh-profile-head{display:flex;align-items:center;gap:12px;padding:18px 20px;background:#fff;border-bottom:1px solid #e3eaf3}.wfh-profile-avatar{width:48px;height:48px;border-radius:13px;background:linear-gradient(135deg,#4f67e8,#7058e9);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;flex:0 0 auto}.wfh-profile-title{min-width:0;flex:1}.wfh-profile-title small{display:block;color:#2563eb;font-size:9px;font-weight:850;letter-spacing:1.3px}.wfh-profile-title h2{margin:3px 0 6px;font-size:20px;line-height:1.15}.wfh-profile-tags{display:flex;gap:5px;flex-wrap:wrap}.wfh-profile-tags span{padding:4px 7px;border-radius:999px;background:#f1f5fa;border:1px solid #e2e9f2;color:#61758f;font-size:8px;font-weight:750}.wfh-profile-close{width:36px;height:36px;border:0;border-radius:9px;background:#eef2f7;color:#607590;font-size:20px;cursor:pointer}.wfh-profile-body{padding:14px 16px 24px;overflow:auto}.wfh-profile-alert{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 12px;border:1px solid var(--risk-border);border-radius:10px;background:var(--risk-bg);color:var(--risk-color);margin-bottom:12px}.wfh-profile-alert strong{display:block;font-size:12px}.wfh-profile-alert small{display:block;margin-top:3px;font-size:9px}.wfh-profile-card{background:#fff;border:1px solid #dfe7f1;border-radius:12px;margin-bottom:11px;overflow:hidden}.wfh-profile-card h3{margin:0;padding:12px 14px;border-bottom:1px solid #e9eef5;font-size:12px}.wfh-profile-grid{display:grid;grid-template-columns:1fr 1fr;padding:4px 14px}.wfh-profile-field{display:grid;grid-template-columns:105px minmax(0,1fr);gap:8px;padding:9px 0;border-bottom:1px solid #eef2f6;min-width:0}.wfh-profile-field:nth-last-child(-n+2){border-bottom:0}.wfh-profile-field b{color:#8595aa;font-size:9px}.wfh-profile-field span{color:#304966;font-size:10px;font-weight:650;word-break:break-word}.wfh-profile-loading{padding:55px;text-align:center;color:#7c8da5}.wfh-profile-error{margin:18px;padding:18px;border:1px solid #fecdd3;border-radius:10px;background:#fff1f2;color:#b42334}.wfh-profile-history{height:30px;padding:0 10px;border:1px solid var(--risk-border);border-radius:8px;background:#fff;color:var(--risk-color);font-size:9px;font-weight:850;cursor:pointer;white-space:nowrap}
    @media(max-width:700px){.wfh-error-audit-grid,.wfh-history-summary,.wfh-record-grid,.wfh-profile-grid{grid-template-columns:1fr}.wfh-record-grid>div.wide{grid-column:auto}.wfh-history-mask{padding:8px}.wfh-profile-drawer{width:100vw}.wfh-profile-field{grid-template-columns:92px minmax(0,1fr)}}
  `
  document.head.appendChild(style)
}

async function fetchSummaries(ids){
  const need=[...new Set((ids||[]).map(upper).filter(Boolean))].filter(id=>!cache.has(id))
  if(!need.length) return
  for(let i=0;i<need.length;i+=100){
    const batch=need.slice(i,i+100)
    const {data,error}=await supabase.from('employee_error_summary').select('*').in('employee_no',batch)
    if(error) continue
    const found=new Set()
    for(const row of (data||[])){
      const id=upper(row.employee_no);found.add(id);cache.set(id,row)
    }
    for(const id of batch) if(!found.has(id)) cache.set(id,null)
  }
}

function styleRisk(el,cfg){
  el.style.setProperty('--risk-color',cfg.color)
  el.style.setProperty('--risk-bg',cfg.bg)
  el.style.setProperty('--risk-border',cfg.border)
}
function levelNode(summary,onOpen){
  const cfg=riskCfg(summary?.month_error_count)
  const chip=document.createElement('span')
  chip.className=`wfh-risk-level${onOpen?' is-clickable':''}`
  chip.textContent=cfg.label
  chip.title=`${cfg.full} · ${monthLabel(summary?.month_key)} ${Number(summary?.month_error_count||0)} 笔 · 近30天 ${Number(summary?.last_30d_error_count||0)} 笔 · 累计 ${Number(summary?.total_error_count||0)} 笔${onOpen?' · 点击查看全部错误记录':''}`
  styleRisk(chip,cfg)
  if(onOpen){
    chip.setAttribute('role','button')
    chip.tabIndex=0
    chip.addEventListener('click',e=>{e.stopPropagation();onOpen()})
    chip.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen()}})
  }
  return chip
}

function ensureLevelHeader(table){
  const tr=table?.querySelector('thead tr')
  if(!tr) return
  if(!tr.querySelector(':scope > .wfh-risk-col-head')){
    const th=document.createElement('th')
    th.className='wfh-risk-col-head'
    th.textContent='等级'
    th.title='按员工当月错误次数计算：0–3 正常 / 4–5 注意 / 6–9 重点 / 10+ 高频'
    tr.insertBefore(th,tr.firstChild)
  }
}

function wireEmployeeOpen(button,id){
  if(!button||!id||button.dataset.wfhEmployeeOpen==='1') return
  button.dataset.wfhEmployeeOpen='1'
  button.classList.add('wfh-error-id-button')
  button.title='打开员工档案'
  button.addEventListener('click',e=>{
    e.preventDefault()
    e.stopImmediatePropagation()
    openEmployeeProfile(id)
  },true)
}

function ensureErrorActions(tr,id){
  const cell=tr?.lastElementChild
  if(!cell||!id) return
  const existing=cell.querySelector('button')
  if(existing&&text(existing.textContent)==='查看') existing.textContent='查看错误'
  if(cell.querySelector('.wfh-employee-open-btn')) return
  let wrap=cell.querySelector('.wfh-error-actions')
  if(!wrap){
    wrap=document.createElement('div')
    wrap.className='wfh-error-actions'
    while(cell.firstChild) wrap.appendChild(cell.firstChild)
    cell.appendChild(wrap)
  }
  const btn=document.createElement('button')
  btn.type='button'
  btn.className='wfh-employee-open-btn'
  btn.textContent='员工档案'
  btn.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();openEmployeeProfile(id)})
  wrap.appendChild(btn)
}

async function enhanceErrorTable(){
  const table=document.querySelector('.rp-errors-table')
  if(!table) return
  table.querySelectorAll('.wfh-risk-chip').forEach(x=>x.remove())
  ensureLevelHeader(table)
  const title=table.closest('.rp-card')?.querySelector('.rp-card-title p')
  if(title&&!title.dataset.wfhLinkedCopy){title.dataset.wfhLinkedCopy='1';title.textContent='主表保留管理重点；点击「等级」查看该员工全部错误记录，点击员工ID打开员工档案；订单号、金额、错误备注、正确操作方式放进「查看错误」详情。'}
  const rows=[...table.querySelectorAll('tbody tr')]
  const pairs=[]
  for(const tr of rows){
    let levelCell=tr.querySelector(':scope > .wfh-risk-col-cell')
    if(!levelCell){levelCell=document.createElement('td');levelCell.className='wfh-risk-col-cell';tr.insertBefore(levelCell,tr.firstChild)}
    const idCell=levelCell.nextElementSibling
    const nameCell=idCell?.nextElementSibling
    const id=upper(idCell?.querySelector('button')?.textContent || idCell?.textContent)
    if(id){
      pairs.push({id,cell:levelCell,name:text(nameCell?.textContent)})
      wireEmployeeOpen(idCell?.querySelector('button'),id)
      ensureErrorActions(tr,id)
    }
  }
  await fetchSummaries(pairs.map(x=>x.id))
  for(const {id,cell,name} of pairs){
    const summary=cache.get(id)
    cell.replaceChildren(levelNode(summary,()=>openEmployeeErrorHistory(id,summary,name)))
  }
}

async function enhanceEmployeeTable(){
  const table=document.querySelector('.employee-master-table')
  if(!table) return
  table.querySelectorAll('.wfh-risk-chip').forEach(x=>x.remove())
  ensureLevelHeader(table)
  const rows=[...table.querySelectorAll('tbody tr')]
  const pairs=[]
  for(const tr of rows){
    let levelCell=tr.querySelector(':scope > .wfh-risk-col-cell')
    if(!levelCell){levelCell=document.createElement('td');levelCell.className='wfh-risk-col-cell';tr.insertBefore(levelCell,tr.firstChild)}
    const idCell=levelCell.nextElementSibling
    const nameCell=idCell?.nextElementSibling
    const id=upper(idCell?.textContent)
    if(id) pairs.push({id,cell:levelCell,name:text(nameCell?.textContent)})
  }
  await fetchSummaries(pairs.map(x=>x.id))
  for(const {id,cell,name} of pairs){
    const summary=cache.get(id)
    cell.replaceChildren(levelNode(summary,()=>openEmployeeErrorHistory(id,summary,name)))
  }
}

function closeOverlay(node){node?.remove()}
function makeOverlay(title,subTitle='',narrow=false){
  const mask=document.createElement('div');mask.className='wfh-history-mask'
  const modal=document.createElement('div');modal.className=`wfh-history-modal${narrow?' narrow':''}`
  modal.innerHTML=`<div class="wfh-history-head"><div><small>ERROR MANAGEMENT</small><h3>${title}</h3>${subTitle?`<div style="margin-top:4px;color:#7b8da6;font-size:9px">${subTitle}</div>`:''}</div><button class="wfh-history-close">×</button></div><div class="wfh-history-body"></div>`
  mask.appendChild(modal)
  mask.addEventListener('mousedown',e=>{if(e.target===mask)closeOverlay(mask)})
  modal.querySelector('.wfh-history-close')?.addEventListener('click',()=>closeOverlay(mask))
  document.body.appendChild(mask)
  return {mask,modal,body:modal.querySelector('.wfh-history-body')}
}

function makeProfileDrawer(){
  document.querySelector('.wfh-profile-mask')?.remove()
  const mask=document.createElement('div');mask.className='wfh-profile-mask'
  const drawer=document.createElement('aside');drawer.className='wfh-profile-drawer'
  mask.appendChild(drawer)
  mask.addEventListener('mousedown',e=>{if(e.target===mask)mask.remove()})
  document.body.appendChild(mask)
  return {mask,drawer}
}
function profileField(label,value){
  const row=document.createElement('div');row.className='wfh-profile-field'
  const b=document.createElement('b');b.textContent=label
  const s=document.createElement('span');s.textContent=text(value)||'—'
  row.append(b,s);return row
}
function profileCard(title,fields){
  const card=document.createElement('section');card.className='wfh-profile-card'
  const h=document.createElement('h3');h.textContent=title
  const grid=document.createElement('div');grid.className='wfh-profile-grid'
  fields.forEach(([k,v])=>grid.appendChild(profileField(k,v)))
  card.append(h,grid);return card
}

async function openEmployeeProfile(employeeNo){
  const id=upper(employeeNo)
  if(!id) return
  const ui=makeProfileDrawer()
  ui.drawer.innerHTML='<div class="wfh-profile-loading">正在读取员工档案…</div>'
  try{
    const {data:listData,error:listError}=await supabase.functions.invoke('admin-employees',{body:{action:'list',page:1,page_size:5,filters:{employee_no:id,status:''}}})
    if(listError||listData?.error) throw new Error(text(listData?.error||listError?.message)||'员工档案读取失败')
    const row=(listData?.rows||[]).find(x=>upper(x.employee_no)===id)
    if(!row?.id) throw new Error(`找不到员工档案：${id}`)
    const {data:detail,error:detailError}=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:row.id}})
    if(detailError||detail?.error) throw new Error(text(detail?.error||detailError?.message)||'员工档案读取失败')
    const e=detail?.employee||row
    const contact=detail?.contact||{}
    const comp=detail?.compensation||{}
    const pay=detail?.payment||{}
    await fetchSummaries([id])
    const summary=cache.get(id)
    const cfg=riskCfg(summary?.month_error_count)

    ui.drawer.replaceChildren()
    const head=document.createElement('div');head.className='wfh-profile-head'
    const avatar=document.createElement('div');avatar.className='wfh-profile-avatar';avatar.textContent=(text(e.full_name)||id).slice(0,1).toUpperCase()
    const title=document.createElement('div');title.className='wfh-profile-title'
    const small=document.createElement('small');small.textContent=id
    const h2=document.createElement('h2');h2.textContent=text(e.full_name)||id
    const tags=document.createElement('div');tags.className='wfh-profile-tags'
    ;[e.employment_type,e.teams?.name||e.team_name,e.positions?.name||e.position_name||e.schedule_position,e.shift_name].map(text).filter(Boolean).forEach(v=>{const x=document.createElement('span');x.textContent=v;tags.appendChild(x)})
    title.append(small,h2,tags)
    const close=document.createElement('button');close.className='wfh-profile-close';close.type='button';close.textContent='×';close.addEventListener('click',()=>ui.mask.remove())
    head.append(avatar,title,close)
    const body=document.createElement('div');body.className='wfh-profile-body'

    if(Number(summary?.total_error_count||0)>0){
      const alert=document.createElement('div');alert.className='wfh-profile-alert';styleRisk(alert,cfg)
      const info=document.createElement('div');const strong=document.createElement('strong');strong.textContent=`${cfg.full} · ${monthLabel(summary?.month_key)} ${Number(summary?.month_error_count||0)} 笔错误`;const sm=document.createElement('small');sm.textContent=`近30天 ${Number(summary?.last_30d_error_count||0)} 笔 · 累计 ${Number(summary?.total_error_count||0)} 笔 · 最近 ${text(summary?.last_error_date)||'—'}`;info.append(strong,sm)
      const btn=document.createElement('button');btn.type='button';btn.className='wfh-profile-history';btn.textContent='查看全部错误记录';styleRisk(btn,cfg);btn.addEventListener('click',()=>openEmployeeErrorHistory(id,summary,text(e.full_name)))
      alert.append(info,btn);body.appendChild(alert)
    }

    body.appendChild(profileCard('基本资料',[
      ['员工ID',e.employee_no],['姓名',e.full_name],['员工国家',e.country||e.nationality],['员工类型',e.employment_type],['状态',statusName(e.status)],['入职日期',e.hire_date],['离职日期',e.resign_date],['离职原因',detail?.resignation_reason]
    ]))
    body.appendChild(profileCard('组织与排班',[
      ['团队',e.teams?.name||e.team_name],['主档岗位',e.positions?.name||e.position_name],['排班岗位',e.schedule_position],['班次',e.shift_name],['组别',e.group_name],['负责人 / 组长',e.leader_name||e.person_in_charge],['培训',e.trainer_name||e.online_trainer||e.on_site_trainer],['盘口',e.platform_scope||e.market_position]
    ]))
    body.appendChild(profileCard('联系与账号',[
      ['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Workfolio 邮箱',contact.work_email],['Telegram',contact.telegram_username],['Zoom 邮箱',contact.zoom_email],['WhatsApp / 手机',contact.whatsapp_phone]
    ]))
    if([comp.base_salary,comp.daily_rate,comp.performance_default,comp.meal_allowance,pay.payment_mode,pay.transfer_using,pay.gcash_account,pay.usdt_address].some(v=>text(v))){
      body.appendChild(profileCard('工资与收款',[
        ['底薪',comp.base_salary],['日薪',comp.daily_rate],['默认绩效',comp.performance_default],['餐补',comp.meal_allowance],['收款方式',pay.payment_mode||pay.mode],['转账方式',pay.transfer_using],['GCash / 银行账号',pay.gcash_account||pay.bank_wallet_account],['USDT 地址',pay.usdt_address]
      ]))
    }
    ui.drawer.append(head,body)
  }catch(e){
    ui.drawer.innerHTML=''
    const box=document.createElement('div');box.className='wfh-profile-error';box.textContent=e?.message||'员工档案读取失败';ui.drawer.appendChild(box)
  }
}

async function fetchAuditForRow(row){
  let q=supabase.from('employee_error_audit').select('first_seen_at,last_seen_at,google_actor,google_event_at,source_row').eq('employee_no',upper(row.employee_id))
  if(text(row.qc_date)) q=q.eq('qc_date',text(row.qc_date))
  if(text(row.error_type)) q=q.eq('error_type',text(row.error_type))
  const {data}=await q.order('source_row',{ascending:false}).limit(1)
  return data?.[0]||null
}

async function openErrorRecord(row){
  const ui=makeOverlay(`${text(row.employee_id)} · ${text(row.error_type)||'错误记录'}`,`${text(row.name)||'—'} · ${text(row.qc_date)||'—'}`,true)
  ui.body.innerHTML='<div style="padding:28px;text-align:center;color:#7d8da4">读取详细资料…</div>'
  const audit=await fetchAuditForRow(row).catch(()=>null)
  const fields=[
    ['员工ID',row.employee_id],['姓名',row.name],['团队',row.team],['岗位',row.position],['盘口',row.platform],['错误类型',row.error_type],['扣分',row.score],['质检人',row.qc_person],['质检时间',row.qc_date],['小组长复审',row.leader_review],['质检人对/错',row.qc_result],['复检时间',row.review_date],
    ['会员/id /订单号',row.member_order,'wide'],['金额',row.amount],['错误备注',row.error_note,'wide'],['正确操作方式',row.correct_action,'wide']
  ]
  const grid=document.createElement('div');grid.className='wfh-record-grid'
  fields.forEach(([k,v,w])=>{const box=document.createElement('div');if(w)box.className='wide';const b=document.createElement('b');b.textContent=k;const p=document.createElement('p');p.textContent=text(v)||'—';box.append(b,p);grid.appendChild(box)})
  const auditCard=document.createElement('div');auditCard.className='wfh-error-audit-card';auditCard.style.margin='12px 0 0';auditCard.innerHTML=`<h4>来源与同步记录</h4><div class="wfh-error-audit-grid"><div><b>系统首次发现/同步</b><span>${audit?formatDateTime(audit.first_seen_at):'未记录'}</span></div><div><b>Supabase 最新同步</b><span>${audit?formatDateTime(audit.last_seen_at):'未记录'}</span></div><div><b>Google 录入账号</b><span>${text(audit?.google_actor)||'未记录（原表没有操作人字段）'}</span></div><div><b>Google 录入时间</b><span>${audit?.google_event_at?formatDateTime(audit.google_event_at):'未记录'}</span></div></div>`
  ui.body.replaceChildren(grid,auditCard)
}

async function openEmployeeErrorHistory(employeeNo,summary,employeeName=''){
  const id=upper(employeeNo)
  if(!id) return
  const ui=makeOverlay(`${employeeName||id} · 全部错误记录`,id)
  ui.body.innerHTML='<div style="padding:35px;text-align:center;color:#7d8da4">正在读取全部错误记录…</div>'
  const {data,error}=await supabase.functions.invoke('admin-reports',{body:{action:'errors',employee_id:id,date_basis:'qc'}})
  if(error||data?.error){ui.body.innerHTML=`<div style="padding:35px;text-align:center;color:#b42334">${text(data?.error||error?.message)||'读取失败'}</div>`;return}
  const rows=(data?.rows||[]).filter(r=>upper(r.employee_id)===id).sort((a,b)=>text(b.qc_date).localeCompare(text(a.qc_date)))
  const months=new Map()
  rows.forEach(r=>{const k=text(r.qc_date||r.review_date).slice(0,7)||'日期未知';months.set(k,(months.get(k)||0)+1)})
  const summaryBox=document.createElement('div');summaryBox.className='wfh-history-summary'
  const monthText=monthLabel(summary?.month_key)
  ;[[monthText,`${Number(summary?.month_error_count||0)} 笔`],['近30天',`${Number(summary?.last_30d_error_count||0)} 笔`],['累计',`${Number(summary?.total_error_count||rows.length)} 笔`],['最近错误',text(summary?.last_error_date)||'—']].forEach(([k,v])=>{const box=document.createElement('div');box.innerHTML=`<span>${k}</span><strong>${v}</strong>`;summaryBox.appendChild(box)})
  const monthBar=document.createElement('div');monthBar.className='wfh-months';[...months.entries()].sort((a,b)=>b[0].localeCompare(a[0])).forEach(([k,n])=>{const x=document.createElement('span');x.textContent=`${k==='日期未知'?k:monthLabel(k)} ${n}笔`;monthBar.appendChild(x)})
  const wrap=document.createElement('div');wrap.className='wfh-history-table-wrap';const table=document.createElement('table');table.className='wfh-history-table';table.innerHTML='<thead><tr><th>日期</th><th>错误类型</th><th>扣分</th><th>质检人</th><th>质检人对/错</th><th>复检时间</th><th>操作</th></tr></thead><tbody></tbody>'
  const tbody=table.querySelector('tbody')
  rows.forEach(r=>{const tr=document.createElement('tr');const vals=[r.qc_date||'—',r.error_type||'—',text(r.score)||'—',r.qc_person||'—',r.qc_result||'—',r.review_date||'—'];vals.forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});const td=document.createElement('td');const btn=document.createElement('button');btn.className='wfh-history-view';btn.textContent='查看';btn.addEventListener('click',()=>openErrorRecord(r));td.appendChild(btn);tr.appendChild(td);tbody.appendChild(tr)})
  wrap.appendChild(table)
  if(!rows.length){const empty=document.createElement('div');empty.style.cssText='padding:34px;text-align:center;color:#7d8da4';empty.textContent='暂无错误记录';ui.body.replaceChildren(summaryBox,empty);return}
  ui.body.replaceChildren(summaryBox,monthBar,wrap)
}

async function enhanceEmployeeDrawer(){
  const drawer=document.querySelector('.employee-detail-drawer.employee-detail-v12')
  if(!drawer) return
  const id=upper(drawer.querySelector('.employee-id-line')?.textContent)
  if(!id) return
  await fetchSummaries([id])
  const summary=cache.get(id)
  const existing=drawer.querySelector('.wfh-employee-risk-banner')
  const resigned=Boolean(drawer.querySelector('.restore-outline'))
  const flagged=Number(summary?.month_error_count||0)>3
  if(resigned||!flagged){if(existing)existing.remove();return}
  const cfg=riskCfg(summary?.month_error_count)
  const anchor=drawer.querySelector('.profile-status-line')
  if(!anchor) return
  const box=existing||document.createElement('div')
  box.className='wfh-employee-risk-banner'
  styleRisk(box,cfg)
  const employeeName=text(drawer.querySelector('.employee-title-row h2, .employee-name-line, h2')?.textContent)
  box.innerHTML=`<div><strong>${cfg.full} · ${monthLabel(summary?.month_key)} ${Number(summary?.month_error_count||0)} 笔错误</strong><span>近30天 ${Number(summary?.last_30d_error_count||0)} 笔 · 累计 ${Number(summary?.total_error_count||0)} 笔 · 最近 ${text(summary?.last_error_date)||'—'}</span></div><button type="button" class="wfh-risk-history-btn">查看全部错误</button>`
  box.querySelector('.wfh-risk-history-btn')?.addEventListener('click',e=>{e.stopPropagation();openEmployeeErrorHistory(id,summary,employeeName)})
  if(!existing) anchor.insertAdjacentElement('afterend',box)
}

function detailValue(grid,label){
  if(!grid) return ''
  for(const box of [...grid.children]){
    const k=text(box.querySelector('span')?.textContent)
    if(k===label) return text(box.querySelector('p')?.textContent)
  }
  return ''
}

async function enhanceErrorDetail(){
  const modals=[...document.querySelectorAll('.rp-modal')]
  for(const modal of modals){
    const grid=modal.querySelector('.rp-detail-grid')
    if(!grid) continue
    const existing=[...modal.querySelectorAll('.wfh-error-audit-card')]
    if(existing.length){existing.slice(1).forEach(x=>x.remove());continue}
    if(modal.dataset.wfhAuditLoading==='1') continue
    const title=text(modal.querySelector('header h2')?.textContent)
    const m=title.match(/^([A-Za-z]{1,4}\d{3,})\s*·\s*(.+)$/)
    if(!m) continue
    modal.dataset.wfhAuditLoading='1'
    try{
      const employeeNo=upper(m[1]),errorType=text(m[2]),qcDate=detailValue(grid,'质检时间')
      let q=supabase.from('employee_error_audit').select('first_seen_at,last_seen_at,google_actor,google_event_at,source_row').eq('employee_no',employeeNo)
      if(qcDate&&qcDate!=='—') q=q.eq('qc_date',qcDate)
      if(errorType&&errorType!=='错误记录') q=q.eq('error_type',errorType)
      const {data}=await q.order('source_row',{ascending:false}).limit(1)
      const audit=data?.[0]||null
      if(modal.querySelector('.wfh-error-audit-card')) continue
      const card=document.createElement('div')
      card.className='wfh-error-audit-card'
      card.innerHTML=`<h4>来源与同步记录</h4><div class="wfh-error-audit-grid"><div><b>系统首次发现/同步</b><span>${audit?formatDateTime(audit.first_seen_at):'未记录'}</span></div><div><b>Supabase 最新同步</b><span>${audit?formatDateTime(audit.last_seen_at):'未记录'}</span></div><div><b>Google 录入账号</b><span>${text(audit?.google_actor)||'未记录（原表没有操作人字段）'}</span></div><div><b>Google 录入时间</b><span>${audit?.google_event_at?formatDateTime(audit.google_event_at):'未记录'}</span></div></div>`
      modal.querySelector('.rp-modal-body')?.appendChild(card)
    } finally { delete modal.dataset.wfhAuditLoading }
  }
}

async function run(){
  if(stopped) return
  scheduled=false
  try{await enhanceErrorTable()}catch{}
  try{await enhanceEmployeeTable()}catch{}
  try{await enhanceEmployeeDrawer()}catch{}
  try{await enhanceErrorDetail()}catch{}
}
function schedule(){if(scheduled||stopped)return;scheduled=true;setTimeout(run,80)}

export function startErrorRiskEnhancer(){
  if(window.__WFH_ERROR_RISK_ENHANCER__) return
  window.__WFH_ERROR_RISK_ENHANCER__=true
  addStyles()
  const observer=new MutationObserver(schedule)
  observer.observe(document.body,{childList:true,subtree:true})
  const timer=setInterval(()=>{cache.clear();schedule()},30000)
  const channel=supabase.channel('wfh-error-risk-ui').on('postgres_changes',{event:'*',schema:'public',table:'employee_error_summary'},payload=>{const id=upper(payload?.new?.employee_no||payload?.old?.employee_no);if(id)cache.delete(id);schedule()}).subscribe()
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();supabase.removeChannel(channel)},{once:true})
}
