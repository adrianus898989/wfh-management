import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

const STORAGE_KEY = 'wfh-staff-locale'
const MANUAL_KEY = 'wfh-staff-locale-manual'
const SUPPORTED = new Set(['zh', 'en', 'vi', 'id'])

export const STAFF_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'id', label: 'Bahasa Indonesia' },
]

const en = {
  'language.choose': 'Language',
  'common.loading': 'Loading…',
  'common.retry': 'Try again',
  'common.close': 'Close',
  'common.hide': 'Hide',
  'common.view': 'View',
  'common.previous': 'Previous',
  'common.next': 'Next',
  'common.page': 'Page {page} / {pages}',
  'common.totalItems': '{count} records',
  'common.noData': 'No data yet',
  'common.notSet': 'Not set',
  'common.points': '{count} pts',
  'common.times': '{count} times',
  'auth.readFailed': 'Unable to read your sign-in session. Check your connection and try again.',
  'auth.accessFailed': 'Unable to verify access right now. Your sign-in session has been kept.',
  'auth.connectionUnstable': 'Connection is temporarily unstable',
  'auth.unavailable': 'The service is temporarily unavailable',
  'auth.staffLogin': 'Employee sign in',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.show': 'Show',
  'auth.signingIn': 'Signing in…',
  'auth.signIn': 'Sign in',
  'auth.firstTime': 'First time here?',
  'auth.activate': 'Activate account',
  'auth.loginUnavailable': 'Sign in is temporarily unavailable',
  'auth.invalidCredentials': 'Incorrect email or password',
  'auth.loginFailed': 'Sign in failed. Please try again.',
  'auth.accountUnavailable': 'This account is unavailable',
  'auth.sessionCheckFailed': 'Unable to verify this browser session. Please try again.',
  'auth.sessionActiveElsewhere': 'This account is already active in another browser. Sign out there before trying again.',
  'auth.sessionEndedElsewhere': 'Your session ended because this account is active in another browser.',
  'auth.sessionEnded': 'This sign-in session has ended. Please sign in again.',
  'register.unavailable': 'Registration is temporarily unavailable',
  'register.completeRequirements': 'Please complete all password requirements',
  'register.failed': 'Registration failed. Check your activation code.',
  'register.success': 'Account activated',
  'register.goLogin': 'Go to sign in',
  'register.title': 'Activate account',
  'register.confirmPassword': 'Confirm password',
  'register.activationCode': 'Activation code',
  'register.processing': 'Processing…',
  'register.create': 'Create account',
  'register.back': 'Back to sign in',
  'register.passwordLength': '10+ characters',
  'register.passwordUpper': 'Uppercase letter',
  'register.passwordLower': 'Lowercase letter',
  'register.passwordNumber': 'Number',
  'register.passwordSymbol': 'Special character',
  'nav.home': 'Home',
  'nav.exams': 'My exams',
  'nav.schedule': 'My schedule',
  'nav.attendance': 'My attendance',
  'nav.payroll': 'My payroll',
  'nav.requests': 'My requests',
  'nav.employeePortal': 'EMPLOYEE PORTAL',
  'nav.signOut': 'Sign out',
  'portal.loadingProfile': 'Loading your profile…',
  'portal.profileLoadFailed': 'Unable to load your profile',
  'portal.activityLoadFailed': 'Unable to load attendance and connectivity records',
  'portal.errorHistoryLoadFailed': 'Unable to load error records',
  'portal.sensitiveLoadFailed': 'Unable to load protected information',
  'portal.examDetailLoadFailed': 'Unable to load exam details',
  'portal.workspace': 'MY WORKSPACE',
  'portal.myHome': 'My workspace',
  'portal.teamUnset': 'Team not set',
  'portal.positionUnset': 'Position not set',
  'portal.shiftUnset': 'Shift not set',
  'portal.refresh': 'Refresh',
  'portal.monthErrors': 'Errors this month',
  'portal.totalErrors': '{count} total',
  'portal.examRecords': 'Exam attempts',
  'portal.passedTimes': '{count} passed',
  'portal.averageScore': 'Average score',
  'portal.gradedTimes': '{count} graded',
  'portal.monthAbsent': 'Absences this month',
  'portal.attendanceRecords': 'Attendance records',
  'portal.monthLeave': 'Leave this month',
  'portal.leaveDays': 'Leave / rest days',
  'portal.connectivity': 'Power / internet',
  'portal.powerInternetCounts': 'Power {power} · Internet {internet}',
  'decor.profile': 'PERSONAL PROFILE',
  'decor.payment': 'PAYMENT & CONTACT',
  'decor.quick': 'QUICK ACCESS',
  'decor.errors': 'ERROR RECORDS',
  'decor.exams': 'EXAM RESULTS',
  'decor.attendance': 'ATTENDANCE',
  'decor.payroll': 'PAYSLIP',
  'tab.info': 'Personal information',
  'tab.errors': 'Error records',
  'tab.exams': 'Exam results',
  'tab.attendance': 'Attendance',
  'tab.connectivity': 'Power / internet',
  'tab.payroll': 'Payroll records',
  'profile.title': 'Personal information',
  'profile.private': 'Only visible to you',
  'profile.employeeId': 'Employee ID',
  'profile.country': 'Country',
  'profile.employmentType': 'Employment type',
  'profile.status': 'Status',
  'profile.active': 'Active',
  'profile.hireDate': 'Hire date',
  'profile.tenure': 'Tenure',
  'profile.team': 'Team',
  'profile.group': 'Group',
  'profile.position': 'Position',
  'profile.shift': 'Shift',
  'profile.leader': 'Supervisor / team lead',
  'profile.trainer': 'Trainer',
  'profile.platform': 'Platform',
  'profile.workContent': 'Work responsibilities',
  'tenure.years': '{years}y ',
  'tenure.duration': '{months}mo {days}d · {total} days',
  'payment.title': 'Payment & contact details',
  'payment.protected': 'Securely hidden',
  'payment.method': 'Payment method',
  'payment.accountName': 'Account name',
  'payment.bankAccount': 'Bank / wallet account',
  'payment.usdt': 'USDT address',
  'payment.phone': 'Phone',
  'payment.address': 'Contact address',
  'payment.reading': 'Loading',
  'quick.title': 'Quick access',
  'quick.takeExam': 'Take an exam',
  'quick.chooseExam': 'Choose an exam →',
  'quick.schedule': 'Schedule',
  'quick.viewSchedule': 'View my schedule →',
  'quick.attendance': 'Attendance',
  'quick.viewAttendance': 'View my attendance →',
  'errors.title': 'Error records',
  'errors.loading': 'Loading error records…',
  'errors.uncategorized': 'Uncategorized error',
  'errors.details': 'What happened',
  'errors.correctAction': 'Correct handling',
  'errors.none': 'No error records are linked to your employee ID.',
  'exams.title': 'Exam results',
  'exams.sourceSummary': 'Current {current} · Legacy {legacy}',
  'exams.current': 'Current system',
  'exams.legacy': 'Legacy exam',
  'exams.attempt': 'Attempt {attempt} · {date}',
  'exams.pending': 'Pending review',
  'exams.viewPaper': 'View answers',
  'exams.none': 'No exam records yet.',
  'exam.detailTitle': 'MY EXAM RESULT',
  'exam.loadingDetail': 'Loading full answers…',
  'exam.result': 'Result',
  'exam.score': 'Score',
  'exam.completedAt': 'Completed',
  'exam.answerSummary': 'Answer summary',
  'exam.questionUnavailable': 'Question content was not retained',
  'exam.questionPoints': '{count} pts',
  'exam.myAnswer': 'My answer',
  'exam.unanswered': '(No answer)',
  'exam.feedback': 'Reviewer feedback',
  'exam.noAnswers': 'Only the final score is available for this exam. Per-question answers have not been synced.',
  'exam.detailWaiting': 'Per-question details are awaiting sync',
  'exam.totalOnly': 'Final score saved · per-question details not synced',
  'exam.breakdown': 'Correct {correct} · Partial {partial} · Wrong {wrong} · Pending {pending}',
  'exam.breakdownAnswered': 'Answered {answered}/{total} · Unanswered {unanswered} · ',
  'attendance.title': 'Attendance',
  'attendance.normal': 'Present',
  'attendance.rest': 'Rest day',
  'attendance.absent': 'Absent',
  'attendance.leave': 'Leave',
  'attendance.late': 'Late',
  'attendance.loading': 'Loading attendance records…',
  'attendance.none': 'No attendance records yet.',
  'connectivity.title': 'Power / internet records',
  'connectivity.loading': 'Loading records…',
  'connectivity.none': 'No power or internet interruption records.',
  'connectivity.power': 'Power outage',
  'connectivity.internet': 'Internet outage',
  'connectivity.timeDuration': 'Time / duration',
  'connectivity.recorded': 'Recorded',
  'connectivity.verified': 'Verified',
  'connectivity.resolved': 'Restored',
  'connectivity.rejected': 'Not confirmed',
  'connectivity.status': 'Status',
  'connectivity.details': 'Details',
  'connectivity.evidence': 'Evidence',
  'connectivity.openFailed': 'Unable to open attachment',
  'connectivity.opening': 'Opening…',
  'connectivity.video': 'Video',
  'connectivity.image': 'Image',
  'connectivity.legacyEvidence': 'Legacy evidence',
  'connectivity.evidenceFile': 'Evidence file',
  'connectivity.hours': '{count}h',
  'connectivity.minutes': '{count}m',
  'empty.title': 'Coming soon',
}

