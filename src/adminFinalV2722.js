import { supabase } from './lib/supabase'
import { getAllErrorSummaryMap } from './lib/errorSummaryStore'
import { openEmployeeErrorHistory } from './stableErrorUiEnhancer'
import { appPathFromBrowserPath, internalPortalPath } from './lib/appBasePath'

const rawInvoke=supabase.functions.invoke.bind(supabase.functions)
const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const reportGradeKey=n=>{n=Number(n||0);if(n>=31)return'high';if(n>=16)return'watch';if(n>=9)return'attention';if(n>=1)return'normal';return'excellent'}
const reportGradeLabel=k=>({excellent:'优秀',normal:'正常',attention:'注意',watch:'重点',high:'高频'}[k]||'优秀')
const employeeRiskKey=n=>{n=Number(n||0);if(n>=31)return'high';if(n>=16)return'watch';if(n>=9)return'attention';if(n>=1)return'normal';return'excellent'}
const employeeRiskLabel=k=>({excellent:'优秀',normal:'正常',attention:'注意',watch:'重点',high:'高频'}[k]||'优秀')
const reportGradeChoices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]
const employeeGradeChoices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]
let reportRisk=''
let employeeRisk=''
let stopped=false,scheduled=false
let summaryCache={at:0,map:new Map()}
let reportCache={at:0,key:'',result:null}
let forceReportReloaded=false

const internalRuntimePath=()=>internalPortalPath(appPathFromBrowserPath(window.location.pathname))
const isReports=()=>internalRuntimePath()==='/admin/reports'
const isEmployees=()=>internalRuntimePath()==='/admin/employees'

