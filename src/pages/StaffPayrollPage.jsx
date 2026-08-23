import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const COPY={
  zh:{title:'工资记录',subtitle:'只显示已发布给你的工资单',language:'语言',history:'工资历史',empty:'暂时没有已发布的工资单',employee:'员工资料',employeeNo:'员工ID',name:'姓名',platform:'盘口 / 平台',position:'岗位',hireDate:'入职日期',payment:'收款方式',period:'工资月份',breakdown:'工资明细',description:'项目',type:'类型',amount:'金额',earn:'收入',deduct:'扣除',adjust:'调整',base_salary:'基本工资',attendance_salary:'出勤工资',leave_deduction:'休假扣款',late_deduction:'迟到扣款',absence_deduction:'缺勤扣款',increment_adjustment:'递增',attendance_bonus:'满勤',performance_adjustment:'绩效调整',deposit_adjustment:'押金调整',overtime_bonus:'额外加班',extra_adjustment:'额外加扣',next_deduction:'下次要扣除',overpayment_deduction:'多转扣除',other_adjustment:'其他调整',total:'实发工资',remark:'备注',print:'打印 / 保存 PDF',loading:'正在读取工资资料…',error:'工资资料读取失败'},
  en:{title:'My Payslips',subtitle:'Only payslips released to you are shown',language:'Language',history:'Payslip History',empty:'No released payslips yet',employee:'Employee Information',employeeNo:'Employee ID',name:'Full Name',platform:'Platform',position:'Position',hireDate:'Hire Date',payment:'Payment Method',period:'Payroll Period',breakdown:'Salary Breakdown',description:'Description',type:'Type',amount:'Amount',earn:'Earn',deduct:'Deduct',adjust:'Adjustment',base_salary:'Basic Salary',attendance_salary:'Attendance Salary',leave_deduction:'Leave Deduction',late_deduction:'Late Deduction',absence_deduction:'Absence Deduction',increment_adjustment:'Increment',attendance_bonus:'Full Attendance',performance_adjustment:'Performance Adjustment',deposit_adjustment:'Deposit Adjustment',overtime_bonus:'Overtime Bonus',extra_adjustment:'Extra Adjustment',next_deduction:'Next-period Deduction',overpayment_deduction:'Overpayment Deduction',other_adjustment:'Other Adjustment',total:'Total Take Home Pay',remark:'Remarks',print:'Print / Save PDF',loading:'Loading payroll information…',error:'Unable to load payroll information'},
  vi:{title:'Phiếu lương của tôi',subtitle:'Chỉ hiển thị phiếu lương đã được công bố cho bạn',language:'Ngôn ngữ',history:'Lịch sử lương',empty:'Chưa có phiếu lương được công bố',employee:'Thông tin nhân viên',employeeNo:'Mã nhân viên',name:'Họ và tên',platform:'Nền tảng',position:'Vị trí',hireDate:'Ngày vào làm',payment:'Phương thức nhận lương',period:'Kỳ lương',breakdown:'Chi tiết lương',description:'Khoản mục',type:'Loại',amount:'Số tiền',earn:'Thu nhập',deduct:'Khấu trừ',adjust:'Điều chỉnh',base_salary:'Lương cơ bản',attendance_salary:'Lương chuyên cần',leave_deduction:'Khấu trừ nghỉ phép',late_deduction:'Khấu trừ đi muộn',absence_deduction:'Khấu trừ vắng mặt',increment_adjustment:'Khoản tăng',attendance_bonus:'Thưởng chuyên cần',performance_adjustment:'Điều chỉnh hiệu suất',deposit_adjustment:'Điều chỉnh tiền cọc',overtime_bonus:'Thưởng tăng ca',extra_adjustment:'Điều chỉnh bổ sung',next_deduction:'Khấu trừ kỳ sau',overpayment_deduction:'Khấu trừ trả thừa',other_adjustment:'Điều chỉnh khác',total:'Thực lĩnh',remark:'Ghi chú',print:'In / Lưu PDF',loading:'Đang tải thông tin lương…',error:'Không thể tải thông tin lương'},
  id:{title:'Slip Gaji Saya',subtitle:'Hanya slip gaji yang telah diterbitkan untuk Anda',language:'Bahasa',history:'Riwayat Gaji',empty:'Belum ada slip gaji yang diterbitkan',employee:'Informasi Karyawan',employeeNo:'ID Karyawan',name:'Nama Lengkap',platform:'Platform',position:'Posisi',hireDate:'Tanggal Masuk',payment:'Metode Pembayaran',period:'Periode Gaji',breakdown:'Rincian Gaji',description:'Keterangan',type:'Jenis',amount:'Jumlah',earn:'Pendapatan',deduct:'Potongan',adjust:'Penyesuaian',base_salary:'Gaji Pokok',attendance_salary:'Gaji Kehadiran',leave_deduction:'Potongan Cuti',late_deduction:'Potongan Terlambat',absence_deduction:'Potongan Absen',increment_adjustment:'Kenaikan',attendance_bonus:'Bonus Kehadiran Penuh',performance_adjustment:'Penyesuaian Kinerja',deposit_adjustment:'Penyesuaian Deposit',overtime_bonus:'Bonus Lembur',extra_adjustment:'Penyesuaian Tambahan',next_deduction:'Potongan Periode Berikutnya',overpayment_deduction:'Potongan Kelebihan Bayar',other_adjustment:'Penyesuaian Lain',total:'Total Gaji Bersih',remark:'Catatan',print:'Cetak / Simpan PDF',loading:'Memuat informasi gaji…',error:'Gagal memuat informasi gaji'},
}

