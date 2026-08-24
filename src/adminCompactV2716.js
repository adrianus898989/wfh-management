import { supabase } from './lib/supabase'
import { getAllErrorSummaryMap } from './lib/errorSummaryStore'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const choices=[
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
const gradeKey=value=>{
  const n=Number(value||0)
  if(n>=31)return 'high'
  if(n>=16)return 'watch'
  if(n>=9)return 'attention'
  if(n>=1)return 'normal'
  return 'excellent'
}

let stopped=false,scheduled=false,employeeGrade=null
let summaryCache={at:0,map:new Map()}

function nativeSet(el,value,eventName='change'){
  if(!el)return
  const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype
  const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set
  if(setter)setter.call(el,value);else el.value=value
  el.dispatchEvent(new Event(eventName,{bubbles:true}))
}

async function getSummaryMap(force=false){
  if(!force&&Date.now()-summaryCache.at<15000&&summaryCache.map.size)return summaryCache.map
  try{summaryCache={at:Date.now(),map:await getAllErrorSummaryMap(force)}}catch{}
  return summaryCache.map
}

function syncGradePicker(label,select){
  const picker=label.querySelector(':scope > .wfh-v2716-grade-picker')
  if(!picker)return
  const value=employeeGrade??text(select.value)
  const trigger=picker.querySelector('.wfh-v2716-grade-trigger')
  const chosen=choices.find(x=>x[0]===value)||choices[0]
  const meta=gradeMeta[value]
  trigger.innerHTML=`${meta?`<i class="wfh-v2716-grade-dot" style="--grade-color:${meta.color}"></i>`:''}${chosen[1]}`
  picker.querySelectorAll('.wfh-v2716-grade-menu button').forEach(b=>b.classList.toggle('active',b.dataset.key===value))
}

function renderGradePicker(label,select){
  let picker=label.querySelector(':scope > .wfh-v2716-grade-picker')
  if(!picker){
    picker=document.createElement('div')
    picker.className='wfh-v2716-grade-picker'
    const trigger=document.createElement('button')
    trigger.type='button'
    trigger.className='wfh-v2716-grade-trigger'
    const menu=document.createElement('div')
    menu.className='wfh-v2716-grade-menu'
    for(const [key,name] of choices){
      const b=document.createElement('button')
      b.type='button';b.dataset.key=key;b.textContent=name
      b.addEventListener('click',e=>{
        e.preventDefault();e.stopPropagation()
        employeeGrade=key
        nativeSet(select,key,'change')
        picker.classList.remove('open')
        setTimeout(()=>{syncGradePicker(label,select);schedule()},30)
      })
      menu.appendChild(b)
    }
    trigger.addEventListener('click',e=>{
      e.preventDefault();e.stopPropagation()
      document.querySelectorAll('.wfh-v2716-grade-picker.open').forEach(x=>{if(x!==picker)x.classList.remove('open')})
      picker.classList.toggle('open')
    })
    picker.append(trigger,menu)
    label.appendChild(picker)
  }
  syncGradePicker(label,select)
}

function ensureEmployeeGrade(){
  const label=document.querySelector('.employee-core-search-grid label[data-native-risk-filter="1"]')
  if(!label)return
  const select=label.querySelector('select')
  if(!select)return
  label.classList.add('wfh-v2716-grade-field')
  select.classList.add('wfh-v2716-native-grade')
  if(employeeGrade===null)employeeGrade=text(select.value)
  const expected=choices.map(([k,n])=>`<option value="${k}">${n}</option>`).join('')
  if(select.innerHTML!==expected)select.innerHTML=expected
  if(text(select.value)!==text(employeeGrade))select.value=employeeGrade||''
  renderGradePicker(label,select)
}

async function regradeTables(){
  const map=await getSummaryMap()
  for(const table of document.querySelectorAll('.employee-master-table,.rp-errors-table')){
    const head=table.querySelector('.wfh-risk-head')
    if(head){
      head.textContent='等级'
      head.title='优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+'
    }
    for(const tr of table.querySelectorAll('tbody tr')){
      const cell=tr.querySelector(':scope > .wfh-risk-cell')
      if(!cell)continue
      const chip=cell.querySelector('.wfh-stable-risk')
      const idCell=cell.nextElementSibling
      const id=upper(idCell?.querySelector('button')?.textContent||idCell?.textContent)
      if(!chip||!id)continue
      const summary=map.get(id)||null
      const n=Number(summary?.total_error_count||0)
      const key=gradeKey(n),meta=gradeMeta[key]
      chip.textContent=meta.label
      chip.title=`${meta.label} · ${meta.range} · 累计 ${n} 笔 · 本月 ${Number(summary?.month_error_count||0)} 笔 · 近30天 ${Number(summary?.last_30d_error_count||0)} 笔`
      chip.dataset.key=key;chip.dataset.count=String(n)
      chip.style.setProperty('--risk-color',meta.color)
      chip.style.setProperty('--risk-bg',meta.bg)
      chip.style.setProperty('--risk-border',meta.border)
      if(table.classList.contains('employee-master-table')&&key==='excellent'){
        chip.classList.remove('is-clickable')
        chip.style.cursor='default'
      }
    }
  }
}

function closePickers(e){
  if(e?.target?.closest?.('.wfh-v2716-grade-picker'))return
  document.querySelectorAll('.wfh-v2716-grade-picker.open').forEach(x=>x.classList.remove('open'))
}
function captureReset(e){
  const b=e.target?.closest?.('button')
  if(!b||text(b.textContent)!=='重置'||!b.closest('.archive-filter-actions'))return
  employeeGrade=''
  schedule()
}

async function run(){
  if(stopped)return
  scheduled=false
  ensureEmployeeGrade()
  await regradeTables()
}
function schedule(){
  if(stopped||scheduled)return
  scheduled=true
  setTimeout(run,80)
}

export function startAdminCompactV2716(){
  if(window.__WFH_ADMIN_COMPACT_V2716__)return
  window.__WFH_ADMIN_COMPACT_V2716__=true
  document.addEventListener('click',closePickers,true)
  document.addEventListener('click',captureReset,true)
  document.addEventListener('change',e=>{
    if(e.target?.matches?.('.employee-core-search-grid label[data-native-risk-filter="1"] select')){
      const v=text(e.target.value)
      if(choices.some(x=>x[0]===v))employeeGrade=v
      schedule()
    }
  },true)
  const observer=new MutationObserver(schedule)
  observer.observe(document.body,{subtree:true,childList:true})
  schedule()
  window.addEventListener('beforeunload',()=>{
    stopped=true;observer.disconnect();document.removeEventListener('click',closePickers,true);document.removeEventListener('click',captureReset,true)
  },{once:true})
}
