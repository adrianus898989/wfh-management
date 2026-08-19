import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
const upper=v=>text(v).toUpperCase()
const gradeKey=value=>{const n=Number(value||0);return n>=31?'high':n>=16?'watch':n>=9?'attention':n>=1?'normal':'excellent'}
const grades={
  excellent:{label:'优秀',range:'0 错误',color:'#168a63',bg:'#ecfdf5',border:'#a7f3d0'},
  normal:{label:'正常',range:'1–8',color:'#2563a8',bg:'#eff6ff',border:'#bfdbfe'},
  attention:{label:'注意',range:'9–15',color:'#a16207',bg:'#fffbeb',border:'#fde68a'},
  watch:{label:'重点',range:'16–30',color:'#c2410c',bg:'#fff7ed',border:'#fed7aa'},
  high:{label:'高频',range:'31+',color:'#b42334',bg:'#fff1f2',border:'#fecdd3'},
}
const choices=[['','全部等级'],['excellent','优秀（0错误）'],['normal','正常（1–8）'],['attention','注意（9–15）'],['watch','重点（16–30）'],['high','高频（31+）']]

let stopped=false,scheduled=false,archiveGrade='',errorGrade=''
let summaryCache={at:0,map:new Map()}
let priorInvoke=null

function addStyles(){
  if(document.getElementById('wfh-grade-polish-v2715'))return
  const s=document.createElement('style');s.id='wfh-grade-polish-v2715';s.textContent=`
    .wfh-grade-picker{position:relative;min-width:0}
    .wfh-grade-trigger{width:100%;height:36px;border:1px solid #d5e0ec;border-radius:9px;background:#fff;color:#294561;padding:0 34px 0 11px;font-size:10px;font-weight:800;text-align:left;cursor:pointer;position:relative;box-shadow:0 1px 2px rgba(27,54,88,.04)}
    .wfh-grade-trigger:after{content:'⌄';position:absolute;right:11px;top:50%;transform:translateY(-54%);font-size:14px;color:#71849a}
    .wfh-grade-picker.open .wfh-grade-trigger{border-color:#4e87df;box-shadow:0 0 0 3px rgba(47,111,216,.10)}
    .wfh-grade-menu{display:none;position:absolute;z-index:5000;top:calc(100% + 5px);left:0;min-width:180px;padding:6px;border:1px solid #dce5ef;border-radius:10px;background:#fff;box-shadow:0 18px 42px rgba(22,44,75,.18)}
    .wfh-grade-picker.open .wfh-grade-menu{display:grid;gap:3px}
    .wfh-grade-menu button{height:32px;border:0;border-radius:7px;background:#fff;color:#35516f;padding:0 9px;text-align:left;font-size:10px;font-weight:750;cursor:pointer}
    .wfh-grade-menu button:hover{background:#f3f7fc}.wfh-grade-menu button.active{background:#eaf2ff;color:#145bcf}
    .wfh-grade-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:1px;background:var(--grade-color,#71849a)}
    .wfh-error-grade-slot{display:grid;gap:4px;min-width:140px}.wfh-error-grade-slot>span{font-size:9px;font-weight:750;color:#6d8098}
    .wfh-stable-risk{min-width:50px!important;height:23px!important;padding:0 8px!important;font-size:9px!important;border-radius:999px!important;box-shadow:none!important}
    .reports-page .rp-head p,.reports-page .rp-source-strip,.rp-card:has(.rp-errors-table)>.rp-card-title p,.wfh-error-unified .meta{display:none!important}
  `;document.head.appendChild(s)
}
function nativeSet(el,value,eventName='input'){if(!el)return;const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(el,value);else el.value=value;el.dispatchEvent(new Event(eventName,{bubbles:true}))}
async function summaries(force=false){if(!force&&Date.now()-summaryCache.at<20000&&summaryCache.map.size)return summaryCache.map;const {data,error}=await supabase.from('employee_error_summary').select('employee_no,month_error_count,last_30d_error_count,total_error_count').limit(5000);if(!error)summaryCache={at:Date.now(),map:new Map((data||[]).map(x=>[upper(x.employee_no),x]))};return summaryCache.map}
function makePicker(value,onChange){const root=document.createElement('div');root.className='wfh-grade-picker';const trigger=document.createElement('button');trigger.type='button';trigger.className='wfh-grade-trigger';const menu=document.createElement('div');menu.className='wfh-grade-menu';const render=()=>{const c=choices.find(x=>x[0]===value)||choices[0],m=grades[value];trigger.innerHTML=`${m?`<i class="wfh-grade-dot" style="--grade-color:${m.color}"></i>`:''}${c[1]}`;[...menu.children].forEach((b,i)=>b.classList.toggle('active',choices[i][0]===value))};choices.forEach(([k,l])=>{const b=document.createElement('button');b.type='button';b.textContent=l;b.addEventListener('click',e=>{e.stopPropagation();value=k;render();root.classList.remove('open');onChange(k)});menu.appendChild(b)});trigger.addEventListener('click',e=>{e.stopPropagation();document.querySelectorAll('.wfh-grade-picker.open').forEach(x=>{if(x!==root)x.classList.remove('open')});root.classList.toggle('open')});root.append(trigger,menu);render();return root}
function employeeIdInput(){const grid=document.querySelector('.employee-core-search-grid');for(const l of grid?.querySelectorAll('label')||[])if(text(l.querySelector('span')?.textContent)==='员工ID')return l.querySelector('input');return null}
function forceEmployeeReload(){const input=employeeIdInput();if(!input)return;const cur=input.value||'';nativeSet(input,cur+' ');setTimeout(()=>nativeSet(input,cur),90)}
function ensureEmployeePicker(){const box=document.querySelector('.wfh-employee-risk-filter');if(!box||box.dataset.cleanGrade==='1')return;box.dataset.cleanGrade='1';box.replaceChildren();const title=document.createElement('span');title.textContent='等级';box.append(title,makePicker(archiveGrade,v=>{archiveGrade=v;forceEmployeeReload()}))}
function errorParts(){const card=[...document.querySelectorAll('.rp-card')].find(x=>text(x.querySelector('.rp-card-title h2')?.textContent)==='员工错误统计');return{card,order:card?.querySelector('.rp-order-toolbar')}}
function ensureErrorPicker(){const advanced=document.querySelector('.wfh-error-unified .wfh-error-advanced');if(!advanced||advanced.querySelector('.wfh-error-grade-slot'))return;const slot=document.createElement('label');slot.className='wfh-error-grade-slot';const t=document.createElement('span');t.textContent='等级';slot.append(t,makePicker(errorGrade,v=>{errorGrade=v;errorParts().order&&[...errorParts().order.querySelectorAll('button')].find(b=>text(b.textContent)==='查询')?.click()}));advanced.insertBefore(slot,advanced.firstChild)}
function patchInvoke(){if(supabase.functions.__wfhGradeCleanPatched)return;priorInvoke=supabase.functions.invoke.bind(supabase.functions);supabase.functions.invoke=async(name,options={})=>{const body=options?.body||{};if(name==='admin-employees'&&body.action==='list'&&archiveGrade)return priorInvoke('admin-employee-risk-list',{...options,body:{...body,risk_level:archiveGrade,filters:{...(body.filters||{}),risk_level:archiveGrade}}});if(name==='admin-reports'&&body.action==='errors'&&errorGrade)return priorInvoke('admin-report-errors',{...options,body:{...body,risk_level:errorGrade}});if(name==='admin-report-errors'&&errorGrade)return priorInvoke(name,{...options,body:{...body,risk_level:errorGrade}});return priorInvoke(name,options)};supabase.functions.__wfhGradeCleanPatched=true}
async function regrade(){const map=await summaries();for(const table of document.querySelectorAll('.employee-master-table,.rp-errors-table')){for(const tr of table.querySelectorAll('tbody tr')){const chip=tr.querySelector('.wfh-stable-risk');if(!chip)continue;const cell=chip.closest('td'),id=upper(cell?.nextElementSibling?.querySelector('button')?.textContent||cell?.nextElementSibling?.textContent);if(!id)continue;const n=Number(map.get(id)?.month_error_count||0),k=gradeKey(n),m=grades[k];chip.textContent=m.label;chip.title=`${m.label} · ${m.range} · 本月 ${n} 笔`;chip.style.setProperty('--risk-color',m.color);chip.style.setProperty('--risk-bg',m.bg);chip.style.setProperty('--risk-border',m.border);chip.dataset.key=k;chip.dataset.count=String(n);if(table.classList.contains('employee-master-table')&&k==='excellent'){chip.classList.remove('is-clickable');chip.style.cursor='default'}}const th=table.querySelector('.wfh-risk-head');if(th)th.title='优秀 0 / 正常 1–8 / 注意 9–15 / 重点 16–30 / 高频 31+'}}
function resetGrade(e){const b=e.target.closest('button');if(!b||text(b.textContent)!=='重置')return;if(b.closest('.archive-filter-actions')){archiveGrade='';const box=document.querySelector('.wfh-employee-risk-filter');if(box){box.dataset.cleanGrade='';setTimeout(()=>{ensureEmployeePicker();forceEmployeeReload()},0)}}if(b.closest('.wfh-error-unified')){errorGrade='';const s=document.querySelector('.wfh-error-grade-slot');s?.remove();setTimeout(ensureErrorPicker,0)}}
async function run(){if(stopped)return;scheduled=false;ensureEmployeePicker();ensureErrorPicker();await regrade()}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,130)}
export function startUiPolishV2713Enhancer(){if(window.__WFH_GRADE_CLEAN_V2715__)return;window.__WFH_GRADE_CLEAN_V2715__=true;addStyles();patchInvoke();document.addEventListener('click',e=>{if(!e.target.closest('.wfh-grade-picker'))document.querySelectorAll('.wfh-grade-picker.open').forEach(x=>x.classList.remove('open'));resetGrade(e)},true);const o=new MutationObserver(schedule);o.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});const timer=setInterval(()=>{summaryCache.at=0;schedule()},30000);schedule();window.addEventListener('beforeunload',()=>{stopped=true;clearInterval(timer);o.disconnect()},{once:true})}