function addStyles(){
  if(document.getElementById('wfh-admin-final-v2722-style'))return
  const s=document.createElement('style')
  s.id='wfh-admin-final-v2722-style'
  s.textContent=`
    /* Error report: one stable toolbar, no duplicate legacy toolbar. */
    .reports-page .wfh-v2721-error-filter{display:none!important}
    .wfh-v2722-error-filter{display:grid;gap:8px;padding:10px 12px;border-top:1px dashed #dce5f0;background:#fbfdff}
    .wfh-v2722-error-row{display:grid;gap:8px;align-items:end}
    .wfh-v2722-error-row.primary{grid-template-columns:120px 158px 150px minmax(190px,1.15fr) minmax(170px,.9fr) 72px}
    .wfh-v2722-error-row.advanced{grid-template-columns:repeat(5,minmax(120px,1fr)) minmax(160px,1.1fr) minmax(170px,1.2fr)}
    .wfh-v2722-error-filter input,.wfh-v2722-error-filter select,.wfh-v2722-error-filter button{height:34px;min-width:0;width:100%;border:1px solid #d5dfeb;border-radius:8px;background:#fff;padding:0 9px;color:#314b68;font-size:10px}
    .wfh-v2722-error-filter button{cursor:pointer;font-weight:800}
    .reports-page .rp-errors-scroll{overflow:auto!important;width:100%!important}
    .reports-page .rp-errors-table{width:100%!important;min-width:1420px!important;table-layout:fixed!important}
    .reports-page .rp-errors-table th,.reports-page .rp-errors-table td{padding:8px 7px!important;font-size:10px!important;vertical-align:middle!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
    .reports-page .rp-errors-table th:first-child,.reports-page .rp-errors-table td:first-child{width:160px!important;min-width:160px!important;max-width:160px!important}
    .reports-page .rp-errors-table th:nth-child(2),.reports-page .rp-errors-table td:nth-child(2){width:180px!important;min-width:180px!important}
    .reports-page .rp-errors-table td:first-child{overflow:visible!important}
    .reports-page .rp-errors-table td:first-child .rp-link[data-wfh-grade]::before{display:none!important;content:none!important}
    .wfh-v2722-id-cell{display:flex;align-items:center;gap:7px;min-width:0}
    .wfh-v2722-grade-chip{height:22px!important;min-width:46px!important;width:auto!important;padding:0 7px!important;border-radius:999px!important;font-size:9px!important;font-weight:850!important;line-height:1!important;flex:none!important;cursor:pointer!important}
    .wfh-v2722-grade-chip[data-grade="优秀"]{border:1px solid #9eecc6!important;background:#ebfff5!important;color:#0a8755!important}
    .wfh-v2722-grade-chip[data-grade="正常"]{border:1px solid #b8d7ff!important;background:#eef6ff!important;color:#1760b8!important}
    .wfh-v2722-grade-chip[data-grade="注意"]{border:1px solid #f5d77c!important;background:#fff9e8!important;color:#9a6500!important}
    .wfh-v2722-grade-chip[data-grade="重点"]{border:1px solid #ffc28d!important;background:#fff4e9!important;color:#b24b00!important}
    .wfh-v2722-grade-chip[data-grade="高频"]{border:1px solid #ffb4bd!important;background:#fff0f2!important;color:#c6283e!important}

    /* Real hover tooltip for the overview charts. */
    .wfh-v2722-chart-tip{position:fixed;z-index:5000;pointer-events:none;display:none;padding:7px 9px;border-radius:7px;background:rgba(24,34,48,.92);color:#fff;font-size:11px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,.18);white-space:nowrap}

    /* Employee list: grade is always visible even after SPA navigation. */
    .wfh-v2722-employee-risk-filter select{width:100%;height:40px;border:1px solid #d5e0ec;border-radius:9px;background:#fff;padding:0 10px;color:#314b68;font-size:11px}
    .employee-master-table .wfh-v2722-risk-head,.employee-master-table .wfh-v2722-risk-cell{width:66px!important;min-width:66px!important;max-width:66px!important;text-align:center!important;white-space:nowrap!important}
    .wfh-v2722-employee-chip{display:inline-flex;align-items:center;justify-content:center;height:22px;min-width:48px;padding:0 7px;border-radius:999px;font-size:9px;font-weight:850;white-space:nowrap}
    .wfh-v2722-employee-chip[data-grade="优秀"]{border:1px solid #9eecc6;background:#ebfff5;color:#0a8755}
    .wfh-v2722-employee-chip[data-grade="正常"]{border:1px solid #b8d7ff;background:#eef6ff;color:#1760b8}
    .wfh-v2722-employee-chip[data-grade="注意"]{border:1px solid #f5d77c;background:#fff9e8;color:#9a6500}
    .wfh-v2722-employee-chip[data-grade="重点"]{border:1px solid #ffc28d;background:#fff4e9;color:#b24b00}
    .wfh-v2722-employee-chip[data-grade="高频"]{border:1px solid #ffb4bd;background:#fff0f2;color:#c6283e}

    /* Employee drawer risk summary replaces the old green 'complete' sentence. */
    .employee-detail-drawer .profile-status-line.is-complete{display:none!important}
    .wfh-v2722-risk-summary{margin:12px 16px 0;display:grid;grid-template-columns:1.1fr repeat(3,1fr) 1.5fr;gap:8px;padding:10px;border:1px solid #dbe6f3;border-radius:12px;background:#f8fbff}
    .wfh-v2722-risk-summary>div{min-width:0;padding:8px 10px;border:1px solid #e1e9f3;border-radius:9px;background:#fff}
    .wfh-v2722-risk-summary span{display:block;color:#7a8da6;font-size:9px;font-weight:750;margin-bottom:4px}
    .wfh-v2722-risk-summary strong{display:block;color:#243f61;font-size:13px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .wfh-v2722-risk-summary .risk-grade strong{font-size:15px}
    .wfh-v2722-risk-summary[data-grade="正常"] .risk-grade strong{color:#1760b8}
    .wfh-v2722-risk-summary[data-grade="注意"] .risk-grade strong{color:#9a6500}
    .wfh-v2722-risk-summary[data-grade="重点"] .risk-grade strong{color:#b24b00}
    .wfh-v2722-risk-summary[data-grade="高频"] .risk-grade strong{color:#c6283e}
    .wfh-v2722-risk-summary[data-grade="优秀"] .risk-grade strong{color:#0a8755}
    .employee-detail-drawer{width:min(760px,94vw)!important}
    .employee-detail-drawer .detail-sections{padding:12px 16px 18px!important;gap:10px!important}
    .employee-detail-drawer .detail-panel{border-radius:11px!important}

    @media(max-width:1350px){
      .wfh-v2722-error-row.primary{grid-template-columns:repeat(3,minmax(130px,1fr))}
      .wfh-v2722-error-row.advanced{grid-template-columns:repeat(4,minmax(130px,1fr))}
      .wfh-v2722-risk-summary{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
  `
  document.head.appendChild(s)
}

