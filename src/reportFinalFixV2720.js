import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const GRADE_CHOICES=[
  ['', '全部等级'],
  ['excellent','优秀（0错误）'],
  ['normal','正常（1–8）'],
  ['attention','注意（9–15）'],
  ['watch','重点（16–30）'],
  ['high','高频（31+）'],
]
const gradeKey=n=>{n=Number(n||0);if(n>=31)return'high';if(n>=16)return'watch';if(n>=9)return'attention';if(n>=1)return'normal';return'excellent'}
let stopped=false,scheduled=false,errorGrade=''
let summaryCache={at:0,map:new Map()}
let errorCache={at:0,key:'',data:null}

function addStyles(){
  if(document.getElementById('wfh-report-final-v2720-style'))return
  const s=document.createElement('style')
  s.id='wfh-report-final-v2720-style'
  s.textContent=`
    .wfh-error-final-grade{height:34px!important;min-width:0!important;width:100%!important;border:1px solid #d5dfeb!important;border-radius:8px!important;background:#fff!important;padding:0 9px!important;color:#314b68!important;font-size:10px!important;font-weight:750!important}
    .wfh-employee-preview-mask{position:fixed;inset:0;z-index:3400;background:rgba(14,29,49,.58);display:flex;align-items:center;justify-content:center;padding:24px}
    .wfh-employee-preview{width:min(980px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:15px;overflow:hidden;box-shadow:0 28px 90px rgba(7,23,46,.35)}
    .wfh-employee-preview header{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid #e5ecf4}.wfh-employee-preview header span{display:block;font-size:9px;letter-spacing:2px;color:#8191a7;font-weight:800}.wfh-employee-preview header h3{margin:4px 0 0;font-size:18px;color:#203a5b}.wfh-employee-preview header button{width:34px;height:34px;border:0;border-radius:9px;background:#eef3f8;color:#667b95;font-size:20px;cursor:pointer}
    .wfh-employee-preview-body{overflow:auto;padding:16px 18px 20px}.wfh-employee-preview-loading{padding:40px;text-align:center;color:#70849d;font-weight:700}
    .wfh-employee-profile-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.wfh-employee-profile-grid>div{padding:10px 12px;border:1px solid #dce5f0;border-radius:10px;background:#fbfdff;min-width:0}.wfh-employee-profile-grid>div.wide{grid-column:1/-1}.wfh-employee-profile-grid span{display:block;font-size:9px;color:#7b8da5;font-weight:750;margin-bottom:5px}.wfh-employee-profile-grid strong,.wfh-employee-profile-grid p{margin:0;color:#2c4564;font-size:11px;line-height:1.5;word-break:break-word}.wfh-employee-profile-grid strong{font-size:12px}
    @media(max-width:760px){.wfh-employee-profile-grid{grid-template-columns:1fr 1fr}}
  `
  document.head.appendChild(s)
}

async function getSummaryMap(force=false){
  if(!force&&Date.now()-summaryCache.at<30000&&summaryCache.map.size)return summaryCache.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count,last_30d_error_count,total_error_count').limit(5000)
  if(!error)summaryCache={at:Date.now(),map:new Map((data||[]).map(r=>[upper(r.employee_no),r]))}
  return summaryCache.map
}

function advancedRosterFilterActive(){
  const bar=document.querySelector('.rp-filterbar')
  if(!bar)return false
  const selects=[...bar.querySelectorAll('select')]
  const manager=bar.querySelector('input[list]')
  const search=bar.querySelector('.rp-search')
  return selects.some(x=>text(x.value))||Boolean(text(manager?.value))||Boolean(text(search?.value))
}

