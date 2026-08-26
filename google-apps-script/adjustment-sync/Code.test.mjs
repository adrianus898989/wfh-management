import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
let uuidSequence = 0;
const context = vm.createContext({
  console,
  Utilities: {
    formatDate(value) {
      return new Date(value).toISOString().slice(0, 10);
    },
    getUuid() {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
    },
  },
});

// Parsing the complete Apps Script in V8 catches syntax errors without touching Google.
vm.runInContext(source, context, { filename: 'Code.gs' });

const evaluateJson = (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));

test('keeps standard metadata unchanged and gives Philippines two managed slots per month', () => {
  const standard = evaluateJson(`ADJUSTMENT_MONTHS.map(function (month) {
    var route = adjustmentRoute_('onsite', month);
    return [route.metadataStart, route.metadataWidth];
  })`);
  const philippines = evaluateJson(`ADJUSTMENT_MONTHS.map(function (month) {
    var route = adjustmentRoute_('home_ph', month);
    return [route.metadataStart, route.metadataWidth,
      adjustmentSlotMetadata_(route, 'first_half').start,
      adjustmentSlotMetadata_(route, 'second_half').start];
  })`);

  assert.deepEqual(standard, [[32, 3], [35, 3], [38, 3], [41, 3]]);
  assert.deepEqual(philippines, [
    [41, 6, 41, 44],
    [47, 6, 47, 50],
    [53, 6, 53, 56],
    [59, 6, 59, 62],
  ]);
});

test('splits the Philippines nine-column row into independent half-month records', () => {
  const rows = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('home_ph', '2026-09'),
    ['Ana', 'PH-12', -25, '迟到', 40, '绩效奖金', 'late 25 minutes', 'excellent', new Date('2026-09-20T12:00:00Z')],
    ['Ana', 'PH-12', '-25', '迟到', '40', '绩效奖金', 'late 25 minutes', 'excellent', '2026-09-20']
  )`);

  assert.deepEqual(rows.map(({ sourceSlot, amount, category, note }) => ({ sourceSlot, amount, category, note })), [
    { sourceSlot: 'first_half', amount: -25, category: '迟到', note: 'late 25 minutes' },
    { sourceSlot: 'second_half', amount: 40, category: '绩效奖金', note: 'excellent' },
  ]);
});

test('maps Philippines edits to the correct half-month slot', () => {
  const slots = evaluateJson(`(function () {
    var route = adjustmentRoute_('home_ph', '2026-09');
    return {
      shared: adjustmentEditedSourceSlots_(route, route.start, route.start),
      date: adjustmentEditedSourceSlots_(route, route.start + 8, route.start + 8),
      firstAmount: adjustmentEditedSourceSlots_(route, route.start + 2, route.start + 2),
      firstType: adjustmentEditedSourceSlots_(route, route.start + 3, route.start + 3),
      firstNote: adjustmentEditedSourceSlots_(route, route.start + 6, route.start + 6),
      secondAmount: adjustmentEditedSourceSlots_(route, route.start + 4, route.start + 4),
      secondType: adjustmentEditedSourceSlots_(route, route.start + 5, route.start + 5),
      secondNote: adjustmentEditedSourceSlots_(route, route.start + 7, route.start + 7)
    };
  })()`);
  assert.deepEqual(slots, {
    shared: ['first_half', 'second_half'],
    date: ['first_half', 'second_half'],
    firstAmount: ['first_half'],
    firstType: ['first_half'],
    firstNote: ['first_half'],
    secondAmount: ['second_half'],
    secondType: ['second_half'],
    secondNote: ['second_half'],
  });

  const firstOnly = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('home_ph', '2026-09'),
    ['Ana', 'PH-12', -25, '迟到', 40, '绩效奖金', 'late 25 minutes', 'excellent', new Date('2026-09-20T12:00:00Z')],
    ['Ana', 'PH-12', '-25', '迟到', '40', '绩效奖金', 'late 25 minutes', 'excellent', '2026-09-20'],
    ['first_half']
  )`);
  assert.equal(firstOnly.length, 1);
  assert.equal(firstOnly[0].sourceSlot, 'first_half');
});

