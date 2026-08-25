/**
 * Change-detected private Google Sheets reader for attendance and adjustments.
 *
 * Required Script Properties (never hard-code either value here):
 *   ATTENDANCE_SYNC_URL
 *   ATTENDANCE_SYNC_TOKEN
 *
 * This script is read-only with respect to Google Sheets. Human edits in the
 * three annual workbooks only mark the affected month dirty. A one-minute
 * trigger combines bursts of edits before reading and pushing that month.
 */

const ATTENDANCE_SYNC_LEGACY_SOURCES = Object.freeze([
  Object.freeze({
    mode: 'legacy',
    sourceKey: 'home_2026_08',
    spreadsheetId: '10H-0oYe-D6v3xRu9vGxatizi4P11J8WYk20s3_XPus8',
    sheetGid: 2111783822,
    tabName: '休假填表',
    maxRows: 3000,
    maxColumns: 14,
  }),
  Object.freeze({
    mode: 'legacy',
    sourceKey: 'onsite_2026_08',
    spreadsheetId: '100xfv19w6zD1bdK0MVLd5kdQtOp8obzrBvI8eE2OUZo',
    sheetGid: 1309516899,
    tabName: '休假填表',
    maxRows: 1000,
    maxColumns: 14,
  }),
]);

const ATTENDANCE_SYNC_ANNUAL_WORKBOOKS = Object.freeze([
  Object.freeze({
    sourcePrefix: 'onsite_annual_2026',
    spreadsheetId: '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg',
    adjustmentSheetGid: 1011694934,
    adjustmentTabName: '填表',
    sourceGroup: 'onsite_to_home',
    currency: 'USD',
    layout: 'onsite',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 6,
    adjustmentBlockWidth: 7,
    adjustmentMetadataColumns: 3,
    adjustmentMetadataStarts: Object.freeze([28, 31, 34, 37]),
    nameColumn: 4,
    employeeNoColumn: 8,
    countryColumn: 5,
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 33,
    monthGids: Object.freeze({
      '2026-09': 605098048,
      '2026-10': 938715589,
      '2026-11': 200094426,
      '2026-12': 462628124,
    }),
  }),
  Object.freeze({
    sourcePrefix: 'home_vimm_annual_2026',
    spreadsheetId: '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ',
    adjustmentSheetGid: 3368572,
    adjustmentTabName: '填表',
    sourceGroup: 'home',
    currency: 'USD',
    layout: 'home_vimm',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 6,
    adjustmentBlockWidth: 7,
    adjustmentMetadataColumns: 3,
    adjustmentMetadataStarts: Object.freeze([28, 31, 34, 37]),
    nameColumn: 4,
    employeeNoColumn: 7,
    countryColumn: 5,
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 31,
    monthGids: Object.freeze({
      '2026-09': 515895997,
      '2026-10': 2006236394,
      '2026-11': 465666790,
      '2026-12': 527622305,
    }),
  }),
  Object.freeze({
    sourcePrefix: 'home_ph_annual_2026',
    spreadsheetId: '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ',
    adjustmentSheetGid: 687407921,
    adjustmentTabName: '填表',
    sourceGroup: 'home',
    currency: 'PHP',
    layout: 'home_ph',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 7,
    adjustmentBlockWidth: 8,
    adjustmentMetadataColumns: 6,
    adjustmentMetadataStarts: Object.freeze([32, 38, 44, 50]),
    nameColumn: 4,
    employeeNoColumn: 5,
    countryColumn: null,
    positionColumn: 3,
    platformColumn: 2,
    dayStartColumn: 39,
    monthGids: Object.freeze({
      '2026-09': 1827489324,
      '2026-10': 296363311,
      '2026-11': 138573169,
      '2026-12': 787543818,
    }),
  }),
]);

const ATTENDANCE_SYNC_ANNUAL_MONTHS = Object.freeze([
  '2026-09', '2026-10', '2026-11', '2026-12',
]);

