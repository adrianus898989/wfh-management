import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const num=v=>Number(v||0)
const bucket=v=>{const n=num(v);return n>=10?'high':n>=6?'watch':n>=4?'attention':n>0?'normal':'none'}
const labels={high:'高频',watch:'重点观察',attention:'注意',normal:'正常',none:'本月0笔'}
const tones={high:['#b42334','#fff1f2','#fecdd3'],watch:['#c2410c','#fff7ed','#fed7aa'],attention:['#a16207','#fffbeb','#fde68a'],normal:['#39734a','#f0fdf4','#bbf7d0'],none:['#65758b','#f8fafc','#e2e8f0']}
let stopped=false,scheduled=false,loading=false,lastLoaded=0,rows=[]

function addStyles(){
  if(document.getElementById('wfh-report-error-overview-style'))return
  const s=document.createElement('style');s.id='wfh-report-error-overview-style';s.textContent=`
  .wfh-eo-card{background:#fff;border:1px solid #dce5f1;border-radius:13px;margin:0 0 12px;overflow:hidden;box-shadow:0 3px 14px rgba(37,64,102,.035);color:#203a5b}.wfh-eo-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:15px 17px 12px;border-bottom:1px solid #edf1f6}.wfh-eo-head h3{margin:0 0 4px;font-size:16px}.wfh-eo-head p{margin:0;color:#8191a7;font-size:10px}.wfh-eo-head span{font-size:9px;color:#6f83a0;white-space:nowrap}.wfh-eo-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;padding:12px 14px}.wfh-eo-kpi{border:1px solid #e1e8f2;border-radius:10px;background:#fbfdff;padding:10px;min-width:0}.wfh-eo-kpi small{display:block;color:#8091a8;font-size:8px;font-weight:800}.wfh-eo-kpi strong{display:block;margin-top:5px;font-size:20px;color:#213d5f}.wfh-eo-kpi em{display:block;margin-top:4px;font-style:normal;color:#94a1b3;font-size:8px}.wfh-eo-kpi.risk{border-color:var(--eo-border);background:var(--eo-bg)}.wfh-eo-kpi.risk strong{color:var(--eo-color)}.wfh-eo-body{display:grid;grid-template-columns:minmax(280px,.8fr) minmax(0,1.7fr);gap:12px;padding:0 14px 14px}.wfh-eo-panel{border:1px solid #e3eaf3;border-radius:11px;overflow:hidden;background:#fff}.wfh-eo-panel-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #edf1f6}.wfh-eo-panel-head strong{font-size:11px}.wfh-eo-panel-head span{font-size:8px;color:#8a99ad}.wfh-eo-bars{padding:10px 12px 12px}.wfh-eo-bar{display:grid;grid-template-columns:78px 36px minmax(0,1fr);align-items:center;gap:7px;padding:6px 0;font-size:9px;color:#526985}.wfh-eo-bar b{text-align:right;color:#344f6f}.wfh-eo-track{height:7px;border-radius:99px;background:#edf2f7;overflow:hidden}.wfh-eo-fill{display:block;height:100%;border-radius:99px;background:var(--eo-color)}.wfh-eo-table-wrap{overflow:auto}.wfh-eo-table{width:100%;min-width:650px;border-collapse:collapse;font-size:9px}.wfh-eo-table th{background:#f6f8fb;color:#6c7f98;text-align:left;padding:8px 9px;white-space:nowrap}.wfh-eo-table td{padding:8px 9px;border-top:1px solid #edf1f5;color:#3a526e;white-space:nowrap}.wfh-eo-id{border:0;background:transparent;padding:0;color:#155bd7;font:inherit;font-weight:850;cursor:pointer}.wfh-eo-id:hover{text-decoration:underline}.wfh-eo-badge{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--eo-border);background:var(--eo-bg);color:var(--eo-color);border-radius:999px;padding:3px 6px;font-size:8px;font-weight:800}.wfh-eo-badge:before{content:'';width:5px;height:5px;border-radius:50%;background:var(--eo-color)}@media(max-width:1100px){.wfh-eo-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.wfh-eo-body{grid-template-columns:1fr}}@media(max-width:650px){.wfh-eo-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
  `;document.head.appendChild(s)
}
function tone(el,key){const [c,b,bd]=tones[key]||tones.none;el.style.setProperty('--eo-color',c);el.style.setProperty('--eo-bg',b);el.style.setProperty('--eo-border',bd)}
function currentMonth(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function monthText(k){const m=text(k).match(/^(\d{4})-(\d{2})$/);return m?`${m[1]}年${Number(m[2])}月`:text(k)||'本月'}

async function load(){
  if(loading)return
  loading=true
  try{
    const [summaryRes,overviewRes]=await Promise.all([
      supabase.from('employee_error_summary').select('*').order('month_error_count',{ascending:false}).limit(5000),
      supabase.functions.invoke('admin-reports',{body:{action:'overview'}}),
    ])
    if(!summaryRes.error){
      const roster=overviewRes?.data?.roster||[]
      const allowed=new Set(roster.map(r=>upper(r.employee_id)).filter(Boolean))
      rows=allowed.size?(summaryRes.data||[]).filter(r=>allowed.has(upper(r.employee_no))):(summaryRes.data||[])
    }
    lastLoaded=Date.now()
  }finally{loading=false}
}
function openErrorsFor(id){
  const tab=[...document.querySelectorAll('.rp-tabs button')].find(x=>text(x.textContent)==='错误统计')
  if(!tab)return
  tab.click()
  setTimeout(()=>{
    const input=document.querySelector('.rp-error-filters input')
    if(!input)return
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set
    if(setter)setter.call(input,id);else input.value=id
    input.dispatchEvent(new Event('input',{bubbles:true}))
    input.focus()
  },180)
}
function kpi(label,value,sub,key=''){
  const box=document.createElement('div');box.className=`wfh-eo-kpi${key?' risk':''}`;if(key)tone(box,key)
  const sm=document.createElement('small');sm.textContent=label
  const strong=document.createElement('strong');strong.textContent=String(value)
  const em=document.createElement('em');em.textContent=sub
  box.append(sm,strong,em);return box
}
function badge(key){const x=document.createElement('span');x.className='wfh-eo-badge';x.textContent=labels[key]||key;tone(x,key);return x}
function render(){
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)
  const anchor=document.querySelector('.rp-grid2')
  const old=document.querySelector('.wfh-eo-card')
  if(active!=='总汇'||!anchor){old?.remove();return}
  const month=currentMonth(),monthRows=rows.filter(r=>text(r.month_key)===month)
  const monthErrors=monthRows.reduce((s,r)=>s+num(r.month_error_count),0)
  const last30=monthRows.reduce((s,r)=>s+num(r.last_30d_error_count),0)
  const withErrors=monthRows.filter(r=>num(r.month_error_count)>0).length
  const counts={high:0,watch:0,attention:0,normal:0,none:0}
  monthRows.forEach(r=>counts[bucket(r.month_error_count)]++)
  const totalPeople=monthRows.length||1
  const top=monthRows.filter(r=>num(r.month_error_count)>0).slice().sort((a,b)=>num(b.month_error_count)-num(a.month_error_count)||num(b.total_error_count)-num(a.total_error_count)).slice(0,10)
  const signature=[month,monthErrors,last30,withErrors,counts.high,counts.watch,counts.attention,counts.normal,counts.none,...top.map(r=>`${r.employee_no}:${r.month_error_count}:${r.last_30d_error_count}:${r.total_error_count}:${r.last_error_date}`)].join('|')
  if(old?.dataset.signature===signature)return
  const card=old||document.createElement('section');card.className='wfh-eo-card';card.dataset.signature=signature;card.replaceChildren()
  const head=document.createElement('div');head.className='wfh-eo-head';const left=document.createElement('div');const h=document.createElement('h3');h.textContent='员工错误风险总览';const p=document.createElement('p');p.textContent='与「错误统计」同一口径，并限制在当前居家排班人员；本月分级 + 近30天 + 累计错误。';left.append(h,p);const stamp=document.createElement('span');stamp.textContent=`${monthText(month)} · 30秒自动刷新`;head.append(left,stamp)
  const kp=document.createElement('div');kp.className='wfh-eo-kpis';kp.append(kpi('本月错误总笔数',monthErrors,'当前排班员工错误合计'),kpi('近30天错误',last30,'滚动30天合计'),kpi('有错误员工',withErrors,`当前统计 ${monthRows.length} 人`),kpi('高频员工',counts.high,'本月 ≥10 笔','high'),kpi('重点观察',counts.watch,'本月 6–9 笔','watch'),kpi('注意员工',counts.attention,'本月 4–5 笔','attention'))
  const body=document.createElement('div');body.className='wfh-eo-body'
  const dist=document.createElement('div');dist.className='wfh-eo-panel';const dh=document.createElement('div');dh.className='wfh-eo-panel-head';dh.innerHTML='<strong>风险等级分布</strong><span>按员工本月错误次数</span>';const bars=document.createElement('div');bars.className='wfh-eo-bars';['high','watch','attention','normal','none'].forEach(key=>{const n=counts[key]||0,b=document.createElement('div');b.className='wfh-eo-bar';const l=document.createElement('span');l.textContent=labels[key];const v=document.createElement('b');v.textContent=n;const track=document.createElement('i');track.className='wfh-eo-track';const fill=document.createElement('span');fill.className='wfh-eo-fill';tone(fill,key);fill.style.width=`${Math.min(100,n/totalPeople*100)}%`;track.appendChild(fill);b.append(l,v,track);bars.appendChild(b)});dist.append(dh,bars)
  const rank=document.createElement('div');rank.className='wfh-eo-panel';const rh=document.createElement('div');rh.className='wfh-eo-panel-head';rh.innerHTML='<strong>本月错误 TOP 10</strong><span>点击员工ID → 对应错误记录</span>';const tw=document.createElement('div');tw.className='wfh-eo-table-wrap';const table=document.createElement('table');table.className='wfh-eo-table';table.innerHTML='<thead><tr><th>等级</th><th>员工ID</th><th>主要错误</th><th>本月</th><th>近30天</th><th>累计</th><th>最近错误</th></tr></thead><tbody></tbody>';const tbody=table.querySelector('tbody');top.forEach(r=>{const tr=document.createElement('tr'),key=bucket(r.month_error_count);const td0=document.createElement('td');td0.appendChild(badge(key));const td1=document.createElement('td');const btn=document.createElement('button');btn.className='wfh-eo-id';btn.textContent=r.employee_no;btn.addEventListener('click',()=>openErrorsFor(r.employee_no));td1.appendChild(btn);const values=[r.main_error_type||'—',num(r.month_error_count),num(r.last_30d_error_count),num(r.total_error_count),r.last_error_date||'—'];tr.append(td0,td1);values.forEach(v=>{const td=document.createElement('td');td.textContent=String(v);tr.appendChild(td)});tbody.appendChild(tr)});tw.appendChild(table);rank.append(rh,tw);body.append(dist,rank)
  card.append(head,kp,body)
  if(!old)anchor.insertAdjacentElement('afterend',card)
}
async function run(){if(stopped)return;scheduled=false;const active=text(document.querySelector('.rp-tabs button.active')?.textContent);if(active==='总汇'&&Date.now()-lastLoaded>25000)await load();render()}
function schedule(){if(scheduled||stopped)return;scheduled=true;setTimeout(run,100)}

export function startReportErrorOverviewEnhancer(){
  if(window.__WFH_REPORT_ERROR_OVERVIEW__)return
  window.__WFH_REPORT_ERROR_OVERVIEW__=true
  addStyles()
  const observer=new MutationObserver(schedule);observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{lastLoaded=0;schedule()},30000)
  const channel=supabase.channel('wfh-report-error-overview').on('postgres_changes',{event:'*',schema:'public',table:'employee_error_summary'},()=>{lastLoaded=0;schedule()}).subscribe()
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();supabase.removeChannel(channel)},{once:true})
}
