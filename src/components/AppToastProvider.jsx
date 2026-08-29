import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createAppToast, enqueueAppToast } from '../lib/appToast'
import '../styles-app-toast.css'

const AppToastContext = createContext(null)

function AppToastItem({ toast, onDismiss }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.durationMs)
    return () => window.clearTimeout(timer)
  }, [toast.id, toast.createdAt, toast.durationMs, onDismiss])

  const retry = async () => {
    if (typeof toast.retry !== 'function') return
    // A retry callback is supplied only when the caller knows the action is
    // safe. Remove the stale failure first so a repeated failure can publish a
    // fresh, deduplicated toast with a full display interval.
    onDismiss(toast.id)
    try { await toast.retry() } catch (_) {
      // The owning page keeps its durable error surface and owns retry errors.
    }
  }

  const isError = toast.type === 'error'
  return <section
    className={`app-toast ${isError ? 'is-error' : 'is-success'}`}
    role={isError ? 'alert' : 'status'}
    aria-live={isError ? 'assertive' : 'polite'}
    aria-atomic="true"
  >
    <span className="app-toast-icon" aria-hidden="true">{isError ? '!' : '✓'}</span>
    <div className="app-toast-copy">
      <strong>{toast.module} · {toast.operation}{isError ? '失败' : '成功'}</strong>
      <p>{toast.reason}</p>
      {toast.retry && <button type="button" className="app-toast-retry" onClick={retry}>{toast.retryLabel}</button>}
    </div>
    <button type="button" className="app-toast-close" aria-label="关闭提示" onClick={() => onDismiss(toast.id)}>×</button>
  </section>
}

export function AppToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const dismiss = useCallback(id => {
    setToasts(current => current.filter(item => item.id !== id))
  }, [])
  const notify = useCallback(input => {
    const toast = createAppToast(input)
    setToasts(current => enqueueAppToast(current, toast))
    return toast.id
  }, [])
  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss])

  return <AppToastContext.Provider value={value}>
    {children}
    <div className="app-toast-viewport" aria-label="操作提示">
      {toasts.map(toast => <AppToastItem key={toast.id} toast={toast} onDismiss={dismiss}/>) }
    </div>
  </AppToastContext.Provider>
}

export function useAppToast() {
  const context = useContext(AppToastContext)
  if (!context) throw new Error('useAppToast must be used inside AppToastProvider')
  return context
}
