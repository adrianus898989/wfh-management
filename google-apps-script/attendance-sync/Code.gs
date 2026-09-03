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
    // The live Home August sheet now follows the full 3,600+ employee roster.
    // Keep a bounded guard, but leave enough headroom for normal roster growth.
    maxRows: 5000,
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
    leaveSheetGid: 868595464,
    leaveTabName: '休假填表',
    leaveMaxRows: 1600,
    leaveColumns: 5,
    leaveBlockWidth: 6,
    adjustmentSheetGid: 1011694934,
    adjustmentTabName: '奖惩填表',
    sourceGroup: 'onsite_to_home',
    currency: 'USD',
    layout: 'onsite',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 7,
    adjustmentBlockWidth: 8,
    adjustmentMetadataColumns: 3,
    adjustmentMetadataStarts: Object.freeze([32, 35, 38, 41]),
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
    leaveSheetGid: 1582220550,
    leaveTabName: '休假填表',
    leaveMaxRows: 1600,
    leaveColumns: 5,
    leaveBlockWidth: 6,
    adjustmentSheetGid: 3368572,
    adjustmentTabName: '奖惩填表',
    sourceGroup: 'home',
    currency: 'USD',
    layout: 'home_vimm',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 7,
    adjustmentBlockWidth: 8,
    adjustmentMetadataColumns: 3,
    adjustmentMetadataStarts: Object.freeze([32, 35, 38, 41]),
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
    leaveSheetGid: 1880767097,
    leaveTabName: '休假填表',
    leaveMaxRows: 1600,
    leaveColumns: 5,
    leaveBlockWidth: 6,
    adjustmentSheetGid: 687407921,
    adjustmentTabName: '奖惩填表',
    sourceGroup: 'home',
    currency: 'PHP',
    layout: 'home_ph',
    maxRows: 1600,
    adjustmentMaxRows: 1100,
    adjustmentColumns: 9,
    adjustmentBlockWidth: 10,
    adjustmentMetadataColumns: 6,
    adjustmentMetadataStarts: Object.freeze([41, 47, 53, 59]),
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
const ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS = Object.freeze([
  '__sync_external_id', '__sync_origin', '__sync_revision',
]);
const ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS = Object.freeze([
  '姓名', 'ID', '金额1-15', '类型', '金额16-末', '类型', '备注1-15', '备注16-末', '日期',
]);
const ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS = Object.freeze([
  '__sync_first_half_external_id', '__sync_first_half_origin', '__sync_first_half_revision',
  '__sync_second_half_external_id', '__sync_second_half_origin', '__sync_second_half_revision',
]);
const ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_SCHEMAS = Object.freeze([
  Object.freeze({
    key: 'with_category',
    hasCategory: true,
    headers: Object.freeze(['姓名', 'ID', '奖金', '扣除', '类型', '备注', '日期']),
  }),
  Object.freeze({
    key: 'legacy_without_category',
    hasCategory: false,
    headers: Object.freeze(['姓名', 'ID', '奖金', '扣除', '备注', '日期']),
  }),
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
        leaveStartColumn: 1 + monthIndex * workbook.leaveBlockWidth,
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

// One reviewed transition only. The source, old snapshot, new snapshot and
// expected row/delete counts were reconciled against production before this
// code was written. Any later Google Sheet edit changes the snapshot hash and
// makes this authorization fail closed.
const ATTENDANCE_SYNC_REVIEWED_HOME_PH_SEP_DELETE = Object.freeze({
  sourceKey: 'home_ph_annual_2026_09',
  previousSnapshotHash: '527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071',
  snapshotHash: '9390bd569f7eeaeb0f563d1598a05159db3f334d0af53c0944a6ff7a59bee651',
  expectedDeleteCount: 9,
  expectedReadRowCount: 721,
  expectedCanonicalRecordCount: 295,
  expectedParseWarningCount: 7,
});

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
  const sheetGid = sheet.getSheetId();
  const firstColumn = event.range.getColumn();
  const lastColumn = firstColumn + event.range.getNumColumns() - 1;
  const workbookSources = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (source) {
    return source.spreadsheetId === spreadsheetId;
  });
  const resolvedAdjustmentSources = tabName === workbook.adjustmentTabName &&
      sheetGid === workbook.adjustmentSheetGid
    ? attendanceResolveAnnualAdjustmentSources_(sheet, workbook)
    : null;
  const affected = workbookSources.filter(function (source) {
    if (source.spreadsheetId !== spreadsheetId) return false;
    if (source.tabName === tabName && source.sheetGid === sheetGid) {
      return annualEditTouchesRelevantColumns_(source, firstColumn, lastColumn);
    }
    if (source.leaveTabName === tabName && source.leaveSheetGid === sheetGid) {
      const leaveEnd = source.leaveStartColumn + source.leaveColumns - 1;
      return firstColumn <= leaveEnd && lastColumn >= source.leaveStartColumn;
    }
    if (tabName !== source.adjustmentTabName || source.adjustmentSheetGid !== sheetGid) return false;
    const resolved = resolvedAdjustmentSources.filter(function (candidate) {
      return candidate.sourceKey === source.sourceKey;
    })[0];
    if (!resolved) return false;
    const blockStart = resolved.adjustmentStartColumn;
    const blockEnd = blockStart + resolved.adjustmentColumns - 1;
    const metadataStart = resolved.adjustmentMetadataStartColumn;
    const metadataEnd = metadataStart + resolved.adjustmentMetadataColumns - 1;
    return (firstColumn <= blockEnd && lastColumn >= blockStart) ||
      (firstColumn <= metadataEnd && lastColumn >= metadataStart);
  });
  const now = String(Date.now());
  const properties = PropertiesService.getScriptProperties();
  affected.forEach(function (source) {
    properties.setProperty(ATTENDANCE_SYNC_DIRTY_PREFIX + source.sourceKey, now);
  });
}

