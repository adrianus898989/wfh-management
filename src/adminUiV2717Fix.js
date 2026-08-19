import { supabase } from './lib/supabase'

const text=v=>String(v??'').trim()
let stopped=false,scheduled=false

function addStyles(){
  if(document.getElementById('wfh-admin-ui-v2718-fix'))return
  document.getElementById('wfh-admin-ui-v2717-fix')?.remove()
  const s=document.createElement('style')
  s.id='wfh-admin-ui-v2718-fix'
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

    /* Error filters: no extra standalone grade selector. Keep the original two rows balanced. */
    .wfh-error-unified{padding:10px 11px!important;gap:8px!important}
    .wfh-error-primary{gap:8px!important;align-items:end!important}
    .wfh-error-advanced{gap:8px!important;align-items:end!important;padding-top:8px!important}
    .wfh-v2717-error-grade,.wfh-error-grade-slot{display:none!important}
    @media(min-width:1400px){
      .wfh-error-primary{grid-template-columns:minmax(205px,1.35fr) 138px 138px minmax(160px,.95fr) minmax(148px,.85fr) repeat(5,auto)!important}
      .wfh-error-advanced{grid-template-columns:repeat(7,minmax(108px,1fr)) auto!important}
    }

    /* Error table: restore all original detail columns and keep balanced widths. */
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

    /* Order statistics: while scrolling right, always keep employee ID + name visible. */
    .rp-order-scroll{position:relative!important;overflow:auto!important}
    .rp-order-table{border-collapse:separate!important;border-spacing:0!important}
    .rp-order-table th:nth-child(1),.rp-order-table td:nth-child(1){
      position:sticky!important;left:0!important;z-index:5!important;
      width:104px!important;min-width:104px!important;max-width:104px!important;
      background:#fff!important;
    }
    .rp-order-table th:nth-child(2),.rp-order-table td:nth-child(2){
      position:sticky!important;left:104px!important;z-index:5!important;
      width:190px!important;min-width:190px!important;max-width:190px!important;
      background:#fff!important;
      box-shadow:8px 0 12px -12px rgba(20,48,82,.55)!important;
    }
    .rp-order-table thead th:nth-child(1),.rp-order-table thead th:nth-child(2){
      z-index:8!important;background:#f2f6fb!important;
    }
    .rp-order-table tbody tr:hover td:nth-child(1),.rp-order-table tbody tr:hover td:nth-child(2){background:#f8fbff!important}
  `
  document.head.appendChild(s)
}

function patchInvoke(){
  if(supabase.functions.__wfhV2718ErrorTotalsPatched)return
  const prior=supabase.functions.invoke.bind(supabase.functions)
  supabase.functions.invoke=async(name,options={})=>{
    const body=options?.body||{}
    const isErrorRequest=(name==='admin-report-errors')||(name==='admin-reports'&&body.action==='errors')
    const result=await prior(name,options)
    if(isErrorRequest&&result?.data&&!result?.data?.error){
      /* AdminReportsPage only applies the current-roster filter when this count is larger
         than the filtered roster. Setting it to 0 keeps the full employee-error snapshot,
         including historical/resigned staff, which is the same source users compare with. */
      return {...result,data:{...result.data,current_roster_employee_count:0}}
    }
    return result
  }
  supabase.functions.__wfhV2718ErrorTotalsPatched=true
}

function cleanupLegacyGrade(){
  document.querySelectorAll('.wfh-v2717-error-grade').forEach(x=>x.remove())
}

function run(){
  if(stopped)return
  scheduled=false
  cleanupLegacyGrade()
}
function schedule(){if(stopped||scheduled)return;scheduled=true;setTimeout(run,80)}

export function startAdminUiV2717Fix(){
  if(window.__WFH_ADMIN_UI_V2718_FIX__)return
  window.__WFH_ADMIN_UI_V2718_FIX__=true
  addStyles();patchInvoke()
  const observer=new MutationObserver(schedule)
  observer.observe(document.body,{subtree:true,childList:true})
  schedule()
  window.addEventListener('beforeunload',()=>{stopped=true;observer.disconnect()},{once:true})
}
