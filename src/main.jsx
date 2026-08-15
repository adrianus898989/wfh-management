import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import appStyles from './styles.css?inline'
import proStyles from './styles-pro.css?inline'

// GitHub Pages 上把 CSS 跟 JS 一起加载，避免出现裸 HTML。
for (const old of document.querySelectorAll('style[data-wfh-inline-styles],style[data-wfh-pro-styles]')) {
  old.remove()
}

const base = document.createElement('style')
base.setAttribute('data-wfh-inline-styles', 'true')
base.textContent = appStyles
document.head.appendChild(base)

const pro = document.createElement('style')
pro.setAttribute('data-wfh-pro-styles', 'true')
pro.textContent = proStyles
document.head.appendChild(pro)

document.documentElement.setAttribute('data-wfh-ui-build', 'backend-preview-v9')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/wfh-management">
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