function nativeSet(el,value,eventName='input'){
  if(!el)return
  const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype
  const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set
  if(setter)setter.call(el,value);else el.value=value
  el.dispatchEvent(new Event(eventName,{bubbles:true}))
}
function buttonByText(root,label){return [...(root?.querySelectorAll('button')||[])].find(x=>text(x.textContent)===label)||null}
function errorCard(){return [...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')||null}
function originalErrorParts(){const card=errorCard();return{card,order:card?.querySelector('.rp-order-toolbar'),local:card?.querySelector('.rp-error-filters'),global:document.querySelector('.rp-filterbar')}}
function hasAdvancedReportFilter(){const host=document.querySelector('.wfh-v2722-error-filter');if(!host)return false;return [...host.querySelectorAll('.advanced select,.advanced input')].some(x=>text(x.value))}

async function getSummary(force=false){
  if(!force&&Date.now()-summaryCache.at<20000&&summaryCache.map.size)return summaryCache.map
  try{summaryCache={at:Date.now(),map:await getAllErrorSummaryMap(force)}}catch{}
  return summaryCache.map
}

function patchInvoke(){
  if(supabase.functions.__wfhAdminFinalV2722)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    const errorRequest=name==='admin-report-errors'||(name==='admin-reports'&&body.action==='errors')
    if(isReports()&&errorRequest){
      const requestBody={...body};delete requestBody.action
      requestBody.risk_level=reportRisk||text(body.risk_level)
      const key=JSON.stringify(requestBody)
      let result
      if(reportCache.result&&reportCache.key===key&&Date.now()-reportCache.at<12000)result=reportCache.result
      else{result=await rawInvoke('admin-report-errors',{...options,body:requestBody});if(!result?.error&&!result?.data?.error)reportCache={at:Date.now(),key,result}}
      if(result?.error||result?.data?.error)return result
      // React used `current_roster_employee_count || allowed.size`; zero accidentally re-enabled roster filtering.
      // A truthy value <= allowed.size disables the roster intersection by default, preserving resigned/history rows.
      const count=hasAdvancedReportFilter()?Math.max(1,Number(result.data?.current_roster_employee_count||1)):1
      return {...result,data:{...result.data,current_roster_employee_count:count}}
    }
    if(isEmployees()&&name==='admin-employees'&&body.action==='list'&&employeeRisk){
      return rawInvoke('admin-employee-risk-list',{...options,body:{...body,risk_level:employeeRisk}})
    }
    return prior(name,options)
  }
  supabase.functions.__wfhAdminFinalV2722=true
}

function syncErrorSearch(){
  const host=document.querySelector('.wfh-v2722-error-filter'),{local}=originalErrorParts();if(!host||!local)return
  const id=text(host.querySelector('[data-role="id"]')?.value),name=text(host.querySelector('[data-role="name"]')?.value)
  nativeSet(local.querySelector('input'),[id,name].filter(Boolean).join(' '),'input')
}
function syncGlobalSelect(role,index){const host=document.querySelector('.wfh-v2722-error-filter'),{global}=originalErrorParts();const src=host?.querySelector(`[data-role="${role}"]`),dst=global?.querySelectorAll('select')?.[index];if(src&&dst)nativeSet(dst,src.value,'change')}
function resetErrorFilters({keepId=''}={}){
  const host=document.querySelector('.wfh-v2722-error-filter'),{order,local,global}=originalErrorParts();if(!host)return
  for(const x of host.querySelectorAll('input,select'))x.value=''
  reportRisk='';reportCache.at=0
  if(local){nativeSet(local.querySelector('input'),'','input');[...local.querySelectorAll('select')].forEach(x=>nativeSet(x,'','change'))}
  if(global){[...global.querySelectorAll('select')].forEach(x=>nativeSet(x,'','change'));const manager=global.querySelector('input[list]');if(manager)nativeSet(manager,'','input')}
  [...(order?.querySelectorAll('input[type="date"]')||[])].forEach(x=>nativeSet(x,'','input'))
  if(keepId){const id=host.querySelector('[data-role="id"]');if(id){id.value=keepId;syncErrorSearch()}}
}
function triggerErrorQuery(){const {order}=originalErrorParts();reportCache.at=0;buttonByText(order,'查询')?.click()}

function copySelectOptions(target,source){if(!target||!source)return;const html=source.innerHTML;if(target.innerHTML!==html){target.innerHTML=html;target.value=source.value||''}else if(document.activeElement!==target&&target.value!==source.value)target.value=source.value||''}
function ensureErrorFilters(){
  const {card,local,global}=originalErrorParts()
  if(!card||!local){if(global)global.style.display='';return}
  if(global)global.style.display='none'
  let host=card.querySelector('.wfh-v2722-error-filter')
  if(!host){
    host=document.createElement('div');host.className='wfh-v2722-error-filter'
    const p=document.createElement('div');p.className='wfh-v2722-error-row primary'
    const id=document.createElement('input');id.dataset.role='id';id.placeholder='输入员工ID';id.addEventListener('input',syncErrorSearch)
    const name=document.createElement('input');name.dataset.role='name';name.placeholder='输入姓名';name.addEventListener('input',syncErrorSearch)
    const grade=document.createElement('select');grade.dataset.role='grade';grade.innerHTML=reportGradeChoices.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');grade.addEventListener('change',()=>{reportRisk=text(grade.value);reportCache.at=0;triggerErrorQuery()})
    const type=document.createElement('select');type.dataset.role='type';type.addEventListener('change',()=>nativeSet(local.querySelectorAll('select')[0],type.value,'change'))
    const qc=document.createElement('select');qc.dataset.role='qc';qc.addEventListener('change',()=>nativeSet(local.querySelectorAll('select')[1],qc.value,'change'))
    const reset=document.createElement('button');reset.type='button';reset.textContent='重置';reset.addEventListener('click',()=>{resetErrorFilters();buttonByText(originalErrorParts().order,'全部')?.click();setTimeout(triggerErrorQuery,0)})
    p.append(id,name,grade,type,qc,reset)

    const a=document.createElement('div');a.className='wfh-v2722-error-row advanced'
    ;[['shift',0],['team',1],['group',2],['position',3],['country',4]].forEach(([role,index])=>{const sel=document.createElement('select');sel.dataset.role=role;sel.addEventListener('change',()=>{syncGlobalSelect(role,index);triggerErrorQuery()});a.appendChild(sel)})
    const manager=document.createElement('input');manager.dataset.role='manager';manager.placeholder='负责人 / 培训 / 组长';manager.addEventListener('input',()=>{const dst=originalErrorParts().global?.querySelector('input[list]');if(dst)nativeSet(dst,manager.value,'input')});manager.addEventListener('change',triggerErrorQuery);a.appendChild(manager)
    const platform=document.createElement('select');platform.dataset.role='platform';platform.addEventListener('change',()=>{syncGlobalSelect('platform',5);triggerErrorQuery()});a.appendChild(platform)
    host.append(p,a)
    local.before(host)
  }
  copySelectOptions(host.querySelector('[data-role="type"]'),local.querySelectorAll('select')[0])
  copySelectOptions(host.querySelector('[data-role="qc"]'),local.querySelectorAll('select')[1])
  if(global){const sels=global.querySelectorAll('select');[['shift',0],['team',1],['group',2],['position',3],['country',4],['platform',5]].forEach(([role,index])=>copySelectOptions(host.querySelector(`[data-role="${role}"]`),sels[index]));const manager=host.querySelector('[data-role="manager"]'),source=global.querySelector('input[list]');if(manager&&source&&document.activeElement!==manager)manager.value=source.value||''}
  const grade=host.querySelector('[data-role="grade"]');if(grade&&document.activeElement!==grade)grade.value=reportRisk
}

async function decorateReportGrades(){
  const table=errorCard()?.querySelector('.rp-errors-table');if(!table)return
  const map=await getSummary()
  for(const tr of table.querySelectorAll('tbody tr')){
    const cell=tr.querySelector('td:first-child');const idButton=cell?.querySelector('button.rp-link');if(!cell||!idButton)continue
    const id=upper(idButton.textContent),summary=map.get(id),label=reportGradeLabel(reportGradeKey(summary?.total_error_count||0))
    cell.classList.add('wfh-v2722-id-cell')
    let chip=cell.querySelector('.wfh-v2722-grade-chip')
    if(!chip){chip=document.createElement('button');chip.type='button';chip.className='wfh-v2722-grade-chip';cell.insertBefore(chip,idButton);chip.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();const employee=upper(chip.dataset.employee);resetErrorFilters({keepId:employee});buttonByText(originalErrorParts().order,'全部')?.click();setTimeout(triggerErrorQuery,30)})}
    chip.dataset.employee=id;chip.dataset.grade=label;chip.textContent=label;chip.title=`${id} · 点击查看这个员工的全部错误`
    idButton.title=`${id} · 点击打开员工档案`
  }
}

