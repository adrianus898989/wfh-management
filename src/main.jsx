import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import appStyles from './styles.css?inline'
import proStyles from './styles-pro.css?inline'
import reportsStyles from './styles-reports.css?inline'
import employeeV27Styles from './styles-employee-v27.css?inline'
import './stable-layout-hotfix.css'
import './report-overview-v2712.css'
import './ui-v2714.css'
import './ui-v2714-hotfix.css'
import './adminCompactV2716.css'
import './adminFinalV2722-hotfix.css'
import './styles-exams.css'
import { startStableErrorUiEnhancer } from './stableErrorUiEnhancer'
import { startReportWorkloadEnhancerV2714 } from './reportWorkloadEnhancerV2714'
import { startUiPolishV2713Enhancer } from './uiPolishV2713Enhancer'
import { startUiPolishV2713Fix } from './uiPolishV2713Fix'
import { startUiV2714Enhancer } from './uiV2714Enhancer'
import { startAdminCompactV2716 } from './adminCompactV2716'
import { startAdminUiV2717Fix } from './adminUiV2717Fix'
import { startAdminFinalV2722 } from './adminFinalV2722'

for (const old of document.querySelectorAll('style[data-wfh-inline-styles],style[data-wfh-pro-styles],style[data-wfh-reports-styles],style[data-wfh-employee-v27-styles]')) old.remove()
const base = document.createElement('style'); base.setAttribute('data-wfh-inline-styles', 'true'); base.textContent = appStyles; document.head.appendChild(base)
const pro = document.createElement('style'); pro.setAttribute('data-wfh-pro-styles', 'true'); pro.textContent = proStyles; document.head.appendChild(pro)
const reports = document.createElement('style'); reports.setAttribute('data-wfh-reports-styles', 'true'); reports.textContent = reportsStyles; document.head.appendChild(reports)
const employeeV27 = document.createElement('style'); employeeV27.setAttribute('data-wfh-employee-v27-styles', 'true'); employeeV27.textContent = employeeV27Styles; document.head.appendChild(employeeV27)
const isReportsPath = window.location.pathname.includes('/admin/reports')
document.documentElement.setAttribute('data-wfh-ui-build', 'exam-v1-team-position')
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter basename="/wfh-management"><App /></BrowserRouter></React.StrictMode>)

startReportWorkloadEnhancerV2714()
startUiV2714Enhancer()

// Legacy observers are still useful when the first loaded route is employee management.
// The v27.22 final layer is path-aware and always starts last so SPA navigation cannot
// leave a report/employee page without the correct final behavior.
if (!isReportsPath) {
  startStableErrorUiEnhancer()
  startUiPolishV2713Enhancer()
  startUiPolishV2713Fix()
  startAdminCompactV2716()
  startAdminUiV2717Fix()
}
startAdminFinalV2722()
