# Home Staff Management System

## V0.2
已加入：

- Founder / 主管 / 组长 / 培训老师 / 助理 / Employee
- 员工前端与后台管理权限分离
- 每账号独立权限勾选
- 数据范围：全部 / 指定团队 / 自己团队 / 仅本人
- 敏感资料单独权限
- 无权限自动遮罩银行卡 / GCash / Maya / USDT
- Employee 默认不能进入后台
- 收款资料修改申请
- 修改原因必填
- OTP 验证流程骨架
- 收款资料后台审核
- 旧值 / 新值对比
- 审核通过前不覆盖原资料

下一步：
1. 建 Supabase 项目
2. 建 profiles / employees / teams / roles / permissions
3. 建 payout_accounts / payout_change_requests / audit_logs
4. 接 Auth + MFA + RLS