const zh = {
  'language.choose':'语言','common.loading':'读取中…','common.retry':'重新验证','common.close':'关闭','common.hide':'隐藏','common.view':'查看','common.previous':'上一页','common.next':'下一页','common.page':'第 {page} / {pages} 页','common.totalItems':'共 {count} 条','common.noData':'暂无数据','common.notSet':'未设置','common.points':'{count} 分','common.times':'{count} 次',
  'auth.readFailed':'登录状态读取失败，请检查网络后重试。','auth.accessFailed':'权限验证暂时失败，请重试。登录状态仍为你保留。','auth.connectionUnstable':'连接暂时不稳定','auth.unavailable':'暂时无法连接','auth.staffLogin':'员工登录','auth.email':'邮箱','auth.password':'密码','auth.show':'显示','auth.signingIn':'登录中...','auth.signIn':'登录','auth.firstTime':'首次使用？','auth.activate':'激活账号','auth.loginUnavailable':'暂时无法登录','auth.invalidCredentials':'用户名或密码错误','auth.loginFailed':'登录失败，请重试','auth.accountUnavailable':'账号不可用','auth.sessionCheckFailed':'无法验证当前浏览器会话，请稍后重试。','auth.sessionActiveElsewhere':'该账号已在另一浏览器登录，请先退出原会话后重试。','auth.sessionEndedElsewhere':'当前会话已结束：该账号正在另一浏览器使用。','auth.sessionEnded':'登录会话已失效，请重新登录。',
  'register.unavailable':'暂时无法注册','register.completeRequirements':'请完成密码要求','register.failed':'注册失败，请检查激活码','register.success':'注册成功','register.goLogin':'去登录','register.title':'激活账号','register.confirmPassword':'确认密码','register.activationCode':'激活码','register.processing':'处理中...','register.create':'创建账号','register.back':'返回登录','register.passwordLength':'10位以上','register.passwordUpper':'大写字母','register.passwordLower':'小写字母','register.passwordNumber':'数字','register.passwordSymbol':'特殊符号',
  'nav.home':'首页','nav.exams':'我的考试','nav.schedule':'我的排班','nav.attendance':'我的出勤','nav.payroll':'我的工资','nav.requests':'我的申请','nav.employeePortal':'员工门户','nav.signOut':'退出登录',
  'portal.loadingProfile':'正在读取个人资料…','portal.profileLoadFailed':'个人资料读取失败','portal.activityLoadFailed':'出勤与断网记录读取失败','portal.errorHistoryLoadFailed':'错误记录读取失败','portal.sensitiveLoadFailed':'敏感资料读取失败','portal.examDetailLoadFailed':'考试明细读取失败','portal.workspace':'我的工作台','portal.myHome':'我的首页','portal.teamUnset':'未设置团队','portal.positionUnset':'未设置岗位','portal.shiftUnset':'班次未设置','portal.refresh':'刷新资料','portal.monthErrors':'本月错误','portal.totalErrors':'累计 {count} 笔','portal.examRecords':'考试记录','portal.passedTimes':'通过 {count} 次','portal.averageScore':'平均成绩','portal.gradedTimes':'已批改 {count} 次','portal.monthAbsent':'本月缺席','portal.attendanceRecords':'出勤记录','portal.monthLeave':'本月休假','portal.leaveDays':'休假 / 公休天数','portal.connectivity':'停电 / 断网','portal.powerInternetCounts':'停电 {power} · 断网 {internet}',
  'tab.info':'个人信息','tab.errors':'出错记录','tab.exams':'考试结果','tab.attendance':'出勤记录','tab.connectivity':'停电 / 断网记录','tab.payroll':'工资记录',
  'profile.title':'个人信息','profile.private':'仅本人可见','profile.employeeId':'员工ID','profile.country':'员工国家','profile.employmentType':'员工类型','profile.status':'状态','profile.active':'在职','profile.hireDate':'入职日期','profile.tenure':'入职时长','profile.team':'团队','profile.group':'组别','profile.position':'岗位','profile.shift':'班次','profile.leader':'负责人 / 组长','profile.trainer':'培训老师','profile.platform':'盘口 / 平台','profile.workContent':'工作内容','tenure.years':'{years}年 ','tenure.duration':'{months}个月 {days}天 · 共 {total} 天',
  'payment.title':'收款与联系资料','payment.protected':'已安全隐藏','payment.method':'收款方式','payment.accountName':'收款姓名','payment.bankAccount':'银行卡 / 钱包账号','payment.usdt':'USDT 地址','payment.phone':'联系电话','payment.address':'联系地址','payment.reading':'读取中','quick.title':'快捷入口','quick.takeExam':'参加考试','quick.chooseExam':'选择考试 →','quick.schedule':'排班记录','quick.viewSchedule':'查看本人排班 →','quick.attendance':'出勤记录','quick.viewAttendance':'查看本人出勤 →',
  'errors.title':'出错记录','errors.loading':'正在读取错误记录…','errors.uncategorized':'未分类错误','errors.details':'错误情况','errors.correctAction':'正确处理方式','errors.none':'目前没有与你员工ID关联的错误记录。',
  'exams.title':'考试结果','exams.sourceSummary':'本系统 {current} · 旧考试 {legacy}','exams.current':'本系统','exams.legacy':'旧考试','exams.attempt':'第 {attempt} 次 · {date}','exams.pending':'待批改','exams.viewPaper':'查看答卷','exams.none':'暂无考试记录。','exam.detailTitle':'我的考试结果','exam.loadingDetail':'正在读取完整答卷…','exam.result':'成绩','exam.score':'得分','exam.completedAt':'完成时间','exam.answerSummary':'答题统计','exam.questionUnavailable':'题目内容未保留','exam.questionPoints':'本题 {count} 分','exam.myAnswer':'我的答案','exam.unanswered':'（未作答）','exam.feedback':'老师评语','exam.noAnswers':'该场考试仅保留总成绩，逐题答卷尚未同步。','exam.detailWaiting':'逐题明细等待同步','exam.totalOnly':'总成绩已保留 · 逐题明细未同步','exam.breakdown':'正确 {correct} · 半对 {partial} · 错误 {wrong} · 待评 {pending}','exam.breakdownAnswered':'已答 {answered}/{total} · 未答 {unanswered} · ',
  'attendance.title':'出勤记录','attendance.normal':'正常','attendance.rest':'公休','attendance.absent':'缺席','attendance.leave':'休假','attendance.late':'迟到','attendance.loading':'正在读取出勤记录…','attendance.none':'暂无出勤记录。',
  'connectivity.title':'停电 / 断网记录','connectivity.loading':'正在读取记录…','connectivity.none':'暂无停电或断网记录','connectivity.power':'停电','connectivity.internet':'断网','connectivity.timeDuration':'时间 / 持续','connectivity.recorded':'已记录','connectivity.verified':'已核实','connectivity.resolved':'已恢复','connectivity.rejected':'不成立','connectivity.status':'状态','connectivity.details':'情况说明','connectivity.evidence':'证明','connectivity.openFailed':'附件打开失败','connectivity.opening':'打开中…','connectivity.video':'视频','connectivity.image':'图片','connectivity.legacyEvidence':'旧证明','connectivity.evidenceFile':'证明文件','connectivity.hours':'{count}小时','connectivity.minutes':'{count}分钟','empty.title':'暂无数据',
  'decor.profile':'个人档案','decor.payment':'收款与联系资料','decor.quick':'快捷入口','decor.errors':'出错记录','decor.exams':'考试结果','decor.attendance':'出勤记录','decor.payroll':'工资单',
}

