import React from 'react'
import {
  managementRiskBand,
  managementRiskIncidentTotal,
  managementRiskOptions,
  managementRiskOrganizationRows,
  managementRiskRowName,
  managementRiskTrendRows,
} from '../lib/managementRiskPresentation'

const text=value=>String(value??'').trim()
const number=value=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:0}
const percent=value=>`${number(value).toFixed(number(value)>=10?1:2).replace(/\.0$/,'')}%`
const dateTime=value=>{
  if(!value)return ''
  const parsed=new Date(value)
  return Number.isNaN(parsed.getTime())?text(value):parsed.toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})
}
const scoreMethodText=value=>{
  if(!value||typeof value!=='object')return text(value)
  return '员工错误、出勤异常和扣款按当前人数换算；考试按已评分试卷的不及格率换算；四项合成 0–100 关注分。'
}
const sampleMethodText=value=>{
  if(!value||typeof value!=='object')return text(value)
  const headcount=number(value.headcount_warning_below)
  const exams=number(value.exam_warning_below_attempts)
  const events=number(value.event_warning_for_positive_events_below)
  const rules=[]
  if(headcount)rules.push(`人数少于 ${headcount} 人`)
  if(exams)rules.push(`已评分考试少于 ${exams} 份`)
  if(events)rules.push(`有效事件少于 ${events} 笔`)
  return `${rules.join('、')||'人数或考试样本不足'}时标记“样本不足”，不据此判断管理表现。`
}
const organizationCount=row=>number(row.employee_count??row.headcount??row.employees)
const affectedCount=row=>number(row.affected_employees??row.at_risk_employees??row.people_with_events??row.observed_employees)
const perHundred=row=>number(row.negative_rate_per_100??row.incident_rate_per_100??row.events_per_100??row.rate_per_100)
  || number(row.negative_events)*100/Math.max(1,organizationCount(row))
const issueName=row=>text(row.issue_type||row.issue||row.label||row.name)||'未分类问题'
const issueCount=row=>number(row.event_count??row.count??row.incidents)

const MANAGER_ROLES={responsible:'负责人',onsite_trainer:'现场培训',online_leader:'线上组长',online_trainer:'线上培训'}
const managerRole=value=>MANAGER_ROLES[text(value)]||text(value)||'负责人 / 老师'

function RiskCombo({value,options,onChange,placeholder,id}){
  return <><input list={id} value={value||''} onChange={event=>onChange(event.target.value)} placeholder={placeholder}/><datalist id={id}>{options.map(option=><option key={option} value={option}/>)}</datalist></>
}

function RiskKpi({label,value,hint}){
  return <article><span>{label}</span><strong>{value??0}</strong><small>{hint}</small></article>
}

function RiskScore({row}){
  const meta=managementRiskBand(row)
  return <span className={`management-risk-score ${meta.className}`} title={meta.title}><strong>{Math.round(number(row.risk_score))}</strong><em>{meta.label}</em></span>
}

