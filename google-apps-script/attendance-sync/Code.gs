/**
 * Change-detected private Google Sheets reader for August 2026 attendance.
 *
 * Required Script Properties (never hard-code either value here):
 *   ATTENDANCE_SYNC_URL
 *   ATTENDANCE_SYNC_TOKEN
 */

const ATTENDANCE_SYNC_SOURCES = Object.freeze([
  Object.freeze({
    sourceKey: 'home_2026_08',
    spreadsheetId: '10H-0oYe-D6v3xRu9vGxatizi4P11J8WYk20s3_XPus8',
    sheetGid: 2111783822,
    tabName: '休假填表',
    maxRows: 3000,
  }),
  Object.freeze({
    sourceKey: 'onsite_2026_08',
    spreadsheetId: '100xfv19w6zD1bdK0MVLd5kdQtOp8obzrBvI8eE2OUZo',
    sheetGid: 1309516899,
    tabName: '休假填表',
    maxRows: 1000,
  }),
]);

const ATTENDANCE_SYNC_ON_EDIT_HANDLER = 'attendanceSheetOnEdit';
const ATTENDANCE_SYNC_RECONCILE_HANDLER = 'reconcileAttendanceSheets';
const ATTENDANCE_SYNC_MANAGED_HANDLERS = Object.freeze([
  ATTENDANCE_SYNC_ON_EDIT_HANDLER,
  ATTENDANCE_SYNC_RECONCILE_HANDLER,
  // Removed v1 handler: clean it up when upgrading an existing installation.
  'syncAttendanceSheets',
]);
const ATTENDANCE_SYNC_HASH_PREFIX = 'ATTENDANCE_SYNC_LAST_HASH_';
const ATTENDANCE_SYNC_RECONCILE_PREFIX = 'ATTENDANCE_SYNC_LAST_RECONCILE_';
const ATTENDANCE_SYNC_EXPECTED_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync';

/**
 * Two installable spreadsheet onEdit triggers share this handler. An edit can
 * therefore read only the one allowlisted spreadsheet that emitted the event.
 */
function attendanceSheetOnEdit(event) {
  if (!event || !event.source) return;
  const spreadsheetId = String(event.source.getId() || '');
  const source = ATTENDANCE_SYNC_SOURCES.find(function (candidate) {
    return candidate.spreadsheetId === spreadsheetId;
  });
  if (!source) return;
  syncAttendanceSourcesInternal_([source], false, 'change');
}

/**
 * Five-minute fallback for formula/API changes, which do not emit onEdit.
 */
function reconcileAttendanceSheets() {
  syncAttendanceSourcesInternal_(ATTENDANCE_SYNC_SOURCES, false, 'change');
}

function runAttendanceReconciliation() {
  syncAttendanceSourcesInternal_(ATTENDANCE_SYNC_SOURCES, true, 'manual');
}

/**
 * The one-time Google authorization entrypoint. It validates access, installs
 * two source-bound onEdit triggers plus one 5-minute fallback trigger, and
 * performs the initial complete sync.
 */
function installAttendanceSync() {
  const config = attendanceSyncConfig_();
  if (!config.url || !config.token) {
    throw new Error('Set ATTENDANCE_SYNC_URL and ATTENDANCE_SYNC_TOKEN in Script Properties first.');
  }
  ATTENDANCE_SYNC_SOURCES.forEach(function (source) {
    readAttendanceSnapshot_(source);
  });
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ATTENDANCE_SYNC_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ATTENDANCE_SYNC_SOURCES.forEach(function (source) {
    ScriptApp.newTrigger(ATTENDANCE_SYNC_ON_EDIT_HANDLER)
      .forSpreadsheet(source.spreadsheetId)
      .onEdit()
      .create();
  });
  ScriptApp.newTrigger(ATTENDANCE_SYNC_RECONCILE_HANDLER)
    .timeBased()
    .everyMinutes(5)
    .create();
  syncAttendanceSourcesInternal_(ATTENDANCE_SYNC_SOURCES, true, 'manual');
}

function removeAttendanceSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ATTENDANCE_SYNC_MANAGED_HANDLERS.indexOf(trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function syncAttendanceSourcesInternal_(sources, force, forcedTriggerKind) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const config = attendanceSyncConfig_();
    if (!config.url || !config.token) throw new Error('Attendance sync Script Properties are missing.');
    const properties = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const failures = [];

    sources.forEach(function (source) {
      try {
        const snapshot = readAttendanceSnapshot_(source);
        const hashKey = ATTENDANCE_SYNC_HASH_PREFIX + source.sourceKey;
        const reconcileKey = ATTENDANCE_SYNC_RECONCILE_PREFIX + source.sourceKey;
        const previousHash = properties.getProperty(hashKey);
        const lastReconcile = properties.getProperty(reconcileKey);
        const changed = snapshot.hash !== previousHash;
        const dailyDue = lastReconcile !== today;
        if (!force && !changed && !dailyDue) return;

        const triggerKind = force
          ? forcedTriggerKind
          : changed
            ? 'change'
            : 'daily_reconcile';
        const requestId = Utilities.getUuid();
        const payload = {
          request_id: requestId,
          trigger_kind: triggerKind,
          source: {
            source_key: source.sourceKey,
            spreadsheet_id: source.spreadsheetId,
            sheet_gid: String(source.sheetGid),
            tab_name: source.tabName,
          },
          snapshot_hash: snapshot.hash,
          captured_at: new Date().toISOString(),
          values: snapshot.values,
        };
        const response = UrlFetchApp.fetch(config.url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'X-Attendance-Sync-Token': config.token },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
          followRedirects: false,
        });
        const responseCode = response.getResponseCode();
        let result = null;
        try {
          result = JSON.parse(response.getContentText());
        } catch (_error) {
          // Avoid logging sheet content or the shared token.
        }
        if (responseCode < 200 || responseCode >= 300 || !result || result.ok !== true) {
          throw new Error(
            'HTTP ' + responseCode + ', request ' + requestId
          );
        }

        // Advance the change detector only after the database accepted the full
        // snapshot. A failed call is therefore retried on the next trigger.
        properties.setProperty(hashKey, snapshot.hash);
        properties.setProperty(reconcileKey, today);
        console.log(JSON.stringify({
          source_key: source.sourceKey,
          request_id: requestId,
          status: result.status,
          inserted: result.inserted || 0,
          updated: result.updated || 0,
          deleted: result.deleted || 0,
        }));
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
  const spreadsheet = SpreadsheetApp.openById(source.spreadsheetId);
  const sheet = spreadsheet.getSheetByName(source.tabName);
  if (!sheet) throw new Error('Missing exact tab ' + source.tabName + ' in ' + source.sourceKey + '.');
  if (sheet.getSheetId() !== source.sheetGid) {
    throw new Error('Sheet gid mismatch for ' + source.sourceKey + '.');
  }
  const lastRow = Math.max(sheet.getLastRow(), 2);
  if (lastRow > source.maxRows) throw new Error('Row limit exceeded for ' + source.sourceKey + '.');
  const values = sheet.getRange(1, 1, lastRow, 14).getDisplayValues();

  // Payroll columns outside A:N can increase getLastRow(). Removing empty A:N
  // tails keeps their edits from causing attendance sync calls.
  while (values.length > 2 && values[values.length - 1].every(function (cell) {
    return String(cell || '').trim() === '';
  })) values.pop();

  assertAttendanceHeaders_(values, source.sourceKey);
  return { values: values, hash: sha256Hex_(JSON.stringify(values)) };
}

function assertAttendanceHeaders_(values, sourceKey) {
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
