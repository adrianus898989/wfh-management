import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const cache=new Map()
let scheduled=false,stopped=false

function labels(table){const hs=[...table.querySelectorAll('thead th')];return{hs,names:hs.map(x=>text(x.textContent).replace(/[↕↑↓]/g,'').trim())}}
async function dates(ids){const need=[...new Set(ids.map(upper).filter(Boolean))].filter(x=>!cache.has(x));if(need.length){const {data,error}=await supabase.functions.invoke('admin-employee-dates',{body:{employee_nos:need}});if(!error){for(const r of data?.rows||[])cache.set(upper(r.employee_no),{hire:text(r.hire_date).slice(0,10),resign:text(r.resign_date).slice(0,10)});need.forEach(id=>{if(!cache.has(id))cache.set(id,{hire:'',resign:''})})}}return cache}
function resignTabActive(){return [...document.querySelectorAll('button')].some(b=>text(b.textContent)==='离职记录'&&b.classList.contains('active'))}
function nativeSet(el,value){if(!el)return;const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(setter)setter.call(el,value);else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))}

async function fixResignRecordDates(){
  if(!resignTabActive())return
  for(const table of document.querySelectorAll('table')){
    let h=labels(table),idIdx=h.names.indexOf('员工ID'),resignIdx=h.names.indexOf('离职日期');if(idIdx<0||resignIdx<0)continue
    const trs=[...table.querySelectorAll('tbody tr')],ids=trs.map(tr=>upper(tr.children[idIdx]?.textContent));await dates(ids)
    let hireIdx=h.names.indexOf('入职日期')
    if(hireIdx<0){const th=document.createElement('th');th.textContent='入职日期';th.className='wfh-hire-date-col';h.hs[resignIdx].before(th);for(const tr of trs){const td=document.createElement('td');td.className='wfh-hire-date-col';tr.children[resignIdx]?.before(td)}h=labels(table);hireIdx=h.names.indexOf('入职日期');resignIdx=h.names.indexOf('离职日期');idIdx=h.names.indexOf('员工ID')}
    for(const tr of trs){const id=upper(tr.children[idIdx]?.textContent),d=cache.get(id)||{};if(tr.children[hireIdx]){tr.children[hireIdx].textContent=d.hire||'—';tr.children[hireIdx].classList.add('wfh-hire-date-col')}if(tr.children[resignIdx]){const fallback=text(tr.children[resignIdx].textContent).match(/\d{4}-\d{2}-\d{2}/)?.[0]||'';tr.children[resignIdx].textContent=d.resign||fallback||'—';tr.children[resignIdx].classList.add('wfh-resign-date-col')}}
  }
}

async function fixResignModalDates(){
  const modals=[...document.querySelectorAll('.modal-card,.people-detail-modal,.analysis-detail-modal')].filter(m=>/离职人员|人员流动/.test(text(m.querySelector('h2,h3')?.textContent)))
  for(const modal of modals){const table=modal.querySelector('table');if(!table)continue;let h=labels(table),idIdx=h.names.indexOf('员工ID');if(idIdx<0)continue;const trs=[...table.querySelectorAll('tbody tr')],ids=trs.map(tr=>upper(tr.children[idIdx]?.textContent));await dates(ids)
    let hireIdx=h.names.indexOf('入职日期'),resignIdx=h.names.indexOf('离职日期')
    if(hireIdx<0||resignIdx<0){const first=h.hs[0];if(!first||!text(first.textContent).includes('日期'))continue;first.textContent='入职日期';first.classList.add('wfh-hire-date-col');const th=document.createElement('th');th.textContent='离职日期';th.className='wfh-resign-date-col';first.after(th);for(const tr of trs){const old=tr.children[0],oldDate=text(old?.textContent).match(/\d{4}-\d{2}-\d{2}/)?.[0]||'';const id=upper(tr.children[idIdx]?.textContent),d=cache.get(id)||{};if(old){old.textContent=d.hire||'—';old.classList.add('wfh-hire-date-col');const td=document.createElement('td');td.className='wfh-resign-date-col';td.textContent=d.resign||oldDate||'—';old.after(td)}}h=labels(table);hireIdx=h.names.indexOf('入职日期');resignIdx=h.names.indexOf('离职日期');idIdx=h.names.indexOf('员工ID')}
    for(const tr of trs){const id=upper(tr.children[idIdx]?.textContent),d=cache.get(id)||{};if(tr.children[hireIdx])tr.children[hireIdx].textContent=d.hire||'—';if(tr.children[resignIdx])tr.children[resignIdx].textContent=d.resign||text(tr.children[resignIdx].textContent)||'—'}
  }
}

function moveArchiveButtons(){const actions=document.querySelector('.archive-filter-actions'),advanced=document.querySelector('.v24-advanced-filter-grid');if(actions&&advanced&&actions.previousElementSibling!==advanced)advanced.insertAdjacentElement('afterend',actions)}
function moveResignButtons(){
  if(!resignTabActive())return
  const root=document.querySelector('.resignation-card-pro');if(!root)return
  const query=root.querySelector('.resignation-query-action')||[...root.querySelectorAll('button')].find(b=>text(b.textContent)==='查询')
  const reset=[...root.querySelectorAll('button')].find(b=>text(b.textContent)==='重置');const panel=root.querySelector('.v25-resignation-filter-panel');if(!query||!reset||!panel)return
  let row=panel.querySelector(':scope > .wfh-resign-action-row');if(!row){row=document.createElement('div');row.className='wfh-resign-action-row';panel.appendChild(row)}row.append(query,reset)
}
function horizontalRowActions(){for(const box of document.querySelectorAll('.employee-master-table .row-actions')){box.style.display='flex';box.style.flexDirection='row';box.style.flexWrap='nowrap';box.style.gap='6px'}}
function forceArchiveGradeReload(e){if(!e.target.closest('.wfh-employee-risk-filter .wfh-grade-menu button'))return;setTimeout(()=>{const grid=document.querySelector('.employee-core-search-grid');const label=[...(grid?.querySelectorAll('label')||[])].find(x=>text(x.querySelector('span')?.textContent)==='员工ID'),input=label?.querySelector('input');if(!input)return;const current=input.value||'';nativeSet(input,current+' ');setTimeout(()=>nativeSet(input,current),70)},90)}

async function run(){if(stopped)return;scheduled=false;moveArchiveButtons();moveResignButtons();horizontalRowActions();await fixResignRecordDates();await fixResignModalDates()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,180)}
export function startUiPolishV2713Fix(){if(window.__WFH_UI_POLISH_V2713_FIX__)return;window.__WFH_UI_POLISH_V2713_FIX__=true;document.addEventListener('click',forceArchiveGradeReload,true);const o=new MutationObserver(schedule);o.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});schedule();window.addEventListener('beforeunload',()=>{stopped=true;o.disconnect();document.removeEventListener('click',forceArchiveGradeReload,true)},{once:true})}
