import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
let stopped=false,scheduled=false,errorRiskLevel='',employeeAutoOpened=''

const errorRiskChoices=[
  ['', '全部等级'],
  ['excellent','优秀（0错误）'],
  ['normal','正常（1–8）'],
  ['attention','注意（9–15）'],
  ['watch','重点（16–30）'],
  ['high','高频（31+）'],
]

function addStyles(){
  if(document.getElementById('wfh-admin-ui-v2719-fix'))return
  document.getElementById('wfh-admin-ui-v2718-fix')?.remove()
  document.getElementById('wfh-admin-ui-v2717-fix')?.remove()
  const s=document.createElement('style')
  s.id='wfh-admin-ui-v2719-fix'
  s.textContent=`
    /* Keep employee analysis / resignation filters dense and aligned on desktop. */
    @media(min-width:1400px){
      .employee-page .people-filter-grid{
        display:grid!important;
        grid-template-columns:112px 132px 138px 152px 152px 152px 136px minmax(245px,1fr) 70px!important;
        gap:8px!important;
        align-items:end!important;
      }
      .employee-page .people-filter-actions{
        grid-column:auto!important;
        display:flex!important;
        align-items:end!important;
        justify-content:flex-end!important;
        align-self:end!important;
        min-height:34px!important;
        margin:0!important;
        padding:0!important;
        border:0!important;
      }
      .employee-page .people-filter-actions button{height:34px!important;min-width:68px!important;padding:0 11px!important}

      .employee-page .resignation-card-pro .v25-resignation-filter-panel{
        display:grid!important;
        grid-template-columns:108px 138px 158px 158px 148px minmax(178px,.9fr) minmax(250px,1.18fr) 136px!important;
        gap:8px!important;
        align-items:end!important;
        padding:10px 12px!important;
      }
      .employee-page .resignation-card-pro .v25-resign-reason,
      .employee-page .resignation-card-pro .v25-resign-date,
      .employee-page .resignation-card-pro .v25-resign-actions{
        grid-column:auto!important;
        grid-row:auto!important;
      }
      .employee-page .resignation-card-pro .v25-resign-actions{
        display:flex!important;
        justify-content:flex-end!important;
        align-items:end!important;
        gap:6px!important;
        min-height:34px!important;
        margin:0!important;
        padding:0!important;
        border:0!important;
        white-space:nowrap!important;
      }
      .employee-page .resignation-card-pro .v25-resign-actions button{height:34px!important;min-width:64px!important;padding:0 10px!important}
    }

    /* Error filters: compact, aligned, separate ID/name, grade included without wasting a row. */
    .wfh-error-unified{padding:10px 11px!important;gap:8px!important}
    .wfh-error-primary{gap:8px!important;align-items:end!important}
    .wfh-error-advanced{gap:8px!important;align-items:end!important;padding-top:8px!important}
    .wfh-error-original-employee{display:none!important}
    .wfh-v2717-error-grade{display:none!important}
    .wfh-error-search-id,.wfh-error-search-name{min-width:0!important;width:100%!important}
    .wfh-error-risk-filter{min-width:0!important;width:100%!important;font-weight:750!important}
    @media(min-width:1400px){
      .wfh-error-primary{grid-template-columns:120px 158px 138px 138px minmax(160px,1fr) minmax(145px,.9fr) repeat(5,auto)!important}
      .wfh-error-advanced{grid-template-columns:132px repeat(7,minmax(104px,1fr)) auto!important}
    }
    @media(max-width:1399px) and (min-width:1060px){
      .wfh-error-primary{grid-template-columns:repeat(6,minmax(120px,1fr))!important}
      .wfh-error-advanced{grid-template-columns:repeat(5,minmax(120px,1fr))!important}
    }

    /* Error table: restore all original detail columns and keep balanced widths. */
    .rp-errors-scroll{overflow-x:auto!important}
    .rp-errors-table{width:100%!important;min-width:1400px!important;table-layout:fixed!important}
    .rp-errors-table .wfh-hide-error-col{display:table-cell!important}
    .rp-errors-table th,.rp-errors-table td{padding:8px 7px!important;font-size:10px!important;vertical-align:middle!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
    .rp-errors-table th:nth-child(1),.rp-errors-table td:nth-child(1){width:62px!important}
    .rp-errors-table th:nth-child(2),.rp-errors-table td:nth-child(2){width:92px!important}
    .rp-errors-table th:nth-child(3),.rp-errors-table td:nth-child(3){width:150px!important}
    .rp-errors-table th:nth-child(4),.rp-errors-table td:nth-child(4){width:80px!important}
    .rp-errors-table th:nth-child(5),.rp-errors-table td:nth-child(5){width:72px!important}
    .rp-errors-table th:nth-child(6),.rp-errors-table td:nth-child(6){width:138px!important}
    .rp-errors-table th:nth-child(7),.rp-errors-table td:nth-child(7){width:160px!important}
    .rp-errors-table th:nth-child(8),.rp-errors-table td:nth-child(8){width:56px!important;text-align:center!important}
    .rp-errors-table th:nth-child(9),.rp-errors-table td:nth-child(9){width:92px!important}
    .rp-errors-table th:nth-child(10),.rp-errors-table td:nth-child(10){width:96px!important}
    .rp-errors-table th:nth-child(11),.rp-errors-table td:nth-child(11){width:118px!important}
    .rp-errors-table th:nth-child(12),.rp-errors-table td:nth-child(12){width:105px!important}
    .rp-errors-table th:nth-child(13),.rp-errors-table td:nth-child(13){width:96px!important}
    .rp-errors-table th:nth-child(14),.rp-errors-table td:nth-child(14){width:78px!important;max-width:78px!important}
    .rp-errors-table td:nth-child(3){font-weight:650!important;color:#2b4564!important}
    .rp-errors-table .rp-cell-clamp{max-width:100%!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}

    /* Order statistics: while scrolling right, always keep hire date + employee ID + name visible. */
    .rp-order-scroll{position:relative!important;overflow:auto!important}
    .rp-order-table{border-collapse:separate!important;border-spacing:0!important}
    .rp-order-table th:nth-child(1),.rp-order-table td:nth-child(1){
      position:sticky!important;left:0!important;z-index:5!important;
      width:104px!important;min-width:104px!important;max-width:104px!important;
      background:#fff!important;
    }
    .rp-order-table th:nth-child(2),.rp-order-table td:nth-child(2){
      position:sticky!important;left:104px!important;z-index:5!important;
      width:104px!important;min-width:104px!important;max-width:104px!important;
      background:#fff!important;
    }
    .rp-order-table th:nth-child(3),.rp-order-table td:nth-child(3){
      position:sticky!important;left:208px!important;z-index:5!important;
      width:190px!important;min-width:190px!important;max-width:190px!important;
      background:#fff!important;
      box-shadow:8px 0 12px -12px rgba(20,48,82,.55)!important;
    }
    .rp-order-table thead th:nth-child(1),.rp-order-table thead th:nth-child(2),.rp-order-table thead th:nth-child(3){
      z-index:8!important;background:#f2f6fb!important;
    }
    .rp-order-table tbody tr:hover td:nth-child(1),.rp-order-table tbody tr:hover td:nth-child(2),.rp-order-table tbody tr:hover td:nth-child(3){background:#f8fbff!important}
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

function hasVisibleAdvancedRosterFilter(){
  const bar=document.querySelector('.rp-filterbar')
  if(!bar)return false
  const selects=[...bar.querySelectorAll('select')]
  const manager=bar.querySelector('input[list]')
  return selects.some(x=>text(x.value))||Boolean(text(manager?.value))
}

function patchInvoke(){
  if(supabase.functions.__wfhV2719ErrorTotalsPatched)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    const isErrorRequest=(name==='admin-report-errors')||(name==='admin-reports'&&body.action==='errors')
    const requestOptions=isErrorRequest&&errorRiskLevel?{...options,body:{...body,risk_level:errorRiskLevel}}:options
    const result=await prior(name,requestOptions)
    if(isErrorRequest&&result?.data&&!result?.data?.error&&!hasVisibleAdvancedRosterFilter()){
      /* Default error report is the complete Supabase error snapshot, including resigned/history staff.
         Only explicit roster filters (team/shift/group/position/country/manager/platform) narrow it to roster. */
      return {...result,data:{...result.data,current_roster_employee_count:0}}
    }
    return result
  }
  supabase.functions.__wfhV2719ErrorTotalsPatched=true
}

function originalErrorParts(){
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  return {card,order:card?.querySelector('.rp-order-toolbar'),local:card?.querySelector('.rp-error-filters'),global:document.querySelector('.rp-filterbar')}
}

function syncSplitSearch(){
  const host=document.querySelector('.wfh-error-unified')
  const original=host?.querySelector('input[data-role="employee"]')
  if(!original)return
  const id=text(host.querySelector('.wfh-error-search-id')?.value)
  const name=text(host.querySelector('.wfh-error-search-name')?.value)
  const combined=[id,name].filter(Boolean).join(' ')
  original.value=combined
  original.dispatchEvent(new Event('input',{bubbles:true}))
}

function ensureErrorSearchFields(){
  const host=document.querySelector('.wfh-error-unified')
  const primary=host?.querySelector('.wfh-error-primary')
  const original=primary?.querySelector('input[data-role="employee"]')
  if(!primary||!original)return
  original.classList.add('wfh-error-original-employee')
  let idInput=primary.querySelector('.wfh-error-search-id')
  let nameInput=primary.querySelector('.wfh-error-search-name')
  if(!idInput){
    idInput=document.createElement('input')
    idInput.className='wfh-error-search-id'
    idInput.placeholder='输入员工ID'
    idInput.autocomplete='off'
    idInput.addEventListener('input',syncSplitSearch)
    primary.insertBefore(idInput,original)
  }
  if(!nameInput){
    nameInput=document.createElement('input')
    nameInput.className='wfh-error-search-name'
    nameInput.placeholder='输入姓名'
    nameInput.autocomplete='off'
    nameInput.addEventListener('input',syncSplitSearch)
    primary.insertBefore(nameInput,original)
  }
  const source=text(original.value)
  if(document.activeElement!==idInput&&document.activeElement!==nameInput){
    if(!source){idInput.value='';nameInput.value=''}
    else if(!text(idInput.value)&&!text(nameInput.value)){
      const parts=source.split(/\s+/)
      if(/^[A-Z]{1,5}\d+/i.test(parts[0]||'')){idInput.value=parts.shift()||'';nameInput.value=parts.join(' ')}
      else nameInput.value=source
    }
  }
}

function clickOriginalErrorQuery(){
  const {order}=originalErrorParts()
  buttonByText(order,'查询')?.click()
}

function ensureErrorGradeFilter(){
  const host=document.querySelector('.wfh-error-unified')
  const advanced=host?.querySelector('.wfh-error-advanced')
  if(!advanced)return
  let select=advanced.querySelector('.wfh-error-risk-filter')
  if(!select){
    select=document.createElement('select')
    select.className='wfh-error-risk-filter'
    select.title='等级：优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+'
    select.innerHTML=errorRiskChoices.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')
    select.value=errorRiskLevel
    select.addEventListener('change',()=>{
      errorRiskLevel=text(select.value)
      clickOriginalErrorQuery()
    })
    advanced.insertBefore(select,advanced.firstChild)
  }
  if(document.activeElement!==select&&select.value!==errorRiskLevel)select.value=errorRiskLevel

  const reset=buttonByText(host,'重置')
  if(reset&&!reset.dataset.wfhRiskReset){
    reset.dataset.wfhRiskReset='1'
    reset.addEventListener('click',()=>{
      errorRiskLevel=''
      const grade=document.querySelector('.wfh-error-risk-filter')
      if(grade)grade.value=''
      const id=document.querySelector('.wfh-error-search-id'),name=document.querySelector('.wfh-error-search-name')
      if(id)id.value='';if(name)name.value=''
    },true)
  }
}

function fixErrorLoadingCount(){
  const {card}=originalErrorParts()
  if(!card)return
  const count=card.querySelector('.rp-card-title > span')
  const loading=card.querySelector('.rp-loading-inline')
  if(count&&loading&&/^0\s*条$/.test(text(count.textContent)))count.textContent='读取中…'
}

function employeeRouteFor(id){
  const current=window.location.pathname
  const base=current.includes('/admin/')?current.replace(/\/admin\/[^/?#]+.*$/,'/admin/employees'):'/wfh-management/admin/employees'
  return `${base}?employee_no=${encodeURIComponent(id)}`
}
function openEmployeeArchive(id){
  const value=upper(id)
  if(!value)return
  try{sessionStorage.setItem('wfh-open-employee-no',value)}catch{}
  window.location.assign(employeeRouteFor(value))
}

function ensureErrorIdLinks(){
  const table=document.querySelector('.rp-errors-table')
  if(!table)return
  if(table.matches('[data-native-errors-v2723]'))return
  for(const tr of table.querySelectorAll('tbody tr')){
    const buttons=[...tr.querySelectorAll('button.rp-link')]
    const btn=buttons.find(b=>/^[A-Z]{1,6}\d+/i.test(text(b.textContent)))
    if(!btn||btn.dataset.wfhEmployeeArchiveLink)return
    btn.dataset.wfhEmployeeArchiveLink='1'
    btn.title='打开员工档案'
    btn.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()
      openEmployeeArchive(text(btn.textContent))
    },true)
  }
}

function findEmployeeStatusSelect(){
  for(const label of document.querySelectorAll('.employee-page label')){
    const caption=text(label.querySelector(':scope > span')?.textContent)
    const select=label.querySelector('select')
    if(select&&caption==='状态')return select
  }
  return null
}
function cleanEmployeeTarget(){
  try{sessionStorage.removeItem('wfh-open-employee-no')}catch{}
  const u=new URL(window.location.href)
  u.searchParams.delete('employee_no')
  window.history.replaceState(window.history.state,'',`${u.pathname}${u.search}${u.hash}`)
}
function openEmployeeFromQuery(){
  if(!/\/admin\/employees\/?$/.test(window.location.pathname))return
  const urlTarget=upper(new URLSearchParams(window.location.search).get('employee_no'))
  let stored='';try{stored=upper(sessionStorage.getItem('wfh-open-employee-no'))}catch{}
  const target=urlTarget||stored
  if(!target||employeeAutoOpened===target)return

  const idInput=document.querySelector('.employee-core-search-grid input[placeholder*="员工ID"]')
  if(idInput&&idInput.dataset.wfhAutoTarget!==target){
    idInput.dataset.wfhAutoTarget=target
    const status=findEmployeeStatusSelect()
    if(status&&status.value!=='')nativeSet(status,'','change')
    nativeSet(idInput,target,'input')
    idInput.blur()
    return
  }

  const table=document.querySelector('.employee-master-table')
  if(!table)return
  const row=[...table.querySelectorAll('tbody tr')].find(tr=>{
    const cells=[...tr.children].map(td=>upper(td.textContent))
    return cells.some(v=>v===target)
  })
  const view=row?[...row.querySelectorAll('button')].find(b=>text(b.textContent)==='查看'):null
  if(view){
    employeeAutoOpened=target
    cleanEmployeeTarget()
    view.click()
  }
}

function cleanupLegacyGrade(){
  document.querySelectorAll('.wfh-v2717-error-grade').forEach(x=>x.remove())
}

function run(){
  if(stopped)return
  scheduled=false
  cleanupLegacyGrade()
  ensureErrorSearchFields()
  ensureErrorGradeFilter()
  fixErrorLoadingCount()
  ensureErrorIdLinks()
  openEmployeeFromQuery()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,80)}

export function startAdminUiV2717Fix(){
  if(window.__WFH_ADMIN_UI_V2719_FIX__)return
  window.__WFH_ADMIN_UI_V2719_FIX__=true
  addStyles();patchInvoke()
  const observer=new MutationObserver(schedule)
  observer.observe(document.body,{subtree:true,childList:true})
  const timer=setInterval(schedule,600)
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect()},{once:true})
}
