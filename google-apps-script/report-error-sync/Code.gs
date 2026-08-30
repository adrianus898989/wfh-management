/**
 * 私有财务质检错误表 -> Supabase。
 *
 * 推荐将本文件加入已授权的 employee-master / attendance Apps Script 项目，
 * 直接复用其私有 token；不要把财务表改成公开链接。
 */

const REPORT_ERROR_SYNC_SOURCE = Object.freeze({
  sourceName: '财务质检错误记录/财务质检错误记录',
  spreadsheetId: '125rN-PXjjWMe4SnYjruGlQ_NdZUb5hI7dXUUBjqe7bY',
  sheetGid: 0,
  tabName: '财务质检错误记录',
  columnCount: 12,
  maxRows: 5000,
});
const REPORT_ERROR_SYNC_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/report-error-sheet-push';
const REPORT_ERROR_SYNC_PROTOCOL = 'report-error-sheet-push-v1';
const REPORT_ERROR_SYNC_ON_EDIT_HANDLER = 'reportErrorSheetOnEdit';
const REPORT_ERROR_SYNC_FLUSH_HANDLER = 'flushReportErrorSheetSync';
const REPORT_ERROR_SYNC_MANAGED_HANDLERS = Object.freeze([
  REPORT_ERROR_SYNC_ON_EDIT_HANDLER,
  REPORT_ERROR_SYNC_FLUSH_HANDLER,
]);
const REPORT_ERROR_SYNC_DIRTY = 'REPORT_ERROR_SYNC_DIRTY_v1';
const REPORT_ERROR_SYNC_LAST_HASH = 'REPORT_ERROR_SYNC_LAST_HASH_v1';
const REPORT_ERROR_SYNC_LAST_SUCCESS = 'REPORT_ERROR_SYNC_LAST_SUCCESS_AT_v1';
const REPORT_ERROR_SYNC_RETRY_AFTER = 'REPORT_ERROR_SYNC_RETRY_AFTER_v1';
const REPORT_ERROR_SYNC_FORCE_RECONCILE_MS = 6 * 60 * 60 * 1000;

const REPORT_ERROR_HEADER_ALIASES = Object.freeze([
  ['a', 'ID', '员工ID', '員工ID'],
  ['会员/id /订单号', '會員/id /訂單號'],
  ['金额', '金額'],
  ['错误备注', '錯誤備註'],
  ['正确操作方式', '正確操作方式'],
  ['错误类型', '錯誤類型'],
  ['扣分'],
  ['质检人', '質檢人'],
  ['质检时间', '質檢時間'],
  ['小组长复审', '小組長複審'],
  ['质检人对错', '质检人对/错', '質檢人對錯'],
  ['复检时间', '複檢時間'],
]);

function reportErrorSheetOnEdit(event) {
  if (!event || !event.source || !event.range) return;
  if (String(event.source.getId() || '') !== REPORT_ERROR_SYNC_SOURCE.spreadsheetId) return;
  const sheet = event.range.getSheet();
  if (sheet.getSheetId() !== REPORT_ERROR_SYNC_SOURCE.sheetGid ||
      sheet.getName() !== REPORT_ERROR_SYNC_SOURCE.tabName) return;
  if (event.range.getRow() < 2 || event.range.getColumn() > REPORT_ERROR_SYNC_SOURCE.columnCount) return;
  PropertiesService.getScriptProperties().setProperty(REPORT_ERROR_SYNC_DIRTY, String(Date.now()));
}