const vi = {
  ...en,
  'language.choose':'Ngôn ngữ','common.loading':'Đang tải…','common.retry':'Thử lại','common.close':'Đóng','common.hide':'Ẩn','common.view':'Xem','common.previous':'Trang trước','common.next':'Trang sau','common.page':'Trang {page} / {pages}','common.totalItems':'Tổng {count} mục','common.noData':'Chưa có dữ liệu','common.notSet':'Chưa thiết lập','common.points':'{count} điểm','common.times':'{count} lần',
  'auth.readFailed':'Không thể đọc phiên đăng nhập. Vui lòng kiểm tra mạng và thử lại.','auth.accessFailed':'Tạm thời không thể xác minh quyền. Phiên đăng nhập vẫn được giữ.','auth.connectionUnstable':'Kết nối tạm thời không ổn định','auth.unavailable':'Dịch vụ tạm thời không khả dụng','auth.staffLogin':'Đăng nhập nhân viên','auth.email':'Email','auth.password':'Mật khẩu','auth.show':'Hiện','auth.signingIn':'Đang đăng nhập…','auth.signIn':'Đăng nhập','auth.firstTime':'Lần đầu sử dụng?','auth.activate':'Kích hoạt tài khoản','auth.loginUnavailable':'Tạm thời không thể đăng nhập','auth.invalidCredentials':'Email hoặc mật khẩu không đúng','auth.loginFailed':'Đăng nhập thất bại. Vui lòng thử lại.','auth.accountUnavailable':'Tài khoản không khả dụng','auth.sessionCheckFailed':'Không thể xác minh phiên trình duyệt này. Vui lòng thử lại.','auth.sessionActiveElsewhere':'Tài khoản này đang hoạt động trên trình duyệt khác. Hãy đăng xuất ở đó trước.','auth.sessionEndedElsewhere':'Phiên đã kết thúc vì tài khoản này đang hoạt động trên trình duyệt khác.','auth.sessionEnded':'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại.',
  'register.unavailable':'Tạm thời không thể đăng ký','register.completeRequirements':'Vui lòng hoàn tất yêu cầu mật khẩu','register.failed':'Đăng ký thất bại. Vui lòng kiểm tra mã kích hoạt.','register.success':'Kích hoạt thành công','register.goLogin':'Đăng nhập','register.title':'Kích hoạt tài khoản','register.confirmPassword':'Xác nhận mật khẩu','register.activationCode':'Mã kích hoạt','register.processing':'Đang xử lý…','register.create':'Tạo tài khoản','register.back':'Quay lại đăng nhập','register.passwordLength':'Từ 10 ký tự','register.passwordUpper':'Chữ hoa','register.passwordLower':'Chữ thường','register.passwordNumber':'Chữ số','register.passwordSymbol':'Ký tự đặc biệt',
  'nav.home':'Trang chủ','nav.exams':'Kỳ thi của tôi','nav.schedule':'Lịch làm việc','nav.attendance':'Chấm công','nav.payroll':'Lương của tôi','nav.requests':'Yêu cầu của tôi','nav.employeePortal':'CỔNG NHÂN VIÊN','nav.signOut':'Đăng xuất',
  'portal.loadingProfile':'Đang tải hồ sơ…','portal.profileLoadFailed':'Không thể tải hồ sơ','portal.activityLoadFailed':'Không thể tải chấm công và gián đoạn mạng','portal.errorHistoryLoadFailed':'Không thể tải lịch sử lỗi','portal.sensitiveLoadFailed':'Không thể tải thông tin bảo mật','portal.examDetailLoadFailed':'Không thể tải chi tiết bài thi','portal.workspace':'KHÔNG GIAN LÀM VIỆC','portal.myHome':'Trang của tôi','portal.teamUnset':'Chưa có nhóm','portal.positionUnset':'Chưa có vị trí','portal.shiftUnset':'Chưa có ca','portal.refresh':'Làm mới','portal.monthErrors':'Lỗi tháng này','portal.totalErrors':'Tổng {count}','portal.examRecords':'Lần thi','portal.passedTimes':'Đạt {count} lần','portal.averageScore':'Điểm trung bình','portal.gradedTimes':'Đã chấm {count} lần','portal.monthAbsent':'Vắng tháng này','portal.attendanceRecords':'Bản ghi chấm công','portal.monthLeave':'Nghỉ tháng này','portal.leaveDays':'Ngày nghỉ / ngày phép','portal.connectivity':'Điện / Internet','portal.powerInternetCounts':'Mất điện {power} · Mất mạng {internet}',
  'tab.info':'Thông tin cá nhân','tab.errors':'Lịch sử lỗi','tab.exams':'Kết quả thi','tab.attendance':'Chấm công','tab.connectivity':'Mất điện / mất mạng','tab.payroll':'Lịch sử lương',
  'profile.title':'Thông tin cá nhân','profile.private':'Chỉ bạn có thể xem','profile.employeeId':'Mã nhân viên','profile.country':'Quốc gia','profile.employmentType':'Loại nhân viên','profile.status':'Trạng thái','profile.active':'Đang làm việc','profile.hireDate':'Ngày vào làm','profile.tenure':'Thâm niên','profile.team':'Nhóm','profile.group':'Tổ','profile.position':'Vị trí','profile.shift':'Ca','profile.leader':'Phụ trách / trưởng nhóm','profile.trainer':'Người đào tạo','profile.platform':'Nền tảng','profile.workContent':'Nội dung công việc','tenure.years':'{years} năm ','tenure.duration':'{months} tháng {days} ngày · {total} ngày',
  'payment.title':'Thanh toán & liên hệ','payment.protected':'Đã ẩn an toàn','payment.method':'Phương thức thanh toán','payment.accountName':'Tên tài khoản','payment.bankAccount':'Ngân hàng / ví','payment.usdt':'Địa chỉ USDT','payment.phone':'Số điện thoại','payment.address':'Địa chỉ liên hệ','payment.reading':'Đang tải','quick.title':'Truy cập nhanh','quick.takeExam':'Làm bài thi','quick.chooseExam':'Chọn bài thi →','quick.schedule':'Lịch làm việc','quick.viewSchedule':'Xem lịch của tôi →','quick.attendance':'Chấm công','quick.viewAttendance':'Xem chấm công →',
  'errors.title':'Lịch sử lỗi','errors.loading':'Đang tải lịch sử lỗi…','errors.uncategorized':'Lỗi chưa phân loại','errors.details':'Tình huống lỗi','errors.correctAction':'Cách xử lý đúng','errors.none':'Chưa có lỗi nào liên kết với mã nhân viên của bạn.',
  'exams.title':'Kết quả thi','exams.sourceSummary':'Hệ thống mới {current} · Hệ thống cũ {legacy}','exams.current':'Hệ thống mới','exams.legacy':'Bài thi cũ','exams.attempt':'Lần {attempt} · {date}','exams.pending':'Chờ chấm','exams.viewPaper':'Xem bài làm','exams.none':'Chưa có bài thi.','exam.detailTitle':'KẾT QUẢ BÀI THI','exam.loadingDetail':'Đang tải toàn bộ bài làm…','exam.result':'Kết quả','exam.score':'Điểm','exam.completedAt':'Hoàn thành','exam.answerSummary':'Thống kê câu trả lời','exam.questionUnavailable':'Nội dung câu hỏi không được lưu','exam.questionPoints':'Câu này {count} điểm','exam.myAnswer':'Câu trả lời của tôi','exam.unanswered':'(Chưa trả lời)','exam.feedback':'Nhận xét','exam.noAnswers':'Bài thi này chỉ còn tổng điểm; chi tiết từng câu chưa được đồng bộ.','exam.detailWaiting':'Chi tiết từng câu đang chờ đồng bộ','exam.totalOnly':'Đã lưu tổng điểm · chưa đồng bộ chi tiết','exam.breakdown':'Đúng {correct} · Nửa đúng {partial} · Sai {wrong} · Chờ chấm {pending}','exam.breakdownAnswered':'Đã trả lời {answered}/{total} · Chưa trả lời {unanswered} · ',
  'attendance.title':'Chấm công','attendance.normal':'Đi làm','attendance.rest':'Nghỉ','attendance.absent':'Vắng','attendance.leave':'Nghỉ phép','attendance.late':'Đi muộn','attendance.loading':'Đang tải chấm công…','attendance.none':'Chưa có dữ liệu chấm công.','connectivity.title':'Lịch sử mất điện / mất mạng','connectivity.loading':'Đang tải bản ghi…','connectivity.none':'Chưa có bản ghi mất điện hoặc mất mạng.','connectivity.power':'Mất điện','connectivity.internet':'Mất mạng','connectivity.timeDuration':'Thời gian / thời lượng','connectivity.recorded':'Đã ghi nhận','connectivity.verified':'Đã xác minh','connectivity.resolved':'Đã khôi phục','connectivity.rejected':'Không xác nhận','connectivity.status':'Trạng thái','connectivity.details':'Mô tả','connectivity.evidence':'Bằng chứng','connectivity.openFailed':'Không thể mở tệp đính kèm','connectivity.opening':'Đang mở…','connectivity.video':'Video','connectivity.image':'Hình ảnh','connectivity.legacyEvidence':'Bằng chứng cũ','connectivity.evidenceFile':'Tệp bằng chứng','connectivity.hours':'{count} giờ','connectivity.minutes':'{count} phút','empty.title':'Sắp ra mắt',
  'decor.profile':'HỒ SƠ CÁ NHÂN','decor.payment':'THANH TOÁN & LIÊN HỆ','decor.quick':'TRUY CẬP NHANH','decor.errors':'LỊCH SỬ LỖI','decor.exams':'KẾT QUẢ THI','decor.attendance':'CHẤM CÔNG','decor.payroll':'PHIẾU LƯƠNG',
}

