# WFH Management V4

- 后台登录：/workspace/login
- 员工登录：/portal/login
- 员工注册：/portal/register
- 旧 `/admin` 与 `/staff` 链接只保留为一次性兼容重定向
- GitHub Pages base：/wfh-management/；这里只部署极简跳转壳，不再部署应用、API 配置或静态资源
- Cloudflare Pages build command：`npm run build:cloudflare`
- Cloudflare Pages output directory：`dist`
- Cloudflare Pages 使用根路径 `/`，构建不会输出顶层 `404.html`，由 Pages 原生提供 SPA 深层链接回退
- Cloudflare Pages 生产分支：`main`；构建环境需配置 `VITE_SUPABASE_URL`、`VITE_SUPABASE_PUBLISHABLE_KEY` 和 `NODE_VERSION=24`
- 管理端站点设置 `VITE_APP_PORTAL_MODE=admin`；员工端站点设置 `VITE_APP_PORTAL_MODE=staff`。访问另一端路径会被送回当前站点自己的登录页。
- 当前免费 Cloudflare Pages 管理端：`https://wfh-workspaceexpert.pages.dev`；员工端：`https://wfh-teamportal.pages.dev`
- 两个 Cloudflare 项目都必须配置生产密钥 `IP_GATE_HMAC_SECRET`，并与 Supabase 对应的管理端/员工端边缘校验密钥分别一致；不要共用两端密钥
- Cloudflare 两站应从同一已提交版本构建并使用同一唯一 `VITE_APP_RELEASE_ID`；两站都成功后，若需要强制所有旧会话失效，再只推进一次数据库 release epoch
- 必须把两个精确 origin（不含路径或通配符）加入 Supabase Edge Functions secret `APP_ALLOWED_ORIGINS`
- 后台账号不能自行注册
- 普通员工仍使用激活码注册并绑定 Employee ID
- 下一步：后台创建账号 / 重置密码 / 停用 / 删除 / 权限勾选


## V4.1
- 后台改为用户名 + 密码
- 员工仍为邮箱 + 密码
- 后台用户名由 `user_access.login_username` 管理
- 新增 `admin-login` Edge Function
- 后台登录 UI 改为极简，不显示角色或系统说明
