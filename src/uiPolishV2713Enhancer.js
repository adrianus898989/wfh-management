import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const gradeKey=value=>{const n=Number(value||0);return n>=31?'high':n>=16?'watch':n>=9?'attention':n>=1?'normal':'excellent'}
const gradeMeta={
  excellent:{label:'优秀',range:'0 错误',color:'#168a63',bg:'#ecfdf5',border:'#a7f3d0'},
  normal:{label:'正常',range:'1–8',color:'#2563a8',bg:'#eff6ff',border:'#bfdbfe'},
  attention:{label:'注意',range:'9–15',color:'#a16207',bg:'#fffbeb',border:'#fde68a'},
  watch:{label:'重点',range:'16–30',color:'#c2410c',bg:'#fff7ed',border:'#fed7aa'},
  high:{label:'高频',range:'31+',color:'#b42334',bg:'#fff1f2',border:'#fecdd3'},
}
const gradeChoices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]

let stopped=false,scheduled=false,archiveGrade='',errorGrade='',priorInvoke=null
let summaryCache={at:0,map:new Map()},lastErrorRows=[],dateCache=new Map()

function addStyles(){
  if(document.getElementById('wfh-ui-polish-v2713-style'))return
  const s=document.createElement('style');s.id='wfh-ui-polish-v2713-style';s.textContent=`
  .reports-page .rp-head p,.reports-page .rp-source-strip{display:none!important}
  .reports-page .rp-head{margin-bottom:10px!important}.reports-page .rp-tabs{margin-bottom:10px!important}
  .rp-card:has(.rp-errors-table)>.rp-card-title p{display:none!important}
  .wfh-error-unified .meta{display:none!important}

  .wfh-grade-picker{position:relative;min-width:0}.wfh-grade-picker>button.wfh-grade-trigger{width:100%;height:38px;border:1px solid #d4dfec;border-radius:10px;background:#fff;color:#294561;padding:0 34px 0 11px;font-size:11px;font-weight:750;text-align:left;cursor:pointer;position:relative;box-shadow:0 1px 2px rgba(26,52,84,.03)}
  .wfh-grade-picker>button.wfh-grade-trigger:after{content:'⌄';position:absolute;right:12px;top:50%;transform:translateY(-54%);color:#71849a;font-size:14px}.wfh-grade-picker.open>button.wfh-grade-trigger{border-color:#5e94e8;box-shadow:0 0 0 3px rgba(64,128,225,.10)}
  .wfh-grade-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:4500;padding:6px;background:#fff;border:1px solid #d9e3ef;border-radius:11px;box-shadow:0 16px 38px rgba(20,45,76,.18);display:none;min-width:160px}.wfh-grade-picker.open .wfh-grade-menu{display:grid;gap:3px}
  .wfh-grade-menu button{height:34px!important;border:0!important;border-radius:7px!important;background:#fff!important;color:#35516f!important;padding:0 9px!important;text-align:left!important;font-size:10px!important;font-weight:700!important;cursor:pointer}.wfh-grade-menu button:hover{background:#f2f7fd!important}.wfh-grade-menu button.active{background:#eaf2ff!important;color:#155bd7!important}
  .wfh-grade-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--grade-color,#6b7d91)}
  .wfh-error-grade-slot{display:grid;gap:4px;min-width:140px}.wfh-error-grade-slot>span{font-size:9px;font-weight:750;color:#6d8098}
  .wfh-error-advanced{grid-template-columns:140px repeat(7,minmax(125px,1fr))!important}

  .wfh-stable-risk{min-width:52px!important;height:23px!important;padding:0 8px!important;font-size:9px!important;border-radius:999px!important;box-shadow:none!important}
  .wfh-stable-risk:before{width:6px!important;height:6px!important}
  .wfh-risk-head,.wfh-risk-cell{width:66px!important;min-width:66px!important;max-width:66px!important}

  .rp-errors-table .wfh-action-cell{display:table-cell!important;visibility:visible!important;opacity:1!important;width:90px!important;min-width:90px!important;max-width:90px!important;text-align:center!important}
  .wfh-error-view-btn{height:30px;border:1px solid #9fc1fb;border-radius:8px;background:#fff;color:#0f5bd8;padding:0 10px;font-size:10px;font-weight:800;white-space:nowrap;cursor:pointer}.wfh-error-view-btn:hover{background:#f3f7ff;border-color:#6f9ff1}
  .wfh-single-error-mask{position:fixed;inset:0;z-index:5200;background:rgba(14,29,49,.58);display:flex;align-items:center;justify-content:center;padding:24px}.wfh-single-error-modal{width:min(920px,94vw);max-height:88vh;background:#fff;border-radius:15px;box-shadow:0 28px 84px rgba(7,23,46,.34);overflow:hidden;display:flex;flex-direction:column}.wfh-single-error-head{display:flex;align-items:center;justify-content:space-between;padding:15px 18px;border-bottom:1px solid #e6edf5}.wfh-single-error-head h3{margin:0;font-size:16px;color:#203a5b}.wfh-single-error-head button{width:34px;height:34px;border:0;border-radius:9px;background:#eef3f8;color:#667b95;font-size:20px;cursor:pointer}.wfh-single-error-body{padding:16px 18px 20px;overflow:auto}.wfh-error-detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.wfh-error-detail-item{padding:10px 11px;border:1px solid #e1e9f2;border-radius:10px;background:#fbfdff;min-width:0}.wfh-error-detail-item.wide{grid-column:span 2}.wfh-error-detail-item.full{grid-column:1/-1}.wfh-error-detail-item span{display:block;color:#8292a7;font-size:9px;font-weight:750;margin-bottom:4px}.wfh-error-detail-item strong{display:block;color:#2c4764;font-size:11px;line-height:1.5;white-space:normal;word-break:break-word}

  .employee-core-search-grid{grid-template-columns:150px repeat(4,minmax(170px,1fr))!important;gap:12px!important;align-items:end!important}.employee-core-search-grid>.wfh-employee-risk-filter{min-width:0!important}
  .archive-filter-actions{display:flex!important;position:static!important;float:none!important;justify-content:flex-end!important;align-items:center!important;gap:8px!important;width:100%!important;margin:10px 0 0!important;padding:11px 0 0!important;border-top:1px dashed #dce5f0!important;grid-column:1/-1!important;order:99!important}
  .archive-filter-actions button{min-width:78px;height:36px!important;border-radius:9px!important}
  .employee-master-table .row-actions{display:flex!important;flex-direction:row!important;align-items:center!important;justify-content:flex-start!important;gap:6px!important;flex-wrap:nowrap!important;white-space:nowrap!important}.employee-master-table td:last-child{min-width:118px!important;width:118px!important}.employee-master-table .row-actions button{margin:0!important;white-space:nowrap!important}

  .wfh-resign-action-row{display:flex;justify-content:flex-end;align-items:center;gap:8px;grid-column:1/-1;padding:2px 0 0;margin-left:auto}.wfh-resign-action-row button{min-width:72px;height:38px}
  .wfh-hire-date-col,.wfh-resign-date-col{white-space:nowrap!important;min-width:105px!important}

  @media(max-width:1450px){.wfh-error-advanced{grid-template-columns:repeat(4,minmax(135px,1fr))!important}.employee-core-search-grid{grid-template-columns:150px repeat(2,minmax(185px,1fr))!important}.wfh-error-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media(max-width:900px){.wfh-error-advanced,.employee-core-search-grid{grid-template-columns:1fr 1fr!important}.wfh-error-detail-grid{grid-template-columns:1fr}.wfh-error-detail-item.wide,.wfh-error-detail-item.full{grid-column:1}.archive-filter-actions{justify-content:stretch!important}.archive-filter-actions button{flex:1}}
  `;document.head.appendChild(s)
}

