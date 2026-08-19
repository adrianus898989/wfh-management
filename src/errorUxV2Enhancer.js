import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const riskKey=v=>{const n=Number(v||0);return n>=10?'high':n>=4?'watch':n>=1?'attention':'normal'}
const riskCfg=v=>{
  const key=riskKey(v)
  return {
    high:{label:'高频',full:'高频错误 · 10+',color:'#b42334',bg:'#fff1f2',border:'#fecdd3'},
    watch:{label:'重点',full:'重点观察 · 4–9',color:'#c2410c',bg:'#fff7ed',border:'#fed7aa'},
    attention:{label:'注意',full:'注意 · 1–3',color:'#a16207',bg:'#fffbeb',border:'#fde68a'},
    normal:{label:'正常',full:'正常 · 0错误',color:'#39734a',bg:'#f0fdf4',border:'#bbf7d0'},
  }[key]
}

let stopped=false,scheduled=false
let riskFilter=''
let summaryCache={at:0,map:new Map()}
let listCache={key:'',at:0,value:null}
const originalInvoke=supabase.functions.invoke.bind(supabase.functions)

function addStyles(){
  if(document.getElementById('wfh-error-ux-v2-style'))return
  const s=document.createElement('style')
  s.id='wfh-error-ux-v2-style'
  s.textContent=`
    .wfh-error-unified-v2{margin:0 0 14px;padding:12px;border:1px solid #dce5f0;border-radius:12px;background:#fbfdff;display:grid;gap:9px}
    .wfh-error-main-v2{display:grid;grid-template-columns:minmax(210px,1.3fr) repeat(4,minmax(145px,.9fr)) repeat(5,auto);gap:8px;align-items:end}
    .wfh-error-advanced-v2{display:grid;grid-template-columns:repeat(7,minmax(125px,1fr)) auto;gap:8px;align-items:center;padding-top:9px;border-top:1px dashed #dce5f0}
    .wfh-error-unified-v2 label{display:grid;gap:4px;color:#6d8098;font-size:9px;font-weight:750;min-width:0}
    .wfh-error-unified-v2 input,.wfh-error-unified-v2 select,.wfh-error-unified-v2 button{height:34px;min-width:0;border:1px solid #d5dfeb;border-radius:8px;background:#fff;padding:0 9px;color:#314b68;font-size:10px}
    .wfh-error-unified-v2 button{cursor:pointer;font-weight:800;white-space:nowrap}.wfh-error-unified-v2 button.primary{background:#2164d8;border-color:#2164d8;color:#fff}
    .wfh-error-unified-v2 .meta{font-size:9px;color:#8191a7;white-space:nowrap;text-align:right}
    .rp-errors-table{width:100%!important;min-width:1080px!important}.rp-errors-table th,.rp-errors-table td{vertical-align:top!important}
    .rp-errors-table td.wfh-error-type-full,.rp-errors-table td.wfh-error-type-full .rp-cell-clamp{min-width:240px!important;max-width:390px!important;white-space:normal!important;overflow:visible!important;text-overflow:clip!important;display:table-cell!important;line-height:1.5!important;word-break:break-word!important;overflow-wrap:anywhere!important}
    .rp-errors-table td.wfh-error-type-full .rp-cell-clamp{display:block!important;max-width:none!important}
    .rp-errors-table th:last-child,.rp-errors-table td:last-child{width:92px!important;max-width:92px!important;white-space:nowrap!important}
    .wfh-employee-risk-filter{min-width:150px}.wfh-employee-risk-filter select{width:100%;height:36px;border:1px solid #d6e0ec;border-radius:8px;background:#fff;padding:0 10px;color:#314b68}
    .wfh-risk-level[data-v2-normal="1"]{cursor:default!important;box-shadow:none!important;transform:none!important}
    @media(max-width:1450px){.wfh-error-main-v2{grid-template-columns:repeat(5,minmax(140px,1fr))}.wfh-error-advanced-v2{grid-template-columns:repeat(4,minmax(135px,1fr))}}
    @media(max-width:900px){.wfh-error-main-v2,.wfh-error-advanced-v2{grid-template-columns:repeat(2,minmax(0,1fr))}.wfh-error-main-v2>input:first-child{grid-column:1/-1}.wfh-error-unified-v2 .meta{text-align:left}}
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
function clickByText(root,label){
  const b=[...(root?.querySelectorAll('button')||[])].find(x=>text(x.textContent)===label)
  if(b)b.click()
}
function cloneSelect(original,onChange){
  const x=document.createElement('select')
  x.innerHTML=original?.innerHTML||'<option value="">全部</option>'
  x.value=original?.value||''
  x.addEventListener('change',()=>onChange(x.value))
  return x
}
function labelWrap(label,control){const l=document.createElement('label');const s=document.createElement('span');s.textContent=label;l.append(s,control);return l}

function buildUnifiedErrorFilters(){
  const active=text(document.querySelector('.rp-tabs button.active')?.textContent)==='错误统计'
  const global=document.querySelector('.rp-filterbar')
  const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计')
  const order=card?.querySelector('.rp-order-toolbar')
  const local=card?.querySelector('.rp-error-filters')
  if(!active||!card||!order||!local){
    if(global)global.style.display=''
    if(order)order.style.display=''
    if(local)local.style.display=''
    document.querySelector('.wfh-error-unified-v2')?.remove()
    return
  }
  if(global)global.style.display='none'
  order.style.display='none';local.style.display='none'

  const localInput=local.querySelector('input')
  const localSelects=[...local.querySelectorAll('select')]
  const dateInputs=[...order.querySelectorAll('input[type="date"]')]
  const globalSelects=[...(global?.querySelectorAll('select')||[])]
  const globalSupervisor=global?.querySelector('input[list]')
  const sig=JSON.stringify({
    q:localInput?.value||'',dates:dateInputs.map(x=>x.value),local:localSelects.map(x=>[x.value,x.options.length]),
    global:globalSelects.map(x=>[x.value,x.options.length]),sup:globalSupervisor?.value||''
  })
  let host=card.querySelector(':scope > .wfh-error-unified-v2')
  if(host?.dataset.signature===sig)return
  if(!host){host=document.createElement('div');host.className='wfh-error-unified-v2';card.querySelector('.rp-card-title')?.insertAdjacentElement('afterend',host)}
  host.dataset.signature=sig;host.replaceChildren()

  const main=document.createElement('div');main.className='wfh-error-main-v2'
  const q=document.createElement('input');q.placeholder='输入员工ID / 姓名';q.value=localInput?.value||'';q.addEventListener('input',()=>nativeSet(localInput,q.value,'input'));main.appendChild(q)
  const d1=document.createElement('input');d1.type='date';d1.value=dateInputs[0]?.value||'';d1.addEventListener('input',()=>nativeSet(dateInputs[0],d1.value,'input'));main.appendChild(labelWrap('质检时间起',d1))
  const d2=document.createElement('input');d2.type='date';d2.value=dateInputs[1]?.value||'';d2.addEventListener('input',()=>nativeSet(dateInputs[1],d2.value,'input'));main.appendChild(labelWrap('质检时间止',d2))
  if(localSelects[0])main.appendChild(cloneSelect(localSelects[0],v=>nativeSet(localSelects[0],v,'change')))
  if(localSelects[1])main.appendChild(cloneSelect(localSelects[1],v=>nativeSet(localSelects[1],v,'change')))
  ;['查询','最近7天','本月','全部','重置'].forEach(t=>{const b=document.createElement('button');b.textContent=t;if(t==='查询')b.className='primary';b.addEventListener('click',()=>{if(t==='重置'){clickByText(local,'重置');clickByText(global,'重置')}else clickByText(order,t)});main.appendChild(b)})

  const advanced=document.createElement('div');advanced.className='wfh-error-advanced-v2'
  const labels=['全部班次','全部团队','全部组别','全部岗位','全部国家']
  globalSelects.slice(0,5).forEach((orig,i)=>advanced.appendChild(cloneSelect(orig,v=>nativeSet(orig,v,'change'))))
  if(globalSupervisor){const x=document.createElement('input');x.placeholder='负责人 / 培训 / 组长';x.value=globalSupervisor.value||'';x.setAttribute('list','wfh-error-supervisors-v2');x.addEventListener('input',()=>nativeSet(globalSupervisor,x.value,'input'));advanced.appendChild(x);const dl=document.createElement('datalist');dl.id='wfh-error-supervisors-v2';const source=document.getElementById(globalSupervisor.getAttribute('list')||'');if(source)dl.innerHTML=source.innerHTML;host.appendChild(dl)}
  if(globalSelects[5])advanced.appendChild(cloneSelect(globalSelects[5],v=>nativeSet(globalSelects[5],v,'change')))
  const meta=document.createElement('div');meta.className='meta';meta.textContent='高级筛选：班次 / 团队 / 组别 / 岗位 / 国家 / 负责人 / 盘口';advanced.appendChild(meta)
  host.append(main,advanced)
}

async function summaryMap(){
  if(Date.now()-summaryCache.at<20000&&summaryCache.map.size)return summaryCache.map
  const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count,month_key,last_30d_error_count,total_error_count').limit(5000)
  if(error)return summaryCache.map
  const map=new Map((data||[]).map(x=>[upper(x.employee_no),x]))
  summaryCache={at:Date.now(),map};return map
}
function applyRiskStyle(el,row){
  const count=Number(row?.month_error_count||0),cfg=riskCfg(count)
  el.textContent=cfg.label
  el.title=`${cfg.full} · 本月 ${count} 笔 · 近30天 ${Number(row?.last_30d_error_count||0)} 笔 · 累计 ${Number(row?.total_error_count||0)} 笔`
  el.style.setProperty('--risk-color',cfg.color);el.style.setProperty('--risk-bg',cfg.bg);el.style.setProperty('--risk-border',cfg.border)
  el.dataset.v2Count=String(count)
  if(count===0)el.dataset.v2Normal='1';else delete el.dataset.v2Normal
}
async function normalizeRiskChips(){
  const map=await summaryMap()
  for(const table of document.querySelectorAll('.rp-errors-table,.employee-master-table')){
    for(const tr of table.querySelectorAll('tbody tr')){
      const chip=tr.querySelector('.wfh-risk-level');if(!chip)continue
      const riskCell=chip.closest('td');const idCell=riskCell?.nextElementSibling
      const id=upper(idCell?.querySelector('button')?.textContent||idCell?.textContent)
      if(id)applyRiskStyle(chip,map.get(id))
    }
  }
  for(const th of document.querySelectorAll('.wfh-risk-col-head'))th.title='等级规则：0 正常 / 1–3 注意 / 4–9 重点 / 10+ 高频'
}

function enhanceErrorTable(){
  const table=document.querySelector('.rp-errors-table');if(!table)return
  const headers=[...table.querySelectorAll('thead th')]
  const errorIndex=headers.findIndex(x=>text(x.textContent).startsWith('错误类型'))
  if(errorIndex>=0){for(const tr of table.querySelectorAll('tbody tr')){const td=tr.children[errorIndex];if(td){td.classList.add('wfh-error-type-full');td.querySelector('.rp-cell-clamp')?.classList.remove('rp-cell-clamp')}}}
  for(const b of table.querySelectorAll('.wfh-employee-open-btn'))b.remove()
  for(const tr of table.querySelectorAll('tbody tr')){const cell=tr.lastElementChild;const b=cell?.querySelector('button');if(b)b.textContent='查看错误'}
}

function findEmployeeIdInput(){
  const grid=document.querySelector('.employee-core-search-grid');if(!grid)return null
  for(const label of grid.querySelectorAll('label'))if(text(label.querySelector('span')?.textContent)==='员工ID')return label.querySelector('input')
  return null
}
function triggerEmployeeReload(){
  const input=findEmployeeIdInput();if(!input)return
  const current=input.value||''
  nativeSet(input,current+' ','input')
  setTimeout(()=>nativeSet(input,current,'input'),360)
}
function ensureEmployeeRiskFilter(){
  const grid=document.querySelector('.employee-core-search-grid');if(!grid)return
  let box=grid.querySelector('.wfh-employee-risk-filter')
  if(!box){
    box=document.createElement('label');box.className='pro-filter-field wfh-employee-risk-filter'
    const title=document.createElement('span');title.textContent='等级'
    const sel=document.createElement('select');sel.innerHTML='<option value="">全部等级</option><option value="normal">正常（0错误）</option><option value="attention">注意（1–3）</option><option value="watch">重点（4–9）</option><option value="high">高频（10+）</option>';sel.value=riskFilter
    sel.addEventListener('change',()=>{riskFilter=sel.value;listCache={key:'',at:0,value:null};triggerEmployeeReload()})
    box.append(title,sel);grid.insertBefore(box,grid.firstChild)
  }else{const sel=box.querySelector('select');if(sel&&sel.value!==riskFilter)sel.value=riskFilter}
}

async function getRiskFilteredList(body){
  const requestedPage=Math.max(1,Number(body.page||1)),requestedSize=Number(body.page_size||20)
  const filters={...(body.filters||{})}
  const key=JSON.stringify({riskFilter,filters})
  if(listCache.key===key&&Date.now()-listCache.at<15000&&listCache.value){
    const all=listCache.value,start=(requestedPage-1)*requestedSize
    return {rows:all.slice(start,start+requestedSize),total:all.length,page:requestedPage,page_size:requestedSize,pages:Math.max(1,Math.ceil(all.length/requestedSize))}
  }
  const map=await summaryMap(),all=[]
  let page=1,pages=1
  do{
    const res=await originalInvoke('admin-employees',{body:{action:'list',page,page_size:500,filters}})
    if(res.error||res.data?.error)return res.data||{rows:[],total:0,page:1,page_size:requestedSize,pages:1}
    all.push(...(res.data?.rows||[]).filter(r=>text(r.source_type)!=='google_deleted'))
    pages=Math.max(1,Number(res.data?.pages||1));page+=1
  }while(page<=pages&&page<=50)
  const matched=all.filter(r=>riskKey(map.get(upper(r.employee_no))?.month_error_count||0)===riskFilter)
  listCache={key,at:Date.now(),value:matched}
  const start=(requestedPage-1)*requestedSize
  return {rows:matched.slice(start,start+requestedSize),total:matched.length,page:requestedPage,page_size:requestedSize,pages:Math.max(1,Math.ceil(matched.length/requestedSize))}
}
function patchInvoke(){
  if(supabase.functions.__wfhRiskPatched)return
  const wrapper=async(name,options={})=>{
    const body=options?.body||{}
    if(name==='admin-employees'&&body.action==='list'&&riskFilter){
      try{return {data:await getRiskFilteredList(body),error:null}}catch(error){return {data:null,error}}
    }
    return originalInvoke(name,options)
  }
  supabase.functions.invoke=wrapper
  supabase.functions.__wfhRiskPatched=true
}

function captureClicks(e){
  const chip=e.target?.closest?.('.wfh-risk-level');if(!chip)return
  const table=chip.closest('table')
  if(table?.classList.contains('rp-errors-table')){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()
    const id=upper(chip.closest('td')?.nextElementSibling?.querySelector('button')?.textContent||chip.closest('td')?.nextElementSibling?.textContent)
    const input=document.querySelector('.rp-error-filters input')
    if(id&&input){nativeSet(input,id,'input');input.focus()}
    return
  }
  if(table?.classList.contains('employee-master-table')&&Number(chip.dataset.v2Count||0)===0){
    e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()
  }
}

async function run(){
  if(stopped)return;scheduled=false
  buildUnifiedErrorFilters();ensureEmployeeRiskFilter();enhanceErrorTable();await normalizeRiskChips()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,120)}

export function startErrorUxV2Enhancer(){
  if(window.__WFH_ERROR_UX_V2__)return
  window.__WFH_ERROR_UX_V2__=true
  addStyles();patchInvoke();document.addEventListener('click',captureClicks,true)
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','value']})
  const timer=setInterval(()=>{summaryCache.at=0;schedule()},30000)
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);observer.disconnect();document.removeEventListener('click',captureClicks,true)},{once:true})
}