const ATTENDANCE_SYNC_ANNUAL_SOURCES = Object.freeze(
  ATTENDANCE_SYNC_ANNUAL_WORKBOOKS.reduce(function (sources, workbook) {
    ATTENDANCE_SYNC_ANNUAL_MONTHS.forEach(function (month, monthIndex) {
      const days = attendanceDaysInMonth_(month);
      sources.push(Object.freeze(Object.assign({}, workbook, {
        mode: 'annual',
        sourceKey: workbook.sourcePrefix + '_' + month.slice(5),
        month: month,
        monthIndex: monthIndex,
        sheetGid: workbook.monthGids[month],
        tabName: Number(month.slice(5)) + '月',
        maxColumns: workbook.dayStartColumn + days + 1,
        adjustmentStartColumn: 1 + monthIndex * workbook.adjustmentBlockWidth,
        adjustmentMetadataStartColumn: workbook.adjustmentMetadataStarts[monthIndex],
      })));
    });
    return sources;
  }, [])
);

const ATTENDANCE_SYNC_ON_EDIT_HANDLER = 'attendanceSheetOnEdit';
const ATTENDANCE_SYNC_FLUSH_HANDLER = 'flushPendingAnnualAttendanceSync';
const ATTENDANCE_SYNC_RECONCILE_HANDLER = 'reconcileAttendanceSheets';
const ATTENDANCE_SYNC_MANAGED_HANDLERS = Object.freeze([
  ATTENDANCE_SYNC_ON_EDIT_HANDLER,
  ATTENDANCE_SYNC_FLUSH_HANDLER,
  ATTENDANCE_SYNC_RECONCILE_HANDLER,
  'syncAttendanceSheets',
]);
const ATTENDANCE_SYNC_HASH_PREFIX = 'ATTENDANCE_SYNC_LAST_HASH_';
const ATTENDANCE_SYNC_DIRTY_PREFIX = 'ATTENDANCE_SYNC_DIRTY_';
const ATTENDANCE_SYNC_BLOCKED_PREFIX = 'ATTENDANCE_SYNC_BLOCKED_HASH_';
const ATTENDANCE_SYNC_PENDING_PREFIX = 'ATTENDANCE_SYNC_PENDING_REQUEST_';
const ATTENDANCE_SYNC_RETRY_PREFIX = 'ATTENDANCE_SYNC_RETRY_STATE_';
const ATTENDANCE_SYNC_DEBOUNCE_MS = 45 * 1000;
const ATTENDANCE_SYNC_EXPECTED_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync';

/**
 * Legacy August edits stay immediate. Annual edits only mark the exact affected
 * logical month; this handler performs no annual sheet reads and no HTTP calls.
 */
function attendanceSheetOnEdit(event) {
  if (!event || !event.source) return;
  const spreadsheetId = String(event.source.getId() || '');
  const legacy = ATTENDANCE_SYNC_LEGACY_SOURCES.find(function (candidate) {
    return candidate.spreadsheetId === spreadsheetId;
  });
  if (legacy) {
    syncAttendanceSourcesInternal_([legacy], false, 'change', false);
    return;
  }

  const workbook = ATTENDANCE_SYNC_ANNUAL_WORKBOOKS.find(function (candidate) {
    return candidate.spreadsheetId === spreadsheetId;
  });
  if (!workbook || !event.range) return;
  const sheet = event.range.getSheet();
  const tabName = sheet.getName();
  const firstColumn = event.range.getColumn();
  const lastColumn = firstColumn + event.range.getNumColumns() - 1;
  const affected = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (source) {
    if (source.spreadsheetId !== spreadsheetId) return false;
    if (source.tabName === tabName) {
      return annualEditTouchesRelevantColumns_(source, firstColumn, lastColumn);
    }
    if (tabName !== source.adjustmentTabName) return false;
    const blockStart = source.adjustmentStartColumn;
    const blockEnd = blockStart + source.adjustmentColumns - 1;
    const metadataStart = source.adjustmentMetadataStartColumn;
    const metadataEnd = metadataStart + source.adjustmentMetadataColumns - 1;
    return (firstColumn <= blockEnd && lastColumn >= blockStart) ||
      (firstColumn <= metadataEnd && lastColumn >= metadataStart);
  });
  const now = String(Date.now());
  const properties = PropertiesService.getScriptProperties();
  affected.forEach(function (source) {
    properties.setProperty(ATTENDANCE_SYNC_DIRTY_PREFIX + source.sourceKey, now);
  });
}

/** Runs every minute and sends only dirty months whose edit burst has settled. */
function flushPendingAnnualAttendanceSync() {
  const properties = PropertiesService.getScriptProperties();
  const now = Date.now();
  const due = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (source) {
    const markedAt = Number(properties.getProperty(ATTENDANCE_SYNC_DIRTY_PREFIX + source.sourceKey) || '0');
    return markedAt > 0 && now - markedAt >= ATTENDANCE_SYNC_DEBOUNCE_MS;
  });
  if (!due.length) return;
  syncAttendanceSourcesInternal_(due, false, 'change', true);
}