function attendanceAdjustmentHeaderKey_(value) {
  return String(value || '').replace(/[\s\u3000_\-—–/]+/g, '').toLowerCase();
}

function attendanceAdjustmentHeaderMatchesAt_(header, start, expected) {
  if (start < 1 || start + expected.length - 1 > header.length) return false;
  return expected.every(function (value, index) {
    return attendanceAdjustmentHeaderKey_(header[start - 1 + index]) ===
      attendanceAdjustmentHeaderKey_(value);
  });
}

function attendanceAdjustmentExactHeadersAt_(header, start, expected) {
  if (start < 1 || start + expected.length - 1 > header.length) return false;
  return expected.every(function (value, index) {
    return String(header[start - 1 + index] || '').trim() === value;
  });
}

function attendanceAdjustmentMonthTitleMatches_(value, month) {
  const monthNumber = String(Number(String(month).slice(5)));
  return new RegExp('^0?' + monthNumber + '月份?$').test(
    String(value || '').replace(/[\s\u3000]+/g, '')
  );
}

/**
 * The Philippines form is not a standard seven-column form. Resolve its four
 * nine-column business blocks from row-1 month titles plus exact row-2 headers,
 * and require the installed six-column metadata block for every month.
 */
function attendanceResolvePhilippinesAdjustmentSources_(sheet, workbook, sources) {
  const headerRow = 2;
  const lastColumn = Math.max(Number(sheet.getLastColumn()), 1);
  const rows = sheet.getRange(headerRow - 1, 1, 2, lastColumn).getDisplayValues();
  const titles = rows[0] || [];
  const header = rows[1] || [];
  const byMonth = {};
  let column = 1;
  while (column <= header.length) {
    if (!attendanceAdjustmentExactHeadersAt_(header, column, ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS)) {
      column += 1;
      continue;
    }
    const month = ATTENDANCE_SYNC_ANNUAL_MONTHS.filter(function (candidate) {
      return attendanceAdjustmentMonthTitleMatches_(titles[column - 1], candidate);
    })[0];
    if (!month || byMonth[month]) {
      throw new Error('Philippines adjustment month title is missing, duplicated, or mismatched.');
    }
    byMonth[month] = column;
    column += ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.length;
  }
  const missing = ATTENDANCE_SYNC_ANNUAL_MONTHS.filter(function (month) { return !byMonth[month]; });
  if (missing.length) {
    throw new Error(
      'Philippines adjustment sheet must contain exact nine-column Sep-Dec blocks; missing ' +
      missing.join(', ') + '. No business data was read.'
    );
  }
  const businessStarts = ATTENDANCE_SYNC_ANNUAL_MONTHS.map(function (month) { return byMonth[month]; });
  if (businessStarts.some(function (start, index) {
    return index > 0 && start <= businessStarts[index - 1];
  })) {
    throw new Error('Philippines adjustment Sep-Dec blocks are out of order. No business data was read.');
  }
  const businessEnd = ATTENDANCE_SYNC_ANNUAL_MONTHS.reduce(function (maximum, month) {
    return Math.max(maximum, byMonth[month] + ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.length - 1);
  }, 0);
  const metadataMatches = [];
  for (let metadataColumn = businessEnd + 1;
    metadataColumn <= header.length - ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.length + 1;
    metadataColumn += 1) {
    if (attendanceAdjustmentExactHeadersAt_(
      header, metadataColumn, ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS
    )) {
      metadataMatches.push(metadataColumn);
      metadataColumn += ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.length - 1;
    }
  }
  if (metadataMatches.length !== ATTENDANCE_SYNC_ANNUAL_MONTHS.length ||
      metadataMatches.some(function (start, index) {
        return start !== metadataMatches[0] + index * ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.length;
      })) {
    throw new Error('Philippines adjustment metadata headers are missing, incomplete, or non-contiguous.');
  }
  return sources.map(function (source) {
    const monthIndex = ATTENDANCE_SYNC_ANNUAL_MONTHS.indexOf(source.month);
    return Object.assign({}, source, {
      adjustmentStartColumn: byMonth[source.month],
      adjustmentColumns: ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.length,
      adjustmentHasCategory: true,
      adjustmentSchemaKey: 'philippines',
      adjustmentMetadataStartColumn: metadataMatches[monthIndex],
      adjustmentMetadataColumns: ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.length,
    });
  });
}

