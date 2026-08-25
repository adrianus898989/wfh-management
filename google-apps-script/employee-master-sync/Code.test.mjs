import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const scriptProperties = {};
const context = vm.createContext({
  console,
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty(key) {
          return Object.prototype.hasOwnProperty.call(scriptProperties, key)
            ? scriptProperties[key]
            : null;
        },
      };
    },
  },
});

// Parsing the complete Apps Script in V8 catches syntax errors without calling
// Google or Supabase.
vm.runInContext(source, context, { filename: 'Code.gs' });
const evaluateJson = (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));

const setScriptProperties = (values) => {
  Object.keys(scriptProperties).forEach((key) => delete scriptProperties[key]);
  Object.assign(scriptProperties, values);
};

test('explicit employee-master config has priority over schedule and attendance', () => {
  setScriptProperties({
    EMPLOYEE_MASTER_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    EMPLOYEE_MASTER_SYNC_TOKEN: 'employee-master-token-placeholder',
    SCHEDULE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync',
    SCHEDULE_SYNC_TOKEN: 'schedule-token-placeholder',
    ATTENDANCE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync',
    ATTENDANCE_SYNC_TOKEN: 'attendance-token-placeholder',
  });
  assert.deepEqual(evaluateJson('employeeMasterSyncConfig_()'), {
    url: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    token: 'employee-master-token-placeholder',
  });
});

test('reuses the existing schedule token while pinning the employee-master URL', () => {
  setScriptProperties({
    SCHEDULE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync',
    SCHEDULE_SYNC_TOKEN: 'schedule-token-placeholder',
    ATTENDANCE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync',
    ATTENDANCE_SYNC_TOKEN: 'attendance-token-placeholder',
  });
  assert.deepEqual(evaluateJson('employeeMasterSyncConfig_()'), {
    url: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    token: 'schedule-token-placeholder',
  });
});

test('falls back to the allowlisted attendance project URL and token', () => {
  setScriptProperties({
    ATTENDANCE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync',
    ATTENDANCE_SYNC_TOKEN: 'attendance-token-placeholder',
  });
  assert.deepEqual(evaluateJson('employeeMasterSyncConfig_()'), {
    url: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    token: 'attendance-token-placeholder',
  });
});

test('blank higher-priority config safely falls through to attendance', () => {
  setScriptProperties({
    EMPLOYEE_MASTER_SYNC_URL: '  ',
    EMPLOYEE_MASTER_SYNC_TOKEN: '  ',
    SCHEDULE_SYNC_URL: '  ',
    SCHEDULE_SYNC_TOKEN: '  ',
    ATTENDANCE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/attendance-sheet-sync',
    ATTENDANCE_SYNC_TOKEN: 'attendance-token-placeholder',
  });
  assert.deepEqual(evaluateJson('employeeMasterSyncConfig_()'), {
    url: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    token: 'attendance-token-placeholder',
  });
});

test('blank optional employee-master properties still fall back to schedule config', () => {
  setScriptProperties({
    EMPLOYEE_MASTER_SYNC_URL: '   ',
    EMPLOYEE_MASTER_SYNC_TOKEN: '   ',
    SCHEDULE_SYNC_URL: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/schedule-sheet-sync',
    SCHEDULE_SYNC_TOKEN: 'schedule-token-placeholder',
  });
  assert.deepEqual(evaluateJson('employeeMasterSyncConfig_()'), {
    url: 'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
    token: 'schedule-token-placeholder',
  });
});

