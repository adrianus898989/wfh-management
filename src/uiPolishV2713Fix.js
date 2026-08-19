import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const dateCache=new Map()
let stopped=false,scheduled=false

function addStyles(){
  if(document.getElementById('wfh-resign-urgent-fix'))return
  const s=document.createElement('style');s.id='wfh-resign-urgent-fix';s.textContent=`
    .v25-resignation-filter-panel{grid-template-columns:120px 150px minmax(160px,.9fr) minmax(160px,.9fr) minmax(165px,.9fr) minmax(185px,1.05fr) minmax(285px,1.45fr) auto!important;gap:10px!important;align-items:end!important;padding-bottom:10px!important}
    .v25-resignation-filter-panel .resign-filter-field{min-width:0!important}
    .v25-resignation-filter-panel input,.v25-resignation-filter-panel select,.v25-resignation-filter-panel .pro-input-shell,.v25-resignation-filter-panel .pro-date-range{height:38px!important;min-height:38px!important}
    .v25-resignation-filter-panel .resign-filter-field>span{font-size:9px!important;margin-bottom:4px!important}
    .v25-resignation-filter-panel .v25-resign-actions{grid-column:auto!important;display:flex!important;justify-content:flex-end!important;align-items:end!important;gap:7px!important;min-height:38px!important;margin:0!important;padding:0!important;border:0!important;white-space:nowrap!important}
    .v25-resignation-filter-panel .v25-resign-actions button{height:38px!important;min-width:68px!important;padding:0 14px!important;border-radius:9px!important}
    .resignation-history-table-wrap{margin-top:0!important}
    .resignation-table-pro th,.resignation-table-pro td{white-space:nowrap!important}
    .resignation-table-pro .wfh-hire-date-col{min-width:102px!important;width:102px!important}
    .resignation-table-pro .wfh-resign-date-col{min-width:102px!important;width:102px!important}
    @media(max-width:1550px){.v25-resignation-filter-panel{grid-template-columns:110px 135px minmax(145px,.8fr) minmax(145px,.8fr) minmax(145px,.8fr) minmax(165px,.95fr) minmax(250px,1.35fr) auto!important;gap:8px!important}}
    @media(max-width:1250px){.v25-resignation-filter-panel{grid-template-columns:repeat(4,minmax(0,1fr))!important}.v25-resignation-filter-panel .v25-resign-actions{grid-column:4!important}}
  `;document.head.appendChild(s)
}
function headers(table){const hs=[...table.querySelectorAll('thead th')];return{hs,names:hs.map(h=>text(h.textContent).replace(/[↕↑↓]/g,'').trim())}}
async function loadDates(ids){const need=[...new Set(ids.map(upper).filter(Boolean))].filter(id=>!dateCache.has(id));if(!need.length)return;const {data,error}=await supabase.functions.invoke('admin-employee-dates',{body:{employee_nos:need}});if(error)return;for(const r of data?.rows||[])dateCache.set(upper(r.employee_no),{hire:text(r.hire_date).slice(0,10),resign:text(r.resign_date).slice(0,10)});need.forEach(id=>{if(!dateCache.has(id))dateCache.set(id,{hire:'',resign:''})})}
function cleanLegacyInjectedColumns(table){
  const h=headers(table),hireIndexes=[];h.names.forEach((n,i)=>{if(n==='入职日期')hireIndexes.push(i)})
  if(hireIndexes.length<=1)return
  for(let k=hireIndexes.length-1;k>=1;k--){const idx=hireIndexes[k];table.querySelectorAll('tr').forEach(tr=>{if(tr.children[idx])tr.children[idx].remove()})}
}
async function ensureSingleHireDate(){
  const table=document.querySelector('.resignation-table-pro');if(!table)return
  cleanLegacyInjectedColumns(table)
  let h=headers(table);let resignIdx=h.names.indexOf('离职日期'),idIdx=h.names.indexOf('员工ID');if(resignIdx<0||idIdx<0)return
  if(h.names.indexOf('入职日期')<0){const th=document.createElement('th');th.textContent='入职日期';th.className='wfh-hire-date-col';h.hs[resignIdx].before(th);h=headers(table);resignIdx=h.names.indexOf('离职日期');idIdx=h.names.indexOf('员工ID')}
  const hireIdx=h.names.indexOf('入职日期'),rows=[...table.querySelectorAll('tbody tr')]
  const ids=[]
  for(const tr of rows){const missing=tr.children.length===h.hs.length-1;const actualIdIdx=missing?idIdx-1:idIdx;const id=upper(tr.children[actualIdIdx]?.textContent);if(id)ids.push(id)}
  await loadDates(ids)
  for(const tr of rows){let missing=tr.children.length===h.hs.length-1;let actualIdIdx=missing?idIdx-1:idIdx;let id=upper(tr.children[actualIdIdx]?.textContent);if(missing){const actualResignIdx=resignIdx-1;const td=document.createElement('td');td.className='wfh-hire-date-col';tr.children[actualResignIdx]?.before(td);missing=false;actualIdIdx=idIdx;id=upper(tr.children[actualIdIdx]?.textContent)}const d=dateCache.get(id)||{};if(tr.children[hireIdx]){tr.children[hireIdx].textContent=d.hire||'—';tr.children[hireIdx].classList.add('wfh-hire-date-col')}if(tr.children[resignIdx])tr.children[resignIdx].classList.add('wfh-resign-date-col')}
}
function keepEmployeeActionsHorizontal(){for(const box of document.querySelectorAll('.employee-master-table .row-actions')){box.style.display='flex';box.style.flexDirection='row';box.style.flexWrap='nowrap';box.style.gap='6px';box.style.alignItems='center'}}
async function run(){if(stopped)return;scheduled=false;keepEmployeeActionsHorizontal();await ensureSingleHireDate()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,150)}
export function startUiPolishV2713Fix(){if(window.__WFH_RESIGN_URGENT_FIX__)return;window.__WFH_RESIGN_URGENT_FIX__=true;addStyles();const o=new MutationObserver(schedule);o.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});schedule();window.addEventListener('beforeunload',()=>{stopped=true;o.disconnect()},{once:true})}