/** 安装后，表格改动最迟在下一次五分钟触发时推送。 */
function installReportErrorSheetSync() {
  reportErrorSyncConfig_();
  readReportErrorSnapshot_();
  removeReportErrorSheetSyncTriggers();
  ScriptApp.newTrigger(REPORT_ERROR_SYNC_ON_EDIT_HANDLER)
    .forSpreadsheet(REPORT_ERROR_SYNC_SOURCE.spreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger(REPORT_ERROR_SYNC_FLUSH_HANDLER)
    .timeBased()
    .everyMinutes(5)
    .create();
  PropertiesService.getScriptProperties().setProperty(REPORT_ERROR_SYNC_DIRTY, String(Date.now()));
  syncReportErrorSheetInternal_(true, false);
}

function removeReportErrorSheetSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (REPORT_ERROR_SYNC_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function flushReportErrorSheetSync() {
  syncReportErrorSheetInternal_(false, false);
}

/** 手工确认源表确实大幅删行时，才运行此函数允许缩表。 */
function runReportErrorSheetSync() {
  syncReportErrorSheetInternal_(true, true);
}

function syncReportErrorSheetInternal_(force, allowLargeDelete) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return;
  try {
    const properties = PropertiesService.getScriptProperties();
    const retryAfter = Number(properties.getProperty(REPORT_ERROR_SYNC_RETRY_AFTER) || '0');
    if (!force && retryAfter > Date.now()) return;
    const dirty = Boolean(properties.getProperty(REPORT_ERROR_SYNC_DIRTY));
    const lastSuccess = Number(properties.getProperty(REPORT_ERROR_SYNC_LAST_SUCCESS) || '0');
    const periodicDue = !lastSuccess || Date.now() - lastSuccess >= REPORT_ERROR_SYNC_FORCE_RECONCILE_MS;
    if (!force && !dirty && !periodicDue) return;

    const config = reportErrorSyncConfig_();
    const snapshot = readReportErrorSnapshot_();
    const previousHash = properties.getProperty(REPORT_ERROR_SYNC_LAST_HASH);
    if (!force && !periodicDue && previousHash === snapshot.hash) {
      properties.deleteProperty(REPORT_ERROR_SYNC_DIRTY);
      return;
    }

    const requestId = Utilities.getUuid();
    const payload = {
      protocol_version: REPORT_ERROR_SYNC_PROTOCOL,
      request_id: requestId,
      captured_at: new Date().toISOString(),
      snapshot_hash: snapshot.hash,
      allow_large_delete: Boolean(allowLargeDelete),
      source: {
        source_name: REPORT_ERROR_SYNC_SOURCE.sourceName,
        spreadsheet_id: REPORT_ERROR_SYNC_SOURCE.spreadsheetId,
        sheet_gid: String(REPORT_ERROR_SYNC_SOURCE.sheetGid),
        tab_name: REPORT_ERROR_SYNC_SOURCE.tabName,
      },
      values: snapshot.values,
    };
    const response = UrlFetchApp.fetch(config.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Report-Error-Sync-Token': config.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
    });
    const responseCode = response.getResponseCode();
    let result = null;
    try { result = JSON.parse(response.getContentText()); } catch (_error) {}
    if (responseCode < 200 || responseCode >= 300 || !result || result.ok !== true) {
      const retrySeconds = Number(response.getHeaders()['Retry-After'] || 0);
      const retryDelay = Math.max(60, Math.min(15 * 60, retrySeconds || 5 * 60));
      if (responseCode === 409 || responseCode === 429 || responseCode >= 500) {
        properties.setProperty(REPORT_ERROR_SYNC_RETRY_AFTER, String(Date.now() + retryDelay * 1000));
      }
      throw new Error(
        '财务质检同步失败：HTTP ' + responseCode + '，请求编号 ' + requestId +
        (result && result.error ? '，原因 ' + String(result.error) : '')
      );
    }

    properties.setProperties({
      [REPORT_ERROR_SYNC_LAST_HASH]: snapshot.hash,
      [REPORT_ERROR_SYNC_LAST_SUCCESS]: String(Date.now()),
    });
    properties.deleteProperty(REPORT_ERROR_SYNC_DIRTY);
    properties.deleteProperty(REPORT_ERROR_SYNC_RETRY_AFTER);
    console.log(JSON.stringify({
      request_id: requestId,
      raw_rows: result.raw_rows || 0,
      normalized_rows: result.normalized_rows || 0,
      changed_chunks: result.changed_chunks || 0,
    }));
  } finally {
    lock.releaseLock();
  }
}

function reportErrorSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const configuredUrl = String(properties.getProperty('REPORT_ERROR_SYNC_URL') || '').trim();
  if (configuredUrl && configuredUrl !== REPORT_ERROR_SYNC_URL) {
    throw new Error('REPORT_ERROR_SYNC_URL 必须与正式财务质检同步地址完全一致。');
  }
  const token = String(
    properties.getProperty('REPORT_ERROR_SYNC_TOKEN') ||
    properties.getProperty('EMPLOYEE_MASTER_SYNC_TOKEN') ||
    properties.getProperty('ATTENDANCE_SYNC_TOKEN') ||
    properties.getProperty('SCHEDULE_SYNC_TOKEN') ||
    properties.getProperty('STAFF_SHEET_SYNC_SECRET') ||
    properties.getProperty('WFH_SUPABASE_SYNC_SECRET') || ''
  ).trim();
  if (!token) {
    throw new Error('请在脚本属性设置 REPORT_ERROR_SYNC_TOKEN，或复用已有 WFH/员工主档/考勤/排班 token。');
  }
  return { url: REPORT_ERROR_SYNC_URL, token: token };
}

function readReportErrorSnapshot_() {
  const spreadsheet = SpreadsheetApp.openById(REPORT_ERROR_SYNC_SOURCE.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(REPORT_ERROR_SYNC_SOURCE.tabName);
  if (!sheet || sheet.getSheetId() !== REPORT_ERROR_SYNC_SOURCE.sheetGid) {
    throw new Error('财务质检工作表 ID、gid 或标签不匹配。');
  }
  const headers = sheet.getRange(1, 1, 1, REPORT_ERROR_SYNC_SOURCE.columnCount).getDisplayValues()[0];
  validateReportErrorHeaders_(headers);
  const lastRow = Math.min(sheet.getLastRow(), REPORT_ERROR_SYNC_SOURCE.maxRows + 1);
  if (lastRow < 2) throw new Error('财务质检表为空；为防误删，已拒绝同步。');
  const values = sheet.getRange(2, 1, lastRow - 1, REPORT_ERROR_SYNC_SOURCE.columnCount)
    .getDisplayValues()
    .map(function (row) { return row.map(function (cell) { return String(cell || ''); }); })
    .filter(function (row) { return row.some(function (cell) { return cell.trim() !== ''; }); });
  if (!values.length) throw new Error('财务质检表没有有效数据；为防误删，已拒绝同步。');
  return { values: values, hash: reportErrorSha256Hex_(JSON.stringify(values)) };
}

function validateReportErrorHeaders_(headers) {
  REPORT_ERROR_HEADER_ALIASES.forEach(function (aliases, index) {
    const actual = String(headers[index] || '').trim();
    if (aliases.indexOf(actual) === -1) {
      throw new Error(
        '财务质检表第 ' + (index + 1) + ' 列标题不匹配：' + actual +
        '；允许：' + aliases.join(' / ')
      );
    }
  });
}

function reportErrorSha256Hex_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  ).map(function (byte) {
    const normalized = byte < 0 ? byte + 256 : byte;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}