function ensureChartTip(){let tip=document.querySelector('.wfh-v2722-chart-tip');if(!tip){tip=document.createElement('div');tip.className='wfh-v2722-chart-tip';document.body.appendChild(tip)}return tip}
function bindTip(el,label){if(el.dataset.wfhV2722Tip===label)return;el.dataset.wfhV2722Tip=label;const tip=ensureChartTip();el.addEventListener('mouseenter',()=>{tip.textContent=label;tip.style.display='block'});el.addEventListener('mousemove',e=>{tip.style.left=`${e.clientX+14}px`;tip.style.top=`${e.clientY+14}px`});el.addEventListener('mouseleave',()=>{tip.style.display='none'})}
function patchChartTooltips(){
  const position=document.querySelector('.wfh-original-position-chart')
  if(position){const src=[...(position.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}));position.querySelectorAll('circle[data-i]').forEach(el=>{const x=src[Number(el.dataset.i)];if(x)bindTip(el,`${x.name} · ${x.count} 人`)})}
  const team=document.querySelector('.wfh-original-team-chart')
  if(team){const src=[...(team.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}));team.querySelectorAll('rect[data-i]').forEach(el=>{const x=src[Number(el.dataset.i)];if(x)bindTip(el,`${x.name} · ${x.count} 人`)})}
}

