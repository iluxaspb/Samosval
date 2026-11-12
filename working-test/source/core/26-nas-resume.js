// Надзиратель за повторными чтениями сервера после сворачивания приложения.
// Чистые правила без браузера и без сети: их можно проверить отдельно.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasResume) return;

  // Источники, ошибки которых снимаются только успешным повторным чтением.
  const SOURCES = ['nas', 'nas-objects', 'nas-games', 'nas-auxiliary', 'nas-archive', 'nas-settings', 'nas-admin', 'nas-catalog'];

  // Состояние повторов: сколько раз подряд упал источник и когда пробовать снова.
  function createState() {
    return { items: {} };
  }

  function bucket(state) {
    if (!state || typeof state !== 'object') return {};
    if (!state.items || typeof state.items !== 'object') state.items = {};
    return state.items;
  }

  // Задержка перед повтором: 1, 2, 4, 8, 16 секунд, дальше не чаще 30 секунд.
  function backoffDelay(attempt, opts) {
    const options = opts || {};
    const base = Number(options.base) > 0 && Number.isFinite(Number(options.base)) ? Number(options.base) : 1000;
    const max = Number(options.max) > 0 && Number.isFinite(Number(options.max)) ? Number(options.max) : 30000;
    const number = Number(attempt);
    if (!Number.isFinite(number) || number < 1) return base;
    const steps = Math.min(Math.floor(number) - 1, 30);
    return Math.min(base * Math.pow(2, steps), max);
  }

  // Очередная неудача: считаем попытки и назначаем время следующей.
  function recordFailure(state, source, now) {
    const items = bucket(state);
    const previous = items[source] && typeof items[source].attempt === 'number' ? items[source].attempt : 0;
    const attempt = previous + 1;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    items[source] = { attempt: attempt, nextAt: at + backoffDelay(attempt) };
    return items[source];
  }

  // Успех полностью сбрасывает счётчик источника.
  function recordSuccess(state, source) {
    const items = bucket(state);
    delete items[source];
    return true;
  }

  // Пора ли пробовать снова: без записи — сразу, иначе не раньше nextAt.
  function due(state, source, now) {
    const items = bucket(state);
    const item = items[source];
    if (!item || typeof item.nextAt !== 'number' || !Number.isFinite(item.nextAt)) return true;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    return at >= item.nextAt;
  }

  // Полный сброс: используется после подтверждённого восстановления связи.
  function reset(state) {
    if (state && typeof state === 'object') state.items = {};
    return true;
  }

  const api = {
    SOURCES: SOURCES,
    createState: createState,
    backoffDelay: backoffDelay,
    recordFailure: recordFailure,
    recordSuccess: recordSuccess,
    due: due,
    reset: reset
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasResume = api;
})(typeof window !== 'undefined' ? window : globalThis);