test('rejects non-exact employee-master, schedule, and attendance destinations', () => {
  setScriptProperties({
    SCHEDULE_SYNC_URL: 'https://example.invalid/functions/v1/schedule-sheet-sync',
    SCHEDULE_SYNC_TOKEN: 'schedule-token-placeholder',
  });
  assert.throws(
    () => vm.runInContext('employeeMasterSyncConfig_()', context),
    /SCHEDULE_SYNC_URL/,
  );

  setScriptProperties({
    EMPLOYEE_MASTER_SYNC_URL: 'https://example.invalid/functions/v1/employee-master-sync',
    SCHEDULE_SYNC_TOKEN: 'schedule-token-placeholder',
  });
  assert.throws(
    () => vm.runInContext('employeeMasterSyncConfig_()', context),
    /EMPLOYEE_MASTER_SYNC_URL/,
  );

  setScriptProperties({
    ATTENDANCE_SYNC_URL: 'https://example.invalid/functions/v1/attendance-sheet-sync',
    ATTENDANCE_SYNC_TOKEN: 'attendance-token-placeholder',
  });
  assert.throws(
    () => vm.runInContext('employeeMasterSyncConfig_()', context),
    /ATTENDANCE_SYNC_URL/,
  );
});

test('home semantic projection ignores M:P and M:P-only trailing rows', () => {
  const base = evaluateJson(`(function () {
    var values = [
      Array(16).fill(''),
      EMPLOYEE_MASTER_HOME_HEADERS.slice(),
      ['TEAM', 'PLATFORM', 'POSITION', 'DAY', 'PH', 'Alice', 'WD1', '2026-08-01', '', '', '', '', '1000', '', '', ''],
      ['', '', '', '', '', '', '', '', '', '', '', '', 'pay-only', '', '', '']
    ];
    var dates = [['', ''], ['', ''], ['2026-08-01', ''], ['', '']];
    return employeeMasterHomeSemanticProjection_(values, dates);
  })()`);
  const changed = evaluateJson(`(function () {
    var values = [
      Array(16).fill(''),
      EMPLOYEE_MASTER_HOME_HEADERS.slice(),
      ['TEAM', 'PLATFORM', 'POSITION', 'DAY', 'PH', 'Alice', 'WD1', '2026-08-01', '', '', '', '', '9999', 'raise', 'changed', 'changed'],
      ['', '', '', '', '', '', '', '', '', '', '', '', 'different-pay-only', '', '', '']
    ];
    var dates = [['', ''], ['', ''], ['2026-08-01', ''], ['', '']];
    return employeeMasterHomeSemanticProjection_(values, dates);
  })()`);

  assert.deepEqual(changed, base);
  assert.equal(base.values.length, 3);
  assert.ok(base.values.every((row) => row.length === 12));
});

test('only deterministic data responses block a semantic hash', () => {
  const decisions = evaluateJson(`[
    employeeMasterShouldBlockSnapshot_(400, { error: 'cross_source_name_mismatch' }),
    employeeMasterShouldBlockSnapshot_(413, { error: 'payload_too_large' }),
    employeeMasterShouldBlockSnapshot_(422, { error_code: 'home_snapshot_incomplete_vs_previous' }),
    employeeMasterShouldBlockSnapshot_(401, { error: 'unauthorized' }),
    employeeMasterShouldBlockSnapshot_(403, { error: 'forbidden' }),
    employeeMasterShouldBlockSnapshot_(429, { error: 'rate_limited' }),
    employeeMasterShouldBlockSnapshot_(500, { error: 'sync_request_failed' }),
    employeeMasterShouldBlockSnapshot_(422, { error: 'database_ingest_rejected' })
  ]`);
  assert.deepEqual(decisions, [true, true, true, false, false, false, false, false]);
});

test('blocked hash state supports timestamped cooldown and legacy values', () => {
  assert.deepEqual(evaluateJson(`employeeMasterBlockedState_(JSON.stringify({
    hash: 'abc', blocked_at: 1234, error_code: 'cross_source_name_mismatch'
  }))`), {
    hash: 'abc', blockedAt: 1234, errorCode: 'cross_source_name_mismatch',
  });
  assert.deepEqual(evaluateJson(`employeeMasterBlockedState_('legacy-hash')`), {
    hash: 'legacy-hash', blockedAt: 0, errorCode: '',
  });
});

test('home onEdit ownership stops at column L while raw validation remains A:P', () => {
  const columns = evaluateJson(`({
    raw: EMPLOYEE_MASTER_HOME_SOURCE.columnCount,
    synced: EMPLOYEE_MASTER_HOME_SOURCE.syncColumnCount
  })`);
  assert.deepEqual(columns, { raw: 16, synced: 12 });
});
