import React from 'react'
import { APP_BASE_URL } from '../lib/appBasePath'

const RECOVERY_KEY = 'wfh_runtime_recovery_at'

const errorText = error => String(error?.message || error || '')
const recoverableAssetError = error => /chunkloaderror|loading chunk|failed to fetch dynamically imported module|importing a module script failed|preload/i.test(errorText(error))

const reloadWithFreshEntry = ({ force = false } = {}) => {
  const now = Date.now()
  const last = Number(sessionStorage.getItem(RECOVERY_KEY) || 0)
  if (!force && now - last < 60_000) return false
  sessionStorage.setItem(RECOVERY_KEY, String(now))
  sessionStorage.setItem('spa_redirect', `${location.pathname}${location.search}${location.hash}`)
  location.replace(`${APP_BASE_URL}?__recover=${now}`)
  return true
}

export const recoverStaleAsset = error => {
  if (!recoverableAssetError(error)) return false
  return reloadWithFreshEntry()
}

export default class AppCrashBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, details) {
    console.error('Application render failed', error, details)
    recoverStaleAsset(error)
  }

  render() {
    if (!this.state.error) return this.props.children
    const diagnostic = errorText(this.state.error).slice(0, 180) || 'unknown-render-error'
    return <main style={{minHeight:'100vh',display:'grid',placeItems:'center',padding:'24px',background:'#f4f7fb',color:'#18304f',fontFamily:'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'}}>
      <section role="alert" style={{width:'min(560px,100%)',padding:'30px',border:'1px solid #d9e3ef',borderRadius:'18px',background:'#fff',boxShadow:'0 18px 50px rgba(30,65,105,.12)'}}>
        <div style={{fontSize:'32px',marginBottom:'10px'}}>⚠</div>
        <h1 style={{fontSize:'22px',margin:'0 0 10px'}}>页面加载失败，但登录资料仍然保留</h1>
        <p style={{lineHeight:1.7,margin:'0 0 18px',color:'#62758d'}}>系统已阻止空白页面。请重新加载最新版本；如果仍然出现，请把下方错误编号发给管理员。</p>
        <button type="button" onClick={()=>reloadWithFreshEntry({force:true})} style={{border:0,borderRadius:'10px',padding:'11px 18px',background:'#2f6fe4',color:'#fff',fontWeight:700,cursor:'pointer'}}>重新加载页面</button>
        <details style={{marginTop:'18px',fontSize:'12px',color:'#7a899d'}}><summary>错误编号</summary><code style={{display:'block',marginTop:'8px',whiteSpace:'pre-wrap',wordBreak:'break-word'}}>{diagnostic}</code></details>
      </section>
    </main>
  }
}
