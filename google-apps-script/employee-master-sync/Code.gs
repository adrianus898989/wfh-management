/**
 * 居家员工主档双来源同步。
 *
 * 脚本属性按 employee-master、schedule、attendance 顺序复用；所有 URL
 * 必须精确命中正式白名单，原始 token 禁止写进代码。
 */

const EMPLOYEE_MASTER_HOME_SOURCE = Object.freeze({
  sourceKey: 'home_employee_roster_current',
  spreadsheetId: '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
  sheetGid: 970844334,
  tabName: '在职名单 Current Staff List',
  maxRows: 5000,
  columnCount: 16,
  syncColumnCount: 12,
  headerRow: 2,
});

const EMPLOYEE_MASTER_SCHEDULE_SOURCE = Object.freeze({
  sourceKey: 'home_schedule_roster_current',
  spreadsheetId: '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
  sheetGid: 1457335551,
  tabName: '填表',
  maxRows: 3500,
  columnCount: 13,
  syncColumnCount: 13,
  headerRow: 1,
});

const EMPLOYEE_MASTER_HOME_HEADERS = Object.freeze([
  '盘口国家', '盘口岗位Platformposition', '岗位', '班次', '国家country', '名字Name', 'ID',
  '入职日期hiredateY/M/D', '离职日期', '工作飞机WorkTG', '后台账号', '离职原因Reason',
  '底薪', '涨底薪', '绩效', 'KPI',
]);

const EMPLOYEE_MASTER_SCHEDULE_HEADERS = Object.freeze([
  '负责人', '现场培训', '线上组长', '线上培训', '组别', '团队', '姓名',
  'ID', '班次', '国家', '岗位', '盘口', '工作内容',
]);

const EMPLOYEE_MASTER_ON_EDIT_HANDLER = 'employeeMasterOnEdit';
const EMPLOYEE_MASTER_FLUSH_HANDLER = 'flushPendingEmployeeMasterSync';
const EMPLOYEE_MASTER_RECONCILE_HANDLER = 'reconcileEmployeeMaster';
const EMPLOYEE_MASTER_MANAGED_HANDLERS = Object.freeze([
  EMPLOYEE_MASTER_ON_EDIT_HANDLER,
  EMPLOYEE_MASTER_FLUSH_HANDLER,
  EMPLOYEE_MASTER_RECONCILE_HANDLER,
  // This project replaces the old schedule-only writer.
  'scheduleSheetOnEdit',
  'reconcileScheduleSheet',
  'syncScheduleSheet',
]);
const EMPLOYEE_MASTER_HASH_PROPERTY = 'EMPLOYEE_MASTER_LAST_HASH_dual_source_v1';
const EMPLOYEE_MASTER_DIRTY_PROPERTY = 'EMPLOYEE_MASTER_DIRTY_dual_source_v1';
const EMPLOYEE_MASTER_BLOCKED_HASH_PROPERTY = 'EMPLOYEE_MASTER_BLOCKED_HASH_dual_source_v1';
const EMPLOYEE_MASTER_LAST_SUCCESS_PROPERTY = 'EMPLOYEE_MASTER_LAST_SUCCESS_AT_dual_source_v1';
const EMPLOYEE_MASTER_DEBOUNCE_MS = 45 * 1000;
const EMPLOYEE_MASTER_FORCE_RECONCILE_AFTER_MS = 6 * 60 * 60 * 1000;
const EMPLOYEE_MASTER_BLOCK_RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const EMPLOYEE_MASTER_EXPECTED_SCHEDULE_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync';
const EMPLOYEE_MASTER_EXPECTED_ATTENDANCE_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync';
const EMPLOYEE_MASTER_EXPECTED_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync';

/**
 * 两张来源表的可安装 onEdit。只有固定 gid 和主数据列的编辑会触发读取。
 * 编辑事件只写一个轻量 dirty token；分钟级 flusher 再同时读取两份完整快照，
 * 避免大批粘贴产生并发全表读取，也避免两份来源先后到达导致误离职。
 */
