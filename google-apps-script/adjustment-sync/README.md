# 奖金 / 扣除双向同步（本地源码）

后台先在一个数据库事务内保存 canonical 记录和 outbox；Apps Script 每分钟批量写入 Google，收到回执后才把状态改为 `synced`。Google 人工编辑使用 `external_id + source_slot + origin + revision` 回传，不创建返程 outbox，因此不会形成同步循环。

此目录不负责首次全量或普通历史行导入：

- 没有协议 metadata 的普通 / 历史行由 annual attendance sync 导入和每日 hash 对账。
- 已有有效 metadata triplet 的 managed 行（菲律宾为 managed slot）由这里的 `adjustment-v1` 双向协议负责；annual parser 必须跳过相应 managed 数据，避免重复。
- 本脚本不会另跑一遍历史全量导入。

## 固定路由

- 现场转居家（USD，`填表` gid `1011694934`）：9–12 月依次 `A:F`、`H:M`、`O:T`、`V:AA`，列为姓名 / ID / 奖金 / 扣除 / 备注 / 日期。
- 居家越南 / 印尼 / 缅甸（USD，`填表` gid `3368572`）：相同标准布局。
- 居家菲律宾（PHP，`填表` gid `687407921`）：9–12 月依次 `A:G`、`I:O`、`Q:W`、`Y:AE`，列为姓名 / ID / 金额1-15 / 金额16-末 / 备注1-15 / 备注16-末 / 日期。

标准表的正数写入“奖金”，负数保留负号写入“扣除”。菲律宾两个金额槽也原样保留正负号；同一 Google 行两个非零金额会拆成两个 canonical 记录，各自拥有独立 `external_id` 和 `revision`。后台新增菲律宾记录时由日期确定 `source_slot`，后续编辑不能跨越 1–15 / 16–月末边界。

## 协议 metadata 映射

标准表每月 3 列，顺序都是 `external_id / origin / revision`：

- 9 月 `AB:AD`
- 10 月 `AE:AG`
- 11 月 `AH:AJ`
- 12 月 `AK:AM`

菲律宾表每月 6 列；前三列属于 `first_half`，后三列属于 `second_half`：

- 9 月 `AF:AH` / `AI:AK`
- 10 月 `AL:AN` / `AO:AQ`
- 11 月 `AR:AT` / `AU:AW`
- 12 月 `AX:AZ` / `BA:BC`

安装前会先只读检查全部 12 个数据块、固定 gid、业务表头以及完整 metadata 区域。只有全部通过才会写并隐藏协议表头。Google onEdit 在同一个 `ScriptLock` 内分配 revision、写入持久重试队列和 metadata；网络发送在解锁后执行。

Google→Supabase 的持久队列按 1 分钟起步做指数退避，最高每小时一次；员工目录尚未同步或其他持续性错误不会每分钟重复消耗 Supabase 请求。成功后才删除队列项，期间仍复用同一个 `request_id`。

Supabase 后台编辑必须提交当前 `expected_revision`。若期间 Google 或另一位管理员已更新，RPC 返回 `adjustment_revision_conflict`，整个事务回滚，现有记录和 outbox 都保留，页面提示刷新后重新编辑。Google 编辑使用 `max(现有 revision + 1, 当前毫秒时间)`，避免 Google 与后台从同一版本并发编辑时产生相同 revision；outbox 也不会覆盖同 revision 的 Google 版本。非空员工 ID 只做 canonical ID 精确匹配；找不到不会按姓名兜底，重复 ID 会 fail closed。

## 上线前配置（本次代码未执行）

1. 先应用数据库 migration，再部署 `adjustment-sheet-sync` Edge Function；平台 JWT 校验关闭，函数自身用私有 token 的 SHA-256 校验，并保留 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`。
2. 在 Apps Script 的 Script Properties 设置：
   - `ADJUSTMENT_SYNC_URL`：Edge Function 完整 URL；
   - `ADJUSTMENT_SYNC_TOKEN`：可选；和考勤脚本同项目时自动复用 `ATTENDANCE_SYNC_TOKEN`；
   - `ADJUSTMENT_HEADER_ROW`：可选，默认 `2`。
3. 三份工作簿都授权给脚本运行账号，执行 `installAdjustmentSync()`。
4. 先用预发布记录验证后台依次显示“Supabase 已保存 / Google 待同步”和“Google 已同步”，再开放正式录入。

若业务表头不在第 2 行，只修改 Script Property 后重新安装，不要绕过预检。`removeAdjustmentSyncTriggers()` 只移除本脚本触发器，不删除表格数据或 metadata。

## 本地验证

```sh
node --test google-apps-script/adjustment-sync/Code.test.mjs
deno test supabase/functions/adjustment-sheet-sync/protocol_test.ts
deno check supabase/functions/adjustment-sheet-sync/index.ts
```
