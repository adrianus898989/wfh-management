import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const esc=v=>text(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))
const COLORS=['#36a2eb','#ff6384','#ff9f40','#ffcd56','#4bc0c0','#9966ff','#c9cbcf','#2f9ed8','#f55f83','#f28e2b','#59c3c3','#8a5cf6','#bfc3c8','#9bd3f4','#ffb16a','#6fc9c4','#7f63dd','#f2c14e','#45b7aa','#f08a24']
const gradeMeta={
  excellent:{label:'优秀（0错误）',color:'#168a63'},normal:{label:'正常（1–8）',color:'#2563a8'},attention:{label:'注意（9–15）',color:'#a16207'},watch:{label:'重点（16–30）',color:'#c2410c'},high:{label:'高频（31+）',color:'#b42334'},
}
const gradeChoices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]
let stopped=false,scheduled=false,priorInvoke=null,employeeGrade=''

function gradeFromErrorUi(){
  const label=text(document.querySelector('.wfh-error-grade-slot .wfh-grade-trigger')?.textContent)
  if(label.startsWith('优秀'))return 'excellent'
  if(label.startsWith('正常'))return 'normal'
  if(label.startsWith('注意'))return 'attention'
  if(label.startsWith('重点'))return 'watch'
  if(label.startsWith('高频'))return 'high'
  return ''
}
function patchInvoke(){
  if(supabase.functions.__wfhV2714Patched)return
  priorInvoke=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    if(name==='admin-employees'&&body.action==='list'&&employeeGrade){
      return priorInvoke('admin-employee-risk-list',{...options,body:{...body,risk_level:employeeGrade,filters:{...(body.filters||{}),risk_level:employeeGrade}}})
    }
    const isErrors=(name==='admin-reports'&&body.action==='errors')||name==='admin-report-errors'
    if(isErrors){
      const risk=gradeFromErrorUi()
      if(risk)return priorInvoke(name,{...options,body:{...body,risk_level:risk}})
    }
    return priorInvoke(name,options)
  }
  supabase.functions.__wfhV2714Patched=true
}

function triggerEmployeeReload(){
  const grid=document.querySelector('.employee-core-search-grid')
  const idInput=[...(grid?.querySelectorAll('label')||[])].find(x=>text(x.querySelector('span')?.textContent)==='员工ID')?.querySelector('input')
  if(idInput){
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set,current=idInput.value||''
    if(setter){setter.call(idInput,current+' ');idInput.dispatchEvent(new Event('input',{bubbles:true}));setTimeout(()=>{setter.call(idInput,current);idInput.dispatchEvent(new Event('input',{bubbles:true}))},65);return}
  }
  document.querySelector('.employee-refresh-action')?.click()
}
function updateEmployeeGradePicker(root){
  const trigger=root?.querySelector('.wfh-grade-trigger'),menu=root?.querySelector('.wfh-grade-menu');if(!trigger||!menu)return
  const chosen=gradeChoices.find(x=>x[0]===employeeGrade)||gradeChoices[0],meta=gradeMeta[employeeGrade]
  trigger.innerHTML=`${meta?`<i class="wfh-grade-dot" style="--grade-color:${meta.color}"></i>`:''}${chosen[1]}`
  ;[...menu.querySelectorAll('button')].forEach(b=>b.classList.toggle('active',b.dataset.key===employeeGrade))
}
function ensureEmployeeGradePicker(){
  const grid=document.querySelector('.employee-core-search-grid');if(!grid)return
  const native=grid.querySelector('label[data-native-risk-filter="1"]');if(native)native.classList.add('wfh-hide-native-grade')
  let label=grid.querySelector('.wfh-v2714-employee-grade')
  if(!label){
    label=document.createElement('label');label.className='pro-filter-field wfh-v2714-employee-grade'
    const title=document.createElement('span');title.textContent='等级'
    const root=document.createElement('div');root.className='wfh-grade-picker'
    const trigger=document.createElement('button');trigger.type='button';trigger.className='wfh-grade-trigger'
    const menu=document.createElement('div');menu.className='wfh-grade-menu'
    gradeChoices.forEach(([key,name])=>{const b=document.createElement('button');b.type='button';b.dataset.key=key;b.textContent=name;b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();employeeGrade=key;root.classList.remove('open');updateEmployeeGradePicker(root);triggerEmployeeReload()});menu.appendChild(b)})
    trigger.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();document.querySelectorAll('.wfh-grade-picker.open').forEach(x=>{if(x!==root)x.classList.remove('open')});root.classList.toggle('open')})
    root.append(trigger,menu);label.append(title,root);grid.insertBefore(label,grid.firstChild)
  }
  updateEmployeeGradePicker(label.querySelector('.wfh-grade-picker'))
}

