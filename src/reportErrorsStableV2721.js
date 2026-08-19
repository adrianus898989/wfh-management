import { supabase } from './lib/supabase'

const nativeInvoke=supabase.functions.invoke.bind(supabase.functions)
const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const gradeKey=n=>{n=Number(n||0);if(n>=31)return'high';if(n>=16)return'watch';if(n>=9)return'attention';if(n>=1)return'normal';return'excellent'}
const gradeLabel=k=>({excellent:'优秀',normal:'正常',attention:'注意',watch:'重点',high:'高频'}[k]||'优秀')
const gradeChoices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]
let riskLevel=''
let stopped=false,scheduled=false
let summaryCache={at:0,map:new Map()}
let errorCache={at:0,key:'',data:null}

function addStyles(){
  if(document.getElementById('wfh-report-errors-v2721-style'))return
  const s=document.createElement('style')
  s.id='wfh-report-errors-v2721-style'
  s.textContent=`
    /* Never show the old observer-built error toolbar/grade column on reports. */
    .reports-page .wfh-error-unified{display:none!important}
    .reports-page .rp-errors-table .wfh-risk-head,.reports-page .rp-errors-table .wfh-risk-cell{display:none!important}
    .reports-page .rp-order-toolbar{display:flex!important}
    .reports-page .rp-error-filters{display:none!important}
    .wfh-v2721-error-filter{display:grid;grid-template-columns:120px 160px 150px minmax(180px,1fr) minmax(160px,.85fr) 72px;gap:8px;align-items:end;padding:9px 12px;border-top:1px dashed #dce5f0;background:#fbfdff}
    .wfh-v2721-error-filter label{display:grid;gap:4px;min-width:0;color:#6d8098;font-size:9px;font-weight:750}
    .wfh-v2721-error-filter input,.wfh-v2721-error-filter select,.wfh-v2721-error-filter button{height:34px;min-width:0;border:1px solid #d5dfeb;border-radius:8px;background:#fff;padding:0 9px;color:#314b68;font-size:10px}
    .wfh-v2721-error-filter button{cursor:pointer;font-weight:800}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade]{display:inline-flex!important;align-items:center;gap:7px;white-space:nowrap}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade]::before{content:attr(data-wfh-grade);display:inline-flex;align-items:center;justify-content:center;height:20px;min-width:42px;padding:0 6px;border-radius:999px;border:1px solid #b8d7ff;background:#eef6ff;color:#1760b8;font-size:9px;font-weight:850}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade="优秀"]::before{border-color:#9eecc6;background:#ebfff5;color:#0a8755}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade="注意"]::before{border-color:#f5d77c;background:#fff9e8;color:#9a6500}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade="重点"]::before{border-color:#ffc28d;background:#fff4e9;color:#b24b00}
    .rp-errors-table td:first-child .rp-link[data-wfh-grade="高频"]::before{border-color:#ffb4bd;background:#fff0f2;color:#c6283e}
    .rp-errors-table th:first-child,.rp-errors-table td:first-child{min-width:150px!important;width:150px!important}
    .rp-errors-table th:nth-child(2),.rp-errors-table td:nth-child(2){min-width:175px!important;width:175px!important}
    .rp-order-scroll{position:relative!important;overflow:auto!important}.rp-order-table{border-collapse:separate!important;border-spacing:0!important}
    .rp-order-table th:nth-child(1),.rp-order-table td:nth-child(1){position:sticky!important;left:0!important;z-index:5!important;width:104px!important;min-width:104px!important;background:#fff!important}
    .rp-order-table th:nth-child(2),.rp-order-table td:nth-child(2){position:sticky!important;left:104px!important;z-index:5!important;width:190px!important;min-width:190px!important;background:#fff!important;box-shadow:8px 0 12px -12px rgba(20,48,82,.55)!important}
    .rp-order-table thead th:nth-child(1),.rp-order-table thead th:nth-child(2){z-index:8!important;background:#f2f6fb!important}
    @media(max-width:1200px){.wfh-v2721-error-filter{grid-template-columns:repeat(3,minmax(130px,1fr))}}
  `
  document.head.appendChild(s)
}

