import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const riskKey=value=>{const n=Number(value||0);return n>=10?'high':n>=4?'watch':n>=1?'attention':'normal'}
const riskInfo=value=>{
  const n=Number(value||0)
  const key=riskKey(n)
  return {
    key,n,
    ...(key==='high'?{label:'高频',full:'高频错误 · 10+',color:'#b42334',bg:'#fff1f2',border:'#fecdd3'}:
      key==='watch'?{label:'重点',full:'重点观察 · 4–9',color:'#c2410c',bg:'#fff7ed',border:'#fed7aa'}:
      key==='attention'?{label:'注意',full:'注意 · 1–3',color:'#a16207',bg:'#fffbeb',border:'#fde68a'}:
      {label:'正常',full:'正常 · 0错误',color:'#39734a',bg:'#f0fdf4',border:'#bbf7d0'})
  }
}

let stopped=false,scheduled=false,riskFilter=''
let summaries={at:0,map:new Map()}
let employeeListCache={key:'',at:0,rows:[]}
const originalInvoke=supabase.functions.invoke.bind(supabase.functions)

function addStyles(){
  if(document.getElementById('wfh-stable-error-ui-style'))return
  const s=document.createElement('style')
  s.id='wfh-stable-error-ui-style'
  s.textContent=`
  .wfh-risk-head,.wfh-risk-cell{width:64px!important;min-width:64px!important;max-width:64px!important;text-align:center!important;white-space:nowrap!important}
  .wfh-stable-risk{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:22px;min-width:48px;padding:0 7px;border:1px solid var(--risk-border);border-radius:999px;background:var(--risk-bg);color:var(--risk-color);font-size:9px;font-weight:850;line-height:1;white-space:nowrap;vertical-align:middle}
  .wfh-stable-risk:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--risk-color)}
  .wfh-stable-risk.is-clickable{cursor:pointer}.wfh-stable-risk.is-clickable:hover{box-shadow:0 3px 9px rgba(35,61,98,.12)}
  .wfh-error-unified{margin:0 0 12px;padding:11px 12px;border:1px solid #dce5f0;border-radius:11px;background:#fbfdff;display:grid;gap:9px}
  .wfh-error-primary{display:grid;grid-template-columns:minmax(210px,1.35fr) 150px 150px minmax(165px,.9fr) minmax(150px,.8fr) repeat(5,auto);gap:8px;align-items:end}
  .wfh-error-advanced{display:grid;grid-template-columns:repeat(7,minmax(125px,1fr)) auto;gap:8px;align-items:center;padding-top:9px;border-top:1px dashed #dce5f0}
  .wfh-error-unified label{display:grid;gap:4px;min-width:0;color:#6d8098;font-size:9px;font-weight:750}
  .wfh-error-unified input,.wfh-error-unified select,.wfh-error-unified button{height:34px;min-width:0;border:1px solid #d5dfeb;border-radius:8px;background:#fff;padding:0 9px;color:#314b68;font-size:10px}
  .wfh-error-unified button{cursor:pointer;font-weight:800;white-space:nowrap}.wfh-error-unified button.primary{background:#2164d8;border-color:#2164d8;color:#fff}
  .wfh-error-unified .meta{font-size:9px;color:#8191a7;white-space:nowrap;text-align:right}
  .rp-errors-table{width:100%!important;min-width:1040px!important}.rp-errors-table th,.rp-errors-table td{vertical-align:middle!important}
  .rp-errors-table .wfh-error-type-cell,.rp-errors-table .wfh-error-type-cell *{white-space:nowrap!important;overflow:visible!important;text-overflow:clip!important;max-width:none!important;display:table-cell!important}
  .rp-errors-table .wfh-error-type-cell>div{display:block!important}
  .rp-errors-table .wfh-hide-error-col{display:none!important}
  .rp-errors-table th:last-child,.rp-errors-table td:last-child{width:86px!important;max-width:86px!important;white-space:nowrap!important}
  .wfh-error-history-mask{position:fixed;inset:0;z-index:2600;background:rgba(14,29,49,.58);display:flex;align-items:center;justify-content:center;padding:22px}
  .wfh-error-history{width:min(1050px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 26px 80px rgba(7,23,46,.34)}
  .wfh-error-history header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e5ecf4}.wfh-error-history header h3{margin:0;color:#203a5b;font-size:16px}.wfh-error-history header button{width:34px;height:34px;border:0;border-radius:9px;background:#eef3f8;color:#667b95;font-size:20px;cursor:pointer}
  .wfh-error-history-body{overflow:auto;padding:12px 14px 16px}.wfh-error-history table{width:100%;border-collapse:collapse;font-size:10px}.wfh-error-history th{padding:8px;background:#f5f8fc;color:#687d98;text-align:left;white-space:nowrap}.wfh-error-history td{padding:8px;border-top:1px solid #edf1f6;color:#344d6a;vertical-align:top}.wfh-error-history .wrap{white-space:normal;word-break:break-word;min-width:180px}
  .wfh-employee-risk-filter{min-width:0}
  .wfh-employee-risk-filter select{width:100%;height:40px;border:1px solid #d5e0ec;border-radius:9px;background:#fff;padding:0 10px;color:#314b68;font-size:11px}
  .employee-core-search-grid{grid-template-columns:150px repeat(4,minmax(170px,1fr))!important;align-items:end!important}
  .employee-core-search-grid>.filter-toolbar-actions{grid-column:1/-1!important;justify-content:flex-end!important;margin-top:0!important;padding-top:1px!important}
  .v24-advanced-filter-grid{grid-template-columns:repeat(5,minmax(0,1fr))!important}
  .employee-master-table{width:100%!important;min-width:0!important;table-layout:auto!important}
  .employee-master-table th,.employee-master-table td{padding-left:7px!important;padding-right:7px!important;font-size:10px!important;white-space:normal!important;line-height:1.35!important}
  .employee-master-table th{font-size:9px!important;white-space:nowrap!important}.employee-master-table td:nth-child(2),.employee-master-table td:nth-child(10),.employee-master-table td:nth-child(11){white-space:nowrap!important}
  .employee-master-table .operator-chip{max-width:125px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap!important}.employee-master-table .row-actions{white-space:nowrap}
  @media(max-width:1450px){.employee-core-search-grid{grid-template-columns:150px repeat(2,minmax(185px,1fr))!important}.v24-advanced-filter-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}.wfh-error-primary{grid-template-columns:repeat(5,minmax(140px,1fr))}.wfh-error-advanced{grid-template-columns:repeat(4,minmax(135px,1fr))}}
  @media(max-width:1050px){.employee-core-search-grid{grid-template-columns:1fr 1fr!important}.v24-advanced-filter-grid{grid-template-columns:1fr 1fr!important}.wfh-error-primary,.wfh-error-advanced{grid-template-columns:1fr 1fr}.wfh-error-primary>input:first-child{grid-column:1/-1}.wfh-error-unified .meta{text-align:left}}
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
async function getSummaryMap(force=false){
  if(!force&&Date.now()-summaries.at<20000&&summaries.map.size)return summaries.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_key,month_error_count,last_30d_error_count,total_error_count,last_error_date,main_error_type,risk_level').limit(5000)
  if(error)return summaries.map
  summaries={at:Date.now(),map:new Map((data||[]).map(x=>[upper(x.employee_no),x]))}
  return summaries.map
}
function styleChip(chip,summary){
  const info=riskInfo(summary?.month_error_count)
  chip.textContent=info.label
  chip.title=`${info.full} · 本月 ${info.n} 笔 · 近30天 ${Number(summary?.last_30d_error_count||0)} 笔 · 累计 ${Number(summary?.total_error_count||0)} 笔`
  chip.style.setProperty('--risk-color',info.color);chip.style.setProperty('--risk-bg',info.bg);chip.style.setProperty('--risk-border',info.border)
  chip.dataset.count=String(info.n);chip.dataset.key=info.key
}
function riskChip(id,summary,context,name){
  const chip=document.createElement('span');chip.className='wfh-stable-risk';styleChip(chip,summary)
  if(context==='errors'||Number(summary?.month_error_count||0)>0){chip.classList.add('is-clickable');chip.setAttribute('role','button');chip.tabIndex=0;const open=()=>context==='errors'?filterErrorsTo(id):openErrorHistory(id,name||id);chip.addEventListener('click',e=>{e.stopPropagation();open()});chip.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})}
  return chip
}
async function ensureRiskColumns(){
  const map=await getSummaryMap()
  for(const table of document.querySelectorAll('.employee-master-table,.rp-errors-table')){
    const context=table.classList.contains('rp-errors-table')?'errors':'employees'
    const head=table.querySelector('thead tr')
    if(head&&!head.querySelector(':scope > .wfh-risk-head')){const th=document.createElement('th');th.className='wfh-risk-head';th.textContent='等级';th.title='0 正常 / 1–3 注意 / 4–9 重点 / 10+ 高频';head.insertBefore(th,head.firstChild)}
    for(const tr of table.querySelectorAll('tbody tr')){
      let cell=tr.querySelector(':scope > .wfh-risk-cell')
      if(!cell){cell=document.createElement('td');cell.className='wfh-risk-cell';tr.insertBefore(cell,tr.firstChild)}
      const idCell=cell.nextElementSibling
      const id=upper(idCell?.querySelector('button')?.textContent||idCell?.textContent)
      const name=text(idCell?.nextElementSibling?.textContent)
      if(!id)continue
      const summary=map.get(id)||null
      const sig=`${id}|${Number(summary?.month_error_count||0)}|${Number(summary?.last_30d_error_count||0)}|${Number(summary?.total_error_count||0)}`
      if(cell.dataset.sig!==sig){cell.dataset.sig=sig;cell.replaceChildren(riskChip(id,summary,context,name))}
    }
  }
}
function filterErrorsTo(id){
  const input=document.querySelector('.rp-error-filters input')
  if(input){nativeSet(input,id,'input');input.focus()}
  const mirror=document.querySelector('.wfh-error-unified input[data-role="employee"]')
  if(mirror)mirror.value=id
}
async function openErrorHistory(id,name){
  document.querySelector('.wfh-error-history-mask')?.remove()
  const mask=document.createElement('div');mask.className='wfh-error-history-mask'
  const modal=document.createElement('div');modal.className='wfh-error-history';modal.innerHTML=`<header><h3>${name||id} · ${id} · 错误记录</h3><button type="button">×</button></header><div class="wfh-error-history-body">读取中...</div>`;mask.appendChild(modal);document.body.appendChild(mask)
  mask.addEventListener('mousedown',e=>{if(e.target===mask)mask.remove()});modal.querySelector('header button')?.addEventListener('click',()=>mask.remove())
  const body=modal.querySelector('.wfh-error-history-body')
  try{const {data,error}=await supabase.functions.invoke('admin-reports',{body:{action:'errors',employee_id:id,date_basis:'qc'}});if(error||data?.error)throw new Error(data?.error||error?.message||'读取失败');const rows=data?.rows||[];if(!rows.length){body.textContent='暂无错误记录';return}body.innerHTML=`<table><thead><tr><th>质检时间</th><th>错误类型</th><th>扣分</th><th>质检人</th><th>会员/订单号</th><th>金额</th><th>错误备注</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${text(r.qc_date)||'—'}</td><td>${text(r.error_type)||'—'}</td><td>${text(r.score)||'—'}</td><td>${text(r.qc_person)||'—'}</td><td>${text(r.member_order)||'—'}</td><td>${text(r.amount)||'—'}</td><td class="wrap">${text(r.error_note)||'—'}</td></tr>`).join('')}</tbody></table>`}catch(e){body.textContent=e?.message||'读取失败'}
}

