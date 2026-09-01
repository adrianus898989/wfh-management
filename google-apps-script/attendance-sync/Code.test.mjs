import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const context = vm.createContext({ console });
vm.runInContext(source, context, { filename: 'Code.gs' });
const json = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));

test('annual sources use the exact live Sep-Dec leave and adjustment blocks', () => {
  const workbooks = json(`ATTENDANCE_SYNC_ANNUAL_WORKBOOKS.map(function (item) {
    return {
      prefix: item.sourcePrefix,
      leave: [item.leaveTabName, item.leaveSheetGid, item.leaveColumns, item.leaveBlockWidth],
      adjustment: [item.adjustmentTabName, item.adjustmentColumns, item.adjustmentBlockWidth,
        item.adjustmentMetadataStarts]
    };
  })`);
  assert.deepEqual(workbooks.map(item => item.leave), [
    ['休假填表', 868595464, 5, 6],
    ['休假填表', 1582220550, 5, 6],
    ['休假填表', 1880767097, 5, 6],
  ]);
  assert.deepEqual(workbooks[0].adjustment, ['奖惩填表', 7, 8, [32, 35, 38, 41]]);
  assert.deepEqual(workbooks[1].adjustment, ['奖惩填表', 7, 8, [32, 35, 38, 41]]);
  assert.deepEqual(workbooks[2].adjustment, ['奖惩填表', 9, 10, [41, 47, 53, 59]]);

  const blocks = json(`ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (item) {
    return item.sourcePrefix === 'onsite_annual_2026';
  }).map(function (item) {
    return [item.month, item.leaveStartColumn, item.adjustmentStartColumn,
      item.adjustmentMetadataStartColumn];
  })`);
  assert.deepEqual(blocks, [
    ['2026-09', 1, 1, 32], ['2026-10', 7, 9, 35],
    ['2026-11', 13, 17, 38], ['2026-12', 19, 25, 41],
  ]);

  const philippines = json(`ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (item) {
    return item.sourcePrefix === 'home_ph_annual_2026';
  }).map(function (item) {
    return [item.month, item.adjustmentStartColumn, item.adjustmentColumns,
      item.adjustmentMetadataStartColumn, item.adjustmentMetadataColumns];
  })`);
  assert.deepEqual(philippines, [
    ['2026-09', 1, 9, 41, 6], ['2026-10', 11, 9, 47, 6],
    ['2026-11', 21, 9, 53, 6], ['2026-12', 31, 9, 59, 6],
  ]);
});

test('header guard accepts both current 7-column and resolved legacy 6-column layouts', () => {
  const result = json(`(function () {
    var source = ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (item) {
      return item.sourceKey === 'onsite_annual_2026_09';
    })[0];
    var attendance = [Array(source.maxColumns).fill('')];
    attendance[0][source.nameColumn] = '姓名';
    attendance[0][source.employeeNoColumn] = 'ID';
    for (var day = 1; day <= attendanceDaysInMonth_(source.month); day += 1) {
      attendance[0][source.dayStartColumn + day - 1] = String(day);
    }
    var leaves = [['9月份','','','',''], ['日期','姓名','ID','类型','备注']];
    var adjustments = [['9月份','','','','','',''], ['姓名','ID','奖金','扣除','类型','备注','日期']];
    var metadata = [['','',''], ['__sync_external_id','__sync_origin','__sync_revision']];
    assertAnnualAttendanceHeaders_(attendance, leaves, adjustments, metadata, source);
    var legacy = Object.assign({}, source, { adjustmentHasCategory: false });
    var legacyAdjustments = [['9月份','','','','',''], ['姓名','ID','奖金','扣除','备注','日期']];
    assertAnnualAttendanceHeaders_(attendance, leaves, legacyAdjustments, metadata, legacy);
    var canonical = attendanceCanonicalAdjustmentValues_(legacyAdjustments, legacy);
    return { current: true, legacy: true, canonicalHeader: canonical[1] };
  })()`);
  assert.deepEqual(result, {
    current: true,
    legacy: true,
    canonicalHeader: ['姓名', 'ID', '奖金', '扣除', '', '备注', '日期'],
  });
});