function triggerEmployeeReload(){const refresh=document.querySelector('.employee-refresh-action');if(refresh){refresh.click();return}const id=document.querySelector('.employee-core-search-grid input[placeholder*="员工ID"]');if(id)nativeSet(id,id.value,'input')}
function ensureEmployeeRiskFilter(){
  const grid=document.querySelector('.employee-core-search-grid');if(!grid)return
  if(grid.querySelector('[data-native-risk-filter="1"]')){grid.querySelectorAll('.wfh-v2722-employee-risk-filter').forEach(box=>box.remove());return}
  let box=grid.querySelector('.wfh-v2722-employee-risk-filter')
  if(!box){box=document.createElement('label');box.className='pro-filter-field wfh-v2722-employee-risk-filter';const title=document.createElement('span');title.textContent='等级';const sel=document.createElement('select');sel.innerHTML=employeeGradeChoices.map(([v,l])=>`<option value="${v}">${l}</option>`).join('');sel.value=employeeRisk;sel.addEventListener('change',()=>{employeeRisk=text(sel.value);triggerEmployeeReload()});box.append(title,sel);grid.insertBefore(box,grid.firstChild)}
  const sel=box.querySelector('select');if(sel&&document.activeElement!==sel)sel.value=employeeRisk
}
function removeFinalEmployeeRiskColumn(){
  for(const table of document.querySelectorAll('.employee-master-table')){
    const head=table.querySelector('thead tr'),finalHead=head?.querySelector(':scope > .wfh-v2722-risk-head')
    const index=finalHead?[...head.children].indexOf(finalHead):-1
    finalHead?.remove()
    if(index>=0)for(const row of table.querySelectorAll('tbody tr'))row.children[index]?.remove()
    else for(const cell of table.querySelectorAll('tbody .wfh-v2722-risk-cell'))cell.remove()
  }
}
async function ensureEmployeeRiskColumn(){
  const table=document.querySelector('.employee-master-table');if(!table)return
  const map=await getSummary(),head=table.querySelector('thead tr')
  if(head&&!head.querySelector('.wfh-v2722-risk-head')&&!head.querySelector('.wfh-risk-head')){const th=document.createElement('th');th.className='wfh-v2722-risk-head';th.textContent='等级';head.insertBefore(th,head.firstChild)}
  for(const tr of table.querySelectorAll('tbody tr')){
    if(tr.querySelector('.wfh-risk-cell'))continue
    let cell=tr.querySelector('.wfh-v2722-risk-cell')
    if(!cell){cell=document.createElement('td');cell.className='wfh-v2722-risk-cell';tr.insertBefore(cell,tr.firstChild)}
    const idCell=cell.nextElementSibling,id=upper(idCell?.textContent);if(!id)continue
    const name=text(idCell?.nextElementSibling?.textContent),s=map.get(id),label=employeeRiskLabel(employeeRiskKey(s?.total_error_count||0));let chip=cell.querySelector('.wfh-v2722-employee-chip')
    if(!chip||chip.tagName!=='BUTTON'){
      const next=document.createElement('button');next.type='button';next.className='wfh-v2722-employee-chip';chip?.replaceWith(next);if(!chip)cell.appendChild(next);chip=next
      chip.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const employeeId=upper(chip.dataset.employee);if(employeeId)openEmployeeErrorHistory(employeeId,chip.dataset.name||employeeId,map.get(employeeId)||{})})
    }
    chip.dataset.employee=id;chip.dataset.name=name;chip.dataset.grade=label;chip.textContent=label;chip.disabled=Number(s?.total_error_count||0)===0;chip.title=`累计 ${Number(s?.total_error_count||0)} · 本月 ${Number(s?.month_error_count||0)} · 近30天 ${Number(s?.last_30d_error_count||0)}${Number(s?.total_error_count||0)>0?' · 点击查看错误记录':''}`
  }
}

