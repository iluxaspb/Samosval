// Derived data attribution for parallel shifts (design §4.6, §8, §10.2).
//
// Every derived row names its shift explicitly: there is no join by
// object/day/type anywhere in this module, and no field is ever inferred from a
// display key, a sheet name or a neighbour row. A record is counted once per
// `(workspaceId, shiftId, sourceRecordId)`; day and night are aggregated
// separately and only then summed. A completed detached trip counts once in its
// source shift and never in the destination. No DOM, no network.
const fail = code => {
  const error = new Error(code);
  error.code = code;
  return error;
};
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const calendarDate = value =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T12:00:00Z')) &&
  new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
const round = value => Math.round(value * 1000) / 1000;
const volumeOf = row => {
  if (row.volume === undefined) return 0;
  if (typeof row.volume !== 'number' || !Number.isFinite(row.volume) || row.volume < 0)
    throw fail('invalid-volume');
  return row.volume;
};

// Requires the explicit pair; the returned copy is otherwise byte-identical.
export function attributeRow(row) {
  if (!plain(row)) throw fail('invalid-row');
  if (!id(row.shiftId) || !id(row.sourceShiftId)) throw fail('missing-shift-attribution');
  return { ...row };
}

// The design key. The same record in two sheets of one shift is one record; the
// same source record in two shifts is two records, because shifts never merge.
export function dedupeRows(rows) {
  if (!Array.isArray(rows)) throw fail('invalid-rows');
  const seen = new Set();
  const kept = [];
  for (const input of rows) {
    const row = attributeRow(input);
    if (!id(row.workspaceId)) throw fail('missing-workspace');
    if (typeof row.sourceRecordId !== 'string' || !row.sourceRecordId)
      throw fail('missing-source-record');
    const key = JSON.stringify([row.workspaceId, row.shiftId, row.sourceRecordId]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  return kept;
}

// Display key only: `object/day:<date>:<day|night>`. Two shifts may share it
// (that is why the identity below is shiftId), and it is never used as a join.
export function sheetKey({ objectId, workDate, shiftType } = {}) {
  if (!id(objectId) || !calendarDate(workDate) || !['day', 'night'].includes(shiftType))
    throw fail('invalid-sheet-key');
  return `${objectId}/day:${workDate}:${shiftType}`;
}

// Day and night are summed separately and only then added up. The input is
// deduped first, so a caller cannot double count by passing the same record from
// two sheets. A row without a shift is an error, never a common pot.
export function aggregateByShift(rows) {
  const unique = dedupeRows(rows);
  const byShift = {};
  const byType = {
    day: { records: 0, volume: 0, shifts: [] },
    night: { records: 0, volume: 0, shifts: [] },
  };
  for (const row of unique) {
    const key = sheetKey(row);
    const volume = volumeOf(row);
    const entry = byShift[row.shiftId] ?? {
      shiftId: row.shiftId,
      sheetKey: key,
      objectId: row.objectId,
      workDate: row.workDate,
      shiftType: row.shiftType,
      records: 0,
      volume: 0,
    };
    entry.records += 1;
    entry.volume = round(entry.volume + volume);
    byShift[row.shiftId] = entry;
    const type = byType[row.shiftType];
    type.records += 1;
    type.volume = round(type.volume + volume);
    if (!type.shifts.includes(row.shiftId)) type.shifts.push(row.shiftId);
  }
  for (const type of Object.values(byType)) type.shifts.sort();
  const ordered = {};
  for (const shiftId of Object.keys(byShift).sort()) ordered[shiftId] = byShift[shiftId];
  return {
    byShift: ordered,
    byType,
    total: {
      records: byType.day.records + byType.night.records,
      volume: round(byType.day.volume + byType.night.volume),
    },
  };
}

// `completed` is exactly one trip in the source shift; `open`/`incomplete` is
// zero in both and explicitly marked unfinished. The destination never receives
// a detached trip, before or after completion.
export function detachedContribution(trip) {
  if (!plain(trip)) throw fail('invalid-detached-trip');
  if (!id(trip.sourceShiftId) || !id(trip.destinationShiftId))
    throw fail('missing-shift-attribution');
  if (trip.sourceShiftId === trip.destinationShiftId) throw fail('invalid-detached-trip');
  if (!['completed', 'open', 'incomplete'].includes(trip.state))
    throw fail('invalid-detached-state');
  const completed = trip.state === 'completed';
  const volume = completed ? volumeOf(trip) : 0;
  return {
    sourceShiftId: trip.sourceShiftId,
    destinationShiftId: trip.destinationShiftId,
    state: trip.state,
    trips: completed ? 1 : 0,
    volume,
    incomplete: !completed,
    byShift: {
      [trip.sourceShiftId]: { trips: completed ? 1 : 0, volume },
      [trip.destinationShiftId]: { trips: 0, volume: 0 },
    },
  };
}
