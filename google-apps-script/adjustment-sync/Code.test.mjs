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

test('uses the fixed non-overlapping metadata map', () => {
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

  assert.deepEqual(standard, [[28, 3], [31, 3], [34, 3], [37, 3]]);
  assert.deepEqual(philippines, [
    [32, 6, 32, 35],
    [38, 6, 38, 41],
    [44, 6, 44, 47],
    [50, 6, 50, 53],
  ]);
});

test('splits both Philippines amount slots into independent protocol rows', () => {
  const rows = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('home_ph', '2026-09'),
    ['Ana', 'PH-12', -25, 40, 'first reason', 'second reason', new Date('2026-09-20T12:00:00Z')],
    ['Ana', 'PH-12', '-25', '40', 'first reason', 'second reason', '2026-09-20']
  )`);

  assert.deepEqual(rows.map(({ sourceSlot, amount, note }) => ({ sourceSlot, amount, note })), [
    { sourceSlot: 'first_half', amount: -25, note: 'first reason' },
    { sourceSlot: 'second_half', amount: 40, note: 'second reason' },
  ]);
});

test('only increments the Philippines slot whose amount or note was edited', () => {
  const slots = evaluateJson(`(function () {
    var route = adjustmentRoute_('home_ph', '2026-09');
    return {
      shared: adjustmentEditedSourceSlots_(route, route.start, route.start),
      first: adjustmentEditedSourceSlots_(route, route.start + 2, route.start + 2),
      second: adjustmentEditedSourceSlots_(route, route.start + 5, route.start + 5)
    };
  })()`);
  assert.deepEqual(slots, {
    shared: ['first_half', 'second_half'],
    first: ['first_half'],
    second: ['second_half'],
  });

  const firstOnly = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('home_ph', '2026-09'),
    ['Ana', 'PH-12', -25, 40, 'first reason', 'second reason', new Date('2026-09-20T12:00:00Z')],
    ['Ana', 'PH-12', '-25', '40', 'first reason', 'second reason', '2026-09-20'],
    ['first_half']
  )`);
  assert.equal(firstOnly.length, 1);
  assert.equal(firstOnly[0].sourceSlot, 'first_half');
});

test('preserves a negative standard deduction in both directions', () => {
  const inbound = evaluateJson(`adjustmentInboundRows_(
    adjustmentRoute_('onsite', '2026-09'),
    ['Lee', 'A-1', '', -30, 'penalty', new Date('2026-09-09T12:00:00Z')],
    ['Lee', 'A-1', '', '-30', 'penalty', '2026-09-09']
  )`);
  assert.equal(inbound[0].amount, -30);

  const outbound = evaluateJson(`(function () {
    var route = adjustmentRoute_('onsite', '2026-09');
    var date = adjustmentDate_(new Date('2026-09-09T12:00:00Z'));
    var values = adjustmentOutboundValues_(route, {
      signed_amount: -30, employee_name: 'Lee', employee_no: 'A-1', note: 'penalty'
    }, date);
    return [values[2], values[3]];
  })()`);
  assert.deepEqual(outbound, ['', -30]);
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