test('standard adjustment blocks and metadata are resolved from the actual header row', () => {
  const result = json(`(function () {
    function makeSheet(headers) {
      return {
        getLastColumn: function () { return headers.length; },
        getRange: function () { return { getDisplayValues: function () { return [headers]; } }; }
      };
    }
    function headersFor(schema, starts, metadataBase) {
      var width = metadataBase + 11;
      var row = Array(width).fill('');
      starts.forEach(function (start) {
        schema.forEach(function (value, index) { row[start - 1 + index] = value; });
      });
      for (var index = 0; index < 4; index += 1) {
        ATTENDANCE_SYNC_STANDARD_ADJUSTMENT_METADATA_HEADERS.forEach(function (value, offset) {
          row[metadataBase - 1 + index * 3 + offset] = value;
        });
      }
      return row;
    }
    var workbook = ATTENDANCE_SYNC_ANNUAL_WORKBOOKS[0];
    var current = attendanceResolveAnnualAdjustmentSources_(makeSheet(headersFor(
      ['姓名','ID','奖金','扣除','类型','备注','日期'], [1,9,17,25], 32
    )), workbook).map(function (source) {
      return [source.adjustmentStartColumn, source.adjustmentColumns,
        source.adjustmentMetadataStartColumn, source.adjustmentSchemaKey];
    });
    var legacy = attendanceResolveAnnualAdjustmentSources_(makeSheet(headersFor(
      ['姓名','ID','奖金','扣除','备注','日期'], [1,8,15,22], 28
    )), workbook).map(function (source) {
      return [source.adjustmentStartColumn, source.adjustmentColumns,
        source.adjustmentMetadataStartColumn, source.adjustmentSchemaKey];
    });
    return { current: current, legacy: legacy };
  })()`);
  assert.deepEqual(result.current, [
    [1, 7, 32, 'with_category'], [9, 7, 35, 'with_category'],
    [17, 7, 38, 'with_category'], [25, 7, 41, 'with_category'],
  ]);
  assert.deepEqual(result.legacy, [
    [1, 6, 28, 'legacy_without_category'], [8, 6, 31, 'legacy_without_category'],
    [15, 6, 34, 'legacy_without_category'], [22, 6, 37, 'legacy_without_category'],
  ]);
});

test('resolves the real Philippines nine-column blocks and six-column metadata from headers', () => {
  const result = json(`(function () {
    var titles = Array(64).fill('');
    var headers = Array(64).fill('');
    [1,11,21,31].forEach(function (start, index) {
      titles[start - 1] = String(index + 9) + '月份';
      ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    [41,47,53,59].forEach(function (start) {
      ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    var sheet = {
      getLastColumn: function () { return headers.length; },
      getRange: function (row, start, height, width) {
        var grid = [titles, headers];
        return { getDisplayValues: function () {
          return Array.from({ length: height }, function (_, index) {
            return grid[row - 1 + index].slice(start - 1, start - 1 + width);
          });
        } };
      }
    };
    var workbook = ATTENDANCE_SYNC_ANNUAL_WORKBOOKS[2];
    return attendanceResolveAnnualAdjustmentSources_(sheet, workbook).map(function (item) {
      return [item.adjustmentStartColumn, item.adjustmentColumns,
        item.adjustmentMetadataStartColumn, item.adjustmentMetadataColumns,
        item.adjustmentSchemaKey];
    });
  })()`);
  assert.deepEqual(result, [
    [1, 9, 41, 6, 'philippines'], [11, 9, 47, 6, 'philippines'],
    [21, 9, 53, 6, 'philippines'], [31, 9, 59, 6, 'philippines'],
  ]);
});

test('Philippines annual payload preserves all nine columns and declares its schema', () => {
  const result = json(`(function () {
    var source = Object.assign({}, ATTENDANCE_SYNC_ANNUAL_SOURCES.filter(function (item) {
      return item.sourceKey === 'home_ph_annual_2026_09';
    })[0], {
      adjustmentHasCategory: true,
      adjustmentSchemaKey: 'philippines',
      adjustmentColumns: 9,
      adjustmentMetadataColumns: 6
    });
    var attendance = [Array(source.maxColumns).fill('')];
    attendance[0][source.nameColumn] = '姓名';
    attendance[0][source.employeeNoColumn] = 'ID';
    for (var day = 1; day <= attendanceDaysInMonth_(source.month); day += 1) {
      attendance[0][source.dayStartColumn + day - 1] = String(day);
    }
    var leaves = [['9月份','','','',''], ['日期','姓名','ID','类型','备注']];
    var adjustments = [
      ['9月份','','','','','','','',''],
      ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.slice()
    ];
    var metadata = [
      ['','','','','',''],
      ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.slice()
    ];
    assertAnnualAttendanceHeaders_(attendance, leaves, adjustments, metadata, source);
    return {
      schema: source.adjustmentSchemaKey,
      canonical: attendanceCanonicalAdjustmentValues_(adjustments, source)
    };
  })()`);
  assert.equal(result.schema, 'philippines');
  assert.deepEqual(result.canonical[1], [
    '姓名', 'ID', '金额1-15', '类型', '金额16-末', '类型', '备注1-15', '备注16-末', '日期',
  ]);
  assert.match(source, /adjustment_schema:\s*resolvedSource\.adjustmentSchemaKey/);
});

