# Supabase

下一步将在这里放数据库 migration。

原则：
- UI 隐藏不是安全权限。
- 正式版必须使用 RLS。
- Employee 只能读取自己的数据。
- Team Leader 只能读取自己团队数据。
- 敏感收款资料需要额外 permission。
- 任何收款资料修改、工资修改必须写 audit log。
