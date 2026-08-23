import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const SPECIAL=['出款','彩金','客服','查单']
const COLORS=['#2563eb','#8b5cf6','#14b8a6','#f59e0b','#ef4444','#06b6d4','#84cc16','#f97316','#ec4899','#64748b','#0ea5e9','#a855f7']
let stopped=false,scheduled=false
let workload={at:0,loading:false,error:'',roster:[],dates:[],orderById:new Map()}

const isoToday=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const isoAdd=(base,days)=>{const d=new Date(`${base}T12:00:00`);d.setDate(d.getDate()+days);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
const uniqueNames=rows=>new Set((rows||[]).map(r=>text(r.name)).filter(Boolean)).size
const dayValue=(order,date)=>{const d=order?.daily?.[date]||{};return Number(d.success||0)+Number(d.reject||0)}

async function invoke(body){
  const {data,error}=await supabase.functions.invoke('admin-reports',{body})
  if(error||data?.error) throw new Error(data?.error||error?.message||'统计读取失败')
  return data
}

async function ensureWorkload(force=false){
  if(workload.loading)return workload
  if(!force&&workload.at&&Date.now()-workload.at<55000)return workload
  workload.loading=true;workload.error=''
  try{
    const end=isoToday(),from=isoAdd(end,-13)
    const [overview,orders]=await Promise.all([
      invoke({action:'overview'}),
      invoke({action:'orders',date_from:from,date_to:end}),
    ])
    const dates=(orders?.dates||[]).slice(-7)
    workload={
      at:Date.now(),loading:false,error:'',
      roster:overview?.roster||[],dates,
      orderById:new Map((orders?.rows||[]).map(x=>[text(x.employee_id).toUpperCase(),x])),
    }
  }catch(e){
    workload={...workload,at:Date.now(),loading:false,error:e?.message||'每日工作量读取失败'}
  }
  return workload
}

function workloadStats(team,position){
  const people=(workload.roster||[]).filter(r=>text(r.team)===team&&text(r.position)===position)
  const ids=[...new Set(people.map(r=>text(r.employee_id).toUpperCase()).filter(Boolean))]
  let total=0,days=0
  ids.forEach(id=>{
    const order=workload.orderById.get(id)
    ;(workload.dates||[]).forEach(d=>{
      const n=dayValue(order,d)
      if(n>0){total+=n;days+=1}
    })
  })
  return {people,count:uniqueNames(people),total,days,avg:days?(total/days).toFixed(1):'0.0'}
}

function teamCard(){return [...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='团队统计表')||null}

function addWorkloadState(card){
  if(!card)return
  const title=card.querySelector('.rp-card-title')
  if(!title)return
  let pill=title.querySelector('.rp-workload-live-pill')
  if(!pill){pill=document.createElement('span');pill.className='rp-workload-live-pill';title.appendChild(pill)}
  if(workload.loading){pill.className='rp-workload-live-pill loading';pill.textContent='Supabase 工作量读取中…';return}
  if(workload.error){pill.className='rp-workload-live-pill error';pill.textContent='Supabase 工作量读取失败';pill.title=workload.error;return}
  if(workload.dates.length){pill.className='rp-workload-live-pill ok';pill.textContent=`日均工作量 ${workload.dates[0].slice(5)} ~ ${workload.dates.at(-1).slice(5)}`}
  else{pill.className='rp-workload-live-pill';pill.textContent='暂无工作量日期'}
}

function patchTeamWorkload(){
  const card=teamCard(),table=card?.querySelector('.rp-team-table')
  if(!card||!table)return
  addWorkloadState(card)
  const heads=[...table.querySelectorAll('thead th')].map(x=>text(x.textContent))
  for(const tr of table.querySelectorAll('tbody tr')){
    const team=text(tr.children[0]?.textContent)
    if(!team)continue
    SPECIAL.forEach(position=>{
      const idx=heads.indexOf(position)
      if(idx<0)return
      const td=tr.children[idx]
      const avg=td?.querySelector('.rp-avg')
      if(!avg)return
      avg.dataset.team=team;avg.dataset.position=position
      if(workload.loading){avg.textContent='日均 …';avg.disabled=true;return}
      if(workload.error){avg.textContent='日均 —';avg.disabled=true;return}
      const stat=workloadStats(team,position)
      avg.disabled=!workload.dates.length
      avg.textContent=`日均 ${stat.avg}`
      avg.title=`Supabase 已同步效率表最近 ${workload.dates.length} 个数据日 · ${stat.count} 人 · ${stat.days} 个有效人日 · 共 ${stat.total} 笔`
    })
  }
}

function closeWorkloadModal(){document.querySelector('.rp-workload-modal-mask')?.remove()}
function openWorkloadModal(team,position){
  closeWorkloadModal()
  const stat=workloadStats(team,position),dates=workload.dates||[]
  const rows=stat.people.map(r=>{
    const order=workload.orderById.get(text(r.employee_id).toUpperCase())
    const daily=Object.fromEntries(dates.map(d=>[d,dayValue(order,d)]))
    return {r,daily,total:dates.reduce((s,d)=>s+(daily[d]||0),0)}
  }).sort((a,b)=>b.total-a.total||text(a.r.name).localeCompare(text(b.r.name),'zh-CN'))
  const lows={}
  dates.forEach(d=>{const vals=[...new Set(rows.map(x=>x.daily[d]).filter(v=>v>0))].sort((a,b)=>a-b);lows[d]=vals.slice(0,3)})
  const mask=document.createElement('div');mask.className='rp-workload-modal-mask'
  const modal=document.createElement('div');modal.className='rp-workload-modal'
  const header=document.createElement('header')
  header.innerHTML=`<div><span>EFFICIENCY DETAIL</span><h2>${team} · ${position}</h2><p>最近 ${dates.length} 个数据日 · ${stat.count} 人 · 日均 ${stat.avg} 笔 · 共 ${stat.total} 笔</p></div><button type="button" aria-label="关闭">×</button>`
  const body=document.createElement('div');body.className='rp-workload-modal-body'
  if(!dates.length){body.innerHTML='<div class="rp-workload-empty">暂无每日工作量日期</div>'}
  else{
    const cells=rows.map((x,i)=>`<tr><td>${i+1}</td><td><strong>${text(x.r.employee_id)||'—'}</strong></td><td>${text(x.r.name)||'—'}</td><td>${text(x.r.team)||'—'}</td><td>${text(x.r.position)||'—'}</td><td><strong>${x.total}</strong></td>${dates.map(d=>{const v=x.daily[d]||0,rank=lows[d].indexOf(v);const cls=v>0?(rank===0?'low1':rank===1?'low2':rank===2?'low3':'positive'):'zero';return `<td><span class="${cls}">${v||'—'}</span></td>`}).join('')}</tr>`).join('')
    body.innerHTML=`<div class="rp-workload-note">每日笔数 = 成功 + 驳回；红 / 橙 / 黄为当天倒数前三个正数。</div><div class="rp-workload-table-wrap"><table><thead><tr><th>#</th><th>ID</th><th>姓名</th><th>团队</th><th>岗位</th><th>近7日总量</th>${dates.map(d=>`<th>${d.slice(5)}</th>`).join('')}</tr></thead><tbody>${cells}</tbody></table></div>`
  }
  modal.append(header,body);mask.appendChild(modal);document.body.appendChild(mask)
  header.querySelector('button')?.addEventListener('click',closeWorkloadModal)
  mask.addEventListener('mousedown',e=>{if(e.target===mask)closeWorkloadModal()})
}

function patchCharts(){
  const card=teamCard()
  const grid=card?.nextElementSibling
  if(!grid?.classList?.contains('rp-grid2'))return
  const cards=[...grid.querySelectorAll(':scope > .rp-card')]
  const positionCard=cards.find(x=>text(x.querySelector('.rp-card-title h3')?.textContent)==='岗位分布')
  const teamRank=cards.find(x=>text(x.querySelector('.rp-card-title h3')?.textContent)==='团队人数')
  if(positionCard){
    positionCard.classList.add('rp-overview-position-card')
    const bars=positionCard.querySelector('.rp-bars')
    if(bars&&!positionCard.querySelector('.rp-injected-donut')){
      const items=[...bars.querySelectorAll('button')].map((b,i)=>({name:text(b.querySelector('span')?.textContent),count:Number(text(b.querySelector('strong')?.textContent))||0,color:COLORS[i%COLORS.length]})).filter(x=>x.count>0)
      const total=items.reduce((s,x)=>s+x.count,0)||1
      let cursor=0
      const stops=items.slice(0,12).map(x=>{const start=cursor;cursor+=x.count/total*100;return `${x.color} ${start}% ${cursor}%`})
      if(cursor<100)stops.push(`#e8eef6 ${cursor}% 100%`)
      const wrap=document.createElement('div');wrap.className='rp-injected-donut'
      wrap.innerHTML=`<div class="rp-injected-donut-chart" style="background:conic-gradient(${stops.join(',')})"><div><strong>${total}</strong><span>人员</span></div></div><div><strong>岗位结构</strong><span>点击右侧条目可查看对应人员</span></div>`
      bars.insertAdjacentElement('beforebegin',wrap)
    }
  }
  if(teamRank)teamRank.classList.add('rp-overview-team-card')
}

function patchRosterModals(){
  for(const modal of document.querySelectorAll('.rp-modal.wide')){
    if(modal.querySelector('.rp-roster-table'))modal.classList.add('rp-roster-modal-fit')
  }
}

async function run(){
  if(stopped)return
  scheduled=false
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)==='总汇'
  if(!active)return
  patchCharts();patchRosterModals()
  const card=teamCard()
  if(!card)return
  addWorkloadState(card)
  await ensureWorkload(false)
  patchTeamWorkload();patchCharts();patchRosterModals()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,120)}

function clickCapture(e){
  const avg=e.target.closest?.('.rp-team-table .rp-avg')
  if(avg){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()
    if(!avg.disabled&&avg.dataset.team&&avg.dataset.position)openWorkloadModal(avg.dataset.team,avg.dataset.position)
    return
  }
  const managerButton=e.target.closest?.('.rp-manager-grid button')
  if(managerButton){
    const managerMask=managerButton.closest('.rp-modal-mask')
    setTimeout(()=>{
      if(managerMask?.isConnected){managerMask.querySelector('.rp-modal>header button')?.click()}
    },0)
  }
}

export function startReportOverviewEnhancer(){
  if(window.__WFH_REPORT_OVERVIEW_V2712__)return
  window.__WFH_REPORT_OVERVIEW_V2712__=true
  document.addEventListener('click',clickCapture,true)
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{if(!document.hidden){workload.at=0;schedule()}},60000)
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('click',clickCapture,true)},{once:true})
}
