# 私有财务质检错误同步

这条链路不会把财务表公开。Apps Script 以已有 Google 权限读取固定表格，再把
固定 A:L 数据推到 source-bound Supabase Edge Function。

## 安装

1. 先部署 `report-error-sheet-push`（`--no-verify-jwt`）。
2. 推荐把 `Code.gs` 加进已经运行 employee-master / attendance 的 Apps Script
   项目，或现有 `WFH System` 项目，这样可以复用现有私有 token /
   `STAFF_SHEET_SYNC_SECRET`。也可以单独创建项目，并在脚本属性添加
   `REPORT_ERROR_SYNC_TOKEN`。
3. 运行一次 `installReportErrorSheetSync` 并完成 Google 授权。

安装后，编辑只写一个 dirty 标记；五分钟触发器读取一次完整快照。内容 hash
没变时不请求 Supabase，每六小时强制对账一次。Edge 忙或临时失败会保留 dirty
标记并自动重试。

正常情况下表格改动在 0–5 分钟内写入错误明细，既有 10 分钟 report cron 会在
下一轮刷新员工汇总。大幅删行默认阻断；确认确实需要大幅删除时，才手工运行
`runReportErrorSheetSync`。
