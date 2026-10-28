  function switchTab(name, btn) {
    if (name === 'admin' && !canAdmin()) { showError('Только админ'); return; }
    if (!name.startsWith('plugin-') && name !== 'admin' && !hasTabAccess(name)) { showError('Нет доступа'); return; }
    // === SECURITY: до загрузки прав разрешена только вкладка line ===
    if (!permissionsLoaded && name !== 'line' && name !== 'admin') {
      showError('Подождите, идёт загрузка прав...'); return;
    }
    document.querySelectorAll('.tab-content').forEach(e=>e.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(e=>e.classList.remove('active'));
    let t = document.getElementById('tab-'+name); if(t) t.classList.add('active');
    if(btn) btn.classList.add('active');
    window.scrollTo(0,0);
    // Always open Summary on the regular truck sheet; GAI is opt-in per visit.
    if (name === 'report') showGAITable = false;
    if (pluginTabs[name]) pluginTabs[name].render(pluginTabs[name].container); else renderAll();
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadMaxQueue(); renderAll(); updateSyncUI();
    window.addEventListener('online', () => { offlineTransportRecovered(); updateSyncUI(); runMaxQueue(); offlineReplayJournal(); });
    window.addEventListener('offline', updateSyncUI);
    let e = localStorage.getItem('dt_saved_email_test347'); if(e) document.getElementById('userBadgeLabel').textContent = '👤 ' + sanitizeName(e);
    document.getElementById('newTruckType').addEventListener('change', toggleVolInput);
    setTimeout(runMaxQueue, 2000);
  });
  setInterval(updateSyncUI, 3000);
  setInterval(offlineReplayJournal, 8000);
  setInterval(() => { if (maxQueue.length && !maxSenderRunning) runMaxQueue(); }, 20000);