test('Philippines resolver fails closed on a wrong title or incomplete metadata headers', () => {
  assert.throws(() => vm.runInContext(`(function () {
    function makeSheet(badTitle, partialMetadata) {
      var titles = Array(64).fill('');
      var headers = Array(64).fill('');
      [1,11,21,31].forEach(function (start, index) {
        titles[start - 1] = String(index + 9) + '月份';
        ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.forEach(function (value, offset) {
          headers[start - 1 + offset] = value;
        });
      });
      if (badTitle) titles[10] = '8月份';
      [41,47,53,59].forEach(function (start) {
        ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.forEach(function (value, offset) {
          headers[start - 1 + offset] = value;
        });
      });
      if (partialMetadata) headers[63] = '';
      return {
        getLastColumn: function () { return headers.length; },
        getRange: function (row, start, height, width) {
          var grid = [titles, headers];
          return { getDisplayValues: function () {
            return Array.from({ length: height }, function (_, index) {
              return grid[row - 1 + index].slice(start - 1, start - 1 + width);
            });
          } };
        }
      };
    }
    return attendanceResolveAnnualAdjustmentSources_(
      makeSheet(true, false), ATTENDANCE_SYNC_ANNUAL_WORKBOOKS[2]
    );
  })()`, context), /month title/);

  assert.throws(() => vm.runInContext(`(function () {
    var titles = Array(64).fill('');
    var headers = Array(64).fill('');
    [1,11,21,31].forEach(function (start, index) {
      titles[start - 1] = String(index + 9) + '月份';
      ATTENDANCE_SYNC_PH_ADJUSTMENT_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    [41,47,53,59].forEach(function (start) {
      ATTENDANCE_SYNC_PH_ADJUSTMENT_METADATA_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    headers[63] = '';
    var sheet = {
      getLastColumn: function () { return headers.length; },
      getRange: function (row, start, height, width) {
        var grid = [titles, headers];
        return { getDisplayValues: function () {
          return Array.from({ length: height }, function (_, index) {
            return grid[row - 1 + index].slice(start - 1, start - 1 + width);
          });
        } };
      }
    };
    return attendanceResolveAnnualAdjustmentSources_(sheet, ATTENDANCE_SYNC_ANNUAL_WORKBOOKS[2]);
  })()`, context), /metadata headers/);
});

test('generic reconciliation does not grant the reviewed delete override', () => {
  const calls = json(`(function () {
    var original = syncAttendanceSourcesInternal_;
    var captured = [];
    try {
      syncAttendanceSourcesInternal_ = function (sources, force, triggerKind, dirtyOnly, reviewedLargeDelete) {
        captured.push({
          sourceKeys: sources.map(function (source) { return source.sourceKey; }),
          force: force,
          triggerKind: triggerKind,
          dirtyOnly: dirtyOnly,
          reviewedLargeDelete: reviewedLargeDelete === true
        });
      };
      reconcileAttendanceSheets();
      runAttendanceReconciliation();
      runReviewedHomePhSeptember2026Reconciliation();
      return captured;
    } finally {
      syncAttendanceSourcesInternal_ = original;
    }
  })()`);

  assert.deepEqual(calls, [
    {
      sourceKeys: calls[0].sourceKeys,
      force: false,
      triggerKind: 'daily_reconcile',
      dirtyOnly: false,
      reviewedLargeDelete: false,
    },
    {
      sourceKeys: calls[1].sourceKeys,
      force: true,
      triggerKind: 'manual',
      dirtyOnly: false,
      reviewedLargeDelete: false,
    },
    {
      sourceKeys: ['home_ph_annual_2026_09'],
      force: true,
      triggerKind: 'manual',
      dirtyOnly: false,
      reviewedLargeDelete: true,
    },
  ]);
  assert.equal(calls[0].sourceKeys.length, 14);
  assert.equal(calls[1].sourceKeys.length, 14);
  assert.match(source, /syncAttendanceSourcesInternal_\(due, false, 'change', true\)/);
});

test('reviewed delete payload is pinned to the audited source, hashes and counts', () => {
  assert.match(source, /sourceKey:\s*'home_ph_annual_2026_09'/);
  assert.match(source, /previousSnapshotHash:\s*'527f340c6cf16ab44dc76005f1148882380b84dd29e462441178d68c225b1071'/);
  assert.match(source, /snapshotHash:\s*'f6da820efa127e92d99bf0240380ef334e5007b093429d5ba1f30683ddf01126'/);
  assert.match(source, /expectedDeleteCount:\s*9/);
  assert.match(source, /expectedReadRowCount:\s*720/);
  assert.match(source, /expectedCanonicalRecordCount:\s*295/);
  assert.match(source, /expectedParseWarningCount:\s*7/);
  assert.match(source, /if \(snapshot\.hash !== reviewed\.snapshotHash\)/);
  assert.match(source, /payload\.allow_large_delete = true/);
});