function nativeSet(el,value,eventName='input'){if(!el)return;const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,value);else el.value=value;el.dispatchEvent(new Event(eventName,{bubbles:true}))}
function btnByText(root,label){return [...(root?.querySelectorAll('button')||[])].find(x=>text(x.textContent)===label)||null}

async function summaryMap(force=false){
  if(!force&&Date.now()-summaryCache.at<20000&&summaryCache.map.size)return summaryCache.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count,last_30d_error_count,total_error_count,last_error_date,main_error_type,risk_level').limit(5000)
  if(!error)summaryCache={at:Date.now(),map:new Map((data||[]).map(x=>[upper(x.employee_no),x]))}
  return summaryCache.map
}

function makeGradePicker(value,onChange,aria='等级筛选'){
  const root=document.createElement('div');root.className='wfh-grade-picker';root.setAttribute('aria-label',aria)
  const trigger=document.createElement('button');trigger.type='button';trigger.className='wfh-grade-trigger'
  const menu=document.createElement('div');menu.className='wfh-grade-menu'
  const update=()=>{const chosen=gradeChoices.find(x=>x[0]===value)||gradeChoices[0],meta=gradeMeta[value];trigger.innerHTML=`${meta?`<i class="wfh-grade-dot" style="--grade-color:${meta.color}"></i>`:''}${chosen[1]}`;[...menu.children].forEach((b,i)=>b.classList.toggle('active',gradeChoices[i][0]===value))}
  gradeChoices.forEach(([key,label])=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',e=>{e.stopPropagation();value=key;update();root.classList.remove('open');onChange(key)});menu.appendChild(b)})
  trigger.addEventListener('click',e=>{e.stopPropagation();document.querySelectorAll('.wfh-grade-picker.open').forEach(x=>{if(x!==root)x.classList.remove('open')});root.classList.toggle('open')})
  root.append(trigger,menu);update();return {root,set:v=>{value=v;update()}}
}

function patchGradeInvoke(){
  if(supabase.functions.__wfhV2713GradePatched)return
  priorInvoke=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    if(name==='admin-employees'&&body.action==='list'&&archiveGrade){
      return priorInvoke('admin-employee-risk-list',{...options,body:{...body,risk_level:archiveGrade,filters:{...(body.filters||{}),risk_level:archiveGrade}}})
    }
    const isErrors=(name==='admin-reports'&&body.action==='errors')||name==='admin-report-errors'
    const result=await priorInvoke(name,options)
    if(isErrors&&result?.data?.rows){
      let rows=[...(result.data.rows||[])];lastErrorRows=rows
      if(errorGrade){const map=await summaryMap();rows=rows.filter(r=>gradeKey(map.get(upper(r.employee_id))?.month_error_count||0)===errorGrade)}
      lastErrorRows=rows
      return {...result,data:{...result.data,rows,options:{...(result.data.options||{}),error_types:[...new Set(rows.map(r=>text(r.error_type)).filter(Boolean))].sort(),qc_people:[...new Set(rows.map(r=>text(r.qc_person)).filter(Boolean))].sort()}}}
    }
    return result
  }
  supabase.functions.__wfhV2713GradePatched=true
}

