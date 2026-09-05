/**
 * 奖金 / 扣除双向同步（Supabase canonical + Google delivery outbox）。
 *
 * Script Properties（不得写入源码）：
 *   ADJUSTMENT_SYNC_URL
 *   ADJUSTMENT_SYNC_TOKEN
 *   ADJUSTMENT_HEADER_ROW（可选，默认 2；安装前会严格校验）
 */

const ADJUSTMENT_SYNC_HANDLER = 'adjustmentSyncEveryMinute';
const ADJUSTMENT_EDIT_HANDLER = 'adjustmentSyncOnEdit';
const ADJUSTMENT_QUEUE_PREFIX = 'ADJUSTMENT_INBOUND_';
const ADJUSTMENT_WORKER_PROPERTY = 'ADJUSTMENT_SYNC_WORKER_ID';
const ADJUSTMENT_STANDARD_METADATA_HEADERS = Object.freeze([
  '__sync_external_id', '__sync_origin', '__sync_revision',
]);
const ADJUSTMENT_PH_METADATA_HEADERS = Object.freeze([
  '__sync_first_half_external_id', '__sync_first_half_origin', '__sync_first_half_revision',
  '__sync_second_half_external_id', '__sync_second_half_origin', '__sync_second_half_revision',
]);
const ADJUSTMENT_PH_HEADERS = Object.freeze([
  '姓名', 'ID', '金额1-15', '类型', '金额16-末', '类型', '备注1-15', '备注16-末', '日期',
]);
const ADJUSTMENT_STANDARD_SCHEMAS = Object.freeze([
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
const ADJUSTMENT_MONTHS = Object.freeze(['2026-09', '2026-10', '2026-11', '2026-12']);
const ADJUSTMENT_SYNC_EXPECTED_URL =
  'https://ibvntgtydsavdiyqekrq.supabase.co/functions/v1/adjustment-sheet-sync';

const ADJUSTMENT_WORKBOOKS = Object.freeze({
  onsite: Object.freeze({
    spreadsheetId: '1EeWiXV9BEAHhfZBV67PQ9PMHvQ9ufSOWqbXhlWbL5Kg',
    gid: 1011694934,
    tabName: '奖惩填表',
    currency: 'USD',
    layout: 'standard',
    starts: Object.freeze([1, 9, 17, 25]), // A:G, I:O, Q:W, Y:AE
    metadataStarts: Object.freeze([32, 35, 38, 41]), // AF:AH, AI:AK, AL:AN, AO:AQ
    headers: Object.freeze(['姓名', 'ID', '奖金', '扣除', '类型', '备注', '日期']),
  }),
  home_vim: Object.freeze({
    spreadsheetId: '1x6-k7VqePZEJW2EMqaGvBJqYkGf_MXVpoZRl0Zue2AQ',
    gid: 3368572,
    tabName: '奖惩填表',
    currency: 'USD',
    layout: 'standard',
    starts: Object.freeze([1, 9, 17, 25]),
    metadataStarts: Object.freeze([32, 35, 38, 41]),
    headers: Object.freeze(['姓名', 'ID', '奖金', '扣除', '类型', '备注', '日期']),
  }),
  home_ph: Object.freeze({
    spreadsheetId: '1j2MAKfOe3Yd-8_OQHsdpOe2__WGXg2oWc2jsefbHzZQ',
    gid: 687407921,
    tabName: '奖惩填表',
    currency: 'PHP',
    layout: 'philippines',
    starts: Object.freeze([1, 11, 21, 31]), // A:I, K:S, U:AC, AE:AM
    metadataStarts: Object.freeze([41, 47, 53, 59]), // AO:AT, AU:AZ, BA:BF, BG:BL
    headers: ADJUSTMENT_PH_HEADERS,
  }),
});

function adjustmentSyncConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const attendanceUrl = String(properties.getProperty('ATTENDANCE_SYNC_URL') || '').trim();
  const config = {
    // When this file lives beside attendance-sync, reuse its existing private
    // token and derive the sibling endpoint. No raw credential is copied.
    url: String(properties.getProperty('ADJUSTMENT_SYNC_URL') ||
      attendanceUrl.replace(/\/attendance-sheet-sync$/, '/adjustment-sheet-sync')).trim(),
    token: String(properties.getProperty('ADJUSTMENT_SYNC_TOKEN') ||
      properties.getProperty('ATTENDANCE_SYNC_TOKEN') || ''),
    headerRow: Number(properties.getProperty('ADJUSTMENT_HEADER_ROW') || '2'),
  };
  if (config.url && config.url !== ADJUSTMENT_SYNC_EXPECTED_URL) {
    throw new Error('ADJUSTMENT_SYNC_URL 必须与正式奖金扣除同步地址完全一致。');
  }
  return config;
}

function adjustmentRoute_(workbookKey, month) {
  const workbook = ADJUSTMENT_WORKBOOKS[workbookKey];
  const monthIndex = ADJUSTMENT_MONTHS.indexOf(month);
  if (!workbook || monthIndex < 0) throw new Error('来源或月份不在允许清单。');
  return {
    workbookKey: workbookKey,
    month: month,
    sourceKey: 'adjustment_' + workbookKey + '_' + month.replace('-', '_'),
    spreadsheetId: workbook.spreadsheetId,
    gid: workbook.gid,
    tabName: workbook.tabName,
    currency: workbook.currency,
    layout: workbook.layout,
    start: workbook.starts[monthIndex],
    width: workbook.headers.length,
    metadataStart: workbook.metadataStarts[monthIndex],
    metadataWidth: workbook.layout === 'philippines' ? 6 : 3,
    headers: workbook.headers,
    hasCategory: workbook.layout === 'philippines' || workbook.headers.length === 7,
    schemaKey: workbook.layout === 'standard' ? 'with_category' : 'philippines',
  };
}

function adjustmentMetadataHeaders_(route) {
  return route.layout === 'philippines'
    ? ADJUSTMENT_PH_METADATA_HEADERS
    : ADJUSTMENT_STANDARD_METADATA_HEADERS;
}

function adjustmentSourceSlots_(route) {
  return route.layout === 'philippines' ? ['first_half', 'second_half'] : ['primary'];
}

function adjustmentSlotMetadata_(route, sourceSlot) {
  const slots = adjustmentSourceSlots_(route);
  const slotIndex = slots.indexOf(String(sourceSlot || ''));
  if (slotIndex < 0) throw new Error('fatal:invalid_source_slot');
  return {
    start: route.metadataStart + slotIndex * 3,
    offset: slotIndex * 3,
    headers: adjustmentMetadataHeaders_(route).slice(slotIndex * 3, slotIndex * 3 + 3),
  };
}

function adjustmentRoutes_() {
  const result = [];
  Object.keys(ADJUSTMENT_WORKBOOKS).forEach(function (key) {
    ADJUSTMENT_MONTHS.forEach(function (month) { result.push(adjustmentRoute_(key, month)); });
  });
  return result;
}

function adjustmentHeaderMatchesAt_(header, start, expected) {
  if (start < 1 || start + expected.length - 1 > header.length) return false;
  return expected.every(function (value, index) {
    return adjustmentHeaderKey_(header[start - 1 + index]) === adjustmentHeaderKey_(value);
  });
}

function adjustmentExactHeadersAt_(header, start, expected) {
  if (start < 1 || start + expected.length - 1 > header.length) return false;
  return expected.every(function (value, index) {
    return String(header[start - 1 + index] || '').trim() === value;
  });
}

/**
 * Parse a month title without using its physical position.  These workbooks
 * are all for 2026, so a title such as `9月` belongs to 2026; an explicit
 * year is retained so a historical block from another year cannot be routed
 * into a 2026 source by accident.
 */
function adjustmentMonthFromTitle_(value) {
  const normalized = String(value || '').replace(/[\s\u3000]+/g, '');
  let match = normalized.match(/^(\d{4})年(0?[1-9]|1[0-2])月(?:份)?$/);
  if (!match) match = normalized.match(/^(\d{4})[-/](0?[1-9]|1[0-2])(?:月(?:份)?)?$/);
  if (match) return match[1] + '-' + String(Number(match[2])).padStart(2, '0');
  match = normalized.match(/^(0?[1-9]|1[0-2])月(?:份)?$/);
  if (!match) return '';
  return '2026-' + String(Number(match[1])).padStart(2, '0');
}

/**
 * Resolve the standard 9–12 month blocks from the sheet's actual header row.
 * The seven-column schema is preferred, while the previous six-column schema
 * remains readable/write-safe until that workbook receives its 类型 column.
 */
function adjustmentResolveStandardRoutes_(sheet, workbookKey, headerRow) {
  if (headerRow < 2) {
    throw new Error('standard 奖惩表必须在业务表头上一行保留月份标题。');
  }
  const lastColumn = Math.max(Number(sheet.getLastColumn()), 1);
  const rows = sheet.getRange(headerRow - 1, 1, 2, lastColumn).getDisplayValues();
  const titles = rows[0] || [];
  const header = rows[1] || [];
  const byMonth = {};
  let column = 1;
  while (column <= header.length) {
    let match = null;
    for (let index = 0; index < ADJUSTMENT_STANDARD_SCHEMAS.length; index += 1) {
      const schema = ADJUSTMENT_STANDARD_SCHEMAS[index];
      if (adjustmentHeaderMatchesAt_(header, column, schema.headers)) {
        match = schema;
        break;
      }
    }
    if (!match) {
      column += 1;
      continue;
    }
    const candidateMonth = adjustmentMonthFromTitle_(titles[column - 1]);
    if (!candidateMonth) {
      throw new Error(
        'standard 奖惩表检测到业务表头，但对应月份标题缺失或无法识别，停止安装/写入。'
      );
    }
    // The same tab may retain March–August historical blocks.  They are
    // intentionally ignored and are never returned to edit/write callers.
    if (ADJUSTMENT_MONTHS.indexOf(candidateMonth) >= 0) {
      if (byMonth[candidateMonth]) {
        throw new Error('standard 奖惩表 9–12 月份标题重复，停止安装/写入。');
      }
      byMonth[candidateMonth] = { start: column, schema: match };
    }
    column += match.headers.length;
  }
  const missing = ADJUSTMENT_MONTHS.filter(function (month) { return !byMonth[month]; });
  if (missing.length) {
    throw new Error(
      'standard 奖惩表必须按月份标题识别 9–12 月的 4 个业务块；缺少 ' +
      missing.join(', ') +
      '。支持表头：姓名、ID、奖金、扣除、[类型]、备注、日期。未读取或写入业务数据。'
    );
  }

  const businessStarts = ADJUSTMENT_MONTHS.map(function (month) { return byMonth[month].start; });
  if (businessStarts.some(function (start, index) {
    return index > 0 && start <= businessStarts[index - 1];
  })) {
    throw new Error('standard 奖惩表 9–12 月业务块顺序不正确，停止安装/写入。');
  }

  const businessEnd = ADJUSTMENT_MONTHS.reduce(function (maximum, month) {
    const match = byMonth[month];
    return Math.max(maximum, match.start + match.schema.headers.length - 1);
  }, 0);
  const metadataMatches = [];
  for (let metadataColumn = businessEnd + 1;
    metadataColumn <= header.length - ADJUSTMENT_STANDARD_METADATA_HEADERS.length + 1;
    metadataColumn += 1) {
    if (adjustmentHeaderMatchesAt_(header, metadataColumn, ADJUSTMENT_STANDARD_METADATA_HEADERS)) {
      metadataMatches.push(metadataColumn);
      metadataColumn += ADJUSTMENT_STANDARD_METADATA_HEADERS.length - 1;
    }
  }
  if (metadataMatches.length && (
    metadataMatches.length !== ADJUSTMENT_MONTHS.length ||
    metadataMatches.some(function (start, index) { return start !== metadataMatches[0] + index * 3; })
  )) {
    throw new Error('standard 奖惩同步协议列不完整或不连续，停止安装/写入，未修改任何单元格。');
  }
  const metadataBase = metadataMatches.length ? metadataMatches[0] : businessEnd + 1;
  return ADJUSTMENT_MONTHS.map(function (month, index) {
    const preferred = adjustmentRoute_(workbookKey, month);
    const match = byMonth[month];
    return Object.assign({}, preferred, {
      start: match.start,
      width: match.schema.headers.length,
      headers: match.schema.headers,
      hasCategory: match.schema.hasCategory,
      schemaKey: match.schema.key,
      metadataStart: metadataBase + index * 3,
    });
  });
}

function adjustmentMonthTitleMatches_(value, month) {
  return adjustmentMonthFromTitle_(value) === month;
}

/**
 * Resolve the Philippines 9–12 month blocks without assuming their physical
 * columns. A block is accepted only when its merged row-1 month title and all
 * nine row-2 business headers agree. Metadata may move as one contiguous
 * four-by-six region; when it is not installed yet, only the allowlisted blank
 * AO:BL region is eligible. No business cell is written by this resolver.
 */
function adjustmentResolvePhilippinesRoutes_(sheet, workbookKey, headerRow) {
  if (headerRow !== 2) {
    throw new Error('Philippines 奖惩表只允许第 1 行月份标题和第 2 行 9 列业务表头。');
  }
  const workbook = ADJUSTMENT_WORKBOOKS[workbookKey];
  const lastColumn = Math.max(Number(sheet.getLastColumn()), 1);
  const rows = sheet.getRange(headerRow - 1, 1, 2, lastColumn).getDisplayValues();
  const titles = rows[0] || [];
  const header = rows[1] || [];
  const byMonth = {};
  let column = 1;
  while (column <= header.length) {
    if (!adjustmentExactHeadersAt_(header, column, ADJUSTMENT_PH_HEADERS)) {
      column += 1;
      continue;
    }
    const month = adjustmentMonthFromTitle_(titles[column - 1]);
    if (!month) {
      throw new Error('Philippines 奖惩表月份标题缺失或与 9 列表头不对应，停止安装/写入。');
    }
    // March–August blocks are historical input on this same tab.  Only the
    // allowlisted September–December blocks can reach synchronization code.
    if (ADJUSTMENT_MONTHS.indexOf(month) < 0) {
      column += ADJUSTMENT_PH_HEADERS.length;
      continue;
    }
    if (byMonth[month]) {
      throw new Error('Philippines 奖惩表 9–12 月份标题重复，停止安装/写入。');
    }
    byMonth[month] = column;
    column += ADJUSTMENT_PH_HEADERS.length;
  }
  const missing = ADJUSTMENT_MONTHS.filter(function (month) { return !byMonth[month]; });
  if (missing.length) {
    throw new Error(
      'Philippines 奖惩表必须按第 1 行月份标题识别 9–12 月的 4 个 9 列业务块；缺少 ' +
      missing.join(', ') + '。未读取或写入业务数据。'
    );
  }
  const businessStarts = ADJUSTMENT_MONTHS.map(function (month) { return byMonth[month]; });
  if (businessStarts.some(function (start, index) {
    return index > 0 && start <= businessStarts[index - 1];
  })) {
    throw new Error('Philippines 奖惩表 9–12 月业务块顺序不正确，停止安装/写入。');
  }

  const businessEnd = ADJUSTMENT_MONTHS.reduce(function (maximum, month) {
    return Math.max(maximum, byMonth[month] + ADJUSTMENT_PH_HEADERS.length - 1);
  }, 0);
  const metadataMatches = [];
  for (let metadataColumn = businessEnd + 1;
    metadataColumn <= header.length - ADJUSTMENT_PH_METADATA_HEADERS.length + 1;
    metadataColumn += 1) {
    if (adjustmentExactHeadersAt_(header, metadataColumn, ADJUSTMENT_PH_METADATA_HEADERS)) {
      metadataMatches.push(metadataColumn);
      metadataColumn += ADJUSTMENT_PH_METADATA_HEADERS.length - 1;
    }
  }
  if (metadataMatches.length && (
    metadataMatches.length !== ADJUSTMENT_MONTHS.length ||
    metadataMatches.some(function (start, index) { return start !== metadataMatches[0] + index * 6; })
  )) {
    throw new Error('Philippines 奖惩同步协议列不完整或不连续，停止安装/写入。');
  }
  let metadataStarts = metadataMatches;
  if (!metadataStarts.length) {
    const preferredBusinessEnd = workbook.starts[workbook.starts.length - 1] +
      ADJUSTMENT_PH_HEADERS.length - 1;
    const metadataGap = workbook.metadataStarts[0] - preferredBusinessEnd;
    const metadataBase = businessEnd + metadataGap;
    metadataStarts = ADJUSTMENT_MONTHS.map(function (_month, index) {
      return metadataBase + index * ADJUSTMENT_PH_METADATA_HEADERS.length;
    });
    metadataStarts.forEach(function (start) {
      if (start <= businessEnd) {
        throw new Error('Philippines 奖惩同步协议列与业务块重叠，停止安装/写入。');
      }
      const existing = header.slice(start - 1, start - 1 + ADJUSTMENT_PH_METADATA_HEADERS.length);
      const empty = existing.every(function (value) { return !String(value || '').trim(); });
      if (!empty) {
        throw new Error('Philippines 预留同步协议列已有其他表头，停止安装/写入。');
      }
    });
  }
  return ADJUSTMENT_MONTHS.map(function (month, index) {
    return Object.assign({}, adjustmentRoute_(workbookKey, month), {
      start: byMonth[month],
      width: ADJUSTMENT_PH_HEADERS.length,
      headers: ADJUSTMENT_PH_HEADERS,
      hasCategory: true,
      schemaKey: 'philippines',
      metadataStart: metadataStarts[index],
      metadataWidth: ADJUSTMENT_PH_METADATA_HEADERS.length,
    });
  });
}

function adjustmentResolveRoutesForSheet_(sheet, workbookKey, headerRow) {
  const workbook = ADJUSTMENT_WORKBOOKS[workbookKey];
  if (!workbook) throw new Error('来源不在允许清单。');
  if (workbook.layout === 'standard') {
    return adjustmentResolveStandardRoutes_(sheet, workbookKey, headerRow);
  }
  return adjustmentResolvePhilippinesRoutes_(sheet, workbookKey, headerRow);
}

function adjustmentResolvedRoute_(sheet, workbookKey, month, headerRow) {
  const routes = adjustmentResolveRoutesForSheet_(sheet, workbookKey, headerRow);
  const route = routes.filter(function (candidate) { return candidate.month === month; })[0];
  if (!route) throw new Error('月份不在允许清单。');
  return route;
}

function adjustmentSheet_(route) {
  const spreadsheet = SpreadsheetApp.openById(route.spreadsheetId);
  const sheet = spreadsheet.getSheets().filter(function (candidate) {
    return candidate.getSheetId() === route.gid;
  })[0];
  if (!sheet) throw new Error('固定 gid 不存在：' + route.sourceKey);
  if (sheet.getName() !== route.tabName) {
    throw new Error(
      route.sourceKey + ' 工作表名称不一致，预期「' + route.tabName +
      '」，实际「' + sheet.getName() + '」。未读取或写入业务数据。'
    );
  }
  return sheet;
}

function adjustmentHeaderKey_(value) {
  return String(value || '').replace(/[\s\u3000_\-—–/]+/g, '').toLowerCase();
}

function validateAdjustmentRoute_(sheet, route, headerRow) {
  if (sheet.getSheetId() !== route.gid || sheet.getParent().getId() !== route.spreadsheetId) {
    throw new Error('工作簿或 gid 与白名单不一致：' + route.sourceKey);
  }
  const actual = sheet.getRange(headerRow, route.start, 1, route.width).getDisplayValues()[0];
  const expected = route.headers;
  for (let index = 0; index < expected.length; index += 1) {
    const matches = route.layout === 'philippines'
      ? String(actual[index] || '').trim() === expected[index]
      : adjustmentHeaderKey_(actual[index]) === adjustmentHeaderKey_(expected[index]);
    if (!matches) {
      throw new Error(
        route.sourceKey + ' 表头不一致，第 ' + (index + 1) + ' 列预期「' + expected[index] +
        '」，实际「' + actual[index] + '」。未写入任何同步列。'
      );
    }
  }
}

function validateAdjustmentMetadataRegion_(sheet, route, headerRow) {
  const expectedHeaders = adjustmentMetadataHeaders_(route);
  if (sheet.getMaxColumns() < route.metadataStart + route.metadataWidth - 1) return;
  const rowCount = Math.max(sheet.getLastRow() - headerRow + 1, 1);
  const values = sheet.getRange(
    headerRow, route.metadataStart, rowCount, route.metadataWidth
  ).getDisplayValues();
  const header = values[0] || [];
  const headerEmpty = header.every(function (value) { return !String(value || '').trim(); });
  const headerValid = expectedHeaders.every(function (expected, index) {
    return String(header[index] || '').trim() === expected;
  });
  if (!headerEmpty && !headerValid) {
    throw new Error('同步协议列已有其他表头，停止安装：' + route.sourceKey);
  }
  for (let index = 1; index < values.length; index += 1) {
    const row = values[index].map(function (value) { return String(value || '').trim(); });
    if (row.every(function (value) { return !value; })) continue;
    adjustmentSourceSlots_(route).forEach(function (sourceSlot) {
      const metadata = adjustmentSlotMetadata_(route, sourceSlot);
      const triplet = row.slice(metadata.offset, metadata.offset + 3);
      if (triplet.every(function (value) { return !value; })) return;
      const revision = Number(triplet[2]);
      const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(triplet[0]) &&
        ['google', 'supabase'].indexOf(triplet[1].toLowerCase()) >= 0 &&
        /^\d+$/.test(triplet[2]) && Number.isSafeInteger(revision) && revision >= 1;
      if (!valid) {
        throw new Error(
          '同步协议列已有业务数据，停止安装：' + route.sourceKey +
          ' 第 ' + (headerRow + index) + ' 行 / ' + sourceSlot
        );
      }
    });
  }
}

/** 首次安装。先只读校验全部 12 个块，全部通过后才写隐藏元数据表头和触发器。 */
function installAdjustmentSync() {
  const config = adjustmentSyncConfig_();
  if (!config.url || !config.token) throw new Error('请先设置 ADJUSTMENT_SYNC_URL / ADJUSTMENT_SYNC_TOKEN。');
  if (!Number.isInteger(config.headerRow) || config.headerRow < 1 || config.headerRow > 20) {
    throw new Error('ADJUSTMENT_HEADER_ROW 必须是 1–20 的整数。');
  }
  const validated = [];
  Object.keys(ADJUSTMENT_WORKBOOKS).forEach(function (workbookKey) {
    const preferred = adjustmentRoute_(workbookKey, ADJUSTMENT_MONTHS[0]);
    const sheet = adjustmentSheet_(preferred);
    adjustmentResolveRoutesForSheet_(sheet, workbookKey, config.headerRow).forEach(function (route) {
      validateAdjustmentRoute_(sheet, route, config.headerRow);
      validateAdjustmentMetadataRegion_(sheet, route, config.headerRow);
      validated.push({ route: route, sheet: sheet });
    });
  });

  removeAdjustmentSyncTriggers();
  validated.forEach(function (item) {
    const sheet = item.sheet;
    const route = item.route;
    const requiredColumns = route.metadataStart + route.metadataWidth - 1;
    if (sheet.getMaxColumns() < requiredColumns) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
    }
    sheet.getRange(config.headerRow, route.metadataStart, 1, route.metadataWidth)
      .setValues([adjustmentMetadataHeaders_(route)]);
    sheet.hideColumns(route.metadataStart, route.metadataWidth);
  });
  const worker = PropertiesService.getScriptProperties().getProperty(ADJUSTMENT_WORKER_PROPERTY);
  if (!worker) PropertiesService.getScriptProperties().setProperty(ADJUSTMENT_WORKER_PROPERTY, Utilities.getUuid());

  Object.keys(ADJUSTMENT_WORKBOOKS).forEach(function (key) {
    ScriptApp.newTrigger(ADJUSTMENT_EDIT_HANDLER)
      .forSpreadsheet(ADJUSTMENT_WORKBOOKS[key].spreadsheetId)
      .onEdit()
      .create();
  });
  ScriptApp.newTrigger(ADJUSTMENT_SYNC_HANDLER).timeBased().everyMinutes(5).create();
}

function removeAdjustmentSyncTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if ([ADJUSTMENT_SYNC_HANDLER, ADJUSTMENT_EDIT_HANDLER].indexOf(trigger.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** 每 5 分钟：先重试 Google→Supabase，再批量拉取 Supabase outbox，最后统一 ack。 */
function adjustmentSyncEveryMinute() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    retryAdjustmentInbound_();
    const properties = PropertiesService.getScriptProperties();
    let workerId = properties.getProperty(ADJUSTMENT_WORKER_PROPERTY);
    if (!workerId) {
      workerId = Utilities.getUuid();
      properties.setProperty(ADJUSTMENT_WORKER_PROPERTY, workerId);
    }
    const pulled = adjustmentFetch_({ action: 'pull', worker_id: workerId, limit: 50 });
    const receipts = (pulled.items || []).map(function (item) {
      try {
        return writeAdjustmentOutboxItem_(item);
      } catch (error) {
        return {
          outbox_id: String(item.outbox_id || ''),
          external_id: String(item.external_id || ''),
          revision: Number(item.revision || 0),
          status: adjustmentFatalError_(error) ? 'fatal' : 'retry',
          error: adjustmentSafeError_(error),
        };
      }
    });
    if (receipts.length) adjustmentFetch_({ action: 'ack', worker_id: workerId, receipts: receipts });
  } finally {
    lock.releaseLock();
  }
}