function originalErrorParts(){
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  return {card,order:card?.querySelector('.rp-order-toolbar'),local:card?.querySelector('.rp-error-filters'),global:document.querySelector('.rp-filterbar')}
}
function makeSelect(role){const x=document.createElement('select');x.dataset.role=role;return x}
function copyOptions(target,source){if(!target||!source)return;const html=source.innerHTML;if(target.innerHTML!==html)target.innerHTML=html;if(document.activeElement!==target&&target.value!==source.value)target.value=source.value}
function buildErrorFilter(){
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)==='错误统计'
  const {card,order,local,global}=originalErrorParts()
  const old=document.querySelector('.wfh-error-unified')
  if(!active||!card||!order||!local){if(global)global.style.display='';if(order)order.style.display='';if(local)local.style.display='';old?.remove();return}
  if(global)global.style.display='none';order.style.display='none';local.style.display='none'
  let host=card.querySelector(':scope > .wfh-error-unified')
  if(!host){
    host=document.createElement('div');host.className='wfh-error-unified'
    const primary=document.createElement('div');primary.className='wfh-error-primary'
    const q=document.createElement('input');q.dataset.role='employee';q.placeholder='输入员工ID / 姓名';q.addEventListener('input',()=>{const p=originalErrorParts();nativeSet(p.local?.querySelector('input'),q.value,'input')});primary.appendChild(q)
    for(const [role,label,index] of [['from','质检时间起',0],['to','质检时间止',1]]){const wrap=document.createElement('label');const span=document.createElement('span');span.textContent=label;const input=document.createElement('input');input.type='date';input.dataset.role=role;input.addEventListener('input',()=>{const p=originalErrorParts();nativeSet(p.order?.querySelectorAll('input[type="date"]')?.[index],input.value,'input')});wrap.append(span,input);primary.appendChild(wrap)}
    const type=makeSelect('type');type.addEventListener('change',()=>{const p=originalErrorParts();nativeSet(p.local?.querySelectorAll('select')?.[0],type.value,'change')});primary.appendChild(type)
    const qc=makeSelect('qc');qc.addEventListener('change',()=>{const p=originalErrorParts();nativeSet(p.local?.querySelectorAll('select')?.[1],qc.value,'change')});primary.appendChild(qc)
    ;['查询','最近7天','本月','全部','重置'].forEach(label=>{const b=document.createElement('button');b.textContent=label;if(label==='查询')b.className='primary';b.addEventListener('click',()=>{const p=originalErrorParts();if(label==='重置'){nativeSet(p.local?.querySelector('input'),'','input');[...(p.local?.querySelectorAll('select')||[])].forEach(x=>nativeSet(x,'','change'));[...(p.order?.querySelectorAll('input[type="date"]')||[])].forEach(x=>nativeSet(x,'','input'));buttonByText(p.global,'重置')?.click();buttonByText(p.order,'全部')?.click()}else buttonByText(p.order,label)?.click()});primary.appendChild(b)})
    const advanced=document.createElement('div');advanced.className='wfh-error-advanced'
    ;['shift','team','group','position','country'].forEach((role,i)=>{const sel=makeSelect(role);sel.dataset.index=String(i);sel.addEventListener('change',()=>{const p=originalErrorParts();nativeSet(p.global?.querySelectorAll('select')?.[i],sel.value,'change')});advanced.appendChild(sel)})
    const manager=document.createElement('input');manager.dataset.role='manager';manager.placeholder='负责人 / 培训 / 组长';manager.addEventListener('input',()=>{const p=originalErrorParts();nativeSet(p.global?.querySelector('input[list]'),manager.value,'input')});advanced.appendChild(manager)
    const platform=makeSelect('platform');platform.addEventListener('change',()=>{const p=originalErrorParts();nativeSet(p.global?.querySelectorAll('select')?.[5],platform.value,'change')});advanced.appendChild(platform)
    const meta=document.createElement('div');meta.className='meta';meta.textContent='高级筛选：班次 / 团队 / 组别 / 岗位 / 国家 / 负责人 / 盘口';advanced.appendChild(meta)
    host.append(primary,advanced);card.querySelector('.rp-card-title')?.insertAdjacentElement('afterend',host)
  }
  const p=originalErrorParts(),localSelects=p.local?.querySelectorAll('select')||[],dates=p.order?.querySelectorAll('input[type="date"]')||[],globalSelects=p.global?.querySelectorAll('select')||[]
  const syncInput=(role,value)=>{const x=host.querySelector(`[data-role="${role}"]`);if(x&&document.activeElement!==x&&x.value!==value)x.value=value||''}
  syncInput('employee',p.local?.querySelector('input')?.value||'');syncInput('from',dates[0]?.value||'');syncInput('to',dates[1]?.value||'');copyOptions(host.querySelector('[data-role="type"]'),localSelects[0]);copyOptions(host.querySelector('[data-role="qc"]'),localSelects[1]);['shift','team','group','position','country'].forEach((role,i)=>copyOptions(host.querySelector(`[data-role="${role}"]`),globalSelects[i]));copyOptions(host.querySelector('[data-role="platform"]'),globalSelects[5]);syncInput('manager',p.global?.querySelector('input[list]')?.value||'')
}

