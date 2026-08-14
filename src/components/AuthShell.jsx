import React from 'react'
export default function AuthShell({title,subtitle,children}){return <div className="auth-page"><div className="auth-brand"><div className="brand-mark">HS</div><div><h1>居家员工管理系统</h1><p>Home Staff Management System</p></div></div><div className="auth-card"><h2>{title}</h2><p className="muted">{subtitle}</p>{children}</div></div>}
