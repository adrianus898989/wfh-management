import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import appStyles from './styles.css?inline'
import proStyles from './styles-pro.css?inline'
import reportsStyles from './styles-reports.css?inline'
import employeeV27Styles from './styles-employee-v27.css?inline'
import { startErrorRiskEnhancer } from './errorRiskEnhancer'
import { startReportErrorOverviewEnhancer } from './reportErrorOverviewEnhancer'
import { startErrorUxV2Enhancer } from './errorUxV2Enhancer'
import { startErrorOverviewV2Enhancer } from './errorOverviewV2Enhancer'

for (const old of document.querySelectorAll('style[data-wfh-inline-styles],style[data-wfh-pro-styles],style[data-wfh-reports-styles],style[data-wfh-employee-v27-styles]')) old.remove()
const base = document.createElement('style'); base.setAttribute('data-wfh-inline-styles', 'true'); base.textContent = appStyles; document.head.appendChild(base)
const pro = document.createElement('style'); pro.setAttribute('data-wfh-pro-styles', 'true'); pro.textContent = proStyles; document.head.appendChild(pro)
const reports = document.createElement('style'); reports.setAttribute('data-wfh-reports-styles', 'true'); reports.textContent = reportsStyles; document.head.appendChild(reports)
const employeeV27 = document.createElement('style'); employeeV27.setAttribute('data-wfh-employee-v27-styles', 'true'); employeeV27.textContent = employeeV27Styles; document.head.appendChild(employeeV27)
document.documentElement.setAttribute('data-wfh-ui-build', 'employee-v27.8-unified-error-risk')
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter basename="/wfh-management"><App /></BrowserRouter></React.StrictMode>)
startErrorRiskEnhancer()
startReportErrorOverviewEnhancer()
startErrorUxV2Enhancer()
startErrorOverviewV2Enhancer()
