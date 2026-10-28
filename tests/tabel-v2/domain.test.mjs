import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, shiftKey, createShift, equipmentRows, setHours, setWorkActual, workProgress, rankChoices, aggregateMaterials, planMaterialImport, countEquipment } from '../../test-app/tabel-v2/domain.mjs';
import { can, canEdit } from '../../test-app/tabel-v2/permissions.mjs';

const settings = { equipment: [{ id: 'mill', name: 'Фреза', kind: 'mill', ownership: 'owned' }], works: [{ id: 'road', name: 'Фрезерование ПЧ 5 см', unit: 'м²', plan: 10000 }], materialId: 'crumb', destinations: ['plant', 'cone'] };
const makeShift = (patch = {}) => createShift({ objectId: 'site', date: '2026-10-28', kind: 'night', startDate: '2026-10-20', settings, ...patch });
const source = (patch = {}) => ({ id: 'line-28', revision: 1, objectId: 'site', date: '2026-10-28', kind: 'night', closed: true, complete: true, trips: [{ id: 'a', materialId: 'crumb', destinationId: 'plant', volume: 300 }], ...patch });
const key = JSON.stringify(['crumb', 'plant']);

test('52 anonymous crew hours are editable independently of machine hours', () => {
  const shift = makeShift(), next = setHours(setHours(shift, 'mill', 'machineHours', 12), 'mill', 'crewHours', 52);
  assert.deepEqual(next.hours.mill, { machineHours: 12, crewHours: 52 });
  assert.deepEqual(shift.hours, {});
  assert.equal(setHours(next, 'mill', 'crewHours', '26,5').hours.mill.crewHours, 26.5);
  assert.throws(() => setHours(shift, 'mill', 'crewHours', -1));
});
test('owned, hired and optional pump have distinct valid rows', () => {
  const water = { id: 'water', name: 'Поливомойка', ownership: 'owned', kind: 'water', pumpEnabled: true };
  assert.equal(equipmentRows(water).length, 3);
  assert.equal(equipmentRows({ ...water, pumpEnabled: false }).length, 2);
  assert.equal(equipmentRows({ ...water, ownership: 'hired' }).length, 1);
  assert.throws(() => setHours(makeShift(), 'mill', 'pumpHours', 5));
});
test('new shift copies settings without copying fact or mutating the prior shift', () => {
  const old = setHours(makeShift(), 'mill', 'crewHours', 52);
  const next = makeShift({ date: '2026-10-29', settings: old.settings });
  next.settings.materialId = 'sand';
  assert.equal(old.settings.materialId, 'crumb');
  assert.deepEqual(next.hours, {}); assert.deepEqual(next.materials, {});
});
test('existing shift is returned without destroying fact; day/night are distinct', () => {
  const old = setHours(makeShift(), 'mill', 'crewHours', 52);
  assert.deepEqual(makeShift({ existing: [old] }), old);
  assert.notEqual(makeShift({ kind: 'day' }).key, old.key);
  assert.throws(() => makeShift({ date: '2026-10-19' }));
  assert.deepEqual(makeShift({ date: '2026-10-30' }).hours, {});
});
test('invalid calendar dates and shift types rejected; leap day valid', () => {
  assert.throws(() => calendarDate('2026-02-29'));
  assert.throws(() => calendarDate('2026-13-01'));
  assert.equal(calendarDate('2024-02-29'), '2024-02-29');
  assert.throws(() => shiftKey('site', '2026-10-28', 'other'));
});
test('work actual accumulates only this object, preserves plan and empty-vs-zero', () => {
  const a = setWorkActual(makeShift(), 'road', 1200);
  const b = setWorkActual(makeShift({ date: '2026-10-29' }), 'road', 800);
  const other = setWorkActual(makeShift({ objectId: 'other' }), 'road', 9000);
  assert.deepEqual(workProgress(settings.works[0], [a,b,other], 'site'), { plan: 10000, actual: 2000, remaining: 8000 });
  assert.equal(a.settings.works[0].plan, 10000);
  assert.equal(workProgress(settings.works[0], [makeShift()], 'site').actual, null);
  assert.equal(workProgress(settings.works[0], [setWorkActual(makeShift(), 'road', 0)], 'site').actual, 0);
});
test('search by partial name/model/number, frequency then recency, original list intact', () => {
  const list = [{ id: 'a', name: 'Фреза', model: 'W205', number: 'А123' }, { id: 'b', name: 'Трактор' }, { id: 'c', name: 'Фёдоров Иван' }];
  const usage = { a: { count: 3, lastSelected: 2 }, b: { count: 3, lastSelected: 4 } };
  assert.deepEqual(rankChoices(list, '', usage).map(x => x.id), ['b','a','c']);
  assert.equal(rankChoices(list, 'федор')[0].id, 'c');
  assert.equal(rankChoices(list, 'w20 а12')[0].id, 'a');
  assert.deepEqual(list.map(x => x.id), ['a','b','c']);
});
test('materials grouped by material and destination with decimal precision', () => {
  const trips = [{ id: 'a', materialId: 'crumb', destinationId: 'plant', volume: '0,1' }, { id: 'b', materialId: 'crumb', destinationId: 'plant', volume: 0.2 }, { id: 'c', materialId: 'crumb', destinationId: 'cone', volume: 200 }, { id: 'gai', isGAI: true }, { id: 'cancel', cancelled: true }];
  const total = aggregateMaterials(source({ trips }));
  assert.equal(total[key], 0.3); assert.equal(total[JSON.stringify(['crumb','cone'])], 200);
});
test('missing directions, duplicate trips or incomplete snapshots never silently import', () => {
  assert.throws(() => aggregateMaterials(source({ complete: false })));
  assert.throws(() => aggregateMaterials(source({ closed: false })));
  assert.throws(() => aggregateMaterials(source({ trips: [{ id: 'a', volume: 300 }] })));
  assert.throws(() => aggregateMaterials(source({ trips: [...source().trips, ...source().trips] })));
});
test('repeat closing 300 then 320 replaces instead of adding to 620', () => {
  const first = planMaterialImport(makeShift(), source());
  assert.equal(first.status, 'ready'); assert.equal(first.shift.materials[key].value, 300);
  const nextSource = source({ revision: 2, trips: [{ ...source().trips[0], volume: 320 }] });
  const next = planMaterialImport(first.shift, nextSource);
  assert.equal(next.shift.materials[key].value, 320);
  assert.equal(planMaterialImport(next.shift, nextSource).status, 'unchanged');
  assert.equal(planMaterialImport(next.shift, source()).status, 'stale');
});
test('changed data with the same source revision is rejected', () => {
  const first = planMaterialImport(makeShift(), source()).shift;
  assert.throws(() => planMaterialImport(first, source({ trips: [{ ...source().trips[0], volume: 320 }] })));
});
test('deleted or redirected source contribution is removed rather than left in totals', () => {
  const first = planMaterialImport(makeShift(), source()).shift;
  const next = planMaterialImport(first, source({ revision: 2, trips: [{ ...source().trips[0], destinationId: 'cone' }] })).shift;
  assert.equal(next.materials[key], undefined);
  assert.equal(next.materials[JSON.stringify(['crumb', 'cone'])].value, 300);
});
test('manual edits produce an atomic conflict with both values; original unchanged', () => {
  const first = planMaterialImport(makeShift(), source()).shift;
  first.materials[key] = { value: 310, origin: 'manual', author: 'operator' };
  const result = planMaterialImport(first, source({ revision: 2, trips: [{ ...source().trips[0], volume: 320 }] }));
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.shift, first); assert.equal(first.sourceImports['line-28'].revision, 1);
  assert.equal(result.conflicts[0].current.value, 310); assert.equal(result.conflicts[0].proposed, 320);
});
test('cross-object/day/night import is rejected', () => {
  for (const patch of [{objectId:'other'}, {date:'2026-10-29'}, {kind:'day'}]) {
    assert.throws(() => planMaterialImport(makeShift(), source(patch)));
  }
});
test('equipment count includes departed arrivals without loads; excludes GAI and pump/crew', () => {
  const equipment = [{ id:'mill' }, { id:'tractor' }, { id:'water' }, { id:'bus' }, {id:'crew',kind:'crew'}, {id:'pump',kind:'pump'}];
  const arrivals = Array.from({length:7}, (_,i) => ({id:`truck-${i}`,arrived:true,onLine:false,loads:0}));
  assert.equal(countEquipment(equipment, [...arrivals, ...arrivals, {id:'gai',isGAI:true,arrived:true}]), 11);
});
test('truck ID and normalized plate aliases count only once across sources', () => {
  assert.equal(countEquipment([{number:'A 123 BC-78'}], [{id:'truck',arrived:true}], [{id:'truck',number:'А123ВС78'}]), 1);
  assert.equal(countEquipment([{number:'А123ВС78'}], [{id:'truck',arrived:true}], [{id:'truck',number:'А123ВС78',isGAI:true}]), 0);
});
const operator = { loaded:true, status:'active', uid:'user', role:'master', objectIds:['site'], actions:['tabel_v2_table_view','tabel_v2_table_edit'] };
test('permissions default deny, object scope and explicit denial override role grants', () => {
  assert.equal(can(operator, 'tabel_v2_table_edit', 'site'), true);
  assert.equal(can(operator, 'tabel_v2_table_edit', 'other'), false);
  assert.equal(can({...operator,overrides:{tabel_v2_table_edit:false}}, 'tabel_v2_table_edit', 'site'), false);
  assert.equal(can({...operator,loaded:false}, 'tabel_v2_table_edit', 'site'), false);
  assert.equal(can({...operator,status:'blocked'}, 'tabel_v2_table_edit', 'site'), false);
  assert.equal(can({...operator,role:'admin'}, 'invented_permission', 'site'), false);
});
test('past and closed changes require additional grants, view alone never writes', () => {
  const shift = makeShift();
  assert.equal(canEdit(operator, 'table', shift, '2026-10-28'), true);
  assert.equal(canEdit(operator, 'table', shift, '2026-10-29'), false);
  assert.equal(canEdit(operator, 'table', {...shift,closed:true}, '2026-10-28'), false);
  assert.equal(canEdit({...operator,actions:['tabel_v2_table_view']}, 'table', shift, '2026-10-28'), false);
  assert.equal(canEdit({...operator,actions:[...operator.actions,'tabel_v2_past_edit','tabel_v2_closed_edit']}, 'table', {...shift,closed:true}, '2026-10-29'), true);
});