/** Resolve actual standard 9–12 blocks before any business rows are read. */
function attendanceResolveAnnualAdjustmentSources_(sheet, workbook) {
  const sources = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (source) {
    return source.sourcePrefix === workbook.sourcePrefix;
  });
  if (workbook.layout === 'home_ph') {
    return attendanceResolvePhilippinesAdjustmentSources_(sheet, workbook, sources);
  }
  const headerRow = 2;
  const lastColumn = Math.max(Number(sheet.getLastColumn()), 1);
  const header = sheet.getRange(headerRow, 1, 1, lastColumn).getDisplayValues()[0];
  const matches = [];
  let column = 1;
  while (column <= header.length) {
    let schema = null;
    for (let index = 0; index < ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_SCHEMAS.length; index += 1) {
      const candidate = ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_SCHEMAS[index];
      if (attendanceAdjustmentHeaderMatchesAt_(header, column, candidate.headers)) {
        schema = candidate;
        break;
      }
    }
    if (!schema) {
      column += 1;
      continue;
    }
    matches.push({ start: column, schema: schema });
    column += schema.headers.length;
  }
  if (matches.length !== ATTENDANCE_SYNC_ANNUAL_MONTHS.length) {
    throw new Error(
      'standard 奖惩表必须识别 9–12 月共 4 个业务块；实际识别 ' + matches.length +
      ' 个。支持：姓名、ID、奖金、扣除、[类型]、备注、日期。未读取业务数据。'
    );
  }
  const businessEnd = matches.reduce(function (maximum, match) {
    return Math.max(maximum, match.start + match.schema.headers.length - 1);
  }, 0);
  const metadataMatches = [];
  for (let metadataColumn = businessEnd + 1;
    metadataColumn <= header.length - ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS.length + 1;
    metadataColumn += 1) {
    if (attendanceAdjustmentHeaderMatchesAt_(
      header, metadataColumn, ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS
    )) {
      metadataMatches.push(metadataColumn);
      metadataColumn += ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS.length - 1;
    }
  }
  if (metadataMatches.length && (
    metadataMatches.length !== ATTENDANCE_SYNC_ANNUAL_MONTHS.length ||
    metadataMatches.some(function (start, index) { return start !== metadataMatches[0] + index * 3; })
  )) {
    throw new Error('standard 奖惩同步协议列不完整或不连续，停止读取。');
  }
  const metadataBase = metadataMatches.length ? metadataMatches[0] : businessEnd + 1;
  return sources.map(function (source, index) {
    const match = matches[index];
    return Object.assign({}, source, {
      adjustmentStartColumn: match.start,
      adjustmentColumns: match.schema.headers.length,
      adjustmentHasCategory: match.schema.hasCategory,
      adjustmentSchemaKey: match.schema.key,
      adjustmentMetadataStartColumn: metadataBase + index * 3,
    });
  });
}

function attendanceResolvedAnnualSource_(sheet, source) {
  const workbook = ATTENDANCE_SYNC_ANNUAL_WORKBOOKS.filter(function (candidate) {
    return candidate.sourcePrefix === source.sourcePrefix;
  })[0];
  if (!workbook) throw new Error('Annual workbook is not allowlisted for ' + source.sourceKey + '.');
  const resolved = attendanceResolveAnnualAdjustmentSources_(sheet, workbook).filter(function (candidate) {
    return candidate.sourceKey === source.sourceKey;
  })[0];
  if (!resolved) throw new Error('Annual adjustment month is not allowlisted for ' + source.sourceKey + '.');
  return resolved;
}