function compactErrorTable(){
  const table=document.querySelector('.rp-errors-table');if(!table)return
  const heads=[...table.querySelectorAll('thead th')]
  for(const th of heads)th.classList.remove('wfh-hide-error-col','wfh-error-type-head','wfh-platform-head','wfh-action-head')
  for(const td of table.querySelectorAll('tbody td'))td.classList.remove('wfh-hide-error-col','wfh-error-type-cell','wfh-platform-cell','wfh-action-cell')
  const labels=heads.map(h=>text(h.textContent).replace(/[↕↑↓]/g,'').trim())
  const hide=new Set(['小组长复审','质检人对/错','复检时间'])
  labels.forEach((label,i)=>{
    if(hide.has(label)){heads[i].classList.add('wfh-hide-error-col');for(const tr of table.querySelectorAll('tbody tr'))tr.children[i]?.classList.add('wfh-hide-error-col')}
    if(label==='错误类型'){heads[i].classList.add('wfh-error-type-head');for(const tr of table.querySelectorAll('tbody tr')){const td=tr.children[i];if(td){td.classList.add('wfh-error-type-cell');const div=td.querySelector('.rp-cell-clamp');if(div){div.classList.remove('rp-cell-clamp');div.title=text(div.textContent)}}}}
    if(label==='盘口'){heads[i].classList.add('wfh-platform-head');for(const tr of table.querySelectorAll('tbody tr'))tr.children[i]?.classList.add('wfh-platform-cell')}
    if(label==='操作'){heads[i].classList.add('wfh-action-head');for(const tr of table.querySelectorAll('tbody tr')){const td=tr.children[i];if(td){td.classList.remove('wfh-hide-error-col');td.classList.add('wfh-action-cell');const btn=td.querySelector('button');if(btn)btn.textContent='查看错误'}}}
  })
}

