WFH V6 ONE PASS

这次不要再用之前任何 V4/V5/fast-fix 补丁。
当前 Supabase 权限已经通，Dashboard 已能读到 Founder=1。
本包只统一 GitHub 前端，不需要再跑 SQL。

一次上传并覆盖以下 10 个文件：
src/App.jsx
src/components/AppLayout.jsx
src/pages/AdminLoginPage.jsx
src/pages/StaffLoginPage.jsx
src/pages/StaffRegisterPage.jsx
src/pages/MfaPage.jsx
src/pages/AdminEmployeesPage.jsx
src/pages/AdminUsersPage.jsx
src/pages/PortalPage.jsx
src/styles.css

完成后 Commit:
Unify WFH admin and staff UI V6

等 GitHub Actions 绿色后，浏览器 Command + Shift + R 强刷。

本版统一：
- 删除左侧 Google Authenticator 菜单
- OTP 改为后台账号逐人开/关；开启时登录后自动进入绑定/6位验证流程
- 后台和员工登录页统一成干净专业 UI
- 员工注册页去掉多余说明
- 用户与权限改为“后台账号 / 员工账号”两个页签
- 后台账号可新增、OTP开关、重置密码、停用/启用
- 员工管理改为从 admin-accounts Edge Function 读取，不再浏览器直接读 employees
- 首页按已确认结构显示：
  员工总数 / 在职 / 今日在岗 / 请假公休 / 回家 / 缺席 / 待审批 / 后台账号
  团队分布 / 岗位分布 / 今日出勤 / 待处理 / 账号概况 / 人员动态
- 尚未建立的考勤、排班、审批、工资模块用 “—” 而不是假装为 0
- 左侧菜单按业务分组为：
  首页 / 员工管理 / 排班与考勤 / 每日工作 / 培训与考试 / 工资中心 / 统计报表 / 用户与权限

这一步之后不再继续修旧 UI；后续按模块开发真实数据与新增员工功能。