function patchInvoke(){
  if(supabase.functions.__wfhReportFinalV2720)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    const isErrors=(name==='admin-report-errors')||(name==='admin-reports'&&body.action==='errors')
    if(!isErrors)return prior(name,options)

    const baseBody={...body}
    delete baseBody.risk_level
    const key=JSON.stringify({name:'errors',body:baseBody})
    let rawData=null
    if(errorCache.data&&errorCache.key===key&&Date.now()-errorCache.at<20000){
      rawData=errorCache.data
    }else{
      const result=await prior('admin-report-errors',{...options,body:baseBody})
      if(result?.error||result?.data?.error)return result
      rawData=result?.data||{}
      errorCache={at:Date.now(),key,data:rawData}
    }

    let rows=Array.isArray(rawData?.rows)?rawData.rows:[]
    const activeGrade=text(errorGrade||body.risk_level)
    if(activeGrade){
      const map=await getSummaryMap()
      rows=rows.filter(r=>gradeKey(map.get(upper(r.employee_id))?.month_error_count||0)===activeGrade)
    }
    const data={...rawData,rows,risk_level:activeGrade,current_roster_employee_count:advancedRosterFilterActive()?rawData.current_roster_employee_count:0}
    return {data,error:null}
  }
  supabase.functions.__wfhReportFinalV2720=true
}

function isGradeSelect(sel){
  const labels=[...sel.options].map(o=>text(o.textContent)).join('|')
  return labels.includes('优秀')&&labels.includes('高频')
}
function clickErrorQuery(){
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  const toolbar=card?.querySelector('.rp-order-toolbar')
  const btn=[...(toolbar?.querySelectorAll('button')||[])].find(b=>text(b.textContent)==='查询')
  btn?.click()
}
function ensureGradeFilter(){
  const host=document.querySelector('.wfh-error-unified')
  const advanced=host?.querySelector('.wfh-error-advanced')
  if(!advanced)return
  const gradeSelects=[...advanced.querySelectorAll('select')].filter(isGradeSelect)
  let select=advanced.querySelector('.wfh-error-final-grade')
  if(!select){
    select=document.createElement('select')
    select.className='wfh-error-final-grade'
    select.innerHTML=GRADE_CHOICES.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')
    select.value=errorGrade
    select.addEventListener('change',()=>{
      errorGrade=text(select.value)
      window.__WFH_ERROR_RISK_LEVEL__=errorGrade
      setTimeout(clickErrorQuery,0)
    })
    advanced.insertBefore(select,advanced.firstChild)
  }
  for(const other of gradeSelects)if(other!==select)other.remove()
  if(document.activeElement!==select&&select.value!==errorGrade)select.value=errorGrade

  const reset=[...host.querySelectorAll('button')].find(b=>text(b.textContent)==='重置')
  if(reset&&!reset.dataset.wfhFinalGradeReset){
    reset.dataset.wfhFinalGradeReset='1'
    reset.addEventListener('click',()=>{errorGrade='';window.__WFH_ERROR_RISK_LEVEL__='';if(select)select.value=''},true)
  }
}

function fixErrorCountLoading(){
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  const count=card?.querySelector('.rp-card-title > span')
  if(count&&card?.querySelector('.rp-loading-inline')&&/^0\s*条$/.test(text(count.textContent)))count.textContent='读取中…'
}

function patchChartHoverText(){
  const position=document.querySelector('.wfh-original-position-chart')
  if(position){
    const source=[...(position.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}))
    position.querySelectorAll('circle[data-i]').forEach(el=>{
      const x=source[Number(el.dataset.i)]
      if(!x)return
      let title=el.querySelector('title');if(!title){title=document.createElementNS('http://www.w3.org/2000/svg','title');el.appendChild(title)}
      title.textContent=`${x.name}：${x.count} 人`
      el.style.cursor='pointer'
    })
    position.querySelectorAll('.wfh-position-legend [data-i]').forEach(el=>{const x=source[Number(el.dataset.i)];if(x)el.title=`${x.name}：${x.count} 人`})
  }
  const team=document.querySelector('.wfh-original-team-chart')
  if(team){
    const source=[...(team.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}))
    team.querySelectorAll('rect[data-i]').forEach(el=>{
      const x=source[Number(el.dataset.i)]
      if(!x)return
      let title=el.querySelector('title');if(!title){title=document.createElementNS('http://www.w3.org/2000/svg','title');el.appendChild(title)}
      title.textContent=`${x.name} · 人数：${x.count}`
      el.style.cursor='pointer'
    })
  }
}

