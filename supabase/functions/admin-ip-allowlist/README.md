# 后台登录 IP 白名单：上线与恢复

## 安全模型

- 只限制 `admin` 后台；员工前端登录、员工 lease 与员工页面不读取这些表。
- 迁移后的开关默认关闭。只有开关已打开且至少一条记录启用时，规则才生效；零条启用记录永远不会锁死全部后台账号。
- 管理员必须先点击“一键加入当前IP”，服务端确认当前 IP 命中启用记录后才允许打开开关。
- `admin-login` 在密码验证前做 IP 预检，并在成功登录后把网关看到的 IP 绑定到 `auth.sessions.id`。
- React 的 admin `claim` 经 `admin-ip-guard` 重新验证并写入 session attestation；数据库的 claim、heartbeat 与 RLS session-validity 都要求该 attestation，因而不能通过浏览器直接调用 Auth API 绕过登录 Edge。
- admin claim 与每分钟 heartbeat 都经 `admin-ip-guard`：允许的网关 IP 会刷新五分钟 attestation，然后才续租原本的五分钟数据库 lease。这样换网后不能绕过 Edge 直接 heartbeat 无限续租。
- 只有可信服务明确判断 `ip_not_allowed` 时才撤销 Auth session；缺少代理 IP、Edge 超时或临时故障只返回可重试错误，不会主动退出已有管理员，也不会刷新 attestation/lease。短故障可在五分钟容错窗口内恢复，持续故障则自然停止服务端授权。
- 表与写入 RPC 都不授予 `anon` / `authenticated`。页面权限 `account.ip_allowlist.manage` 与普通后台账号权限相互独立，Edge 和数据库 mutation RPC 会再次校验。

## 真实 IP 信任边界

代码只读取 Supabase hosted Edge gateway 经 Cloudflare 写入的 `CF-Connecting-IP`。它不读取请求 body、query、`X-Forwarded-For`、`X-Real-IP` 或自定义 header；值缺失、含代理链或是 CIDR 时直接拒绝。

依据：Supabase 的 [Edge Functions 架构](https://supabase.com/docs/guides/functions/architecture)说明请求先进入全局 API gateway；官方 [日志说明](https://supabase.com/docs/guides/troubleshooting/discovering-and-interpreting-api-errors-in-the-logs-7xREI9)把 `request.headers.cf_connecting_ip` 定义为请求者 IP。2026-08-27 已在本项目 hosted Functions 域名执行不回传原始 IP 的生产 canary：该头与网关代理链首段一致；调用方伪造 `X-Forwarded-For` 会被覆盖，伪造 `CF-Connecting-IP` 会在函数执行前被 Cloudflare 拒绝。

如果改为 self-hosted 或绕过 Supabase hosted Cloudflare 边界，不能沿用此信任模型；必须由自管代理覆盖可信客户端 IP 头，并在 staging 重做防伪测试后才能开启强制执行。

## 已部署状态与启用前顺序

数据库迁移以及 `admin-login`、`admin-ip-guard`、`admin-ip-allowlist` 已部署；强制开关保持关闭。启用前按以下顺序操作：

1. 发布前端；确认“后台账号”旁能看到“后台登入IP白名单”，而没有独立权限的账号看不到且直接访问会被路由守卫拦截。
2. 保持开关关闭，测试 IPv4、IPv6、CIDR 命中/拒绝、员工登录、MFA 与单浏览器 lease。
3. 用 Founder 登录，点击“一键加入当前IP”，再加入至少一个可用的备用办公网络。
4. 从另一个允许网络复测后再打开开关。打开时会撤销其他尚未证明当前 IP 的后台 session；员工 session 不会被触碰。
5. 用非白名单网络无痕窗口验证后台登录被拒绝；再验证 Edge 临时失败只显示重试，不会让现有后台 session 退出。

本地/CI 数据库测试（仅 disposable database）：

```sh
supabase db reset
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/admin_login_ip_allowlist.sql
```

Deno 单元测试：

```sh
deno test supabase/functions/_shared/adminIp_test.ts
```

## Founder 锁定恢复

若可信代理配置错误或所有允许网络均不可达，由项目所有者进入 Supabase SQL Editor 执行：

```sql
select session_private.founder_recover_admin_ip_allowlist(
  'DISABLE ADMIN IP ALLOWLIST'
);
```

此函数不授权给 `anon`、`authenticated` 或 `service_role`，只能由数据库所有者执行。它只关闭强制开关并清除 IP attestation，不删除白名单记录；修复代理后可以重新验证并开启。
