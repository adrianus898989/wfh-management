import { supabase } from './lib/supabase'

const text = v => String(v ?? '').trim()
const upper = v => text(v).toUpperCase()
const riskCfg = count => {
  const n = Number(count || 0)
  if (n >= 10) return { key:'high', label:'高频错误', short:`● ${n}`, color:'#b42334', bg:'#fff1f2', border:'#fecdd3' }
  if (n >= 6) return { key:'watch', label:'重点观察', short:`● ${n}`, color:'#c2410c', bg:'#fff7ed', border:'#fed7aa' }
  if (n >= 4) return { key:'attention', label:'注意', short:`● ${n}`, color:'#a16207', bg:'#fffbeb', border:'#fde68a' }
  return null
}

const cache = new Map()
let scheduled = false
let stopped = false

function addStyles(){
  if(document.getElementById('wfh-error-risk-enhancer-style')) return
  const style=document.createElement('style')
  style.id='wfh-error-risk-enhancer-style'
  style.textContent=`
    .wfh-risk-chip{display:inline-flex;align-items:center;justify-content:center;min-width:32px;height:20px;padding:0 6px;margin-right:6px;border:1px solid var(--risk-border);border-radius:999px;background:var(--risk-bg);color:var(--risk-color);font-size:9px;font-weight:850;line-height:1;white-space:nowrap;vertical-align:middle;cursor:help}
    .wfh-employee-risk-banner{margin:0 16px 12px;padding:10px 12px;border:1px solid var(--risk-border);border-radius:10px;background:var(--risk-bg);color:var(--risk-color);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    .wfh-employee-risk-banner strong{display:block;font-size:12px}.wfh-employee-risk-banner span{font-size:10px}
    .wfh-error-audit-card{margin:0 16px 16px;padding:12px;border:1px solid #dfe7f2;border-radius:10px;background:#fbfdff;color:#405974}
    .wfh-error-audit-card h4{margin:0 0 8px;font-size:11px;color:#203a5b}.wfh-error-audit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    .wfh-error-audit-grid>div{padding:8px;border:1px solid #e6ecf4;border-radius:8px;background:#fff;min-width:0}.wfh-error-audit-grid b{display:block;margin-bottom:4px;color:#8393a8;font-size:8px}.wfh-error-audit-grid span{display:block;font-size:10px;word-break:break-word}
    @media(max-width:700px){.wfh-error-audit-grid{grid-template-columns:1fr}}
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

async function enhanceErrorTable(){
  const table=document.querySelector('.rp-errors-table')
  if(!table) return
  const rows=[...table.querySelectorAll('tbody tr')]
  const pairs=[]
  for(const tr of rows){
    const cells=[...tr.children]
    if(!cells.length) continue
    let idCell=cells[0]
    let id=text(idCell.querySelector('button')?.textContent || idCell.textContent)
    if(!/^[A-Za-z]{1,4}\d{3,}$/i.test(id)){
      const hit=cells.find(td=>/^[A-Za-z]{1,4}\d{3,}$/i.test(text(td.querySelector('button')?.textContent||td.textContent)))
      if(hit){idCell=hit;id=text(hit.querySelector('button')?.textContent||hit.textContent)}
    }
    id=upper(id)
    if(id) pairs.push({id,cell:idCell})
  }
  await fetchSummaries(pairs.map(x=>x.id))
  for(const {id,cell} of pairs){
    const summary=cache.get(id),cfg=riskCfg(summary?.month_error_count)
    const old=cell.querySelector(':scope > .wfh-risk-chip')
    if(!cfg){if(old)old.remove();continue}
    const chip=old||document.createElement('span')
    chip.className='wfh-risk-chip'
    chip.textContent=cfg.short
    chip.title=`${cfg.label} · 本月 ${summary.month_error_count} 笔 · 近30天 ${summary.last_30d_error_count||0} 笔 · 累计 ${summary.total_error_count||0} 笔`
    styleRisk(chip,cfg)
    if(!old) cell.insertBefore(chip,cell.firstChild)
  }
}

async function enhanceEmployeeDrawer(){
  const drawer=document.querySelector('.employee-detail-drawer.employee-detail-v12')
  if(!drawer) return
  const id=upper(drawer.querySelector('.employee-id-line')?.textContent)
  if(!id) return
  await fetchSummaries([id])
  const summary=cache.get(id),cfg=riskCfg(summary?.month_error_count)
  const existing=drawer.querySelector('.wfh-employee-risk-banner')
  const resigned=Boolean(drawer.querySelector('.restore-outline'))
  if(!cfg||resigned){if(existing)existing.remove();return}
  const anchor=drawer.querySelector('.profile-status-line')
  if(!anchor) return
  const box=existing||document.createElement('div')
  box.className='wfh-employee-risk-banner'
  styleRisk(box,cfg)
  box.innerHTML=`<div><strong>${cfg.label} · 本月 ${Number(summary.month_error_count||0)} 笔错误</strong><span>近30天 ${Number(summary.last_30d_error_count||0)} 笔 · 累计 ${Number(summary.total_error_count||0)} 笔 · 最近 ${text(summary.last_error_date)||'—'}</span></div><span>统计报表 → 错误统计可查看明细</span>`
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
    if(!grid||modal.querySelector('.wfh-error-audit-card')) continue
    const title=text(modal.querySelector('header h2')?.textContent)
    const m=title.match(/^([A-Za-z]{1,4}\d{3,})\s*·\s*(.+)$/)
    if(!m) continue
    const employeeNo=upper(m[1]),errorType=text(m[2]),qcDate=detailValue(grid,'质检时间')
    let q=supabase.from('employee_error_audit').select('first_seen_at,last_seen_at,google_actor,google_event_at,source_row').eq('employee_no',employeeNo)
    if(qcDate&&qcDate!=='—') q=q.eq('qc_date',qcDate)
    if(errorType&&errorType!=='错误记录') q=q.eq('error_type',errorType)
    const {data}=await q.order('source_row',{ascending:false}).limit(1)
    const audit=data?.[0]||null
    const card=document.createElement('div')
    card.className='wfh-error-audit-card'
    const fmt=v=>{if(!v)return '未记录';const d=new Date(v);return Number.isNaN(d.getTime())?text(v):d.toLocaleString('zh-CN',{hour12:false})}
    card.innerHTML=`<h4>来源与同步记录</h4><div class="wfh-error-audit-grid"><div><b>系统首次发现/同步</b><span>${audit?fmt(audit.first_seen_at):'未记录'}</span></div><div><b>Supabase 最新同步</b><span>${audit?fmt(audit.last_seen_at):'未记录'}</span></div><div><b>Google 录入账号</b><span>${text(audit?.google_actor)||'未记录（原表没有操作人字段）'}</span></div><div><b>Google 录入时间</b><span>${audit?.google_event_at?fmt(audit.google_event_at):'未记录'}</span></div></div>`
    modal.querySelector('.rp-modal-body')?.appendChild(card)
  }
}

async function run(){
  if(stopped) return
  scheduled=false
  try{await enhanceErrorTable()}catch{}
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