function writeAdjustmentOutboxItem_(item) {
  const workbookKey = String(item.workbook_key || '');
  const month = String(item.source_month || '');
  const preferredRoute = adjustmentRoute_(workbookKey, month);
  if (String(item.source_key || '') !== preferredRoute.sourceKey ||
      String(item.spreadsheet_id || '') !== preferredRoute.spreadsheetId ||
      Number(item.sheet_gid) !== preferredRoute.gid ||
      String(item.currency || '') !== preferredRoute.currency ||
      String(item.layout || '') !== preferredRoute.layout) {
    throw new Error('fatal:outbox_route_mismatch');
  }
  const externalId = adjustmentUuid_(item.external_id, 'external_id');
  const revision = Number(item.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('fatal:invalid_revision');
  const eventDate = adjustmentDate_(item.event_date);
  if (eventDate.key.slice(0, 7) !== preferredRoute.month) throw new Error('fatal:event_date_outside_month');
  const sheet = adjustmentSheet_(preferredRoute);
  const headerRow = adjustmentSyncConfig_().headerRow;
  const route = adjustmentResolvedRoute_(sheet, workbookKey, month, headerRow);
  validateAdjustmentRoute_(sheet, route, headerRow);
  validateAdjustmentMetadataRegion_(sheet, route, headerRow);
  const sourceSlot = adjustmentOutboundSourceSlot_(route, item, eventDate.key);
  const slotMetadata = adjustmentSlotMetadata_(route, sourceSlot);
  const dataRow = headerRow + 1;
  const row = findAdjustmentExternalRow_(sheet, route, slotMetadata, externalId, dataRow)
    || findAdjustmentEmptyRow_(sheet, route, dataRow);
  const metadata = sheet.getRange(row, slotMetadata.start, 1, 3).getDisplayValues()[0];
  const existingExternal = String(metadata[0] || '').trim().toLowerCase();
  const existingOrigin = String(metadata[1] || '').trim().toLowerCase();
  const existingRevisionText = String(metadata[2] || '').trim();
  const existingRevision = Number(existingRevisionText || 0);
  if (existingExternal && (
    ['google', 'supabase'].indexOf(existingOrigin) < 0 ||
    !/^\d+$/.test(existingRevisionText) ||
    !Number.isSafeInteger(existingRevision) || existingRevision < 1
  )) {
    throw new Error('fatal:invalid_existing_metadata');
  }
  if (existingExternal === externalId && (
    existingRevision > revision ||
    (existingRevision === revision && existingOrigin === 'google')
  )) {
    throw new Error('fatal:google_revision_ahead');
  }
  const writePlan = route.layout === 'standard'
    ? { layout: 'standard', values: adjustmentOutboundValues_(route, item, eventDate) }
    : adjustmentPhilippinesWritePlan_(sheet, route, row, sourceSlot, item, eventDate);

  // Claim identity first. If a later business-cell write fails, retry finds the
  // same external_id and safely replays the complete idempotent write plan.
  sheet.getRange(row, slotMetadata.start, 1, 3)
    .setValues([[externalId, 'supabase', revision]]);
  if (writePlan.layout === 'standard') {
    sheet.getRange(row, route.start, 1, route.width).setValues([writePlan.values]);
  } else {
    applyPhilippinesAdjustmentWritePlan_(sheet, writePlan);
  }
  return {
    outbox_id: String(item.outbox_id), external_id: externalId, revision: revision, status: 'ok',
    source_slot: sourceSlot, sheet_row: row, sheet_gid: String(route.gid), sheet_name: sheet.getName(),
  };
}

function adjustmentOutboundSourceSlot_(route, item, eventDateKey) {
  let sourceSlot = String(item.source_slot || '').trim().toLowerCase();
  if (!sourceSlot) {
    sourceSlot = route.layout === 'standard'
      ? 'primary'
      : Number(eventDateKey.slice(8, 10)) <= 15 ? 'first_half' : 'second_half';
  }
  adjustmentSlotMetadata_(route, sourceSlot);
  return sourceSlot;
}

function adjustmentOutboundValues_(route, item, suppliedEventDate) {
  const amount = Number(item.signed_amount);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('fatal:invalid_signed_amount');
  const eventDate = suppliedEventDate || adjustmentDate_(item.event_date);
  if (eventDate.key.slice(0, 7) !== route.month) throw new Error('fatal:event_date_outside_month');
  const name = String(item.employee_name || '').trim();
  const employeeNo = String(item.employee_no || '').trim();
  const note = String(item.note || '').trim();
  const category = String(item.category || item.reason || '').trim();
  if (!name || !employeeNo || !category || !note) throw new Error('fatal:required_field_missing');
  if (route.layout === 'standard') {
    if (route.hasCategory === false) {
      return [name, employeeNo, amount > 0 ? amount : '', amount < 0 ? amount : '', note, eventDate.date];
    }
    return [name, employeeNo, amount > 0 ? amount : '', amount < 0 ? amount : '', category, note, eventDate.date];
  }
  throw new Error('fatal:philippines_requires_slot_write');
}

function adjustmentPhilippinesWritePlan_(sheet, route, row, sourceSlot, item, eventDate) {
  const amount = Number(item.signed_amount);
  const name = String(item.employee_name || '').trim();
  const employeeNo = String(item.employee_no || '').trim();
  const category = String(item.category || item.reason || '').trim();
  const note = String(item.note || '').trim();
  if (!Number.isFinite(amount) || amount === 0) throw new Error('fatal:invalid_signed_amount');
  if (!name || !employeeNo || !category || !note) throw new Error('fatal:required_field_missing');

  const otherSlot = sourceSlot === 'first_half' ? 'second_half' : 'first_half';
  const otherMetadata = adjustmentSlotMetadata_(route, otherSlot);
  const otherExternal = String(
    sheet.getRange(row, otherMetadata.start, 1, 1).getDisplayValue() || ''
  ).trim();
  if (otherExternal) {
    const existing = sheet.getRange(row, route.start, 1, route.width).getValues()[0];
    const currentName = String(existing[0] || '').trim();
    const currentEmployeeNo = String(existing[1] || '').trim();
    const currentDate = existing[8] ? adjustmentDate_(existing[8]).key : '';
    if ((currentName && currentName !== name) ||
        (currentEmployeeNo && currentEmployeeNo.toUpperCase() !== employeeNo.toUpperCase())) {
      throw new Error('fatal:paired_slot_identity_conflict');
    }
    if (currentDate && currentDate !== eventDate.key) {
      throw new Error('fatal:paired_slot_date_conflict');
    }
  }

  const amountOffset = sourceSlot === 'first_half' ? 2 : 4;
  const categoryOffset = sourceSlot === 'first_half' ? 3 : 5;
  const noteOffset = sourceSlot === 'first_half' ? 6 : 7;
  return {
    layout: 'philippines', row: row, start: route.start,
    name: name, employeeNo: employeeNo,
    amountColumn: route.start + amountOffset, amount: amount,
    categoryColumn: route.start + categoryOffset, category: category,
    noteColumn: route.start + noteOffset, note: note,
    dateColumn: route.start + 8, date: eventDate.date,
  };
}

function applyPhilippinesAdjustmentWritePlan_(sheet, plan) {
  sheet.getRange(plan.row, plan.start, 1, 2).setValues([[plan.name, plan.employeeNo]]);
  sheet.getRange(plan.row, plan.amountColumn, 1, 1).setValue(plan.amount);
  sheet.getRange(plan.row, plan.categoryColumn, 1, 1).setValue(plan.category);
  sheet.getRange(plan.row, plan.noteColumn, 1, 1).setValue(plan.note);
  sheet.getRange(plan.row, plan.dateColumn, 1, 1).setValue(plan.date);
}

function findAdjustmentExternalRow_(sheet, route, slotMetadata, externalId, dataRow) {
  const count = Math.max(sheet.getLastRow() - dataRow + 1, 0);
  if (!count) return 0;
  const values = sheet.getRange(dataRow, slotMetadata.start, count, 1).getDisplayValues();
  let match = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0] || '').trim().toLowerCase() !== externalId) continue;
    if (match) throw new Error('fatal:duplicate_google_external_id');
    match = dataRow + index;
  }
  return match;
}

