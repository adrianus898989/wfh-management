import React from 'react'
import {Link} from 'react-router-dom'
export const AdminHome=()=> <div className="content-page"><div className="page-head"><div><p className="eyebrow">后台管理端</p><h1>控制台</h1><p>V3 已连接真实 Supabase 登录与员工账号流程。</p></div></div><div className="card-grid"><Link to="/admin/employees" className="module-card"><strong>员工 / 激活码</strong><span>生成员工专属激活码</span></Link><Link to="/security/mfa" className="module-card"><strong>Google Authenticator</strong><span>绑定谷歌验证器</span></Link></div></div>
export const StaffHome=()=> <div className="content-page"><div className="page-head"><div><p className="eyebrow">员工前端</p><h1>我的首页</h1><p>后续接工资、出勤、排班、考试与申请。</p></div></div></div>
