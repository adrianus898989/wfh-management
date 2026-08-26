import React from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAdminI18n } from '../lib/adminI18n'
import AdminCompanyAssetsPage from './AdminCompanyAssetsPage'

const WORK_PAGES = {
  '': {
    title:'事件跟踪表',
    description:'模块入口已经建立；事件字段、负责人流程和状态规则确认后再接入真实数据。',
  },
  'daily-inspection': {
    title:'每日巡视项目日报记录表',
    description:'模块入口已经建立；巡视项目、提交人和日报格式确认后再接入真实数据。',
  },
  'quality-inspection': {
    title:'质检日报记录表',
    description:'模块入口已经建立；后续可按出款抽查、彩金抽查和客服抽查区分记录。',
  },
}

export default function AdminPlanningPage({ section }) {
  const { t } = useAdminI18n()
  const [params] = useSearchParams()
  if (section === 'account-usage') return <AdminCompanyAssetsPage/>
  const pages = WORK_PAGES
  const page = pages[params.get('tab') || ''] || pages['']

  return <div className="content-page admin-planning-page">
    <div className="module-title-row">
      <div>
        <div className="module-kicker">PLANNED MODULE</div>
        <h1>{t(page.title)}</h1>
        <p className="page-subtitle">{t('菜单入口已建立，现有功能和数据不会受到影响。')}</p>
      </div>
      <span className="module-stage-badge">{t('规划中')}</span>
    </div>
    <section className="admin-planning-card">
      <div className="admin-planning-icon" aria-hidden="true">规</div>
      <div>
        <h2>{t('等待需求确认')}</h2>
        <p>{t(page.description)}</p>
      </div>
    </section>
  </div>
}