const money=(value,currency='USD',locale='en')=>{
  const amount=Number(value||0)
  const localeMap={zh:'zh-CN',en:'en-US',vi:'vi-VN',id:'id-ID'}
  try{return new Intl.NumberFormat(localeMap[locale],{style:'currency',currency,maximumFractionDigits:2}).format(amount)}catch{return `${amount.toLocaleString(localeMap[locale])} ${currency}`}
}
const monthLabel=(value,locale)=>{
  const date=new Date(`${String(value).slice(0,7)}-01T00:00:00`)
  if(Number.isNaN(date.getTime()))return String(value||'—')
  return new Intl.DateTimeFormat({zh:'zh-CN',en:'en-US',vi:'vi-VN',id:'id-ID'}[locale],{year:'numeric',month:'long'}).format(date)
}

export function StaffPayrollWorkspace({embedded=false}){
  const [locale,setLocale]=useState(()=>window.localStorage.getItem('wfh-payroll-language')||'zh')
  const [state,setState]=useState({loading:true,error:'',data:null})
  const [selectedId,setSelectedId]=useState(null)
  const [detail,setDetail]=useState(null)
  const [detailLoading,setDetailLoading]=useState(false)
  const t=COPY[locale]

  useEffect(()=>{window.localStorage.setItem('wfh-payroll-language',locale)},[locale])
  useEffect(()=>{let alive=true;(async()=>{
    const {data,error}=await supabase.rpc('staff_payroll_home')
    if(!alive)return
    if(error)setState({loading:false,error:error.message,data:null})
    else{
      setState({loading:false,error:'',data:data||null})
      const first=data?.history?.[0]?.id||null;setSelectedId(first)
    }
  })();return()=>{alive=false}},[])

  useEffect(()=>{if(!selectedId){setDetail(null);return}let alive=true;setDetailLoading(true);(async()=>{
    const {data,error}=await supabase.rpc('staff_payroll_detail',{p_payslip_id:selectedId})
    if(!alive)return
    setDetailLoading(false);if(!error)setDetail(data||null)
  })();return()=>{alive=false}},[selectedId])

  if(state.loading)return <div className={`${embedded?'':'content-page '}staff-payroll-page ${embedded?'staff-payroll-embedded':''}`}><div className="payroll-state">{t.loading}</div></div>
  if(state.error)return <div className={`${embedded?'':'content-page '}staff-payroll-page ${embedded?'staff-payroll-embedded':''}`}><div className="payroll-alert error">{t.error}：{state.error}</div></div>
  const history=state.data?.history||[]

  return <div className={`${embedded?'':'content-page '}staff-payroll-page ${embedded?'staff-payroll-embedded':''}`}>
    <header className="staff-payroll-head"><div><small>PAYSLIP</small><h1>{t.title}</h1><p>{t.subtitle}</p></div><label>{t.language}<select value={locale} onChange={event=>setLocale(event.target.value)}><option value="zh">中文</option><option value="en">English</option><option value="vi">Tiếng Việt</option><option value="id">Bahasa Indonesia</option></select></label></header>
    {!history.length?<div className="payroll-state">{t.empty}</div>:<div className="staff-payroll-layout">
      <aside className="staff-payroll-history"><h2>{t.history}</h2>{history.map(item=><button key={item.id} className={Number(selectedId)===Number(item.id)?'active':''} onClick={()=>setSelectedId(item.id)}><span>{monthLabel(item.period_start,locale)}</span><strong>{money(item.total_pay,item.currency,locale)}</strong><small>{item.title}</small></button>)}</aside>
      <main className="payslip-paper">{detailLoading&&!detail?<div className="payroll-state">{t.loading}</div>:detail&&<Payslip detail={detail} locale={locale} t={t}/>}</main>
    </div>}
  </div>
}

