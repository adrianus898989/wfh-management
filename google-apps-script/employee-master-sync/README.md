# 员工主档双来源同步

这套脚本把两份来源作为**同一次原子快照**推送，避免一张表先到、另一张表
后到时误判离职：

- 居家员工名单：`在职名单 Current Staff List!A:P`（gid `970844334`）
- 居家排班表：`填表!A:M`（gid `1457335551`）

居家名单负责姓名、正式 ID、入离职状态和基础资料；排班表覆盖组别、团队、
岗位、班次、国家、盘口、工作内容及负责人/培训/组长。仅在排班表出现、且
“工作内容”带“现场人员”的正式 ID，会作为现场人员补充进员工主档。

## 安装

1. 建议把本文件加入已成功运行的 `August Attendance New` 或现有排班同步 Apps Script 项目；运行账号必须能读取两张员工来源表。安装时会移除旧的排班单来源触发器，避免两条写入链竞争。
2. 复制本目录的 `Code.gs` 与 `appsscript.json`。
3. 在脚本属性设置：
   - `EMPLOYEE_MASTER_SYNC_URL`：可选；优先使用且必须精确等于正式员工主档端点。
   - `EMPLOYEE_MASTER_SYNC_TOKEN`：可选；优先使用。
   - 若未设置以上两项，可复用精确匹配正式地址的 `SCHEDULE_SYNC_URL` 与 `SCHEDULE_SYNC_TOKEN`；若排班配置也没有，则复用 `August Attendance New` 已有的 `ATTENDANCE_SYNC_URL` 与 `ATTENDANCE_SYNC_TOKEN`。
   - 优先级固定为员工主档、排班、考勤；任一被选中的来源 URL 必须与正式地址完全一致，最终请求地址始终固定为正式 `employee-master-sync`，不会由任意 URL 拼接。原始 token 仍不写入代码或日志。
4. 运行 `installEmployeeMasterSync` 并授权。

安装过程会先完成一次全量只读校验，再为两张表各建立一个 onEdit 和一个
onChange，并建立一个每分钟 dirty 刷新器和一个十分钟兜底对账触发器，然后
尝试首次入库。onEdit 负责单元格编辑，onChange 只负责整行插入/删除；两者都只
写 dirty token，不读取整表。刷新器在最后一次变更至少 45 秒后合并读取两份
原子快照。
若当前存在重复 ID，同一错误 hash 会被阻断，不会重复请求；六小时后周期任务会
有限重试，修正表格后也会自动继续。
401/403/429 和服务端错误不会永久阻断同一 hash。内容没变时不会调用 Supabase；
每六小时最多强制一次完整对账。

若生产触发器清单里两个 `employeeMasterOnEdit`、两个
`employeeMasterOnChange` 与
`reconcileEmployeeMaster` 都正常、唯独缺少
`flushPendingEmployeeMasterSync`，不要运行完整安装器。只运行一次
`installMissingEmployeeMasterFlushTrigger`：它只补一个每分钟 flusher，重复运行不
会新增副本，也不会删除或重建现有触发器。代码复制到 Apps Script 但未运行此
函数时，Google 不会自动创建触发器。

若现有自动同步只缺整行插入/删除监听，运行一次
`installMissingEmployeeMasterChangeTriggers`。它只审计并补齐两张固定来源表各一个
`employeeMasterOnChange`，不会删除或重建 onEdit、flusher、reconcile。正确的现有
触发器会原样保留；若发现同名触发器重复、事件类型错误或绑定到其他 Spreadsheet，
函数会在创建任何新触发器前报错，需先人工核对。

## 安全规则

- 任一来源表头漂移、空读、hash 不匹配或 ID 重复时，整次同步失败，上一份正常
  快照和员工主档不变。
- 重复 ID 会返回 ID 和两个来源行号。例如当前排班表的 AKI 重复问题修正后，
  下一次触发会自动恢复，无需改代码。
- 居家名单不会因为标签名叫“在职名单”就把历史行都当在职；离职日期或后台
  账号中的严格“辞职/离职/resigned/terminated”标记会保留为明确离职证据；
  “未离职/非离职/not-resigned”等否定值不会误判。
- 同时从两张表消失只会新增 `pending_manual_review` 人工复核记录；无论连续缺席
  几次，都绝不自动改员工状态、停用前端账号或删除 Auth 用户。
- 居家表 A:P 仍完整读取、校验表头和原始 hash；只有主档实际使用的 A:L（含规范
  日期）参与变更 hash。M:P 的薪资/绩效编辑不会触发 Supabase 请求。
- 运行 `runEmployeeMasterReconciliation` 可手动强制校验；运行
  `removeEmployeeMasterSyncTriggers` 可停用自动同步。