function patchInvoke(){
  if(supabase.functions.__wfhReportErrorsV2721)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    const isErrors=name==='admin-report-errors'||(name==='admin-reports'&&body.action==='errors')
    if(!isErrors)return prior(name,options)
    const requestBody={...body}
    delete requestBody.action
    requestBody.risk_level=riskLevel||text(body.risk_level)
    const key=JSON.stringify(requestBody)
    if(errorCache.data&&errorCache.key===key&&Date.now()-errorCache.at<15000)return {data:errorCache.data,error:null}
    const result=await nativeInvoke('admin-report-errors',{...options,body:requestBody})
    if(result?.error||result?.data?.error)return result
    const data={...result.data,current_roster_employee_count:0}
    errorCache={at:Date.now(),key,data}
    return {data,error:null}
  }
  supabase.functions.__wfhReportErrorsV2721=true
}

function nativeSet(el,value,eventName='input'){
  if(!el)return
  const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype
  const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set
  if(setter)setter.call(el,value);else el.value=value
  el.dispatchEvent(new Event(eventName,{bubbles:true}))
}
function errorCard(){return [...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')||null}
function queryButton(){return [...(errorCard()?.querySelector('.rp-order-toolbar')?.querySelectorAll('button')||[])].find(b=>text(b.textContent)==='查询')||null}

function ensureFilters(){
  const card=errorCard();if(!card)return
  const original=card.querySelector('.rp-error-filters');if(!original)return
  let host=card.querySelector('.wfh-v2721-error-filter')
  if(!host){
    host=document.createElement('div');host.className='wfh-v2721-error-filter'
    const mk=(ph,cls)=>{const i=document.createElement('input');i.placeholder=ph;i.className=cls;return i}
    const id=mk('输入员工ID','wfh-v2721-id'),name=mk('输入姓名','wfh-v2721-name')
    const grade=document.createElement('select');grade.className='wfh-v2721-grade';grade.innerHTML=gradeChoices.map(([v,l])=>`<option value="${v}">${l}</option>`).join('')
    const type=document.createElement('select'),qc=document.createElement('select'),reset=document.createElement('button');reset.type='button';reset.textContent='重置'
    host.append(id,name,grade,type,qc,reset);original.before(host)
    const syncSearch=()=>{const source=original.querySelector('input');nativeSet(source,[text(id.value),text(name.value)].filter(Boolean).join(' '),'input')}
    id.addEventListener('input',syncSearch);name.addEventListener('input',syncSearch)
    type.addEventListener('change',()=>nativeSet(original.querySelectorAll('select')[0],type.value,'change'))
    qc.addEventListener('change',()=>nativeSet(original.querySelectorAll('select')[1],qc.value,'change'))
    grade.addEventListener('change',()=>{riskLevel=text(grade.value);errorCache.at=0;queryButton()?.click()})
    reset.addEventListener('click',()=>{id.value='';name.value='';grade.value='';riskLevel='';errorCache.at=0;nativeSet(original.querySelector('input'),'','input');nativeSet(original.querySelectorAll('select')[0],'','change');nativeSet(original.querySelectorAll('select')[1],'','change')})
  }
  const type=host.querySelectorAll('select')[1],qc=host.querySelectorAll('select')[2]
  const src=original.querySelectorAll('select')
  if(type&&src[0]&&type.innerHTML!==src[0].innerHTML){type.innerHTML=src[0].innerHTML;type.value=src[0].value}
  if(qc&&src[1]&&qc.innerHTML!==src[1].innerHTML){qc.innerHTML=src[1].innerHTML;qc.value=src[1].value}
  const grade=host.querySelector('.wfh-v2721-grade');if(grade&&document.activeElement!==grade&&grade.value!==riskLevel)grade.value=riskLevel
}

async function getSummary(){
  if(Date.now()-summaryCache.at<30000&&summaryCache.map.size)return summaryCache.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count').limit(5000)
  if(!error)summaryCache={at:Date.now(),map:new Map((data||[]).map(r=>[upper(r.employee_no),Number(r.month_error_count||0)]))}
  return summaryCache.map
}
async function decorateGrades(){
  const table=errorCard()?.querySelector('.rp-errors-table');if(!table)return
  const map=await getSummary()
  for(const tr of table.querySelectorAll('tbody tr')){
    const btn=tr.querySelector('td:first-child button.rp-link');if(!btn)continue
    const id=upper(btn.textContent),label=gradeLabel(gradeKey(map.get(id)||0))
    if(btn.dataset.wfhGrade!==label)btn.dataset.wfhGrade=label
    btn.title=`${id} · ${label} · 点击查看完整员工档案`
  }
}

const esc=v=>text(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))
const statusName=s=>({active:'在职',probation:'试用',suspended:'停用',inactive:'停用',resigned:'离职'}[text(s)]||text(s)||'—')
const typeName=v=>({home_ph:'纯居家菲律宾',onsite_to_home:'现场转居家',home_vn:'纯居家（越南/缅甸/印尼等）',home_id:'纯居家（越南/缅甸/印尼等）',home_mm:'纯居家（越南/缅甸/印尼等）'}[text(v)]||text(v)||'—')
function date(v){return text(v).slice(0,10)||'—'}
function infoPanel(title,rows){return `<section class="detail-panel"><div class="detail-panel-head"><h3>${esc(title)}</h3></div><div class="info-rows">${rows.map(([k,v])=>`<div class="info-row"><span>${esc(k)}</span><strong>${esc(text(v)||'—')}</strong></div>`).join('')}</div></section>`}
function closeDrawer(){document.querySelector('.wfh-v2721-employee-mask')?.remove()}
async function openEmployeeDrawer(employeeNo){
  const id=upper(employeeNo);if(!id)return
  closeDrawer()
  const mask=document.createElement('div');mask.className='modal-mask detail-mask wfh-v2721-employee-mask'
  mask.innerHTML=`<div class="employee-detail-drawer employee-detail-v12"><div class="employee-hero"><div class="employee-avatar">E</div><div class="employee-hero-copy"><div class="employee-id-line">${esc(id)}</div><h2>读取员工档案...</h2></div><div class="drawer-head-actions"><button class="drawer-close">×</button></div></div><div class="empty-state">读取完整档案...</div></div>`
  document.body.appendChild(mask)
  const drawer=mask.firstElementChild;mask.addEventListener('mousedown',e=>{if(e.target===mask)closeDrawer()});drawer.addEventListener('mousedown',e=>e.stopPropagation());drawer.querySelector('.drawer-close')?.addEventListener('click',closeDrawer)
  try{
    const found=await nativeInvoke('admin-employees',{body:{action:'list',page:1,page_size:5,filters:{employee_no:id,status:''}}})
    if(found.error||found.data?.error)throw new Error(found.data?.error||found.error?.message||'员工读取失败')
    const row=(found.data?.rows||[]).find(x=>upper(x.employee_no)===id)||(found.data?.rows||[])[0]
    const employeeId=text(row?.id||row?.employee_id);if(!employeeId)throw new Error('找不到对应员工档案')
    const detail=await nativeInvoke('admin-employees',{body:{action:'detail',employee_id:employeeId}})
    if(detail.error||detail.data?.error)throw new Error(detail.data?.error||detail.error?.message||'员工档案读取失败')
    const d=detail.data||{},e=d.employee||{},c=d.contact||{},p=d.payment||{},comp=d.compensation||{},missing=d.missing_fields||[]
    const hero=drawer.querySelector('.employee-hero');hero.querySelector('.employee-avatar').textContent=text(e.full_name).slice(0,1).toUpperCase()||'E';hero.querySelector('h2').textContent=e.full_name||id
    const copy=hero.querySelector('.employee-hero-copy');const tags=document.createElement('div');tags.className='employee-tags';tags.innerHTML=`<span>${esc(typeName(e.employment_type))}</span><span>${esc(e.teams?.name||'未匹配团队')}</span><span>${esc(e.positions?.name||'未设置主档岗位')}</span>`;copy.appendChild(tags)
    drawer.querySelector('.empty-state')?.remove()
    const status=document.createElement('div');status.className=`profile-status-line ${missing.length?'has-missing':'is-complete'}`;status.innerHTML=`<div><strong>${missing.length?`资料待完善 ${missing.length} 项`:'当前必填资料完整'}</strong><span>${esc(missing.length?missing.join(' · '):'已通过当前员工类型的资料检查规则')}</span></div>`;drawer.appendChild(status)
    const sections=document.createElement('div');sections.className='detail-sections detail-sections-v11'
    sections.innerHTML=
      infoPanel('基本资料',[['员工ID',e.employee_no],['姓名',e.full_name],['员工国家',e.country||e.nationality],['员工类型',typeName(e.employment_type)],['状态',statusName(e.status)],['入职日期',date(e.hire_date)],['录入时间',e.created_at?new Date(e.created_at).toLocaleString('zh-CN',{hour12:false}):'—'],['离职日期',date(e.resign_date)],...(e.status==='resigned'?[['离职原因',d.resignation_reason||'—']]:[])])+
      infoPanel('组织与排班',[['团队',e.teams?.name],['主档岗位',e.positions?.name],['排班岗位',e.schedule_position],['班次',e.shift_name],['负责人 / 组长',e.leader_name],['培训老师',e.trainer_name],['盘口',e.platform_scope],['工作内容',e.work_content]])+
      infoPanel('联系方式',[['工作TG',e.work_tg],['后台账号',e.backend_accounts],['Telegram',c.telegram_username],['Workfolio邮箱',c.work_email],['Zoom邮箱',c.zoom_email],['Facebook',c.facebook],['WhatsApp',c.whatsapp_phone]])+
      infoPanel('工资设置',[['底薪',comp.base_salary],['日薪',comp.daily_rate],['默认绩效',comp.performance_default],['餐补',comp.meal_allowance],['备注',comp.note]])+
      infoPanel('收款资料',[['收款方式',p.transfer_using||p.mode],['银行卡 / 钱包账号',p.bank_wallet_account],['收款姓名',p.account_name],['USDT 地址',p.usdt_address],['联系电话',p.contact_phone],['WhatsApp',p.whatsapp_number],['员工地址',p.employee_address]])
    drawer.appendChild(sections)
  }catch(err){const empty=drawer.querySelector('.empty-state')||document.createElement('div');empty.className='empty-state';empty.textContent=err?.message||'员工档案读取失败';if(!empty.parentElement)drawer.appendChild(empty)}
}
function captureId(e){
  if(!/\/admin\/reports\/?$/.test(window.location.pathname))return
  const btn=e.target?.closest?.('.rp-errors-table tbody td:first-child button.rp-link');if(!btn)return
  e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();openEmployeeDrawer(btn.textContent)
}

function fixCountLoading(){const card=errorCard(),count=card?.querySelector('.rp-card-title>span');if(count&&card?.querySelector('.rp-loading-inline'))count.textContent='读取中…'}
function patchChartHoverText(){
  const position=document.querySelector('.wfh-original-position-chart');if(position){const source=[...(position.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}));position.querySelectorAll('circle[data-i]').forEach(el=>{const x=source[Number(el.dataset.i)];if(!x)return;let t=el.querySelector('title');if(!t){t=document.createElementNS('http://www.w3.org/2000/svg','title');el.appendChild(t)}t.textContent=`${x.name}：${x.count} 人`})}
  const team=document.querySelector('.wfh-original-team-chart');if(team){const source=[...(team.closest('.rp-card')?.querySelectorAll('.rp-bars button')||[])].map(b=>({name:text(b.querySelector('span')?.textContent),count:text(b.querySelector('strong')?.textContent)}));team.querySelectorAll('rect[data-i]').forEach(el=>{const x=source[Number(el.dataset.i)];if(!x)return;let t=el.querySelector('title');if(!t){t=document.createElementNS('http://www.w3.org/2000/svg','title');el.appendChild(t)}t.textContent=`${x.name} · 人数：${x.count}`})}
}

async function run(){if(stopped)return;scheduled=false;if(!/\/admin\/reports\/?$/.test(window.location.pathname))return;ensureFilters();fixCountLoading();patchChartHoverText();await decorateGrades()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,120)}
export function startReportErrorsStableV2721(){
  if(window.__WFH_REPORT_ERRORS_STABLE_V2721__)return
  window.__WFH_REPORT_ERRORS_STABLE_V2721__=true
  addStyles();patchInvoke();document.addEventListener('click',captureId,true)
  const obs=new MutationObserver(schedule);obs.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{if(!document.hidden){summaryCache.at=0;schedule()}},30000)
  schedule();window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);obs.disconnect();document.removeEventListener('click',captureId,true)},{once:true})
}