const id = {
  ...en,
  'language.choose':'Bahasa','common.loading':'Memuat…','common.retry':'Coba lagi','common.close':'Tutup','common.hide':'Sembunyikan','common.view':'Lihat','common.previous':'Sebelumnya','common.next':'Berikutnya','common.page':'Halaman {page} / {pages}','common.totalItems':'Total {count} data','common.noData':'Belum ada data','common.notSet':'Belum diatur','common.points':'{count} poin','common.times':'{count} kali',
  'auth.readFailed':'Tidak dapat membaca sesi masuk. Periksa koneksi dan coba lagi.','auth.accessFailed':'Akses belum dapat diverifikasi. Sesi masuk Anda tetap disimpan.','auth.connectionUnstable':'Koneksi sementara tidak stabil','auth.unavailable':'Layanan sementara tidak tersedia','auth.staffLogin':'Masuk karyawan','auth.email':'Email','auth.password':'Kata sandi','auth.show':'Tampilkan','auth.signingIn':'Sedang masuk…','auth.signIn':'Masuk','auth.firstTime':'Pertama kali?','auth.activate':'Aktifkan akun','auth.loginUnavailable':'Login sementara tidak tersedia','auth.invalidCredentials':'Email atau kata sandi salah','auth.loginFailed':'Gagal masuk. Silakan coba lagi.','auth.accountUnavailable':'Akun ini tidak tersedia','auth.sessionCheckFailed':'Sesi browser ini tidak dapat diverifikasi. Silakan coba lagi.','auth.sessionActiveElsewhere':'Akun ini sudah aktif di browser lain. Keluar dari sana sebelum mencoba lagi.','auth.sessionEndedElsewhere':'Sesi berakhir karena akun ini aktif di browser lain.','auth.sessionEnded':'Sesi masuk telah berakhir. Silakan masuk kembali.',
  'register.unavailable':'Pendaftaran sementara tidak tersedia','register.completeRequirements':'Lengkapi semua syarat kata sandi','register.failed':'Pendaftaran gagal. Periksa kode aktivasi.','register.success':'Akun berhasil diaktifkan','register.goLogin':'Masuk sekarang','register.title':'Aktifkan akun','register.confirmPassword':'Konfirmasi kata sandi','register.activationCode':'Kode aktivasi','register.processing':'Memproses…','register.create':'Buat akun','register.back':'Kembali ke login','register.passwordLength':'Minimal 10 karakter','register.passwordUpper':'Huruf besar','register.passwordLower':'Huruf kecil','register.passwordNumber':'Angka','register.passwordSymbol':'Karakter khusus',
  'nav.home':'Beranda','nav.exams':'Ujian saya','nav.schedule':'Jadwal saya','nav.attendance':'Kehadiran saya','nav.payroll':'Gaji saya','nav.requests':'Pengajuan saya','nav.employeePortal':'PORTAL KARYAWAN','nav.signOut':'Keluar',
  'portal.loadingProfile':'Memuat profil…','portal.profileLoadFailed':'Gagal memuat profil','portal.activityLoadFailed':'Gagal memuat kehadiran dan gangguan koneksi','portal.errorHistoryLoadFailed':'Gagal memuat catatan kesalahan','portal.sensitiveLoadFailed':'Gagal memuat informasi terlindungi','portal.examDetailLoadFailed':'Gagal memuat detail ujian','portal.workspace':'RUANG KERJA SAYA','portal.myHome':'Ruang kerja saya','portal.teamUnset':'Tim belum diatur','portal.positionUnset':'Posisi belum diatur','portal.shiftUnset':'Shift belum diatur','portal.refresh':'Muat ulang','portal.monthErrors':'Kesalahan bulan ini','portal.totalErrors':'Total {count}','portal.examRecords':'Riwayat ujian','portal.passedTimes':'Lulus {count} kali','portal.averageScore':'Nilai rata-rata','portal.gradedTimes':'Dinilai {count} kali','portal.monthAbsent':'Absen bulan ini','portal.attendanceRecords':'Catatan kehadiran','portal.monthLeave':'Cuti bulan ini','portal.leaveDays':'Hari cuti / libur','portal.connectivity':'Listrik / internet','portal.powerInternetCounts':'Listrik {power} · Internet {internet}',
  'tab.info':'Informasi pribadi','tab.errors':'Catatan kesalahan','tab.exams':'Hasil ujian','tab.attendance':'Kehadiran','tab.connectivity':'Listrik / internet','tab.payroll':'Riwayat gaji',
  'profile.title':'Informasi pribadi','profile.private':'Hanya dapat dilihat oleh Anda','profile.employeeId':'ID karyawan','profile.country':'Negara','profile.employmentType':'Jenis karyawan','profile.status':'Status','profile.active':'Aktif','profile.hireDate':'Tanggal masuk','profile.tenure':'Masa kerja','profile.team':'Tim','profile.group':'Grup','profile.position':'Posisi','profile.shift':'Shift','profile.leader':'Penanggung jawab / ketua tim','profile.trainer':'Pelatih','profile.platform':'Platform','profile.workContent':'Tanggung jawab kerja','tenure.years':'{years} thn ','tenure.duration':'{months} bln {days} hari · {total} hari',
  'payment.title':'Pembayaran & kontak','payment.protected':'Disembunyikan dengan aman','payment.method':'Metode pembayaran','payment.accountName':'Nama rekening','payment.bankAccount':'Rekening bank / dompet','payment.usdt':'Alamat USDT','payment.phone':'Telepon','payment.address':'Alamat kontak','payment.reading':'Memuat','quick.title':'Akses cepat','quick.takeExam':'Ikuti ujian','quick.chooseExam':'Pilih ujian →','quick.schedule':'Jadwal','quick.viewSchedule':'Lihat jadwal saya →','quick.attendance':'Kehadiran','quick.viewAttendance':'Lihat kehadiran saya →',
  'errors.title':'Catatan kesalahan','errors.loading':'Memuat catatan kesalahan…','errors.uncategorized':'Kesalahan tanpa kategori','errors.details':'Kejadian','errors.correctAction':'Penanganan yang benar','errors.none':'Belum ada catatan kesalahan yang terhubung ke ID karyawan Anda.',
  'exams.title':'Hasil ujian','exams.sourceSummary':'Sistem baru {current} · Sistem lama {legacy}','exams.current':'Sistem baru','exams.legacy':'Ujian lama','exams.attempt':'Percobaan {attempt} · {date}','exams.pending':'Menunggu penilaian','exams.viewPaper':'Lihat jawaban','exams.none':'Belum ada riwayat ujian.','exam.detailTitle':'HASIL UJIAN SAYA','exam.loadingDetail':'Memuat jawaban lengkap…','exam.result':'Hasil','exam.score':'Nilai','exam.completedAt':'Selesai','exam.answerSummary':'Ringkasan jawaban','exam.questionUnavailable':'Isi soal tidak disimpan','exam.questionPoints':'Soal ini {count} poin','exam.myAnswer':'Jawaban saya','exam.unanswered':'(Belum dijawab)','exam.feedback':'Catatan penilai','exam.noAnswers':'Hanya nilai akhir yang tersedia; jawaban per soal belum disinkronkan.','exam.detailWaiting':'Detail per soal menunggu sinkronisasi','exam.totalOnly':'Nilai akhir tersimpan · detail per soal belum disinkronkan','exam.breakdown':'Benar {correct} · Sebagian {partial} · Salah {wrong} · Menunggu {pending}','exam.breakdownAnswered':'Dijawab {answered}/{total} · Belum dijawab {unanswered} · ',
  'attendance.title':'Kehadiran','attendance.normal':'Hadir','attendance.rest':'Libur','attendance.absent':'Absen','attendance.leave':'Cuti','attendance.late':'Terlambat','attendance.loading':'Memuat catatan kehadiran…','attendance.none':'Belum ada catatan kehadiran.','connectivity.title':'Catatan listrik / internet','connectivity.loading':'Memuat catatan…','connectivity.none':'Belum ada catatan gangguan listrik atau internet.','connectivity.power':'Listrik padam','connectivity.internet':'Internet terputus','connectivity.timeDuration':'Waktu / durasi','connectivity.recorded':'Tercatat','connectivity.verified':'Terverifikasi','connectivity.resolved':'Pulih','connectivity.rejected':'Tidak terbukti','connectivity.status':'Status','connectivity.details':'Keterangan','connectivity.evidence':'Bukti','connectivity.openFailed':'Lampiran tidak dapat dibuka','connectivity.opening':'Membuka…','connectivity.video':'Video','connectivity.image':'Gambar','connectivity.legacyEvidence':'Bukti lama','connectivity.evidenceFile':'File bukti','connectivity.hours':'{count} jam','connectivity.minutes':'{count} mnt','empty.title':'Segera hadir',
  'decor.profile':'PROFIL PRIBADI','decor.payment':'PEMBAYARAN & KONTAK','decor.quick':'AKSES CEPAT','decor.errors':'CATATAN KESALAHAN','decor.exams':'HASIL UJIAN','decor.attendance':'KEHADIRAN','decor.payroll':'SLIP GAJI',
}

