import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const num=v=>Number(v||0)
const riskKey=v=>{const n=num(v);return n>=10?'high':n>=4?'watch':n>=1?'attention':'normal'}
const labels={high:'高频',watch:'重点',attention:'注意',normal:'正常'}
const tones={
  high:['#b42334','#fff1f2','#fecdd3'],
  watch:['#c2410c','#fff7ed','#fed7aa'],
  attention:['#a16207','#fffbeb','#fde68a'],
  normal:['#39734a','#f0fdf4','#bbf7d0'],
}
let stopped=false,scheduled=false,loading=false,lastLoaded=0,rows=[]

function currentMonth(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function tone(el,key){const [c,b,bd]=tones[key]||tones.normal;el.style.setProperty('--eo-color',c);el.style.setProperty('--eo-bg',b);el.style.setProperty('--eo-border',bd)}

async function load(){
  if(loading)return
  loading=true
  try{
    const [summaryRes,overviewRes]=await Promise.all([
      supabase.from('employee_error_summary').select('*').limit(5000),
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

function setKpi(box,label,value,sub,key=''){
  if(!box)return
  const small=box.querySelector('small'),strong=box.querySelector('strong'),em=box.querySelector('em')
  if(small)small.textContent=label
  if(strong)strong.textContent=String(value)
  if(em)em.textContent=sub
  if(key){box.classList.add('risk');tone(box,key)}
}

function render(){
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)
  const card=document.querySelector('.wfh-eo-card')
  if(active!=='总汇'||!card)return
  const month=currentMonth()
  const monthRows=rows.filter(r=>text(r.month_key)===month)
  const counts={high:0,watch:0,attention:0,normal:0}
  monthRows.forEach(r=>counts[riskKey(r.month_error_count)]++)
  const monthErrors=monthRows.reduce((s,r)=>s+num(r.month_error_count),0)
  const last30=monthRows.reduce((s,r)=>s+num(r.last_30d_error_count),0)
  const withErrors=monthRows.filter(r=>num(r.month_error_count)>0).length
  const kpis=[...card.querySelectorAll('.wfh-eo-kpi')]
  setKpi(kpis[0],'本月错误总笔数',monthErrors,'当前排班员工错误合计')
  setKpi(kpis[1],'近30天错误',last30,'滚动30天合计')
  setKpi(kpis[2],'有错误员工',withErrors,`当前统计 ${monthRows.length} 人`)
  setKpi(kpis[3],'高频员工',counts.high,'本月 ≥10 笔','high')
  setKpi(kpis[4],'重点员工',counts.watch,'本月 4–9 笔','watch')
  setKpi(kpis[5],'注意员工',counts.attention,'本月 1–3 笔','attention')

  const bars=[...card.querySelectorAll('.wfh-eo-bars .wfh-eo-bar')]
  const total=Math.max(1,monthRows.length)
  ;['high','watch','attention','normal'].forEach((key,i)=>{
    const bar=bars[i];if(!bar)return
    bar.style.display='grid'
    const label=bar.querySelector('span'),value=bar.querySelector('b'),fill=bar.querySelector('.wfh-eo-fill')
    if(label)label.textContent=labels[key]
    if(value)value.textContent=String(counts[key]||0)
    if(fill){tone(fill,key);fill.style.width=`${Math.min(100,(counts[key]||0)/total*100)}%`}
  })
  bars.slice(4).forEach(x=>x.style.display='none')
  const distHead=card.querySelector('.wfh-eo-bars')?.closest('.wfh-eo-panel')?.querySelector('.wfh-eo-panel-head span')
  if(distHead)distHead.textContent='0正常 / 1–3注意 / 4–9重点 / 10+高频'

  const byId=new Map(monthRows.map(r=>[upper(r.employee_no),r]))
  for(const tr of card.querySelectorAll('.wfh-eo-table tbody tr')){
    const id=upper(tr.querySelector('.wfh-eo-id')?.textContent)
    const row=byId.get(id);if(!row)continue
    const key=riskKey(row.month_error_count)
    const badge=tr.querySelector('.wfh-eo-badge')
    if(badge){badge.textContent=labels[key];tone(badge,key)}
  }
}

async function run(){
  if(stopped)return
  scheduled=false
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)
  if(active==='总汇'&&Date.now()-lastLoaded>20000)await load()
  render()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,140)}

export function startErrorOverviewV2Enhancer(){
  if(window.__WFH_ERROR_OVERVIEW_V2__)return
  window.__WFH_ERROR_OVERVIEW_V2__=true
  const observer=new MutationObserver(schedule)
  observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{lastLoaded=0;schedule()},30000)
  const channel=supabase.channel('wfh-error-overview-v2').on('postgres_changes',{event:'*',schema:'public',table:'employee_error_summary'},()=>{lastLoaded=0;schedule()}).subscribe()
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();supabase.removeChannel(channel)},{once:true})
}