const esc=v=>text(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))
function closeEmployeePreview(){document.querySelector('.wfh-employee-preview-mask')?.remove()}
function field(label,value,wide=false){return `<div${wide?' class="wide"':''}><span>${esc(label)}</span><strong>${esc(value||'—')}</strong></div>`}
async function openEmployeePreview(employeeNo){
  const id=upper(employeeNo);if(!id)return
  closeEmployeePreview()
  const mask=document.createElement('div');mask.className='wfh-employee-preview-mask'
  const modal=document.createElement('div');modal.className='wfh-employee-preview'
  modal.innerHTML=`<header><div><span>EMPLOYEE PROFILE</span><h3>${esc(id)} · 员工档案</h3></div><button type="button">×</button></header><div class="wfh-employee-preview-body"><div class="wfh-employee-preview-loading">读取员工档案…</div></div>`
  mask.appendChild(modal);document.body.appendChild(mask)
  modal.querySelector('header button')?.addEventListener('click',closeEmployeePreview);mask.addEventListener('mousedown',e=>{if(e.target===mask)closeEmployeePreview()})
  const body=modal.querySelector('.wfh-employee-preview-body')
  try{
    const list=await supabase.functions.invoke('admin-employees',{body:{action:'list',page:1,page_size:20,filters:{employee_no:id,status:''}}})
    if(list.error||list.data?.error)throw new Error(list.data?.error||list.error?.message||'读取员工失败')
    const row=(list.data?.rows||[]).find(r=>upper(r.employee_no)===id)||(list.data?.rows||[])[0]
    if(!row?.id){body.innerHTML='<div class="wfh-employee-preview-loading">找不到对应员工档案</div>';return}
    const detail=await supabase.functions.invoke('admin-employees',{body:{action:'detail',employee_id:row.id}})
    if(detail.error||detail.data?.error)throw new Error(detail.data?.error||detail.error?.message||'读取员工档案失败')
    const d=detail.data||{},e=d.employee||{},c=d.contact||{},p=d.payment||{},comp=d.compensation||{}
    body.innerHTML=`<div class="wfh-employee-profile-grid">
      ${field('员工ID',e.employee_no)}${field('姓名',e.full_name)}${field('状态',e.status==='active'?'在职':e.status==='resigned'?'离职':e.status)}
      ${field('团队',e.teams?.name)}${field('岗位',e.positions?.name)}${field('员工国家',e.country||e.nationality)}
      ${field('班次',e.shift_name)}${field('员工类型',e.employment_type)}${field('入职日期',text(e.hire_date).slice(0,10))}
      ${field('离职日期',text(e.resign_date).slice(0,10))}${field('工作TG',e.work_tg)}${field('后台账号',e.backend_accounts)}
      ${field('盘口',e.platform_scope,true)}${field('Workfolio 邮箱',c.work_email)}${field('Telegram',c.telegram_username)}${field('Zoom 邮箱',c.zoom_email)}
      ${field('收款方式',p.mode)}${field('转账方式',p.transfer_using)}${field('薪资/底薪',comp.base_salary||comp.daily_rate||comp.performance_default)}
    </div>`
  }catch(err){body.innerHTML=`<div class="wfh-employee-preview-loading">${esc(err?.message||'读取员工档案失败')}</div>`}
}

function captureErrorId(e){
  const btn=e.target?.closest?.('.rp-errors-table tbody button.rp-link')
  if(!btn)return
  const id=upper(btn.textContent)
  if(!/^[A-Z]{1,6}\d+/i.test(id))return
  e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()
  openEmployeePreview(id)
}

async function run(){
  if(stopped)return
  scheduled=false
  ensureGradeFilter()
  fixErrorCountLoading()
  patchChartHoverText()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,90)}

export function startReportFinalFixV2720(){
  if(window.__WFH_REPORT_FINAL_V2720__)return
  window.__WFH_REPORT_FINAL_V2720__=true
  addStyles();patchInvoke()
  document.addEventListener('click',captureErrorId,true)
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{if(!document.hidden){summaryCache.at=0;schedule()}},30000)
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('click',captureErrorId,true)},{once:true})
}