const dictionaries = { en, zh, vi, id }

const getStoredLocale = () => {
  if (typeof window === 'undefined') return 'en'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  return SUPPORTED.has(stored) ? stored : 'en'
}

const countryLocale = country => {
  const value = String(country || '').trim().toLowerCase()
  if (!value) return 'en'
  if (/vietnam|viet nam|việt nam|越南/.test(value)) return 'vi'
  if (/indonesia|印尼|印度尼西亚/.test(value)) return 'id'
  if (/china|chinese|taiwan|hong kong|macau|中国|台湾|香港|澳门|中文/.test(value)) return 'zh'
  return 'en'
}

const interpolate = (value, vars) => String(value).replace(/\{(\w+)\}/g, (match, key) => vars?.[key] ?? match)

const StaffLocaleContext = createContext(null)

export function StaffI18nProvider({ children }) {
  const [locale, setLocaleState] = useState(getStoredLocale)

  const applyLocale = useCallback((next, manual = true) => {
    const safe = SUPPORTED.has(next) ? next : 'en'
    setLocaleState(safe)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, safe)
      if (manual) window.localStorage.setItem(MANUAL_KEY, '1')
    }
  }, [])

  const setLocale = useCallback(next => applyLocale(next, true), [applyLocale])
  const resetLocale = useCallback(() => {
    setLocaleState('en')
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY)
      window.localStorage.removeItem(MANUAL_KEY)
    }
  }, [])
  const adoptCountry = useCallback(country => {
    if (typeof window !== 'undefined' && window.localStorage.getItem(MANUAL_KEY) === '1') return
    applyLocale(countryLocale(country), false)
  }, [applyLocale])

  const t = useCallback((key, fallback, vars) => {
    const value = dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? fallback ?? key
    return interpolate(value, vars)
  }, [locale])

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.staffLocale = locale
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale, resetLocale, t, adoptCountry }), [locale, setLocale, resetLocale, t, adoptCountry])
  return React.createElement(StaffLocaleContext.Provider, { value }, children)
}

export function useStaffLocale() {
  const context = useContext(StaffLocaleContext)
  if (context) return context
  return {
    locale: 'en',
    setLocale: () => {},
    resetLocale: () => {},
    adoptCountry: () => {},
    t: (key, fallback, vars) => interpolate(fallback ?? dictionaries.en[key] ?? key, vars),
  }
}

export const useStaffI18n = useStaffLocale

export function StaffLanguageSwitcher({ className = '' }) {
  const { locale, setLocale, t } = useStaffLocale()
  return React.createElement(
    'label',
    { className: `staff-language-switcher ${className}`.trim() },
    React.createElement('span', null, t('language.choose', '语言')),
    React.createElement(
      'select',
      {
        'aria-label': t('language.choose', '语言'),
        value: locale,
        onChange: event => setLocale(event.target.value),
      },
      STAFF_LANGUAGES.map(language => React.createElement('option', { value: language.code, key: language.code }, language.label)),
    ),
  )
}

export const staffLocaleForCountry = countryLocale
