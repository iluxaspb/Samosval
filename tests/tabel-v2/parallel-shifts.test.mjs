import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateByShift,
  attributeRow,
  dedupeRows,
  detachedContribution,
  sheetKey,
} from '../../working-test/tabel-v2/shift-attribution.mjs';

// Derived data attribution (design §4.6, §8, §10.2, plan Task 27).
//
// The client never joins two shifts by object/day/type: every derived row names
// its shift explicitly, the deduplication key is the design triple
// `(workspaceId, shiftId, sourceRecordId)`, and a completed detached trip counts
// once in its source shift and never in the destination.

const row = overrides => ({
  workspaceId: 'workspace',
  shiftId: 'shift_a',
  sourceShiftId: 'shift_a',
  sourceRecordId: 'trip_1',
  objectId: 'site',
  workDate: '2026-11-23',
  shiftType: 'day',
  volume: 10,
  ...overrides,
});

const codeOf = fn => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

test('attributeRow requires explicit shift and source shift and copies without inventing', () => {
  for (const missing of [
    {shiftId: undefined},
    {sourceShiftId: undefined},
    {shiftId: ''},
    {sourceShiftId: 42},
  ]) {
    const input = row(missing);
    if (missing.shiftId === undefined) delete input.shiftId;
    if (missing.sourceShiftId === undefined) delete input.sourceShiftId;
    assert.equal(codeOf(() => attributeRow(input)), 'missing-shift-attribution');
  }
  assert.equal(codeOf(() => attributeRow(null)), 'invalid-row');
  assert.equal(codeOf(() => attributeRow(['shiftId'])), 'invalid-row');

  const source = row({note: 'kept as is'});
  const attributed = attributeRow(source);
  assert.notEqual(attributed, source, 'attributeRow returns a copy');
  assert.deepEqual(attributed, source, 'nothing is added or rewritten');
  assert.deepEqual(Object.keys(attributeRow({shiftId: 'shift_a', sourceShiftId: 'shift_a'})).sort(),
    ['shiftId', 'sourceShiftId']);
});

test('dedupeRows counts one record once per workspace, shift and source record', () => {
  const inTwoSheets = [row({sheetId: 'one'}), row({sheetId: 'two', volume: 99})];
  assert.equal(dedupeRows(inTwoSheets).length, 1, 'one shift sheet pair is one record');

  const inTwoShifts = [row(), row({shiftId: 'shift_b', sourceShiftId: 'shift_b'})];
  const kept = dedupeRows(inTwoShifts);
  assert.equal(kept.length, 2, 'different shifts never merge');
  assert.deepEqual(kept.map(item => item.shiftId).sort(), ['shift_a', 'shift_b']);

  assert.equal(dedupeRows([row({sourceRecordId: 'trip_1'}), row({sourceRecordId: 'trip_2'})]).length, 2);
  assert.equal(dedupeRows([row(), row({workspaceId: 'other'})]).length, 2, 'workspace scopes the key');

  const copies = dedupeRows([row()]);
  assert.notEqual(copies[0], inTwoShifts[0], 'dedupe returns attributed copies');
  assert.equal(codeOf(() => dedupeRows([row({sourceRecordId: undefined})])), 'missing-source-record');
  assert.equal(codeOf(() => dedupeRows([row({workspaceId: undefined})])), 'missing-workspace');
});

test('aggregateByShift keeps day and night apart, dedupes, and sums the total', () => {
  const rows = [
    row({shiftId: 'shift_a', sourceShiftId: 'shift_a', sourceRecordId: 'a1', volume: 10}),
    row({shiftId: 'shift_a', sourceShiftId: 'shift_a', sourceRecordId: 'a2', volume: 5}),
    row({shiftId: 'shift_a', sourceShiftId: 'shift_a', sourceRecordId: 'a1', volume: 10, sheetId: 'other'}),
    row({shiftId: 'shift_b', sourceShiftId: 'shift_b', sourceRecordId: 'b1', shiftType: 'night', volume: 7}),
    row({shiftId: 'shift_b', sourceShiftId: 'shift_b', sourceRecordId: 'b2', shiftType: 'night', volume: 3}),
  ];
  const summary = aggregateByShift(rows);
  assert.deepEqual(Object.keys(summary.byShift), ['shift_a', 'shift_b']);
  assert.deepEqual(summary.byShift.shift_a, {
    shiftId: 'shift_a', sheetKey: 'site/day:2026-11-23:day', objectId: 'site',
    workDate: '2026-11-23', shiftType: 'day', records: 2, volume: 15,
  });
  assert.deepEqual(summary.byType.day, {records: 2, volume: 15, shifts: ['shift_a']});
  assert.deepEqual(summary.byType.night, {records: 2, volume: 10, shifts: ['shift_b']});
  assert.deepEqual(summary.total, {records: 4, volume: 25});
  assert.equal(summary.total.records, summary.byType.day.records + summary.byType.night.records);
  assert.equal(summary.total.volume, summary.byType.day.volume + summary.byType.night.volume);

  const withoutShift = row();
  delete withoutShift.shiftId;
  assert.equal(codeOf(() => aggregateByShift([withoutShift])), 'missing-shift-attribution');
  assert.equal(codeOf(() => aggregateByShift([row({volume: -1})])), 'invalid-volume');
});

