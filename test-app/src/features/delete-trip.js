try { (function(){
  if (window.__fixLogDeleteV1) return;
  window.__fixLogDeleteV1 = true;

  // ===== Обновление overlay 📄 Лист, если открыт =====
  function refreshOverlayIfOpen() {
    const overlay = document.getElementById('report-viewer-overlay');
    if (!overlay) return;
    if (!hasTabAccess('report')) { overlay.remove(); return; }
    const paper = overlay.querySelector('.paper-report-container');
    if (!paper) return;
    if (!state || !state.shift) return;
    if (typeof buildReportHTML !== 'function') return;

    try {
      const objNameEl = paper.querySelector('.paper-object-name');
      const isGaiMode = !!(objNameEl && objNameEl.textContent.includes('ГАИ'));
      if (isGaiMode && !hasPermission('view_gai_report')) { overlay.remove(); return; }

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

  // The built-in wrapper must keep the same transaction guards as the core handler.
  const pendingDeletes = new Set();
  window.deleteLog = async function(id) {
    if (!requireEdit('edit_logs') || pendingDeletes.has(id)) return;
    const log = state.logs.find(item => item.id === id);
    if (!log || log.offlinePending) { showError('Рейс не найден или ещё не синхронизирован'); return; }
    const snapshot = { ...log }, before = logEditSnapshot(log), uid = currentUid;
    pendingDeletes.add(id);
    try {
      if (!(await appConfirm('Удалить рейс?'))) return;
      if (currentUid !== uid) throw Error('Учётная запись изменилась. Повторите действие.');
      await commitReportLogChange(id, before, null);
      // The subscription owns local data; failures must never restore a deleted/stale row.
      if (currentUid !== uid || state.shift?.id !== before.shiftId) return;
      forceRenderAll();
      setTimeout(forceRenderAll, 100);
      setTimeout(forceRenderAll, 400);
      setTimeout(forceRenderAll, 1000);
      showToastEl('🗑 Рейс удалён: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)', false);
      if (typeof addAudit === 'function') {
        addAudit('🗑 Удалён рейс: ' + (snapshot.truckName || '') + ' (+' + (snapshot.volume || 0) + ' м³)', {
          eventType: 'log_delete', logId: id, truckId: snapshot.truckId, shiftId: before.shiftId
        }).catch(() => {});
      }
    } catch(e) {
      if (currentUid === uid) showError('Не удалось удалить рейс: ' + e.message);
    } finally { pendingDeletes.delete(id); }
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