function findAdjustmentEmptyRow_(sheet, route, dataRow) {
  const scanEnd = Math.min(sheet.getMaxRows(), Math.max(sheet.getLastRow() + 50, dataRow + 49));
  const count = scanEnd - dataRow + 1;
  const values = sheet.getRange(dataRow, route.start, count, route.width).getDisplayValues();
  const metadata = sheet.getRange(
    dataRow, route.metadataStart, count, route.metadataWidth
  ).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    const businessEmpty = values[index].every(function (value) { return !String(value || '').trim(); });
    const metadataEmpty = metadata[index].every(function (value) { return !String(value || '').trim(); });
    if (businessEmpty && metadataEmpty) return dataRow + index;
  }
  sheet.insertRowsAfter(sheet.getMaxRows(), 50);
  return scanEnd + 1;
}

/** 安装型 onEdit：只处理固定 gid、固定 12 个数据块，不响应隐藏元数据列。 */
function adjustmentSyncOnEdit(event) {
  if (!event || !event.source || !event.range) return;
  const spreadsheetId = String(event.source.getId() || '');
  const sheet = event.range.getSheet();
  const workbookKey = Object.keys(ADJUSTMENT_WORKBOOKS).filter(function (key) {
    const workbook = ADJUSTMENT_WORKBOOKS[key];
    return workbook.spreadsheetId === spreadsheetId && workbook.gid === sheet.getSheetId();
  })[0];
  if (!workbookKey) return;
  const config = adjustmentSyncConfig_();
  if (event.range.getLastRow() <= config.headerRow) return;
  const queued = [];
  const lock = LockService.getScriptLock();
  lock.waitLock(300000);
  try {
    adjustmentResolveRoutesForSheet_(sheet, workbookKey, config.headerRow).forEach(function (route) {
      const editFirst = event.range.getColumn();
      const editLast = event.range.getLastColumn();
      if (editLast < route.start || editFirst > route.start + route.width - 1) return;
      validateAdjustmentRoute_(sheet, route, config.headerRow);
      const editedSourceSlots = adjustmentEditedSourceSlots_(route, editFirst, editLast);
      const firstRow = Math.max(event.range.getRow(), config.headerRow + 1);
      for (let row = firstRow; row <= event.range.getLastRow(); row += 1) {
        const entry = queueAdjustmentInboundRow_(sheet, route, row, editedSourceSlots);
        if (entry) queued.push(entry);
      }
    });
  } finally {
    lock.releaseLock();
  }
  queued.forEach(deliverQueuedAdjustmentInbound_);
}