function attendanceCanonicalAdjustmentValues_(values, source) {
  if (source.adjustmentHasCategory !== false) return values;
  return values.map(function (row) {
    return row.slice(0, 4).concat([''], row.slice(4, 6));
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
 * Executes only the reviewed Home-PH September transition. This is deliberately
 * separate from runAttendanceReconciliation(), which must never grant a delete
 * override to all attendance sources.
 */
function runReviewedHomePhSeptember2026Reconciliation() {
  const source = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (candidate) {
    return candidate.sourceKey === ATTENDANCE_SYNC_REVIEWED_HOME_PH_SEP_DELETE.sourceKey;
  });
  if (source.length !== 1) throw new Error('Reviewed attendance source is not uniquely configured.');
  syncAttendanceSourcesInternal_(source, true, 'manual', false, true);
}

/**
 * Re-reads only Home-PH September without any delete authorization. This
 * records fresh server-side diagnostics when the reviewed snapshot changed,
 * while the database guard continues to block every removal.
 */
function validateHomePhSeptember2026AttendanceSnapshot() {
  const source = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (candidate) {
    return candidate.sourceKey === 'home_ph_annual_2026_09';
  });
  if (source.length !== 1) throw new Error('Attendance validation source is not uniquely configured.');
  syncAttendanceSourcesInternal_(source, true, 'daily_reconcile', false, false);
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

function syncAttendanceSourcesInternal_(sources, force, triggerKind, dirtyOnly, reviewedLargeDelete) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const config = attendanceSyncConfig_();
    if (!config.url || !config.token) throw new Error('Attendance sync Script Properties are missing.');
    const failures = [];
    sources.forEach(function (source) {
      try {
        syncOneAttendanceSource_(source, config, force, triggerKind, dirtyOnly, reviewedLargeDelete);
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

function syncOneAttendanceSource_(source, config, force, triggerKind, dirtyOnly, reviewedLargeDelete) {
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
    sourcePayload.leave_sheet_gid = String(source.leaveSheetGid);
    sourcePayload.leave_tab_name = source.leaveTabName;
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
  if (reviewedLargeDelete === true) {
    const reviewed = ATTENDANCE_SYNC_REVIEWED_HOME_PH_SEP_DELETE;
    if (triggerKind !== 'manual' || source.sourceKey !== reviewed.sourceKey) {
      throw new Error('Reviewed attendance delete override source mismatch.');
    }
    if (snapshot.hash !== reviewed.snapshotHash) {
      throw new Error('Reviewed attendance snapshot changed; re-audit before deleting old records.');
    }
    payload.allow_large_delete = true;
    payload.expected_delete_count = reviewed.expectedDeleteCount;
    payload.expected_previous_snapshot_hash = reviewed.previousSnapshotHash;
    payload.expected_snapshot_hash = reviewed.snapshotHash;
    payload.expected_read_row_count = reviewed.expectedReadRowCount;
    payload.expected_canonical_record_count = reviewed.expectedCanonicalRecordCount;
    payload.expected_parse_warning_count = reviewed.expectedParseWarningCount;
  }

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

  const leaveSheet = spreadsheet.getSheetByName(source.leaveTabName);
  if (!leaveSheet) throw new Error('Missing exact tab ' + source.leaveTabName + ' in ' + source.sourceKey + '.');
  if (leaveSheet.getSheetId() !== source.leaveSheetGid) {
    throw new Error('Leave sheet gid mismatch for ' + source.sourceKey + '.');
  }
  const leaveLastRow = Math.max(leaveSheet.getLastRow(), 2);
  if (leaveLastRow > source.leaveMaxRows) {
    throw new Error('Leave row limit exceeded for ' + source.sourceKey + '.');
  }
  const leaves = leaveSheet
    .getRange(1, source.leaveStartColumn, leaveLastRow, source.leaveColumns)
    .getDisplayValues();
  trimEmptyTail_(leaves, 2);

  const adjustmentSheet = spreadsheet.getSheetByName(source.adjustmentTabName);
  if (!adjustmentSheet) throw new Error('Missing exact tab ' + source.adjustmentTabName + ' in ' + source.sourceKey + '.');
  if (adjustmentSheet.getSheetId() !== source.adjustmentSheetGid) {
    throw new Error('Adjustment sheet gid mismatch for ' + source.sourceKey + '.');
  }
  const resolvedSource = attendanceResolvedAnnualSource_(adjustmentSheet, source);
  const adjustmentLastRow = Math.max(adjustmentSheet.getLastRow(), 2);
  if (adjustmentLastRow > source.adjustmentMaxRows) {
    throw new Error('Adjustment row limit exceeded for ' + source.sourceKey + '.');
  }
  const adjustments = adjustmentSheet
    .getRange(
      1, resolvedSource.adjustmentStartColumn, adjustmentLastRow, resolvedSource.adjustmentColumns
    )
    .getDisplayValues();
  const adjustmentMetadata = adjustmentSheet
    .getRange(
      1,
      resolvedSource.adjustmentMetadataStartColumn,
      adjustmentLastRow,
      resolvedSource.adjustmentMetadataColumns
    )
    .getDisplayValues();
  trimAnnualAdjustmentTail_(adjustments, adjustmentMetadata, 2);
  assertAnnualAttendanceHeaders_(attendance, leaves, adjustments, adjustmentMetadata, resolvedSource);
  const canonicalAdjustments = attendanceCanonicalAdjustmentValues_(adjustments, resolvedSource);
  const values = {
    attendance: attendance,
    leaves: leaves,
    adjustments: canonicalAdjustments,
    adjustment_metadata: adjustmentMetadata,
    adjustment_schema: resolvedSource.adjustmentSchemaKey,
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

function assertAnnualAttendanceHeaders_(attendance, leaves, adjustments, metadata, source) {
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
  if (!leaves || leaves.length < 2) throw new Error('Leave headers missing for ' + source.sourceKey + '.');
  const monthNumber = String(Number(source.month.slice(5)));
  if (!new RegExp('^' + monthNumber + '月份?$').test(String(leaves[0][0] || '').trim())) {
    throw new Error('Leave month header mismatch for ' + source.sourceKey + '.');
  }
  const leaveHeader = leaves[1] || [];
  const expectedLeaveHeaders = ['日期', '姓名', 'ID', '类型', '备注'];
  expectedLeaveHeaders.forEach(function (expected, column) {
    if (String(leaveHeader[column] || '').replace(/[\s\u3000_-]+/g, '').toLowerCase() !==
        expected.replace(/[\s\u3000_-]+/g, '').toLowerCase()) {
      throw new Error(
        'Leave header mismatch at column ' + (column + 1) + ' for ' + source.sourceKey +
        ': expected ' + expected + ', actual ' + String(leaveHeader[column] || '').trim() + '.'
      );
    }
  });
  if (!adjustments || adjustments.length < 2) throw new Error('Adjustment headers missing for ' + source.sourceKey + '.');
  if (String(adjustments[0][0] || '').trim().indexOf(monthNumber + '月') !== 0) {
    throw new Error('Adjustment month header mismatch for ' + source.sourceKey + '.');
  }
  const adjustmentHeader = adjustments[1] || [];
  if (!/姓名|name/i.test(String(adjustmentHeader[0] || '').trim()) ||
      !/^id$/i.test(String(adjustmentHeader[1] || '').trim())) {
    throw new Error('Adjustment identity header mismatch for ' + source.sourceKey + '.');
  }
  const isPhilippines = source.adjustmentSchemaKey === 'philippines' || source.layout === 'home_ph';
  const expectedAdjustmentHeaders = isPhilippines
    ? ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS
    : source.adjustmentHasCategory === false
      ? ['姓名', 'ID', '奖金', '扣除', '备注', '日期']
      : ['姓名', 'ID', '奖金', '扣除', '类型', '备注', '日期'];
  expectedAdjustmentHeaders.forEach(function (expected, column) {
    const rawActual = String(adjustmentHeader[column] || '').trim();
    const matches = isPhilippines
      ? rawActual === expected
      : rawActual.replace(/[\s\u3000_-]+/g, '').toLowerCase() ===
        expected.replace(/[\s\u3000_-]+/g, '').toLowerCase();
    if (!matches) {
      throw new Error(
        'Adjustment header mismatch at column ' + (column + 1) + ' for ' + source.sourceKey +
        ': expected ' + expected + ', actual ' + String(adjustmentHeader[column] || '').trim() + '.'
      );
    }
  });
  const expectedMetadataHeaders = isPhilippines
    ? ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS
    : ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS;
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