function hideEmployeeNoise(){
  for(const node of document.querySelectorAll('.employee-page p,.employee-page small,.employee-page span')){
    const s=text(node.textContent)
    if(s.includes('Realtime 自动刷新')&&s.includes('60 秒静默轮询兜底'))node.style.display='none'
  }
  for(const small of document.querySelectorAll('.analytics-detail-table .event-date-cell small'))small.style.display='none'
}

function teamCard(){return [...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='团队统计表')||null}
function rankingCards(){
  const team=teamCard(),grid=team?.nextElementSibling
  if(!grid?.classList?.contains('rp-grid2'))return {}
  const cards=[...grid.querySelectorAll(':scope > .rp-card')]
  return {position:cards.find(x=>text(x.querySelector('.rp-card-title h3')?.textContent)==='岗位分布'),team:cards.find(x=>text(x.querySelector('.rp-card-title h3')?.textContent)==='团队人数')}
}
function sourceItems(card){return [...(card?.querySelectorAll('.rp-bars button')||[])].map((button,i)=>({button,name:text(button.querySelector('span')?.textContent)||`项目${i+1}`,count:Number(text(button.querySelector('strong')?.textContent))||0})).filter(x=>x.name)}

function closeSummary(){document.querySelector('.wfh-chart-summary-mask')?.remove()}
function openSummary(title,items){
  closeSummary()
  const mask=document.createElement('div');mask.className='wfh-chart-summary-mask'
  const box=document.createElement('div');box.className='wfh-chart-summary-modal'
  box.innerHTML=`<header><div><span>SUMMARY</span><h3>${esc(title)}汇总</h3></div><button type="button">×</button></header><div class="wfh-chart-summary-list">${items.map((x,i)=>`<button type="button" data-i="${i}"><span>${esc(x.name)}</span><strong>${x.count}</strong></button>`).join('')}</div>`
  mask.appendChild(box);document.body.appendChild(mask)
  box.querySelector('header button')?.addEventListener('click',closeSummary)
  mask.addEventListener('mousedown',e=>{if(e.target===mask)closeSummary()})
  box.querySelectorAll('.wfh-chart-summary-list button').forEach(b=>b.addEventListener('click',()=>{const x=items[Number(b.dataset.i)];closeSummary();x?.button?.click()}))
}
function ensureChartHeader(card,subtitle,items){
  const head=card?.querySelector('.rp-card-title');if(!head)return
  const p=head.querySelector('p');if(p)p.textContent=subtitle
  let btn=head.querySelector('.wfh-view-summary')
  if(!btn){btn=document.createElement('button');btn.type='button';btn.className='wfh-view-summary';btn.textContent='查看汇总';head.appendChild(btn)}
  btn.onclick=()=>openSummary(text(head.querySelector('h3')?.textContent),items)
}
function renderDonut(card){
  if(!card)return
  card.querySelector('.rp-injected-donut')?.remove()
  const items=sourceItems(card).filter(x=>x.count>0),sig=items.map(x=>`${x.name}:${x.count}`).join('|')
  ensureChartHeader(card,'点击图例或图形 → 弹出该岗位员工名单',items)
  let host=card.querySelector('.wfh-original-position-chart')
  if(!host){host=document.createElement('div');host.className='wfh-original-position-chart';card.querySelector('.rp-bars')?.insertAdjacentElement('beforebegin',host)}
  if(host.dataset.sig===sig)return
  host.dataset.sig=sig
  const total=items.reduce((s,x)=>s+x.count,0)||1,r=116,circ=2*Math.PI*r
  let cursor=0
  const arcs=items.map((x,i)=>{const raw=x.count/total*circ,gap=Math.min(2.6,raw*.12),len=Math.max(0,raw-gap),offset=-cursor;cursor+=raw;return `<circle data-i="${i}" cx="180" cy="180" r="${r}" fill="none" stroke="${COLORS[i%COLORS.length]}" stroke-width="76" stroke-dasharray="${len.toFixed(2)} ${(circ-len).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" transform="rotate(-90 180 180)"/>`}).join('')
  host.innerHTML=`<div class="wfh-position-legend">${items.map((x,i)=>`<button type="button" data-i="${i}"><i style="--legend:${COLORS[i%COLORS.length]}"></i>${esc(x.name)}</button>`).join('')}</div><div class="wfh-donut-wrap"><svg viewBox="0 0 360 360" role="img" aria-label="岗位分布">${arcs}<circle cx="180" cy="180" r="76" class="wfh-donut-hole"/></svg></div>`
  const open=i=>items[Number(i)]?.button?.click();host.querySelectorAll('[data-i]').forEach(el=>el.addEventListener('click',()=>open(el.dataset.i)))
}
function renderTeamBars(card){
  if(!card)return
  const items=sourceItems(card).filter(x=>x.count>=0),sig=items.map(x=>`${x.name}:${x.count}`).join('|')
  ensureChartHeader(card,'点击柱子 → 弹出该团队员工名单',items)
  let host=card.querySelector('.wfh-original-team-chart')
  if(!host){host=document.createElement('div');host.className='wfh-original-team-chart';card.querySelector('.rp-bars')?.insertAdjacentElement('beforebegin',host)}
  if(host.dataset.sig===sig)return
  host.dataset.sig=sig
  const w=760,h=330,left=48,right=16,top=18,bottom=88,plotW=w-left-right,plotH=h-top-bottom
  const maxValue=Math.max(1,...items.map(x=>x.count)),niceMax=Math.max(50,Math.ceil(maxValue/50)*50),steps=niceMax/50<=8?niceMax/50:7
  const grid=[]
  for(let i=0;i<=steps;i++){const value=Math.round(niceMax*i/steps),y=top+plotH-(value/niceMax)*plotH;grid.push(`<line x1="${left}" x2="${w-right}" y1="${y}" y2="${y}"/><text x="${left-8}" y="${y+4}" text-anchor="end">${value}</text>`)}
  const slot=plotW/Math.max(1,items.length),bw=Math.min(40,slot*.66)
  const bars=items.map((x,i)=>{const bh=x.count/niceMax*plotH,cx=left+slot*i+slot/2,y=top+plotH-bh;return `<rect data-i="${i}" x="${(cx-bw/2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/><text class="wfh-team-x" x="${cx.toFixed(1)}" y="${(top+plotH+21).toFixed(1)}" transform="rotate(-55 ${cx.toFixed(1)} ${(top+plotH+21).toFixed(1)})" text-anchor="end">${esc(x.name)}</text>`}).join('')
  host.innerHTML=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="团队人数"><g class="wfh-team-grid">${grid.join('')}</g><g class="wfh-team-bars">${bars}</g></svg>`
  host.querySelectorAll('rect[data-i]').forEach(el=>el.addEventListener('click',()=>items[Number(el.dataset.i)]?.button?.click()))
}
function patchReports(){
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)==='总汇';if(!active)return
  const card=teamCard();if(card)card.classList.add('wfh-team-fit-card')
  const {position,team}=rankingCards();if(position)position.classList.add('wfh-original-chart-card');if(team)team.classList.add('wfh-original-chart-card')
  renderDonut(position);renderTeamBars(team)
}

async function run(){if(stopped)return;scheduled=false;ensureEmployeeGradePicker();hideEmployeeNoise();patchReports()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,100)}
function captureClick(e){
  const b=e.target.closest?.('button')
  if(b&&text(b.textContent)==='重置'&&b.closest('.archive-filter-actions')){employeeGrade='';schedule()}
}
export function startUiV2714Enhancer(){
  if(window.__WFH_UI_V2714__)return
  window.__WFH_UI_V2714__=true;patchInvoke();document.addEventListener('click',captureClick,true)
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;observer.disconnect();document.removeEventListener('click',captureClick,true)},{once:true})
}