test('writes Philippines outbound values into the real nine-column slots', () => {
  const result = evaluateJson(`(function () {
    var route = adjustmentRoute_('home_ph', '2026-09');
    var sheet = {
      getRange: function () {
        return { getDisplayValue: function () { return ''; } };
      }
    };
    var eventDate = adjustmentDate_(new Date('2026-09-20T12:00:00Z'));
    var base = {
      signed_amount: -25, employee_name: 'Ana', employee_no: 'PH-12',
      category: '迟到', note: 'late 25 minutes'
    };
    var first = adjustmentPhilippinesWritePlan_(sheet, route, 3, 'first_half', base, eventDate);
    var second = adjustmentPhilippinesWritePlan_(sheet, route, 3, 'second_half',
      Object.assign({}, base, { signed_amount: 40, category: '绩效奖金', note: 'excellent' }),
      eventDate);
    var calls = [];
    var writeSheet = {
      getRange: function (row, column, height, width) {
        return {
          setValues: function (values) { calls.push(['values', row, column, height, width, values]); },
          setValue: function (value) { calls.push(['value', row, column, height, width, value]); }
        };
      }
    };
    applyPhilippinesAdjustmentWritePlan_(writeSheet, first);
    return {
      first: [first.amountColumn, first.categoryColumn, first.noteColumn, first.dateColumn],
      second: [second.amountColumn, second.categoryColumn, second.noteColumn, second.dateColumn],
      calls: calls
    };
  })()`);
  assert.deepEqual(result.first, [3, 4, 7, 9]);
  assert.deepEqual(result.second, [5, 6, 8, 9]);
  assert.deepEqual(result.calls.map(call => call[2]), [1, 3, 4, 7, 9]);
  assert.equal(result.calls[2][5], '迟到');
});