/** Daily low-frequency read validation; unchanged hashes make zero HTTP calls. */
function reconcileAttendanceSheets() {
  syncAttendanceSourcesInternal_(
    ATTENDANCE_SYNC_LEGACY_SOURCES.concat(ATTENDANCE_SYNC_ANNUAL_SOURCES),
    false,
    'daily_reconcile',
    false
  );
}

/** Deliberate operator retry. It bypasses blocked-hash and unchanged-hash skips. */
function runAttendanceReconciliation() {
  syncAttendanceSourcesInternal_(
    ATTENDANCE_SYNC_LEGACY_SOURCES.concat(ATTENDANCE_SYNC_ANNUAL_SOURCES),
    true,
    'manual',
    false
  );
}

/**
 * One-time authorization entrypoint. It creates five source-bound onEdit
 * triggers, a one-minute dirty-month flusher, and one daily full validation.
 */
function installAttendanceSync() {
  const config = attendanceSyncConfig_();
  if (!config.url || !config.token) {
    throw new Error('Set ATTENDANCE_SYNC_URL and ATTENDANCE_SYNC_TOKEN in Script Properties first.');
  }
  ATTENDANCE_SYNC_LEGACY_SOURCES.forEach(readAttendanceSnapshot_);
  ATTENDANCE_SYNC_ANNUAL_SOURCES.forEach(readAttendanceSnapshot_);
  removeAttendanceSyncTriggers();

  const spreadsheetIds = {};
  ATTENDANCE_SYNC_LEGACY_SOURCES.concat(ATTENDANCE_SYNC_ANNUAL_SOURCES).forEach(function (source) {
    spreadsheetIds[source.spreadsheetId] = true;
  });
  Object.keys(spreadsheetIds).forEach(function (spreadsheetId) {
    ScriptApp.newTrigger(ATTENDANCE_SYNC_ON_EDIT_HANDLER)
      .forSpreadsheet(spreadsheetId)
      .onEdit()
      .create();
  });
  ScriptApp.newTrigger(ATTENDANCE_SYNC_FLUSH_HANDLER)
    .timeBased()
    .everyMinutes(1)
    .create();
  ScriptApp.newTrigger(ATTENDANCE_SYNC_RECONCILE_HANDLER)
    .timeBased()
    .atHour(3)
    .everyDays(1)
    .create();
  runAttendanceReconciliation();
}

function removeAttendanceSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ATTENDANCE_SYNC_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncAttendanceSourcesInternal_(sources, force, triggerKind, dirtyOnly) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const config = attendanceSyncConfig_();
    if (!config.url || !config.token) throw new Error('Attendance sync Script Properties are missing.');
    const failures = [];
    sources.forEach(function (source) {
      try {
        syncOneAttendanceSource_(source, config, force, triggerKind, dirtyOnly);
      } catch (error) {
        const message = error && error.message ? error.message : 'unknown failure';
        failures.push(source.sourceKey + ': ' + message);
        console.error(JSON.stringify({ source_key: source.sourceKey, error: message }));
      }
    });
    if (failures.length) throw new Error('Attendance sync failures: ' + failures.join('; '));
  } finally {
    lock.releaseLock();
  }
}