function employeeMasterOnEdit(event) {
  if (!event || !event.source || !event.range) return;
  const sourceId = String(event.source.getId() || '');
  const sheet = event.range.getSheet();
  let source = null;
  if (sourceId === EMPLOYEE_MASTER_HOME_SOURCE.spreadsheetId) source = EMPLOYEE_MASTER_HOME_SOURCE;
  if (sourceId === EMPLOYEE_MASTER_SCHEDULE_SOURCE.spreadsheetId) source = EMPLOYEE_MASTER_SCHEDULE_SOURCE;
  if (!source) return;
  if (sheet.getSheetId() !== source.sheetGid || sheet.getName() !== source.tabName) return;
  // Home M:P (pay/performance) is validated in the raw A:P snapshot but is
  // outside employee-master ownership, so those edits must not make HTTP calls.
  if (event.range.getColumn() > source.syncColumnCount) return;
  PropertiesService.getScriptProperties().setProperty(
    EMPLOYEE_MASTER_DIRTY_PROPERTY,
    JSON.stringify({ token: Utilities.getUuid(), dirty_at: Date.now() })
  );
}

/**
 * 分钟级刷新器。成功、内容已恢复到上一份成功 hash，或当前 hash 已记录为
 * 确定性阻断后清 dirty；锁冲突和网络错误保留 token。新编辑会生成新 token，
 * 而十分钟对账仍会在冷却后有界重试，避免坏 hash 永久每分钟读取两张整表。
 */
function flushPendingEmployeeMasterSync() {
  const properties = PropertiesService.getScriptProperties();
  const stored = properties.getProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY);
  const dirty = employeeMasterDirtyState_(stored);
  if (!dirty.token) return;
  if (dirty.dirtyAt > 0 && Date.now() - dirty.dirtyAt < EMPLOYEE_MASTER_DEBOUNCE_MS) return;
  const complete = syncEmployeeMasterInternal_(false, 'change', false);
  if (complete && properties.getProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY) === stored) {
    properties.deleteProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY);
  }
}

/**
 * 十分钟只做 hash 对账；内容没变不会请求 Supabase。每六小时最多强制一次
 * 完整对账，让数据库快照在被意外清空时能够自愈。
 */
function reconcileEmployeeMaster() {
  const properties = PropertiesService.getScriptProperties();
  const stored = properties.getProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY);
  const complete = syncEmployeeMasterInternal_(false, 'change', true);
  if (complete && stored && properties.getProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY) === stored) {
    properties.deleteProperty(EMPLOYEE_MASTER_DIRTY_PROPERTY);
  }
}

function runEmployeeMasterReconciliation() {
  syncEmployeeMasterInternal_(true, 'manual', false);
}

