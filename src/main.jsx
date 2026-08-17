import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import appStyles from './styles.css?inline'
import proStyles from './styles-pro.css?inline'
import reportsStyles from './styles-reports.css?inline'

for (const old of document.querySelectorAll('style[data-wfh-inline-styles],style[data-wfh-pro-styles],style[data-wfh-reports-styles]')) old.remove()
const base = document.createElement('style'); base.setAttribute('data-wfh-inline-styles', 'true'); base.textContent = appStyles; document.head.appendChild(base)
const pro = document.createElement('style'); pro.setAttribute('data-wfh-pro-styles', 'true'); pro.textContent = proStyles; document.head.appendChild(pro)
const reports = document.createElement('style'); reports.setAttribute('data-wfh-reports-styles', 'true'); reports.textContent = reportsStyles; document.head.appendChild(reports)
document.documentElement.setAttribute('data-wfh-ui-build', 'reports-v26')
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><BrowserRouter basename="/wfh-management"><App /></BrowserRouter></React.StrictMode>)
