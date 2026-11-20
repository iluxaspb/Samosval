// Единый канал восстановления связи (1.7.10). Раньше каждый из 7 источников
// NAS-рантайма независимо ждал свой таймаут и независимо повторял чтение:
// при потере сети телефоном это давало шторм по 20-секундных таймаутов и
// семь сообщений «Сервер недоступен». Теперь состояние связи одно на всё
// приложение, повторы делает только этот супервизор с бэкоффом
// 2/5/10/20/30/60 с, а после первой же успешной пробы все источники
// перечитываются ровно один раз (линия первой — урок 1.6.0).
// Здесь только чистые правила состояния: их можно проверить без браузера.
// Файл идемпотентен: повторная загрузка не ломает уже созданный объект.
(function (root) {
  'use strict';

  if (root.WorkingTestNasConnection) return root.WorkingTestNasConnection;

  // Пауза между пробами после N-й неудачи, секунды. Максимум 60; после
  // восстановления счётчик сбрасывается и первая проба идёт без задержки.
  const BACKOFF_STEPS_S = [2, 5, 10, 20, 30, 60];
  const PROBE_TIMEOUT_S = 15;

  function delayFor(state, now) {
    const attempt = Number(state.attempt) || 0;
    const index = Math.min(attempt, BACKOFF_STEPS_S.length) - 1;
    const seconds = attempt > 0 ? BACKOFF_STEPS_S[Math.max(0, index)] : 0;
    // Отсчёт — от последней неудачи (для первой пробы задержки нет).
    const base = attempt > 0 ? Number(state.lastFailAt) || Number(state.downSince) || now : now;
    const nextAt = base + seconds * 1000;
    return { seconds: seconds, nextAt: nextAt };
  }

  // Создать супервизора. env подставляют браузер или тест:
  //   now() -> мс, probe() -> Promise (GET /api/v1/session с таймаутом 15 c),
  //   emit(kind, detail) -> событие UI 'offline'/'online', log(...) -> консоль.
  function create(env) {
    const e = env || {};
    const now = typeof e.now === 'function' ? e.now : () => Date.now();
    const probe = typeof e.probe === 'function' ? e.probe : async () => {};
    const emit = typeof e.emit === 'function' ? e.emit : () => {};
    const log = typeof e.log === 'function' ? e.log : () => {};

    const state = {
      online: true,        // связь с сервером подтверждена последней пробой
      attempt: 0,          // число неудачных проб с момента потери связи
      downSince: 0,        // когда связь потеряна (для «восстановлено за Xс»)
      probeCount: 0,       // всего проб (для диагностики и тестов)
      probing: false,
      timer: null
    };

    function message(kind, extra) {
      if (kind === 'connecting') return '[связь] подключение…';
      if (kind === 'timeout') return '[связь] таймаут (' + PROBE_TIMEOUT_S + 'с, ответных заголовков нет), повтор через ' + extra + 'с';
      if (kind === 'retry') return '[связь] повтор №' + extra.attempt + ' через ' + extra.seconds + 'с';
      if (kind === 'recovered') return '[связь] восстановлено за ' + extra + 'с, перечитываю данные';
      if (kind === 'offline') return '[связь] оффлайн (браузер)';
      return '[связь] ' + kind;
    }

    // Запустить пробу немедленно. true/false — успех/неудача, null — проба
    // уже идёт (не считать повтором и не двигать бэкофф).
    async function runProbe() {
      if (state.probing) return null;
      state.probing = true;
      state.probeCount++;
      let ok = false;
      try { await probe(); ok = true; } catch (_) { ok = false; }
      state.probing = false;
      return ok;
    }

    // Центральный цикл: пока связи нет, раз в секунду смотрим, не пора ли
    // пробовать. Одна неудача — один переход и одна запись в журнале.
    function loop() {
      if (state.online || state.timer) return;
      const step = async () => {
        if (state.online) return;
        const t = now();
        const wait = delayFor(state, t);
        if (state.attempt > 0 && t < wait.nextAt) return;
        if (state.attempt > 0) log(message('retry', { attempt: state.attempt + 1, seconds: wait.seconds }));
        else if (state.probeCount === 0) log(message('connecting'));
        const ok = await runProbe();
        if (ok === null || state.online) return;
        if (ok) {
          recover();
        } else {
          state.attempt++;
          state.lastFailAt = now();
          log(message('timeout', BACKOFF_STEPS_S[Math.min(state.attempt, BACKOFF_STEPS_S.length) - 1]));
          emit('offline', { attempt: state.attempt, downSince: state.downSince });
        }
      };
      const interval = typeof e.setInterval === 'function'
        ? e.setInterval
        : (root.setInterval ? root.setInterval.bind(root) : null);
      const clear = typeof e.clearInterval === 'function'
        ? e.clearInterval
        : (root.clearInterval ? root.clearInterval.bind(root) : null);
      if (!interval || !clear) return;
      state.timer = interval(() => { void step(); }, 1000);
    }

    function stopLoop() {
      if (state.timer && typeof e.clearInterval === 'function') e.clearInterval(state.timer);
      else if (state.timer && root.clearInterval) root.clearInterval(state.timer);
      state.timer = null;
    }

    // Сообщить о неудаче любого канала. Первый переход в оффлайн — событие и
    // сообщение; повторные неудачи других каналов уже ничего не добавляют.
    function reportFailure(reason) {
      if (!state.online) return false;
      state.online = false;
      state.attempt = 0;
      state.downSince = now();
      if (reason === 'browser-offline') log(message('offline'));
      else log(message('connecting'));
      emit('offline', { attempt: 0, downSince: state.downSince });
      loop();
      return true;
    }

    // Сообщить об успехе любого запроса («сердце» связи): если считались
    // оффлайн — восстановление, одно событие и один общий перечитка.
    function reportSuccess() {
      if (state.online) return false;
      const elapsedS = Math.round((now() - state.downSince) / 1000);
      state.online = true;
      state.attempt = 0;
      state.downSince = 0;
      stopLoop();
      log(message('recovered', elapsedS));
      emit('online', { elapsedS: elapsedS });
      return true;
    }

    function recover() {
      if (state.online) return false;
      return reportSuccess();
    }

    function snapshot() {
      const wait = delayFor(state, now());
      return {
        online: state.online,
        attempt: state.attempt,
        downSince: state.downSince,
        probeCount: state.probeCount,
        nextRetryInS: state.online ? 0 : Math.max(0, Math.ceil((wait.nextAt - now()) / 1000))
      };
    }

    return Object.freeze({
      reportFailure: reportFailure,
      reportSuccess: reportSuccess,
      runProbe: runProbe,
      snapshot: snapshot,
      stop: stopLoop,
      BACKOFF_STEPS_S: BACKOFF_STEPS_S,
      PROBE_TIMEOUT_S: PROBE_TIMEOUT_S
    });
  }

  const api = { create: create, BACKOFF_STEPS_S: BACKOFF_STEPS_S, PROBE_TIMEOUT_S: PROBE_TIMEOUT_S };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.freeze(api);
  root.WorkingTestNasConnection = api;
  return api;
})(typeof window !== 'undefined' ? window : globalThis);
