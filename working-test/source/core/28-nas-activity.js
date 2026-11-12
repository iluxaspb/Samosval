// Правила «активного обновления»: пока приложение на экране, данные читаются
// сами — при возврате видимости, фокуса, сети и разблокировке экрана, а также
// периодически. Здесь только чистые правила: их можно проверить без браузера.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasActivity) return;

  // Поводы разбудить приложение. 'resume' — возобновление после разблокировки
  // экрана или выхода из фона (Page Lifecycle API и мобильные оболочки).
  const REASONS = ['visibilitychange', 'focus', 'pageshow', 'online', 'resume', 'poll'];

  // Приложение активно на экране: вкладка видима и сеть есть.
  function isActive(env) {
    const e = env || {};
    if (e.hidden === true) return false;
    if (e.visible === false) return false;
    if (e.onLine === false) return false;
    return true;
  }

  // Ограничитель частоты: не чаще одной серии обновлений за minGap.
  function createGate(options) {
    const opts = options || {};
    const minGap = Number(opts.minGap) > 0 && Number.isFinite(Number(opts.minGap)) ? Number(opts.minGap) : 4000;
    return { lastAt: 0, minGap: minGap, pending: false };
  }

  // Можно ли обновляться сейчас. force — возврат на экран, его не сдерживаем.
  function allow(gate, now, force) {
    if (!gate || typeof gate !== 'object') return true;
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    if (force) { gate.lastAt = at; return true; }
    const gap = Number(gate.minGap) > 0 ? Number(gate.minGap) : 4000;
    if (gate.lastAt && at - gate.lastAt < gap) return false;
    gate.lastAt = at;
    return true;
  }

  function reset(gate) {
    if (gate && typeof gate === 'object') { gate.lastAt = 0; gate.pending = false; }
    return true;
  }

  const api = { REASONS: REASONS, isActive: isActive, createGate: createGate, allow: allow, reset: reset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);