function syncOneAttendanceSource_(source, config, force, triggerKind, dirtyOnly) {
  const properties = PropertiesService.getScriptProperties();
  const dirtyKey = ATTENDANCE_SYNC_DIRTY_PREFIX + source.sourceKey;
  if (dirtyOnly && !properties.getProperty(dirtyKey)) return;
  const snapshot = readAttendanceSnapshot_(source);
  const hashKey = ATTENDANCE_SYNC_HASH_PREFIX + source.sourceKey;
  const blockedKey = ATTENDANCE_SYNC_BLOCKED_PREFIX + source.sourceKey;
  const pendingKey = ATTENDANCE_SYNC_PENDING_PREFIX + source.sourceKey;
  const retryKey = ATTENDANCE_SYNC_RETRY_PREFIX + source.sourceKey;
  const previousHash = properties.getProperty(hashKey);
  const blockedHash = properties.getProperty(blockedKey);

  if (!force && snapshot.hash === previousHash) {
    properties.deleteProperty(dirtyKey);
    return;
  }
  if (!force && snapshot.hash === blockedHash) {
    properties.deleteProperty(dirtyKey);
    return;
  }

  const retryState = parseJsonProperty_(properties.getProperty(retryKey));
  if (!force && retryState && retryState.hash === snapshot.hash && Number(retryState.retry_at || 0) > Date.now()) {
    return;
  }

  const pending = parseJsonProperty_(properties.getProperty(pendingKey));
  const requestId = pending && pending.hash === snapshot.hash && pending.request_id
    ? pending.request_id
    : Utilities.getUuid();
  properties.setProperty(pendingKey, JSON.stringify({ hash: snapshot.hash, request_id: requestId }));

  const sourcePayload = {
    source_key: source.sourceKey,
    spreadsheet_id: source.spreadsheetId,
    sheet_gid: String(source.sheetGid),
    tab_name: source.tabName,
  };
  if (source.mode === 'annual') {
    sourcePayload.adjustment_sheet_gid = String(source.adjustmentSheetGid);
    sourcePayload.adjustment_tab_name = source.adjustmentTabName;
  }
  const payload = {
    request_id: requestId,
    trigger_kind: triggerKind,
    source: sourcePayload,
    snapshot_hash: snapshot.hash,
    captured_at: new Date().toISOString(),
    values: snapshot.values,
  };

  let response;
  try {
    response = UrlFetchApp.fetch(config.url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Attendance-Sync-Token': config.token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
      followRedirects: false,
    });
  } catch (error) {
    scheduleAttendanceRetry_(properties, retryKey, snapshot.hash, retryState);
    throw new Error('network_error, request ' + requestId);
  }

  const responseCode = response.getResponseCode();
  let result = null;
  try {
    result = JSON.parse(response.getContentText());
  } catch (_error) {
    // Never log response bodies that could accidentally contain private data.
  }

  if (responseCode >= 200 && responseCode < 300 && result && result.ok === true) {
    properties.setProperty(hashKey, snapshot.hash);
    properties.deleteProperty(blockedKey);
    properties.deleteProperty(pendingKey);
    properties.deleteProperty(retryKey);
    properties.deleteProperty(dirtyKey);
    console.log(JSON.stringify({
      source_key: source.sourceKey,
      request_id: requestId,
      status: result.status,
      inserted: result.inserted || 0,
      updated: result.updated || 0,
      deleted: result.deleted || 0,
    }));
    return;
  }

  if ((responseCode >= 400 && responseCode < 500) || (responseCode >= 300 && responseCode < 400)) {
    // A client/configuration error cannot be repaired by retries. The same hash
    // stays blocked until sheet content changes or an operator forces a retry.
    properties.setProperty(blockedKey, snapshot.hash);
    properties.deleteProperty(pendingKey);
    properties.deleteProperty(retryKey);
    properties.deleteProperty(dirtyKey);
    const safeError = result && result.error ? String(result.error).slice(0, 120) : 'request_rejected';
    throw new Error('HTTP ' + responseCode + ' ' + safeError + ', request ' + requestId + ' (not retried)');
  }

  if (result && result.retry_with_new_request_id === true) {
    properties.deleteProperty(pendingKey);
  }
  scheduleAttendanceRetry_(properties, retryKey, snapshot.hash, retryState);
  throw new Error('HTTP ' + responseCode + ', request ' + requestId + ' (retry scheduled)');
}

function scheduleAttendanceRetry_(properties, retryKey, hash, previousState) {
  const previousAttempt = previousState && previousState.hash === hash
    ? Number(previousState.attempt || 0)
    : 0;
  const attempt = Math.min(previousAttempt + 1, 8);
  const delaySeconds = Math.min(60 * Math.pow(2, attempt - 1), 3600);
  properties.setProperty(retryKey, JSON.stringify({
    hash: hash,
    attempt: attempt,
    retry_at: Date.now() + delaySeconds * 1000,
  }));
}

function parseJsonProperty_(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function attendanceSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    url: String(properties.getProperty('ATTENDANCE_SYNC_URL') || '').trim(),
    token: String(properties.getProperty('ATTENDANCE_SYNC_TOKEN') || '').trim(),
  };
  if (config.url && config.url !== ATTENDANCE_SYNC_EXPECTED_URL) {
    throw new Error('ATTENDANCE_SYNC_URL must exactly match the production attendance sync endpoint.');
  }
  return config;
}

