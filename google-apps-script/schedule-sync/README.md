# 私有居家排班表同步（中文操作流程）

这套同步只读取固定私有表格的 `填表!A:M`，把完整快照推送到 Supabase。
人工编辑会近实时触发；公式、导入或 API 修改由每 5 分钟兜底任务发现。
每次都会先计算 SHA-256，内容没变化时通常不会调用 Edge Function。为避免
Supabase 快照被外部清除后因本地 hash 未变化而无法恢复，定时任务每 6 小时
最多强制对账一次；因此无修改时约为每天 4 次、每 30 天约 120 次调用。
`scheduleSheetOnEdit` 仍会在内容未变化时直接跳过，不会触发周期强制同步。

## 一次性安装

1. 用有该私有表编辑权限的 Google 账号打开居家排班表。
2. 点顶部「扩展程序」→「Apps Script」。
3. 把 `Code.gs` 全部复制到编辑器；在左侧「项目设置」勾选显示
   `appsscript.json`，再复制本目录的 manifest 内容。
4. 在「项目设置」→「脚本属性」新增：
   - `SCHEDULE_SYNC_URL`：
     `https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync`
   - `SCHEDULE_SYNC_TOKEN`：使用现有考勤同步的同一个原始 token。
5. 不要把 token 写进 `Code.gs`、截图、GitHub 或聊天。原始 token 只保存在
   Google Apps Script 的脚本属性中，执行日志不会输出它。
6. 回到代码编辑器，在顶部函数下拉框选择 `installScheduleSync`，点「运行」。
7. 第一次会出现 Google 授权提示；选择能够读取该私有表的账号并允许。
8. 执行成功后，在左侧「触发器」应看到两个项目：
   - 编辑时：`scheduleSheetOnEdit`
   - 每 5 分钟：`reconcileScheduleSheet`

首次快照只有在 Supabase 接收成功后才会创建触发器；若运行失败，不会留下
每 5 分钟持续重试的触发器。

安装函数会立即完成一次全量同步。以后在 `填表!A:M` 修改负责人、培训、组长、
组别、团队、姓名、ID、班次、国家、岗位、盘口或工作内容，后台将以 Supabase
快照为准更新。M 列以外或其他标签页的修改不会触发 Edge Function。

## 手动检查与故障处理

- 需要立即重读：运行 `runScheduleReconciliation()`。
- 即使表格没有变化，定时任务也会在距上次成功推送满 6 小时后自动重推完整
  快照；若 Supabase 快照曾被误清空，最迟约 6 小时可自愈。手动运行可立即恢复。
- 需要重装触发器：再次运行 `installScheduleSync()`，它会先删除旧触发器，
  不会叠加重复任务。
- 需要停用：运行 `removeScheduleSyncTriggers()`。

## 出现 HTTP 400 时

最新版 `Code.gs` 会在执行日志中同时显示服务端的非敏感校验码，例如
`snapshot_duplicate_employee_id_123`（第 123 行 ID 重复）或
`snapshot_hash_mismatch`（发送内容与校验摘要不一致）。请先把仓库中的
最新版 `Code.gs` 全量覆盖到该表绑定的 Apps Script 项目并保存，再运行
`installScheduleSync`。新版安装会先移除旧触发器，再尝试首次同步；失败时
不会继续每 5 分钟请求。把“原因 …”和请求编号一并提供即可排查，切勿复制
或截图 `SCHEDULE_SYNC_TOKEN`。修正表格后再次运行同一安装函数即可恢复触发器。
- 若提示表头错误，请确认第 1 行 A:M 依次是：
  `负责人、现场培训、线上组长、线上培训、组别、团队、姓名、ID、班次、国家、岗位、盘口、工作内容`。
- 若 HTTP 失败，先在 Apps Script 左侧「执行记录」查看请求编号，再到 Supabase
  的 `schedule_sheet_sync_runs` 查同一 `request_id`；日志不会输出表格内容或 token。

同步采用完整快照，但数据库拒绝空名单；一次异常读取不会清空上一份正常目录。