test('preserves a negative standard deduction in both directions', () => {
  const inbound = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('onsite', '2026-09'),
    ['Lee', 'A-1', '', -30, '迟到', 'penalty', new Date('2026-09-09T12:00:00Z')],
    ['Lee', 'A-1', '', '-30', '迟到', 'penalty', '2026-09-09']
  )`);
  assert.equal(inbound[0].amount, -30);
  assert.equal(inbound[0].category, '迟到');

  const outbound = evaluateJson(`(function () {
    var route = adjustmentRoute_('onsite', '2026-09');
    var date = adjustmentDate_(new Date('2026-09-09T12:00:00Z'));
    var values = adjustmentOutboundValues_(route, {
      signed_amount: -30, employee_name: 'Lee', employee_no: 'A-1',
      category: '迟到', note: 'penalty'
    }, date);
    return [values[2], values[3], values[4], values[5]];
  })()`);
  assert.deepEqual(outbound, ['', -30, '迟到', 'penalty']);
});

test('standard routes match the live seven-column Sep-Dec layout', () => {
  const routes = evaluateJson(`ADJUSTMENT_MONTHS.map(function (month) {
    var route = adjustmentRoute_('onsite', month);
    return { start: route.start, width: route.width, tabName: route.tabName, headers: route.headers };
  })`);
  assert.deepEqual(routes.map(route => route.start), [1, 9, 17, 25]);
  assert.ok(routes.every(route => route.width === 7 && route.tabName === '奖惩填表'));
  assert.deepEqual(routes[0].headers, ['姓名', 'ID', '奖金', '扣除', '类型', '备注', '日期']);
});

test('resolves each standard month from the actual seven-column headers', () => {
  const routes = evaluateJson(`(function () {
    var titles = [
      '9月份','','','','','','','',
      '10月份','','','','','','','',
      '11月份','','','','','','','',
      '12月份'
    ];
    var header = [
      '姓名','ID','奖金','扣除','类型','备注','日期','',
      '姓名','ID','奖金','扣除','类型','备注','日期','',
      '姓名','ID','奖金','扣除','类型','备注','日期','',
      '姓名','ID','奖金','扣除','类型','备注','日期'
    ];
    var sheet = {
      getLastColumn: function () { return header.length; },
      getRange: function (row, start, height, width) {
        var grid = [titles, header];
        return { getDisplayValues: function () {
          return Array.from({ length: height }, function (_, index) {
            return grid[row - 1 + index].slice(start - 1, start - 1 + width);
          });
        } };
      }
    };
    return adjustmentResolveStandardRoutes_(sheet, 'onsite', 2).map(function (route) {
      return [route.start, route.width, route.metadataStart, route.hasCategory, route.schemaKey];
    });
  })()`);
  assert.deepEqual(routes, [
    [1, 7, 32, true, 'with_category'],
    [9, 7, 35, true, 'with_category'],
    [17, 7, 38, true, 'with_category'],
    [25, 7, 41, true, 'with_category'],
  ]);
});

test('standard resolver ignores March-August history and routes only September-December', () => {
  const routes = evaluateJson(`(function () {
    var titles = Array(79).fill('');
    var headers = Array(79).fill('');
    for (var month = 3; month <= 12; month += 1) {
      var start = 1 + (month - 3) * 8;
      titles[start - 1] = String(month) + '月份';
      ADJUSTMENT_STANDARD_SCHEMAS[0].headers.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    }
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
    return adjustmentResolveStandardRoutes_(sheet, 'onsite', 2).map(function (route) {
      return [route.month, route.start, route.width, route.metadataStart];
    });
  })()`);
  assert.deepEqual(routes, [
    ['2026-09', 49, 7, 80],
    ['2026-10', 57, 7, 83],
    ['2026-11', 65, 7, 86],
    ['2026-12', 73, 7, 89],
  ]);
});

test('resolves Philippines blocks only from row-1 month titles and exact row-2 nine-column headers', () => {
  const routes = evaluateJson(`(function () {
    var titles = Array(64).fill('');
    var headers = Array(64).fill('');
    [1,11,21,31].forEach(function (start, index) {
      titles[start - 1] = String(index + 9) + '月份';
      ADJUSTMENT_PH_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    [41,47,53,59].forEach(function (start) {
      ADJUSTMENT_PH_METADATA_HEADERS.forEach(function (value, offset) {
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
    return adjustmentResolvePhilippinesRoutes_(sheet, 'home_ph', 2).map(function (route) {
      return [route.start, route.width, route.metadataStart, route.metadataWidth,
        route.hasCategory, route.schemaKey];
    });
  })()`);
  assert.deepEqual(routes, [
    [1, 9, 41, 6, true, 'philippines'],
    [11, 9, 47, 6, true, 'philippines'],
    [21, 9, 53, 6, true, 'philippines'],
    [31, 9, 59, 6, true, 'philippines'],
  ]);
});

test('Philippines resolver ignores March-August history and routes only September-December', () => {
  const routes = evaluateJson(`(function () {
    var titles = Array(99).fill('');
    var headers = Array(99).fill('');
    for (var month = 3; month <= 12; month += 1) {
      var start = 1 + (month - 3) * 10;
      titles[start - 1] = String(month) + '月份';
      ADJUSTMENT_PH_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    }
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
    return adjustmentResolvePhilippinesRoutes_(sheet, 'home_ph', 2).map(function (route) {
      return [route.month, route.start, route.width, route.metadataStart];
    });
  })()`);
  assert.deepEqual(routes, [
    ['2026-09', 61, 9, 101],
    ['2026-10', 71, 9, 107],
    ['2026-11', 81, 9, 113],
    ['2026-12', 91, 9, 119],
  ]);
});

test('rejects a Philippines block with a wrong month title or occupied metadata region', () => {
  assert.throws(() => vm.runInContext(`(function () {
    var sheet = { getLastColumn: function () { return 64; } };
    return adjustmentResolvePhilippinesRoutes_(sheet, 'home_ph', 3);
  })()`, context), /第 1 行月份标题和第 2 行/);

  assert.throws(() => vm.runInContext(`(function () {
    var titles = Array(64).fill('');
    var headers = Array(64).fill('');
    [1,11,21,31].forEach(function (start, index) {
      titles[start - 1] = String(index + 9) + '月份';
      ADJUSTMENT_PH_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    titles[10] = '8月份';
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
    return adjustmentResolvePhilippinesRoutes_(sheet, 'home_ph', 2);
  })()`, context), /缺少 2026-10/);

  assert.throws(() => vm.runInContext(`(function () {
    var titles = Array(64).fill('');
    var headers = Array(64).fill('');
    [1,11,21,31].forEach(function (start, index) {
      titles[start - 1] = String(index + 9) + '月份';
      ADJUSTMENT_PH_HEADERS.forEach(function (value, offset) {
        headers[start - 1 + offset] = value;
      });
    });
    headers[40] = 'reserved by business';
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
    return adjustmentResolvePhilippinesRoutes_(sheet, 'home_ph', 2);
  })()`, context), /已有其他表头/);
});

test('resolves the legacy six-column standard layout without shifting date or metadata', () => {
  const routes = evaluateJson(`(function () {
    var titles = [
      '9月份','','','','','','',
      '10月份','','','','','','',
      '11月份','','','','','','',
      '12月份'
    ];
    var header = [
      '姓名','ID','奖金','扣除','备注','日期','',
      '姓名','ID','奖金','扣除','备注','日期','',
      '姓名','ID','奖金','扣除','备注','日期','',
      '姓名','ID','奖金','扣除','备注','日期'
    ];
    var sheet = {
      getLastColumn: function () { return header.length; },
      getRange: function (row, start, height, width) {
        var grid = [titles, header];
        return { getDisplayValues: function () {
          return Array.from({ length: height }, function (_, index) {
            return grid[row - 1 + index].slice(start - 1, start - 1 + width);
          });
        } };
      }
    };
    return adjustmentResolveStandardRoutes_(sheet, 'onsite', 2).map(function (route) {
      return [route.start, route.width, route.metadataStart, route.hasCategory, route.schemaKey];
    });
  })()`);
  assert.deepEqual(routes, [
    [1, 6, 28, false, 'legacy_without_category'],
    [8, 6, 31, false, 'legacy_without_category'],
    [15, 6, 34, false, 'legacy_without_category'],
    [22, 6, 37, false, 'legacy_without_category'],
  ]);

  const inbound = evaluateJson(`adjustmentInboundRows_(
    Object.assign({}, adjustmentRoute_('onsite', '2026-09'), {
      width: 6, hasCategory: false,
      headers: ['姓名','ID','奖金','扣除','备注','日期']
    }),
    ['Lee', 'A-1', '', -30, 'late 30 minutes', new Date('2026-09-09T12:00:00Z')],
    ['Lee', 'A-1', '', '-30', 'late 30 minutes', '2026-09-09']
  )`);
  assert.equal(inbound[0].category, '扣款');
  assert.equal(inbound[0].note, 'late 30 minutes');
});

test('rejects an incomplete standard header map before any sheet write', () => {
  assert.throws(() => vm.runInContext(`(function () {
    var titles = ['9月份'];
    var header = ['姓名','ID','奖金','扣除','类型','备注','日期'];
    var sheet = {
      getLastColumn: function () { return header.length; },
      getRange: function (row, start, height, width) {
        var grid = [titles, header];
        return { getDisplayValues: function () {
          return Array.from({ length: height }, function (_, index) {
            return grid[row - 1 + index].slice(start - 1, start - 1 + width);
          });
        } };
      }
    };
    return adjustmentResolveStandardRoutes_(sheet, 'onsite', 2);
  })()`, context), /缺少 2026-10, 2026-11, 2026-12/);
});

test('allocates revision and durable queue inside ScriptLock', () => {
  const handler = source.slice(
    source.indexOf('function adjustmentSyncOnEdit'),
    source.indexOf('function adjustmentEditedSourceSlots_'),
  );
  assert.match(handler, /lock\.waitLock\(300000\)/);
  assert.ok(handler.indexOf('lock.waitLock') < handler.indexOf('queueAdjustmentInboundRow_'));
  assert.ok(handler.indexOf('queueAdjustmentInboundRow_') < handler.indexOf('lock.releaseLock'));
  assert.match(source, /const revision = Math\.max\([\s\S]*Date\.now\(\)\);/);
  assert.match(source, /existingRevision === revision && existingOrigin === 'google'/);
});

test('backs off a durable inbound retry instead of calling Supabase every minute', () => {
  let stored = null;
  context.testProperties = {
    setProperty(_key, value) {
      stored = JSON.parse(value);
    },
  };
  context.testPayload = { action: 'inbound', request_id: 'r1' };
  context.testBefore = Date.now();
  vm.runInContext(
    `scheduleAdjustmentInboundRetry_(testProperties, 'queue-key', testPayload,
      { attempt: 6 }, new Error('sync_http_400:employee_not_found'))`,
    context,
  );
  assert.equal(stored.attempt, 7);
  assert.ok(stored.retry_at >= context.testBefore + 3_500_000);
  assert.equal(stored.payload.request_id, 'r1');
});