function ensureArchiveGradePicker(){
  const box=document.querySelector('.wfh-employee-risk-filter');if(!box||box.dataset.v2713==='1')return
  box.dataset.v2713='1';box.replaceChildren();const title=document.createElement('span');title.textContent='等级'
  const picker=makeGradePicker(archiveGrade,v=>{archiveGrade=v;const first=[...document.querySelectorAll('.pagination-actions button')].find(x=>text(x.textContent)==='首页'&&!x.disabled);first?.click();setTimeout(()=>document.querySelector('.employee-refresh-action')?.click(),80)},'员工等级筛选')
  box.append(title,picker.root)
}

function ensureErrorGradePicker(){
  const advanced=document.querySelector('.wfh-error-unified .wfh-error-advanced');if(!advanced||advanced.querySelector('.wfh-error-grade-slot'))return
  const slot=document.createElement('label');slot.className='wfh-error-grade-slot';const title=document.createElement('span');title.textContent='等级';slot.appendChild(title)
  const picker=makeGradePicker(errorGrade,v=>{errorGrade=v;const {order}=errorParts();btnByText(order,'查询')?.click()},'错误等级筛选');slot.appendChild(picker.root);advanced.insertBefore(slot,advanced.firstChild)
}

function errorParts(){const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计');return{card,order:card?.querySelector('.rp-order-toolbar'),local:card?.querySelector('.rp-error-filters')}}

async function regradeChips(){
  const map=await summaryMap()
  for(const table of document.querySelectorAll('.employee-master-table,.rp-errors-table')){
    for(const tr of table.querySelectorAll('tbody tr')){
      const chip=tr.querySelector('.wfh-stable-risk');if(!chip)continue
      const riskCell=chip.closest('td'),idCell=riskCell?.nextElementSibling,id=upper(idCell?.querySelector('button')?.textContent||idCell?.textContent);if(!id)continue
      const n=Number(map.get(id)?.month_error_count||0),key=gradeKey(n),meta=gradeMeta[key];if(!meta)continue
      if(chip.dataset.v2713grade!==`${key}|${n}`){chip.dataset.v2713grade=`${key}|${n}`;chip.textContent=meta.label;chip.title=`${meta.label} · ${meta.range} · 本月 ${n} 笔`;chip.style.setProperty('--risk-color',meta.color);chip.style.setProperty('--risk-bg',meta.bg);chip.style.setProperty('--risk-border',meta.border)}
      if(n===0&&table.classList.contains('employee-master-table')){chip.classList.remove('is-clickable');chip.style.cursor='default'}
    }
    const th=table.querySelector('.wfh-risk-head');if(th)th.title='优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+'
  }
}

function headerMap(table){const hs=[...table.querySelectorAll('thead th')];const labels=hs.map(h=>text(h.textContent).replace(/[↕↑↓]/g,'').trim());return{hs,labels,index:l=>labels.indexOf(l)}}
function errorRowFor(tr,table){const h=headerMap(table),val=l=>{const i=h.index(l);return i>=0?text(tr.children[i]?.textContent):''};const id=upper(val('员工ID')),date=val('质检时间'),type=val('错误类型'),qc=val('质检人');return lastErrorRows.find(r=>upper(r.employee_id)===id&&(!date||text(r.qc_date)===date)&&(!type||text(r.error_type)===type)&&(!qc||text(r.qc_person)===qc))||lastErrorRows.find(r=>upper(r.employee_id)===id&&(!date||text(r.qc_date)===date))||null}
function esc(v){return text(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function openSingleError(row){
  document.querySelector('.wfh-single-error-mask')?.remove();const mask=document.createElement('div');mask.className='wfh-single-error-mask';const modal=document.createElement('div');modal.className='wfh-single-error-modal'
  const fields=[['员工ID',row.employee_id],['姓名',row.name],['团队',row.team],['岗位',row.position],['盘口',row.platform],['质检时间',row.qc_date],['错误类型',row.error_type],['扣分',row.score],['质检人',row.qc_person],['会员 / 订单号',row.member_order],['金额',row.amount],['复检时间',row.review_date],['小组长复审',row.leader_review],['质检结果',row.qc_result],['错误备注',row.error_note,'full'],['正确操作方式',row.correct_action,'full']]
  modal.innerHTML=`<div class="wfh-single-error-head"><h3>${esc(row.employee_id)} · 错误详情</h3><button type="button">×</button></div><div class="wfh-single-error-body"><div class="wfh-error-detail-grid">${fields.map(([l,v,c])=>`<div class="wfh-error-detail-item ${c||''}"><span>${esc(l)}</span><strong>${esc(v)||'—'}</strong></div>`).join('')}</div></div>`;mask.appendChild(modal);document.body.appendChild(mask);mask.addEventListener('mousedown',e=>{if(e.target===mask)mask.remove()});modal.querySelector('button')?.addEventListener('click',()=>mask.remove())
}
async function loadSingleErrorFromTr(tr,table){let row=errorRowFor(tr,table);if(row)return row;const h=headerMap(table),i=h.index('员工ID'),id=upper(i>=0?tr.children[i]?.textContent:'');const d=h.index('质检时间'),date=text(d>=0?tr.children[d]?.textContent:'');if(!id)return null;const res=await priorInvoke('admin-report-errors',{body:{employee_id:id,date_from:date,date_to:date}});return res?.data?.rows?.[0]||null}
async function ensureEveryErrorButton(){
  const table=document.querySelector('.rp-errors-table');if(!table)return;const h=headerMap(table),ai=h.index('操作');if(ai<0)return
  h.hs[ai]?.classList.remove('wfh-hide-error-col');h.hs[ai]?.classList.add('wfh-action-head')
  for(const tr of table.querySelectorAll('tbody tr')){const td=tr.children[ai];if(!td)continue;td.classList.remove('wfh-hide-error-col');td.classList.add('wfh-action-cell');if(td.dataset.v2713btn==='1'&&td.querySelector('.wfh-error-view-btn'))continue;td.dataset.v2713btn='1';const b=document.createElement('button');b.type='button';b.className='wfh-error-view-btn';b.textContent='查看错误';b.addEventListener('click',async()=>{b.disabled=true;try{const row=await loadSingleErrorFromTr(tr,table);if(row)openSingleError(row)}finally{b.disabled=false}});td.replaceChildren(b)}
}

function polishArchiveActions(){
  const actions=document.querySelector('.archive-filter-actions');if(actions){const advanced=document.querySelector('.v24-advanced-filter-grid');if(advanced&&actions.previousElementSibling!==advanced)advanced.insertAdjacentElement('afterend',actions)}
}

function polishResignRecordActions(){
  const active=[...document.querySelectorAll('button')].find(b=>text(b.textContent)==='离职记录'&&b.classList.contains('active'));if(!active)return
  const card=[...document.querySelectorAll('.data-card,.section-card,.admin-section,.content-card')].find(x=>text(x.querySelector('h2,h3')?.textContent)==='离职记录')||[...document.querySelectorAll('section,div')].find(x=>text(x.querySelector(':scope > h2,:scope > h3')?.textContent)==='离职记录')
  if(!card)return;const buttons=[...card.querySelectorAll('button')].filter(b=>['查询','重置'].includes(text(b.textContent)));if(buttons.length<2)return
  let row=card.querySelector('.wfh-resign-action-row');if(!row){row=document.createElement('div');row.className='wfh-resign-action-row';const filterArea=buttons[0].closest('.filter-panel,.resignation-filter-panel,.data-card')||buttons[0].parentElement?.parentElement||card;filterArea.appendChild(row)}buttons.forEach(b=>row.appendChild(b))
}

async function employeeDates(ids){
  const need=[...new Set(ids.map(upper).filter(Boolean))].filter(id=>!dateCache.has(id));if(need.length){const {data,error}=await supabase.functions.invoke('admin-employee-dates',{body:{employee_nos:need}});if(!error){for(const r of data?.rows||[])dateCache.set(upper(r.employee_no),{hire_date:text(r.hire_date).slice(0,10),resign_date:text(r.resign_date).slice(0,10)});need.forEach(id=>{if(!dateCache.has(id))dateCache.set(id,{hire_date:'',resign_date:''})})}}return dateCache
}
async function addHireDateToResignTable(){
  const active=[...document.querySelectorAll('button')].find(b=>text(b.textContent)==='离职记录'&&b.classList.contains('active'));if(!active)return
  const tables=[...document.querySelectorAll('table')].filter(t=>headerMap(t).labels.includes('离职日期')&&headerMap(t).labels.includes('员工ID'))
  for(const table of tables){const h=headerMap(table),idIdx=h.index('员工ID'),resignIdx=h.index('离职日期');if(idIdx<0||resignIdx<0)continue;const ids=[...table.querySelectorAll('tbody tr')].map(tr=>upper(tr.children[idIdx]?.textContent));await employeeDates(ids);if(!h.labels.includes('入职日期')){const th=document.createElement('th');th.textContent='入职日期';th.className='wfh-hire-date-col';h.hs[resignIdx].before(th)}for(const tr of table.querySelectorAll('tbody tr')){if(tr.querySelector('.wfh-hire-date-cell-v2713'))continue;const id=upper(tr.children[idIdx+(h.labels.includes('入职日期')?0:0)]?.textContent);const cell=document.createElement('td');cell.className='wfh-hire-date-cell-v2713 wfh-hire-date-col';cell.textContent=dateCache.get(id)?.hire_date||'—';const resignCell=[...tr.children].find((c,i)=>text(table.querySelectorAll('thead th')[i]?.textContent)==='离职日期');resignCell?.before(cell)}}
}
async function splitResignModalDates(){
  const modals=[...document.querySelectorAll('.modal-card,.people-detail-modal,.analysis-detail-modal')].filter(m=>/离职人员|人员流动/.test(text(m.querySelector('h2,h3')?.textContent)))
  for(const modal of modals){const table=modal.querySelector('table');if(!table||table.dataset.v2713dates==='1')continue;const h=headerMap(table),idIdx=h.index('员工ID'),firstLabel=h.labels[0]||'';if(idIdx<0||!firstLabel.includes('日期'))continue;const trs=[...table.querySelectorAll('tbody tr')],ids=trs.map(tr=>upper(tr.children[idIdx]?.textContent));await employeeDates(ids);table.dataset.v2713dates='1';const firstTh=h.hs[0];firstTh.textContent='入职日期';firstTh.classList.add('wfh-hire-date-col');const resignTh=document.createElement('th');resignTh.textContent='离职日期';resignTh.className='wfh-resign-date-col';firstTh.after(resignTh);for(const tr of trs){const id=upper(tr.children[idIdx]?.textContent),old=text(tr.children[0]?.textContent).match(/\d{4}-\d{2}-\d{2}/)?.[0]||'',d=dateCache.get(id)||{};tr.children[0].textContent=d.hire_date||'—';tr.children[0].classList.add('wfh-hire-date-col');const cell=document.createElement('td');cell.className='wfh-resign-date-col';cell.textContent=d.resign_date||old||'—';tr.children[0].after(cell)}}
}

async function run(){if(stopped)return;scheduled=false;ensureArchiveGradePicker();ensureErrorGradePicker();polishArchiveActions();polishResignRecordActions();await regradeChips();await ensureEveryErrorButton();await addHireDateToResignTable();await splitResignModalDates()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,140)}

export function startUiPolishV2713Enhancer(){
  if(window.__WFH_UI_POLISH_V2713__)return;window.__WFH_UI_POLISH_V2713__=true;addStyles();patchGradeInvoke();document.addEventListener('click',e=>{if(!e.target.closest('.wfh-grade-picker'))document.querySelectorAll('.wfh-grade-picker.open').forEach(x=>x.classList.remove('open'))})
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});const timer=setInterval(()=>{summaryCache.at=0;schedule()},30000);schedule();window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect()},{once:true})
}