/** 首次安装：先校验两份表，再替换旧排班触发器并尝试第一次推送。 */
function installEmployeeMasterSync() {
  const config = employeeMasterSyncConfig_();
  if (!config.url || !config.token) {
    throw new Error('请先设置 EMPLOYEE_MASTER_SYNC_URL 和 EMPLOYEE_MASTER_SYNC_TOKEN。');
  }
  readEmployeeMasterSnapshot_();
  removeEmployeeMasterSyncTriggers();
  ScriptApp.newTrigger(EMPLOYEE_MASTER_ON_EDIT_HANDLER)
    .forSpreadsheet(EMPLOYEE_MASTER_HOME_SOURCE.spreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger(EMPLOYEE_MASTER_ON_EDIT_HANDLER)
    .forSpreadsheet(EMPLOYEE_MASTER_SCHEDULE_SOURCE.spreadsheetId)
    .onEdit()
    .create();
  ScriptApp.newTrigger(EMPLOYEE_MASTER_FLUSH_HANDLER)
    .timeBased()
    .everyMinutes(1)
    .create();
  ScriptApp.newTrigger(EMPLOYEE_MASTER_RECONCILE_HANDLER)
    .timeBased()
    .everyMinutes(10)
    .create();

  // Triggers deliberately exist before this call. A duplicate-ID snapshot is
  // blocked by hash (zero repeat HTTP), while the next correction changes the
  // hash and is picked up automatically.
  syncEmployeeMasterInternal_(true, 'manual', false);
}

/**
 * 生产环境仅缺 flusher 时使用。它不会删除或重建两个 onEdit 与 reconcile，
 * 且重复运行不会制造重复触发器。
 */
function installMissingEmployeeMasterFlushTrigger() {
  const config = employeeMasterSyncConfig_();
  if (!config.url || !config.token) {
    throw new Error('请先设置员工主档同步 URL 与 token。');
  }
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === EMPLOYEE_MASTER_FLUSH_HANDLER;
  });
  if (existing.length > 1) {
    throw new Error('检测到多个员工主档 flusher；请先人工核对，未自动删除任何触发器。');
  }
  if (existing.length === 1) return;
  ScriptApp.newTrigger(EMPLOYEE_MASTER_FLUSH_HANDLER)
    .timeBased()
    .everyMinutes(1)
    .create();
}

function removeEmployeeMasterSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (EMPLOYEE_MASTER_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncEmployeeMasterInternal_(force, triggerKind, allowPeriodicReconciliation) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return false;
  try {
    const config = employeeMasterSyncConfig_();
    if (!config.url || !config.token) throw new Error('员工主档同步脚本属性不完整。');
    const snapshot = readEmployeeMasterSnapshot_();
    const properties = PropertiesService.getScriptProperties();
    const previousHash = properties.getProperty(EMPLOYEE_MASTER_HASH_PROPERTY);
    const blocked = employeeMasterBlockedState_(
      properties.getProperty(EMPLOYEE_MASTER_BLOCKED_HASH_PROPERTY)
    );
    const lastSuccessAt = Number(properties.getProperty(EMPLOYEE_MASTER_LAST_SUCCESS_PROPERTY) || '0');
    const periodicDue = Boolean(
      allowPeriodicReconciliation &&
      (!Number.isFinite(lastSuccessAt) || lastSuccessAt <= 0 ||
        Date.now() - lastSuccessAt >= EMPLOYEE_MASTER_FORCE_RECONCILE_AFTER_MS)
    );
    if (!force && blocked.hash === snapshot.hash) {
      const blockStillCoolingDown = blocked.blockedAt > 0 &&
        Date.now() - blocked.blockedAt < EMPLOYEE_MASTER_BLOCK_RETRY_AFTER_MS;
      // onEdit never retries an unchanged deterministic bad snapshot. The
      // periodic reconciler gets one retry after the bounded cooldown; another
      // deterministic rejection renews the cooldown, avoiding timer spam.
      if (!allowPeriodicReconciliation || blockStillCoolingDown) return true;
    }
    if (!force && !periodicDue && previousHash === snapshot.hash) return true;

    const requestId = Utilities.getUuid();
    const payload = {
      request_id: requestId,
      trigger_kind: force ? triggerKind : 'change',
      captured_at: new Date().toISOString(),
      snapshot_hash: snapshot.hash,
      sources: {
        home_roster: {
          source: employeeMasterSourceMetadata_(EMPLOYEE_MASTER_HOME_SOURCE),
          snapshot_hash: snapshot.home.hash,
          values: snapshot.home.values,
          date_values: snapshot.home.dateValues,
        },
        schedule_roster: {
          source: employeeMasterSourceMetadata_(EMPLOYEE_MASTER_SCHEDULE_SOURCE),
          snapshot_hash: snapshot.schedule.hash,
          values: snapshot.schedule.values,
        },
      },
    };
    const response = UrlFetchApp.fetch(config.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Employee-Master-Sync-Token': config.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
    });
    const responseCode = response.getResponseCode();
    let result = null;
    try {
      result = JSON.parse(response.getContentText());
    } catch (_error) {
      // 响应正文可能含内部错误，不直接写日志。
    }
    if (responseCode < 200 || responseCode >= 300 || !result || result.ok !== true) {
      const safe = employeeMasterSafeError_(result);
      if (employeeMasterShouldBlockSnapshot_(responseCode, result)) {
        properties.setProperty(EMPLOYEE_MASTER_BLOCKED_HASH_PROPERTY, JSON.stringify({
          hash: snapshot.hash,
          blocked_at: Date.now(),
          error_code: employeeMasterResponseErrorCode_(result),
        }));
      } else if (blocked.hash === snapshot.hash) {
        // Clear legacy/generic 4xx poison after a retryable response so a token
        // correction or rate-limit recovery can resume without a content edit.
        properties.deleteProperty(EMPLOYEE_MASTER_BLOCKED_HASH_PROPERTY);
      }
      throw new Error(
        '员工主档同步失败：HTTP ' + responseCode + '，请求编号 ' + requestId +
        (safe ? '，原因 ' + safe : '') + '。'
      );
    }

    properties.setProperties({
      [EMPLOYEE_MASTER_HASH_PROPERTY]: snapshot.hash,
      [EMPLOYEE_MASTER_LAST_SUCCESS_PROPERTY]: String(Date.now()),
    });
    properties.deleteProperty(EMPLOYEE_MASTER_BLOCKED_HASH_PROPERTY);
    console.log(JSON.stringify({
      request_id: requestId,
      status: result.status,
      home_rows: result.home_rows || 0,
      schedule_rows: result.schedule_rows || 0,
      inserted: result.inserted || 0,
      updated: result.updated || 0,
      rekeyed: result.rekeyed || 0,
      pending_departure: result.pending_departure || 0,
      archived: result.archived || 0,
    }));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function employeeMasterSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const scheduleUrl = String(properties.getProperty('SCHEDULE_SYNC_URL') || '').trim();
  const attendanceUrl = String(properties.getProperty('ATTENDANCE_SYNC_URL') || '').trim();
  const employeeMasterUrl = String(
    properties.getProperty('EMPLOYEE_MASTER_SYNC_URL') || ''
  ).trim();
  const employeeMasterToken = String(
    properties.getProperty('EMPLOYEE_MASTER_SYNC_TOKEN') || ''
  ).trim();
  const scheduleToken = String(properties.getProperty('SCHEDULE_SYNC_TOKEN') || '').trim();
  const attendanceToken = String(properties.getProperty('ATTENDANCE_SYNC_TOKEN') || '').trim();
  let url = employeeMasterUrl;
  if (!url && scheduleUrl) {
    if (scheduleUrl !== EMPLOYEE_MASTER_EXPECTED_SCHEDULE_URL) {
      throw new Error('SCHEDULE_SYNC_URL 必须与正式排班同步地址完全一致。');
    }
    // Reuse the existing project's authorization material, but never derive a
    // destination from an arbitrary URL supplied through Script Properties.
    url = EMPLOYEE_MASTER_EXPECTED_URL;
  } else if (!url && attendanceUrl) {
    if (attendanceUrl !== EMPLOYEE_MASTER_EXPECTED_ATTENDANCE_URL) {
      throw new Error('ATTENDANCE_SYNC_URL 必须与正式考勤同步地址完全一致。');
    }
    // The proven August Attendance project may reuse its matching shared token,
    // but the employee-master destination remains a literal allowlisted URL.
    url = EMPLOYEE_MASTER_EXPECTED_URL;
  }
  const config = {
    url: url,
    token: employeeMasterToken || scheduleToken || attendanceToken,
  };
  if (config.url && config.url !== EMPLOYEE_MASTER_EXPECTED_URL) {
    throw new Error('EMPLOYEE_MASTER_SYNC_URL 必须与正式员工主档同步地址完全一致。');
  }
  return config;
}

