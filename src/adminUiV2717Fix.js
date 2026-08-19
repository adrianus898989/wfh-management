import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const gradeChoices=[
  ['', '全部等级'],
  ['excellent','优秀（0错误）'],
  ['normal','正常（1–8）'],
  ['attention','注意（9–15）'],
  ['watch','重点（16–30）'],
  ['high','高频（31+）'],
]
const gradeMeta={
  excellent:{label:'优秀',range:'0 错误',color:'#168a63',bg:'#ecfdf5',border:'#a7f3d0'},
  normal:{label:'正常',range:'1–8',color:'#2563a8',bg:'#eff6ff',border:'#bfdbfe'},
  attention:{label:'注意',range:'9–15',color:'#a16207',bg:'#fffbeb',border:'#fde68a'},
  watch:{label:'重点',range:'16–30',color:'#c2410c',bg:'#fff7ed',border:'#fed7aa'},
  high:{label:'高频',range:'31+',color:'#b42334',bg:'#fff1f2',border:'#fecdd3'},
}
const gradeKey=value=>{const n=Number(value||0);return n>=31?'high':n>=16?'watch':n>=9?'attention':n>=1?'normal':'excellent'}

let stopped=false,scheduled=false,errorGrade=''
let summaryCache={at:0,map:new Map()}

