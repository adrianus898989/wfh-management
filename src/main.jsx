import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import appStyles from './styles.css?inline'

// GitHub Pages 上强制把完整 CSS 跟随 JS 一起加载。
// 这样即使外部 CSS 资源被缓存/延迟/请求异常，页面也不会变成裸 HTML。
const existing = document.querySelector('style[data-wfh-inline-styles]')
if (existing) existing.remove()

const style = document.createElement('style')
style.setAttribute('data-wfh-inline-styles', 'true')
style.textContent = appStyles
document.head.appendChild(style)

document.documentElement.setAttribute('data-wfh-ui-build', 'inline-style-v1')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename="/wfh-management">
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