function employeeMasterSourceMetadata_(source) {
  return {
    source_key: source.sourceKey,
    spreadsheet_id: source.spreadsheetId,
    sheet_gid: String(source.sheetGid),
    tab_name: source.tabName,
  };
}

function readEmployeeMasterSnapshot_() {
  const home = readHomeRosterSnapshot_();
  const schedule = readScheduleRosterSnapshot_();
  const hash = employeeMasterSha256Hex_(JSON.stringify({
    home: home.semanticHash,
    schedule: schedule.semanticHash,
  }));
  return { home: home, schedule: schedule, hash: hash };
}

function readHomeRosterSnapshot_() {
  const result = readSourceValues_(EMPLOYEE_MASTER_HOME_SOURCE, EMPLOYEE_MASTER_HOME_HEADERS);
  const sheet = result.sheet;
  const rawDates = sheet.getRange(1, 8, result.values.length, 2).getValues();
  const timezone = sheet.getParent().getSpreadsheetTimeZone() || Session.getScriptTimeZone();
  const dateValues = rawDates.map(function (row, index) {
    if (index < EMPLOYEE_MASTER_HOME_SOURCE.headerRow) return ['', ''];
    return [
      employeeMasterCanonicalDate_(row[0], result.values[index][7], timezone),
      employeeMasterCanonicalDate_(row[1], result.values[index][8], timezone),
    ];
  });
  const hash = employeeMasterSha256Hex_(JSON.stringify({ values: result.values, date_values: dateValues }));
  const semanticHash = employeeMasterSha256Hex_(JSON.stringify(
    employeeMasterHomeSemanticProjection_(result.values, dateValues)
  ));
  return { values: result.values, dateValues: dateValues, hash: hash, semanticHash: semanticHash };
}

function readScheduleRosterSnapshot_() {
  const result = readSourceValues_(EMPLOYEE_MASTER_SCHEDULE_SOURCE, EMPLOYEE_MASTER_SCHEDULE_HEADERS);
  const hash = employeeMasterSha256Hex_(JSON.stringify(result.values));
  return { values: result.values, hash: hash, semanticHash: hash };
}

function employeeMasterHomeSemanticProjection_(values, dateValues) {
  let end = values.length;
  while (end > EMPLOYEE_MASTER_HOME_SOURCE.headerRow) {
    const row = values[end - 1].slice(0, 12);
    const dates = dateValues[end - 1] || ['', ''];
    const hasSyncedValue = row.some(function (cell) {
      return String(cell || '').trim() !== '';
    }) || dates.some(function (cell) {
      return String(cell || '').trim() !== '';
    });
    if (hasSyncedValue) break;
    end -= 1;
  }
  return {
    values: values.slice(0, end).map(function (row) { return row.slice(0, 12); }),
    date_values: dateValues.slice(0, end),
  };
}

function readSourceValues_(source, expectedHeaders) {
  const spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(source.tabName);
  if (!sheet) throw new Error('找不到固定标签页「' + source.tabName + '」。');
  if (sheet.getSheetId() !== source.sheetGid) throw new Error('标签页「' + source.tabName + '」gid 不一致。');
  let lastRow = source.headerRow;
  for (let column = 1; column <= source.columnCount; column += 1) {
    const columnLastRow = sheet.getRange(sheet.getMaxRows(), column)
      .getNextDataCell(SpreadsheetApp.Direction.UP)
      .getRow();
    lastRow = Math.max(lastRow, columnLastRow);
  }
  if (lastRow > source.maxRows) throw new Error('「' + source.tabName + '」超过安全行数上限。');
  const values = sheet.getRange(1, 1, lastRow, source.columnCount).getDisplayValues();
  while (values.length > source.headerRow && values[values.length - 1].every(function (cell) {
    return String(cell || '').trim() === '';
  })) values.pop();
  assertEmployeeMasterHeaders_(values, source, expectedHeaders);
  return { sheet: sheet, values: values };
}