function adjustmentEditedSourceSlots_(route, editFirst, editLast) {
  if (route.layout === 'standard') return ['primary'];
  const intersectsOffset = function (offset) {
    const column = route.start + offset;
    return editFirst <= column && editLast >= column;
  };
  if (intersectsOffset(0) || intersectsOffset(1) || intersectsOffset(8)) {
    return ['first_half', 'second_half'];
  }
  const slots = [];
  if (intersectsOffset(2) || intersectsOffset(3) || intersectsOffset(6)) slots.push('first_half');
  if (intersectsOffset(4) || intersectsOffset(5) || intersectsOffset(7)) slots.push('second_half');
  return slots;
}

/** Allocate metadata revision and persist the durable queue under ScriptLock. */
function queueAdjustmentInboundRow_(sheet, route, row, editedSourceSlots) {
  const values = sheet.getRange(row, route.start, 1, route.width).getValues()[0];
  const display = sheet.getRange(row, route.start, 1, route.width).getDisplayValues()[0];
  if (!String(display[0] || '').trim() && !String(display[1] || '').trim()) return null;
  const parsedRows = adjustmentInboundRows_(route, values, display, editedSourceSlots);
  const metadataRange = sheet.getRange(row, route.metadataStart, 1, route.metadataWidth);
  const metadata = metadataRange.getDisplayValues()[0];
  const nextMetadata = metadata.slice();
  while (nextMetadata.length < route.metadataWidth) nextMetadata.push('');
  const inboundRows = parsedRows.map(function (parsed) {
    const slotMetadata = adjustmentSlotMetadata_(route, parsed.sourceSlot);
    const existingExternal = String(metadata[slotMetadata.offset] || '').trim();
    const existingRevision = String(metadata[slotMetadata.offset + 2] || '').trim();
    const existingRevisionNumber = Number(existingRevision || 0);
    const externalId = existingExternal
      ? adjustmentUuid_(existingExternal, 'external_id')
      : Utilities.getUuid();
    if (existingRevision && (
      !/^\d+$/.test(existingRevision) ||
      !Number.isSafeInteger(existingRevisionNumber) ||
      existingRevisionNumber < 1
    )) {
      throw new Error('fatal:invalid_existing_revision');
    }
    // Google and the admin UI can edit from the same base revision before either
    // side observes the other. Epoch-backed revisions keep a Google edit from
    // colliding with the admin's sequential base+1 revision.
    const revision = Math.max(Math.max(existingRevisionNumber, 0) + 1, Date.now());
    nextMetadata[slotMetadata.offset] = externalId;
    nextMetadata[slotMetadata.offset + 1] = 'google';
    nextMetadata[slotMetadata.offset + 2] = revision;
    return {
      external_id: externalId, origin: 'google', revision: revision,
      source_slot: parsed.sourceSlot,
      event_date: parsed.eventDate, signed_amount: parsed.amount, currency: route.currency,
      employee_no: parsed.employeeNo, employee_name: parsed.name,
      category: parsed.category || '', note: parsed.note, google_row: row,
    };
  });
  const requestId = Utilities.getUuid();
  const payload = {
    action: 'inbound', request_id: requestId, source_key: route.sourceKey,
    rows: inboundRows,
  };
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = ADJUSTMENT_QUEUE_PREFIX + requestId;
  // Keep retry state beside the durable payload. A persistent validation or
  // employee-directory problem must not generate one Supabase request a minute.
  properties.setProperty(propertyKey, JSON.stringify({
    payload: payload, attempt: 0, retry_at: 0, last_error: '',
  }));
  try {
    metadataRange.setValues([nextMetadata]);
  } catch (error) {
    properties.deleteProperty(propertyKey);
    throw error;
  }
  return { propertyKey: propertyKey, requestId: requestId, payload: payload };
}

