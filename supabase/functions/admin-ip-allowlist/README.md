# 后台 / 员工前端登录 IP 白名单：上线与恢复

## 当前状态

本目录包含一套**可部署、但员工端默认关闭**的能力。迁移
`20260829112326_staff_portal_ip_allowlist.sql` 和本次 Edge/前端改动尚未部署时，
不能把员工前端描述为已经受白名单保护。部署迁移也不会自动开启员工限制。

现有白名单记录迁移后全部保持 `admin` 范围，不会自动套用给员工。每条网络可明确选择：

- `admin`：仅后台；
- `staff`：仅员工前端；
- `both`：两者。

后台与员工前端各有独立开关。员工开关 `staff_enforced` 默认 `false`；只有管理者
先录入员工实际网络并再次明确确认开启时才生效。一旦明确开启，空员工清单是
deny-all，而不是静默放开；SQL owner 有独立恢复开关。

## 安全模型

- GitHub Pages 只是静态前端。隐藏登录页只能减少信息暴露，不能作为安全边界。
- `/staff/login` 与 `/staff/register` 挂载表单前调用匿名 `admin-ip-preflight`
  （body `portal=staff`）；该函数必须以 `verify_jwt=false` 部署。
- `admin-login` 在密码验证前复核相同规则，并在登录成功后把网关 IP 绑定到
  `auth.sessions.id`。
- `register-employee` 在校验或消费激活码前也复核员工规则。
- admin/staff 的 claim 与 heartbeat 都经过 `admin-ip-guard`。Edge 先刷新相应
  portal 的五分钟 attestation，再允许数据库续租五分钟 lease。
- `session_private.current_app_session_is_valid()` 在原 OID 上加入 staff attestation
  检查；依赖它的 RLS 和员工自助 RPC 因而会拒绝直接绕过 Edge 的 Auth/JWT。
- 只有可信服务明确判断 `ip_not_allowed` 时才撤销对应 session。缺少代理头、
  Edge 超时或数据库临时故障只返回可重试错误，不会把网络超时误判为登出。
- allowlist 表及 mutation/attestation RPC 均不授权给 `anon`/`authenticated`。

## 真实 IP 信任边界

代码只读取 Supabase hosted Edge gateway 经 Cloudflare 写入的
`CF-Connecting-IP`。它不读取请求 body、query、`X-Forwarded-For`、
`X-Real-IP` 或自定义 header；值缺失、含代理链或是 CIDR 时直接拒绝。

如果改为 self-hosted 或绕过 Supabase hosted Cloudflare，不能沿用该信任模型；
必须由自管代理覆盖可信客户端 IP 头，并在 staging 重做防伪测试。

## 上线前必须由业务方提供

对每条允许的员工网络，需要一份明确清单：

1. 出口 IPv4 或 CIDR；
2. 出口 IPv6 或 IPv6 CIDR（如存在）；
3. 网络标签/地点/负责人；
4. 主线路或备用线路；
5. 是否为动态 IP、住宅宽带、移动网络或 VPN；
6. 哪些网络只允许后台、只允许员工、或两者。

不要猜测 CIDR，不要把当前后台的 9 条 IP 直接复制为员工范围。若大量员工使用
动态住宅/移动网络，IP allowlist 会带来高锁定风险，应先明确使用企业 VPN/固定
出口的方案。

## 安全上线顺序

1. 先应用数据库迁移，确认现有记录全部是 `admin` 且 `staff_enforced=false`。
2. 部署 `admin-ip-preflight`、`admin-login`、`register-employee` 时明确使用
   `verify_jwt=false`（它们都是取得 JWT 前的入口）；部署 `admin-ip-guard` 与
   `admin-ip-allowlist` 时必须保持 `verify_jwt=true`。员工开关仍保持关闭。
3. 部署前端；确认员工登录/激活页在 preflight 完成前不渲染表单，同时开关关闭时
   现有员工可正常登录。
4. 由 Founder/有管理权限账号逐条录入已确认的 `staff`/`both` 网络；不要批量猜测。
5. 在 staging 或受控 canary 用允许网络验证：登录页、登录、注册、claim、heartbeat、
   员工自助 RPC；再用拒绝网络验证上述所有层均拒绝。
6. 预先准备下面的 staff break-glass SQL，确认项目 owner 可使用。
7. 业务低峰期明确开启员工开关。该动作会注销现有 staff sessions，员工需从允许
   网络重新登录；admin sessions 不受影响。
8. 观察 Auth/Edge/Postgres 日志至少 15–30 分钟，再逐步扩大；不要与同步恢复或
   预警重计算等高负载变更同窗上线。

## 测试

数据库测试仅对 disposable/local database 执行：

```sh
supabase db reset
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/admin_login_ip_allowlist.sql
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/staff_portal_ip_allowlist.sql
```

Deno 与前端契约测试：

```sh
deno test supabase/functions/_shared/adminIp_test.ts
node --test src/lib/staffIpAllowlist.test.mjs
```

## Founder 锁定恢复

后台限制恢复（既有能力）：

```sql
select session_private.founder_recover_admin_ip_allowlist(
  'DISABLE ADMIN IP ALLOWLIST'
);
```

仅关闭员工前端限制：

```sql
select session_private.founder_recover_staff_ip_allowlist(
  'DISABLE STAFF IP ALLOWLIST'
);
```

两者都不授权给 `anon`、`authenticated` 或 `service_role`，只能由数据库 owner
执行。恢复函数只关闭对应开关并清除 attestation，不删除白名单记录。