function assertEmployeeMasterHeaders_(values, source, expectedHeaders) {
  const header = values[source.headerRow - 1] || [];
  expectedHeaders.forEach(function (expected, column) {
    const actual = String(header[column] || '').trim().replace(/[\s\n\r]+/g, '');
    if (actual !== expected) {
      throw new Error(
        '「' + source.tabName + '」第 ' + source.headerRow + ' 行第 ' + (column + 1) +
        ' 列表头不正确，应为「' + expected + '」。'
      );
    }
  });
}

function employeeMasterCanonicalDate_(value, displayValue, timezone) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, timezone, 'yyyy-MM-dd');
  }
  return String(displayValue || '').trim();
}

function employeeMasterDirtyState_(stored) {
  if (!stored) return { token: '', dirtyAt: 0 };
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      return {
        token: String(parsed.token || ''),
        dirtyAt: Number(parsed.dirty_at || 0),
      };
    }
  } catch (_error) {
    // Legacy/plain dirty markers remain actionable immediately.
  }
  return { token: String(stored), dirtyAt: 0 };
}

function employeeMasterBlockedState_(stored) {
  if (!stored) return { hash: '', blockedAt: 0, errorCode: '' };
  try {
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      return {
        hash: String(parsed.hash || ''),
        blockedAt: Number(parsed.blocked_at || 0),
        errorCode: String(parsed.error_code || ''),
      };
    }
  } catch (_error) {
    // Legacy versions stored only the hash. Let the next periodic reconciliation
    // retry it once, then persist the timestamped bounded-backoff form.
  }
  return { hash: String(stored), blockedAt: 0, errorCode: '' };
}

function employeeMasterResponseErrorCode_(result) {
  return String(result && (result.error_code || result.error) || '').trim();
}

function employeeMasterShouldBlockSnapshot_(responseCode, result) {
  // Credentials, rate limits and runtime/server failures are retryable and must
  // never poison a content hash permanently.
  if (responseCode === 401 || responseCode === 403 || responseCode === 429) return false;
  const code = employeeMasterResponseErrorCode_(result);
  if (responseCode === 413) return code === 'payload_too_large';
  if (responseCode === 400) {
    return /^(?:malformed_json|invalid_|source_not_allowlisted$|sheet_|snapshot_|values_|cell_|home_|schedule_|employee_id_too_long$|cross_source_name_mismatch$)/.test(code);
  }
  if (responseCode !== 422) return false;
  return [
    'stale_snapshot',
    'home_snapshot_incomplete_vs_previous',
    'schedule_snapshot_incomplete_vs_previous',
    'home_duplicate_employee_id',
    'schedule_duplicate_employee_id',
    'cross_source_name_mismatch',
    'canonical_employee_id_case_conflict',
    'employee_master_mass_absence_guard',
    'snapshot_row_count_mismatch',
  ].indexOf(code) !== -1 || /^invalid_(?:home|schedule)_roster_row$/.test(code);
}

function employeeMasterSafeError_(result) {
  const code = employeeMasterResponseErrorCode_(result);
  if (!/^(invalid_|source_|sheet_|snapshot_|values_|cell_|payload_|home_|schedule_|employee_|cross_|canonical_|stale_|database_ingest_)/.test(code)) {
    return '';
  }
  const details = result && result.details && typeof result.details === 'object' ? result.details : null;
  if (!details) return code;
  const safeDetails = {};
  ['source', 'employee_id', 'row', 'rows', 'column', 'expected'].forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(details, key)) safeDetails[key] = details[key];
  });
  return code + (Object.keys(safeDetails).length ? ' ' + JSON.stringify(safeDetails) : '');
}

function employeeMasterSha256Hex_(value) {
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