function triggerEmployeeReload(){
  const first=[...document.querySelectorAll('.pagination-actions button')].find(x=>text(x.textContent)==='首页'&&!x.disabled);if(first)first.click()
  setTimeout(()=>document.querySelector('.employee-refresh-action')?.click(),60)
}
function ensureEmployeeRiskFilter(){
  const grid=document.querySelector('.employee-core-search-grid');if(!grid)return
  let box=grid.querySelector('.wfh-employee-risk-filter')
  if(!box){box=document.createElement('label');box.className='pro-filter-field wfh-employee-risk-filter';const title=document.createElement('span');title.textContent='等级';const sel=document.createElement('select');sel.innerHTML='<option value="">全部等级</option><option value="normal">正常（0）</option><option value="attention">注意（1–3）</option><option value="watch">重点（4–9）</option><option value="high">高频（10+）</option>';sel.value=riskFilter;sel.addEventListener('change',()=>{riskFilter=sel.value;employeeListCache={key:'',at:0,rows:[]};triggerEmployeeReload()});box.append(title,sel);grid.insertBefore(box,grid.firstChild)}
}
async function riskFilteredList(body){
  const requestedPage=Math.max(1,Number(body.page||1)),requestedSize=Number(body.page_size||20),filters={...(body.filters||{})}
  const key=JSON.stringify({riskFilter,filters})
  let matched=employeeListCache.key===key&&Date.now()-employeeListCache.at<15000?employeeListCache.rows:null
  if(!matched){const map=await getSummaryMap(),all=[];let page=1,pages=1;do{const res=await originalInvoke('admin-employees',{body:{action:'list',page,page_size:500,filters}});if(res.error||res.data?.error)return res;all.push(...(res.data?.rows||[]).filter(r=>text(r.source_type)!=='google_deleted'));pages=Math.max(1,Number(res.data?.pages||1));page+=1}while(page<=pages&&page<=50);matched=all.filter(r=>riskKey(map.get(upper(r.employee_no))?.month_error_count||0)===riskFilter);employeeListCache={key,at:Date.now(),rows:matched}}
  const start=(requestedPage-1)*requestedSize
  return {data:{rows:matched.slice(start,start+requestedSize),total:matched.length,page:requestedPage,page_size:requestedSize,pages:Math.max(1,Math.ceil(matched.length/requestedSize))},error:null}
}
function patchInvoke(){
  if(supabase.functions.__wfhStableRiskPatched)return
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    if(name==='admin-reports'&&body.action==='errors') return originalInvoke('admin-report-errors',options)
    return originalInvoke(name,options)
  }
  supabase.functions.__wfhStableRiskPatched=true
}

async function run(){if(stopped)return;scheduled=false;if(document.querySelector('.rp-errors-table[data-native-errors-v2723]'))return;buildErrorFilter();await ensureRiskColumns();compactErrorTable()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,120)}
export function startStableErrorUiEnhancer(){
  if(window.__WFH_STABLE_ERROR_UI__)return
  window.__WFH_STABLE_ERROR_UI__=true;addStyles();patchInvoke()
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']})
  const timer=setInterval(()=>{summaries.at=0;schedule()},30000)
  const channel=supabase.channel('wfh-stable-error-ui').on('postgres_changes',{event:'*',schema:'public',table:'employee_error_summary'},()=>{summaries.at=0;employeeListCache={key:'',at:0,rows:[]};schedule()}).subscribe()
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();supabase.removeChannel(channel)},{once:true})
}