export default function StaffPayrollPage(){return <StaffPayrollWorkspace/>}
function Payslip({detail,locale,t}){
  const employee=detail.employee||{}
  const currency=detail.currency||'USD'
  const standard=useMemo(()=>[
    ['base_salary','earn'],['attendance_salary','earn'],['leave_deduction','deduct'],['late_deduction','deduct'],
    ['absence_deduction','deduct'],['performance_adjustment','adjust'],['deposit_adjustment','adjust'],
    ['overtime_bonus','earn'],['other_adjustment','adjust'],
  ].filter(([code])=>Number(detail[code]||0)!==0).map(([code,type])=>({code,label:t[code],type,amount:Number(detail[code]||0)})),[detail,locale])
  const rows=Array.isArray(detail.line_items)&&detail.line_items.length?detail.line_items.map(item=>({...item,label:t[item.code]||item.label||item.code})):standard
  return <article className="payslip-content">
    <div className="payslip-title"><div><span>{t.period}</span><h2>{monthLabel(detail.period_start,locale)}</h2><small>{detail.title}</small></div><button onClick={()=>window.print()}>{t.print}</button></div>
    <section><h3>{t.employee}</h3><div className="payslip-info-grid">
      <Info label={t.employeeNo} value={employee.employee_no}/><Info label={t.name} value={employee.full_name}/>
      <Info label={t.platform} value={employee.platform}/><Info label={t.position} value={employee.position_name}/>
      <Info label={t.hireDate} value={employee.hire_date}/><Info label={t.payment} value={employee.payment_method}/>
    </div></section>
    <section><h3>{t.breakdown}</h3><div className="payslip-breakdown-head"><span>{t.description}</span><span>{t.type}</span><span>{t.amount}</span></div>
      <div className="payslip-breakdown">{rows.length?rows.map((item,index)=>{
        const type=item.type==='deduct'?'deduct':item.type==='earn'?'earn':'adjust'
        const display=type==='deduct'?-Math.abs(Number(item.amount||0)):Number(item.amount||0)
        return <div key={`${item.code||item.label}-${index}`}><span>{item.label}</span><b>{t[type]}</b><strong className={type}>{display>0?'+ ':''}{money(display,currency,locale)}</strong></div>
      }):<div className="payslip-no-lines">—</div>}</div>
    </section>
    {detail.remark&&<section className="payslip-remark"><h3>{t.remark}</h3><p>{detail.remark}</p></section>}
    <div className="payslip-total"><span>{t.total}</span><strong>{money(detail.total_pay,currency,locale)}</strong></div>
  </article>
}

function Info({label,value}){return <div><span>{label}</span><strong>{value||'—'}</strong></div>}
