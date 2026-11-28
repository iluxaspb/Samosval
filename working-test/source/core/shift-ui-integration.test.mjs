import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('./', import.meta.url));
const navigation = readFileSync(here + '19-navigation.js', 'utf8');
const shell = readFileSync(new URL('../shell.html', import.meta.url), 'utf8');
const lineUi = readFileSync(here + '18-line-ui.js', 'utf8');
const style = readFileSync(new URL('../styles/style-05.css', import.meta.url), 'utf8');

test('интеграция: кнопка открывает лист, полоса стоит перед нижней навигацией', () => {
  assert.match(shell, /id="shiftManagementBtn"[^>]*onclick="openShiftManagement\(\)"/);
  assert.match(shell, /id="shiftManagementModal"/);
  assert.match(shell, /id="shiftManagementBody"/);
  assert.ok(shell.indexOf('id="shiftStrip"') < shell.indexOf('id="bottomNav"'));
  assert.match(navigation, /window\.openShiftManagement\s*=/);
  assert.match(navigation, /window\.closeShiftManagement\s*=/);
  assert.match(navigation, /Управление сменами доступно после включения канала v2/);
});

test('интеграция: без моста скрывает полосу, без v1-fallback; события v2 обновляют UI', () => {
  assert.match(navigation, /if \(!bridge \|\| !bridge\.store \|\| !bridge\.transport/);
  assert.match(navigation, /mount\.hidden = true/);
  assert.match(navigation, /samosval-working-test-shifts/);
  assert.match(navigation, /samosval-working-test-shift-snapshot/);
  assert.match(navigation, /window\.shiftStripSelect\s*=/);
  assert.match(navigation, /__wtRenderShiftStrip/);
  assert.match(lineUi, /window\.__wtRenderShiftStrip\?\.\(\)/);
  // Лист смен не подменяет v2-команды старым клиентом. nasSaveRecord здесь
  // допустим только для создания объекта из пункта «Новый объект…», но не для
  // самой смены: закрытие и старт идут через v2-мост.
  assert.doesNotMatch(navigation, /startShiftWithObject\(|nasCloseCurrentShift\(/);
  const saveCalls = navigation.match(/nasSaveRecord\([^)]*/g) || [];
  assert.ok(saveCalls.every(call => /nasSaveRecord\('object'/.test(call)), 'nasSaveRecord вызывается только для объекта: ' + saveCalls.join('; '));
});

test('интеграция: снимок активной смены перерисовывает линию, а чужой — нет', () => {
  // Список смен приходит раньше снимка. Если снимок выбранной смены не
  // публиковать в старую линию, карточки машин не появляются вообще.
  const handler = navigation.slice(navigation.indexOf("samosval-working-test-shift-snapshot"));
  assert.match(handler, /detail\.applied !== true/);
  assert.match(handler, /detail\.shiftId !== ui\.selector\.activeShiftId\(\)/);
  assert.match(handler, /projectActiveContextToLegacyState\(state\)/);
  assert.match(handler, /renderHeaderStats\(\)/);
  assert.match(handler, /scheduleRenderLine\(\)/);
});

test('интеграция: полоса прижата к низу и не перекрывает ни модалки, ни карточки', () => {
  // Жалоба владельца (28.11.2026): при короткой линии sticky-полоса висела
  // под последней карточкой, а при открытии «Выбор самосвалов» оказывалась
  // поверх окна. Полоса — fixed над меню, ниже модалок, с запасом под неё.
  assert.match(style, /\.shift-strip\s*\{[^}]*position:\s*fixed/s);
  assert.match(style, /\.shift-strip\s*\{[^}]*bottom:\s*56px/s);
  const stripZ = Number(/\.shift-strip\s*\{[^}]*z-index:\s*(\d+)/s.exec(style)[1]);
  const modalZ = Number(/\.modal\s*\{[^}]*z-index:\s*(\d+)/s.exec(readFileSync(new URL('../styles/style-04.css', import.meta.url), 'utf8'))[1]);
  assert.ok(stripZ < modalZ, 'модалка обязана быть выше полосы: ' + stripZ + ' < ' + modalZ);
  assert.match(style, /body\.shift-strip-open\s*\{[^}]*padding-bottom:\s*calc\(/s);
  assert.match(style, /--shift-strip-h/);
  assert.match(style, /overflow-x:\s*auto/);
  assert.match(style, /scroll-snap-type:\s*x\s+proximity/);
  assert.match(style, /\.shift-tab\s*\{[^}]*flex:\s*0\s+0\s+auto/s);
  assert.match(style, /scroll-snap-align:\s*start/);
});

test('интеграция: перевод и оставшиеся рейсы подключены только на живом v2-мосте', () => {
  const modules = readFileSync(new URL('../../modules.json', import.meta.url), 'utf8');
  const shifts = readFileSync(here + '15-shifts.js', 'utf8');
  const confirm = readFileSync(new URL('../features/pretty-confirm.js', import.meta.url), 'utf8');
  const transfer = readFileSync(here + '47-shift-transfer-ui.js', 'utf8');

  // Модуль собирается в канал сразу после detached-модуля.
  assert.ok(modules.indexOf('core/46-detached-trips.js') < modules.indexOf('core/47-shift-transfer-ui.js'));
  // Отдельный блок в потоке линии, не внутри списка карточек текущей смены.
  assert.ok(shell.indexOf('id="trucksLineList"') < shell.indexOf('id="detachedTripsBlock"'));
  assert.match(shell, /id="detachedTripsBlock" hidden/);
  assert.match(style, /#detachedTripsBlock\s*\{/);
  assert.match(style, /\.detached-trip-warning\s*\{/);
  assert.match(lineUi, /window\.__wtRenderDetachedTrips\?\.\(\)/);

  // Без моста блок скрыт, v2-добавления самосвала нет — экран 1.8.7 цел.
  assert.match(navigation, /window\.__wtRenderDetachedTrips = hideDetachedTrips/);
  assert.match(navigation, /delete window\.__wtAddTruckToShift/);
  assert.match(navigation, /WorkingTestShiftTransferUi\.createShiftTransferUi/);
  assert.match(navigation, /forceTransferAllowed: mayForceTransfer/);
  assert.match(navigation, /window\.__wtAddTruckToShift\s*=/);
  // §6: роль проверяется вместе с правом, а не только матрица прав.
  assert.match(navigation, /role === 'admin' \|\| role === 'senior_foreman'/);

  // Экран добавления самосвала уходит в v2, а не в старую команду линии.
  assert.ok(shifts.indexOf('window.__wtAddTruckToShift') < shifts.indexOf('await nasChangeMembership(id,true)'));

  // Опасное подтверждение: безопасный default и тексты design §10.2.
  assert.match(confirm, /opts\.focus === 'cancel'/);
  assert.match(confirm, /opts\.enterConfirms !== false/);
  assert.match(transfer, /Перевести самосвал в другую смену\?/);
  assert.match(transfer, /Рейсы, оставшиеся в прежней смене/);
  assert.match(transfer, /Завершить в прежней смене/);
  assert.match(transfer, /Отменить перевод будет нельзя\./);
});