function addStyles(){
  if(document.getElementById('wfh-admin-ui-v2717-fix'))return
  const s=document.createElement('style')
  s.id='wfh-admin-ui-v2717-fix'
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

    /* Error filters: two compact, balanced rows with the same visual language as employee archive. */
    .wfh-error-unified{padding:10px 11px!important;gap:8px!important}
    .wfh-error-primary{gap:8px!important;align-items:end!important}
    .wfh-error-advanced{gap:8px!important;align-items:end!important;padding-top:8px!important}
    .wfh-error-grade-slot{display:none!important}
    .wfh-v2717-error-grade{display:grid!important;gap:4px!important;min-width:0!important}
    .wfh-v2717-error-grade>span{font-size:9px!important;font-weight:750!important;color:#6d8098!important}
    .wfh-v2717-grade-picker{position:relative!important;min-width:0!important;width:100%!important}
    .wfh-v2717-grade-trigger{width:100%!important;height:34px!important;border:1px solid #d5e0ec!important;border-radius:8px!important;background:#fff!important;color:#294561!important;padding:0 30px 0 10px!important;font-size:10px!important;font-weight:800!important;text-align:left!important;cursor:pointer!important;position:relative!important;box-shadow:0 1px 2px rgba(26,52,84,.03)!important}
    .wfh-v2717-grade-trigger:after{content:'⌄';position:absolute;right:10px;top:50%;transform:translateY(-55%);color:#6f8298;font-size:13px}
    .wfh-v2717-grade-picker.open .wfh-v2717-grade-trigger{border-color:#4b83dd!important;box-shadow:0 0 0 3px rgba(47,111,216,.10)!important}
    .wfh-v2717-grade-menu{display:none;position:absolute;z-index:9500;left:0;top:calc(100% + 5px);min-width:188px;padding:6px;border:1px solid #dbe5ef;border-radius:10px;background:#fff;box-shadow:0 16px 40px rgba(18,42,72,.18)}
    .wfh-v2717-grade-picker.open .wfh-v2717-grade-menu{display:grid;gap:3px}
    .wfh-v2717-grade-menu button{height:32px!important;border:0!important;border-radius:7px!important;background:#fff!important;color:#35516f!important;padding:0 9px!important;text-align:left!important;font-size:10px!important;font-weight:750!important;cursor:pointer!important}
    .wfh-v2717-grade-menu button:hover{background:#f2f7fd!important}
    .wfh-v2717-grade-menu button.active{background:#eaf2ff!important;color:#145bcf!important}
    .wfh-v2717-grade-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--grade-color,#71849a)}

    @media(min-width:1400px){
      .wfh-error-primary{grid-template-columns:minmax(205px,1.35fr) 138px 138px minmax(160px,.95fr) minmax(148px,.85fr) repeat(5,auto)!important}
      .wfh-error-advanced{grid-template-columns:140px repeat(6,minmax(108px,1fr)) minmax(128px,1fr) auto!important}
    }

    /* Restore the full error table and balance widths. */
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
  `
  document.head.appendChild(s)
}

function queryButton(){
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  const order=card?.querySelector('.rp-order-toolbar')
  return [...(order?.querySelectorAll('button')||[])].find(b=>text(b.textContent)==='查询')||null
}

function patchInvoke(){
  if(supabase.functions.__wfhV2717GradePatched)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    if(name==='admin-reports'&&body.action==='errors'&&errorGrade){
      return prior('admin-report-errors',{...options,body:{...body,risk_level:errorGrade}})
    }
    if(name==='admin-report-errors'){
      return prior(name,{...options,body:{...body,risk_level:errorGrade||body.risk_level||''}})
    }
    return prior(name,options)
  }
  supabase.functions.__wfhV2717GradePatched=true
}

function renderGradePicker(root){
  const trigger=root.querySelector('.wfh-v2717-grade-trigger')
  const chosen=gradeChoices.find(x=>x[0]===errorGrade)||gradeChoices[0]
  const meta=gradeMeta[errorGrade]
  trigger.innerHTML=`${meta?`<i class="wfh-v2717-grade-dot" style="--grade-color:${meta.color}"></i>`:''}${chosen[1]}`
  root.querySelectorAll('.wfh-v2717-grade-menu button').forEach(b=>b.classList.toggle('active',b.dataset.key===errorGrade))
}

function ensureErrorGradePicker(){
  const advanced=document.querySelector('.wfh-error-unified .wfh-error-advanced')
  if(!advanced)return
  let field=advanced.querySelector(':scope > .wfh-v2717-error-grade')
  if(!field){
    field=document.createElement('label');field.className='wfh-v2717-error-grade'
    const title=document.createElement('span');title.textContent='等级'
    const picker=document.createElement('div');picker.className='wfh-v2717-grade-picker'
    const trigger=document.createElement('button');trigger.type='button';trigger.className='wfh-v2717-grade-trigger'
    const menu=document.createElement('div');menu.className='wfh-v2717-grade-menu'
    for(const [key,label] of gradeChoices){
      const b=document.createElement('button');b.type='button';b.dataset.key=key;b.textContent=label
      b.addEventListener('click',e=>{
        e.preventDefault();e.stopPropagation();errorGrade=key;picker.classList.remove('open');renderGradePicker(picker)
        setTimeout(()=>queryButton()?.click(),0)
      })
      menu.appendChild(b)
    }
    trigger.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();document.querySelectorAll('.wfh-v2717-grade-picker.open').forEach(x=>{if(x!==picker)x.classList.remove('open')});picker.classList.toggle('open')})
    picker.append(trigger,menu);field.append(title,picker);advanced.insertBefore(field,advanced.firstChild)
  }
  renderGradePicker(field.querySelector('.wfh-v2717-grade-picker'))
}

async function getSummaryMap(force=false){
  if(!force&&Date.now()-summaryCache.at<15000&&summaryCache.map.size)return summaryCache.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count,last_30d_error_count,total_error_count').limit(5000)
  if(!error)summaryCache={at:Date.now(),map:new Map((data||[]).map(r=>[upper(r.employee_no),r]))}
  return summaryCache.map
}

async function regradeErrorTable(){
  const table=document.querySelector('.rp-errors-table')
  if(!table)return
  const map=await getSummaryMap()
  const head=table.querySelector('.wfh-risk-head')
  if(head){head.textContent='等级';head.title='优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+'}
  for(const tr of table.querySelectorAll('tbody tr')){
    const cell=tr.querySelector(':scope > .wfh-risk-cell')
    if(!cell)continue
    const chip=cell.querySelector('.wfh-stable-risk')
    const idCell=cell.nextElementSibling
    const id=upper(idCell?.querySelector('button')?.textContent||idCell?.textContent)
    if(!chip||!id)continue
    const summary=map.get(id)||null
    const n=Number(summary?.month_error_count||0),key=gradeKey(n),meta=gradeMeta[key]
    chip.textContent=meta.label
    chip.title=`${meta.label} · ${meta.range} · 本月 ${n} 笔 · 近30天 ${Number(summary?.last_30d_error_count||0)} 笔 · 累计 ${Number(summary?.total_error_count||0)} 笔`
    chip.dataset.key=key;chip.dataset.count=String(n)
    chip.style.setProperty('--risk-color',meta.color);chip.style.setProperty('--risk-bg',meta.bg);chip.style.setProperty('--risk-border',meta.border)
  }
}

function onClick(e){
  if(!e.target.closest('.wfh-v2717-grade-picker'))document.querySelectorAll('.wfh-v2717-grade-picker.open').forEach(x=>x.classList.remove('open'))
  const b=e.target.closest('button')
  if(!b)return
  if(text(b.textContent)==='重置'&&b.closest('.wfh-error-unified')){
    errorGrade=''
    setTimeout(()=>{ensureErrorGradePicker();queryButton()?.click()},0)
  }
}

async function run(){
  if(stopped)return
  scheduled=false
  ensureErrorGradePicker()
  await regradeErrorTable()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,90)}

export function startAdminUiV2717Fix(){
  if(window.__WFH_ADMIN_UI_V2717_FIX__)return
  window.__WFH_ADMIN_UI_V2717_FIX__=true
  addStyles();patchInvoke();document.addEventListener('click',onClick,true)
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{summaryCache.at=0;schedule()},15000)
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('click',onClick,true)},{once:true})
}