function deliverQueuedAdjustmentInbound_(entry) {
  const properties = PropertiesService.getScriptProperties();
  try {
    adjustmentFetch_(entry.payload);
    properties.deleteProperty(entry.propertyKey);
  } catch (error) {
    scheduleAdjustmentInboundRetry_(
      properties, entry.propertyKey, entry.payload, entry.retryState || null, error
    );
    console.warn(JSON.stringify({
      status: 'inbound_queued', request_id: entry.requestId, error: adjustmentSafeError_(error),
    }));
  }
}

function adjustmentInboundRows_(route, values, display, editedSourceSlots) {
  const name = String(display[0] || '').trim();
  const employeeNo = String(display[1] || '').trim();
  const dateCell = values[route.layout === 'philippines'
    ? 8
    : route.hasCategory === false ? 5 : 6];
  const eventDate = adjustmentDate_(dateCell).key;
  if (eventDate.slice(0, 7) !== route.month) throw new Error('日期不属于当前月份块。');
  if (!name || !employeeNo) throw new Error('姓名、ID 和日期都是必填项。');
  if (route.layout === 'standard') {
    const bonus = adjustmentNumber_(display[2]);
    const deduction = adjustmentNumber_(display[3]);
    if ((bonus !== 0 && deduction !== 0) || (bonus === 0 && deduction === 0)) {
      throw new Error('奖金与扣除必须且只能填写一个。');
    }
    const category = route.hasCategory === false
      ? (bonus !== 0 ? '奖金' : '扣款')
      : String(display[4] || '').trim();
    const note = String(display[route.hasCategory === false ? 4 : 5] || '').trim();
    if (route.hasCategory !== false && !category) throw new Error('类型是必填项。');
    if (!note) throw new Error('备注是必填项。');
    return [{
      name: name, employeeNo: employeeNo, eventDate: eventDate,
      amount: bonus !== 0 ? Math.abs(bonus) : -Math.abs(deduction),
      category: category, note: note, sourceSlot: 'primary',
    }];
  }

  const requested = Array.isArray(editedSourceSlots) && editedSourceSlots.length
    ? editedSourceSlots
    : ['first_half', 'second_half'];
  const definitions = [
    { sourceSlot: 'first_half', amountIndex: 2, categoryIndex: 3, noteIndex: 6, label: '1-15' },
    { sourceSlot: 'second_half', amountIndex: 4, categoryIndex: 5, noteIndex: 7, label: '16-末' },
  ].filter(function (definition) { return requested.indexOf(definition.sourceSlot) >= 0; });
  const rows = [];
  definitions.forEach(function (definition) {
    const amount = adjustmentNumber_(display[definition.amountIndex]);
    const category = String(display[definition.categoryIndex] || '').trim();
    const note = String(display[definition.noteIndex] || '').trim();
    if (amount === 0 && (category || note)) {
      throw new Error(definition.label + ' 有类型/备注但金额为空或 0。');
    }
    if (amount === 0) return;
    if (!category) throw new Error(definition.label + ' 金额对应的类型是必填项。');
    if (!note) throw new Error(definition.label + ' 金额对应的备注是必填项。');
    rows.push({
      name: name, employeeNo: employeeNo, eventDate: eventDate,
      amount: amount, category: category, note: note, sourceSlot: definition.sourceSlot,
    });
  });
  if (!rows.length) throw new Error('所编辑期间的金额不能清空或设为 0。');
  return rows;
}

