  // === НАСТРОЙКИ ===
  function openSettingsModal() {
    document.getElementById('settingHoldLoad').value = settings.holdLoad;
    document.getElementById('settingHoldArrive').value = settings.holdArrive;
    document.getElementById('settingHoldTtn').value = settings.holdTtn;
    document.getElementById('settingCycleMinutes').disabled=!canAdmin();
    document.getElementById('settingCycleMinutes').value = Math.max(MIN_CYCLE_MINUTES, settings.cycleMinutes || MIN_CYCLE_MINUTES);
    for(const name of ['hapticArrive','hapticLoad','hapticTtn'])document.getElementById(name).checked=!!settings[name];
    document.getElementById('settingsModal').classList.add('open');
  }
  function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('open'); }
  function updateHoldSetting(t,v) { let f=parseFloat(v); f = isNaN(f)?0.5:Math.max(0,Math.min(5,f)); if(t==='load') settings.holdLoad=f; else if(t==='arrive') settings.holdArrive=f; else settings.holdTtn=f; localStorage.setItem('dt_settings', JSON.stringify(settings)); }
  async function updateCycleMinutes(v) {
    if(!canAdmin()){showError('Время ходки задаёт администратор');return;}
    if(!navigator.onLine){showError('Для изменения общего времени ходки требуется связь');return;}
    const n=Math.max(15,parseInt(v)||15);
    try{await appConfigRef.set({cycleMinutes:n},{merge:true});settings.cycleMinutes=n;localStorage.setItem('dt_settings',JSON.stringify(settings));renderAll();}
    catch(e){showError('Время ходки не сохранено: '+e.message);}
  }
  function toggleSetting(k,v) { settings[k]=v; localStorage.setItem('dt_settings', JSON.stringify(settings)); }

  function renderAll() {
    renderHeaderStats();
    if (hasTabAccess('line')) renderLine();
    if (hasTabAccess('report')) renderReport();
    if (hasTabAccess('archive')) renderArchive();
    if (hasTabAccess('trucks')) { renderGlobalTrucksManage(); renderGlobalObjectsManage(); }
    if (hasTabAccess('analytics')) renderAnalytics();
    if (canAdmin()) renderAdminPanel();
    renderStatusTicker();
    updateSyncUI();
  }