async function injectDrawerRisk(){
  for(const drawer of document.querySelectorAll('.employee-detail-drawer')){
    const id=upper(drawer.querySelector('.employee-id-line')?.textContent);if(!id||id.includes('读取'))continue
    if(drawer.querySelector('.wfh-v2722-risk-summary[data-profile-metrics="1"]'))continue
    drawer.querySelector('.profile-status-line.is-complete')?.remove()
    const map=await getSummary(),s=map.get(id)||{},isReport=drawer.closest('.wfh-v2721-employee-mask')
    const label=reportGradeLabel(reportGradeKey(s.total_error_count||0))
    let box=drawer.querySelector('.wfh-v2722-risk-summary')
    if(!box){box=document.createElement('div');box.className='wfh-v2722-risk-summary';const hero=drawer.querySelector('.employee-hero');hero?.insertAdjacentElement('afterend',box)}
    if(!box)continue
    box.dataset.grade=label
    const metric=(title,value,className='')=>{const item=document.createElement('div');if(className)item.className=className;const caption=document.createElement('span');caption.textContent=title;const strong=document.createElement('strong');strong.textContent=value;item.append(caption,strong);return{item,strong}}
    const grade=metric('等级',label,'risk-grade')
    const month=metric('本月错误',`${Number(s.month_error_count||0)} 笔`)
    const recent=metric('近30天错误',`${Number(s.last_30d_error_count||0)} 笔`)
    const total=metric('总错误',`${Number(s.total_error_count||0)} 笔`)
    const mainType=text(s.main_error_type),lastDate=text(s.last_error_date).slice(0,10)
    const main=metric('主要错误 / 最近错误',`${mainType||'—'}${lastDate?` · ${lastDate}`:''}`)
    main.strong.title=mainType
    box.replaceChildren(grade.item,month.item,recent.item,total.item,main.item)
  }
}

function forceReportRefreshOnce(){if(!isReports()||forceReportReloaded||!errorCard())return;const count=text(errorCard()?.querySelector('.rp-card-title>span')?.textContent);if(count&&!count.includes('读取')){forceReportReloaded=true;reportCache.at=0;setTimeout(triggerErrorQuery,30)}}

async function run(){
  if(stopped)return;scheduled=false
  if(isReports()){
    if(document.querySelector('.rp-errors-table[data-native-errors-v2723]')){patchChartTooltips();return}
    ensureErrorFilters();forceReportRefreshOnce();patchChartTooltips();await decorateReportGrades();await injectDrawerRisk();return
  }
  document.querySelector('.rp-filterbar')?.style.removeProperty('display')
  if(isEmployees()){
    ensureEmployeeRiskFilter()
    if(window.__WFH_STABLE_ERROR_UI__)removeFinalEmployeeRiskColumn();else await ensureEmployeeRiskColumn()
    await injectDrawerRisk();return
  }
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,90)}
export function startAdminFinalV2722(){
  if(window.__WFH_ADMIN_FINAL_V2722__)return
  window.__WFH_ADMIN_FINAL_V2722__=true
  addStyles();patchInvoke()
  const obs=new MutationObserver(schedule);obs.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  schedule();window.addEventListener('beforeunload',()=>{stopped=true;obs.disconnect()},{once:true})
}
