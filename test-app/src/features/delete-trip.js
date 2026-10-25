try { (function(){
  if (window.__fixLogDeleteV1) return;
  window.__fixLogDeleteV1 = true;

  // ===== Обновление overlay 📄 Лист, если открыт =====
  function refreshOverlayIfOpen() {
    const overlay = document.getElementById('report-viewer-overlay');
    if (!overlay) return;
    const paper = overlay.querySelector('.paper-report-container');
    if (!paper) return;
    if (!state || !state.shift) return;
    if (typeof buildReportHTML !== 'function') return;

    try {
      const objNameEl = paper.querySelector('.paper-object-name');
      const isGaiMode = objNameEl && objNameEl.textContent.includes('ГАИ');

      const logs = getLogs().filter(l => !!l.isGAI === isGaiMode);
      const activeLineIds = getActiveLineIds();

      const checkTTN = isGaiMode ? null : (id, logId) => {
        return state.truckStatus[id] && state.truckStatus[id].ttnStatus === true && state.truckStatus[id].ttnLogId === logId;
      };

      const html = buildReportHTML({
        objectName: state.shift.objectName,
        date: state.shift.startDate,
        logs: logs,
        activeLineIds: activeLineIds,
        type: isGaiMode ? 'gai' : 'regular',
        checkTTN: checkTTN
      });

      paper.innerHTML = html;
    } catch(e) {
      console.warn('[fix-log-delete] overlay refresh:', e);
    }
  }

  // ===== Перерисовать всё =====
  function forceRenderAll() {
    if (typeof renderReport === 'function') { try { renderReport(); } catch(e) { console.warn(e); } }
    if (typeof renderLine === 'function') { try { renderLine(); } catch(e) { console.warn(e); } }
    if (typeof renderHeaderStats === 'function') { try { renderHeaderStats(); } catch(e) { console.warn(e); } }
    if (typeof renderAnalytics === 'function') { try { renderAnalytics(true); } catch(e) { console.warn(e); } }
    refreshOverlayIfOpen();
  }

  // ===== Переопределяем deleteLog =====
  window.deleteLog = async function(id) {
    if (typeof requireEdit === 'function' && !requireEdit('edit_logs')) return;
    if (!(await appConfirm('Удалить рейс?'))) return;

    const log = state.logs.find(l => l.id === id);
    if (!log) { if (typeof showError === 'function') showError('Рейс не найден'); return; }

    const snapshot = Object.assign({}, log);

    try {
      // 1. Сначала удаляем из Firestore и ждём подтверждения
      await refs.logs.doc(id).delete();

      // 2. Только после успеха — удаляем из локального состояния
      state.logs = state.logs.filter(x => x.id !== id);
      if (typeof saveCache === 'function') saveCache();

      // 3. Принудительно перерисовываем всё
      forceRenderAll();

      // 4. Дополнительные перерисовки на случай, если onSnapshot ещё не отработал
      setTimeout(forceRenderAll, 100);
      setTimeout(forceRenderAll, 400);
      setTimeout(forceRenderAll, 1000);

      // 5. Тост
      if (typeof showToastEl === 'function') {
        showToastEl('🗑 Рейс удалён: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)', false);
      }

      // 6. Аудит
      if (typeof addAudit === 'function') {
        addAudit('🗑 Удалён рейс: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)').catch(()=>{});
      }
    } catch(e) {
      // Ошибка Firestore — восстанавливаем локально
      if (!state.logs.find(l => l.id === id)) {
        state.logs.push(snapshot);
        state.logs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (typeof saveCache === 'function') saveCache();
      }
      forceRenderAll();
      if (typeof showError === 'function') showError('Не удалось удалить рейс: ' + e.message);
    }
  };

  // ===== Расширяем saveLogEdit (edit) =====
  const origSaveLogEdit = window.saveLogEdit;
  if (origSaveLogEdit) {
    window.saveLogEdit = async function() {
      const result = await origSaveLogEdit.apply(this, arguments);
      // После сохранения тоже перерисовываем overlay
      setTimeout(forceRenderAll, 100);
      setTimeout(forceRenderAll, 400);
      return result;
    };
  }

  // ===== Обёртка renderReport — обновляет overlay при каждом вызове =====
  const origRenderReport = window.renderReport;
  if (origRenderReport) {
    window.renderReport = function() {
      const result = origRenderReport.apply(this, arguments);
      setTimeout(refreshOverlayIfOpen, 30);
      return result;
    };
  }

  console.log('[fix-log-delete] ✅ Активен. Удаление рейсов синхронизировано с отчётом и overlay.');
})();; }
catch (e) { console.error('[baked patch: Удаление рейса с листика]', e); }
