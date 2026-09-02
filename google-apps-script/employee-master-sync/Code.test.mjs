import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const scriptProperties = {};
let uuidSequence = 0;
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
        setProperty(key, value) {
          scriptProperties[key] = String(value);
        },
        deleteProperty(key) {
          delete scriptProperties[key];
        },
      };
    },
  },
  Utilities: {
    getUuid() {
      uuidSequence += 1;
      return `test-uuid-${uuidSequence}`;
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

const existingTrigger = ({
  handler = 'employeeMasterOnChange',
  eventType = 'ON_CHANGE',
  triggerSource = 'SPREADSHEETS',
  sourceId = '',
} = {}) => ({
  getHandlerFunction: () => handler,
  getEventType: () => eventType,
  getTriggerSource: () => triggerSource,
  getTriggerSourceId: () => sourceId,
});

const createScriptAppHarness = (seedTriggers = []) => {
  const projectTriggers = [...seedTriggers];
  const created = [];
  const deleted = [];
  const scriptApp = {
    EventType: {
      ON_CHANGE: 'ON_CHANGE',
      ON_EDIT: 'ON_EDIT',
    },
    TriggerSource: {
      CLOCK: 'CLOCK',
      SPREADSHEETS: 'SPREADSHEETS',
    },
    getProjectTriggers() {
      return [...projectTriggers];
    },
    deleteTrigger(trigger) {
      deleted.push(trigger);
      const index = projectTriggers.indexOf(trigger);
      if (index !== -1) projectTriggers.splice(index, 1);
    },
    newTrigger(handler) {
      const record = { handler };
      const builder = {
        forSpreadsheet(spreadsheetId) {
          record.spreadsheetId = spreadsheetId;
          record.triggerSource = 'SPREADSHEETS';
          return builder;
        },
        onEdit() {
          record.event = 'onEdit';
          record.eventType = 'ON_EDIT';
          return builder;
        },
        onChange() {
          record.event = 'onChange';
          record.eventType = 'ON_CHANGE';
          return builder;
        },
        timeBased() {
          record.event = 'timeBased';
          record.triggerSource = 'CLOCK';
          return builder;
        },
        everyMinutes(minutes) {
          record.minutes = minutes;
          return builder;
        },
        create() {
          created.push({ ...record });
          const trigger = existingTrigger({
            handler: record.handler,
            eventType: record.eventType,
            triggerSource: record.triggerSource,
            sourceId: record.spreadsheetId,
          });
          projectTriggers.push(trigger);
          return trigger;
        },
      };
      return builder;
    },
  };
  return { scriptApp, created, deleted, projectTriggers };
};

const setValidEmployeeMasterConfig = () => setScriptProperties({
  EMPLOYEE_MASTER_SYNC_URL:
    'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/employee-master-sync',
  EMPLOYEE_MASTER_SYNC_TOKEN: 'employee-master-token-placeholder',
});

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

test('dirty state supports timestamped tokens and legacy markers', () => {
  assert.deepEqual(evaluateJson(`employeeMasterDirtyState_(JSON.stringify({
    token: 'edit-token', dirty_at: 1234
  }))`), {
    token: 'edit-token', dirtyAt: 1234,
  });
  assert.deepEqual(evaluateJson(`employeeMasterDirtyState_('legacy-dirty')`), {
    token: 'legacy-dirty', dirtyAt: 0,
  });
});

test('onChange marks only source-bound row insertions and removals dirty', () => {
  setScriptProperties({});
  vm.runInContext(`employeeMasterOnChange({
    source: { getId: function () { return 'untrusted-spreadsheet'; } },
    changeType: 'INSERT_ROW'
  })`, context);
  assert.equal(scriptProperties.EMPLOYEE_MASTER_DIRTY_dual_source_v1, undefined);

  vm.runInContext(`employeeMasterOnChange({
    source: { getId: function () { return EMPLOYEE_MASTER_HOME_SOURCE.spreadsheetId; } },
    changeType: 'INSERT_ROW'
  })`, context);
  const afterHomeInsert = JSON.parse(scriptProperties.EMPLOYEE_MASTER_DIRTY_dual_source_v1);
  assert.match(afterHomeInsert.token, /^test-uuid-/);
  assert.ok(Number.isFinite(afterHomeInsert.dirty_at));

  for (const changeType of ['EDIT', 'FORMAT', 'INSERT_COLUMN', 'REMOVE_COLUMN', 'OTHER']) {
    vm.runInContext(`employeeMasterOnChange({
      source: { getId: function () { return EMPLOYEE_MASTER_HOME_SOURCE.spreadsheetId; } },
      changeType: ${JSON.stringify(changeType)}
    })`, context);
    assert.equal(
      scriptProperties.EMPLOYEE_MASTER_DIRTY_dual_source_v1,
      JSON.stringify(afterHomeInsert),
    );
  }

  vm.runInContext(`employeeMasterOnChange({
    source: { getId: function () { return EMPLOYEE_MASTER_SCHEDULE_SOURCE.spreadsheetId; } },
    changeType: 'REMOVE_ROW'
  })`, context);
  const afterScheduleRemove = JSON.parse(scriptProperties.EMPLOYEE_MASTER_DIRTY_dual_source_v1);
  assert.notEqual(afterScheduleRemove.token, afterHomeInsert.token);
  assert.ok(afterScheduleRemove.dirty_at >= afterHomeInsert.dirty_at);
});

test('installer creates the missing minute flusher and exposes a non-destructive repair helper', () => {
  assert.match(source, /const EMPLOYEE_MASTER_FLUSH_HANDLER = 'flushPendingEmployeeMasterSync'/);
  assert.match(source, /function flushPendingEmployeeMasterSync\(\)/);
  assert.match(
    source,
    /newTrigger\(EMPLOYEE_MASTER_FLUSH_HANDLER\)[\s\S]*?\.everyMinutes\(1\)[\s\S]*?\.create\(\)/,
  );
  const repairBody = source.match(
    /function installMissingEmployeeMasterFlushTrigger\(\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';
  assert.match(repairBody, /getProjectTriggers\(\)/);
  assert.match(repairBody, /existing\.length === 1/);
  assert.doesNotMatch(repairBody, /removeEmployeeMasterSyncTriggers/);
  assert.doesNotMatch(repairBody, /deleteTrigger/);
});

test('change-trigger repair creates only the two missing source-bound triggers', () => {
  const harness = createScriptAppHarness();
  context.ScriptApp = harness.scriptApp;
  setValidEmployeeMasterConfig();

  vm.runInContext('installMissingEmployeeMasterChangeTriggers()', context);
  assert.deepEqual(harness.created, [
    {
      handler: 'employeeMasterOnChange',
      spreadsheetId: '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
      triggerSource: 'SPREADSHEETS',
      event: 'onChange',
      eventType: 'ON_CHANGE',
    },
    {
      handler: 'employeeMasterOnChange',
      spreadsheetId: '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
      triggerSource: 'SPREADSHEETS',
      event: 'onChange',
      eventType: 'ON_CHANGE',
    },
  ]);
  assert.equal(harness.deleted.length, 0);

  vm.runInContext('installMissingEmployeeMasterChangeTriggers()', context);
  assert.equal(harness.created.length, 2, 'a second repair must not duplicate correct triggers');
  assert.equal(harness.deleted.length, 0);
});

test('change-trigger repair preserves a correct trigger and creates only its missing peer', () => {
  const homeSourceId = '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8';
  const harness = createScriptAppHarness([
    existingTrigger({ sourceId: homeSourceId }),
    existingTrigger({ handler: 'unrelatedHandler', sourceId: 'unrelated-spreadsheet' }),
  ]);
  context.ScriptApp = harness.scriptApp;
  setValidEmployeeMasterConfig();

  vm.runInContext('installMissingEmployeeMasterChangeTriggers()', context);
  assert.deepEqual(harness.created, [{
    handler: 'employeeMasterOnChange',
    spreadsheetId: '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
    triggerSource: 'SPREADSHEETS',
    event: 'onChange',
    eventType: 'ON_CHANGE',
  }]);
  assert.equal(harness.deleted.length, 0);
});

test('change-trigger repair fails closed on duplicates or wrong bindings', () => {
  const homeSourceId = '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8';
  const invalidSets = [
    {
      triggers: [
        existingTrigger({ sourceId: homeSourceId }),
        existingTrigger({ sourceId: homeSourceId }),
      ],
      error: /重复/,
    },
    {
      triggers: [existingTrigger({ sourceId: 'wrong-spreadsheet' })],
      error: /绑定错误来源/,
    },
    {
      triggers: [existingTrigger({ sourceId: homeSourceId, eventType: 'ON_EDIT' })],
      error: /事件类型或来源错误/,
    },
    {
      triggers: [existingTrigger({ sourceId: homeSourceId, triggerSource: 'CLOCK' })],
      error: /事件类型或来源错误/,
    },
  ];

  invalidSets.forEach(({ triggers, error }) => {
    const harness = createScriptAppHarness(triggers);
    context.ScriptApp = harness.scriptApp;
    setValidEmployeeMasterConfig();
    assert.throws(
      () => vm.runInContext('installMissingEmployeeMasterChangeTriggers()', context),
      error,
    );
    assert.equal(harness.created.length, 0);
    assert.equal(harness.deleted.length, 0);
  });
});

test('a registered deterministic block does not cause minute-by-minute full-table reads', () => {
  assert.match(
    source,
    /if \(!allowPeriodicReconciliation \|\| blockStillCoolingDown\) return true;/,
  );
  assert.match(
    source,
    /if \(complete && properties\.getProperty\(EMPLOYEE_MASTER_DIRTY_PROPERTY\) === stored\)/,
  );
});

test('home onEdit ownership stops at column L while raw validation remains A:P', () => {
  const columns = evaluateJson(`({
    raw: EMPLOYEE_MASTER_HOME_SOURCE.columnCount,
    synced: EMPLOYEE_MASTER_HOME_SOURCE.syncColumnCount
  })`);
  assert.deepEqual(columns, { raw: 16, synced: 12 });
});

test('installer creates exactly two source-bound onChange triggers', () => {
  const harness = createScriptAppHarness();
  context.ScriptApp = harness.scriptApp;
  setValidEmployeeMasterConfig();
  vm.runInContext(`
    readEmployeeMasterSnapshot_ = function () { return {}; };
    syncEmployeeMasterInternal_ = function () { return true; };
    installEmployeeMasterSync();
  `, context);

  const onChangeTriggers = harness.created.filter((trigger) => trigger.event === 'onChange');
  assert.deepEqual(onChangeTriggers, [
    {
      handler: 'employeeMasterOnChange',
      spreadsheetId: '1Diz8hArjv_rx-3cUvGl-etcFsiCYfQqrNfCcTgTJrz8',
      triggerSource: 'SPREADSHEETS',
      event: 'onChange',
      eventType: 'ON_CHANGE',
    },
    {
      handler: 'employeeMasterOnChange',
      spreadsheetId: '1e38ZBHG0B0nxODaooPhgreG67A2RLxLxrpP8Sas_vZA',
      triggerSource: 'SPREADSHEETS',
      event: 'onChange',
      eventType: 'ON_CHANGE',
    },
  ]);
  assert.equal(harness.created.filter((trigger) => trigger.event === 'onEdit').length, 2);
  assert.equal(harness.created.filter((trigger) => trigger.event === 'timeBased').length, 2);
  assert.ok(evaluateJson('EMPLOYEE_MASTER_MANAGED_HANDLERS').includes('employeeMasterOnChange'));
});