function retryAdjustmentInbound_() {
  const properties = PropertiesService.getScriptProperties();
  const queued = properties.getProperties();
  Object.keys(queued).filter(function (key) { return key.indexOf(ADJUSTMENT_QUEUE_PREFIX) === 0; })
    .slice(0, 25).forEach(function (key) {
      let stored;
      try {
        stored = JSON.parse(queued[key]);
        // Backward-compatible with payload-only queue entries from v1.
        const retryState = stored && stored.payload
          ? stored
          : { payload: stored, attempt: 0, retry_at: 0, last_error: '' };
        if (Number(retryState.retry_at || 0) > Date.now()) return;
        const payload = retryState.payload;
        adjustmentFetch_(payload);
        properties.deleteProperty(key);
      } catch (error) {
        const retryState = stored && stored.payload
          ? stored
          : { payload: stored, attempt: 0, retry_at: 0, last_error: '' };
        if (retryState.payload) {
          scheduleAdjustmentInboundRetry_(properties, key, retryState.payload, retryState, error);
        }
        console.warn(JSON.stringify({ status: 'inbound_retry_pending', key: key, error: adjustmentSafeError_(error) }));
      }
    });
}

/**
 * Operator recovery for queue entries whose source-slot identity was repaired
 * and independently verified against the live Google sheets. This deliberately
 * ignores transient errors and entries that have not exhausted all retries.
 */
