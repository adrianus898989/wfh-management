# WFH Management V4

- 后台登录：/admin/login
- 员工登录：/staff/login
- 员工注册：/staff/register
- GitHub Pages base：/wfh-management/
- 后台账号不能自行注册
- 普通员工仍使用激活码注册并绑定 Employee ID
- 下一步：后台创建账号 / 重置密码 / 停用 / 删除 / 权限勾选


## V4.1
- 后台改为用户名 + 密码
- 员工仍为邮箱 + 密码
- 后台用户名由 `user_access.login_username` 管理
- 新增 `admin-login` Edge Function
- 后台登录 UI 改为极简，不显示角色或系统说明
