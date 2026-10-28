// New timesheet domain. No imports from, or writes into, the existing plugin.
export const SCHEMA_VERSION = 1;
const copy = value => structuredClone(value);
const fail = message => { throw new Error(message); };
export function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label}: не заполнено`);
  return value;
}
export function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) fail('Неверная дата');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('Неверная дата');
  return value;
}
// Adapt the Line calendar string without timezone conversion or guessing today.
export function lineCalendarDate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  return calendarDate(ru ? `${ru[3]}-${ru[2].padStart(2, '0')}-${ru[1].padStart(2, '0')}` : text);
}
export function shiftKey(objectId, date, kind) {
  required(objectId, 'Объект'); calendarDate(date);
  if (!['day', 'night'].includes(kind)) fail('Выберите дневную или ночную смену');
  return JSON.stringify([objectId, date, kind]);
}
export function quantity(value) {
  if (typeof value !== 'number' && typeof value !== 'string') fail('Введите число');
  const raw = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) fail('Введите неотрицательное число, до трёх знаков после запятой');
  const units = Math.round(Number(raw) * 1000);
  if (!Number.isSafeInteger(units)) fail('Слишком большое число');
  return units / 1000;
}
export function equipmentRows(equipment) {
  required(equipment.id, 'ID техники');
  required(equipment.name, 'Название техники');
  if (!['owned', 'hired'].includes(equipment.ownership)) fail('Выберите собственную или наёмную технику');
  const row = (field, name) => ({ id: `${equipment.id}:${field}`, equipmentId: equipment.id, field, name });
  const rows = [row('machineHours', equipment.name)];
  if (equipment.ownership === 'hired') return rows;
  const labels = { mill: 'Машинисты фрезы', tractor: 'Тракторист', water: 'Водитель поливомойки' };
  rows.push(row('crewHours', labels[equipment.kind] || 'Машинисты / водители'));
  if (equipment.kind === 'water' && equipment.pumpEnabled) rows.push(row('pumpHours', 'Помпа'));
  return rows;
}
export function createShift({ objectId, date, kind, startDate, settings, existing = [] }) {
  const key = shiftKey(objectId, date, kind);
  if (date < calendarDate(startDate)) fail('Дата раньше начала объекта');
  const found = existing.find(item => item.key === key);
  if (found) return copy(found);
  return {
    schemaVersion: SCHEMA_VERSION, key, objectId, date, kind, closed: false,
    settings: copy(settings), hours: {}, workActual: {}, materials: {}, sourceImports: {},
    revision: 0,
  };
}
export function setHours(shift, equipmentId, field, value) {
  const equipment = (shift.settings.equipment || []).find(item => item.id === equipmentId);
  if (!equipment || !equipmentRows(equipment).some(row => row.field === field)) fail('Нет такой строки техники');
  const next = copy(shift);
  // Crew hours are an anonymous total; no 24-hour cap or allocation to people.
  const parsed = value === '' || value === null ? null : quantity(value);
  next.hours[equipmentId] = { ...next.hours[equipmentId], [field]: parsed };
  return next;
}
export function setWorkActual(shift, workId, value) {
  if (!(shift.settings.works || []).some(work => work.id === workId)) fail('Нет такого вида работ');
  const next = copy(shift);
  next.workActual[workId] = value === '' || value === null ? null : quantity(value);
  return next;
}
export function workProgress(work, shifts, objectId) {
  let units = 0, entries = 0;
  for (const shift of shifts) {
    if (shift.objectId !== objectId || shift.workActual[work.id] == null) continue;
    units += Math.round(quantity(shift.workActual[work.id]) * 1000); entries++;
  }
  const plan = quantity(work.plan);
  return { plan, actual: entries ? units / 1000 : null, remaining: (Math.round(plan * 1000) - units) / 1000 };
}
export function rankChoices(items, query = '', usage = {}) {
  const normalize = text => String(text || '').toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return items.filter(item => {
    const text = normalize([item.name, item.firstName, item.lastName, item.model, item.number].join(' '));
    return terms.every(term => text.includes(term));
  }).slice().sort((a, b) =>
    (usage[b.id]?.count || 0) - (usage[a.id]?.count || 0) ||
    (usage[b.id]?.lastSelected || 0) - (usage[a.id]?.lastSelected || 0) ||
    normalize(a.name).localeCompare(normalize(b.name), 'ru') || a.id.localeCompare(b.id));
}

// Input is a validated, complete snapshot of one CLOSED Line shift.
// Missing metadata is rejected: never silently assign historical trips to today's destination.
export function aggregateMaterials(source) {
  required(source.id, 'ID смены Линии');
  shiftKey(source.objectId, source.date, source.kind);
  if (!Number.isSafeInteger(source.revision) || source.revision < 1) fail('Нет версии исходной смены');
  if (source.closed !== true || source.complete !== true) fail('Нужен полный снимок закрытой смены');
  if (!Array.isArray(source.trips)) fail('Нет списка рейсов');
  const seen = new Set(), totals = {};
  for (const trip of source.trips) {
    required(trip.id, 'ID рейса');
    if (seen.has(trip.id)) fail('Повторный ID рейса в исходном снимке');
    seen.add(trip.id);
    if (trip.isGAI || trip.cancelled) continue;
    required(trip.materialId, 'Материал рейса'); required(trip.destinationId, 'Направление рейса');
    const key = JSON.stringify([trip.materialId, trip.destinationId]);
    const amount = Math.round(quantity(trip.volume) * 1000);
    totals[key] = (totals[key] || 0) + amount;
    if (!Number.isSafeInteger(totals[key])) fail('Слишком большой суммарный объём');
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => a.localeCompare(b)).map(([key, units]) => [key, units / 1000]));
}
export function planMaterialImport(shift, source) {
  const totals = aggregateMaterials(source);
  if (shift.key !== shiftKey(source.objectId, source.date, source.kind)) fail('Не совпадают объект, дата или смена');
  const previous = shift.sourceImports[source.id];
  const fingerprint = JSON.stringify(totals);
  if (previous && source.revision < previous.revision) return { status: 'stale', shift: copy(shift), conflicts: [] };
  if (previous && source.revision === previous.revision) {
    if (previous.fingerprint !== fingerprint) fail('Одна версия источника содержит разные объёмы');
    return { status: 'unchanged', shift: copy(shift), conflicts: [] };
  }
  const next = copy(shift), conflicts = [];
  const keys = new Set([...Object.keys(totals), ...Object.keys(previous?.totals || {})]);
  for (const key of keys) {
    const cell = next.materials[key];
    const incoming = Object.hasOwn(totals, key) ? totals[key] : null;
    if (cell && (cell.origin !== 'line' || cell.sourceId !== source.id)) {
      conflicts.push({ key, current: copy(cell), proposed: incoming, sourceId: source.id, sourceRevision: source.revision });
      continue;
    }
    if (incoming === null) delete next.materials[key];
    else next.materials[key] = { value: incoming, origin: 'line', sourceId: source.id, sourceRevision: source.revision };
  }
  // Atomic proposal: on ANY conflict, caller keeps the original and both versions.
  // No acknowledgement until an explicit, permission-checked resolution is committed.
  if (conflicts.length) return { status: 'conflict', shift: copy(shift), proposedShift: next, conflicts, source: copy(source) };
  next.sourceImports[source.id] = { revision: source.revision, fingerprint, totals };
  return { status: 'ready', shift: next, conflicts: [] };
}

// Join aliases before counting: a truck selected by plate and arriving by ID is one unit.
export function countEquipment(equipment, arrivals, registry = []) {
  const parent = new Map();
  const root = key => { if (!parent.has(key)) parent.set(key, key); if (parent.get(key) !== key) parent.set(key, root(parent.get(key))); return parent.get(key); };
  const plate = raw => String(raw || '').toUpperCase().replace(/[\s-]/g, '').replace(/[ABCEHKMOPTXY]/g, c => ({A:'А',B:'В',C:'С',E:'Е',H:'Н',K:'К',M:'М',O:'О',P:'Р',T:'Т',X:'Х',Y:'У'}[c]));
  const aliases = item => [item.id && `id:${item.id}`, item.number && `plate:${plate(item.number)}`].filter(Boolean);
  for (const item of [...registry, ...equipment, ...arrivals]) {
    const keys = aliases(item); for (const key of keys.slice(1)) parent.set(root(key), root(keys[0]));
  }
  const excluded = new Set([...registry, ...equipment, ...arrivals].filter(item => item.isGAI).flatMap(aliases).map(root));
  const selected = equipment.filter(item => !['crew', 'driver', 'pump'].includes(item.kind));
  selected.push(...arrivals.filter(item => item.arrived === true));
  const ids = new Set();
  for (const item of selected) {
    const keys = aliases(item);
    if (!keys.length) fail('У техники нет ID или номера');
    const key = root(keys[0]); if (!excluded.has(key)) ids.add(key);
  }
  return ids.size;
}
