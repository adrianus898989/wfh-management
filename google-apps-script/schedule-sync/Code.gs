/**
 * 私有居家排班表变更推送。
 *
 * 必填脚本属性（禁止把值直接写进代码）：
 *   SCHEDULE_SYNC_URL
 *   SCHEDULE_SYNC_TOKEN
 */

const SCHEDULE_SYNC_SOURCE = Object.freeze({
  sourceKey: 'home_roster_current',
  spreadsheetId: '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
  sheetGid: 1457335551,
  tabName: '填表',
  maxRows: 3500,
  columnCount: 13,
});

const SCHEDULE_SYNC_EXPECTED_HEADERS = Object.freeze([
  '负责人', '现场培训', '线上组长', '线上培训', '组别', '团队', '姓名',
  'ID', '班次', '国家', '岗位', '盘口', '工作内容',
]);
const SCHEDULE_SYNC_ON_EDIT_HANDLER = 'scheduleSheetOnEdit';
const SCHEDULE_SYNC_RECONCILE_HANDLER = 'reconcileScheduleSheet';
const SCHEDULE_SYNC_MANAGED_HANDLERS = Object.freeze([
  SCHEDULE_SYNC_ON_EDIT_HANDLER,
  SCHEDULE_SYNC_RECONCILE_HANDLER,
  // 清理早期安装可能留下的旧处理器。
  'syncScheduleSheet',
]);
const SCHEDULE_SYNC_HASH_PROPERTY = 'SCHEDULE_SYNC_LAST_HASH_home_roster_current';
const SCHEDULE_SYNC_LAST_SUCCESS_PROPERTY =
  'SCHEDULE_SYNC_LAST_SUCCESS_AT_home_roster_current';
// 相同内容也会每 6 小时最多强制对账一次，避免 Supabase 快照被外部清除后
// 因本地 hash 未变化而永久无法自愈。无变化时仍只产生约 4 次/天请求。
const SCHEDULE_SYNC_FORCE_RECONCILE_AFTER_MS = 6 * 60 * 60 * 1000;
const SCHEDULE_SYNC_EXPECTED_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync';

/**
 * 可安装的来源表 onEdit 处理器。只响应固定「填表」的 A:M 编辑，
 * 其他标签页或 M 列之后的修改不会读取表格，也不会调用 Edge Function。
 */
function scheduleSheetOnEdit(event) {
  if (!event || !event.source || !event.range) return;
  if (String(event.source.getId() || '') !== SCHEDULE_SYNC_SOURCE.spreadsheetId) return;
  const editedSheet = event.range.getSheet();
  if (
    editedSheet.getSheetId() !== SCHEDULE_SYNC_SOURCE.sheetGid ||
    editedSheet.getName() !== SCHEDULE_SYNC_SOURCE.tabName
  ) return;
  if (event.range.getColumn() > SCHEDULE_SYNC_SOURCE.columnCount) return;
  syncScheduleInternal_(false, 'change', false);
}

/**
 * 五分钟兜底：用于捕获公式、导入或 API 修改（这些修改不会触发 onEdit）。
 * 表格 hash 未改变时通常不会请求 Supabase；但距上次成功推送满 6 小时后会
 * 强制对账一次，使被外部清除的 Supabase 快照能够自动恢复。
 */
function reconcileScheduleSheet() {
  syncScheduleInternal_(false, 'change', true);
}

/** 管理员手动强制重读并推送一次。 */
function runScheduleReconciliation() {
  syncScheduleInternal_(true, 'manual', false);
}

/**
 * 首次安装入口。请由有该私有表编辑权限的 Google 账号运行一次并授权。
 */