test('sheetKey separates day and night and the shift stays the aggregation identity', () => {
  assert.equal(sheetKey({objectId: 'site', workDate: '2026-11-23', shiftType: 'day'}),
    'site/day:2026-11-23:day');
  assert.equal(sheetKey({objectId: 'site', workDate: '2026-11-23', shiftType: 'night'}),
    'site/day:2026-11-23:night');
  assert.notEqual(
    sheetKey({objectId: 'site', workDate: '2026-11-23', shiftType: 'day'}),
    sheetKey({objectId: 'site', workDate: '2026-11-23', shiftType: 'night'}),
  );
  assert.equal(codeOf(() => sheetKey({objectId: 'site', workDate: '2026-02-30', shiftType: 'day'})),
    'invalid-sheet-key');
  assert.equal(codeOf(() => sheetKey({objectId: '', workDate: '2026-11-23', shiftType: 'day'})),
    'invalid-sheet-key');
  assert.equal(codeOf(() => sheetKey({objectId: 'site', workDate: '2026-11-23', shiftType: 'evening'})),
    'invalid-sheet-key');

  // Two shifts with an identical display key are still two lines: the only
  // identity is shiftId, so there is no object/date/type join in the module.
  const twins = [
    row({shiftId: 'shift_a', sourceShiftId: 'shift_a', sourceRecordId: 'a1'}),
    row({shiftId: 'shift_b', sourceShiftId: 'shift_b', sourceRecordId: 'b1'}),
  ];
  assert.equal(sheetKey(twins[0]), sheetKey(twins[1]));
  const summary = aggregateByShift(twins);
  assert.equal(Object.keys(summary.byShift).length, 2, 'identical display keys do not merge');
  assert.deepEqual(summary.byType.day.shifts, ['shift_a', 'shift_b']);
  assert.equal(summary.total.records, 2);
});

test('detachedContribution counts a completed trip once in the source shift only', () => {
  const completed = detachedContribution({
    sourceShiftId: 'shift_a', destinationShiftId: 'shift_b', state: 'completed', volume: 12,
  });
  assert.equal(completed.trips, 1);
  assert.equal(completed.volume, 12);
  assert.equal(completed.incomplete, false);
  assert.deepEqual(completed.byShift.shift_a, {trips: 1, volume: 12});
  assert.deepEqual(completed.byShift.shift_b, {trips: 0, volume: 0});

  for (const state of ['open', 'incomplete']) {
    const pending = detachedContribution({
      sourceShiftId: 'shift_a', destinationShiftId: 'shift_b', state, volume: 12,
    });
    assert.equal(pending.trips, 0);
    assert.equal(pending.volume, 0);
    assert.equal(pending.incomplete, true, 'an unfinished detached trip is not a trip');
    assert.deepEqual(pending.byShift.shift_a, {trips: 0, volume: 0});
    assert.deepEqual(pending.byShift.shift_b, {trips: 0, volume: 0});
  }

  assert.equal(codeOf(() => detachedContribution({
    sourceShiftId: 'shift_a', destinationShiftId: 'shift_b', state: 'lost',
  })), 'invalid-detached-state');
  assert.equal(codeOf(() => detachedContribution({
    sourceShiftId: 'shift_a', state: 'completed',
  })), 'missing-shift-attribution');
  assert.equal(codeOf(() => detachedContribution({
    sourceShiftId: 'shift_a', destinationShiftId: 'shift_a', state: 'completed',
  })), 'invalid-detached-trip');
  assert.equal(codeOf(() => detachedContribution(null)), 'invalid-detached-trip');
});