function readAttendanceSnapshot_(source) {
  return source.mode === 'annual'
    ? readAnnualAttendanceSnapshot_(source)
    : readLegacyAttendanceSnapshot_(source);
}

function readLegacyAttendanceSnapshot_(source) {
  const spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(source.tabName);
  if (!sheet) throw new Error('Missing exact tab ' + source.tabName + ' in ' + source.sourceKey + '.');
  if (sheet.getSheetId() !== source.sheetGid) throw new Error('Sheet gid mismatch for ' + source.sourceKey + '.');
  const lastRow = Math.max(sheet.getLastRow(), 2);
  if (lastRow > source.maxRows) throw new Error('Row limit exceeded for ' + source.sourceKey + '.');
  const values = sheet.getRange(1, 1, lastRow, source.maxColumns).getDisplayValues();
  trimEmptyTail_(values, 2);
  assertLegacyAttendanceHeaders_(values, source.sourceKey);
  return { values: values, hash: sha256Hex_(JSON.stringify(values)) };
}

function readAnnualAttendanceSnapshot_(source) {
  const spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
  const attendanceSheet = spreadsheet.getSheetByName(source.tabName);
  if (!attendanceSheet) throw new Error('Missing exact tab ' + source.tabName + ' in ' + source.sourceKey + '.');
  if (attendanceSheet.getSheetId() !== source.sheetGid) throw new Error('Sheet gid mismatch for ' + source.sourceKey + '.');
  const attendanceLastRow = Math.max(attendanceSheet.getLastRow(), 1);
  if (attendanceLastRow > source.maxRows) throw new Error('Row limit exceeded for ' + source.sourceKey + '.');
  const attendance = attendanceSheet
    .getRange(1, 1, attendanceLastRow, source.maxColumns)
    .getDisplayValues();
  projectAnnualAttendanceValues_(attendance, source);
  trimEmptyTail_(attendance, 1);

  const adjustmentSheet = spreadsheet.getSheetByName(source.adjustmentTabName);
  if (!adjustmentSheet) throw new Error('Missing exact tab ' + source.adjustmentTabName + ' in ' + source.sourceKey + '.');
  if (adjustmentSheet.getSheetId() !== source.adjustmentSheetGid) {
    throw new Error('Adjustment sheet gid mismatch for ' + source.sourceKey + '.');
  }
  const adjustmentLastRow = Math.max(adjustmentSheet.getLastRow(), 2);
  if (adjustmentLastRow > source.adjustmentMaxRows) {
    throw new Error('Adjustment row limit exceeded for ' + source.sourceKey + '.');
  }
  const adjustments = adjustmentSheet
    .getRange(1, source.adjustmentStartColumn, adjustmentLastRow, source.adjustmentColumns)
    .getDisplayValues();
  const adjustmentMetadata = adjustmentSheet
    .getRange(
      1,
      source.adjustmentMetadataStartColumn,
      adjustmentLastRow,
      source.adjustmentMetadataColumns
    )
    .getDisplayValues();
  trimAnnualAdjustmentTail_(adjustments, adjustmentMetadata, 2);
  assertAnnualAttendanceHeaders_(attendance, adjustments, adjustmentMetadata, source);
  const values = {
    attendance: attendance,
    adjustments: adjustments,
    adjustment_metadata: adjustmentMetadata,
  };
  return { values: values, hash: sha256Hex_(JSON.stringify(values)) };
}

function projectAnnualAttendanceValues_(values, source) {
  const relevant = {};
  [source.nameColumn, source.employeeNoColumn, source.positionColumn, source.platformColumn]
    .forEach(function (column) { relevant[column] = true; });
  if (source.countryColumn !== null) relevant[source.countryColumn] = true;
  for (let day = 0; day < attendanceDaysInMonth_(source.month); day += 1) {
    relevant[source.dayStartColumn + day] = true;
  }
  values.forEach(function (row) {
    for (let column = 0; column < row.length; column += 1) {
      if (!relevant[column]) row[column] = '';
    }
  });
}

function annualEditTouchesRelevantColumns_(source, firstColumn, lastColumn) {
  const relevant = [
    source.nameColumn + 1,
    source.employeeNoColumn + 1,
    source.positionColumn + 1,
    source.platformColumn + 1,
  ];
  if (source.countryColumn !== null) relevant.push(source.countryColumn + 1);
  const dayStart = source.dayStartColumn + 1;
  const dayEnd = dayStart + attendanceDaysInMonth_(source.month) - 1;
  if (firstColumn <= dayEnd && lastColumn >= dayStart) return true;
  return relevant.some(function (column) { return column >= firstColumn && column <= lastColumn; });
}