function installScheduleSync() {
  const config = scheduleSyncConfig_();
  if (!config.url || !config.token) {
    throw new Error(
      '请先打开「项目设置 → 脚本属性」，添加 SCHEDULE_SYNC_URL 和 SCHEDULE_SYNC_TOKEN。'
    );
  }

  // 先清理早期安装留下的触发器；后续任何读取或同步失败都不会继续循环请求。
  removeScheduleSyncTriggers();
  // 安装触发器之前验证账号确实可以读取固定表格、gid 与 A:M 表头。
  readScheduleSnapshot_();

  // 首次快照必须先被 Supabase 接受。若这里失败，项目中不会遗留每 5 分钟
  // 自动重试的触发器，避免一次配置/数据错误演变成持续请求循环。
  syncScheduleInternal_(true, 'manual', false);

  ScriptApp.newTrigger(SCHEDULE_SYNC_ON_EDIT_HANDLER)
    .forSpreadsheet(SCHEDULE_SYNC_SOURCE.spreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger(SCHEDULE_SYNC_RECONCILE_HANDLER)
    .timeBased()
    .everyMinutes(5)
    .create();
}

function removeScheduleSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (SCHEDULE_SYNC_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncScheduleInternal_(force, triggerKind, allowPeriodicReconciliation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const config = scheduleSyncConfig_();
    if (!config.url || !config.token) {
      throw new Error('排班同步脚本属性不完整，请检查 URL 和 TOKEN。');
    }
    const snapshot = readScheduleSnapshot_();
    const properties = PropertiesService.getScriptProperties();
    const previousHash = properties.getProperty(SCHEDULE_SYNC_HASH_PROPERTY);
    const lastSuccessAt = Number(
      properties.getProperty(SCHEDULE_SYNC_LAST_SUCCESS_PROPERTY) || '0'
    );
    const periodicReconciliationDue = Boolean(
      allowPeriodicReconciliation &&
      (!Number.isFinite(lastSuccessAt) ||
        lastSuccessAt <= 0 ||
        Date.now() - lastSuccessAt >= SCHEDULE_SYNC_FORCE_RECONCILE_AFTER_MS)
    );
    if (!force && !periodicReconciliationDue && previousHash === snapshot.hash) return;

    const requestId = Utilities.getUuid();
    const payload = {
      request_id: requestId,
      trigger_kind: force ? triggerKind : 'change',
      source: {
        source_key: SCHEDULE_SYNC_SOURCE.sourceKey,
        spreadsheet_id: SCHEDULE_SYNC_SOURCE.spreadsheetId,
        sheet_gid: String(SCHEDULE_SYNC_SOURCE.sheetGid),
        tab_name: SCHEDULE_SYNC_SOURCE.tabName,
      },
      snapshot_hash: snapshot.hash,
      captured_at: new Date().toISOString(),
      values: snapshot.values,
    };
    const response = UrlFetchApp.fetch(config.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Schedule-Sync-Token': config.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
    });
    const responseCode = response.getResponseCode();
    let result = null;
    try {
      result = JSON.parse(response.getContentText());
    } catch (_error) {
      // 不记录响应正文，避免日志意外收集敏感内容。
    }
    if (responseCode < 200 || responseCode >= 300 || !result || result.ok !== true) {
      // 此接口只会返回经过白名单限制的校验码；将其写入 Apps Script
      // 执行日志，管理员无需查看或复制请求体即可找到具体失败原因。
      const detail = scheduleSyncSafeError_(result && result.error);
      throw new Error(
        '排班同步失败：HTTP ' + responseCode + '，请求编号 ' + requestId +
        (detail ? '，原因 ' + detail : '') + '。'
      );
    }

    // 只有数据库接受完整快照后才推进 hash；失败会在下一次触发器自动重试。
    properties.setProperties({
      [SCHEDULE_SYNC_HASH_PROPERTY]: snapshot.hash,
      [SCHEDULE_SYNC_LAST_SUCCESS_PROPERTY]: String(Date.now()),
    });
    console.log(JSON.stringify({
      source_key: SCHEDULE_SYNC_SOURCE.sourceKey,
      request_id: requestId,
      reconciliation: force ? 'manual' : periodicReconciliationDue ? 'periodic' : 'changed',
      status: result.status,
      rows: result.rows || 0,
      inserted: result.inserted || 0,
      updated: result.updated || 0,
      deleted: result.deleted || 0,
    }));
  } finally {
    lock.releaseLock();
  }
}

function scheduleSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    url: String(properties.getProperty('SCHEDULE_SYNC_URL') || '').trim(),
    token: String(properties.getProperty('SCHEDULE_SYNC_TOKEN') || '').trim(),
  };
  if (config.url && config.url !== SCHEDULE_SYNC_EXPECTED_URL) {
    throw new Error('SCHEDULE_SYNC_URL 必须与正式排班同步地址完全一致，不能带参数或使用其他域名。');
  }
  return config;
}

function readScheduleSnapshot_() {
  const spreadsheet = SpreadsheetApp.openById(SCHEDULE_SYNC_SOURCE.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(SCHEDULE_SYNC_SOURCE.tabName);
  if (!sheet) throw new Error('找不到固定标签页「' + SCHEDULE_SYNC_SOURCE.tabName + '」。');
  if (sheet.getSheetId() !== SCHEDULE_SYNC_SOURCE.sheetGid) {
    throw new Error('「填表」gid 不一致，已停止同步以避免读取错误标签页。');
  }
  // getLastRow() considers every sheet column. Find the real A:M boundary so
  // unrelated helper columns cannot create a false overflow or false change.
  let lastRow = 1;
  for (let column = 1; column <= SCHEDULE_SYNC_SOURCE.columnCount; column += 1) {
    const columnLastRow = sheet
      .getRange(sheet.getMaxRows(), column)
      .getNextDataCell(SpreadsheetApp.Direction.UP)
      .getRow();
    lastRow = Math.max(lastRow, columnLastRow);
  }
  if (lastRow > SCHEDULE_SYNC_SOURCE.maxRows) {
    throw new Error('「填表」超过 ' + SCHEDULE_SYNC_SOURCE.maxRows + ' 行，已停止同步。');
  }
  const values = sheet
    .getRange(1, 1, lastRow, SCHEDULE_SYNC_SOURCE.columnCount)
    .getDisplayValues();

  // 删除 A:M 全空尾行，避免仅格式变化造成假变更。
  while (values.length > 1 && values[values.length - 1].every(function (cell) {
    return String(cell || '').trim() === '';
  })) values.pop();

  assertScheduleHeaders_(values);
  return { values: values, hash: scheduleSha256Hex_(JSON.stringify(values)) };
}

function assertScheduleHeaders_(values) {
  if (!values || !values.length) throw new Error('「填表」A:M 表头不存在。');
  const header = values[0] || [];
  SCHEDULE_SYNC_EXPECTED_HEADERS.forEach(function (expected, column) {
    const actual = String(header[column] || '').trim().replace(/[\s\n\r]+/g, '');
    if (actual !== expected) {
      throw new Error(
        '「填表」第 ' + (column + 1) + ' 列表头不正确，应为「' + expected + '」。'
      );
    }
  });
}

/** 仅允许服务端定义的非敏感校验码进入 Apps Script 执行日志。 */
function scheduleSyncSafeError_(value) {
  const code = String(value || '').trim();
  if (/^(invalid_|source_not_allowlisted$|sheet_|snapshot_|values_|cell_|payload_|malformed_json$)/.test(code)) {
    return code;
  }
  return '';
}

function scheduleSha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function (byte) {
    const unsigned = byte < 0 ? byte + 256 : byte;
    return ('0' + unsigned.toString(16)).slice(-2);
  }).join('');
}