export default function ManagementRiskPanel({data,filters,setFilters,dimension,setDimension,onQuery,onReset,onRange,onOpenEmployee}){
  const summary=data.summary||{}
  const period=data.period||{}
  const scope=data.scope||{}
  const methodology=data.methodology||{}
  const organizationRows=managementRiskOrganizationRows(data,dimension)
  const repeatRows=Array.isArray(data.repeat_employees)?data.repeat_employees:[]
  const issueRows=Array.isArray(data.common_issues)?data.common_issues:[]
  const trendRows=managementRiskTrendRows(data)
  const teamOptions=managementRiskOptions(data,'teams')
  const groupOptions=managementRiskOptions(data,'groups',{team:filters.team})
  const managerOptions=managementRiskOptions(data,'managers',{
    team:filters.team,group:filters.group,manager_role:filters.manager_role,
  })
  const trendMax=Math.max(1,...trendRows.map(row=>managementRiskIncidentTotal(row)))
  const organizationLabels={teams:'团队',groups:'组别',managers:'组长 / 老师'}
  const syncAt=text(scope.roster_refreshed_at||scope.refreshed_at||data.roster_refreshed_at)

  return <section className="management-risk-page">
    <div className="management-risk-intro">
      <div><span>MANAGEMENT SIGNALS</span><h2>管理风险分析</h2><p>按最新居家排班，把错误、考试不及格、出勤异常和扣款重新归属到当前团队、组别、负责人及培训老师。</p></div>
      <aside><strong>仅作管理关注信号</strong><span>排行用于找出需要复核的组织与人员，不代表组长或老师已经管理失职。</span></aside>
    </div>

    <div className="management-risk-filter-panel">
      <label><span>日期区间</span><div className="management-risk-date-range"><input type="date" value={filters.date_from} onChange={event=>setFilters({...filters,date_from:event.target.value})}/><b>—</b><input type="date" value={filters.date_to} onChange={event=>setFilters({...filters,date_to:event.target.value})}/></div></label>
      <label><span>当前团队</span><RiskCombo id="risk-team-options" value={filters.team} options={teamOptions} onChange={value=>setFilters({...filters,team:value,group:'',manager:''})} placeholder="全部当前团队"/></label>
      <label><span>当前组别</span><RiskCombo id="risk-group-options" value={filters.group} options={groupOptions} onChange={value=>setFilters({...filters,group:value,manager:''})} placeholder="全部当前组别"/></label>
      <label><span>负责人类型</span><select value={filters.manager_role} onChange={event=>setFilters({...filters,manager_role:event.target.value,manager:''})}><option value="">全部负责人 / 老师</option>{Object.entries(MANAGER_ROLES).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
      <label><span>负责人 / 老师</span><RiskCombo id="risk-manager-options" value={filters.manager} options={managerOptions} onChange={value=>setFilters({...filters,manager:value})} placeholder="输入姓名"/></label>
      <label><span>员工</span><input value={filters.employee_search} onChange={event=>setFilters({...filters,employee_search:event.target.value})} placeholder="员工 ID / 姓名"/></label>
      <div className="management-risk-filter-actions"><div><button type="button" onClick={()=>onRange('30d')} disabled={data.loading}>近30天</button><button type="button" onClick={()=>onRange('90d')} disabled={data.loading}>近90天</button><button type="button" onClick={()=>onRange('month')} disabled={data.loading}>本月</button></div><button type="button" className="secondary-action" onClick={onReset} disabled={data.loading}>重置</button><button type="button" className="primary-action" onClick={onQuery} disabled={data.loading}>{data.loading?'分析中…':'查询'}</button></div>
    </div>

    {data.loading&&!organizationRows.length?<div className="management-risk-loading" role="status"><i/><span>正在按当前组织关系汇总风险…</span></div>:<>
      <div className="management-risk-meta-row"><span>统计期：{period.from||filters.date_from||'—'} → {period.to||filters.date_to||'—'} · {period.days||'—'} 天</span><span>当前排班 {scope.roster_employees??summary.employees??0} 人{syncAt?` · 更新 ${dateTime(syncAt)}`:''}</span></div>

      <div className="management-risk-kpis">
        <RiskKpi label="当前范围员工" value={summary.employees??scope.matched_employees??0} hint={`排班匹配 ${scope.matched_employees??summary.employees??0} 人`}/>
        <RiskKpi label="需关注人员" value={summary.at_risk_employees??summary.affected_employees??0} hint={`惯犯 ${summary.repeat_employees??summary.repeat_offenders??repeatRows.length} 人`}/>
        <RiskKpi label="员工错误" value={summary.error_events??0} hint={`每百人 ${number(summary.error_rate_per_100).toFixed(1)}`}/>
        <RiskKpi label="考试不及格" value={summary.exam_failures??0} hint={`${summary.graded_exams??0} 份已评分 · ${percent(summary.exam_failure_rate_pct??0)}`}/>
        <RiskKpi label="出勤异常" value={summary.attendance_issues??0} hint={`每百人 ${number(summary.attendance_rate_per_100).toFixed(1)}`}/>
        <RiskKpi label="扣款记录" value={summary.deductions??0} hint={`每百人 ${number(summary.deduction_rate_per_100).toFixed(1)}`}/>
      </div>

      <div className="management-risk-methodology"><strong>公平比较口径</strong><span>{scoreMethodText(methodology.score_formula)||'四类问题按人数 / 考试次数归一化后合成 0–100 关注分。'}</span><span>{sampleMethodText(methodology.min_sample_rules||methodology.minimum_sample_rules)||'人数或考试样本不足时只显示“样本不足”，不据此判断管理表现。'}</span></div>

      <section className="management-risk-card management-risk-organization-card">
        <div className="management-risk-card-head"><div><h3>组织风险排行</h3><p>总量与每百人发生率同时展示，避免人数多的团队天然排在前面。</p></div><div className="management-risk-dimension-tabs">{Object.entries(organizationLabels).map(([key,label])=><button type="button" key={key} className={dimension===key?'active':''} onClick={()=>setDimension(key)}>{label}</button>)}</div></div>
        <div className="management-risk-table-wrap"><table><thead><tr><th>{organizationLabels[dimension]}</th><th>当前人数</th><th>涉及员工</th><th>员工错误</th><th>考试不及格</th><th>出勤异常</th><th>扣款</th><th>每百人事件</th><th>关注分</th></tr></thead><tbody>{organizationRows.map((row,index)=><tr key={`${dimension}-${managementRiskRowName(row,dimension)}-${index}`}><td><strong>{managementRiskRowName(row,dimension)}</strong>{dimension!=='teams'&&<small>{text(row.team_name)||'跨团队'}{dimension==='managers'&&text(row.manager_role)?` · ${managerRole(row.manager_role)}`:''}</small>}</td><td>{organizationCount(row)}</td><td>{affectedCount(row)}</td><td>{number(row.error_events)}</td><td>{number(row.exam_failures)}<small>{row.graded_exams!=null?` / ${row.graded_exams} 份`:''}</small></td><td>{number(row.attendance_issues)}</td><td>{number(row.deductions)}</td><td><strong>{perHundred(row).toFixed(1)}</strong></td><td><RiskScore row={row}/></td></tr>)}</tbody></table></div>
        {!organizationRows.length&&<div className="empty-state">当前筛选没有可比较的{organizationLabels[dimension]}数据</div>}
      </section>

      <div className="management-risk-detail-grid">
        <section className="management-risk-card repeat-offender-card">
          <div className="management-risk-card-head"><div><h3>惯犯 / 高频人员名单</h3><p>按当前组织归属展示；点击员工可核对完整档案与原始记录。</p></div><span>{repeatRows.length} 人</span></div>
          <div className="management-risk-table-wrap"><table><thead><tr><th>员工</th><th>当前归属</th><th>错误</th><th>不及格</th><th>出勤</th><th>扣款</th><th>合计</th><th>关注分</th><th>操作</th></tr></thead><tbody>{repeatRows.map((row,index)=><tr key={row.employee_id||`${row.employee_no}-${index}`}><td><strong>{row.employee_no||'—'}</strong><small>{row.full_name||'—'}</small></td><td><strong>{row.team_name||'未设置团队'}</strong><small>{row.group_name||'未设置组别'} · {row.manager_name||row.online_leader||row.responsible||row.online_trainer||row.onsite_trainer||'未设置负责人'}</small></td><td>{number(row.error_events)}</td><td>{number(row.exam_failures)}</td><td>{number(row.attendance_issues)}</td><td>{number(row.deductions)}</td><td><strong>{managementRiskIncidentTotal(row)}</strong></td><td><RiskScore row={row}/></td><td>{row.employee_id?<button type="button" className="table-action" onClick={()=>onOpenEmployee(row)}>查看档案</button>:'—'}</td></tr>)}</tbody></table></div>
          {!repeatRows.length&&<div className="empty-state">当前区间没有达到惯犯阈值的员工</div>}
        </section>

        <section className="management-risk-card common-risk-card">
          <div className="management-risk-card-head"><div><h3>经常发生的问题</h3><p>先处理重复发生且覆盖员工较多的问题。</p></div><span>{issueRows.length} 类</span></div>
          <div className="management-risk-issue-list">{issueRows.map((row,index)=>{const count=issueCount(row);return <article key={`${issueName(row)}-${index}`}><div><span>{text(row.category_label||row.category)||'问题'}</span><strong title={issueName(row)}>{issueName(row)}</strong><small>涉及 {number(row.employee_count??row.affected_employees)} 人</small></div><em>{count} 次</em><i style={{width:`${Math.max(3,Math.min(100,count/Math.max(1,issueCount(issueRows[0]))*100))}%`}}/></article>})}</div>
          {!issueRows.length&&<div className="empty-state">当前区间没有问题记录</div>}
        </section>
      </div>

      <section className="management-risk-card management-risk-trend-card">
        <div className="management-risk-card-head"><div><h3>问题发生趋势</h3><p>观察问题是否集中在特定日期或持续重复发生。</p></div><span>{trendRows.length} 个时间点</span></div>
        <div className="management-risk-trend">{trendRows.map((row,index)=>{const total=managementRiskIncidentTotal(row);const label=text(row.date||row.period_start||row.week_start||row.bucket)||'—';return <div key={label||index}><span>{label}{row.week_end?` → ${text(row.week_end)}`:''}</span><div><i className="error" style={{width:`${number(row.error_events)/trendMax*100}%`}}/><i className="exam" style={{width:`${number(row.exam_failures)/trendMax*100}%`}}/><i className="attendance" style={{width:`${number(row.attendance_issues)/trendMax*100}%`}}/><i className="deduction" style={{width:`${number(row.deductions)/trendMax*100}%`}}/></div><strong>{total}</strong></div>})}</div>
        {!trendRows.length&&<div className="empty-state">当前区间没有趋势数据</div>}
        <div className="management-risk-trend-legend"><span className="error">员工错误</span><span className="exam">考试不及格</span><span className="attendance">出勤异常</span><span className="deduction">扣款</span></div>
      </section>
    </>}
  </section>
}
