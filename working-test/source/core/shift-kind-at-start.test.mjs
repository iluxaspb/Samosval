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

test('linePeriod: без workShift тип не выводится из часа открытия — ошибка unknown-shift-period', () => {
  const dayStart = Date.parse('2026-11-18T07:00:00Z'); // 10:00 МСК
  const nightStart = Date.parse('2026-11-18T19:00:00Z'); // 22:00 МСК
  for (const startedAt of [dayStart, nightStart]) {
    assert.throws(() => linePeriod({startDate:'18.11.2026', startedAt}), {code:'unknown-shift-period'}, 'час открытия не доказательство типа');
  }
  assert.throws(() => linePeriod({startDate:'18.11.2026', startedAt: dayStart, kind:'evening'}), {code:'unknown-shift-period'});
  assert.deepEqual(linePeriod({startDate:'18.11.2026', startedAt: dayStart, kind:'night'}), {date:'2026-11-18', kind:'night'}, 'доказанный kind остаётся доказательством');
});

test('15-shifts.js: NAS-старт передаёт workShift', () => {
  assert.match(shiftsSource, /nasBusinessCommand\('start','current',\{objectId:objId,workShift\}\)/, 'workShift уходит в nasBusinessCommand start');
});

test('15-shifts.js: ensureDay берёт дату и тип открытой смены, а не nowDateStr() и жёсткое day', () => {
  assert.match(shiftsSource, /ensureDay\(tabelV2Host\(\),\{objectId:objId,date:lineDateIso\(state\.shift\?\.startDate\|\|nowDateStr\(\)\),kind:state\.shift\?\.workShift\|\|'day'\}\)/, 'дата и тип из state.shift');
  assert.doesNotMatch(shiftsSource, /ensureDay\([^)]*kind:'day'/, 'жёсткое kind:\'day\' больше не используется');
});

test('15-shifts.js: обе двери открытия смены идут через requireWorkShiftChoice', () => {
  assert.match(shiftsSource, /startShiftFromBase\(id\)[^\n]*startShiftWithObject\(o\.name,\s*o\.id,\s*requireWorkShiftChoice\(\)\)/, 'startShiftFromBase требует выбора типа');
  assert.match(shiftsSource, /confirmStartShift\(\)[\s\S]{0,400}?requireWorkShiftChoice\(\)/, 'confirmStartShift требует выбора типа');
  assert.match(shiftsSource, /if\(!workShift\)\{appNotice\('Выберите тип смены: дневная или ночная'\);return;\}/, 'startShiftWithObject блокирует пустой тип');
});

test('shell.html + 15-shifts.js: выбранная кнопка типа смены явно подсвечена', () => {
  const shell = readFileSync(join(here, '..', 'shell.html'), 'utf8');
  assert.match(shell, /data-work-shift="day"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-work-shift="day"/, 'кнопка Дневная с aria-pressed');
  assert.match(shell, /data-work-shift="night"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-work-shift="night"/, 'кнопка Ночная с aria-pressed');
  assert.match(shiftsSource, /classList\.toggle\('ws-selected',on\)/, 'selectWorkShift переключает класс ws-selected');
  assert.match(shiftsSource, /setAttribute\('aria-pressed',on\?'true':'false'\)/, 'selectWorkShift переключает aria-pressed');
  const css = readFileSync(join(here, '..', 'styles', 'style-04.css'), 'utf8');
  assert.match(css, /\.btn-secondary\.ws-selected\s*\{\s*background:\s*var\(--success\)/, 'залитая зелёная подсветка выбранной кнопки');
});

// sourcePeriod (material-transfer.mjs): добыча попадает в день/ночь по типу смены,
// а не по времени записей/закрытия. Тест падает, если workShift игнорируется.
const {sourcePeriod, shiftHasProvenKind} = await import('../../tabel-v2/material-transfer.mjs');

test('sourcePeriod: workShift day — вечерние записи 20:00-21:00 остаются дневной сменой', () => {
  const startedAt = Date.parse('2026-11-18T07:00:00Z'); // 10:00 МСК 18.11
  const closedAt = Date.parse('2026-11-18T18:00:00Z');  // 21:00 МСК 18.11, записи до 20:00-21:00
  assert.deepEqual(sourcePeriod({startDate:'18.11.2026', startedAt, closedAt, workShift:'day'}), {date:'2026-11-18', shift:'day'});
});

test('sourcePeriod: workShift night — открытие днём остаётся ночной сменой', () => {
  const startedAt = Date.parse('2026-11-18T09:00:00Z'); // 12:00 МСК 18.11 — по часу фолбэк дал бы day
  const closedAt = Date.parse('2026-11-18T18:00:00Z');  // 21:00 МСК
  assert.deepEqual(sourcePeriod({startDate:'18.11.2026', startedAt, closedAt, workShift:'night'}), {date:'2026-11-18', shift:'night'});
});

test('sourcePeriod: без workShift тип не выводится из часа открытия — внятная ошибка', () => {
  const dayStart = Date.parse('2026-11-18T07:00:00Z');  // 10:00 МСК
  const nightStart = Date.parse('2026-11-18T19:00:00Z'); // 22:00 МСК
  for (const startedAt of [dayStart, nightStart]) {
    assert.throws(() => sourcePeriod({startDate:'18.11.2026', startedAt}), /Не определён тип смены/, 'час открытия не доказательство типа');
  }
  assert.equal(sourcePeriod({startDate:'18.11.2026', kind:'night'}).shift, 'night', 'доказанный kind остаётся доказательством');
});

// Решение владельца 26.11.2026: legacy-смену, открытую до обязательного выбора
// типа, закрываем без вопросов — но материал не переносим, а предупреждаем.
// Предикат «тип доказан» должен быть переиспользуемым и проверяемым.
test('shiftHasProvenKind: доказанный тип → true, отсутствие и мусор → false', () => {
  assert.equal(shiftHasProvenKind({workShift:'day'}), true);
  assert.equal(shiftHasProvenKind({workShift:'night'}), true);
  assert.equal(shiftHasProvenKind({kind:'day'}), true);
  assert.equal(shiftHasProvenKind({kind:'night'}), true);
  assert.equal(shiftHasProvenKind({startDate:'18.11.2026', startedAt:Date.parse('2026-11-18T07:00:00Z')}), false, 'час открытия не доказательство типа');
  assert.equal(shiftHasProvenKind({startDate:'18.11.2026', startedAt:Date.parse('2026-11-18T19:00:00Z')}), false);
  assert.equal(shiftHasProvenKind({workShift:'evening'}), false, 'мусорный тип — не тип');
  assert.equal(shiftHasProvenKind({workShift:''}), false);
  assert.equal(shiftHasProvenKind({kind:null}), false);
  assert.equal(shiftHasProvenKind(null), false);
});

test('21-nas-runtime.js: legacy-смена без типа закрывается с предупреждением и без переноса в табель', () => {
  const runtimeSource = readFileSync(join(here, '21-nas-runtime.js'), 'utf8');
  assert.match(runtimeSource, /if\(module\.shiftHasProvenKind\(prepared\.shift\)\)await module\.transferClosedLine\(nasTabelHost\(\),prepared\.shift,prepared\.archive\)/, 'перенос вызывается только при доказанном типе смены');
  assert.match(runtimeSource, /'Смена открыта без выбранного типа \(дневная\/ночная\)\. Закрыто без переноса в табель — объёмы остались в архиве\.'/, 'понятный текст предупреждения по-русски');
  assert.match(runtimeSource, /if\(skippedUnresolvedType\)appNotice\(/, 'предупреждение показывается через appNotice, а не как ошибка');
});
