// Чистые правила переключения сервера данных. Вынесены отдельно, чтобы их
// можно было проверить без браузера и без обращения к базам.
(function (root) {
  'use strict';

  // Что нужно, чтобы вообще начать переключение. Возвращает либо запрет с
  // понятной причиной, либо подтверждённое поколение для серверной команды.
  function decideSwitchPlan(input) {
    const state = input || {};
    const target = state.target;
    if (target !== 'firebase' && target !== 'ubuntu') return { ok: false, error: 'Неизвестный режим сервера.' };
    if (!state.authenticated) return { ok: false, error: 'Нужен вход в приложение.' };
    if (!state.permissionsLoaded || !state.isAdmin) return { ok: false, error: 'Режим сервера может менять только активный администратор.' };
    if (Number(state.pending) > 0) return { ok: false, error: 'Переключение запрещено: есть неотправленные действия.' };
    if (state.currentProvider === target) return { ok: true, noop: true, expectedGeneration: state.generation };
    if (!Number.isInteger(state.generation) || state.generation < 0) {
      return { ok: false, error: 'Общий режим сервера ещё не подтверждён сервером.' };
    }
    return { ok: true, noop: false, expectedGeneration: state.generation };
  }

  // Отказ сервера переводим в понятный текст. Неизвестный отказ возвращаем
  // как есть, чтобы не скрывать настоящую причину.
  function describeSwitchFailure(status, code, message) {
    if (code === 'authority-generation-conflict') return 'Режим уже изменил другой администратор. Откройте админку заново.';
    if (code === 'authority-generation-mismatch') return 'Телефон отстал от общего режима. Обновите страницу и повторите.';
    if (code === 'not-authoritative') return 'Сервер ещё не объявлен владельцем записи. Переключение не выполнено.';
    if (status === 403) return 'Резерв пока не содержит вашу учётную запись. Дождитесь репликации или проверьте права.';
    if (status === 401) return 'Сеанс входа истёк. Войдите заново.';
    return message || null;
  }

  // Право записи принадлежит ровно одному серверу: резерв не принимает
  // зеркало, когда владельцем объявлен он сам, и наоборот.
  function isMirrorAllowed(authorityProvider) {
    return authorityProvider === 'firebase';
  }

  const api = { decideSwitchPlan, describeSwitchFailure, isMirrorAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.WorkingTestSwitchPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);