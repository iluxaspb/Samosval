// Регрессия 1.7.20: тип смены (дневная/ночная) выбирается при открытии и
// фиксируется вместе с датой открытия — время закрытия на тип и дату не влияет.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const {linePeriod} = await import('../../../server/src/shift-archive.mjs');
const shiftsSource = readFileSync(join(here, '15-shifts.js'), 'utf8');

test('linePeriod: workShift фиксирует тип смены при открытии, независимо от времени закрытия', () => {
  const startedAt = Date.parse('2026-11-18T07:00:00Z'); // 10:00 МСК 18.11
  const closedAt01 = Date.parse('2026-11-19T22:00:00Z'); // 01:00 МСК 19.11
  const closedAfter2Days = Date.parse('2026-11-20T10:00:00Z'); // 13:00 МСК 20.11
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt, workShift:'night'}), {date:'2026-11-18', kind:'night'});
  assert.equal(closedAt01 > startedAt, true);
  assert.equal(closedAfter2Days - startedAt > 2 * 24 * 3600 * 1000, true);
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt, closedAt: closedAt01, workShift:'night'}), {date:'2026-11-18', kind:'night'}, 'закрытие в 01:00 не меняет тип');
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt, closedAt: closedAfter2Days, workShift:'night'}), {date:'2026-11-18', kind:'night'}, 'закрытие через 2 дня не меняет тип');
});

test('linePeriod: workShift day при закрытии ночью остаётся day', () => {
  const startedAt = Date.parse('2026-11-18T07:00:00Z'); // 10:00 МСК
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt, workShift:'day'}), {date:'2026-11-18', kind:'day'});
});

test('linePeriod: без workShift — старый фолбэк по часу открытия (совместимость)', () => {
  const dayStart = Date.parse('2026-11-18T07:00:00Z'); // 10:00 МСК
  const nightStart = Date.parse('2026-11-18T19:00:00Z'); // 22:00 МСК
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt: dayStart}), {date:'2026-11-18', kind:'day'});
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt: nightStart}), {date:'2026-11-18', kind:'night'});
});

test('15-shifts.js: NAS-старт передаёт workShift', () => {
  assert.match(shiftsSource, /nasBusinessCommand\('start','current',\{objectId:objId,workShift\}\)/, 'workShift уходит в nasBusinessCommand start');
});

test('15-shifts.js: ensureDay берёт дату и тип открытой смены, а не nowDateStr() и жёсткое day', () => {
  assert.match(shiftsSource, /ensureDay\(tabelV2Host\(\),\{objectId:objId,date:lineDateIso\(state\.shift\?\.startDate\|\|nowDateStr\(\)\),kind:state\.shift\?\.workShift\|\|'day'\}\)/, 'дата и тип из state.shift');
  assert.doesNotMatch(shiftsSource, /ensureDay\([^)]*kind:'day'/, 'жёсткое kind:\'day\' больше не используется');
});