function clearTerminalAdjustmentInboundRetries() {
  const properties = PropertiesService.getScriptProperties();
  const queued = properties.getProperties();
  let removed = 0;
  Object.keys(queued).forEach(function (key) {
    if (key.indexOf(ADJUSTMENT_QUEUE_PREFIX) !== 0) return;
    let stored;
    try {
      stored = JSON.parse(queued[key]);
    } catch (_error) {
      return;
    }
    if (Number(stored && stored.attempt || 0) < 8 ||
        String(stored && stored.last_error || '')
          .indexOf('google_source_slot_identity_conflict') < 0) return;
    properties.deleteProperty(key);
    removed += 1;
  });
  console.log(JSON.stringify({
    status: 'terminal_adjustment_retries_cleared', removed: removed,
  }));
  return removed;
}

function scheduleAdjustmentInboundRetry_(properties, propertyKey, payload, previousState, error) {
  const previousAttempt = Number(previousState && previousState.attempt || 0);
  const attempt = Math.min(Math.max(previousAttempt, 0) + 1, 8);
  const delaySeconds = Math.min(60 * Math.pow(2, attempt - 1), 3600);
  properties.setProperty(propertyKey, JSON.stringify({
    payload: payload,
    attempt: attempt,
    retry_at: Date.now() + delaySeconds * 1000,
    last_error: adjustmentSafeError_(error),
  }));
}

function adjustmentFetch_(payload) {
  const config = adjustmentSyncConfig_();
  if (!config.url || !config.token) throw new Error('同步脚本属性不完整。');
  const response = UrlFetchApp.fetch(config.url, {
    method: 'post', contentType: 'application/json',
    headers: { 'X-Adjustment-Sync-Token': config.token },
    payload: JSON.stringify(payload), muteHttpExceptions: true, followRedirects: false,
  });
  let result = null;
  try { result = JSON.parse(response.getContentText()); } catch (_error) {}
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result || result.ok !== true) {
    throw new Error('sync_http_' + response.getResponseCode() + ':' + String(result && result.error || 'unknown'));
  }
  return result;
}

function adjustmentNumber_(value) {
  const normalized = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!normalized) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error('金额格式无效。');
  return Math.round(amount * 100) / 100;
}

function adjustmentDate_(value) {
  let date = value instanceof Date ? value : new Date(String(value || '').trim());
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('日期格式无效。');
  const key = Utilities.formatDate(date, 'Asia/Manila', 'yyyy-MM-dd');
  return { date: date, key: key };
}

function adjustmentUuid_(value, field) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error('fatal:invalid_' + field);
  }
  return normalized;
}

function adjustmentFatalError_(error) {
  return String(error && error.message || error || '').indexOf('fatal:') === 0;
}

function adjustmentSafeError_(error) {
  return String(error && error.message || error || 'sync_failed').replace(/[\r\n]+/g, ' ').slice(0, 300);
}