function trimEmptyTail_(values, minimumRows) {
  while (values.length > minimumRows && values[values.length - 1].every(function (cell) {
    return String(cell || '').trim() === '';
  })) values.pop();
}

function trimAnnualAdjustmentTail_(adjustments, metadata, minimumRows) {
  while (adjustments.length > minimumRows && metadata.length > minimumRows) {
    const adjustmentEmpty = adjustments[adjustments.length - 1].every(function (cell) {
      return String(cell || '').trim() === '';
    });
    const metadataEmpty = metadata[metadata.length - 1].every(function (cell) {
      return String(cell || '').trim() === '';
    });
    if (!adjustmentEmpty || !metadataEmpty) return;
    adjustments.pop();
    metadata.pop();
  }
}

function assertLegacyAttendanceHeaders_(values, sourceKey) {
  if (!values || values.length < 2) throw new Error('Headers missing for ' + sourceKey + '.');
  const header = values[1] || [];
  const expected = [
    [0, /姓名|name/i], [1, /原因|reason/i], [2, /日期|date/i], [3, /备注|note/i],
    [5, /姓名|name/i], [6, /原因|reason/i], [7, /日期|date/i], [8, /备注|note/i],
    [10, /姓名|name/i], [11, /金额|金額|amount/i], [12, /日期|date/i], [13, /备注|note/i],
  ];
  expected.forEach(function (entry) {
    if (!entry[1].test(String(header[entry[0]] || '').trim())) {
      throw new Error('Header mismatch at column ' + (entry[0] + 1) + ' for ' + sourceKey + '.');
    }
  });
}

function assertAnnualAttendanceHeaders_(attendance, adjustments, metadata, source) {
  if (!attendance || !attendance.length) throw new Error('Headers missing for ' + source.sourceKey + '.');
  const header = attendance[0] || [];
  if (!/姓名|name/i.test(String(header[source.nameColumn] || '').trim())) {
    throw new Error('Name header mismatch for ' + source.sourceKey + '.');
  }
  if (!/^id$/i.test(String(header[source.employeeNoColumn] || '').trim())) {
    throw new Error('ID header mismatch for ' + source.sourceKey + '.');
  }
  for (let day = 1; day <= attendanceDaysInMonth_(source.month); day += 1) {
    if (String(header[source.dayStartColumn + day - 1] || '').trim() !== String(day)) {
      throw new Error('Day header mismatch for ' + source.sourceKey + ', day ' + day + '.');
    }
  }
  if (!adjustments || adjustments.length < 2) throw new Error('Adjustment headers missing for ' + source.sourceKey + '.');
  const monthNumber = String(Number(source.month.slice(5)));
  if (String(adjustments[0][0] || '').trim().indexOf(monthNumber + '月') !== 0) {
    throw new Error('Adjustment month header mismatch for ' + source.sourceKey + '.');
  }
  const adjustmentHeader = adjustments[1] || [];
  if (!/姓名|name/i.test(String(adjustmentHeader[0] || '').trim()) ||
      !/^id$/i.test(String(adjustmentHeader[1] || '').trim())) {
    throw new Error('Adjustment identity header mismatch for ' + source.sourceKey + '.');
  }
  const expectedMetadataHeaders = source.layout === 'home_ph'
    ? [
      '__sync_first_half_external_id', '__sync_first_half_origin', '__sync_first_half_revision',
      '__sync_second_half_external_id', '__sync_second_half_origin', '__sync_second_half_revision',
    ]
    : ['__sync_external_id', '__sync_origin', '__sync_revision'];
  const metadataHeader = metadata && metadata[1] || [];
  expectedMetadataHeaders.forEach(function (expected, column) {
    if (String(metadataHeader[column] || '').trim() !== expected) {
      throw new Error(
        'Adjustment metadata header mismatch at column ' + (column + 1) +
        ' for ' + source.sourceKey + '.'
      );
    }
  });
}

function attendanceDaysInMonth_(month) {
  const parts = String(month).split('-');
  return new Date(Number(parts[0]), Number(parts[1]), 0).getDate();
}

function sha256Hex_(value) {
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
