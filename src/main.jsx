import React,{useState} from 'react'
import ReactDOM from 'react-dom/client'
import {BrowserRouter,useNavigate,useLocation} from 'react-router-dom'
import {LayoutDashboard,Users,CalendarDays,ClipboardList,GraduationCap,WalletCards,BarChart3,Settings,Menu,ChevronDown} from 'lucide-react'
import './styles.css'

const groups=[
['控制台',LayoutDashboard,['Dashboard']],
['人员与团队',Users,['在职员工','新增 / 异动','团队管理','离职员工库']],
['排班与考勤',CalendarDays,['排班总览','考勤记录','请假 / 公休 / 回家 / 换班','轮班规则']],
['每日工作',ClipboardList,['组长日报','培训日报','问题 / 交接','出错 / 扣款 / 奖金']],
['培训与考试',GraduationCap,['考试总览','题库同步','创建 / 分配考试','批改 / 成绩']],
['工资中心',WalletCards,['工资规则 / 配置','月度工资','审核 / 发布','导出 / 修改记录']],
['统计报表',BarChart3,['团队 / 人员统计','离职率 / 人员异动','考勤 / 工作量 / 出错','工资统计']],
['系统管理',Settings,['用户与权限 / OTP','操作日志','帮助中心 / 教程','系统设置']]
]
const metrics=[['在职员工','1,248'],['今日出勤率','95.6%'],['今日请假','32'],['本月离职','18'],['待处理事项','23'],['本月工资','USD 238,450']]
function App(){
 const [mode,setMode]=useState('admin'); const [open,setOpen]=useState(new Set(['人员与团队','排班与考勤'])); const [selected,setSelected]=useState('Dashboard');
 const toggle=(g)=>{const n=new Set(open);n.has(g)?n.delete(g):n.add(g);setOpen(n)}
 return <div className="shell">
   <aside className="side">
    <div className="brand"><b>居家员工管理系统</b><small>{mode==='admin'?'ADMIN BACK OFFICE':'EMPLOYEE PORTAL'}</small></div>
    {mode==='admin'?groups.map(([g,Icon,items])=><div key={g}>
      <button className={'nav '+(selected===g?'active':'')} onClick={()=>items.length===1?setSelected(items[0]):toggle(g)}><Icon size={18}/><span>{g}</span>{items.length>1&&<ChevronDown size={15}/>}</button>
      {items.length>1&&open.has(g)&&<div className="subs">{items.map(x=><button className={selected===x?'activeSub':''} onClick={()=>setSelected(x)} key={x}>{x}</button>)}</div>}
    </div>):<>
      {['首页','我的排班 / 出勤','我的工资','我的考试','我的申请','我的资料'].map(x=><button className="nav" key={x} onClick={()=>setSelected(x)}>{x}</button>)}
    </>}
   </aside>
   <main>
    <header><div><h2>{selected}</h2><p>{mode==='admin'?'后台管理端':'员工前端'}</p></div><button className="switch" onClick={()=>{setMode(mode==='admin'?'staff':'admin');setSelected(mode==='admin'?'首页':'Dashboard')}}>{mode==='admin'?'员工前端预览':'返回后台'}</button></header>
    <section className="content">
      {selected==='Dashboard'?<>
       <div className="title"><div><span>后台管理端</span><h1>控制台 Dashboard</h1><p>只显示需要关注的核心信息；详细内容进入对应模块。</p></div><div className="pill">Supabase 尚未配置</div></div>
       <div className="metrics">{metrics.map(([a,b])=><div className="card" key={a}><small>{a}</small><strong>{b}</strong></div>)}</div>
       <div className="grid">
        <div className="panel wide"><h3>团队实时统计</h3><table><thead><tr><th>团队</th><th>总人数</th><th>组长</th><th>白班</th><th>中班</th><th>夜班</th></tr></thead><tbody><tr><td>PH客服支持组</td><td>338</td><td>Randi F</td><td>120</td><td>102</td><td>116</td></tr><tr><td>AR印度</td><td>337</td><td>John</td><td>118</td><td>98</td><td>121</td></tr></tbody></table></div>
        <div className="panel"><h3>待处理事项</h3><p>请假审批 8</p><p>工资复核 11</p><p>考试待批改 6</p><p>员工问题跟进 5</p></div>
        <div className="panel"><h3>今日对班</h3><p>Adrian → Jodie</p><p>Jessica → Minh</p><p>Lucas → Randi</p></div>
        <div className="panel"><h3>工资状态</h3><p>已计算 1,142 / 1,153</p><div className="bar"><i/></div><p>待复核 11</p></div>
       </div>
      </>:<div className="placeholder"><h1>{selected}</h1><p>页面骨架已经建立。下一步接 Supabase 数据、权限、筛选、编辑、审批和导出。</p></div>}
    </section>
   </main>
 </div>
}
ReactDOM.createRoot(document.getElementById('root')).render(<BrowserRouter basename="/home-staff-management"><App/></BrowserRouter>)