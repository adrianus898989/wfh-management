import React, { useMemo, useState } from 'react'

const CONFIG = {
  schedule: {
    title: '排班与考勤',
    tabs: ['排班表', '今日考勤', '考勤记录', '请假审批', '换班记录'],
    filters: ['员工ID / 姓名', '团队', '班次', '日期'],
  },
  daily: {
    title: '每日工作',
    tabs: ['组长日报', '培训日报', '交接事项', '异常问题', '奖惩记录'],
    filters: ['员工ID / 姓名', '团队', '负责人', '日期'],
  },
  training: {
    title: '培训与考试',
    tabs: ['概览', '考试记录', '题库', '创建考试', '人工批改', '成绩统计'],
    filters: ['员工ID / 姓名', '岗位', '考试', '日期'],
  },
  payroll: {
    title: '工资中心',
    tabs: ['工资计算', '待复核', '已发布', '工资规则', '导出记录'],
    filters: ['员工ID / 姓名', '团队', '工资月份', '状态'],
  },
  reports: {
    title: '统计报表',
    tabs: ['人员统计', '出勤统计', '工资统计', '离职率', '账号统计'],
    filters: ['团队', '岗位', '国家', '日期范围'],
  },
}

export default function ModulePage({ module }) {
  const cfg = CONFIG[module]
  const [tab, setTab] = useState(cfg.tabs[0])
  const [q, setQ] = useState('')
  const [advanced, setAdvanced] = useState(false)

  const title = useMemo(() => `${cfg.title} · ${tab}`, [cfg.title, tab])

  return (
    <div className="content-page module-page">
      <div className="module-title-row">
        <div>
          <div className="module-kicker">WFH MANAGEMENT</div>
          <h1>{cfg.title}</h1>
        </div>
      </div>

      <div className="module-tabs">
        {cfg.tabs.map(x => (
          <button key={x} className={tab === x ? 'active' : ''} onClick={() => setTab(x)}>{x}</button>
        ))}
      </div>

      <div className="filter-card">
        <div className="filter-main-row">
          <div className="search-box">
            <span>⌕</span>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder={`搜索${cfg.filters[0]}`} />
          </div>
          <button className="filter-toggle" onClick={() => setAdvanced(v => !v)}>
            {advanced ? '收起筛选' : '更多筛选'}
          </button>
        </div>

        {advanced && (
          <div className="filter-grid">
            {cfg.filters.slice(1).map(label => (
              <label key={label}>{label}
                <input placeholder={`选择/输入${label}`} />
              </label>
            ))}
          </div>
        )}
      </div>

      <div className="module-summary-grid">
        <div className="summary-card"><span>当前模块</span><strong>{tab}</strong></div>
        <div className="summary-card"><span>数据状态</span><strong>—</strong></div>
        <div className="summary-card"><span>待处理</span><strong>—</strong></div>
        <div className="summary-card"><span>异常</span><strong>—</strong></div>
      </div>

      <div className="data-card module-empty">
        <div>
          <h2>{title}</h2>
          <p>界面结构已固定，下一阶段接入真实业务数据。</p>
        </div>
      </div>
    </div>
  )
}
